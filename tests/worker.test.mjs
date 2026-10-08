// Tests for proxy/worker.js. Run: node --test tests/
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../proxy/worker.js";

const ORIGIN = "https://astroficboy.github.io";
let upstreamCalls;
let store;

beforeEach(() => {
  upstreamCalls = [];
  store = new Map();
  globalThis.caches = {
    default: {
      match: async (req) => store.get(req.url)?.clone(),
      put: async (req, res) => { store.set(req.url, res); },
    },
  };
  globalThis.fetch = async (url) => {
    upstreamCalls.push(url);
    if (url.includes("down.example")) throw new Error("boom");
    const status = url.includes("opensky") ? 429 : 200;
    return new Response(JSON.stringify({ ok: status === 200, url }), {
      status, headers: { "Content-Type": "application/json", "Set-Cookie": "x=1" },
    });
  };
});

const ctx = { waitUntil: (p) => p };
const call = (target, { origin = ORIGIN, method = "GET" } = {}) => worker.fetch(
  new Request(`https://proxy.test/?url=${encodeURIComponent(target)}`, { method, headers: origin ? { Origin: origin } : {} }),
  {}, ctx,
);

test("proxies an allowed host and adds CORS headers", async () => {
  const res = await call("https://api.adsb.lol/v2/point/51.5/-0.1/250");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), ORIGIN);
  assert.equal(res.headers.get("set-cookie"), null);
  assert.equal((await res.json()).url, "https://api.adsb.lol/v2/point/51.5/-0.1/250");
});

test("serves repeat requests from the edge cache", async () => {
  await call("https://crt.sh/?q=%25.example.com&output=json");
  const res = await call("https://crt.sh/?q=%25.example.com&output=json");
  assert.equal(res.status, 200);
  assert.equal(upstreamCalls.length, 1);
});

test("passes upstream errors through without caching them", async () => {
  const a = await call("https://opensky-network.org/api/states/all");
  await call("https://opensky-network.org/api/states/all");
  assert.equal(a.status, 429);
  assert.equal(a.headers.get("access-control-allow-origin"), ORIGIN);
  assert.equal(upstreamCalls.length, 2);
});

test("refuses hosts outside the allowlist, non-https and bad input", async () => {
  for (const url of ["https://evil.example/", "http://api.adsb.lol/", "https://api.adsb.lol.evil.example/", "not a url"]) {
    const res = await call(url);
    assert.ok([400, 403].includes(res.status), url);
  }
  assert.equal(upstreamCalls.length, 0);
});

test("refuses other origins and missing origins", async () => {
  assert.equal((await call("https://api.adsb.lol/", { origin: "https://evil.example" })).status, 403);
  assert.equal((await call("https://api.adsb.lol/", { origin: null })).status, 403);
  assert.equal(upstreamCalls.length, 0);
});

test("answers CORS preflight for allowed origins only", async () => {
  const ok = await call("https://api.adsb.lol/", { method: "OPTIONS" });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get("access-control-allow-origin"), ORIGIN);
  assert.equal((await call("https://api.adsb.lol/", { method: "OPTIONS", origin: "https://evil.example" })).status, 403);
});
