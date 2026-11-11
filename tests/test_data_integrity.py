import importlib.util
import json
import os
import re
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("pipeline", ROOT / "pipeline/pipeline.py")
PIPELINE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PIPELINE)


class DataIntegrityTests(unittest.TestCase):
    def test_source_name_corrections_reach_core_and_pack_careers(self):
        league = "Q1"
        player = "Q17403497"
        club = "Q1386854"
        spells = [[club, 2024, 2025, 33, 6, 0],
                  ["Q704857", 2025, None, 21, 3, 0]]
        pack = {"cc": "IT", "leagues": {league: ("League", 1, "IT")},
                "current": {league: [club]}}
        data = {
            "clubs": {club: {"name": "Bad indexed name", "cc": "IT", "leagues": [league]}},
            "attrs": {player: ["Gianluca Turchetta", 1991, "IT", None, None]},
            "teams": {"Q704857": "Bad career-only name"},
            "wp_titles": {"SP Tre Penne": "Q704857", "S.P. Tre Penne": "Q704857"},
        }
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "checkpoint.json").write_text("{}")
            with patch.object(PIPELINE, "DATA", root), \
                    patch.object(PIPELINE, "STATE", root / "state"), \
                    patch.object(PIPELINE, "SITE_DATA", root / "site"), \
                    patch.object(PIPELINE, "load", side_effect=data.get), \
                    patch.object(PIPELINE, "load_members", return_value={club: [player]}), \
                    patch.object(PIPELINE, "load_careers", return_value={player: spells}), \
                    patch.object(PIPELINE, "CORE_LEAGUE_ORDER", [league]), \
                    patch.object(PIPELINE, "CURRENT", {league: [club]}), \
                    patch.object(PIPELINE, "LEAGUES", pack["leagues"]), \
                    patch.object(PIPELINE, "PACKS", {"test": pack}), \
                    patch("builtins.print"):
                PIPELINE.save_state("wp", {}, {
                    f"Q{i}": [f"Player {i}", [[title, 2025, None, 1, 0, 0]]]
                    for i, title in enumerate(["SP Tre Penne", "S.P. Tre Penne", "SP Tre Penne"])
                })
                PIPELINE.stage_build()

            core = json.loads((root / "site/career/0.json").read_text())["0"]
            shard = int(player[1:]) % PIPELINE.PACK_NSHARDS
            packed = json.loads((root / f"site/packs/test/career/{shard}.json").read_text())[player[1:]]
            expected = [int(player[1:]), [["FC Andorra", 2024, 2025, 33, 6],
                                        ["SP Tre Penne", 2025, None, 21, 3]]]
            self.assertEqual(core, expected)
            self.assertEqual(packed, expected)
            index = json.loads((root / "site/index.json").read_text())
            self.assertEqual(index["clubs"][0][0], "FC Andorra")

    def test_missing_flags_warn_without_rejecting_valid_nationalities(self):
        with patch.object(PIPELINE, "SOURCE_WARNINGS", set()):
            self.assertEqual(PIPELINE.nationality_errors(["IT", "SU,RU", "ZZ", ""], "core"), [])
            self.assertEqual(len(PIPELINE.SOURCE_WARNINGS), 1)
            warning = next(iter(PIPELINE.SOURCE_WARNINGS))
            self.assertIn("['SU', 'ZZ']", warning)
            self.assertIn("country-code labels", warning)

    def test_malformed_nationality_fields_still_fail_validation(self):
        for value in [None, 12, [], "Russia", "it", "Z1", "SU,", ",SU", "SU,,RU"]:
            with self.subTest(value=value):
                self.assertTrue(PIPELINE.nationality_errors([value], "core"))

    def test_client_and_pipeline_agree_which_codes_have_emoji_flags(self):
        source = (ROOT / "site/app.js").read_text()
        codes = re.search(r"const ISO_ALPHA2 = new Set\(`([^`]+)`", source).group(1)
        self.assertEqual(set(codes.split()), PIPELINE.ISO_ALPHA2)

    def test_core_validator_accepts_a_dataset_with_a_missing_flag(self):
        # Reproduce the rejected weekly input without copying its career shards.
        with tempfile.TemporaryDirectory() as tmp:
            candidate = Path(tmp)
            for entry in (ROOT / "site/data").iterdir():
                if entry.name != "index.json":
                    (candidate / entry.name).symlink_to(entry, target_is_directory=entry.is_dir())
            index = json.loads((ROOT / "site/data/index.json").read_text())
            index["nats"][0] = "SU"
            (candidate / "index.json").write_text(json.dumps(index))
            with patch.object(PIPELINE, "SITE_DATA", candidate), \
                    patch.object(PIPELINE, "SOURCE_WARNINGS", set()), \
                    patch.dict(os.environ, {"VALIDATE_PUBLISHED_ONLY": "1"}):
                PIPELINE.stage_validate()
                self.assertTrue(any("['SU']" in warning for warning in PIPELINE.SOURCE_WARNINGS))

    def test_pack_validator_accepts_nationality_without_flag_artwork(self):
        index = {
            "v": 1, "id": "pt", "leagues": [["One", 1, "PT"], ["Two", 2, "PT"]],
            "clubs": [["A", "PT", 1, "Q10", 0, 0], ["B", "PT", 2, "Q11", 0, 1]],
            "players": [[100, -1, "Player", 1990, "SU", "", 0]],
            "postings": [[0], [0]], "apps": [[2], [3]], "goals": [[0], [0]],
        }
        with patch.object(PIPELINE, "SOURCE_WARNINGS", set()):
            self.assertEqual(PIPELINE.pack_index_errors(index, "pt", 0, [1, 1]), [])
            self.assertTrue(any("pack pt:" in warning for warning in PIPELINE.SOURCE_WARNINGS))

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
