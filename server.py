#!/usr/bin/env python3
"""God's Eye — OSINT situational-awareness server.

Serves the web UI from ./web and exposes a small JSON API that proxies a fixed
allowlist of public, keyless OSINT sources (with a TTL cache so many browser
tabs don't hammer upstream providers). Standard library only.

    python3 server.py              # live data on http://127.0.0.1:8080
    python3 server.py --demo       # bundled sample data, no network needed
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import mimetypes
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WEB_DIR = ROOT / "web"
USER_AGENT = "GodsEye-OSINT/1.0 (+https://github.com/astroficboy/osint)"


@dataclass(frozen=True)
class Feed:
    url: str
    ttl: int  # seconds
    kind: str = "json"  # "json" or "text"


CELESTRAK = "https://celestrak.org/NORAD/elements/gp.php?FORMAT=tle&GROUP="

# Static, keyless feeds. The browser only ever names a key from this table,
# so the server can never be pointed at an arbitrary URL.
FEEDS: dict[str, Feed] = {
    "aircraft": Feed("https://opensky-network.org/api/states/all", 15),
    "quakes": Feed("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson", 60),
    "eonet": Feed("https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=30", 600),
    "gdacs": Feed("https://www.gdacs.org/gdacsapi/api/events/geteventlist/MAP", 600),
    "kp": Feed("https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json", 600),
    "radar": Feed("https://api.rainviewer.com/public/weather-maps.json", 300),
    "sats-stations": Feed(CELESTRAK + "stations", 6 * 3600, "text"),
    "sats-visual": Feed(CELESTRAK + "visual", 6 * 3600, "text"),
    "sats-gps": Feed(CELESTRAK + "gps-ops", 6 * 3600, "text"),
    "sats-weather": Feed(CELESTRAK + "weather", 6 * 3600, "text"),
}

DOMAIN_RE = re.compile(r"^(?=.{1,253}$)(?!-)[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})+$")
DNS_TYPES = ("A", "AAAA", "CNAME", "MX", "NS", "TXT")


class UpstreamError(Exception):
    pass


class Cache:
    def __init__(self) -> None:
        self._data: dict[str, tuple[float, object]] = {}
        self._lock = threading.Lock()

    def get(self, key: str, ttl: int):
        with self._lock:
            hit = self._data.get(key)
        if hit and time.time() - hit[0] < ttl:
            return hit[1]
        return None

    def put(self, key: str, value: object) -> None:
        with self._lock:
            self._data[key] = (time.time(), value)


CACHE = Cache()
POOL = ThreadPoolExecutor(max_workers=8)


def fetch(url: str, ttl: int, kind: str = "json", timeout: float = 20):
    cached = CACHE.get(url, ttl)
    if cached is not None:
        return cached
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "*/*"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise UpstreamError(f"{urllib.parse.urlsplit(url).netloc}: {exc}") from exc
    text = raw.decode("utf-8", errors="replace")
    try:
        value = json.loads(text) if kind == "json" else text
    except json.JSONDecodeError as exc:
        raise UpstreamError(f"{urllib.parse.urlsplit(url).netloc}: invalid JSON") from exc
    CACHE.put(url, value)
    return value


def gather(jobs: dict[str, tuple]) -> dict:
    """Run several fetches concurrently; failures become {"error": ...}."""
    futures = {name: POOL.submit(fetch, *args) for name, args in jobs.items()}
    out = {}
    for name, fut in futures.items():
        try:
            out[name] = fut.result()
        except UpstreamError as exc:
            out[name] = {"error": str(exc)}
    return out


# --- parameter validation -------------------------------------------------

def valid_domain(value: str) -> str:
    value = value.strip().lower().rstrip(".")
    if value.startswith(("http://", "https://")):
        value = urllib.parse.urlsplit(value).hostname or ""
    if not DOMAIN_RE.match(value):
        raise ValueError("invalid domain name")
    return value


def valid_ip(value: str) -> str:
    addr = ipaddress.ip_address(value.strip())
    if not addr.is_global:
        raise ValueError("only public IP addresses can be looked up")
    return str(addr)


def valid_coord(lat: str, lon: str) -> tuple[float, float]:
    la, lo = float(lat), float(lon)
    if not (-90 <= la <= 90 and -180 <= lo <= 180):
        raise ValueError("coordinates out of range")
    return round(la, 5), round(lo, 5)


def q(value: str) -> str:
    return urllib.parse.quote(value, safe="")


# --- composite endpoints --------------------------------------------------

def recon_domain(name: str) -> dict:
    jobs = {f"dns_{t}": (f"https://dns.google/resolve?name={q(name)}&type={t}", 300) for t in DNS_TYPES}
    jobs["rdap"] = (f"https://rdap.org/domain/{q(name)}", 3600)
    jobs["crtsh"] = (f"https://crt.sh/?q={q('%.' + name)}&output=json", 3600, "json", 40)
    raw = gather(jobs)

    dns = {}
    for t in DNS_TYPES:
        res = raw[f"dns_{t}"]
        dns[t] = [a.get("data") for a in res.get("Answer", [])] if "error" not in res else res
    crt = raw["crtsh"]
    if isinstance(crt, list):
        names = set()
        for row in crt:
            for n in str(row.get("name_value", "")).split("\n"):
                n = n.strip().lower().lstrip("*.")
                if n == name or n.endswith("." + name):
                    names.add(n)
        subdomains = sorted(names)
    else:
        subdomains = crt
    return {"domain": name, "dns": dns, "subdomains": subdomains, "rdap": summarize_rdap(raw["rdap"])}


def summarize_rdap(rdap: dict) -> dict:
    if not isinstance(rdap, dict) or "error" in rdap:
        return rdap
    events = {e.get("eventAction"): e.get("eventDate") for e in rdap.get("events", [])}
    entities = []
    for ent in rdap.get("entities", []):
        label = ent.get("handle", "")
        for item in (ent.get("vcardArray") or [None, []])[1]:
            if item and item[0] == "fn":
                label = item[3]
        entities.append({"roles": ent.get("roles", []), "name": label})
    return {
        "handle": rdap.get("handle"),
        "name": rdap.get("ldhName") or rdap.get("name"),
        "status": rdap.get("status", []),
        "events": events,
        "entities": entities,
        "nameservers": [ns.get("ldhName") for ns in rdap.get("nameservers", [])],
        "country": rdap.get("country"),
        "range": [rdap.get("startAddress"), rdap.get("endAddress")] if rdap.get("startAddress") else None,
    }


def recon_ip(addr: str) -> dict:
    raw = gather({
        "geo": (f"https://ipwho.is/{q(addr)}", 3600),
        "rdap": (f"https://rdap.org/ip/{q(addr)}", 3600),
        "ptr": (f"https://dns.google/resolve?name={q(reverse_name(addr))}&type=PTR", 3600),
    })
    ptr = raw["ptr"]
    return {
        "ip": addr,
        "geo": raw["geo"],
        "rdap": summarize_rdap(raw["rdap"]),
        "ptr": [a.get("data") for a in ptr.get("Answer", [])] if "error" not in ptr else ptr,
    }


def reverse_name(addr: str) -> str:
    return ipaddress.ip_address(addr).reverse_pointer


def place(lat: float, lon: float) -> dict:
    raw = gather({
        "address": (f"https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&lat={lat}&lon={lon}", 86400),
        "wiki": ("https://en.wikipedia.org/w/api.php?action=query&list=geosearch&format=json"
                 f"&gsradius=10000&gslimit=12&gscoord={lat}%7C{lon}", 86400),
    })
    wiki = raw["wiki"]
    return {
        "lat": lat,
        "lon": lon,
        "address": raw["address"],
        "wiki": wiki.get("query", {}).get("geosearch", []) if "error" not in wiki else wiki,
    }


def news(query: str) -> dict:
    query = query.strip()[:200] or "(conflict OR protest OR disaster OR attack)"
    url = ("https://api.gdeltproject.org/api/v2/doc/doc?mode=artlist&format=json&sort=datedesc"
           f"&maxrecords=60&timespan=24h&query={q(query)}")
    return fetch(url, 300)


# --- HTTP layer -----------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "GodsEye/1.0"
    demo = False

    def log_message(self, fmt, *args):  # quieter default logging
        if not self.path.startswith("/api/feed/"):
            super().log_message(fmt, *args)

    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        params = {k: v[0] for k, v in urllib.parse.parse_qs(url.query).items()}
        if url.path.startswith("/api/"):
            self.handle_api(url.path[len("/api/"):], params)
        else:
            self.serve_static(url.path)

    def handle_api(self, route: str, p: dict):
        try:
            if self.demo:
                data = demo_response(route, p)
                status = HTTPStatus.NOT_FOUND if data == {"error": "not found"} else HTTPStatus.OK
                return self.send_json(data, status)
            if route.startswith("feed/"):
                feed = FEEDS.get(route[len("feed/"):])
                if not feed:
                    return self.send_json({"error": "unknown feed"}, HTTPStatus.NOT_FOUND)
                data = fetch(feed.url, feed.ttl, feed.kind)
                return self.send_json({"text": data} if feed.kind == "text" else data)
            if route == "news":
                return self.send_json(news(p.get("q", "")))
            if route == "place":
                return self.send_json(place(*valid_coord(p.get("lat", ""), p.get("lon", ""))))
            if route == "recon/domain":
                return self.send_json(recon_domain(valid_domain(p.get("name", ""))))
            if route == "recon/ip":
                return self.send_json(recon_ip(valid_ip(p.get("addr", ""))))
            if route == "feeds":
                return self.send_json({"feeds": sorted(FEEDS), "demo": self.demo})
            self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)
        except ValueError as exc:
            self.send_json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        except UpstreamError as exc:
            self.send_json({"error": str(exc)}, HTTPStatus.BAD_GATEWAY)

    def serve_static(self, path: str):
        rel = urllib.parse.unquote(path).lstrip("/") or "index.html"
        target = (WEB_DIR / rel).resolve()
        if not target.is_relative_to(WEB_DIR) or not target.is_file():
            return self.send_json({"error": "not found"}, HTTPStatus.NOT_FOUND)
        body = target.read_bytes()
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, obj, status=HTTPStatus.OK):
        body = json.dumps(obj, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


DEMO_DATA: dict = {}


def demo_response(route: str, p: dict):
    """Serve synthetic sample data so the UI works fully offline."""
    if route == "feeds":
        return {"feeds": sorted(FEEDS), "demo": True}
    return DEMO_DATA.get(route, {"error": "not found"})


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    # Hosting platforms (Render, Railway, Fly, Heroku, Cloud Run) pass PORT and expect 0.0.0.0.
    env_port = os.environ.get("PORT")
    ap.add_argument("--host", default=os.environ.get("HOST", "0.0.0.0" if env_port else "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(env_port or 8080))
    ap.add_argument("--demo", action="store_true", help="serve bundled sample data instead of live feeds")
    args = ap.parse_args()
    Handler.demo = args.demo
    if args.demo:
        import demo_data
        DEMO_DATA.update(demo_data.build())
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.daemon_threads = True
    mode = "DEMO (sample data)" if args.demo else "LIVE"
    print(f"God's Eye [{mode}] → http://{args.host}:{args.port}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
