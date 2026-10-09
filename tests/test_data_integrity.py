import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("pipeline", ROOT / "pipeline/pipeline.py")
PIPELINE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PIPELINE)


class DataIntegrityTests(unittest.TestCase):
    def test_only_brazil_has_a_source_specific_appearance_floor(self):
        self.assertEqual(PIPELINE.APPS_FLOOR, .85)
        for pack_id in PIPELINE.PACKS:
            idx = {"apps": [[1] * 76 + [-1] * 24], "postings": [[]]}
            with patch.object(PIPELINE, "apps_coverage", return_value=.76):
                errors = PIPELINE.pack_index_errors(idx, pack_id, 0, [0, 0])
            coverage_errors = [e for e in errors if "apps coverage" in e]
            self.assertEqual(bool(coverage_errors), pack_id != "br")
        with patch.object(PIPELINE, "apps_coverage", return_value=.74):
            errors = PIPELINE.pack_index_errors(idx, "br", 0, [0, 0])
        self.assertTrue(any("apps coverage" in e for e in errors))

    def test_optional_country_memberships_are_complete_and_disjoint(self):
        self.assertEqual(set(PIPELINE.PACKS), {"pt", "nl", "be", "tr", "br", "ar"})
        leagues, clubs = set(), set()
        for pack in PIPELINE.PACKS.values():
            self.assertEqual([row[1] for row in pack["leagues"].values()], [1, 2])
            self.assertEqual(set(pack["leagues"]), set(pack["current"]))
            self.assertEqual([len(qs) for qs in pack["current"].values()],
                             pack["expected_current"])
            self.assertFalse(leagues.intersection(pack["leagues"]))
            leagues.update(pack["leagues"])
            for qids in pack["current"].values():
                self.assertEqual(len(qids), len(set(qids)))
                self.assertFalse(clubs.intersection(qids))
                self.assertFalse(PIPELINE.BLOCKLIST.intersection(qids))
                clubs.update(qids)

    def test_dutch_and_belgian_reserves_are_excluded(self):
        for name in ["Jong Ajax", "Jong AZ", "Jong PSV", "Jong FC Utrecht",
                     "Jong Genk", "Jong KAA Gent"]:
            self.assertTrue(PIPELINE.EXCLUDE_CLUB.search(name), name)
        self.assertTrue({"Q101625593", "Q114056326"}.issubset(PIPELINE.BLOCKLIST))
        self.assertEqual(PIPELINE.LEAGUE_ALIAS["Q233199"], "Q23925620")

    def test_historical_willem_ii_survives_the_reserve_suffix_filter(self):
        def binding(qid, name):
            return {"club": {"value": f"http://www.wikidata.org/entity/{qid}"},
                    "clubLabel": {"value": name}, "cc": {"value": "NL"},
                    "lg": {"value": "http://www.wikidata.org/entity/Q167541"}}
        rows = [binding("Q332664", "Willem II"), binding("Q1770361", "Jong Ajax")]
        with patch.object(PIPELINE, "sparql", return_value=rows), \
                patch.object(PIPELINE, "CURRENT", {}), \
                patch.object(PIPELINE, "save") as save:
            PIPELINE.stage_clubs()
        clubs = save.call_args.args[1]
        self.assertIn("Q332664", clubs)
        self.assertNotIn("Q1770361", clubs)

    def test_america_mineiro_and_natal_are_distinct_clubs(self):
        clubs = {q: {"cc": "BR", "name": "América Futebol Clube"}
                 for q in ["Q338285", "Q482262"]}
        self.assertEqual(PIPELINE.merge_map(clubs, {"Q338285": ["Q1"], "Q482262": ["Q2"]}), {})
        self.assertNotEqual(PIPELINE.CLUB_NAMES["Q338285"], PIPELINE.CLUB_NAMES["Q482262"])

    def test_years_require_bounded_ordered_integer_pairs(self):
        self.assertTrue(PIPELINE.valid_spell_years([[], [150, 152, 160, 162]]))
        for values in [None, [None], [[150]], [[152, 150]], [[0, 251]],
                       [[-1, 1]], [[True, 2]], [[1.5, 2]], [["1", 2]]]:
            with self.subTest(values=values):
                self.assertFalse(PIPELINE.valid_spell_years(values))

    def test_careers_must_route_to_their_actual_shard(self):
        rows = {"2": [123, [["Club", 2000, 2001, 10, 0]]], "4": [456, []]}
        self.assertEqual(PIPELINE.career_shard_errors(rows, 0, 2, range(5)), [])
        self.assertTrue(PIPELINE.career_shard_errors(rows, 1, 2, range(5)))
        self.assertTrue(PIPELINE.career_shard_errors(rows, 0, 2, range(2)))

    def test_pack_career_keys_must_match_the_player_qid(self):
        self.assertEqual(PIPELINE.career_shard_errors({"2": [2, []]}, 0, 2, {2}, True), [])
        self.assertTrue(PIPELINE.career_shard_errors({"2": [3, []]}, 0, 2, {2}, True))

    def test_malformed_careers_fail_with_diagnostics(self):
        for rows in [[], {"no": []}, {"01": [1, []]}, {"0": None},
                     {"0": [True, []]}, {"0": [1, [None]]},
                     {"0": [1, [[None, 2000, 2001, 10, 0]]]},
                     {"0": [1, [["Club", 2000, 2001, -1, 0]]]},
                     {"0": [1, [["Club", 2000, 2001, 1.5, 0]]]},
                     {"0": [1, [["Club", 2000, 1990, 10, 0]]]},
                     {"0": [1, [["Club", 2000, 3000, 10, 0]]]},
                     {"0": [1, [["Club", 1200, 1300, 10, 0]]]}]:
            with self.subTest(rows=rows):
                self.assertTrue(PIPELINE.career_shard_errors(rows, 0, 2, range(5)))

    def test_ordered_career_years_are_accepted(self):
        rows = {"0": [1, [["Club", 2000, 2001, 10, 0], ["Club", 2003, None, 0, 0]]]}
        self.assertEqual(PIPELINE.career_shard_errors(rows, 0, 2, range(5)), [])


if __name__ == "__main__":
    unittest.main()
