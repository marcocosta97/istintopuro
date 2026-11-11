import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("pipeline", ROOT / "pipeline/pipeline.py")
PIPELINE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PIPELINE)


def spell(title):
    return [title, 2025, None, 21, 3, 0]


def evidence(titles, team="Q704857"):
    records = {str(i): [f"Player {i}", [spell(title)]] for i, title in enumerate(titles)}
    return PIPELINE.club_name_evidence(records, dict.fromkeys(titles, team))


class ClubNameEvidenceTests(unittest.TestCase):
    def test_each_page_votes_once_across_spells_variants_and_duplicate_player_ids(self):
        records = {
            "Q1": ["Player_One", [spell("SP Tre Penne")] * 20 + [spell("S.P. Tre Penne")]],
            "Q2": ["Player One", [spell("SP Tre Penne")]],
            "Q3": ["Player Two", [spell("S.P. Tre Penne")]],
        }
        result = PIPELINE.club_name_evidence(records, {
            "SP Tre Penne": "Q704857", "S.P. Tre Penne": "Q704857",
        })["Q704857"]
        self.assertEqual((result["support"], result["pages"]), (2, 2))
        self.assertFalse(result["strong"])
        self.assertEqual(result["winner"], "SP Tre Penne")

    def test_conflicting_names_on_one_page_abstain_and_unresolved_titles_are_ignored(self):
        records = {"Q1": ["Player", [spell("Old Name"), spell("New Name"), spell("Unknown")]]}
        result = PIPELINE.club_name_evidence(records, {"Old Name": "Q9", "New Name": "Q9"})
        self.assertEqual(set(result), {"Q9"})
        self.assertEqual(result["Q9"]["support"], 0)
        self.assertEqual(result["Q9"]["pages"], 1)
        self.assertIsNone(result["Q9"]["winner"])
        self.assertFalse(result["Q9"]["strong"])

    def test_consensus_needs_three_pages_and_eighty_percent(self):
        for titles, strong in [(["Club"] * 2, False), (["Club"] * 3, True),
                               (["Club"] * 3 + ["Other"], False),
                               (["Club"] * 4 + ["Other"], True),
                               (["Club", "Other"] * 3, False)]:
            with self.subTest(titles=titles):
                self.assertEqual(evidence(titles)["Q704857"]["strong"], strong)

    def test_normalization_keeps_non_latin_distinctions_and_team_suffixes(self):
        key = PIPELINE.club_name_key
        self.assertEqual(key("S.P. Tré Penne"), key("SP Tre Penne"))
        self.assertEqual(key("ＡＣ Milan"), key("AC Milan"))
        self.assertNotEqual(key("東京"), key("京都"))
        self.assertNotEqual(key("Club"), key("Club II"))

    def test_votes_are_never_pooled_across_club_identifiers(self):
        records = {str(i): [f"Player {i}", [spell(title)]]
                   for i, title in enumerate(["Club One", "Club One", "Club Two"])}
        result = PIPELINE.club_name_evidence(records, {"Club One": "Q1", "Club Two": "Q2"})
        self.assertFalse(result["Q1"]["strong"])
        self.assertFalse(result["Q2"]["strong"])


class ClubNameDecisionTests(unittest.TestCase):
    def resolve(self, raw="gil paja", titles=None, previous=None, overrides=None):
        ev = evidence(titles if titles is not None else ["SP Tre Penne", "S.P. Tre Penne", "SP Tre Penne"])
        return PIPELINE.resolve_club_names({"Q704857": raw}, ev, previous or {}, overrides or {})

    def test_cold_cache_recovers_tre_penne_without_a_manual_exception(self):
        self.assertNotIn("Q704857", PIPELINE.CLUB_NAMES)
        names, accepted, conflicts = self.resolve()
        self.assertEqual(names, {"Q704857": "SP Tre Penne"})
        self.assertEqual(accepted, names)
        self.assertEqual(conflicts[0]["reason"], "wikipedia_consensus")
        self.assertEqual(conflicts[0]["wikidata"], "gil paja")

    def test_sparse_conflicts_are_reported_without_trusting_or_guessing_a_name(self):
        names, accepted, conflicts = self.resolve(titles=["SP Tre Penne"] * 2)
        self.assertEqual(names["Q704857"], "gil paja")
        self.assertEqual(accepted, {})
        self.assertEqual(conflicts[0]["reason"], "needs_review")

    def test_last_accepted_name_survives_sparse_or_absent_evidence(self):
        for titles in [[], ["SP Tre Penne"], ["Unrelated New Name"] * 2]:
            with self.subTest(titles=titles):
                names, accepted, conflicts = self.resolve(titles=titles, previous={"Q704857": "SP Tre Penne"})
                self.assertEqual(names, accepted)
                self.assertEqual(names["Q704857"], "SP Tre Penne")
                self.assertEqual(conflicts[0]["reason"], "retained_previous")

    def test_confirmed_rename_can_replace_the_accepted_name(self):
        names, accepted, conflicts = self.resolve(raw="Riverport United", titles=["Riverport United"] * 3,
                                                  previous={"Q704857": "Oldtown Athletic"})
        self.assertEqual(names["Q704857"], "Riverport United")
        self.assertEqual(accepted, names)
        self.assertEqual(conflicts, [])

    def test_consensus_can_repair_a_previously_bad_name(self):
        names, accepted, conflicts = self.resolve(previous={"Q704857": "gil paja"})
        self.assertEqual(names["Q704857"], "SP Tre Penne")
        self.assertEqual(accepted, names)
        self.assertEqual(conflicts[0]["reason"], "wikipedia_consensus")

    def test_known_minority_historical_name_is_not_replaced(self):
        names, accepted, conflicts = self.resolve(raw="Oldtown Athletic",
                                                  titles=["Riverport United"] * 4 + ["Oldtown Athletic"])
        self.assertEqual(names["Q704857"], "Oldtown Athletic")
        self.assertEqual(accepted, {})
        self.assertEqual(conflicts, [])

    def test_common_legal_abbreviated_and_transliterated_names_are_retained(self):
        for raw, title in [("AC Milan", "A.C. Milan"), ("Paris Saint-Germain FC", "PSG"),
                           ("Società Sportiva Lazio", "S.S. Lazio"),
                           ("FC Bayern München", "FC Bayern Munich"),
                           ("Internazionale Milano", "Inter Milan"), ("東京FC", "東京 FC")]:
            with self.subTest(raw=raw):
                names, accepted, conflicts = self.resolve(raw=raw, titles=[title] * 3)
                self.assertEqual(names["Q704857"], raw)
                self.assertEqual(accepted, names)
                self.assertEqual(conflicts, [])

    def test_no_evidence_preserves_raw_names_without_seeding_trust(self):
        names, accepted, conflicts = self.resolve(raw="Unknown Club", titles=[])
        self.assertEqual(names, {"Q704857": "Unknown Club"})
        self.assertEqual(accepted, {})
        self.assertEqual(conflicts, [])

    def test_curated_names_take_precedence_and_unused_memory_is_retained(self):
        names, accepted, conflicts = self.resolve(previous={"Q99": "Other Club"},
                                                  overrides={"Q704857": "Curated Name"})
        self.assertEqual(names["Q704857"], "Curated Name")
        self.assertEqual(accepted, {"Q99": "Other Club", "Q704857": "Curated Name"})
        self.assertEqual(conflicts[0]["reason"], "curated_correction")


class ClubNamePersistenceTests(unittest.TestCase):
    def test_build_memory_survives_full_refresh_and_report_preserves_raw_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            titles = {"SP Tre Penne": "Q704857"}
            with patch.object(PIPELINE, "DATA", root), \
                    patch.object(PIPELINE, "STATE", root / "state"), \
                    patch.object(PIPELINE, "SOURCE_WARNINGS", set()), \
                    patch.dict(os.environ, {"FULL_REFRESH": "1"}):
                PIPELINE.save("wp_titles", titles)
                PIPELINE.save_state("wp", {}, {
                    str(i): [f"Player {i}", [spell("SP Tre Penne")]] for i in range(3)
                })
                raw = {"Q704857": "gil paja"}
                names = PIPELINE.validated_club_names(raw)
                self.assertEqual(raw, {"Q704857": "gil paja"})
                self.assertEqual(names["Q704857"], "SP Tre Penne")
                report = PIPELINE.load("reports/club-name-conflicts")
                conflict = report["conflicts"][0]
                self.assertEqual(conflict["wikidata"], "gil paja")
                self.assertEqual(conflict["selected"], "SP Tre Penne")
                self.assertEqual(conflict["evidence"]["support"], 3)
                self.assertEqual(len(conflict["evidence"]["examples"]), 3)
                self.assertTrue(PIPELINE.SOURCE_WARNINGS)

                # A new full fetch may lose Wikipedia coverage; it must not lose trust.
                PIPELINE.save_state("wp", {}, {})
                self.assertEqual(PIPELINE.validated_club_names(raw), names)
                self.assertEqual(PIPELINE.load("reports/club-name-conflicts")["conflicts"][0]["reason"],
                                 "retained_previous")
                # Once the source is fixed the report clears, rather than accumulating.
                self.assertEqual(PIPELINE.validated_club_names(names), names)
                self.assertEqual(PIPELINE.load("reports/club-name-conflicts")["conflicts"], [])
                self.assertEqual(PIPELINE.load_state("club_names"), ({}, {}))
                _, memory = PIPELINE.load_state("club_names", reuse_on_full_refresh=True)
                self.assertEqual(memory, names)


if __name__ == "__main__":
    unittest.main()
