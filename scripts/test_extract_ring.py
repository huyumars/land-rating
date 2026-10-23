"""Topology and actual-source quality checks for the operational G1503 ring."""
from collections import defaultdict
import json
from pathlib import Path
import unittest

from shapely.geometry import Point, shape

from extract_ring import build_graph, enclosed_loops, strongly_connected_components, trace_cycle


class TopologyTests(unittest.TestCase):
    def test_cycle_can_exclude_open_candidate_tail(self):
        outgoing = {1: [(2, 10)], 2: [(3, 11), (5, 99)], 3: [(4, 12)], 4: [(1, 13)]}
        incoming = defaultdict(list)
        for node, edges in outgoing.items():
            for neighbor, way_id in edges:
                incoming[neighbor].append((node, way_id))
        components = strongly_connected_components(outgoing, incoming)
        closed = next(component for component in components if len(component) > 1)
        self.assertEqual(closed, {1, 2, 3, 4})
        loop = trace_cycle(closed, outgoing, {1: [0, 0], 2: [1, 0], 3: [1, 1], 4: [0, 1]})
        self.assertTrue(loop["polygon"].is_valid)
        self.assertEqual(loop["path"][0], loop["path"][-1])
        self.assertNotIn(99, [edge["wayId"] for edge in loop["edges"]])

    def test_equal_coordinates_do_not_join_distinct_osm_nodes(self):
        ways = {1: {"id": 1, "nodes": [[10, 0, 0], [11, 1, 0]]},
                2: {"id": 2, "nodes": [[12, 1, 0], [13, 1, 1]]}}
        outgoing, incoming, _ = build_graph(ways)
        components = strongly_connected_components(outgoing, incoming)
        self.assertTrue(all(len(component) == 1 for component in components))
        self.assertNotIn(12, [node for node, _ in outgoing.get(11, [])])
        with self.assertRaisesRegex(ValueError, "refusing synthetic closure"):
            enclosed_loops(ways)

    def test_invalid_self_crossing_cycle_is_not_repaired(self):
        with self.assertRaisesRegex(ValueError, "no automatic repair"):
            trace_cycle({1, 2, 3, 4}, {1: [(2, 1)], 2: [(3, 2)], 3: [(4, 3)], 4: [(1, 4)]},
                        {1: [0, 0], 2: [1, 1], 3: [0, 1], 4: [1, 0]})

    def test_conflicting_same_node_sources_fail(self):
        with self.assertRaisesRegex(ValueError, "Conflicting coordinates"):
            build_graph({1: {"id": 1, "nodes": [[10, 0, 0], [11, 1, 0]]},
                         2: {"id": 2, "nodes": [[11, 1.01, 0], [12, 1, 1]]}})


class CurrentDataTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        path = Path(__file__).resolve().parents[1] / "data/suburban-ring.geojson"
        cls.data = json.loads(path.read_text())
        cls.polygon = shape(cls.data["features"][0]["geometry"])

    def test_actual_source_geometry_and_coverage(self):
        self.assertEqual(len(self.data["features"]), 1)
        self.assertEqual(self.polygon.geom_type, "Polygon")
        self.assertTrue(self.polygon.is_valid)
        self.assertEqual(list(self.polygon.bounds), self.data["bbox"])
        for point in self.data["metadata"]["validationPoints"]:
            self.assertEqual(self.polygon.covers(Point(point["coordinates"])), point["expectedInside"])

    def test_actual_sources_and_every_edge_have_road_lineage(self):
        metadata = self.data["metadata"]
        self.assertEqual(metadata["dataDate"], "2026-10-20T20:23:47Z")
        self.assertEqual({source["dataDate"] for source in metadata["sources"]}, {metadata["dataDate"]})
        self.assertEqual(metadata["gapCount"], 0)
        self.assertEqual(metadata["syntheticEdgeCount"], 0)
        self.assertEqual(metadata["maximumJoinGapM"], 0)
        self.assertEqual(sum(member["usedSegmentCount"] for member in metadata["routeMembers"]),
                         len(self.polygon.exterior.coords) - 1)
        self.assertEqual(len(metadata["wayIds"]), len(set(metadata["wayIds"])))
        self.assertEqual(metadata["westernSupplement"]["addedWayIds"], [106977592, 182222835, 182222838, 182222842])
        self.assertLess(metadata["areaKm2"], metadata["alternateCarriagewayAreaKm2"])
        self.assertAlmostEqual(metadata["areaKm2"], 2971.978, places=3)


if __name__ == "__main__":
    unittest.main()
