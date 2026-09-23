// Use server.py's /api when it's there; otherwise (static hosting) call the
// upstream sources straight from the browser via direct.js.
let mode = null;
export function apiMode() {
  mode ||= fetch("api/feeds")
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((b) => (Array.isArray(b.feeds) ? (b.demo ? "demo" : "server") : "direct"))
    .catch(() => "direct");
  return mode;
}

export async function api(path) {
  if ((await apiMode()) === "direct") {
    const { direct } = await import("./direct.js");
    return direct(path);
  }
  const res = await fetch(`api/${path}`);
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok || (body && body.error && Object.keys(body).length === 1)) {
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return body;
}

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

export function table(rows) {
  const body = rows
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`)
    .join("");
  return `<table class="kv">${body}</table>`;
}

export function ago(ts) {
  const s = Math.round((Date.now() - new Date(ts).getTime()) / 1000);
  if (!isFinite(s)) return "";
  if (s < 0) return "upcoming";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function distanceKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

export const fmt = (n, digits = 0) => (n == null || isNaN(n) ? "–" : Number(n).toLocaleString(undefined, { maximumFractionDigits: digits }));

export function link(href, text) {
  return `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(text ?? href)}</a>`;
}

/** A button that opens the OSINT Framework toolkit at a category, with a target prefilled. */
export function toolkitButton(category, target, label) {
  return `<button class="tk-launch small" data-toolkit="${esc(category)}" data-target="${esc(target)}">${esc(label)} in OSINT Framework →</button>`;
}
