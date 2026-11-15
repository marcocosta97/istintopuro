import unittest
import importlib.util
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlparse


ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / "site"
ORIGIN = "https://istintopuro.mcosta.it"


class PageHead(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.meta = {}
        self.links = {}
        self.scripts = []
        self.base = ""
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "meta":
            self.meta[attrs.get("name") or attrs.get("property")] = attrs.get("content")
        elif tag == "link":
            self.links[attrs.get("rel")] = attrs.get("href")
        elif tag == "script" and "src" in attrs:
            self.scripts.append(attrs["src"])
        elif tag == "base":
            self.base = attrs["href"]


class SeoFilesTest(unittest.TestCase):
    def test_homepage_declares_canonical_url_and_static_about_copy(self):
        html = (SITE / "index.html").read_text()

        self.assertIn(f'<link rel="canonical" href="{ORIGIN}/">', html)
        self.assertIn("quiz di calcio giornaliero", html.lower())
        self.assertIn('id="abouttext">Due modi di giocare', html)

    def test_sitemap_lists_distinct_canonical_entry_points(self):
        root = ET.parse(SITE / "sitemap.xml").getroot()
        namespace = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}

        self.assertEqual(
            [node.text for node in root.findall("sm:url/sm:loc", namespace)],
            [f"{ORIGIN}/", f"{ORIGIN}/quiz/"],
        )

    def test_entry_points_have_consistent_metadata_and_resolvable_assets(self):
        for route in ["/", "/quiz/"]:
            with self.subTest(route=route):
                page = SITE / route.lstrip("/") / "index.html"
                html = page.read_text()
                head = PageHead(html)
                self.assertEqual(head.links["canonical"], ORIGIN + route)
                self.assertEqual(head.meta["og:url"], ORIGIN + route)
                self.assertEqual(head.meta["description"], head.meta["og:description"])
                self.assertEqual(head.meta["description"], head.meta["twitter:description"])
                self.assertEqual(head.meta["og:title"], head.meta["twitter:title"])
                self.assertEqual(head.meta["og:locale"], "it_IT")
                self.assertIn('id="intro-title">Chi ha giocato in entrambe?', html)
                base = urljoin(ORIGIN + route, head.base)
                for asset in [*head.scripts, head.links["stylesheet"], head.links["manifest"]]:
                    resolved = urlparse(urljoin(base, asset)).path
                    self.assertTrue((SITE / resolved.lstrip("/")).is_file(), asset)

    def test_quiz_entry_is_generated_from_homepage(self):
        spec = importlib.util.spec_from_file_location("site_pages", ROOT / "scripts/site-pages.py")
        generator = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(generator)
        quiz = (SITE / "quiz/index.html").read_text()
        self.assertEqual(quiz, generator.quiz_page((SITE / "index.html").read_text()))
        self.assertIn('data-entry="quiz"', quiz)
        self.assertIn('id="intro-play" href="quiz/"', quiz)
        self.assertIn('<dialog id="intro"', quiz)

    def test_release_stamps_both_entry_points_in_an_isolated_copy(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "scripts").mkdir()
            (root / "site").mkdir()
            script = root / "scripts/site-pages.py"
            script.write_text((ROOT / "scripts/site-pages.py").read_text())
            (root / "site/index.html").write_text((SITE / "index.html").read_text())
            subprocess.run([sys.executable, str(script)], check=True, capture_output=True)
            subprocess.run([sys.executable, str(script), "--check"], check=True, capture_output=True)
            subprocess.run([sys.executable, str(script), "--version", "release-123"],
                           check=True, capture_output=True)
            for page in [root / "site/index.html", root / "site/quiz/index.html"]:
                self.assertNotIn("__V__", page.read_text())
                self.assertIn("app.js?v=release-123", page.read_text())
            checked = subprocess.run([sys.executable, str(script), "--check"], capture_output=True, text=True)
            self.assertNotEqual(checked.returncode, 0)
            self.assertIn("Source HTML is already stamped", checked.stderr)

    def test_robots_file_allows_crawling_and_advertises_sitemap(self):
        robots = (SITE / "robots.txt").read_text()

        self.assertIn("User-agent: *\nAllow: /", robots)
        self.assertIn(f"Sitemap: {ORIGIN}/sitemap.xml", robots)


if __name__ == "__main__":
    unittest.main()
