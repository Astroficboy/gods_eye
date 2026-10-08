// Serverless mode: the same /api routes as server.py, implemented in the browser
// against CORS-enabled public endpoints. Used automatically when the page is
// hosted statically (GitHub Pages, Netlify, …) and no server.py is present.

const CELESTRAK = "https://celestrak.org/NORAD/elements/gp.php?FORMAT=tle&GROUP=";
const FEEDS = {
  quakes: ["https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson", 60],
  eonet: ["https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=30", 600],
  gdacs: ["https://www.gdacs.org/gdacsapi/api/events/geteventlist/MAP", 600],
  kp: ["https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json", 600],
  radar: ["https://api.rainviewer.com/public/weather-maps.json", 300],
  "sats-stations": [CELESTRAK + "stations", 21600, "text"],
  "sats-visual": [CELESTRAK + "visual", 21600, "text"],
  "sats-gps": [CELESTRAK + "gps-ops", 21600, "text"],
  "sats-weather": [CELESTRAK + "weather", 21600, "text"],
};
const DNS_TYPES = ["A", "AAAA", "CNAME", "MX", "NS", "TXT"];
const DOMAIN_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/;

// Cache in memory and sessionStorage, so reloads and tabs don't re-hit rate-limited APIs.
const memo = new Map();
async function fetchCached(url, ttl, kind = "json", timeout = 25000) {
  const now = Date.now();
  const hit = memo.get(url) || readStore(url);
  if (hit && now - hit.at < ttl * 1000) return hit.value;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  let res;
  try {
    res = await fetch(url, { signal: ctl.signal });
  } catch (err) {
    throw new Error(`${new URL(url).host}: ${err.name === "AbortError" ? "timed out" : "unreachable (network or CORS)"}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`${new URL(url).host}: HTTP ${res.status}`);
  const value = kind === "json" ? await res.json() : await res.text();
  memo.set(url, { at: now, value });
  writeStore(url, { at: now, value });
  return value;
}
function readStore(url) {
  try { return JSON.parse(sessionStorage.getItem(`ge:${url}`)); } catch { return null; }
}
function writeStore(url, entry) {
  try { sessionStorage.setItem(`ge:${url}`, JSON.stringify(entry)); } catch { /* quota: memory cache is enough */ }
}

async function settle(jobs) {
  const names = Object.keys(jobs);
  const results = await Promise.allSettled(names.map((n) => fetchCached(...jobs[n])));
  return Object.fromEntries(names.map((n, i) => [n, results[i].status === "fulfilled" ? results[i].value : { error: results[i].reason.message }]));
}

const enc = encodeURIComponent;

function validDomain(v) {
  v = String(v || "").trim().toLowerCase().replace(/\.$/, "");
  if (/^https?:\/\//.test(v)) { try { v = new URL(v).hostname; } catch { v = ""; } }
  if (!DOMAIN_RE.test(v)) throw new Error("invalid domain name");
  return v;
}

function validIp(v) {
  v = String(v || "").trim();
  const m = v.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [+m[1], +m[2]];
    if (m.slice(1).some((x) => +x > 255)) throw new Error("invalid IP address");
    const priv = a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
    if (priv) throw new Error("only public IP addresses can be looked up");
    return v;
  }
  if (/^[0-9a-f:]+$/i.test(v) && v.includes(":")) {
    if (/^(::1?|fe[89ab]|f[cd])/i.test(v)) throw new Error("only public IP addresses can be looked up");
    return v.toLowerCase();
  }
  throw new Error("invalid IP address");
}

function reversePointer(ip) {
  if (ip.includes(".")) return ip.split(".").reverse().join(".") + ".in-addr.arpa";
  const [head, tail = ""] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = [...h, ...Array(8 - h.length - t.length).fill("0"), ...t].map((g) => g.padStart(4, "0"));
  return groups.join("").split("").reverse().join(".") + ".ip6.arpa";
}

export function summarizeRdap(r) {
  if (!r || typeof r !== "object" || r.error) return r;
  const events = Object.fromEntries((r.events || []).map((e) => [e.eventAction, e.eventDate]));
  const entities = (r.entities || []).map((ent) => {
    let name = ent.handle || "";
    for (const item of ent.vcardArray?.[1] || []) if (item?.[0] === "fn") name = item[3];
    return { roles: ent.roles || [], name };
  });
  return {
    handle: r.handle, name: r.ldhName || r.name, status: r.status || [], events, entities,
    nameservers: (r.nameservers || []).map((n) => n.ldhName), country: r.country,
    range: r.startAddress ? [r.startAddress, r.endAddress] : null,
  };
}

const answers = (res) => (res.error ? res : (res.Answer || []).map((a) => a.data));

async function reconDomain(name) {
  const jobs = Object.fromEntries(DNS_TYPES.map((t) => [`dns_${t}`, [`https://dns.google/resolve?name=${enc(name)}&type=${t}`, 300]]));
  jobs.rdap = [`https://rdap.org/domain/${enc(name)}`, 3600];
  jobs.crtsh = [`https://crt.sh/?q=${enc("%." + name)}&output=json`, 3600, "json", 45000];
  const raw = await settle(jobs);
  const dns = Object.fromEntries(DNS_TYPES.map((t) => [t, answers(raw[`dns_${t}`])]));
  let subdomains = raw.crtsh;
  if (Array.isArray(subdomains)) {
    const names = new Set();
    for (const row of subdomains) {
      for (let n of String(row.name_value || "").split("\n")) {
        n = n.trim().toLowerCase().replace(/^\*\./, "");
        if (n === name || n.endsWith("." + name)) names.add(n);
      }
    }
    subdomains = [...names].sort();
  }
  return { domain: name, dns, subdomains, rdap: summarizeRdap(raw.rdap) };
}

async function reconIp(ip) {
  const raw = await settle({
    geo: [`https://ipwho.is/${enc(ip)}`, 3600],
    rdap: [`https://rdap.org/ip/${enc(ip)}`, 3600],
    ptr: [`https://dns.google/resolve?name=${enc(reversePointer(ip))}&type=PTR`, 3600],
  });
  return { ip, geo: raw.geo, rdap: summarizeRdap(raw.rdap), ptr: answers(raw.ptr) };
}

async function place(lat, lon) {
  lat = Number(lat); lon = Number(lon);
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) throw new Error("coordinates out of range");
  const raw = await settle({
    address: [`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&lat=${lat}&lon=${lon}`, 86400],
    wiki: [`https://en.wikipedia.org/w/api.php?action=query&list=geosearch&format=json&origin=*&gsradius=10000&gslimit=12&gscoord=${lat}%7C${lon}`, 86400],
  });
  return { lat, lon, address: raw.address, wiki: raw.wiki.error ? raw.wiki : raw.wiki.query?.geosearch || [] };
}

function news(q) {
  q = String(q || "").trim().slice(0, 200) || "(conflict OR protest OR disaster OR attack)";
  return fetchCached(`https://api.gdeltproject.org/api/v2/doc/doc?mode=artlist&format=json&sort=datedesc&maxrecords=60&timespan=24h&query=${enc(q)}`, 300);
}

// ---------------------------------------------------------------- aircraft
// OpenSky gives a global picture but rate-limits anonymous users hard (and may
// block browser requests). When it fails, fall back to community ADS-B
// aggregators that serve a 250 nm radius around a point, in readsb format.
const OPENSKY = "https://opensky-network.org/api/states/all";
const REGIONAL = [
  ["adsb.lol", (lat, lon) => `https://api.adsb.lol/v2/point/${lat}/${lon}/250`],
  ["airplanes.live", (lat, lon) => `https://api.airplanes.live/v2/point/${lat}/${lon}/250`],
  ["adsb.fi", (lat, lon) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/250`],
];
let openskyRetryAt = 0;

/** Convert a readsb-style aircraft list to OpenSky's state-vector shape. */
export function readsbToStates(body) {
  const FT = 0.3048, KT = 0.514444, FPM = 0.00508;
  const states = [];
  for (const a of body.ac || body.aircraft || []) {
    if (a.lat == null || a.lon == null) continue;
    const ground = a.alt_baro === "ground";
    const baro = typeof a.alt_baro === "number" ? a.alt_baro * FT : null;
    const geom = typeof a.alt_geom === "number" ? a.alt_geom * FT : null;
    const seen = Math.round(Date.now() / 1000 - (a.seen_pos ?? a.seen ?? 0));
    const rate = a.baro_rate ?? a.geom_rate;
    states.push([
      String(a.hex || "").replace(/^~/, ""), a.flight || a.r || "", a.r || "", seen, seen,
      a.lon, a.lat, ground ? 0 : baro, ground, a.gs != null ? a.gs * KT : null, a.track ?? a.true_heading ?? null,
      rate != null ? rate * FPM : null, null, ground ? 0 : geom ?? baro, a.squawk ?? null, false, 0,
    ]);
  }
  return { time: Math.round(Date.now() / 1000), states };
}

export async function aircraft(lat, lon, fetcher = fetchCached) {
  const errors = [];
  if (Date.now() >= openskyRetryAt) {
    try {
      return { ...(await fetcher(OPENSKY, 60)), source: "OpenSky", scope: "global" };
    } catch (err) {
      errors.push(`OpenSky: ${err.message}`);
      openskyRetryAt = Date.now() + 10 * 60000; // don't burn the quota retrying every refresh
    }
  }
  lat = Math.round(Math.max(-85, Math.min(85, Number(lat) || 0)) * 10) / 10;
  lon = Math.round((((Number(lon) || 0) + 540) % 360 - 180) * 10) / 10;
  for (const [name, url] of REGIONAL) {
    try {
      return { ...readsbToStates(await fetcher(url(lat, lon), 15)), source: name, scope: "regional" };
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
    }
  }
  throw new Error(errors.join(" · "));
}

/** Handle an /api path (e.g. "recon/ip?addr=1.1.1.1") entirely in the browser. */
export async function direct(path) {
  const u = new URL(path, "http://x/");
  const route = u.pathname.slice(1);
  const p = Object.fromEntries(u.searchParams);
  if (route === "feeds") return { feeds: Object.keys(FEEDS).sort(), demo: false, mode: "direct" };
  if (route === "feed/aircraft") return aircraft(p.lat, p.lon);
  if (route.startsWith("feed/")) {
    const f = FEEDS[route.slice(5)];
    if (!f) throw new Error("unknown feed");
    const value = await fetchCached(...f);
    return f[2] === "text" ? { text: value } : value;
  }
  if (route === "news") return news(p.q);
  if (route === "place") return place(p.lat, p.lon);
  if (route === "recon/domain") return reconDomain(validDomain(p.name));
  if (route === "recon/ip") return reconIp(validIp(p.addr));
  throw new Error("not found");
}
