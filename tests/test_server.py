import json
import sys
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import demo_data  # noqa: E402
import server  # noqa: E402


class ValidationTests(unittest.TestCase):
    def test_domain_normalised(self):
        self.assertEqual(server.valid_domain(" Example.COM. "), "example.com")
        self.assertEqual(server.valid_domain("https://sub.example.org/path?x=1"), "sub.example.org")

    def test_domain_rejects_garbage(self):
        for bad in ["", "localhost", "-bad.com", "a b.com", "exa mple", "x" * 300 + ".com", "evil.com/../x"]:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                server.valid_domain(bad)

    def test_ip_only_public(self):
        self.assertEqual(server.valid_ip("8.8.8.8"), "8.8.8.8")
        self.assertEqual(server.valid_ip("2001:4860:4860::8888"), "2001:4860:4860::8888")
        for bad in ["127.0.0.1", "10.0.0.1", "192.168.1.1", "169.254.169.254", "::1", "not-an-ip"]:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                server.valid_ip(bad)

    def test_coords(self):
        self.assertEqual(server.valid_coord("51.5", "-0.12"), (51.5, -0.12))
        for lat, lon in [("91", "0"), ("0", "181"), ("nan", "0"), ("inf", "0"), ("x", "0")]:
            with self.subTest(lat=lat, lon=lon), self.assertRaises(ValueError):
                server.valid_coord(lat, lon)


class ReconTests(unittest.TestCase):
    def test_domain_recon_filters_ct_names_and_survives_failures(self):
        def fake_fetch(url, ttl, kind="json", timeout=20):
            if "crt.sh" in url:
                return [{"name_value": "www.example.com\n*.api.example.com"},
                        {"name_value": "notexample.com"}, {"name_value": "EXAMPLE.com"}]
            if "rdap" in url:
                raise server.UpstreamError("rdap.org: timed out")
            if "type=A&" in url or url.endswith("type=A"):
                return {"Answer": [{"data": "93.184.215.14"}]}
            return {}

        with mock.patch.object(server, "fetch", side_effect=fake_fetch):
            out = server.recon_domain("example.com")
        self.assertEqual(out["subdomains"], ["api.example.com", "example.com", "www.example.com"])
        self.assertEqual(out["dns"]["A"], ["93.184.215.14"])
        self.assertEqual(out["dns"]["MX"], [])
        self.assertIn("error", out["rdap"])

    def test_summarize_rdap(self):
        raw = {
            "handle": "NET-1", "startAddress": "1.0.0.0", "endAddress": "1.0.0.255", "country": "AU",
            "events": [{"eventAction": "registration", "eventDate": "2011-01-01"}],
            "entities": [{"handle": "ORG-1", "roles": ["registrant"], "vcardArray": ["vcard", [["fn", {}, "text", "APNIC Research"]]]}],
        }
        out = server.summarize_rdap(raw)
        self.assertEqual(out["range"], ["1.0.0.0", "1.0.0.255"])
        self.assertEqual(out["events"]["registration"], "2011-01-01")
        self.assertEqual(out["entities"], [{"roles": ["registrant"], "name": "APNIC Research"}])

    def test_fetch_caches(self):
        server.CACHE = server.Cache()
        resp = mock.MagicMock()
        resp.__enter__.return_value.read.return_value = b'{"ok": 1}'
        with mock.patch("urllib.request.urlopen", return_value=resp) as urlopen:
            self.assertEqual(server.fetch("https://x.test/a", 60), {"ok": 1})
            self.assertEqual(server.fetch("https://x.test/a", 60), {"ok": 1})
        self.assertEqual(urlopen.call_count, 1)


class HttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        server.DEMO_DATA.update(demo_data.build())
        handler = type("DemoHandler", (server.Handler,), {"demo": True, "log_message": lambda *a: None})
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        cls.base = f"http://127.0.0.1:{cls.httpd.server_address[1]}"
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()

    def get(self, path):
        try:
            with urllib.request.urlopen(self.base + path) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    def test_every_feed_has_demo_data(self):
        for name, feed in server.FEEDS.items():
            with self.subTest(feed=name):
                status, body = self.get(f"/api/feed/{name}")
                self.assertEqual(status, 200)
                data = json.loads(body)
                if feed.kind == "text":
                    self.assertIn("text", data)

    def test_demo_aircraft_has_one_emergency(self):
        _, body = self.get("/api/feed/aircraft")
        squawks = [s[14] for s in json.loads(body)["states"]]
        self.assertEqual([s for s in squawks if s in ("7500", "7600", "7700")], ["7700"])

    def test_demo_tles_are_well_formed(self):
        _, body = self.get("/api/feed/sats-stations")
        lines = json.loads(body)["text"].splitlines()
        self.assertEqual(lines[0], "ISS (ZARYA)")
        for line in lines[1:3]:
            self.assertEqual(len(line), 69)
            self.assertEqual(line[-1], demo_data._tle_checksum(line[:-1]))

    def test_static_and_traversal(self):
        status, body = self.get("/")
        self.assertEqual(status, 200)
        self.assertIn(b"God's Eye", body)
        for path in ["/../server.py", "/%2e%2e/server.py", "/js/../../server.py"]:
            with self.subTest(path=path):
                self.assertEqual(self.get(path)[0], 404)

    def test_unknown_routes_404(self):
        self.assertEqual(self.get("/api/nope")[0], 404)
        self.assertEqual(self.get("/api/feed/nope")[0], 404)


class OsintFrameworkDataTests(unittest.TestCase):
    def test_bundled_dataset_is_well_formed(self):
        path = Path(server.WEB_DIR) / "data" / "osint-framework.json"
        data = json.loads(path.read_text())
        tools = data["tools"]
        self.assertGreater(len(tools), 1000)
        cats = set(data["categories"])
        for t in tools:
            self.assertTrue(t["u"].startswith(("http://", "https://")), t)
            self.assertIn(t["c"][0], cats)
            self.assertTrue(t["n"])
            self.assertLessEqual(set(t.get("f", "")), set("TDRMAIX"))
        keys = [(t["n"], t["u"], tuple(t["c"])) for t in tools]
        self.assertEqual(len(keys), len(set(keys)))


if __name__ == "__main__":
    unittest.main()
