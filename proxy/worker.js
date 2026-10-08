// God's Eye CORS proxy — a Cloudflare Worker (free plan is plenty).
//
// Some data sources refuse requests made from web pages (CORS). A static site
// such as GitHub Pages then can't read them. This Worker fetches those sources
// server-side and returns the data with the CORS header browsers need.
//
// It is NOT an open proxy. It only fetches hosts listed in ALLOWED_HOSTS, and only
// for pages served from ALLOWED_ORIGINS.
//
// Deploy: Cloudflare dashboard → Workers & Pages → Create → Create Worker →
// Deploy → Edit code → paste this file → Deploy. Then put the Worker's URL in
// web/config.js. See README "CORS proxy".

// Sites allowed to use this proxy. Add your own domain if you host elsewhere.
const ALLOWED_ORIGINS = [
  "https://astroficboy.github.io",
  "http://127.0.0.1:8080",
  "http://localhost:8080",
];

// Upstream hosts the site uses; anything else is refused.
const ALLOWED_HOSTS = new Set([
  "opensky-network.org", "api.adsb.lol", "api.airplanes.live", "opendata.adsb.fi",
  "earthquake.usgs.gov", "eonet.gsfc.nasa.gov", "www.gdacs.org", "services.swpc.noaa.gov",
  "api.rainviewer.com", "celestrak.org", "api.gdeltproject.org",
  "dns.google", "crt.sh", "rdap.org", "ipwho.is",
  "nominatim.openstreetmap.org", "en.wikipedia.org",
]);

// Seconds to cache responses at Cloudflare's edge, so many visitors share one upstream call.
const TTL = { "api.adsb.lol": 10, "api.airplanes.live": 10, "opendata.adsb.fi": 10, "opensky-network.org": 30 };
const DEFAULT_TTL = 120;

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function reply(status, message, origin) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json", ...(origin ? cors(origin) : {}) },
  });
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : null;
    if (request.method === "OPTIONS") {
      return allowed ? new Response(null, { status: 204, headers: cors(allowed) }) : reply(403, "origin not allowed");
    }
    if (request.method !== "GET") return reply(405, "GET only", allowed);
    if (!allowed) return reply(403, "origin not allowed");

    let target;
    try {
      target = new URL(new URL(request.url).searchParams.get("url") || "");
    } catch {
      return reply(400, "missing or invalid ?url=", allowed);
    }
    if (target.protocol !== "https:" || !ALLOWED_HOSTS.has(target.hostname)) {
      return reply(403, `host not allowed: ${target.hostname}`, allowed);
    }

    const cache = caches.default;
    const cacheKey = new Request(target.toString());
    let upstream = await cache.match(cacheKey);
    if (!upstream) {
      try {
        upstream = await fetch(target.toString(), {
          headers: { "User-Agent": "GodsEye-OSINT/1.0 (+https://github.com/astroficboy/gods_eye)", "Accept": "*/*" },
          redirect: "follow",
        });
      } catch (err) {
        return reply(502, `${target.hostname}: ${err.message}`, allowed);
      }
      if (upstream.ok) {
        const ttl = TTL[target.hostname] ?? DEFAULT_TTL;
        upstream = new Response(upstream.body, upstream);
        upstream.headers.set("Cache-Control", `public, max-age=${ttl}`);
        ctx.waitUntil(cache.put(cacheKey, upstream.clone()));
      }
    }

    const res = new Response(upstream.body, upstream);
    for (const [k, v] of Object.entries(cors(allowed))) res.headers.set(k, v);
    res.headers.delete("Set-Cookie");
    return res;
  },
};
