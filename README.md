# God's Eye — OSINT situational awareness

A single-screen "god's eye view" of the world built only from **public, keyless
open-source intelligence feeds**. It combines live air traffic, orbital objects,
seismic activity, disaster alerts, natural hazards, weather, space weather and
global news on one map. It also has an infrastructure-recon workbench, a
dossier for any clicked location, and the full
[OSINT Framework](https://osintframework.com) catalogue of about 1,165 tools, which you can search and filter.

```
python3 server.py            # live feeds  → http://127.0.0.1:8080
python3 server.py --demo     # synthetic sample data, works fully offline
```

It needs only Python 3.9+ and a browser. There is nothing to install and no API keys. Leaflet and
satellite.js load from jsDelivr. Don't open `web/index.html` directly as a file: browsers block its
scripts. Use the server, or one of the hosted options below.

## Putting it online

The site runs in one of two modes, and picks the right one automatically:

| Mode | When | How data is fetched |
|---|---|---|
| **Server** | `server.py` is running | The server fetches every source, with caching and no browser restrictions. Most complete. |
| **Serverless** | Hosted as static files (GitHub Pages, Netlify, …) | The browser calls each source directly. The top bar shows "serverless". A source that blocks cross-site requests (CORS) shows as *offline* in Feed health; everything else keeps working. |

**Free static hosting on GitHub Pages (serverless):**
1. Merge this branch into `main`.
2. In the repo, go to **Settings → Pages → Build and deployment** and set **Source** to **GitHub Actions**.
3. The *Deploy to GitHub Pages* workflow publishes `web/` to `https://<user>.github.io/<repo>/`.

**Full server version (Docker; works on Render, Railway, Fly.io, Cloud Run, a VPS):**
```
docker build -t gods-eye . && docker run -p 8080:8080 gods-eye
```
- **Render:** New → Blueprint → select this repo (it reads `render.yaml`).
- **Railway / Heroku:** they use the `Procfile`.
- The server reads the `PORT` environment variable and binds to `0.0.0.0` when it is set.

## What's on the map

| Layer | Source | Refresh | OSINT technique |
|---|---|---|---|
| Aircraft | [OpenSky Network](https://opensky-network.org) ADS-B state vectors | 20 s | ADS-B / SIGINT-adjacent tracking; altitude-coloured, **emergency squawks 7500/7600/7700** raised as red alerts |
| Satellites | [CelesTrak](https://celestrak.org) TLEs (stations, brightest, GPS, weather) | propagated every 2 s | Orbital tracking with SGP4; click one for its ground track (−45/+95 min) |
| Earthquakes | [USGS](https://earthquake.usgs.gov) all-day GeoJSON | 60 s | Seismic monitoring; size = magnitude, tsunami flag |
| Disaster alerts | [GDACS](https://www.gdacs.org) | 10 min | Cyclones, floods, volcanoes, droughts, wildfires, with alert level |
| Natural events | [NASA EONET](https://eonet.gsfc.nasa.gov) | 10 min | Wildfires, storms (with tracks), ice, volcanoes |
| Weather radar | [RainViewer](https://www.rainviewer.com/api.html) | 5 min | Precipitation overlay (off by default) |
| Day/night | computed locally | 1 min | Solar terminator |
| Recon targets | results of the Recon tab | on demand | Geolocated infrastructure |

The top bar shows totals and the planetary **Kp index** from [NOAA SWPC](https://www.swpc.noaa.gov).
The basemap can be switched between dark, Esri satellite imagery and OSM streets.

## Panels

- **Events**: one timeline that merges quakes, GDACS, EONET and emergency squawks, ranked by severity. Click an event to fly to it.
- **News**: [GDELT](https://www.gdeltproject.org) full-text search over the last 24 h of global media in 65+ languages.
- **Recon**: enter a domain or public IP.
  - Domain → DNS (A/AAAA/CNAME/MX/NS/TXT via Google DoH), subdomains from certificate transparency ([crt.sh](https://crt.sh)), RDAP registration, and A records geolocated onto the map.
  - IP → geolocation and ASN ([ipwho.is](https://ipwho.is)), reverse DNS, RDAP network block.
  - Both include pivot links to Shodan, Censys, urlscan, VirusTotal, Wayback, AbuseIPDB and bgp.he.net.
- **Dossier**: click anywhere on the map. It shows:
  - reverse-geocoded address ([Nominatim](https://nominatim.org))
  - solar time and sun elevation
  - aircraft within 150 km and satellites nearby
  - tracked events within 500 km
  - Wikipedia-documented places within 10 km
  - one-click links to Google, Bing, Sentinel Hub, Zoom Earth, OSM and Mapillary imagery

### OSINT Framework toolkit

Open it with the **⌘ OSINT Framework** button in the top bar, or press `T`. It contains every tool from
[osintframework.com](https://osintframework.com) (33 categories), bundled locally so it works offline:

- **Target box.** Paste a selector and the categories that accept it are picked automatically.
  - Recognised types: email, domain, URL, IPv4/IPv6, MAC, phone, username, Bitcoin/Ethereum address,
    file hash, image URL, `lat, lon`, aircraft/ship registration.
  - Clicking a tool copies the target to your clipboard and opens the tool.
- **Search.** Matches words against tool names, descriptions, inputs and outputs.
- **Filters:**
  - Free
  - Passive OPSEC (doesn't touch or notify the target)
  - No signup
  - Web-based
  - Has API
  - Hide down/deprecated
- **Category tree** with live counts. Each card shows status, pricing, OPSEC notes and flags
  (local tool, Google dork, registration required, edit URL manually).
- Recon results and location dossiers have buttons that jump into the relevant toolkit category with the target pre-filled.

To refresh the bundled list from upstream, run `python3 tools/update_osint_framework.py`.
OSINT Framework is MIT-licensed by Justin Nordine. Its licence is in `web/data/OSINT-FRAMEWORK-LICENSE`.

The **Search** box accepts `lat, lon`, an aircraft callsign or ICAO24 hex, or a satellite name or NORAD ID.

## Architecture

```
server.py        stdlib HTTP server: static files + /api proxy with TTL cache
demo_data.py     synthetic fixtures for --demo (regenerated at startup)
web/index.html   layout
web/js/main.js   map, layer scheduling, events/news/dossier/search
web/js/layers.js one object per data layer (load / tick / popups)
web/js/recon.js  domain & IP recon panel
web/js/sun.js    solar position + terminator polygon
web/js/toolkit.js OSINT Framework browser (search, filters, selector detection)
web/data/        bundled OSINT Framework catalogue + licence
tools/update_osint_framework.py  regenerate web/data/osint-framework.json
web/js/direct.js serverless mode: the /api routes implemented in the browser
tests/           python -m unittest discover -s tests (also run by .github/workflows/ci.yml)
```

The browser only talks to `server.py`. The server fetches from a **fixed
allowlist** of upstream URLs (`FEEDS` in `server.py`), so it cannot be used as an
open proxy. Recon inputs are validated: domains must be syntactically valid, and IPs must be globally
routable, which rejects private, loopback and link-local ranges. Responses are cached for each feed's
TTL, so several open tabs don't hammer the upstream providers.

## Notes and limits

- OpenSky's anonymous API is rate-limited (about 400 requests/day, 10 s resolution). The 15 s server cache keeps one tab
  inside the rate limit. For heavier use, register and add credentials to the request in `fetch()`.
- crt.sh can be slow for large domains. Its lookup has a 40 s timeout, and the rest of the recon still returns.
- Please respect each provider's terms of use and rate limits. Nominatim, for example, allows about 1 request/s.
- The live map and recon panels cover world events and internet infrastructure. The OSINT Framework
  toolkit links out to third-party services; it runs no queries itself. Follow each service's terms
  and the laws that apply to you.

## Ideas for extension

- AIS ship tracking (e.g. aisstream.io; needs a free key and a server-side websocket)
- NASA FIRMS active-fire hotspots (free map key)
- Public webcam overlay (Windy webcams API)
- Historical playback: store feed snapshots and scrub a timeline
