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
from pathlib import Path
import urllib.request

import osmium
from shapely.geometry import Point, mapping, shape

ROOT = Path(__file__).resolve().parents[1]
PBF_URL = "https://download.geofabrik.de/asia/china/shanghai-latest.osm.pbf"
POLY_URL = "https://download.geofabrik.de/asia/china/shanghai.poly"
SOURCE_PAGE = "https://download.geofabrik.de/asia/china/shanghai.html"
LABELS = {"cafe": "咖啡店", "mall": "商场", "school": "学校", "metro": "地铁入口"}


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
    return None


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
        self.boundaries = []
        self.waters = []
        self.errors = Counter()

    def add(self, kind: str, identifier: int, tags: dict[str, str], point, category: str,
            point_type: str, geometry=None):
        osm_id = f"{kind}/{identifier}"
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
        }
        for key in ["name:en", "brand", "operator", "ref", "local_ref", "wheelchair", "access", "opening_hours"]:
            if tags.get(key):
                properties[key] = tags[key]
        if category == "school":
            properties["schoolType"] = tags.get("school:CN") or tags.get("school") or "未分类"
        self.features.append({"type": "Feature", "id": osm_id, "geometry": {
            "type": "Point", "coordinates": [round(point.x, 7), round(point.y, 7)]},
            "properties": properties})
        if geometry is not None:
            self.area_geometries[osm_id] = geometry

    def node(self, node):
        tags = dict(node.tags)
        category = category_for(tags)
        if category and node.location.valid():
            self.add("node", node.id, tags, Point(node.location.lon, node.location.lat), category,
                     "subway_entrance" if category == "metro" else "osm_node")

    def area(self, area):
        tags = dict(area.tags)
        category = category_for(tags)
        is_water = tags.get("natural") == "water" or tags.get("waterway") == "riverbank"
        is_shanghai = (tags.get("boundary") == "administrative" and tags.get("admin_level") == "4"
                       and (tags.get("name") in ("上海市", "上海", "Shanghai")
                            or tags.get("name:en") == "Shanghai"))
        if not category and not is_shanghai and not is_water:
            return
        try:
            geometry = shape(json.loads(self.factory.create_multipolygon(area)))
            if not geometry.is_valid:
                geometry = geometry.buffer(0)
            if geometry.is_empty:
                raise ValueError("empty geometry")
            kind = "way" if area.from_way() else "relation"
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
    features, duplicate_count = deduplicate(extractor.features, extractor.area_geometries)
    features.sort(key=lambda f: (f["properties"]["category"], f["id"]))
    counts = {category: sum(f["properties"]["category"] == category for f in features) for category in LABELS}
    data_hash = hashlib.sha256(args.pbf.read_bytes()).hexdigest()
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    metadata = {
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
        "totalCount": len(features),
        "sourceSha256": data_hash,
        "removedDuplicateNodeCount": duplicate_count,
        "geometryErrors": dict(extractor.errors),
        "categories": {
            "cafe": {"label": "咖啡店", "osmFilter": "amenity=cafe"},
            "mall": {"label": "商场", "osmFilter": "shop=mall"},
            "school": {"label": "学校", "osmFilter": "amenity=school (excludes kindergarten/university)"},
            "metro": {"label": "地铁入口", "osmFilter": "railway=subway_entrance"},
        },
        "limitations": [
            "OSM volunteer coverage is incomplete and uneven. Counts are mapped objects, not a complete facilities census.",
            "Distances are straight-line geographic distances; rivers, walls, entrances and walking access are not modeled.",
            "Polygon facilities use an interior representative point, not a surveyed entrance.",
            "Metro features are individually mapped subway entrances; multiple entrances of one station are retained.",
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
                      "removedDuplicates": duplicate_count, "waterCount": len(extractor.waters), "geometryErrors": dict(extractor.errors)},
                     ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
