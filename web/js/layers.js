import { api, esc, table, ago, fmt, link } from "./util.js";
import { nightPolygon } from "./sun.js";

const EMERGENCY_SQUAWKS = { "7500": "Hijack", "7600": "Radio failure", "7700": "Emergency" };
const GDACS_TYPES = { EQ: "Earthquake", TC: "Tropical cyclone", FL: "Flood", VO: "Volcano", DR: "Drought", WF: "Wildfire", TS: "Tsunami" };
const EONET_COLORS = { wildfires: "#ff7a45", severeStorms: "#b18cff", volcanoes: "#ff3d3d", seaLakeIce: "#9be7ff", floods: "#3d8bff", earthquakes: "#ffd166", drought: "#c9a26b", dustHaze: "#d6c6a0", landslides: "#a67c52", snow: "#ffffff", tempExtremes: "#ff4fa3", manmade: "#cccccc", waterColor: "#34c3b2" };

/**
 * Every layer shares one shape:
 *   id, name, color, interval (ms between reloads, 0 = once), on (default visibility),
 *   group (Leaflet layer), load() -> Promise<count>, tick() (optional fast update)
 */
export function createLayers(map, state) {
  const canvas = L.canvas({ padding: 0.3 });
  // Clicking a marker should open its popup, not also trigger the map's dossier click.
  L.Path.mergeOptions({ bubblingMouseEvents: false });
  const events = (source, list) => { state.events[source] = list; state.onEvents(); };

  // ---------------------------------------------------------------- aircraft
  const aircraft = {
    id: "aircraft", name: "Aircraft (ADS-B)", color: "#ffe066", interval: 20000, on: true,
    group: L.layerGroup(),
    async load() {
      const data = await api("feed/aircraft");
      this.group.clearLayers();
      const planes = [];
      const alerts = [];
      for (const s of data.states || []) {
        const [icao24, callsign, country, , lastContact, lon, lat, baroAlt, onGround, velocity, track, vrate, , geoAlt, squawk] = s;
        if (lat == null || lon == null) continue;
        const p = { icao24, callsign: (callsign || "").trim(), country, lat, lon, alt: geoAlt ?? baroAlt, onGround, velocity, track, vrate, squawk, lastContact };
        planes.push(p);
        const emergency = EMERGENCY_SQUAWKS[squawk];
        p.marker = L.circleMarker([lat, lon], {
          renderer: canvas, radius: emergency ? 6 : 2.2, stroke: !!emergency, color: "#ff5566",
          fillColor: emergency ? "#ff5566" : altitudeColor(p.alt, onGround), fillOpacity: 0.9, weight: 2,
        }).bindPopup(() => planePopup(p)).addTo(this.group);
        if (emergency) {
          alerts.push({
            id: `sq-${icao24}`, source: "squawk", severity: "red", lat, lon,
            title: `SQUAWK ${squawk} (${emergency}) — ${p.callsign || icao24}`,
            time: new Date(lastContact * 1000).toISOString(), marker: p.marker,
          });
        }
      }
      state.aircraft = planes;
      events("squawk", alerts);
      return planes.length;
    },
  };

  // ---------------------------------------------------------------- earthquakes
  const quakes = {
    id: "quakes", name: "Earthquakes (USGS 24h)", color: "#ffd166", interval: 60000, on: true,
    group: L.layerGroup(),
    async load() {
      const data = await api("feed/quakes");
      this.group.clearLayers();
      const list = [];
      for (const f of data.features || []) {
        const [lon, lat, depth] = f.geometry.coordinates;
        const p = f.properties;
        const mag = p.mag ?? 0;
        const marker = L.circleMarker([lat, lon], {
          renderer: canvas, radius: Math.max(2, mag * 2.2), color: "#ffd166", weight: 1,
          fillColor: depth > 70 ? "#ff9f1c" : "#ffd166", fillOpacity: 0.35,
        }).bindPopup(() => `<b>M${fmt(mag, 1)} — ${esc(p.place)}</b>` + table([
          ["Time", `${new Date(p.time).toUTCString()} (${ago(p.time)})`],
          ["Depth", `${fmt(depth, 1)} km`],
          ["Tsunami", p.tsunami ? "<span class='error'>flag set</span>" : "no"],
          ["Alert", esc(p.alert || "none")],
          ["Felt reports", fmt(p.felt)],
          ["Source", link(p.url, "USGS event page")],
        ])).addTo(this.group);
        if (mag >= 2.5) {
          list.push({
            id: f.id, source: "quake", lat, lon, marker, url: p.url,
            severity: mag >= 6 ? "red" : mag >= 4.5 ? "orange" : "green",
            title: `M${fmt(mag, 1)} ${p.place}`, time: new Date(p.time).toISOString(),
          });
        }
      }
      state.quakes = (data.features || []).length;
      events("quake", list);
      return state.quakes;
    },
  };

  // ---------------------------------------------------------------- GDACS
  const gdacs = {
    id: "gdacs", name: "Disaster alerts (GDACS)", color: "#ff5566", interval: 600000, on: true,
    group: L.layerGroup(),
    async load() {
      const data = await api("feed/gdacs");
      this.group.clearLayers();
      const list = [];
      for (const f of data.features || []) {
        if (f.geometry?.type !== "Point") continue;
        const [lon, lat] = f.geometry.coordinates;
        const p = f.properties;
        const level = String(p.alertlevel || "green").toLowerCase();
        const color = { red: "#ff5566", orange: "#ffb347" }[level] || "#34e0a1";
        const type = GDACS_TYPES[p.eventtype] || p.eventtype;
        const url = p.url?.report || p.url?.details;
        const marker = L.circleMarker([lat, lon], {
          renderer: canvas, radius: 9, color, weight: 2, fillColor: color, fillOpacity: 0.25,
        }).bindPopup(() => `<b>${esc(type)}: ${esc(p.name || p.eventname)}</b>` + table([
          ["Alert level", `<span class="sev-${esc(level)}">${esc(p.alertlevel)}</span>`],
          ["Country", esc(p.country)],
          ["From", esc(p.fromdate)], ["To", esc(p.todate)],
          ["Severity", esc(p.severitydata?.severitytext)],
          ["Report", url ? link(url, "GDACS report") : ""],
        ])).addTo(this.group);
        list.push({
          id: `gdacs-${p.eventtype}-${p.eventid}`, source: "gdacs", lat, lon, marker, url, severity: level,
          title: `${type}: ${p.name || p.eventname || p.country}`, time: p.fromdate,
        });
      }
      events("gdacs", list);
      return list.length;
    },
  };

  // ---------------------------------------------------------------- NASA EONET
  const eonet = {
    id: "eonet", name: "Natural events (NASA EONET)", color: "#ff7a45", interval: 600000, on: true,
    group: L.layerGroup(),
    async load() {
      const data = await api("feed/eonet");
      this.group.clearLayers();
      const list = [];
      for (const e of data.events || []) {
        const g = e.geometry?.[e.geometry.length - 1];
        if (!g) continue;
        let [lon, lat] = g.coordinates;
        if (g.type === "Polygon") [lon, lat] = g.coordinates[0][0];
        const cat = e.categories?.[0] || {};
        const color = EONET_COLORS[cat.id] || "#ff7a45";
        const marker = L.circleMarker([lat, lon], {
          renderer: canvas, radius: 5, color, weight: 1, fillColor: color, fillOpacity: 0.7,
        }).bindPopup(() => `<b>${esc(e.title)}</b>` + table([
          ["Category", esc(cat.title)],
          ["Last seen", `${esc(g.date)} (${ago(g.date)})`],
          ["Track points", e.geometry.length],
          ["Sources", (e.sources || []).map((s) => link(s.url, s.id)).join(" ")],
        ])).addTo(this.group);
        // Draw storm tracks / multi-point events as lines.
        if (e.geometry.length > 1 && e.geometry.every((x) => x.type === "Point")) {
          L.polyline(e.geometry.map((x) => [x.coordinates[1], x.coordinates[0]]), { renderer: canvas, color, weight: 1, opacity: 0.6 }).addTo(this.group);
        }
        list.push({ id: e.id, source: "eonet", lat, lon, marker, severity: "orange", title: `${cat.title}: ${e.title}`, time: g.date });
      }
      events("eonet", list);
      return list.length;
    },
  };

  // ---------------------------------------------------------------- satellites
  const satellites = {
    id: "satellites", name: "Satellites (CelesTrak)", color: "#5cb8ff", interval: 6 * 3600000, on: true,
    group: L.layerGroup(), track: L.layerGroup(), sats: [],
    async load() {
      if (!window.satellite) throw new Error("satellite.js not loaded");
      const groups = ["stations", "visual", "gps", "weather"];
      const texts = await Promise.allSettled(groups.map((g) => api(`feed/sats-${g}`)));
      const byId = new Map();
      texts.forEach((r, i) => {
        if (r.status !== "fulfilled") return;
        for (const sat of parseTle(r.value.text || "")) {
          if (!byId.has(sat.id)) byId.set(sat.id, { ...sat, group: groups[i] });
        }
      });
      if (!byId.size) throw new Error("no TLEs available");
      this.group.clearLayers();
      this.sats = [...byId.values()];
      for (const s of this.sats) {
        const iss = s.id === "25544";
        s.marker = L.circleMarker([0, 0], {
          renderer: canvas, radius: iss ? 5 : 2.5, weight: iss ? 2 : 0, color: "#fff",
          fillColor: s.group === "gps" ? "#a0e8ff" : s.group === "stations" ? "#ffffff" : "#5cb8ff", fillOpacity: 0.95,
        }).bindPopup(() => satPopup(s)).on("click", () => this.showTrack(s)).addTo(this.group);
        if (iss) s.marker.bindTooltip("ISS", { permanent: true, direction: "right", className: "sat-label", offset: [6, 0] });
      }
      state.sats = this.sats;
      this.tick();
      return this.sats.length;
    },
    tick() {
      const now = new Date();
      for (const s of this.sats) {
        const pos = propagate(s.satrec, now);
        s.pos = pos;
        if (pos) s.marker.setLatLng([pos.lat, pos.lon]);
      }
    },
    showTrack(s) {
      this.track.clearLayers();
      const pts = [];
      const now = Date.now();
      for (let m = -45; m <= 95; m += 1) {
        const p = propagate(s.satrec, new Date(now + m * 60000));
        if (p) pts.push([p.lat, p.lon]);
      }
      for (const seg of splitAntimeridian(pts)) {
        L.polyline(seg, { color: "#5cb8ff", weight: 1.5, dashArray: "4 4", opacity: 0.8 }).addTo(this.track);
      }
      this.track.addTo(map);
    },
  };

  // ---------------------------------------------------------------- radar
  const radar = {
    id: "radar", name: "Weather radar (RainViewer)", color: "#3d8bff", interval: 300000, on: false,
    group: L.layerGroup(),
    async load() {
      const data = await api("feed/radar");
      const frame = data.radar?.past?.at(-1);
      if (!frame) throw new Error("no radar frames");
      this.group.clearLayers();
      L.tileLayer(`${data.host}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`, {
        opacity: 0.6, maxNativeZoom: 7, attribution: "Radar © RainViewer",
      }).addTo(this.group);
      return 1;
    },
  };

  // ---------------------------------------------------------------- day / night
  const night = {
    id: "night", name: "Day / night terminator", color: "#1b2a4a", interval: 60000, on: true,
    group: L.layerGroup(),
    async load() {
      this.group.clearLayers();
      L.polygon(nightPolygon(), { color: "#000", weight: 0, fillColor: "#000814", fillOpacity: 0.35, interactive: false }).addTo(this.group);
      return null;
    },
  };

  // ---------------------------------------------------------------- recon hosts
  const recon = {
    id: "recon", name: "Recon targets", color: "#ff4fa3", interval: 0, on: true,
    group: L.layerGroup(),
    async load() { return this.group.getLayers().length; },
  };

  return [aircraft, satellites, quakes, gdacs, eonet, radar, night, recon];
}

// ---------------------------------------------------------------- helpers

function altitudeColor(alt, onGround) {
  if (onGround || alt == null) return "#8a8a8a";
  const t = Math.min(1, Math.max(0, alt / 12500));
  return `hsl(${Math.round(50 - t * 50 + t * 250)}, 90%, ${60 - t * 10}%)`;
}

function planePopup(p) {
  const squawk = EMERGENCY_SQUAWKS[p.squawk] ? `<span class="error">${esc(p.squawk)} — ${EMERGENCY_SQUAWKS[p.squawk]}</span>` : esc(p.squawk);
  return `<b>✈ ${esc(p.callsign || "(no callsign)")}</b>` + table([
    ["ICAO24", esc(p.icao24)],
    ["Registered", esc(p.country)],
    ["Altitude", p.onGround ? "on ground" : `${fmt(p.alt)} m (${fmt(p.alt * 3.28084)} ft)`],
    ["Speed", `${fmt(p.velocity * 3.6)} km/h`],
    ["Heading", `${fmt(p.track)}°`],
    ["Vertical", `${fmt(p.vrate, 1)} m/s`],
    ["Squawk", squawk],
    ["Last contact", ago(p.lastContact * 1000)],
    ["Track", link(`https://globe.adsbexchange.com/?icao=${encodeURIComponent(p.icao24)}`, "ADS-B Exchange") + " · " +
      link(`https://opensky-network.org/aircraft-profile?icao24=${encodeURIComponent(p.icao24)}`, "OpenSky")],
  ]);
}

function satPopup(s) {
  const p = s.pos || {};
  return `<b>🛰 ${esc(s.name)}</b>` + table([
    ["NORAD ID", esc(s.id)],
    ["Group", esc(s.group)],
    ["Altitude", `${fmt(p.height)} km`],
    ["Velocity", `${fmt(p.speed, 2)} km/s`],
    ["Position", `${fmt(p.lat, 3)}, ${fmt(p.lon, 3)}`],
    ["More", link(`https://www.n2yo.com/satellite/?s=${encodeURIComponent(s.id)}`, "N2YO") + " · " +
      link(`https://celestrak.org/satcat/table-satcat.php?CATNR=${encodeURIComponent(s.id)}`, "SATCAT")],
  ]) + `<span class="hint">Ground track shown for −45 / +95 min.</span>`;
}

export function parseTle(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
  const out = [];
  for (let i = 0; i + 2 < lines.length; ) {
    if (lines[i + 1]?.startsWith("1 ") && lines[i + 2]?.startsWith("2 ")) {
      try {
        const satrec = window.satellite.twoline2satrec(lines[i + 1], lines[i + 2]);
        out.push({ name: lines[i].trim(), id: String(parseInt(lines[i + 1].slice(2, 7), 10)), satrec });
      } catch { /* skip malformed element set */ }
      i += 3;
    } else {
      i += 1;
    }
  }
  return out;
}

function propagate(satrec, date) {
  const sat = window.satellite;
  const pv = sat.propagate(satrec, date);
  if (!pv || !pv.position) return null;
  const gd = sat.eciToGeodetic(pv.position, sat.gstime(date));
  const v = pv.velocity;
  return {
    lat: sat.degreesLat(gd.latitude),
    lon: sat.degreesLong(gd.longitude),
    height: gd.height,
    speed: Math.hypot(v.x, v.y, v.z),
  };
}

function splitAntimeridian(points) {
  const segs = [[]];
  for (let i = 0; i < points.length; i++) {
    if (i && Math.abs(points[i][1] - points[i - 1][1]) > 180) segs.push([]);
    segs.at(-1).push(points[i]);
  }
  return segs.filter((s) => s.length > 1);
}
