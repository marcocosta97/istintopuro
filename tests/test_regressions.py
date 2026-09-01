import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("pipeline", ROOT / "pipeline" / "pipeline.py")
PIPELINE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PIPELINE)


class WikipediaOverlayTests(unittest.TestCase):
    def test_common_name_replaces_handle_like_wikidata_vandalism(self):
        self.assertEqual(PIPELINE.common_name("elpisha", "Joaquín (footballer, born 1981)"), "Joaquín")
        self.assertEqual(PIPELINE.common_name("Nolito", "Nolito"), "Nolito")

    def test_infobox_excludes_youth_clubs_from_the_senior_career(self):
        text = """{{Infobox football biography
            | youthclubs1 = [[Udinese Calcio|Udinese]]
            | years1 = 2000–2001 | caps1 = 24 | goals1 = 4
            | clubs1 = [[A.S.D. Castel di Sangro Calcio|Castel di Sangro]]
        }}"""

        self.assertEqual(PIPELINE.parse_infobox(text), [
            ["A.S.D. Castel di Sangro Calcio", 2000, 2001, 24, 4, 0],
        ])

    def test_complete_wikipedia_career_is_kept_as_is(self):
        spells = [
            ["Senior One", 2000, 2001, 10, 2, 0],
            ["Senior Two", 2002, 2003, 20, 3, 0],
        ]

        self.assertEqual(PIPELINE.resolve_wp_spells(spells, {
            "Senior One": "Q1", "Senior Two": "Q2",
        }), [
            ["Q1", 2000, 2001, 10, 2, 0],
            ["Q2", 2002, 2003, 20, 3, 0],
        ])

    def test_partial_title_resolution_keeps_wikidata_fallback(self):
        spells = [
            ["Senior One", 2000, 2001, 10, 2, 0],
            ["Unresolved", 2002, 2003, 20, 3, 0],
        ]

        self.assertIsNone(PIPELINE.resolve_wp_spells(spells, {"Senior One": "Q1"}))

    def test_revision_response_follows_normalization_and_redirects(self):
        batch = [["Q1", "Old_title"]]
        page = {"title": "Current title", "revisions": [{"revid": 42}]}
        data = {"query": {
            "normalized": [{"from": "Old_title", "to": "Old title"}],
            "redirects": [{"from": "Old title", "to": "Current title"}],
            "pages": [page],
        }}

        self.assertEqual(PIPELINE.wp_batch_pages(batch, data), [("Q1", page)])


class IncrementalCacheTests(unittest.TestCase):
    def test_only_new_changed_unknown_or_missing_records_are_refetched(self):
        current = {"same": "r1", "changed": "r2", "new": "r1",
                   "unknown": None, "negative": "r1"}
        old_source = {"same": "r1", "changed": "r1", "deleted": "r1",
                      "unknown": None, "negative": "r1"}
        old_records = {"same": [1], "changed": [1], "deleted": [1], "negative": []}

        self.assertEqual(PIPELINE.stale_records(current, old_source, old_records),
                         ["changed", "new", "unknown"])

    def test_incompatible_cache_version_is_ignored(self):
        with tempfile.TemporaryDirectory() as td, patch.object(PIPELINE, "STATE", Path(td)):
            (Path(td) / "attrs.json").write_text(json.dumps({
                "version": PIPELINE.CACHE_VERSION + 1,
                "source": {"Q1": "r1"}, "records": {"Q1": [1]},
            }))

            self.assertEqual(PIPELINE.load_state("attrs"), ({}, {}))

    def test_valid_cache_round_trips_negative_records(self):
        with tempfile.TemporaryDirectory() as td, patch.object(PIPELINE, "STATE", Path(td)):
            PIPELINE.save_state("careers", {"Q1": "r1"}, {"Q1": []})

            self.assertEqual(PIPELINE.load_state("careers"),
                             ({"Q1": "r1"}, {"Q1": []}))

    def test_full_refresh_ignores_compatible_cache(self):
        with tempfile.TemporaryDirectory() as td, patch.object(PIPELINE, "STATE", Path(td)):
            PIPELINE.save_state("attrs", {"Q1": "r1"}, {"Q1": [1]})
            with patch.dict("os.environ", {"FULL_REFRESH": "1"}):
                self.assertEqual(PIPELINE.load_state("attrs"), ({}, {}))

    def test_wikipedia_warm_run_fetches_content_only_for_changed_page(self):
        with tempfile.TemporaryDirectory() as td:
            data_dir = Path(td)
            state_dir = data_dir / "state"
            fixtures = {
                "members": {"QC": ["Q1", "Q2"]},
                "roster": {},
                "careers": {
                    "Q1": [["QC", 2000, 2001, 1, 0, 0]],
                    "Q2": [["QC", 2000, 2001, 1, 0, 0]],
                },
                "attrs": {
                    "Q1": ["One", 1980, "GB", None, None, "Player One"],
                    "Q2": ["Two", 1980, "GB", None, None, "Player Two"],
                },
            }
            for name, value in fixtures.items():
                (data_dir / f"{name}.json").write_text(json.dumps(value))

            revisions = {"Player One": 10, "Player Two": 20}
            content_calls = []
            def fake_wp_get(**params):
                titles = params["titles"].split("|")
                pages = []
                for title in titles:
                    rev = {"revid": revisions[title]}
                    if "content" in params["rvprop"]:
                        content_calls.append(title)
                        rev["slots"] = {"main": {"content":
                            "{{Infobox football biography|years1=2000–2001"
                            "|clubs1=[[Club One]]|caps1=1|goals1=0}}"}}
                    pages.append({"title": title, "revisions": [rev]})
                return {"query": {"pages": pages}}

            with patch.object(PIPELINE, "DATA", data_dir), \
                    patch.object(PIPELINE, "STATE", state_dir), \
                    patch.object(PIPELINE, "wp_get", side_effect=fake_wp_get), \
                    patch.object(PIPELINE, "titles_to_qids", return_value={"Club One": "QC"}):
                PIPELINE.stage_wp()
                self.assertCountEqual(content_calls, ["Player One", "Player Two"])

                content_calls.clear()
                revisions["Player Two"] = 21
                PIPELINE.stage_wp()

            self.assertEqual(content_calls, ["Player Two"])
            self.assertEqual(set(json.loads((data_dir / "wp.json").read_text())), {"Q1", "Q2"})

    def test_wikidata_warm_run_fetches_only_changed_attributes(self):
        with tempfile.TemporaryDirectory() as td:
            data_dir = Path(td)
            state_dir = data_dir / "state"
            (data_dir / "members.json").write_text(json.dumps({"QC": ["Q1", "Q2"]}))
            (data_dir / "roster.json").write_text("{}")
            revisions = {"Q1": "r1", "Q2": "r1"}
            queries = []
            def fake_sparql(query):
                queries.append(query)
                return [{"p": {"value": f"http://www.wikidata.org/entity/{p}"},
                         "en": {"value": p}} for p in revisions if f"wd:{p}" in query]

            with patch.object(PIPELINE, "DATA", data_dir), \
                    patch.object(PIPELINE, "STATE", state_dir), \
                    patch.object(PIPELINE, "current_wd_versions",
                                 side_effect=lambda _players: dict(revisions)), \
                    patch.object(PIPELINE, "sparql", side_effect=fake_sparql):
                PIPELINE.stage_attrs()
                self.assertIn("wd:Q1", queries[-1])
                self.assertIn("wd:Q2", queries[-1])

                revisions["Q2"] = "r2"
                PIPELINE.stage_attrs()

            self.assertNotIn("wd:Q1", queries[-1])
            self.assertIn("wd:Q2", queries[-1])

    def test_wikidata_revision_scan_uses_entity_modified_time_and_is_resumable(self):
        with tempfile.TemporaryDirectory() as td:
            data_dir = Path(td)
            queries = []
            response = [{
                "p": {"value": "http://www.wikidata.org/entity/Q1"},
                "modified": {"value": "2026-08-25T12:00:00Z"},
            }]
            with patch.object(PIPELINE, "DATA", data_dir), \
                    patch.object(PIPELINE, "sparql", side_effect=lambda q: queries.append(q) or response):
                expected = {"Q1": "2026-08-25T12:00:00Z"}
                self.assertEqual(PIPELINE.current_wd_versions(["Q1"]), expected)
                self.assertEqual(PIPELINE.current_wd_versions(["Q1"]), expected)

            self.assertEqual(len(queries), 1)
            self.assertIn("?p schema:dateModified ?modified", queries[0])


class LeaguePackTests(unittest.TestCase):
    def test_pack_configuration_is_two_divisions_with_unique_current_clubs(self):
        core_leagues = set(PIPELINE.CORE_LEAGUE_ORDER)
        core_current = {q for league in core_leagues for q in PIPELINE.CURRENT[league]}
        for pack in PIPELINE.PACKS.values():
            self.assertEqual(len(pack["leagues"]), 2)
            self.assertTrue(core_leagues.isdisjoint(pack["leagues"]))
            current = [pack["current"][league] for league in pack["leagues"]]
            self.assertEqual([len(clubs) for clubs in current], pack["expected_current"])
            flat = [club for clubs in current for club in clubs]
            self.assertEqual(len(flat), len(set(flat)))
            self.assertTrue(core_current.isdisjoint(flat))

    def test_pack_asset_validator_accepts_the_contract(self):
        idx = {
            "v": 1, "id": "pt", "leagues": [["One", 1, "PT"], ["Two", 2, "PT"]],
            "clubs": [["A", "PT", 1, "Q10", 0, 0], ["B", "PT", 2, "Q11", 0, 1]],
            "players": [[100, -1, "One", 1990, "PT", "", 0],
                        [101, 3, "Two", 1991, "BR", "aaPhoto.jpg", 1]],
            "postings": [[0, 1], [1]], "apps": [[2, 3], [4]], "goals": [[0, 1], [1]],
        }

        self.assertEqual(PIPELINE.pack_index_errors(idx, "pt", 10, [1, 1]), [])

    def test_pack_asset_validator_rejects_bad_identity_and_mapping(self):
        idx = {
            "v": 1, "id": "be", "leagues": [["One", 1, "PT"], ["Two", 2, "PT"]],
            "clubs": [["A", "PT", 1, "Q10", 0, 0], ["B", "PT", 2, "Q11", 0, 1]],
            "players": [[100, 10, "One", 1990, "ZZ", "", 0]],
            "postings": [[0], [0]], "apps": [[2], [4]], "goals": [[0], [1]],
        }

        errors = "\n".join(PIPELINE.pack_index_errors(idx, "pt", 10, [1, 1]))
        self.assertIn("id 'be' != 'pt'", errors)
        self.assertIn("invalid core player id", errors)
        self.assertIn("nat codes with no flag", errors)


class MobileBrowserBackTests(unittest.TestCase):
    def test_flag_markup_is_rendered_as_escaped_html(self):
        source = (ROOT / "site" / "app.js").read_text()
        start = source.index("  const level = brCC === null ? 0")
        end = source.index("\n}\n\n// ---------------------------------------------------------------- selection", start)
        render = source[start:end]

        self.assertNotIn("brBack.textContent", render)
        self.assertIn("brBack.innerHTML", render)
        self.assertIn("countryFlag(brCC)", render)
        self.assertIn("esc(countryName(brCC))", render)


if __name__ == "__main__":
    unittest.main()
