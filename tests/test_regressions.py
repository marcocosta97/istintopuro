import importlib.util
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("pipeline", ROOT / "pipeline" / "pipeline.py")
PIPELINE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PIPELINE)


class WikipediaOverlayTests(unittest.TestCase):
    def test_infobox_excludes_youth_clubs_from_the_senior_career(self):
        text = """{{Infobox football biography
            | youthclubs1 = [[Udinese Calcio|Udinese]]
            | years1 = 2000–2001 | caps1 = 24 | goals1 = 4
            | clubs1 = [[A.S.D. Castel di Sangro Calcio|Castel di Sangro]]
        }}"""

        self.assertEqual(PIPELINE.parse_infobox(text), [
            ["A.S.D. Castel di Sangro Calcio", 2000, 2001, 24, 4, 0],
        ])

    def test_complete_wikipedia_career_is_kept_as_is(self):
        spells = [
            ["Senior One", 2000, 2001, 10, 2, 0],
            ["Senior Two", 2002, 2003, 20, 3, 0],
        ]

        self.assertEqual(PIPELINE.resolve_wp_spells(spells, {
            "Senior One": "Q1", "Senior Two": "Q2",
        }), [
            ["Q1", 2000, 2001, 10, 2, 0],
            ["Q2", 2002, 2003, 20, 3, 0],
        ])

    def test_partial_title_resolution_keeps_wikidata_fallback(self):
        spells = [
            ["Senior One", 2000, 2001, 10, 2, 0],
            ["Unresolved", 2002, 2003, 20, 3, 0],
        ]

        self.assertIsNone(PIPELINE.resolve_wp_spells(spells, {"Senior One": "Q1"}))


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
