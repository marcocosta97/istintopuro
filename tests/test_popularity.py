import copy
import hashlib
from datetime import date
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import requests


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("popularity", ROOT / "pipeline/popularity.py")
P = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(P)
MONTHS = P.month_window("2025-12", today=date(2026, 2, 1))
PLAYERS = {"Q1": {"name": "Player", "club_count": 2}}


def entity(title="Player"):
    return {"sitelinks": {
        "enwiki": {"url": "https://en.wikipedia.org/wiki/Player", "title": title},
        "itwiki": {"url": "https://it.wikipedia.org/wiki/Giocatore", "title": "Giocatore"},
        "commonswiki": {"url": "https://commons.wikimedia.org/wiki/Category:Player", "title": "Category:Player"},
        "enwikiquote": {"url": "https://en.wikiquote.org/wiki/Player", "title": title},
    }}


def payload(months=MONTHS, value=100, title="Player"):
    return {"items": [{"timestamp": m.replace("-", "") + "0100", "views": value,
                       "article": title.replace(" ", "_"), "project": "en.wikipedia",
                       "access": "all-access", "agent": "user", "granularity": "monthly"}
                      for m in months]}


class FakeClient:
    def __init__(self, *responses):
        self.responses = iter(responses)
        self.calls = []

    def get(self, url, params=None, missing_ok=False):
        self.calls.append((url, params, missing_ok))
        value = next(self.responses)
        if isinstance(value, Exception):
            raise value
        return value


class PopularityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "state.jsonl"
        self.journal = P.Journal(self.path)
        clock = patch.object(P, "utc_now", return_value="2026-01-15T00:00:00+00:00")
        self.clock = clock.start()
        self.addCleanup(clock.stop)

    def collect(self, client, months=MONTHS, players=PLAYERS):
        return P.collect(players, self.journal, client, months)

    def report(self, months=MONTHS):
        return P.audit(PLAYERS, self.journal, months, "2025-12-01", 0, 0, False)["players"]["Q1"]

    def seed(self, months=MONTHS):
        self.collect(FakeClient({"entities": {"Q1": entity()}}, payload(months)), months)

    def test_window_handles_year_rollover_leap_year_and_rejects_incomplete_months(self):
        self.assertEqual(P.month_window(today=date(2026, 1, 1)), MONTHS)
        window = P.month_window("2024-02", today=date(2026, 1, 1))
        self.assertEqual((window[0], window[-1]), ("2023-03", "2024-02"))
        with self.assertRaises(ValueError):
            P.month_window("2026-01", today=date(2026, 1, 15))

    def test_language_count_excludes_other_wikimedia_projects_and_missing_is_unknown(self):
        coverage = P.language_coverage(entity())
        self.assertEqual(coverage["languages"], ["en", "it"])
        self.assertEqual(coverage["count"], 2)
        self.assertIsNone(P.language_coverage({"missing": ""})["count"])
        self.assertEqual(P.language_coverage({"sitelinks": {}})["count"], 0)
        for malformed in (None, {}, {"sitelinks": {"enwiki": {"title": "Player"}}}):
            with self.subTest(malformed=malformed), self.assertRaises(ValueError):
                P.language_coverage(malformed)

    def test_repeated_run_reuses_both_signals_without_network_requests(self):
        self.seed()
        warm = FakeClient()
        self.assertEqual(self.collect(warm), (0, False))
        self.assertEqual(warm.calls, [])
        row = self.report()
        self.assertEqual(row["pageviews"]["total_views"], 1200)
        self.assertEqual(row["pageviews"]["median_monthly_views"], 100)
        self.assertTrue(row["language_coverage"]["current"])

    def test_quarterly_refresh_batches_the_missing_months_in_one_request(self):
        self.seed()
        self.clock.return_value = "2026-04-15T00:00:00+00:00"
        months = P.month_window("2026-03", today=date(2026, 4, 15))
        client = FakeClient({"entities": {"Q1": entity()}}, payload(months[-3:], 200))
        self.collect(client, months)
        self.assertTrue(client.calls[1][0].endswith("/monthly/20260101/20260331"))
        self.assertEqual(self.report(months)["pageviews"]["total_views"], 1500)
        self.assertNotIn("2025-01", self.journal.records["Q1"]["views"]["months"])

    def test_missing_buckets_are_unknown_but_an_explicit_zero_is_valid(self):
        self.collect(FakeClient({"entities": {"Q1": entity()}}, payload(MONTHS[:1], 0)))
        views = self.report()["pageviews"]
        self.assertEqual(views["status"], "partial")
        self.assertEqual(views["monthly"][0][1], 0)
        self.assertIsNone(views["monthly"][1][1])
        self.assertIsNone(views["total_views"])
        self.assertIsNone(views["median_monthly_views"])
        warm = FakeClient()
        self.collect(warm)
        self.assertEqual(warm.calls, [])
        with patch.object(P, "utc_now", return_value="2026-04-15T00:00:00+00:00"):
            retry = FakeClient({"entities": {"Q1": entity()}}, payload(MONTHS[1:], 1))
            self.collect(retry)
        self.assertEqual(self.report()["pageviews"]["total_views"], 11)

    def test_404_and_no_english_article_are_distinct_from_zero(self):
        self.collect(FakeClient({"entities": {"Q1": entity()}}, None))
        self.assertEqual(self.report()["pageviews"]["status"], "unavailable")
        self.assertIsNone(self.report()["pageviews"]["total_views"])
        other = entity()
        del other["sitelinks"]["enwiki"]
        self.journal = P.Journal(Path(self.temp.name) / "other.jsonl")
        client = FakeClient({"entities": {"Q1": other}})
        self.collect(client)
        self.assertEqual(len(client.calls), 1)
        self.assertEqual(self.report()["pageviews"]["status"], "no_article")

    def test_title_change_does_not_merge_old_article_counts(self):
        self.seed()
        self.clock.return_value = "2026-04-15T00:00:00+00:00"
        months = P.month_window("2026-01", today=date(2026, 2, 1))
        client = FakeClient({"entities": {"Q1": entity("New title/é")}},
                            payload(["2026-01"], 200, title="New title/é"))
        self.collect(client, months)
        self.assertIn("/New_title%2F%C3%A9/", client.calls[1][0])
        views = self.report(months)["pageviews"]
        self.assertEqual(views["observed_months"], 1)
        self.assertIsNone(views["total_views"])

    def test_metadata_failure_preserves_old_values_and_prevents_requests_to_stale_titles(self):
        self.seed()
        old = copy.deepcopy(self.journal.records["Q1"])
        self.clock.return_value = "2026-04-15T00:00:00+00:00"
        months = P.month_window("2026-01", today=date(2026, 2, 1))
        client = FakeClient(requests.ConnectionError("offline"))
        self.assertEqual(self.collect(client, months), (1, False))
        self.assertEqual(len(client.calls), 1)
        self.assertEqual(self.journal.records["Q1"]["coverage"], old["coverage"])
        self.assertEqual(self.journal.records["Q1"]["views"], old["views"])
        self.assertFalse(self.report(months)["language_coverage"]["current"])

    def test_view_failure_preserves_history_and_can_be_retried(self):
        self.seed()
        self.clock.return_value = "2026-04-15T00:00:00+00:00"
        months = P.month_window("2026-01", today=date(2026, 2, 1))
        self.collect(FakeClient({"entities": {"Q1": entity()}}, requests.Timeout()), months)
        self.assertEqual(self.report(months)["pageviews"]["observed_months"], 12)
        self.assertIn("views", self.report(months)["errors"])
        self.clock.return_value = "2026-04-22T00:00:00+00:00"
        self.collect(FakeClient(payload(["2026-01"])), months)
        self.assertEqual(self.report(months)["pageviews"]["status"], "complete")
        self.assertEqual(self.report(months)["errors"], {})

    def test_budget_resume_uses_durable_metadata_without_refetching(self):
        client = FakeClient({"entities": {"Q1": entity()}}, P.BudgetExhausted())
        self.assertEqual(self.collect(client), (0, True))
        self.journal = P.Journal(self.path)
        resumed = FakeClient(payload())
        self.collect(resumed)
        self.assertEqual(len(resumed.calls), 1)
        self.assertTrue(resumed.calls[0][0].startswith(P.VIEWS_API))

    def test_unavailable_articles_cannot_starve_players_not_yet_attempted(self):
        coverage = {**P.language_coverage(entity()), "period": "2026-01", "fetched_at": "2026-01-01T00:00:00+00:00"}
        self.journal.put("Q1", {"coverage": coverage, "views": {
            "title": "Player", "months": {}, "status": "unavailable",
            "attempted_on": "2026-01-01", "fetched_at": "2026-01-01T00:00:00+00:00"}})
        self.journal.put("Q2", {"coverage": {**coverage, "enwiki": "Second"}})
        players = {**PLAYERS, "Q2": {"name": "Second", "club_count": 2}}
        client = FakeClient(payload(title="Second"))
        self.assertEqual(self.collect(client, players=players), (0, False))
        self.assertIn("/Second/monthly/", client.calls[0][0])
        self.assertEqual(len(self.journal.records["Q2"]["views"]["months"]), 12)

    def test_a_killed_journal_write_is_discarded_without_losing_the_last_success(self):
        self.seed()
        with self.path.open("a") as out:
            out.write('{"version":1,"qid":"Q2"')
        resumed = P.Journal(self.path)
        self.assertIn("Q1", resumed.records)
        self.assertNotIn("Q2", resumed.records)
        resumed.put("Q2", {})
        self.assertIn("Q2", P.Journal(self.path).records)

    def test_historical_readership_window_does_not_freeze_language_coverage(self):
        self.seed()
        self.clock.return_value = "2026-04-15T00:00:00+00:00"
        client = FakeClient({"entities": {"Q1": entity()}})
        self.collect(client)  # Same historical views, new observation month.
        self.assertEqual(len(client.calls), 1)
        self.assertEqual(self.report()["language_coverage"]["period"], "2026-04")

    def test_month_boundaries_do_not_expire_fresh_players_or_erase_their_measured_window(self):
        self.seed()
        self.clock.return_value = "2026-02-15T00:00:00+00:00"
        months = P.month_window("2026-01")
        client = FakeClient()
        self.collect(client, months)
        self.assertEqual(client.calls, [])
        views = self.report(months)["pageviews"]
        self.assertEqual(views["through"], "2025-12")
        self.assertEqual(views["total_views"], 1200)
        self.assertTrue(views["current"])

    def test_refresh_deadline_is_per_player_and_newcomers_do_not_refetch_existing_players(self):
        self.seed()
        self.clock.return_value = "2026-04-14T00:00:00+00:00"  # 89 days old.
        newcomer = {**PLAYERS, "Q2": {"name": "Second", "club_count": 2}}
        client = FakeClient({"entities": {"Q2": entity("Second")}}, payload(title="Second"))
        self.collect(client, players=newcomer)
        self.assertEqual(client.calls[0][1]["ids"], "Q2")
        self.assertEqual(len(client.calls), 2)
        self.assertTrue(self.report()["language_coverage"]["current"])

    def snapshot(self):
        return P.make_snapshot(P.audit(PLAYERS, self.journal, MONTHS, "2025-12-01", 0, 0, False))

    def test_partial_refresh_keeps_the_previous_complete_series_in_the_validated_snapshot(self):
        self.seed()
        previous = self.snapshot()
        self.clock.return_value = "2026-04-15T00:00:00+00:00"
        months = P.month_window("2026-03")
        self.collect(FakeClient({"entities": {"Q1": entity()}}, payload(["2026-01"])), months)
        report = P.audit(PLAYERS, self.journal, months, "2026-04-01", 2, 0, False)
        self.assertEqual(report["players"]["Q1"]["pageviews"]["status"], "partial")
        snapshot = P.make_snapshot(report, previous)
        views = snapshot["players"]["Q1"]["pageviews"]
        self.assertEqual(views["total_views"], 1200)
        self.assertEqual(views["through"], "2025-12")
        self.assertFalse(views["current"])

    def test_publishing_never_uses_a_source_client_and_preserves_good_output_on_bad_input(self):
        self.seed()
        source, output = Path(self.temp.name) / "snapshot.json", Path(self.temp.name) / "published.json"
        source.write_text(json.dumps(self.snapshot()))
        with patch.object(P, "Client") as client:
            P.main(["--publish", "--snapshot", str(source), "--output", str(output)])
        client.assert_not_called()
        good = output.read_bytes()
        source.write_text('{"version": 999}')
        P.publish_snapshot(source, output)
        self.assertEqual(output.read_bytes(), good)

    def test_missing_or_older_snapshots_cannot_replace_a_newer_published_snapshot(self):
        self.seed()
        source, output = Path(self.temp.name) / "source.json", Path(self.temp.name) / "published.json"
        source.write_text(json.dumps(self.snapshot()))
        self.clock.return_value = "2026-01-22T00:00:00+00:00"
        output.write_text(json.dumps(self.snapshot()))
        previous = output.read_bytes()
        P.publish_snapshot(source, output)
        self.assertEqual(output.read_bytes(), previous)
        source.unlink()
        P.publish_snapshot(source, output)
        self.assertEqual(output.read_bytes(), previous)

    def test_snapshot_validation_rejects_tampered_totals_and_duplicate_months(self):
        self.seed()
        snapshot = self.snapshot()
        snapshot["players"]["Q1"]["pageviews"]["total_views"] = 999
        with self.assertRaises(ValueError):
            P.validate_snapshot(snapshot)
        snapshot = self.snapshot()
        snapshot["players"]["Q1"]["pageviews"]["monthly"][1][0] = MONTHS[0]
        with self.assertRaises(ValueError):
            P.validate_snapshot(snapshot)

    def test_failed_collection_keeps_checkpoint_progress_and_does_not_replace_validated_snapshot(self):
        self.seed()
        snapshot = Path(self.temp.name) / "snapshot.json"
        snapshot.write_text(json.dumps(self.snapshot()))
        previous = snapshot.read_bytes()
        self.clock.return_value = "2026-04-15T00:00:00+00:00"
        with patch.object(P, "candidates", return_value=("2025-12-01", PLAYERS)), \
                patch.object(requests.Session, "get", side_effect=requests.ConnectionError()), \
                patch.object(P.time, "sleep"):
            result = P.main(["--state", str(self.path), "--snapshot", str(snapshot),
                             "--output", str(Path(self.temp.name) / "audit.json"),
                             "--through", "2026-03"])
        self.assertEqual(result, 1)
        self.assertEqual(snapshot.read_bytes(), previous)
        self.assertIn("coverage_error", P.Journal(self.path).records["Q1"])
        self.journal = P.Journal(self.path)
        client = FakeClient()
        self.collect(client, P.month_window("2026-03"))
        self.assertEqual(client.calls, [])  # Back off until a later weekly run.

    def test_malformed_or_mismatched_view_payloads_cannot_poison_counts(self):
        for key, value in [("views", -1), ("views", True), ("agent", "all-agents"),
                           ("article", "Another player"), ("article", None), ("timestamp", "2025011500")]:
            bad = payload(MONTHS[:1])
            bad["items"][0][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                P.parse_views(bad, "Player", MONTHS)
        for bad in ({}, {"items": [None]}, {"items": payload(MONTHS[:1])["items"] * 2}):
            with self.assertRaises(ValueError):
                P.parse_views(bad, "Player", MONTHS)

    def test_candidate_selection_uses_core_postings_and_stable_qids(self):
        root = Path(self.temp.name) / "site"
        (root / "career").mkdir(parents=True)
        # p0 plays twice, p1 has a zero registration, p2 has unknown counts twice.
        index = {"built": "2026-01-01", "nshards": 1, "names": ["A", "B", "C"],
                 "postings": [[0, 1, 1], [0, 1, 1]], "apps": [[2, 0, -1], [1, 5, -1]]}
        (root / "index.json").write_text(json.dumps(index))
        (root / "career/0.json").write_text(json.dumps({"0": [42, []], "1": [43, []], "2": [44, []]}))
        _, selected = P.candidates(root)
        self.assertEqual(set(selected), {"Q42", "Q44"})

    def test_frozen_sample_rejects_other_datasets_and_duplicate_or_unavailable_candidates(self):
        root = Path(self.temp.name) / "site"
        root.mkdir()
        index = root / "index.json"
        index.write_text('{"built":"2025-12-01"}')
        source = Path(self.temp.name) / "sample.json"
        sample = {"version": 1, "kind": "recognition-calibration-sample",
                  "indexFileDigest": hashlib.sha256(index.read_bytes()).hexdigest(), "players": [{"qid": "Q1"}]}
        source.write_text(json.dumps(sample))
        self.assertEqual(P.sample_players(source, root, PLAYERS), PLAYERS)
        for qids in (["Q1", "Q1"], ["Q2"]):
            source.write_text(json.dumps({**sample, "players": [{"qid": qid} for qid in qids]}))
            with self.assertRaisesRegex(ValueError, "unique core candidate"):
                P.sample_players(source, root, PLAYERS)
        source.write_text(json.dumps(sample))
        index.write_text('{"built":"2025-12-02"}')
        with self.assertRaisesRegex(ValueError, "different core index"):
            P.sample_players(source, root, PLAYERS)

    def test_quiz_priority_is_bound_to_the_core_index_and_validates_candidate_qids(self):
        root = Path(self.temp.name) / "priority-input"
        root.mkdir()
        (root / "index.json").write_text('{}')
        source = root / "priority.json"
        priority = {"version": 1, "kind": "quiz-recognition-priority", "qids": ["Q100"],
                    "indexFileDigest": hashlib.sha256((root / "index.json").read_bytes()).hexdigest()}
        source.write_text(json.dumps(priority))
        players = {**PLAYERS, "Q100": {"name": "Modern Player", "club_count": 2}}
        self.assertEqual(P.priority_qids(source, root, players), ["Q100"])
        for qids in (["Q100", "Q100"], ["Q999"]):
            source.write_text(json.dumps({**priority, "qids": qids}))
            with self.assertRaises(ValueError):
                P.priority_qids(source, root, players)
        source.write_text(json.dumps(priority))
        (root / "index.json").write_text('{"built":"changed"}')
        with self.assertRaisesRegex(ValueError, "mismatched"):
            P.priority_qids(source, root, players)

    def test_quiz_priority_precedes_unattempted_ordinary_readership_without_dropping_it(self):
        players = {**PLAYERS, "Q100": {"name": "Priority", "club_count": 2}}
        coverage = {**P.language_coverage(entity()), "fetched_at": P.utc_now(), "period": "2026-01"}
        self.journal.put("Q1", {"coverage": coverage})
        self.journal.put("Q100", {"coverage": {**coverage, "enwiki": "Priority"},
            "views": {"title": "Priority", "months": {}, "fetched_at": "2025-01-01T00:00:00+00:00"}})
        first = FakeClient(payload(title="Priority"), P.BudgetExhausted())
        self.assertEqual(P.collect(players, self.journal, first, MONTHS, priority_qids=["Q100"]), (0, True))
        self.assertIn("/Priority/monthly/", first.calls[0][0])
        resumed = FakeClient(payload())
        self.assertEqual(P.collect(players, self.journal, resumed, MONTHS, priority_qids=["Q100"]), (0, False))
        self.assertIn("/Player/monthly/", resumed.calls[0][0])
        self.assertEqual(set(self.journal.records), set(players))

    def test_quiz_priority_precedes_older_ordinary_coverage_batches(self):
        players = {f"Q{i}": {"name": "Player", "club_count": 2} for i in range(1, 52)}
        self.journal.put("Q51", {"coverage": {**P.language_coverage(entity()),
            "fetched_at": "2025-01-01T00:00:00+00:00", "period": "2025-01"}})
        batch = ["Q51", *[f"Q{i}" for i in range(1, 50)]]
        client = FakeClient({"entities": {qid: entity() for qid in batch}}, P.BudgetExhausted())
        self.assertEqual(P.collect(players, self.journal, client, MONTHS, priority_qids=["Q51"]), (0, True))
        self.assertEqual(client.calls[0][1]["ids"].split("|"), batch)
        self.assertTrue(P.fresh(self.journal.records["Q51"]["coverage"]))

    def test_sample_collection_reuses_checkpoint_and_writes_an_isolated_snapshot(self):
        self.seed()
        root = Path(self.temp.name) / "site"
        root.mkdir()
        (root / "index.json").write_text('{}')
        source = Path(self.temp.name) / "sample.json"
        source.write_text(json.dumps({"version": 1, "kind": "recognition-calibration-sample",
                          "indexFileDigest": hashlib.sha256((root / "index.json").read_bytes()).hexdigest(),
                          "players": [{"qid": "Q1"}]}))
        output = Path(self.temp.name) / "sample-metrics.json"
        snapshot = Path(self.temp.name) / "sample-snapshot.json"
        args = ["--sample", str(source), "--site-data", str(root), "--state", str(self.path),
                "--output", str(output), "--snapshot", str(snapshot), "--through", "2025-12"]
        with patch.object(P, "candidates", return_value=("2025-12-01", PLAYERS)), \
                patch.object(requests.Session, "get") as get:
            self.assertEqual(P.main(args), 0)
        get.assert_not_called()
        saved = P.validate_snapshot(json.loads(snapshot.read_text()))
        self.assertEqual(set(saved["players"]), {"Q1"})
        self.assertIn("frozen calibration sample", saved["scope"])
        self.assertEqual(saved["sample_digest"], hashlib.sha256(source.read_bytes()).hexdigest())
        with self.assertRaises(SystemExit):
            P.main(["--sample", str(source), "--snapshot", str(ROOT / "data/popularity/snapshot.json")])

    def test_cli_writes_a_partial_audit_and_resumes_it_to_completion(self):
        output = Path(self.temp.name) / "metrics.json"
        args = ["--state", str(self.path), "--output", str(output), "--through", "2025-12",
                "--snapshot", str(Path(self.temp.name) / "snapshot.json"),
                "--max-requests", "1", "--max-seconds", "60"]
        response = ClientTests().response(data={"entities": {"Q1": entity()}})
        with patch.object(P, "candidates", return_value=("2025-12-01", PLAYERS)), \
                patch.object(requests.Session, "get", return_value=response) as get:
            self.assertEqual(P.main(args), 0)
        self.assertEqual(get.call_count, 1)
        report = json.loads(output.read_text())
        self.assertTrue(report["run"]["budget_exhausted"])
        self.assertEqual(report["summary"]["pageviews_pending"], 1)
        with patch.object(P, "candidates", return_value=("2025-12-01", PLAYERS)), \
                patch.object(requests.Session, "get", return_value=ClientTests().response(data=payload())):
            self.assertEqual(P.main(args), 0)
        report = json.loads(output.read_text())
        self.assertFalse(report["run"]["budget_exhausted"])
        self.assertEqual(report["summary"]["pageviews_complete"], 1)

    def test_weekly_job_preserves_partial_state_and_keeps_collection_separate_from_releases(self):
        workflow = (ROOT / ".github/workflows/refresh-popularity.yml").read_text()
        self.assertIn("python3 pipeline/pipeline.py popularity", workflow)
        self.assertIn("contents: read", workflow)
        save = workflow.split("- name: Preserve source results", 1)[1].split("\n      - ", 1)[0]
        self.assertIn("if: always()", save)
        self.assertIn("actions/upload-artifact@v7", save)
        self.assertIn("retention-days: 90", save)
        self.assertIn('cron: "17 3 * * 0"', workflow)
        self.assertNotIn("actions/cache/", workflow)
        self.assertIn("data/popularity/state.jsonl", save)
        self.assertNotIn("git push", workflow)
        self.assertNotIn("deploy-pages", workflow)


class ClientTests(unittest.TestCase):
    def response(self, status=200, data=None, headers=None):
        response = requests.Response()
        response.status_code = status
        response._content = json.dumps(data or {"ok": True}).encode()
        response.headers.update(headers or {})
        return response

    def test_retry_after_is_respected_and_http_attempts_count_against_budget(self):
        client = P.Client(2, 60)
        self.addCleanup(client.session.close)
        responses = [self.response(429, headers={"Retry-After": "7"}), self.response()]
        with patch.object(client.session, "get", side_effect=responses), patch.object(P.time, "sleep") as sleep:
            self.assertEqual(client.get("https://example.test"), {"ok": True})
        self.assertIn(unittest.mock.call(7.0), sleep.call_args_list)
        self.assertEqual(client.count, 2)
        with self.assertRaises(P.BudgetExhausted):
            client.get("https://example.test")

    def test_api_error_is_retried_and_user_agent_identifies_the_pipeline(self):
        client = P.Client(3, 60)
        self.addCleanup(client.session.close)
        responses = [self.response(data={"error": {"code": "maxlag"}}), self.response()]
        with patch.object(client.session, "get", side_effect=responses), patch.object(P.time, "sleep"):
            client.get(P.WD_API)
        self.assertEqual(client.count, 2)
        self.assertEqual(client.session.headers["User-Agent"], P.UA)

    def test_source_error_at_the_request_limit_is_not_reported_as_successful_partial_collection(self):
        client = P.Client(1, 60)
        self.addCleanup(client.session.close)
        with patch.object(client.session, "get", side_effect=requests.ConnectionError("offline")):
            with self.assertRaises(requests.ConnectionError):
                client.get(P.WD_API)


if __name__ == "__main__":
    unittest.main()
