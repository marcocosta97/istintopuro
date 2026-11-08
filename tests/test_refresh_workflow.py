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

    def test_recognition_restore_is_optional_and_runs_after_checkpoint_restore(self):
        text = WORKFLOW.read_text()
        restore = text.index("- name: Restore optional recognition snapshot")
        fetch = text.index("- name: Refresh dataset")
        self.assertLess(text.index("path: data\n"), restore)
        self.assertLess(restore, fetch)
        step = text[restore:fetch]
        self.assertIn("continue-on-error: true", step)
        self.assertIn("scripts/popularity-artifacts.py snapshot", step)
        self.assertIn("actions: read", text)
        self.assertNotIn("pipeline.py popularity", text)

    def test_club_sources_share_bounded_maintenance_and_do_not_run_during_releases(self):
        maintenance = (ROOT / ".github/workflows/refresh-popularity.yml").read_text()
        self.assertIn("scripts/club-recognition.py --max-requests 600 --max-seconds 600", maintenance)
        self.assertIn("steps.club_restore.outcome == 'success'", maintenance)
        for kind in ("checkpoint", "snapshot"):
            self.assertIn(f"quiz-club-recognition-{kind}-v1-", maintenance)
            self.assertIn(f"popularity-artifacts.py {kind} --scope clubs", maintenance)
        release = WORKFLOW.read_text()
        self.assertIn("popularity-artifacts.py snapshot --scope clubs", release)
        self.assertNotIn("club-recognition.py", release)

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
            "actions/upload-artifact@v7",
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

    def test_candidate_is_captured_before_recovery_and_uploaded_after_checks(self):
        text = WORKFLOW.read_text()
        capture = text.index("- name: Capture candidate")
        recovery = text.index("- name: Keep the last validated dataset")
        checks = text.index("- name: Test pipeline")
        upload = text.index("- name: Save failed refresh diagnostics")
        self.assertLess(capture, recovery)
        self.assertLess(checks, upload)
        self.assertIn("cp -R site/data /tmp/refresh-diagnostics/candidate", text)
        self.assertIn("failure() || steps.refresh.outcome == 'failure'", text[upload:])
        self.assertIn("retention-days: 7", text[upload:])

    def test_logged_commands_use_bash_pipefail_so_tee_cannot_hide_failure(self):
        text = WORKFLOW.read_text()
        for name in ("Refresh dataset", "Test pipeline"):
            step = text.split(f"- name: {name}", 1)[1].split("\n      - ", 1)[0]
            self.assertIn("shell: bash", step)
            self.assertIn("| tee /tmp/", step)

    def test_failed_refresh_is_reported_after_recovery_and_diagnostics(self):
        text = WORKFLOW.read_text()
        mark = text.index("- name: Mark unsuccessful refresh after fallback")
        self.assertLess(text.index("uses: actions/deploy-pages@v5"), mark)
        self.assertLess(text.index("- name: Save failed refresh diagnostics"), mark)
        self.assertIn("always() && steps.refresh.outcome == 'failure'", text[mark:])
        self.assertIn("exit 1", text[mark:])
        commit = text.split("- name: Commit refreshed dataset", 1)[1].split("\n      - ", 1)[0]
        self.assertIn("if: steps.refresh.outcome == 'success'", commit)


if __name__ == "__main__":
    unittest.main()
