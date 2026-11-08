"""Regression checks for Wikimedia API failures in the scheduled collector."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import call, patch

import requests


SPEC = importlib.util.spec_from_file_location(
    "popularity_retries", Path(__file__).resolve().parents[1] / "pipeline/popularity.py")
P = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(P)


def response(payload, retry_after=None):
    result = requests.Response()
    result.status_code = 200
    result._content = json.dumps(payload).encode()
    if retry_after is not None:
        result.headers["Retry-After"] = retry_after
    return result


MAXLAG = {"error": {"code": "maxlag", "info": "Waiting for replication lag"}}


class PopularityRetryTests(unittest.TestCase):
    def client(self, requests_limit=10, seconds=600):
        client = P.Client(requests_limit, seconds)
        self.addCleanup(client.session.close)
        return client

    def test_http_200_maxlag_can_recover_after_three_failed_attempts(self):
        client = self.client()
        with patch.object(client.session, "get", side_effect=[
                response(MAXLAG, "5"), response(MAXLAG, "5"), response(MAXLAG, "5"),
                response({"entities": {}})]), patch.object(P.time, "sleep") as sleep:
            self.assertEqual(client.get(P.WD_API), {"entities": {}})
        self.assertEqual(client.count, 4)
        delays = [entry.args[0] for entry in sleep.call_args_list if entry.args[0] != .2]
        self.assertEqual(delays, [5, 10, 20])

    def test_long_retry_after_is_a_minimum_and_cannot_be_shortened(self):
        for retry_after in ("180", "Thu, 01 Jan 1970 00:19:40 GMT"):
            with self.subTest(retry_after=retry_after):
                client = self.client()
                with patch.object(client.session, "get", side_effect=[
                        response(MAXLAG, retry_after), response({"entities": {}})]), \
                        patch.object(P.time, "time", return_value=1000), \
                        patch.object(P.time, "sleep") as sleep:
                    client.get(P.WD_API)
                self.assertIn(call(180), sleep.call_args_list)

    def test_retry_after_beyond_deadline_preserves_the_source_failure(self):
        client = self.client(seconds=60)
        with patch.object(client.session, "get", return_value=response(MAXLAG, "180")) as get, \
                patch.object(P.time, "sleep") as sleep:
            with self.assertRaisesRegex(ValueError, "maxlag.*Waiting for replication lag"):
                client.get(P.WD_API)
        self.assertEqual(get.call_count, 1)
        sleep.assert_not_called()

    def test_persistent_api_error_remains_a_failure_with_diagnostics_in_checkpoint(self):
        client = self.client()
        players = {"Q615": {"name": "Player", "club_count": 2}}
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "state.jsonl"
            journal = P.Journal(path)
            with patch.object(client.session, "get", return_value=response(MAXLAG)) as get, \
                    patch.object(P.time, "sleep"):
                self.assertEqual(P.collect(players, journal, client, P.month_window()), (1, False))
            self.assertEqual(get.call_count, 5)
            error = P.Journal(path).records["Q615"]["coverage_error"]
            self.assertIn("maxlag", error["message"])
            self.assertIn("Waiting for replication lag", error["message"])


if __name__ == "__main__":
    unittest.main()
