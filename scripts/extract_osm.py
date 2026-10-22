#!/usr/bin/env python3
"""Download a Geofabrik Shanghai extract and produce small, reusable MVP datasets.

Run in an isolated environment containing osmium and shapely. See data/README.md.
No paid API, account, or routing API is used.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import re
import urllib.request

import osmium
from shapely.geometry import Point, mapping, shape

ROOT = Path(__file__).resolve().parents[1]
PBF_URL = "https://download.geofabrik.de/asia/china/shanghai-latest.osm.pbf"
POLY_URL = "https://download.geofabrik.de/asia/china/shanghai.poly"
SOURCE_PAGE = "https://download.geofabrik.de/asia/china/shanghai.html"
LABELS = {"cafe": "咖啡店", "mall": "商场", "school": "学校", "metro": "地铁入口",
          "sports": "运动设施", "library": "图书馆"}
SPORTS_TYPES = {"sports_centre", "sports_hall", "fitness_centre", "fitness_station", "pitch",
                "swimming_pool", "track", "stadium"}
SPORTS_VENUES = {"sports_centre", "sports_hall", "stadium"}
RESTRICTED_ACCESS = {"no", "private"}
METRO_ASSOCIATION_MAX_M = 350


def download(url: str, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".part")
    request = urllib.request.Request(url, headers={"User-Agent": "ShanghaiAccessMVP/1.0"})
    with urllib.request.urlopen(request, timeout=120) as response, temporary.open("wb") as output:
        while chunk := response.read(1024 * 1024):
            output.write(chunk)
    temporary.replace(destination)


def parse_poly(path: Path):
    """Geofabrik .poly is a coverage outline, not an administrative boundary."""
    lines = path.read_text().splitlines()[1:]
    polygons = []
    i = 0
    while i < len(lines):
        name = lines[i].strip()
        i += 1
        if name == "END":
            break
        ring = []
        while i < len(lines) and lines[i].strip() != "END":
            ring.append([float(v) for v in lines[i].split()])
            i += 1
        i += 1
        if name.startswith("!") and polygons:
            polygons[-1].append(ring)
        else:
            polygons.append([ring])
    return shape({"type": "MultiPolygon", "coordinates": polygons})


def category_for(tags: dict[str, str]) -> str | None:
    if tags.get("amenity") == "cafe":
        return "cafe"
    if tags.get("shop") == "mall":
        return "mall"
    if tags.get("amenity") == "school":
        return "school"
    # Entrances only: station centroids can be misleading and are not entrances.
    if tags.get("railway") == "subway_entrance":
        return "metro"
    if tags.get("amenity") == "library":
        return "library"
    if tags.get("leisure") in SPORTS_TYPES:
        return "sports"
    return None


def metro_station(tags: dict[str, str]) -> bool:
    return (tags.get("railway") == "station" or tags.get("public_transport") == "station") and (
        tags.get("station") == "subway" or tags.get("subway") == "yes")


def geographic_distance(a, b) -> float:
    lon1, lat1, lon2, lat2 = map(math.radians, [*a, *b])
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 6371008.8 * 2 * math.asin(min(1, math.sqrt(h)))


def normalize_station_name(name: str) -> str:
    # Line annotations vary across station nodes; distance still bounds every merge.
    return re.sub(r"\s+", "", re.sub(r"[（(][^）)]*号线[^）)]*[）)]", "", name)).casefold()


def poi_name(tags: dict[str, str], category: str, osm_id: str) -> str:
    name = tags.get("name:zh") or tags.get("name") or tags.get("brand") or tags.get("operator")
    if name:
        return name
    ref = tags.get("ref") or tags.get("local_ref")
    if category == "metro" and ref:
        return f"地铁 {ref} 号口"
    return f"未命名{LABELS[category]} · {osm_id}"


class Extractor(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.factory = osmium.geom.GeoJSONFactory()
        self.features = []
        self.area_geometries = {}
        self.tags = {}
        self.stations = {}
        self.stop_areas = {}
        self.stop_area_groups = {}
        self.restricted_sports_areas = {}
        self.excluded_access = Counter()
        self.boundaries = []
        self.waters = []
        self.errors = Counter()

    def add(self, kind: str, identifier: int, tags: dict[str, str], point, category: str,
            point_type: str, geometry=None):
        osm_id = f"{kind}/{identifier}"
        if category in ("sports", "library") and tags.get("access") in RESTRICTED_ACCESS:
            self.excluded_access[category] += 1
            if category == "sports" and geometry is not None:
                self.restricted_sports_areas[osm_id] = geometry
            return
        properties = {
            "id": osm_id,
            "name": poi_name(tags, category, osm_id),
            "category": category,
            "source": "OpenStreetMap",
            "osmType": kind,
            "osmId": str(identifier),
            "osmUrl": f"https://www.openstreetmap.org/{osm_id}",
            "pointType": point_type,
            "named": bool(tags.get("name:zh") or tags.get("name") or tags.get("brand")),
            "groupId": f"{category}:{osm_id}",
            "groupName": poi_name(tags, category, osm_id),
            "groupingMethod": "individual_osm_object",
        }
        for key in ["name:en", "brand", "operator", "ref", "local_ref", "wheelchair", "access", "opening_hours"]:
            if tags.get(key):
                properties[key] = tags[key]
        if category == "school":
            properties["schoolType"] = tags.get("school:CN") or tags.get("school") or "未分类"
        if category == "sports":
            properties["sportsType"] = tags["leisure"]
            properties["sport"] = tags.get("sport") or "未分类"
        self.features.append({"type": "Feature", "id": osm_id, "geometry": {
            "type": "Point", "coordinates": [round(point.x, 7), round(point.y, 7)]},
            "properties": properties})
        self.tags[osm_id] = tags
        if geometry is not None:
            self.area_geometries[osm_id] = geometry

    def node(self, node):
        tags = dict(node.tags)
        category = category_for(tags)
        if category and node.location.valid():
            self.add("node", node.id, tags, Point(node.location.lon, node.location.lat), category,
                     "subway_entrance" if category == "metro" else "osm_node")
        if metro_station(tags) and node.location.valid():
            self.stations[f"node/{node.id}"] = {"name": tags.get("name:zh") or tags.get("name") or "",
                                                 "coordinates": [node.location.lon, node.location.lat]}

    def relation(self, relation):
        tags = dict(relation.tags)
        kind = tags.get("public_transport")
        if kind not in ("stop_area", "stop_area_group"):
            return
        member_types = {"n": "node", "w": "way", "r": "relation"}
        record = {"name": tags.get("name:zh") or tags.get("name") or "",
                  "members": [f"{member_types[m.type]}/{m.ref}" for m in relation.members if m.type in member_types]}
        destination = self.stop_areas if kind == "stop_area" else self.stop_area_groups
        destination[f"relation/{relation.id}"] = record

    def way(self, way):
        tags = dict(way.tags)
        # Running tracks can be linear ways rather than mapped facility polygons.
        if tags.get("leisure") != "track" or (way.is_closed() and tags.get("area") != "no"):
            return
        try:
            geometry = shape(json.loads(self.factory.create_linestring(way)))
            self.add("way", way.id, tags, geometry.interpolate(0.5, normalized=True), "sports",
                     "line_representative_point", geometry)
        except (RuntimeError, ValueError) as exc:
            self.errors[type(exc).__name__] += 1

    def area(self, area):
        tags = dict(area.tags)
        category = category_for(tags)
        is_station = metro_station(tags)
        is_water = tags.get("natural") == "water" or tags.get("waterway") == "riverbank"
        is_shanghai = (tags.get("boundary") == "administrative" and tags.get("admin_level") == "4"
                       and (tags.get("name") in ("上海市", "上海", "Shanghai")
                            or tags.get("name:en") == "Shanghai"))
        if not category and not is_shanghai and not is_water and not is_station:
            return
        try:
            geometry = shape(json.loads(self.factory.create_multipolygon(area)))
            if not geometry.is_valid:
                geometry = geometry.buffer(0)
            if geometry.is_empty:
                raise ValueError("empty geometry")
            kind = "way" if area.from_way() else "relation"
            if is_station:
                station_point = geometry.representative_point()
                self.stations[f"{kind}/{area.orig_id()}"] = {
                    "name": tags.get("name:zh") or tags.get("name") or "",
                    "coordinates": [station_point.x, station_point.y]}
            if is_water:
                self.waters.append({"type": "Feature", "id": f"{kind}/{area.orig_id()}",
                                    "geometry": mapping(geometry.simplify(0.00002, preserve_topology=True)),
                                    "properties": {"name": tags.get("name:zh") or tags.get("name") or "未命名水面",
                                                   "source": "OpenStreetMap", "water": tags.get("water") or "water",
                                                   "osmUrl": f"https://www.openstreetmap.org/{kind}/{area.orig_id()}"}})
            if is_shanghai:
                self.boundaries.append({"type": "Feature", "id": f"{kind}/{area.orig_id()}",
                                        "geometry": mapping(geometry.simplify(0.00012, preserve_topology=True)),
                                        "properties": {"name": "上海市", "source": "OpenStreetMap",
                                                       "boundaryType": "administrative", "adminLevel": 4,
                                                       "osmUrl": f"https://www.openstreetmap.org/{kind}/{area.orig_id()}"}})
            if category:
                self.add(kind, area.orig_id(), tags, geometry.representative_point(), category,
                         "polygon_representative_point", geometry)
        except (RuntimeError, ValueError) as exc:
            self.errors[type(exc).__name__] += 1


def deduplicate(features, areas):
    """Avoid a separately mapped point and enclosing area counting as two facilities.

    Keep subway entrances separate: they are distinct accessible destinations.
    Unnamed nearby objects are retained; they cannot be reliably identified as duplicates.
    """
    by_name = {}
    for feature in features:
        props = feature["properties"]
        if props["named"] and feature["id"] in areas:
            by_name.setdefault((props["category"], props["name"].casefold().strip()), []).append(feature)
    removed = set()
    for feature in features:
        props = feature["properties"]
        if props["osmType"] != "node" or not props["named"] or props["category"] == "metro":
            continue
        key = (props["category"], props["name"].casefold().strip())
        point = shape(feature["geometry"])
        for area in by_name.get(key, []):
            if areas[area["id"]].covers(point):
                removed.add(feature["id"])
                break
    return [feature for feature in features if feature["id"] not in removed], len(removed)


def group_sports(features, areas, restricted_areas):
    """Use complete geometric containment, not arbitrary proximity, for venue grouping."""
    inherited_exclusions = []
    for feature in features:
        if feature["properties"]["category"] != "sports":
            continue
        geometry = areas.get(feature["id"], shape(feature["geometry"]))
        if any(parent.covers(geometry) for parent in restricted_areas.values()):
            inherited_exclusions.append(feature["id"])
    features = [f for f in features if f["id"] not in set(inherited_exclusions)]
    venues = [f for f in features if f["properties"]["category"] == "sports"
              and f["properties"]["sportsType"] in SPORTS_VENUES and f["id"] in areas]
    validation = {"containedMembersChecked": 0, "containmentErrors": 0,
                  "excludedInsideRestrictedSportArea": len(inherited_exclusions)}
    for feature in features:
        props = feature["properties"]
        if props["category"] != "sports":
            continue
        geometry = areas.get(feature["id"], shape(feature["geometry"]))
        candidates = [venue for venue in venues if areas[venue["id"]].covers(geometry)]
        if not candidates:
            continue
        # The outermost mapped venue owns nested stadiums/halls and all their pitches.
        parent = min(candidates, key=lambda f: (-areas[f["id"]].area, f["id"]))
        props["groupId"] = f"sports:{parent['id']}"
        props["groupName"] = parent["properties"]["name"]
        props["groupingMethod"] = "sports_venue" if parent["id"] == feature["id"] else "contained_in_sports_venue"
        props["groupSourceId"] = parent["id"]
        if parent["id"] != feature["id"]:
            validation["containedMembersChecked"] += 1
            validation["containmentErrors"] += not areas[parent["id"]].covers(geometry)
    return features, validation


def group_metro(features, stations, stop_areas, stop_area_groups):
    """Explicit OSM membership first; bounded nearest-station fallback second."""
    entrances = {f["id"]: f for f in features if f["properties"]["category"] == "metro"}
    parents = {}

    def find(key):
        parents.setdefault(key, key)
        if parents[key] != key:
            parents[key] = find(parents[key])
        return parents[key]

    def union(a, b):
        a, b = find(a), find(b)
        if a != b:
            parents[max(a, b)] = min(a, b)

    records = {key: {**station, "priority": 2, "kind": "station"} for key, station in stations.items()}
    for key in stations:
        find(key)
    valid_areas = {key: area for key, area in stop_areas.items()
                   if any(member in stations or member in entrances for member in area["members"])}
    entrance_relations = {}
    for key, area in valid_areas.items():
        records[key] = {**area, "priority": 1, "kind": "stop_area"}
        find(key)
        for member in area["members"]:
            if member in stations:
                union(key, member)
            if member in entrances:
                entrance_relations.setdefault(member, []).append(key)
    # Entrances explicitly shared across line-specific stop areas identify one complex.
    for keys in entrance_relations.values():
        for key in keys[1:]:
            union(keys[0], key)
    valid_area_groups = {}
    for key, area in stop_area_groups.items():
        members = [member for member in area["members"] if member in valid_areas]
        if not members:
            continue
        records[key] = {**area, "priority": 0, "kind": "stop_area_group"}
        valid_area_groups[key] = area
        for member in members:
            union(key, member)

    # Multi-line stations may have separate station nodes without a stop-area group.
    # Same normalized name alone is never sufficient: every pair is within 350 m.
    by_name = {}
    for key, station in stations.items():
        name = normalize_station_name(station["name"])
        if name:
            by_name.setdefault(name, []).append(key)
    same_name_pairs = 0
    for keys in by_name.values():
        for i, a in enumerate(keys):
            for b in keys[i + 1:]:
                if geographic_distance(stations[a]["coordinates"], stations[b]["coordinates"]) <= METRO_ASSOCIATION_MAX_M:
                    union(a, b)
                    same_name_pairs += 1

    components = {}
    for key in records:
        components.setdefault(find(key), []).append(key)
    canonical = {component: min(keys, key=lambda key: (records[key]["priority"], key))
                 for component, keys in components.items()}
    for entrance_id, feature in entrances.items():
        props = feature["properties"]
        station_key = None
        if entrance_id in entrance_relations:
            component = find(entrance_relations[entrance_id][0])
            props["groupingMethod"] = "osm_stop_area_membership"
        else:
            candidates = [(geographic_distance(feature["geometry"]["coordinates"], station["coordinates"]), key)
                          for key, station in stations.items()]
            distance, station_key = min(candidates, default=(math.inf, None))
            if distance > METRO_ASSOCIATION_MAX_M:
                props["groupingMethod"] = "unassociated_entrance"
                continue
            component = find(station_key)
            props["groupingMethod"] = "nearest_metro_station_within_350m"
            props["groupingDistanceM"] = round(distance, 3)
            props["groupingStationId"] = station_key
            props["groupingStationCoordinates"] = stations[station_key]["coordinates"]
        source_id = canonical[component]
        source = records[source_id]
        component_keys = components[component]
        names = [records[key]["name"] for key in sorted(component_keys, key=lambda k: (records[k]["priority"], k))
                 if records[key]["name"]]
        props["groupId"] = f"metro:{source_id}"
        props["groupName"] = names[0] if names else f"未命名地铁站 · {source_id}"
        props["groupSourceId"] = source_id
        props["groupSourceType"] = source["kind"]

    methods = Counter(f["properties"]["groupingMethod"] for f in entrances.values())
    fallback_features = [f for f in entrances.values() if "groupingDistanceM" in f["properties"]]
    invalid_fallbacks = [f["id"] for f in fallback_features
                         if geographic_distance(f["geometry"]["coordinates"],
                                                f["properties"]["groupingStationCoordinates"]) > METRO_ASSOCIATION_MAX_M]
    return {
        "entranceCount": len(entrances), "mappedMetroStationObjectCount": len(stations),
        "validMetroStopAreaCount": len(valid_areas), "validMetroStopAreaGroupCount": len(valid_area_groups),
        "sameNamedStationPairsMergedWithin350m": same_name_pairs,
        "entrancesByGroupingMethod": dict(methods),
        "associatedEntranceCount": len(entrances) - methods.get("unassociated_entrance", 0),
        "unassociatedEntranceCount": methods.get("unassociated_entrance", 0),
        "unassociatedEntranceIds": [f["id"] for f in entrances.values()
                                      if f["properties"]["groupingMethod"] == "unassociated_entrance"],
        "heuristicMaxDistanceM": METRO_ASSOCIATION_MAX_M,
        "largestObservedHeuristicDistanceM": max((f["properties"]["groupingDistanceM"] for f in fallback_features), default=None),
        "heuristicDistanceValidationErrors": invalid_fallbacks,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh", action="store_true", help="Download the latest source even if cached")
    parser.add_argument("--pbf", type=Path, default=ROOT / ".cache/shanghai-latest.osm.pbf")
    parser.add_argument("--poly", type=Path, default=ROOT / ".cache/shanghai.poly")
    parser.add_argument("--out-dir", type=Path, default=ROOT / "data")
    args = parser.parse_args()
    for url, path in [(PBF_URL, args.pbf), (POLY_URL, args.poly)]:
        if args.refresh or not path.exists():
            print(f"Downloading {url}", flush=True)
            download(url, path)

    reader = osmium.io.Reader(str(args.pbf))
    header = reader.header()
    data_date = header.get("osmosis_replication_timestamp") or None
    reader.close()
    coverage = parse_poly(args.poly)
    extractor = Extractor()
    print("Extracting real OSM nodes and areas…", flush=True)
    extractor.apply_file(str(args.pbf), locations=True, idx="flex_mem")
    # A closed linear sports way may also be emitted by the area assembler. Keep
    # one object, with polygon geometry preferred because area callbacks run last.
    unique_objects = {feature["id"]: feature for feature in extractor.features}
    duplicate_object_count = len(extractor.features) - len(unique_objects)
    features, duplicate_count = deduplicate(list(unique_objects.values()), extractor.area_geometries)
    features, sports_grouping = group_sports(features, extractor.area_geometries, extractor.restricted_sports_areas)
    metro_grouping = group_metro(features, extractor.stations, extractor.stop_areas, extractor.stop_area_groups)
    features.sort(key=lambda f: (f["properties"]["category"], f["id"]))
    counts = {category: sum(f["properties"]["category"] == category for f in features) for category in LABELS}
    group_counts = {category: len({f["properties"]["groupId"] for f in features
                                   if f["properties"]["category"] == category}) for category in LABELS}
    methods_by_category = {category: dict(Counter(f["properties"]["groupingMethod"] for f in features
                                                 if f["properties"]["category"] == category)) for category in LABELS}
    assert len({f["id"] for f in features}) == len(features), "Duplicate feature IDs"
    for feature in features:
        lon, lat = feature["geometry"]["coordinates"]
        assert math.isfinite(lon) and math.isfinite(lat) and -180 <= lon <= 180 and -90 <= lat <= 90
        props = feature["properties"]
        assert props["groupId"] and props["groupName"] and props["groupingMethod"]
    assert not metro_grouping["heuristicDistanceValidationErrors"], "Metro association exceeds 350 m"
    assert not sports_grouping["containmentErrors"], "Sports group containment error"
    data_hash = hashlib.sha256(args.pbf.read_bytes()).hexdigest()
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    metadata = {
        "schemaVersion": 2,
        "source": "OpenStreetMap contributors / Geofabrik Shanghai extract",
        "sourceUrl": SOURCE_PAGE,
        "downloadUrl": PBF_URL,
        "license": "ODbL-1.0",
        "licenseUrl": "https://www.openstreetmap.org/copyright",
        "attribution": "© OpenStreetMap contributors",
        "coordinateSystem": "WGS84 (EPSG:4326)",
        "downloadedAt": datetime.fromtimestamp(args.pbf.stat().st_mtime, timezone.utc).isoformat().replace("+00:00", "Z"),
        "generatedAt": now,
        "dataDate": data_date,
        "coverageBBox": list(coverage.bounds),
        "coverageType": "Geofabrik Shanghai extract (includes a border buffer; not an administrative boundary)",
        "counts": counts,
        "groupCounts": group_counts,
        "totalGroupCount": sum(group_counts.values()),
        "totalCount": len(features),
        "sourceSha256": data_hash,
        "removedDuplicateNodeCount": duplicate_count,
        "removedDuplicateObjectCount": duplicate_object_count,
        "grouping": {
            "countingRule": "For each category, count unique properties.groupId within the requested radius; use minimum member distance for each group.",
            "idStability": "IDs use source OSM object IDs. Stable for the same OSM objects and grouping snapshot; changes to OSM membership can change a group.",
            "methodsByCategory": methods_by_category,
            "metro": metro_grouping,
            "sports": sports_grouping,
        },
        "accessFiltering": {
            "categories": ["sports", "library"],
            "excludedExplicitAccess": {category: extractor.excluded_access.get(category, 0)
                                       for category in ("sports", "library")},
            "excludedAccessValues": sorted(RESTRICTED_ACCESS),
            "sportsWithinRestrictedAreaExcluded": sports_grouping["excludedInsideRestrictedSportArea"],
            "retainedConditionalAccessCounts": {
                category: dict(Counter(f["properties"].get("access") for f in features
                                       if f["properties"]["category"] == category
                                       and f["properties"].get("access")
                                       and f["properties"].get("access") not in ("yes", "public", "permissive")))
                for category in ("sports", "library")},
            "limitation": "Missing access tags do not establish public access. School/campus/residential access is not inferred. Original four category filters are unchanged.",
        },
        "geometryErrors": dict(extractor.errors),
        "categories": {
            "cafe": {"label": "咖啡店", "osmFilter": "amenity=cafe"},
            "mall": {"label": "商场", "osmFilter": "shop=mall"},
            "school": {"label": "学校", "osmFilter": "amenity=school (excludes kindergarten/university)"},
            "metro": {"label": "地铁入口", "osmFilter": "railway=subway_entrance"},
            "sports": {"label": "运动设施", "osmFilter": "leisure IN (" + ", ".join(sorted(SPORTS_TYPES)) + "); excludes access=no/private",
                       "parentVenueTypes": sorted(SPORTS_VENUES)},
            "library": {"label": "图书馆", "osmFilter": "amenity=library; excludes access=no/private"},
        },
        "tagDocumentation": [
            "https://wiki.openstreetmap.org/wiki/Tag:amenity=library",
            "https://wiki.openstreetmap.org/wiki/Tag:leisure=sports_centre",
            "https://wiki.openstreetmap.org/wiki/Tag:leisure=fitness_centre",
            "https://wiki.openstreetmap.org/wiki/Tag:leisure=fitness_station",
            "https://wiki.openstreetmap.org/wiki/Tag:leisure=pitch",
            "https://wiki.openstreetmap.org/wiki/Tag:public_transport=stop_area",
            "https://wiki.openstreetmap.org/wiki/Tag:railway=subway_entrance",
            "https://wiki.openstreetmap.org/wiki/Key:access",
        ],
        "limitations": [
            "OSM volunteer coverage is incomplete and uneven. Counts are mapped objects, not a complete facilities census.",
            "Distances are straight-line geographic distances; rivers, walls, entrances and walking access are not modeled.",
            "Polygon facilities use an interior representative point, not a surveyed entrance.",
            "Metro entrance points are retained for distance; counts deduplicate explicit stop-area groups and bounded station associations. Unassociated entrances remain separate groups and may overcount stations.",
            "Metro nearest-station fallback and same-named station merges are geographic heuristics bounded to 350 m per association, not verified pedestrian links; nearby stations may be misassigned.",
            "Sports counts collapse mapped child facilities only when their complete geometry lies inside a mapped sports_centre, sports_hall or stadium polygon. Missing venue boundaries can still overcount adjacent courts.",
            "Sports/library access=no/private objects are removed; missing access tags, customer/member limits, campus access and opening times prevent a guarantee of public availability.",
            "A same-named POI node inside a mapped facility polygon is removed; other potential duplicates may remain.",
            "The extract has a border buffer and does not guarantee all facilities beyond the Shanghai boundary.",
            "School tags do not establish school quality, catchment, enrollment eligibility or public access.",
        ],
    }
    args.out_dir.mkdir(parents=True, exist_ok=True)
    (args.out_dir / "pois.geojson").write_text(json.dumps({"type": "FeatureCollection", "metadata": metadata,
                                                        "features": features}, ensure_ascii=False, separators=(",", ":")) + "\n")
    if extractor.boundaries:
        boundary_features = extractor.boundaries
        boundary_type = "OSM administrative boundary (may include territorial water)"
    else:
        boundary_features = [{"type": "Feature", "geometry": mapping(coverage), "properties": {
            "name": "上海数据覆盖范围", "source": "Geofabrik", "boundaryType": "extract_coverage"}}]
        boundary_type = "Geofabrik extract coverage only; not an administrative boundary"
    (args.out_dir / "boundary.geojson").write_text(json.dumps({"type": "FeatureCollection", "metadata": {
        "source": metadata["source"], "sourceUrl": SOURCE_PAGE, "license": "ODbL-1.0", "dataDate": data_date,
        "boundaryType": boundary_type, "coordinateSystem": "WGS84 (EPSG:4326)"}, "features": boundary_features},
        ensure_ascii=False, separators=(",", ":")) + "\n")
    (args.out_dir / "metadata.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n")
    (args.out_dir / "water.geojson").write_text(json.dumps({"type": "FeatureCollection", "metadata": {
        "source": metadata["source"], "sourceUrl": SOURCE_PAGE, "license": "ODbL-1.0", "dataDate": data_date,
        "filter": "natural=water OR waterway=riverbank (mapped inland water surfaces, not all sea)",
        "simplificationToleranceDegrees": 0.00002, "featureCount": len(extractor.waters),
        "coordinateSystem": "WGS84 (EPSG:4326)",
        "limitation": "Incomplete mapped water mask; simplify preserves topology but shorelines are approximate. Not a land-use/accessibility mask."},
        "features": extractor.waters}, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(json.dumps({"counts": counts, "total": len(features), "boundaryType": boundary_type,
                      "groupCounts": group_counts, "metroGrouping": metro_grouping,
                      "sportsGrouping": sports_grouping, "excludedAccess": dict(extractor.excluded_access),
                      "removedDuplicates": duplicate_count, "waterCount": len(extractor.waters), "geometryErrors": dict(extractor.errors)},
                     ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
