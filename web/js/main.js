import { api, apiMode, esc, table, ago, fmt, link, distanceKm, toolkitButton } from "./util.js";
import { createLayers } from "./layers.js";
import { sunElevation } from "./sun.js";
import { initRecon } from "./recon.js";
import { initToolkit } from "./toolkit.js";

const $ = (sel) => document.querySelector(sel);

const map = L.map("map", { worldCopyJump: true, zoomControl: false, minZoom: 2 }).setView([25, 10], 3);
L.control.zoom({ position: "bottomleft" }).addTo(map);
L.control.scale({ position: "bottomleft", imperial: false }).addTo(map);
const basemaps = {
  Dark: L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    subdomains: "abcd", maxZoom: 19, attribution: "© OpenStreetMap contributors © CARTO",
  }),
  Satellite: L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 19, attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
  }),
  Streets: L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: "© OpenStreetMap contributors",
  }),
};
basemaps.Dark.addTo(map);
L.control.layers(basemaps, null, { position: "bottomleft" }).addTo(map);

const state = {
  aircraft: [], sats: [], quakes: 0, events: {}, health: {},
  onEvents: () => renderEvents(),
};

// ------------------------------------------------------------------ layers
const layers = createLayers(map, state);
const byId = Object.fromEntries(layers.map((l) => [l.id, l]));

function renderLayerPanel() {
  $("#layer-list").innerHTML = layers.map((l) => `
    <label class="layer">
      <input type="checkbox" data-layer="${l.id}" ${l.on ? "checked" : ""}>
      <span class="swatch" style="background:${l.color}"></span>
      <span class="name">${esc(l.name)}</span>
      <span class="count" id="count-${l.id}"></span>
    </label>`).join("");
  $("#layer-list").addEventListener("change", (e) => {
    const l = byId[e.target.dataset.layer];
    if (!l) return;
    l.on = e.target.checked;
    if (l.on) { l.group.addTo(map); refresh(l); } else { map.removeLayer(l.group); l.track && map.removeLayer(l.track); }
  });
}

async function refresh(l) {
  if (l.busy) return;
  l.busy = true;
  try {
    const n = await l.load();
    state.health[l.id] = { ok: true, at: Date.now() };
    if (n != null) $(`#count-${l.id}`).textContent = fmt(n);
  } catch (err) {
    state.health[l.id] = { ok: false, at: Date.now(), error: err.message };
    $(`#count-${l.id}`).innerHTML = `<span class="err" title="${esc(err.message)}">offline</span>`;
  } finally {
    l.busy = false;
    renderHealth();
    renderStats();
  }
}

function renderHealth() {
  $("#feed-health").innerHTML = "<h2>Feed health</h2>" + layers.filter((l) => state.health[l.id]).map((l) => {
    const h = state.health[l.id];
    const cls = h.ok ? "ok" : "err";
    return `<div title="${esc(h.error || "")}"><span>${esc(l.id)}</span><span class="${cls}">${h.ok ? "● " + ago(h.at) : "● error"}</span></div>`;
  }).join("");
}

for (const l of layers) {
  if (l.on) { l.group.addTo(map); refresh(l); }
  if (l.interval) setInterval(() => l.on && refresh(l), l.interval);
}
setInterval(() => byId.satellites.on && byId.satellites.tick(), 2000);
setInterval(renderHealth, 15000);
renderLayerPanel();

// ------------------------------------------------------------------ top bar
let kp = null;
async function loadKp() {
  try {
    const rows = await api("feed/kp");
    const last = rows.at(-1);
    kp = Number(Array.isArray(last) ? last[1] : last.Kp ?? last.kp_index ?? last.kp);
  } catch { kp = null; }
  renderStats();
}
loadKp();
setInterval(loadKp, 600000);

function renderStats() {
  const ev = Object.values(state.events).flat();
  const red = ev.filter((e) => e.severity === "red").length;
  const airborne = state.aircraft.filter((a) => !a.onGround).length;
  const kpClass = kp >= 7 ? "err" : kp >= 5 ? "stale" : "ok";
  $("#stats").innerHTML = [
    `<span class="stat">Aircraft <b>${fmt(airborne)}</b> airborne</span>`,
    `<span class="stat">Satellites <b>${fmt(state.sats.length)}</b></span>`,
    `<span class="stat">Quakes 24h <b>${fmt(state.quakes)}</b></span>`,
    `<span class="stat">Events <b>${fmt(ev.length)}</b></span>`,
    `<span class="stat">Red alerts <b class="${red ? "err" : ""}">${fmt(red)}</b></span>`,
    `<span class="stat">Geomagnetic Kp <b class="${kpClass}">${kp == null || isNaN(kp) ? "–" : kp.toFixed(1)}</b></span>`,
  ].join("");
}

setInterval(() => { $("#utc").textContent = new Date().toISOString().slice(11, 19); }, 1000);

// ------------------------------------------------------------------ tabs
function showTab(name) {
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === `tab-${name}`));
}
document.querySelector(".tabs").addEventListener("click", (e) => e.target.dataset.tab && showTab(e.target.dataset.tab));

// ------------------------------------------------------------------ events feed
function renderEvents() {
  const filter = $("#event-filter").value;
  const list = Object.values(state.events).flat()
    .filter((e) => filter === "all" || e.source === filter)
    .sort((a, b) => sevRank(b) - sevRank(a) || new Date(b.time) - new Date(a.time))
    .slice(0, 300);
  $("#event-list").innerHTML = list.length ? list.map((e, i) => `
    <li data-i="${i}">
      <div>${esc(e.title)}</div>
      <div class="meta"><span class="tag sev-${esc(e.severity)}">${esc(e.source)}</span><span>${esc(ago(e.time))}</span></div>
    </li>`).join("") : `<li class="hint">No events.</li>`;
  $("#event-list").onclick = (ev) => {
    const li = ev.target.closest("li[data-i]");
    if (!li) return;
    const e = list[li.dataset.i];
    map.flyTo([e.lat, e.lon], Math.max(map.getZoom(), 6));
    if (e.marker) setTimeout(() => e.marker.openPopup(), 600);
  };
  renderStats();
}
const sevRank = (e) => ({ red: 3, orange: 2, green: 1 })[e.severity] || 0;
$("#event-filter").addEventListener("change", renderEvents);

// ------------------------------------------------------------------ news (GDELT)
async function loadNews(q = "") {
  const out = $("#news-list");
  out.innerHTML = `<li class="loading">Querying GDELT</li>`;
  try {
    const data = await api(`news?q=${encodeURIComponent(q)}`);
    const arts = data.articles || [];
    out.innerHTML = arts.length ? arts.map((a) => `
      <li><a href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${esc(a.title)}</a>
      <div class="meta"><span>${esc(a.domain)}</span><span>${esc(a.sourcecountry)}</span><span>${esc(a.language)}</span><span>${esc(gdeltAgo(a.seendate))}</span></div></li>`).join("")
      : `<li class="hint">No articles in the last 24h.</li>`;
  } catch (err) {
    out.innerHTML = `<li class="error">${esc(err.message)}</li>`;
  }
}
const gdeltAgo = (s) => (s ? ago(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`) : "");
$("#news-form").addEventListener("submit", (e) => { e.preventDefault(); loadNews($("#news-q").value); });
loadNews();

// ------------------------------------------------------------------ recon
initRecon({ map, layer: byId.recon, showTab });

// ------------------------------------------------------------------ OSINT Framework toolkit
const toolkit = initToolkit();
$("#toolkit-btn").addEventListener("click", () => toolkit.open());
// Any element with data-toolkit="<category>" (and optional data-target) opens the toolkit there.
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-toolkit]");
  if (el) toolkit.open({ category: el.dataset.toolkit || null, target: el.dataset.target ?? "" });
});
document.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() === "t" && !e.ctrlKey && !e.metaKey && !e.altKey && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) {
    e.preventDefault();
    toolkit.open();
  }
});

// ------------------------------------------------------------------ dossier
const pin = L.marker([0, 0], { opacity: 0.9 });
map.on("click", (e) => dossier(e.latlng.lat, e.latlng.lng));

async function dossier(lat, lon) {
  lon = ((((lon + 180) % 360) + 360) % 360) - 180;
  pin.setLatLng([lat, lon]).addTo(map);
  showTab("dossier");
  const out = $("#dossier-out");
  const elev = sunElevation(lat, lon);
  const solarOffset = Math.round(lon / 15);
  const solarTime = new Date(Date.now() + solarOffset * 3600000).toISOString().slice(11, 16);
  const near = (list, km) => list.map((x) => ({ ...x, d: distanceKm(lat, lon, x.lat, x.lon) })).filter((x) => x.d <= km).sort((a, b) => a.d - b.d);
  const planes = near(state.aircraft, 150);
  const evs = near(Object.values(state.events).flat(), 500);
  const overhead = near(state.sats.filter((s) => s.pos).map((s) => ({ ...s, lat: s.pos.lat, lon: s.pos.lon })), 2000);

  const local = table([
    ["Coordinates", `${lat.toFixed(5)}, ${lon.toFixed(5)}`],
    ["Solar time", `${solarTime} (UTC${solarOffset >= 0 ? "+" : ""}${solarOffset})`],
    ["Sun", `${elev.toFixed(1)}° — ${elev > 0 ? "daylight" : elev > -6 ? "civil twilight" : elev > -18 ? "twilight" : "night"}`],
    ["Aircraft ≤150 km", `${planes.length}${planes.length ? ": " + planes.slice(0, 6).map((p) => esc(p.callsign || p.icao24)).join(", ") : ""}`],
    ["Satellites ≤2000 km ground dist.", `${overhead.length}${overhead.length ? ": " + overhead.slice(0, 4).map((s) => esc(s.name)).join(", ") : ""}`],
    ["Imagery", [
      link(`https://www.google.com/maps/@${lat},${lon},2000m/data=!3m1!1e3`, "Google"),
      link(`https://www.bing.com/maps?cp=${lat}~${lon}&lvl=16&style=a`, "Bing"),
      link(`https://apps.sentinel-hub.com/eo-browser/?zoom=12&lat=${lat}&lng=${lon}`, "Sentinel"),
      link(`https://zoom.earth/maps/satellite/#view=${lat},${lon},10z`, "Zoom Earth"),
      link(`https://www.openstreetmap.org/#map=15/${lat}/${lon}`, "OSM"),
      link(`https://www.mapillary.com/app/?lat=${lat}&lng=${lon}&z=15`, "Mapillary"),
    ].join(" · ")],
    ["More tools", toolkitButton("Geolocation Tools / Maps", `${lat.toFixed(5)}, ${lon.toFixed(5)}`, "Geolocation tools")],
  ]);
  const evHtml = evs.length ? `<ol class="list">${evs.slice(0, 10).map((e) => `<li><div>${esc(e.title)}</div><div class="meta"><span class="tag sev-${esc(e.severity)}">${esc(e.source)}</span><span>${fmt(e.d)} km</span><span>${esc(ago(e.time))}</span></div></li>`).join("")}</ol>` : `<p class="hint">No tracked events within 500 km.</p>`;
  out.innerHTML = `<h2>Location</h2>${local}<h2>Address</h2><p class="loading">Reverse geocoding</p><h2>Events ≤500 km</h2>${evHtml}<h2>Documented places (Wikipedia ≤10 km)</h2><p class="loading">Searching</p>`;

  try {
    const d = await api(`place?lat=${lat.toFixed(5)}&lon=${lon.toFixed(5)}`);
    const addr = d.address?.error ? `<p class="error">${esc(d.address.error)}</p>` : `<p>${esc(d.address?.display_name || "Unknown (open ocean?)")}</p>`;
    const wiki = Array.isArray(d.wiki) && d.wiki.length
      ? `<ol class="list">${d.wiki.map((w) => `<li>${link(`https://en.wikipedia.org/?curid=${w.pageid}`, w.title)}<div class="meta"><span>${fmt(w.dist)} m</span></div></li>`).join("")}</ol>`
      : `<p class="hint">${d.wiki?.error ? esc(d.wiki.error) : "Nothing nearby."}</p>`;
    const loaders = out.querySelectorAll(".loading");
    loaders[0].outerHTML = addr;
    loaders[1].outerHTML = wiki;
  } catch (err) {
    out.querySelectorAll(".loading").forEach((n) => { n.outerHTML = `<p class="error">${esc(err.message)}</p>`; });
  }
}

// ------------------------------------------------------------------ search / goto
$("#goto-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("#goto").value.trim();
  const m = q.match(/^(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)$/);
  if (m) {
    map.flyTo([+m[1], +m[2]], 10);
    return dossier(+m[1], +m[2]);
  }
  const needle = q.toUpperCase();
  const plane = state.aircraft.find((p) => p.callsign.toUpperCase() === needle || p.icao24.toUpperCase() === needle)
    || state.aircraft.find((p) => p.callsign.toUpperCase().startsWith(needle));
  const sat = !plane && state.sats.find((s) => s.name.toUpperCase().includes(needle) || s.id === q);
  const hit = plane ? plane.marker : sat ? sat.marker : null;
  if (!hit) { $("#goto").setCustomValidity("No aircraft or satellite matches"); $("#goto").reportValidity(); return; }
  $("#goto").setCustomValidity("");
  map.flyTo(hit.getLatLng(), plane ? 9 : 4);
  setTimeout(() => { hit.openPopup(); if (sat) byId.satellites.showTrack(sat); }, 700);
});
$("#goto").addEventListener("input", () => $("#goto").setCustomValidity(""));

apiMode().then((m) => {
  const label = { demo: " · DEMO DATA", direct: " · serverless" }[m];
  if (label) $(".brand small").textContent += label;
  if (m === "demo") document.title += " [DEMO]";
  if (m === "direct") $(".brand small").title = "No server.py detected: data is fetched straight from each source. A few sources may block this (CORS); run server.py for full coverage.";
});
