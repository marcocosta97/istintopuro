from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "refresh-data.yml"


class RefreshWorkflowTests(unittest.TestCase):
    def test_schedule_runs_monday_at_0200_utc(self):
        text = WORKFLOW.read_text()

        self.assertIn('cron: "0 2 * * 1"', text)

    def test_deployment_uses_the_refreshed_head_as_its_cache_version(self):
        text = WORKFLOW.read_text()

        self.assertIn('s/__V__/$(git rev-parse HEAD)/g', text)
        self.assertNotIn('s/__V__/${GITHUB_SHA}/g', text)


if __name__ == "__main__":
    unittest.main()
