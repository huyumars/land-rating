"""Meaningful grouping invariants; no network or source PBF required."""
import unittest

from shapely.geometry import box
from extract_osm import Extractor, category_for, group_metro, group_sports


def feature(identifier, category, xy=(121.47, 31.23), **properties):
    return {"type": "Feature", "id": identifier,
            "geometry": {"type": "Point", "coordinates": list(xy)},
            "properties": {"id": identifier, "category": category, "name": identifier,
                           "groupId": f"{category}:{identifier}", "groupName": identifier,
                           "groupingMethod": "individual_osm_object", **properties}}


class GroupingTests(unittest.TestCase):
    def test_explicit_station_membership_and_bounded_fallback(self):
        points = [feature("node/1", "metro", (121.47, 31.23)),
                  feature("node/2", "metro", (121.471, 31.23)),
                  feature("node/3", "metro", (121.49, 31.23))]
        stations = {"node/10": {"name": "测试站", "coordinates": [121.47, 31.23]}}
        stats = group_metro(points, stations, {"relation/1": {"name": "测试站", "members": ["node/1", "node/10"]}}, {})
        self.assertEqual(points[0]["properties"]["groupId"], points[1]["properties"]["groupId"])
        self.assertNotEqual(points[1]["properties"]["groupId"], points[2]["properties"]["groupId"])
        self.assertEqual(stats["associatedEntranceCount"], 2)
        self.assertEqual(stats["unassociatedEntranceIds"], ["node/3"])
        self.assertEqual(points[0]["properties"]["groupingMethod"], "osm_stop_area_membership")

    def test_same_name_never_merges_distant_stations(self):
        points = [feature("node/1", "metro", (121.47, 31.23)),
                  feature("node/2", "metro", (121.57, 31.23))]
        stations = {"node/10": {"name": "同名站", "coordinates": [121.47, 31.23]},
                    "node/11": {"name": "同名站", "coordinates": [121.57, 31.23]}}
        group_metro(points, stations, {}, {})
        self.assertNotEqual(points[0]["properties"]["groupId"], points[1]["properties"]["groupId"])

    def test_mapped_transfer_group_unifies_line_relations(self):
        points = [feature("node/1", "metro"), feature("node/2", "metro")]
        areas = {"relation/10": {"name": "甲线站", "members": ["node/1"]},
                 "relation/11": {"name": "乙线站", "members": ["node/2"]}}
        groups = {"relation/20": {"name": "换乘站", "members": list(areas)}}
        group_metro(points, {}, areas, groups)
        self.assertEqual(points[0]["properties"]["groupId"], "metro:relation/20")
        self.assertEqual(points[1]["properties"]["groupId"], "metro:relation/20")

    def test_sports_complete_geometry_and_outer_venue(self):
        points = [feature("way/1", "sports", (1, 1), sportsType="sports_centre"),
                  feature("way/2", "sports", (1, 1), sportsType="stadium"),
                  feature("way/3", "sports", (1, 1), sportsType="pitch"),
                  feature("way/4", "sports", (1, 1), sportsType="pitch")]
        areas = {"way/1": box(0, 0, 4, 4), "way/2": box(.5, .5, 3, 3),
                 "way/3": box(1, 1, 2, 2), "way/4": box(1, 1, 5, 5)}
        result, stats = group_sports(points, areas, {})
        self.assertEqual(result[2]["properties"]["groupId"], "sports:way/1")
        self.assertEqual(result[1]["properties"]["groupId"], "sports:way/1")
        # The fourth representative point is inside the venue but its full polygon is not.
        self.assertEqual(result[3]["properties"]["groupId"], "sports:way/4")
        self.assertEqual(stats["containedMembersChecked"], 2)

    def test_access_exclusions_and_member_access_preserved(self):
        extractor = Extractor()
        from shapely.geometry import Point
        for identifier, category, tags in [(1, "sports", {"leisure": "pitch", "access": "private"}),
                                           (2, "library", {"amenity": "library", "access": "no"}),
                                           (3, "sports", {"leisure": "fitness_centre", "access": "members"})]:
            extractor.add("node", identifier, tags, Point(1, 1), category, "osm_node")
        self.assertEqual(len(extractor.features), 1)
        self.assertEqual(extractor.features[0]["properties"]["access"], "members")
        result, stats = group_sports(extractor.features, {}, {"way/1": box(0, 0, 2, 2)})
        self.assertFalse(result)
        self.assertEqual(stats["excludedInsideRestrictedSportArea"], 1)

    def test_new_category_filters(self):
        self.assertEqual(category_for({"amenity": "library"}), "library")
        self.assertEqual(category_for({"leisure": "fitness_station"}), "sports")
        self.assertIsNone(category_for({"shop": "books"}))
        self.assertIsNone(category_for({"sport": "basketball"}))


if __name__ == "__main__":
    unittest.main()
