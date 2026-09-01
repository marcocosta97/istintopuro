import unittest
import xml.etree.ElementTree as ET
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "site"
ORIGIN = "https://istintopuro.mcosta.it"


class SeoFilesTest(unittest.TestCase):
    def test_homepage_declares_canonical_url_and_static_about_copy(self):
        html = (SITE / "index.html").read_text()

        self.assertIn(f'<link rel="canonical" href="{ORIGIN}/">', html)
        self.assertIn("quiz e solver di calcio", html.lower())
        self.assertIn('id="abouttext">Due modi di giocare', html)

    def test_sitemap_lists_the_canonical_homepage(self):
        root = ET.parse(SITE / "sitemap.xml").getroot()
        namespace = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}

        self.assertEqual(
            [node.text for node in root.findall("sm:url/sm:loc", namespace)],
            [f"{ORIGIN}/"],
        )

    def test_robots_file_allows_crawling_and_advertises_sitemap(self):
        robots = (SITE / "robots.txt").read_text()

        self.assertIn("User-agent: *\nAllow: /", robots)
        self.assertIn(f"Sitemap: {ORIGIN}/sitemap.xml", robots)


if __name__ == "__main__":
    unittest.main()
