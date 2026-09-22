"""Synthetic sample data for `server.py --demo`.

Generated at startup so timestamps are always fresh. Shapes mirror the real
upstream APIs closely enough for the UI to exercise every code path, but the
content is invented — nothing here describes real aircraft, events or hosts.
"""

from __future__ import annotations

import math
import random
from datetime import datetime, timedelta, timezone

AIRPORTS = [
    (51.47, -0.45), (40.64, -73.78), (25.25, 55.36), (1.36, 103.99), (35.55, 139.78),
    (49.01, 2.55), (33.94, -118.41), (-33.94, 151.18), (19.09, 72.87), (-23.43, -46.47),
    (50.03, 8.56), (41.98, -87.90), (22.31, 113.91), (55.97, 37.41), (-26.14, 28.24),
    (37.46, 126.44), (43.68, -79.63), (28.56, 77.10), (30.12, 31.41), (6.58, 3.32),
]
AIRLINES = ["BAW", "DLH", "UAE", "SIA", "AAL", "DAL", "AFR", "QFA", "JAL", "KLM", "THY", "QTR", "ANA", "UAL"]
COUNTRIES = ["United Kingdom", "Germany", "United Arab Emirates", "Singapore", "United States", "France", "Australia", "Japan", "Netherlands", "Turkey", "Qatar"]


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _gdacs_date(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%S")


def aircraft(rng: random.Random, now: datetime) -> dict:
    ts = int(now.timestamp())
    states = []
    for i in range(1800):
        a, b = rng.sample(AIRPORTS, 2)
        t = rng.random()
        lat = a[0] + (b[0] - a[0]) * t + rng.gauss(0, 0.8)
        lon = a[1] + (b[1] - a[1]) * t + rng.gauss(0, 0.8)
        track = (math.degrees(math.atan2(b[1] - a[1], b[0] - a[0])) + 360) % 360
        on_ground = t < 0.02 or t > 0.98
        alt = 0.0 if on_ground else min(12500.0, 300 + 40000 * min(t, 1 - t) + rng.gauss(0, 300))
        callsign = f"{rng.choice(AIRLINES)}{rng.randint(1, 999)}"
        squawk = f"{rng.randint(0o1000, 0o7477):04o}"  # octal, never an emergency code
        states.append([f"{0x400000 + i:06x}", callsign.ljust(8), rng.choice(COUNTRIES), ts - 2, ts - 1,
                       round(lon, 4), round(lat, 4), round(alt, 1), on_ground, round(rng.uniform(180, 260), 1),
                       round(track, 1), round(rng.gauss(0, 2), 2), None, round(alt + 50, 1), squawk, False, 0])
    # One aircraft squawking 7700 so the emergency path is visible.
    states[0][1], states[0][5], states[0][6], states[0][14] = "DEMO77  ", -30.5, 52.1, "7700"
    return {"time": ts, "states": states}


def quakes(rng: random.Random, now: datetime) -> dict:
    belts = [(38, 142), (-6, 105), (36, 70), (-33, -71), (61, -150), (15, -92), (38, 22), (-20, -175), (13, 122)]
    feats = []
    for i in range(140):
        lat, lon = rng.choice(belts)
        mag = round(min(7.4, rng.expovariate(1.1) + 1.0), 1)
        t = now - timedelta(minutes=rng.randint(1, 1440))
        feats.append({
            "type": "Feature", "id": f"demo{i:04d}",
            "properties": {"mag": mag, "place": f"{rng.randint(5, 180)} km of demo fault zone {i % 9 + 1}",
                           "time": int(t.timestamp() * 1000), "url": "https://earthquake.usgs.gov/earthquakes/map/",
                           "tsunami": int(mag >= 7), "alert": "orange" if mag >= 6.5 else None, "felt": rng.randint(0, 400)},
            "geometry": {"type": "Point", "coordinates": [round(lon + rng.gauss(0, 3), 3), round(lat + rng.gauss(0, 3), 3), round(rng.uniform(5, 300), 1)]},
        })
    return {"type": "FeatureCollection", "features": feats}


def gdacs(now: datetime) -> dict:
    rows = [
        ("TC", "Red", "DEMO-CYCLONE", "Philippines", 14.5, 128.0),
        ("FL", "Orange", "Demo flood", "Bangladesh", 23.8, 90.4),
        ("VO", "Orange", "Demo volcano", "Indonesia", -7.5, 110.4),
        ("WF", "Green", "Demo wildfire", "Canada", 55.0, -115.0),
        ("DR", "Orange", "Demo drought", "Kenya", 1.0, 38.0),
        ("EQ", "Green", "Demo quake", "Chile", -30.0, -71.5),
    ]
    feats = []
    for i, (typ, level, name, country, lat, lon) in enumerate(rows):
        feats.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [lon, lat]}, "properties": {
            "eventtype": typ, "eventid": 1000 + i, "alertlevel": level, "name": name, "country": country,
            "fromdate": _gdacs_date(now - timedelta(hours=6 + i * 11)), "todate": _gdacs_date(now),
            "severitydata": {"severitytext": f"{level} alert (demo)"}, "url": {"report": "https://www.gdacs.org/"}}})
    return {"type": "FeatureCollection", "features": feats}


def eonet(now: datetime) -> dict:
    def ev(i, cat, title, pts):
        return {"id": f"EONET_DEMO_{i}", "title": title, "categories": [{"id": cat, "title": cat}],
                "sources": [{"id": "DEMO", "url": "https://eonet.gsfc.nasa.gov/"}],
                "geometry": [{"date": _iso(now - timedelta(hours=6 * (len(pts) - k))), "type": "Point", "coordinates": [lon, lat]}
                             for k, (lat, lon) in enumerate(pts)]}
    return {"events": [
        ev(1, "severeStorms", "Demo Tropical Storm", [(12.0 + k * 0.9, -45.0 - k * 1.8) for k in range(10)]),
        ev(2, "wildfires", "Demo Wildfire, California", [(38.5, -121.9)]),
        ev(3, "wildfires", "Demo Wildfire, Portugal", [(39.7, -8.1)]),
        ev(4, "volcanoes", "Demo Volcano, Iceland", [(63.9, -22.3)]),
        ev(5, "seaLakeIce", "Demo Iceberg A99", [(-70.5, -40.0)]),
    ]}


def kp(now: datetime) -> list:
    rows = [["time_tag", "Kp", "a_running", "station_count"]]
    for k in range(8, 0, -1):
        rows.append([(now - timedelta(hours=3 * k)).strftime("%Y-%m-%d %H:%M:%S.000"), f"{2 + (k % 4) * 0.67:.2f}", "12", "8"])
    return rows


def _tle_checksum(line: str) -> str:
    return str(sum(int(c) if c.isdigit() else 1 if c == "-" else 0 for c in line) % 10)


def tle(name: str, norad: int, now: datetime, incl: float, raan: float, mm: float, ma: float) -> str:
    year = now.year % 100
    day = now.timetuple().tm_yday + (now.hour * 3600 + now.minute * 60) / 86400
    l1 = f"1 {norad:05d}U 00000A   {year:02d}{day:012.8f}  .00000000  00000-0  00000-0 0  999"
    l2 = f"2 {norad:05d} {incl:8.4f} {raan:8.4f} 0001000   0.0000 {ma:8.4f} {mm:11.8f}    1"
    return f"{name}\n{l1}{_tle_checksum(l1)}\n{l2}{_tle_checksum(l2)}\n"


def satellites(now: datetime) -> dict[str, str]:
    stations = tle("ISS (ZARYA)", 25544, now, 51.64, 120.0, 15.50, 10.0) + tle("CSS (TIANHE)", 48274, now, 41.47, 200.0, 15.60, 190.0)
    visual = "".join(tle(f"DEMO-SAT {i}", 90000 + i, now, 45 + i * 4.5, i * 37 % 360, 14.2 + (i % 6) * 0.2, i * 29 % 360) for i in range(24))
    gps = "".join(tle(f"GPS DEMO (PRN {i + 1:02d})", 91000 + i, now, 55.0, (i // 4) * 60.0, 2.00565, (i % 4) * 90.0) for i in range(24))
    weather = "".join(tle(f"WX DEMO {i}", 92000 + i, now, 98.7, i * 45.0, 14.12, i * 80 % 360) for i in range(6))
    return {"sats-stations": stations, "sats-visual": visual, "sats-gps": gps, "sats-weather": weather}


def news(now: datetime) -> dict:
    heads = ["Demo: cyclone makes landfall", "Demo: flood warnings extended", "Demo: volcano ash advisory issued",
             "Demo: wildfire containment improves", "Demo: aftershock sequence continues", "Demo: drought relief funding approved"]
    return {"articles": [{"url": "https://example.com/", "title": h, "domain": "example.com", "language": "English",
                          "sourcecountry": "Demo", "seendate": (now - timedelta(minutes=17 * i)).strftime("%Y%m%dT%H%M%SZ")}
                         for i, h in enumerate(heads)]}


def build() -> dict:
    now = datetime.now(timezone.utc)
    rng = random.Random(42)
    data = {
        "feed/aircraft": aircraft(rng, now),
        "feed/quakes": quakes(rng, now),
        "feed/gdacs": gdacs(now),
        "feed/eonet": eonet(now),
        "feed/kp": kp(now),
        "feed/radar": {"host": "", "radar": {"past": []}},
        "news": news(now),
        "place": {"lat": 0, "lon": 0, "address": {"display_name": "Demo mode — reverse geocoding is disabled"},
                  "wiki": [{"pageid": 1, "title": "Demo place", "dist": 420}]},
        "recon/domain": {
            "domain": "example.com",
            "dns": {"A": ["93.184.215.14"], "AAAA": ["2606:2800:21f:cb07:6820:80da:af6b:8b2c"], "CNAME": [],
                    "MX": ["0 ."], "NS": ["a.iana-servers.net.", "b.iana-servers.net."], "TXT": ["\"v=spf1 -all\""]},
            "subdomains": ["dev.example.com", "mail.example.com", "www.example.com"],
            "rdap": {"handle": "DEMO", "name": "EXAMPLE.COM", "status": ["client delete prohibited"],
                     "events": {"registration": "1995-08-14T04:00:00Z", "expiration": "2030-08-13T04:00:00Z"},
                     "entities": [{"roles": ["registrar"], "name": "Demo Registrar"}], "nameservers": [], "country": None, "range": None},
        },
        "recon/ip": {"ip": "93.184.215.14", "ptr": [],
                     "geo": {"success": True, "city": "Demo City", "region": "Demo", "country": "Demo", "latitude": 42.15, "longitude": -70.82,
                             "connection": {"asn": 64496, "org": "Demo Network (documentation ASN)", "isp": "Demo ISP"}, "timezone": {"id": "UTC"}},
                     "rdap": {"handle": "DEMO-NET", "name": "DEMO", "range": ["93.184.215.0", "93.184.215.255"], "country": "US",
                              "status": [], "events": {}, "entities": [], "nameservers": []}},
    }
    for name, text in satellites(now).items():
        data[f"feed/{name}"] = {"text": text}
    return data
