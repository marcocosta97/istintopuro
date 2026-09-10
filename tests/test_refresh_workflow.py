from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "refresh-data.yml"
PAGES_WORKFLOW = ROOT / ".github" / "workflows" / "pages.yml"


class RefreshWorkflowTests(unittest.TestCase):
    def test_all_release_paths_run_the_shared_checks(self):
        for workflow in (WORKFLOW, PAGES_WORKFLOW, ROOT / ".github/workflows/test.yml"):
            with self.subTest(workflow=workflow.name):
                self.assertIn("sh scripts/check.sh", workflow.read_text())
        checks = (ROOT / "scripts/check.sh").read_text()
        self.assertIn("VALIDATE_PUBLISHED_ONLY=1", checks)
        self.assertIn("tests/*.test.js", checks)

    def test_schedule_runs_monday_at_0200_utc(self):
        text = WORKFLOW.read_text()

        self.assertIn('cron: "0 2 * * 1"', text)

    def test_deployment_uses_the_refreshed_head_as_its_cache_version(self):
        text = WORKFLOW.read_text()

        self.assertIn('s/__V__/$(git rev-parse HEAD)/g', text)
        self.assertNotIn('s/__V__/${GITHUB_SHA}/g', text)

    def test_failed_refresh_falls_back_without_poisoning_validated_state(self):
        text = WORKFLOW.read_text()

        self.assertIn("id: refresh", text)
        self.assertIn("continue-on-error: true", text)
        self.assertIn("steps.refresh.outcome == 'failure'", text)
        self.assertIn("git restore --source=HEAD --staged --worktree site/data", text)
        self.assertIn("git clean -fd -- site/data", text)
        self.assertIn("steps.refresh.outcome == 'success'", text)
        self.assertIn("GITHUB_STEP_SUMMARY", text)
        self.assertIn("restore-keys: refresh-state-v1-", text)
        self.assertNotIn("hashFiles('pipeline/pipeline.py')", text)

    def test_external_actions_use_current_runtime_majors(self):
        text = WORKFLOW.read_text() + PAGES_WORKFLOW.read_text()

        for action in (
            "actions/checkout@v7",
            "actions/setup-python@v7",
            "actions/setup-node@v7",
            "actions/cache/restore@v6",
            "actions/cache/save@v6",
            "actions/upload-pages-artifact@v5",
            "actions/deploy-pages@v5",
        ):
            self.assertIn(action, text)
        for legacy in (
            "actions/checkout@v4",
            "actions/setup-python@v5",
            "actions/setup-node@v4",
            "actions/cache/restore@v4",
            "actions/cache/save@v4",
            "actions/upload-pages-artifact@v3",
            "actions/deploy-pages@v4",
        ):
            self.assertNotIn(legacy, text)
        self.assertIn("pip install --retries 10 --timeout 30", text)
        self.assertEqual(text.count("continue-on-error: true"), 5)


if __name__ == "__main__":
    unittest.main()
