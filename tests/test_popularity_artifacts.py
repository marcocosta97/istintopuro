import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock
import zipfile

import requests


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("popularity_artifacts", ROOT / "scripts/popularity-artifacts.py")
A = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(A)


def response(payload=None, content=None, status=200):
    result = requests.Response()
    result.status_code = status
    result._content = content if content is not None else json.dumps(payload).encode()
    return result


def run(run_id=10, branch="master", repo="owner/repo", event="schedule", conclusion="success"):
    return {"id": run_id, "head_branch": branch, "head_repository": {"full_name": repo},
            "event": event, "conclusion": conclusion}


def artifact(artifact_id=100, kind="checkpoint", expired=False):
    return {"id": artifact_id, "name": f"quiz-recognition-{kind}-v1-10-1",
            "expired": expired, "created_at": "2026-01-01T00:00:00Z"}


def archive(contents=None, filename="state.jsonl"):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as out:
        out.writestr(filename, contents if contents is not None else
                     json.dumps({"version": 1, "qid": "Q42", "record": {}}) + "\n")
        out.writestr("../unrelated", "never extracted")
    return buf.getvalue()


class ArtifactRestoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.destination = Path(self.tmp.name) / "restored" / "state.jsonl"
        self.destination.parent.mkdir()
        self.session = Mock()

    def restore(self, kind="checkpoint"):
        return A.restore(self.session, "owner/repo", "master", kind, self.destination)

    def test_restores_partial_progress_even_when_the_source_run_failed(self):
        self.session.get.side_effect = [response({"workflow_runs": [run(conclusion="failure")]}),
                                        response({"artifacts": [artifact()]}), response(content=archive())]
        self.assertTrue(self.restore())
        self.assertEqual(json.loads(self.destination.read_text())["qid"], "Q42")
        self.assertFalse((Path(self.tmp.name) / "unrelated").exists())

    def test_restore_skips_other_branches_forks_pull_requests_and_expired_artifacts(self):
        self.session.get.side_effect = [response({"workflow_runs": [run(branch="feature"), run(repo="fork/repo"),
                                            run(event="pull_request"), run()]}),
                                        response({"artifacts": [artifact(expired=True)]})]
        self.assertFalse(self.restore())
        self.assertEqual(self.session.get.call_count, 2)

    def test_invalid_latest_checkpoint_falls_back_to_an_older_valid_run(self):
        self.session.get.side_effect = [response({"workflow_runs": [run(11), run(10)]}),
            response({"artifacts": [artifact(101)]}), response(content=archive('{"version":99}\n')),
            response({"artifacts": [artifact(100)]}), response(content=archive())]
        self.assertTrue(self.restore())
        self.assertEqual(json.loads(self.destination.read_text())["qid"], "Q42")

    def test_all_invalid_artifacts_fail_without_overwriting_existing_state(self):
        self.destination.write_text("keep this checkpoint")
        self.session.get.side_effect = [response({"workflow_runs": [run()]}),
            response({"artifacts": [artifact()]}), response(content=b"not a zip archive")]
        with self.assertRaises(ValueError):
            self.restore()
        self.assertEqual(self.destination.read_text(), "keep this checkpoint")

    def test_missing_workflow_and_empty_history_allow_first_bootstrap(self):
        for result in (response(status=404), response({"workflow_runs": []})):
            with self.subTest(status=result.status_code):
                self.session.get.side_effect = [result]
                self.assertFalse(self.restore())
        self.assertFalse(self.destination.exists())

    def test_network_failure_does_not_silently_start_a_new_backfill(self):
        self.destination.write_text("keep this checkpoint")
        self.session.get.side_effect = requests.ConnectionError("unavailable")
        with self.assertRaises(requests.ConnectionError):
            self.restore()
        self.assertEqual(self.destination.read_text(), "keep this checkpoint")

    def test_archive_without_the_expected_member_is_rejected(self):
        self.session.get.side_effect = [response({"workflow_runs": [run()]}),
            response({"artifacts": [artifact()]}), response(content=archive(filename="unexpected.json"))]
        with self.assertRaises(ValueError):
            self.restore()
        self.assertFalse(self.destination.exists())

    def test_snapshot_restoration_validates_the_observations_before_replacing_output(self):
        self.destination.write_text("last validated snapshot")
        self.session.get.side_effect = [response({"workflow_runs": [run()]}),
            response({"artifacts": [artifact(kind="snapshot")]}),
            response(content=archive('{"version":1,"players":{}}', "snapshot.json"))]
        with self.assertRaises(ValueError):
            self.restore("snapshot")
        self.assertEqual(self.destination.read_text(), "last validated snapshot")

    def test_valid_snapshot_can_be_restored_and_published_without_a_source_request(self):
        months = A.P.month_window()
        journal = A.P.Journal(Path(self.tmp.name) / "source.jsonl")
        report = A.P.audit({"Q42": {"name": "Player", "club_count": 2}}, journal,
                           months, "2026-01-01", 0, 0, True)
        snapshot = A.P.make_snapshot(report)
        self.session.get.side_effect = [response({"workflow_runs": [run()]}),
            response({"artifacts": [artifact(kind="snapshot")]}),
            response(content=archive(json.dumps(snapshot), "snapshot.json"))]
        self.assertTrue(self.restore("snapshot"))
        published = Path(self.tmp.name) / "recognition.json"
        A.P.publish_snapshot(self.destination, published)
        self.assertEqual(json.loads(published.read_text())["players"], snapshot["players"])


if __name__ == "__main__":
    unittest.main()
