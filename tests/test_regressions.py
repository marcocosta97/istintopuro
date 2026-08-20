import importlib.util
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("pipeline", ROOT / "pipeline" / "pipeline.py")
PIPELINE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PIPELINE)


class WikipediaOverlayGuardTests(unittest.TestCase):
    def test_rejects_equal_count_overlay_missing_a_wikidata_club(self):
        wd = [
            ["Q1", 2000, 2001, 10, None, 0],
            ["Q2", 2002, 2003, None, 2, 0],
        ]
        wp = [
            ["Q1", 2000, 2001, 10, None, 0],
            ["Q3", 2002, 2003, None, 2, 0],
        ]

        self.assertFalse(PIPELINE.wp_covers_wd(wd, wp))

    def test_rejects_known_stat_moved_to_another_covered_club(self):
        wd = [
            ["Q1", 2000, 2001, 10, None, 0],
            ["Q2", 2002, 2003, None, 2, 0],
        ]
        wp = [
            ["Q1", 2000, 2001, None, None, 0],
            ["Q2", 2002, 2003, 10, 2, 0],
        ]

        self.assertFalse(PIPELINE.wp_covers_wd(wd, wp))

    def test_accepts_overlay_that_preserves_clubs_and_known_stat_kinds(self):
        wd = [
            ["Q1", 2000, 2001, 10, None, 0],
            ["Q2", 2002, 2003, None, 2, 0],
            ["Q-bare", None, None, None, None, 0],
        ]
        wp = [
            ["Q1", 2000, 2001, 12, 1, 0],
            ["Q2", 2002, 2003, 5, 3, 0],
        ]

        self.assertTrue(PIPELINE.wp_covers_wd(wd, wp))

    def test_keeps_aggregate_richness_guard(self):
        wd = [
            ["Q1", 2000, 2001, 10, None, 0],
            ["Q1", 2004, 2005, 8, None, 0],
        ]
        wp = [["Q1", 2000, 2005, 18, 0, 0]]

        self.assertFalse(PIPELINE.wp_covers_wd(wd, wp))


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
