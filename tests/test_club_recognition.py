import importlib.util
import copy
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("club_recognition", ROOT / "scripts/club-recognition.py")
C = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(C)


class FakeClient:
    calls = []
    enabled = True

    def __init__(self, *limits):
        self.count = 0
        self.session = SimpleNamespace(close=lambda: None)

    def get(self, url, params=None, missing_ok=False):
        if not self.enabled:
            raise AssertionError("warm collection made a source request")
        self.count += 1
        self.calls.append(url)
        if params:
            return {"entities": {qid: {"sitelinks": {"enwiki": {
                "title": "Club " + qid, "url": "https://en.wikipedia.org/wiki/Club_" + qid}}}
                for qid in params["ids"].split("|")}}
        title = url.split("/user/")[1].split("/monthly/")[0]
        return {"items": [{"timestamp": month.replace("-", "") + "0100", "views": 100,
                           "article": title, "project": "en.wikipedia", "access": "all-access",
                           "agent": "user", "granularity": "monthly"} for month in C.source.month_window()]}


class ClubRecognitionTests(unittest.TestCase):
    def test_isolated_club_snapshot_reuses_the_common_durable_checkpoint_without_career_shards(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            site = directory / "input"
            site.mkdir()
            (site / "index.json").write_text(json.dumps({"built": "2026-10-26", "clubs": [
                ["Alpha", "IT", 1, "Q1", 0, 0], ["Beta", "GB", 2, "Q2", 0, 1]]}))
            output = directory / "clubs.json"
            args = ["--site-data", str(site), "--state", str(directory / "state.jsonl"), "--output", str(output)]
            FakeClient.calls = []
            FakeClient.enabled = True
            with patch.object(C.source, "Client", FakeClient):
                self.assertEqual(C.main(args), 0)
                first = json.loads(output.read_text())
                self.assertEqual(first["kind"], "club-recognition-sources")
                self.assertEqual(set(first["clubs"]), {"Q1", "Q2"})
                self.assertNotIn("players", first)
                self.assertEqual(first["summary"]["pageviews_complete"], 2)
                self.assertEqual(len(FakeClient.calls), 3)
                FakeClient.enabled = False
                self.assertEqual(C.main(args), 0)
            second = json.loads(output.read_text())
            self.assertEqual(second["clubs"], first["clubs"])
            self.assertEqual(second["run"]["requests"], 0)

    def test_club_collection_cannot_overwrite_player_or_published_snapshots(self):
        for destination in [ROOT / "data/popularity/snapshot.json", ROOT / "site/data/recognition.json"]:
            with self.assertRaises(SystemExit):
                C.main(["--output", str(destination)])


class RedirectClient:
    def __init__(self, *responses):
        self.responses = iter(responses)
        self.calls = []

    def get(self, url, params=None, missing_ok=False):
        self.calls.append((url, params))
        response = next(self.responses)
        if isinstance(response, Exception):
            raise response
        return response


class ClubRedirectTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "state.jsonl"
        self.journal = C.source.Journal(self.path)
        clock = patch.object(C.source, "utc_now", return_value="2026-11-09T16:00:00+00:00")
        clock.start()
        self.addCleanup(clock.stop)
        self.months = C.source.month_window("2026-10")
        self.clubs = {"Q1": {"name": "Club", "club_count": 1}}
        self.journal.put("Q1", {"coverage": {
            **C.source.language_coverage({"sitelinks": {"enwiki": {
                "title": "New Club", "url": "https://en.wikipedia.org/wiki/New_Club"}}}),
            "fetched_at": C.source.utc_now(), "period": "2026-11"},
            "views": {"title": "New Club", "months": {self.months[-1]: 800},
                      "attempted_window": self.months, "attempted_on": "2026-11-09",
                      "fetched_at": C.source.utc_now(), "status": "partial"}})

    def identity(self, qid="Q1"):
        return {"query": {"pages": {"1": {"title": "New Club", "pageprops": {"wikibase_item": qid},
            "redirects": [{"ns": 0, "title": "Abbreviation"}, {"ns": 0, "title": "Old Club"}]}}}}

    def views(self, title, value, months=None):
        return {"items": [{"timestamp": month.replace("-", "") + "0100", "views": value,
            "article": title.replace(" ", "_"), "project": "en.wikipedia", "access": "all-access",
            "agent": "user", "granularity": "monthly"} for month in (months or self.months)]}

    def moves(self):
        return {"query": {"logevents": [{"title": "Old Club", "timestamp": "2026-09-09T14:07:12Z",
            "params": {"target_title": "New Club"}}]}}

    def repair(self, client):
        return C.repair_redirects(self.clubs, self.journal, client, self.months)

    def snapshot(self):
        report = C.source.audit(self.clubs, self.journal, self.months, "2026-11-09", 0, 0, False)
        return C.source.make_snapshot(report)

    def test_verified_move_recovers_one_complete_series_and_warm_runs_make_no_requests(self):
        client = RedirectClient(self.identity(), self.views("Abbreviation", 20), self.views("Old Club", 2000), self.moves())
        self.assertEqual(self.repair(client), (0, False))
        row = self.snapshot()["players"]["Q1"]["pageviews"]
        self.assertEqual(row["title"], "Old Club")
        self.assertEqual(row["median_monthly_views"], 2000)
        self.assertEqual(row["total_views"], 24000)  # Never add canonical or other redirect counts.
        self.assertEqual(row["verified_alias_qid"], "Q1")
        self.assertEqual(client.calls[-1][1]["letitle"], "Old Club")
        warm = RedirectClient()
        self.assertEqual(C.source.collect(self.clubs, self.journal, warm, self.months), (0, False))
        self.assertEqual(self.repair(warm), (0, False))
        self.assertEqual(warm.calls, [])
        for field, value in [("verified_alias_qid", "Q2"), ("sitelink_title", "Other Club"), ("alias_move_at", None)]:
            bad = copy.deepcopy(self.snapshot())
            bad["players"]["Q1"]["pageviews"][field] = value
            with self.assertRaises(ValueError):
                C.source.validate_snapshot(bad)

    def test_redirects_to_a_different_entity_are_rejected_before_reading_traffic(self):
        client = RedirectClient(self.identity("Q2"))
        self.assertEqual(self.repair(client), (1, False))
        self.assertEqual(len(client.calls), 1)
        self.assertEqual(self.snapshot()["players"]["Q1"]["pageviews"]["status"], "partial")

    def test_expired_redirect_identity_is_not_current_and_refreshes_the_canonical_title(self):
        self.repair(RedirectClient(self.identity(), self.views("Abbreviation", 20),
                                  self.views("Old Club", 2000), self.moves()))
        record = self.journal.records["Q1"]
        record["views"]["alias_checked_at"] = "2026-08-01T16:00:00+00:00"
        self.journal.put("Q1", record)
        self.assertFalse(self.snapshot()["players"]["Q1"]["pageviews"]["current"])
        client = RedirectClient(self.views("New Club", 100))
        self.assertEqual(C.source.collect(self.clubs, self.journal, client, self.months), (0, False))
        row = self.snapshot()["players"]["Q1"]["pageviews"]
        self.assertEqual(len(client.calls), 1)
        self.assertTrue(row["current"])
        self.assertEqual(row["title"], "New Club")
        self.assertNotIn("title_mode", row)

    def test_a_redirect_without_a_verified_article_move_cannot_supply_a_low_traffic_penalty(self):
        client = RedirectClient(self.identity(), self.views("Abbreviation", 20), self.views("Old Club", 2000),
                                {"query": {"logevents": []}}, {"query": {"logevents": []}})
        self.assertEqual(self.repair(client), (0, False))
        self.assertEqual(self.snapshot()["players"]["Q1"]["pageviews"]["status"], "partial")

    def test_missing_alias_months_remain_unknown_and_real_zero_buckets_are_preserved(self):
        client = RedirectClient(self.identity(), self.views("Abbreviation", 20, self.months[-2:]),
                                self.views("Old Club", 0), self.moves())
        self.assertEqual(self.repair(client), (0, False))
        row = self.snapshot()["players"]["Q1"]["pageviews"]
        self.assertEqual(row["title"], "Old Club")
        self.assertEqual(row["total_views"], 0)
        self.assertEqual(len(self.journal.records["Q1"]["redirect_views"]["Abbreviation"]["months"]), 2)

    def test_exhausted_budget_resumes_at_move_verification_without_refetching_aliases(self):
        first = RedirectClient(self.identity(), self.views("Abbreviation", 20), self.views("Old Club", 2000),
                               C.source.BudgetExhausted())
        self.assertEqual(self.repair(first), (0, True))
        self.journal = C.source.Journal(self.path)
        self.assertFalse(self.journal.records["Q1"]["redirect_scan"]["done"])
        resumed = RedirectClient(self.moves())
        self.assertEqual(self.repair(resumed), (0, False))
        self.assertEqual(len(resumed.calls), 1)
        self.assertEqual(resumed.calls[0][1]["list"], "logevents")
        self.assertEqual(self.snapshot()["players"]["Q1"]["pageviews"]["status"], "complete")

    def test_recent_move_after_many_old_redirects_gets_priority_without_expanding_view_requests(self):
        self.clubs["Q1"]["name"] = "Old Club"
        identity = self.identity()
        identity["query"]["pages"]["1"]["redirects"] = [
            *[{"ns": 0, "title": f"Old abbreviation {i}", "pageid": i} for i in range(20)],
            {"ns": 0, "title": "Old Club", "pageid": 100}]
        client = RedirectClient(identity, self.views("Old Club", 2000), self.moves())
        self.assertEqual(C.repair_redirects(self.clubs, self.journal, client, self.months, max_aliases=1), (0, False))
        self.assertEqual(client.calls[0][1]["rdlimit"], 500)
        self.assertEqual(len(client.calls), 3, "one metadata, one measured alias and one move verification")
        self.assertEqual(self.snapshot()["players"]["Q1"]["pageviews"]["title"], "Old Club")

    def test_an_unverified_popular_alias_does_not_hide_a_verified_historical_title(self):
        client = RedirectClient(self.identity(), self.views("Abbreviation", 3000), self.views("Old Club", 2000),
                                {"query": {"logevents": []}}, self.moves())
        self.assertEqual(self.repair(client), (0, False))
        row = self.snapshot()["players"]["Q1"]["pageviews"]
        self.assertEqual(row["title"], "Old Club")
        self.assertEqual(row["median_monthly_views"], 2000)

    def test_resume_keeps_negative_move_checks_and_reopens_old_incomplete_scans(self):
        old = self.journal.records["Q1"]
        old["redirect_scan"] = {"policy": 2, "done": True, "sitelink_title": "New Club", "fetched_at": C.source.utc_now()}
        self.journal.put("Q1", old)
        first = RedirectClient(self.identity(), self.views("Abbreviation", 3000), self.views("Old Club", 2000),
                               {"query": {"logevents": []}}, C.source.BudgetExhausted())
        self.assertEqual(self.repair(first), (0, True))
        self.journal = C.source.Journal(self.path)
        resumed = RedirectClient(self.moves())
        self.assertEqual(self.repair(resumed), (0, False))
        self.assertEqual(len(resumed.calls), 1)
        self.assertEqual(resumed.calls[0][1]["letitle"], "Old Club")
        self.assertEqual(self.snapshot()["players"]["Q1"]["pageviews"]["status"], "complete")


if __name__ == "__main__":
    unittest.main()
