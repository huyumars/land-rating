#!/usr/bin/env python3
"""Create the current G1503 operational-road enclosure from exact OSM topology.

No convex hull, rectangle, endpoint snapping, straight-line gap filling, polygon
repair, or coastline approximation is used. Missing source roads fail explicitly.
The same-day Jiangsu extract supplies four real ways omitted by Shanghai's crop.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import urllib.request

import osmium
from shapely.geometry import Point, Polygon, mapping
from shapely.geometry.polygon import orient
from shapely.validation import explain_validity

ROOT = Path(__file__).resolve().parents[1]
ROUTE_ID = 236871
EARTH_RADIUS_M = 6371008.8
JIANGSU_URL = "https://download.geofabrik.de/asia/china/jiangsu-261020.osm.pbf"
CENTRE = [121.4751, 31.2304]
VALIDATION_POINTS = [
    {"name": "人民广场", "coordinates": CENTRE, "expectedInside": True},
    {"name": "宝山图书馆", "coordinates": [121.4855934, 31.3974444], "expectedInside": True,
     "osmId": "node/2123875901"},
    {"name": "嘉定图书馆", "coordinates": [121.2593345, 31.3524917], "expectedInside": True,
     "osmId": "relation/19008953"},
    {"name": "朱家角镇图书馆", "coordinates": [121.0416792, 31.1049493], "expectedInside": False,
     "osmId": "way/1362865177"},
    {"name": "上海市滴水湖学校", "coordinates": [121.9535712, 30.9116341], "expectedInside": False,
     "osmId": "way/1410782499"},
    {"name": "北部工业区验证坐标", "coordinates": [121.47, 31.43], "expectedInside": False},
]
OFFICIAL_REFERENCES = [
    {"date": "2022-11-28", "title": "浦西沿江A、B段连接原G1503与郊环隧道通车",
     "url": "https://jtw.sh.gov.cn/xydt/20221128/18062f2369a5450f8a339d18f9803fc1.html"},
    {"date": "2025-07-17", "title": "沿江通道浦东段持续推进：独立成环最后一段仍在建",
     "url": "https://www.shanghai.gov.cn/nw15343/20250717/42fffcbc63c544dfb0ee6a5654636273.html"},
    {"date": "2026-09-21", "title": "规资局解读仍列加快G1503沿江通道浦东段规划建设",
     "url": "https://ghzyj.sh.gov.cn/zcjd/20260921/d53a79dab17a4a9ab45093acb6fa207d.html"},
    {"date": "2026-10-09", "title": "沿江通道浦东段主线4标仍有在建工地活动",
     "url": "https://jtw.sh.gov.cn/xydt/20261009/4520f5f9232544458f416d74a51cdb0d.html"},
]


def distance_m(a, b):
    lon1, lat1, lon2, lat2 = map(math.radians, [*a, *b])
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return EARTH_RADIUS_M * 2 * math.asin(min(1, math.sqrt(h)))


def spherical_area_km2(coordinates):
    # Spherical area is sufficient for a displayed approximate area; the geometry
    # itself remains the unmodified WGS84 source road-node coordinates.
    return abs(sum(math.radians(b[0] - a[0]) * (math.sin(math.radians(a[1])) + math.sin(math.radians(b[1])))
                   for a, b in zip(coordinates, coordinates[1:]))) * EARTH_RADIUS_M ** 2 / 2 / 1e6


def header_date(path):
    reader = osmium.io.Reader(str(path))
    timestamp = reader.header().get("osmosis_replication_timestamp")
    reader.close()
    return timestamp


class RouteReader(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.route = None

    def relation(self, relation):
        if relation.id == ROUTE_ID:
            self.route = {"id": f"relation/{relation.id}", "osmUrl": f"https://www.openstreetmap.org/relation/{relation.id}",
                          "tags": dict(relation.tags), "version": relation.version,
                          "timestamp": str(relation.timestamp),
                          "members": [{"type": m.type, "id": m.ref, "role": m.role} for m in relation.members]}


class RoadReader(osmium.SimpleHandler):
    def __init__(self, source_name, route_way_ids, connectors=True):
        super().__init__()
        self.source_name = source_name
        self.route_way_ids = route_way_ids
        self.connectors = connectors
        self.ways = {}
        self.excluded_construction_ids = []

    def way(self, way):
        tags = dict(way.tags)
        highway = tags.get("highway")
        refs = {ref.strip() for ref in tags.get("ref", "").split(";")}
        member = way.id in self.route_way_ids
        if highway == "construction" and ("G1503" in refs or member):
            self.excluded_construction_ids.append(way.id)
            return
        mainline = highway == "motorway" and "G1503" in refs
        connector = self.connectors and member and highway == "motorway_link"
        if not mainline and not connector:
            return
        if tags.get("oneway") not in ("yes", "1", "-1"):
            raise ValueError(f"way/{way.id} has ambiguous one-way direction; inspect source before continuing")
        nodes = [[node.ref, node.lon, node.lat] for node in way.nodes]
        if len(nodes) < 2:
            raise ValueError(f"way/{way.id} is missing road geometry")
        if tags.get("oneway") == "-1":
            nodes.reverse()
        self.ways[way.id] = {"id": way.id, "tags": tags, "nodes": nodes, "sourceExtract": self.source_name,
                             "version": way.version, "timestamp": str(way.timestamp), "relationMember": member}


def build_graph(ways):
    outgoing, incoming = defaultdict(list), defaultdict(list)
    coordinates = {}
    for way in ways.values():
        for node_id, lon, lat in way["nodes"]:
            xy = [lon, lat]
            if node_id in coordinates and coordinates[node_id] != xy:
                raise ValueError(f"Conflicting coordinates for OSM node/{node_id}; sources may not share a snapshot")
            coordinates[node_id] = xy
        for first, second in zip(way["nodes"], way["nodes"][1:]):
            outgoing[first[0]].append((second[0], way["id"]))
            incoming[second[0]].append((first[0], way["id"]))
    return outgoing, incoming, coordinates


def strongly_connected_components(outgoing, incoming):
    """Iterative Kosaraju: do not mistake geographic bridge crossings for nodes."""
    nodes = set(outgoing) | set(incoming)
    seen, order = set(), []
    for start in sorted(nodes):
        if start in seen:
            continue
        seen.add(start)
        stack = [(start, iter(outgoing.get(start, [])))]
        while stack:
            node, neighbors = stack[-1]
            try:
                neighbor, _ = next(neighbors)
                if neighbor not in seen:
                    seen.add(neighbor)
                    stack.append((neighbor, iter(outgoing.get(neighbor, []))))
            except StopIteration:
                order.append(node)
                stack.pop()
    seen, components = set(), []
    for start in reversed(order):
        if start in seen:
            continue
        seen.add(start)
        component, stack = set(), [start]
        while stack:
            node = stack.pop()
            component.add(node)
            for neighbor, _ in incoming.get(node, []):
                if neighbor not in seen:
                    seen.add(neighbor)
                    stack.append(neighbor)
        components.append(component)
    return components


def trace_cycle(component, outgoing, coordinates):
    internal = {node: [(next_node, way_id) for next_node, way_id in outgoing.get(node, []) if next_node in component]
                for node in component}
    if any(len(edges) != 1 for edges in internal.values()):
        raise ValueError("Candidate ring branches inside a strongly-connected component; manual route inspection required")
    indegrees = Counter(next_node for edges in internal.values() for next_node, _ in edges)
    if any(indegrees[node] != 1 for node in component):
        raise ValueError("Candidate ring has non-unique incoming road topology")
    start, node = min(component), min(component)
    nodes, edges = [], []
    while True:
        nodes.append(node)
        next_node, way_id = internal[node][0]
        edges.append({"fromNodeId": node, "toNodeId": next_node, "wayId": way_id})
        node = next_node
        if node == start:
            break
        if len(nodes) >= len(component):
            raise ValueError("Road traversal did not close on its original OSM node")
    if len(nodes) != len(component):
        raise ValueError("Road traversal missed nodes in its candidate cycle")
    # The repeated final coordinate is an existing closing road segment, never
    # a new geometric shortcut connecting unrelated endpoints.
    path = [coordinates[node] for node in nodes + [start]]
    polygon = Polygon(path)
    if not polygon.is_valid:
        raise ValueError(f"Road cycle polygon invalid: {explain_validity(polygon)}; no automatic repair applied")
    return {"polygon": polygon, "path": path, "edges": edges, "nodeIds": nodes,
            "areaKm2": spherical_area_km2(path),
            "lengthKm": sum(distance_m(a, b) for a, b in zip(path, path[1:])) / 1000}


def enclosed_loops(ways):
    outgoing, incoming, coordinates = build_graph(ways)
    loops = []
    for component in strongly_connected_components(outgoing, incoming):
        if len(component) < 100:
            continue
        loop = trace_cycle(component, outgoing, coordinates)
        if loop["areaKm2"] > 500 and loop["polygon"].covers(Point(CENTRE)):
            loops.append(loop)
    if len(loops) != 2:
        raise ValueError(f"Expected two complete operational carriageway loops, found {len(loops)}. "
                         "Source roads are missing or route topology changed; refusing synthetic closure.")
    return sorted(loops, key=lambda loop: loop["areaKm2"])


def route_members(loop, ways):
    used = {}
    for edge in loop["edges"]:
        way = ways[edge["wayId"]]
        record = used.setdefault(way["id"], {"osmId": f"way/{way['id']}", "id": way["id"],
            "osmUrl": f"https://www.openstreetmap.org/way/{way['id']}", "sourceExtract": way["sourceExtract"],
            "relationMember": way["relationMember"], "version": way["version"], "timestamp": way["timestamp"],
            "highway": way["tags"]["highway"], "ref": way["tags"].get("ref"), "name": way["tags"].get("name"),
            "sourceNodeCount": len(way["nodes"]), "usedSegmentCount": 0, "usedNodeRanges": []})
        ranges = record["usedNodeRanges"]
        if ranges and ranges[-1]["toNodeId"] == edge["fromNodeId"]:
            ranges[-1]["toNodeId"] = edge["toNodeId"]
        else:
            ranges.append({"fromNodeId": edge["fromNodeId"], "toNodeId": edge["toNodeId"]})
        record["usedSegmentCount"] += 1
    return list(used.values())


def source_record(path, source_name, url):
    return {"name": source_name, "fileName": path.name, "url": url, "dataDate": header_date(path),
            "downloadedAt": datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat().replace("+00:00", "Z"),
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


def download_missing(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".part")
    print(f"Downloading same-day Jiangsu source (~76 MB): {JIANGSU_URL}", flush=True)
    with urllib.request.urlopen(JIANGSU_URL, timeout=120) as response, temporary.open("wb") as output:
        while chunk := response.read(1024 * 1024):
            output.write(chunk)
    temporary.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pbf", type=Path, default=ROOT / ".cache/shanghai-latest.osm.pbf")
    parser.add_argument("--jiangsu", type=Path, default=ROOT / ".cache/jiangsu-261020.osm.pbf")
    parser.add_argument("--out", type=Path, default=ROOT / "data/suburban-ring.geojson")
    parser.add_argument("--download-missing", action="store_true", help="Download the fixed same-day Jiangsu supplement if absent")
    args = parser.parse_args()
    if not args.jiangsu.exists() and args.download_missing:
        download_missing(args.jiangsu)
    if not args.pbf.exists() or not args.jiangsu.exists():
        raise FileNotFoundError("Shanghai PBF and same-day Jiangsu PBF are both required. "
                                "Use --download-missing for the 2026-10-20 Jiangsu source; no synthetic fallback is available.")
    dates = [header_date(args.pbf), header_date(args.jiangsu)]
    if not dates[0] or dates[0] != dates[1]:
        raise ValueError(f"PBF snapshots do not match: {dates}; obtain matching snapshots before extracting")

    route_reader = RouteReader()
    route_reader.apply_file(str(args.pbf))
    route = route_reader.route
    if not route or route["tags"].get("ref") != "G1503":
        raise ValueError("Reference G1503 road route relation/236871 missing or changed")
    route_ids = {member["id"] for member in route["members"] if member["type"] == "w"}
    print("Reading Shanghai mainlines and route-member motorway links…", flush=True)
    shanghai = RoadReader("shanghai", route_ids)
    shanghai.apply_file(str(args.pbf), locations=True, idx="flex_mem")
    print("Reading same-day Jiangsu G1503 ways omitted by Shanghai crop…", flush=True)
    jiangsu = RoadReader("jiangsu", route_ids, connectors=False)
    jiangsu.apply_file(str(args.jiangsu), locations=True, idx="flex_mem")
    ways = dict(shanghai.ways)
    supplement_ids = []
    for identifier, way in jiangsu.ways.items():
        if identifier in ways:
            if ways[identifier]["nodes"] != way["nodes"]:
                raise ValueError(f"Overlapping way/{identifier} differs between same-date extracts")
        else:
            ways[identifier] = way
            supplement_ids.append(identifier)

    loops = enclosed_loops(ways)
    selected, alternate = loops
    polygon = orient(selected["polygon"], sign=1.0)
    checks = [{**point, "actualInside": polygon.covers(Point(point["coordinates"]))} for point in VALIDATION_POINTS]
    if any(check["actualInside"] != check["expectedInside"] for check in checks):
        raise ValueError(f"Ring coverage validation failed: {checks}")
    members = route_members(selected, ways)
    used_way_ids = {member["id"] for member in members}
    bbox = list(polygon.bounds)
    snapshot_stamp = datetime.fromisoformat(dates[0].replace("Z", "+00:00")).strftime("%y%m%d")
    metadata = {
        "source": "OpenStreetMap contributors / Geofabrik same-day Shanghai and Jiangsu extracts",
        "sourceUrl": "https://download.geofabrik.de/asia/china/shanghai.html",
        "dataDate": dates[0], "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "license": "ODbL-1.0", "licenseUrl": "https://www.openstreetmap.org/copyright",
        "attribution": "© OpenStreetMap contributors", "coordinateSystem": "WGS84 (EPSG:4326)",
        "boundaryType": "operational_road_ring_enclosure", "bbox": bbox,
        "areaKm2": round(selected["areaKm2"], 3), "perimeterKm": round(selected["lengthKm"], 3),
        "areaMethod": "Spherical polygon area using IUGG mean Earth radius 6371008.8 m; approximate, not cadastral area",
        "method": "Exact OSM node topology. Candidate roads are G1503-tagged operational motorway mainlines and motorway_link members "
                  "of route relation/236871. Identify both directed closed carriageway cycles, validate geographic coverage, and select "
                  "the smaller-area valid loop. No hull, rectangle, snapping, straight-line gap filling, repair or simplification.",
        "northernClosure": "Use operational G1503 Jiaohuan Tunnel and Puxi elevated approach, real Linghai interchange links, "
                           "and Pudong G1503;S20 shared section. Use real Gaodong/Wuzhou interchange ramps. "
                           "Exclude under-construction independent Pudong riverside G1503 viaduct.",
        "westernSupplement": {"reason": "About 2 km of the real G1503 road in Huaqiao is outside Geofabrik Shanghai crop",
                              "sourceExtract": "jiangsu", "sameSnapshot": True,
                              "addedWayIds": sorted(supplement_ids),
                              "selectedWayIds": sorted(used_way_ids & set(supplement_ids))},
        "sources": [source_record(args.pbf, "shanghai", f"https://download.geofabrik.de/asia/china/shanghai-{snapshot_stamp}.osm.pbf"),
                    source_record(args.jiangsu, "jiangsu", f"https://download.geofabrik.de/asia/china/jiangsu-{snapshot_stamp}.osm.pbf")],
        "routeRelation": {key: value for key, value in route.items() if key != "members"},
        "routeRelationMemberCount": len(route["members"]), "candidateWayCount": len(ways),
        "excludedConstructionWayIds": sorted(set(shanghai.excluded_construction_ids + jiangsu.excluded_construction_ids)),
        "directedLoopCount": len(loops), "alternateCarriagewayAreaKm2": round(alternate["areaKm2"], 3),
        "carriagewayChoice": "Smaller-area operational direction; this is not guaranteed to be geometrically inset at every interchange",
        "vertexCountIncludingClosure": len(polygon.exterior.coords),
        "wayIds": [member["id"] for member in members], "routeMembers": members,
        "routeMemberOrder": "First occurrence in the drivable directed cycle. GeoJSON exterior is oriented counterclockwise per RFC7946.",
        "gapCount": 0, "maximumJoinGapM": 0, "syntheticEdgeCount": 0, "endpointSnappingToleranceM": 0,
        "simplificationToleranceM": 0, "geometryValid": polygon.is_valid, "validationPoints": checks,
        "officialRouteContext": OFFICIAL_REFERENCES,
        "limitations": [
            "This is a reproducible product analysis area enclosed by mapped operating roads, not an official legal or administrative area.",
            "The boundary follows one real directional carriageway rather than a surveyed motorway centerline; side-of-road differences are visible at ramps.",
            "Current northern closure includes the Pudong S20 shared section; the independent G1503 Pudong riverside viaduct was still under construction in official 2026 sources.",
            "The western Huaqiao gap in the Shanghai crop is supplied by four real ways from an identical-date Jiangsu extract, never by a straight chord.",
            "OSM mapping and operational status can lag real roads. Snapshot-specific relation/route topology must be checked again before refreshing.",
            "Area and perimeter are spherical approximations. The polygon is neither a navigable land mask nor a survey of highway right-of-way.",
        ],
    }
    result = {"type": "FeatureCollection", "bbox": bbox, "metadata": metadata,
              "features": [{"type": "Feature", "id": "shanghai-suburban-ring",
                            "properties": {"name": "上海郊环内（G1503现状通车环线）", "source": "OpenStreetMap",
                                           "areaKm2": metadata["areaKm2"]}, "geometry": mapping(polygon)}]}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.out.with_suffix(args.out.suffix + ".part")
    temporary.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n")
    temporary.replace(args.out)
    print(json.dumps({"path": str(args.out), "bbox": bbox, "areaKm2": metadata["areaKm2"],
                      "selectedWayCount": len(members), "supplementWayIds": sorted(supplement_ids),
                      "gapCount": 0, "allValidationPointsPassed": True}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
