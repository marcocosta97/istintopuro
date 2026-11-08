import importlib.util
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


if __name__ == "__main__":
    unittest.main()
