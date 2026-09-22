import { esc, fmt } from "./util.js";

// OSINT Framework (https://osintframework.com, MIT) as a searchable, filterable toolkit.
// Data: web/data/osint-framework.json, refreshed by tools/update_osint_framework.py.

const PAGE = 150;
const SEP = " › "; // category names themselves contain " / "
const FLAG_LABELS = {
  T: ["local tool", "Must be downloaded / installed and run locally"],
  D: ["dork", "Google dork — a crafted search-engine query"],
  R: ["registration", "Requires an account"],
  M: ["edit URL", "Put your search term into the URL manually"],
  A: ["API", "Has an API"],
  I: ["invite only", "Invitation required"],
  X: ["deprecated", "Marked deprecated upstream"],
};
const FILTERS = {
  free: { label: "Free", test: (t) => t.p === "free" || t.p === "free/freemium" },
  passive: { label: "Passive OPSEC", test: (t) => t.op === "passive", title: "Doesn't touch or notify the target" },
  noreg: { label: "No signup", test: (t) => !t.f?.includes("R") && !t.f?.includes("I") },
  web: { label: "Web-based", test: (t) => !t.f?.includes("T") },
  api: { label: "Has API", test: (t) => t.f?.includes("A") },
  live: { label: "Hide down", test: (t) => !["down", "defunct"].includes(t.s) && !t.f?.includes("X") },
};

// Selector type → categories that accept it.
const SELECTORS = [
  ["email", /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i, ["Email Address", "Username"]],
  ["IPv4", /^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/, ["IP & MAC Address", "Cyber Threat Intelligence"]],
  ["IPv6", /^[0-9a-f]{0,4}(:[0-9a-f]{0,4}){2,7}$/i, ["IP & MAC Address", "Cyber Threat Intelligence"]],
  ["MAC", /^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i, ["IP & MAC Address"]],
  ["coordinates", /^-?\d+(\.\d+)?\s*,\s*-?\d+(\.\d+)?$/, ["Geolocation Tools / Maps", "Transportation"]],
  ["image URL", /^https?:\/\/\S+\.(jpe?g|png|gif|webp|bmp|tiff?)(\?\S*)?$/i, ["Images / Videos / Docs", "Disinformation & Media Verification"]],
  ["URL", /^https?:\/\/\S+$/i, ["Domain Name", "Archives", "Documentation / Evidence Capture", "Malicious File Analysis"]],
  ["phone", /^\+?[\d\s().-]{7,20}$/, ["Telephone Numbers", "Instant Messaging"]],
  ["bitcoin", /^(bc1[a-z0-9]{25,60}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/, ["Blockchain & Cryptocurrency"]],
  ["ethereum", /^0x[0-9a-f]{40}$/i, ["Blockchain & Cryptocurrency"]],
  ["hash", /^([0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64})$/i, ["Malicious File Analysis", "Cyber Threat Intelligence"]],
  ["vehicle/aircraft", /^([A-Z]{1,2}-[A-Z0-9]{3,5}|N\d{1,5}[A-Z]{0,2}|IMO\s?\d{7}|MMSI\s?\d{9})$/i, ["Transportation"]],
  ["domain", /^(?!-)[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})+$/i, ["Domain Name", "Cloud Infrastructure", "Email Address"]],
  ["username", /^@?[\w.-]{2,40}$/, ["Username", "Social Networks", "Online Communities"]],
];

export function detectSelector(value) {
  const v = value.trim();
  if (!v) return null;
  for (const [type, re, cats] of SELECTORS) if (re.test(v)) return { type, cats };
  return { type: "keyword", cats: ["Search Engines", "Online Communities", "Archives"] };
}

const safeUrl = (u) => (/^https?:\/\//i.test(u) ? u : "#");

export function initToolkit() {
  const root = document.querySelector("#toolkit");
  const $ = (s) => root.querySelector(s);
  let data = null;
  let loading = null;
  const st = { q: "", cat: null, target: "", filters: new Set(["live"]), limit: PAGE, open: new Set() };

  async function load() {
    if (data) return data;
    loading ||= fetch("data/osint-framework.json").then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }).then((d) => {
      for (const t of d.tools) {
        t._key = t.c.join(SEP);
        t._hay = [t.n, t.d, t.b, t.i, t.o, t._key, t.u].filter(Boolean).join(" ").toLowerCase();
      }
      data = d;
      return d;
    });
    return loading;
  }

  function matches(t, { skipCat = false } = {}) {
    for (const f of st.filters) if (!FILTERS[f].test(t)) return false;
    if (!skipCat && st.cat && !(t._key === st.cat || t._key.startsWith(st.cat + SEP))) return false;
    if (!skipCat && !st.cat && st.sel && st.sel.type !== "keyword" && !st.sel.cats.includes(t.c[0])) return false;
    if (st.q) {
      for (const word of st.q.toLowerCase().split(/\s+/)) if (word && !t._hay.includes(word)) return false;
    }
    return true;
  }

  function renderTree() {
    // Counts respect search + filters but not the category selection itself.
    const counts = new Map();
    for (const t of data.tools) {
      if (!matches(t, { skipCat: true })) continue;
      for (let i = 1; i <= t.c.length; i++) {
        const k = t.c.slice(0, i).join(SEP);
        counts.set(k, (counts.get(k) || 0) + 1);
      }
    }
    const children = new Map();
    for (const t of data.tools) {
      for (let i = 1; i < t.c.length; i++) {
        const parent = t.c.slice(0, i).join(SEP);
        const k = t.c.slice(0, i + 1).join(SEP);
        if (!children.has(parent)) children.set(parent, new Set());
        children.get(parent).add(k);
      }
    }
    const hl = new Set(st.sel?.type !== "keyword" ? st.sel?.cats || [] : []);
    const node = (k, depth) => {
      const n = counts.get(k) || 0;
      const kids = [...(children.get(k) || [])];
      const open = st.open.has(k) || (st.cat && st.cat.startsWith(k + SEP));
      const label = k.split(SEP).at(-1);
      return `<li class="${n ? "" : "empty"}">
        <div class="tk-node ${st.cat === k ? "active" : ""} ${hl.has(k) ? "hl" : ""}" data-cat="${esc(k)}" style="padding-left:${depth * 12 + 4}px">
          <span class="tk-twisty" data-toggle="${esc(k)}">${kids.length ? (open ? "▾" : "▸") : ""}</span>
          <span class="tk-label">${esc(label)}</span><span class="tk-n">${n}</span>
        </div>
        ${kids.length && open ? `<ul>${kids.map((c) => node(c, depth + 1)).join("")}</ul>` : ""}
      </li>`;
    };
    const total = data.tools.filter((t) => matches(t, { skipCat: true })).length;
    $("#tk-tree").innerHTML = `<ul>
      <li><div class="tk-node ${st.cat ? "" : "active"}" data-cat=""><span class="tk-twisty"></span><span class="tk-label">All categories</span><span class="tk-n">${total}</span></div></li>
      ${data.categories.map((c) => node(c, 0)).join("")}</ul>`;
  }

  function badge(text, cls = "", title = "") {
    return `<span class="tk-badge ${cls}" ${title ? `title="${esc(title)}"` : ""}>${esc(text)}</span>`;
  }

  function card(t, i) {
    const b = [];
    if (t.s && t.s !== "live") b.push(badge(t.s, t.s === "degraded" ? "warn" : "bad"));
    if (t.p) b.push(badge(t.p, t.p === "free" ? "good" : t.p === "paid" ? "warn" : ""));
    if (t.op) b.push(badge(t.op, t.op === "active" ? "warn" : t.op === "passive" ? "good" : "", t.on));
    for (const f of t.f || "") b.push(badge(FLAG_LABELS[f][0], f === "X" ? "bad" : "", FLAG_LABELS[f][1]));
    return `<article class="tk-card">
      <div class="tk-title"><a href="${esc(safeUrl(t.u))}" target="_blank" rel="noopener noreferrer" data-i="${i}">${esc(t.n)}</a>
        <span class="tk-host">${esc(host(t.u))}</span></div>
      <div class="tk-path">${esc(t._key)}</div>
      ${t.d ? `<p>${esc(t.d)}</p>` : ""}
      ${t.i || t.o ? `<div class="tk-io">${t.i ? `<b>in</b> ${esc(t.i)}` : ""}${t.o ? ` <b>→ out</b> ${esc(t.o)}` : ""}</div>` : ""}
      <div class="tk-badges">${b.join("")}</div>
    </article>`;
  }

  let shown = [];
  function renderResults() {
    const list = data.tools.filter((t) => matches(t));
    shown = list.slice(0, st.limit);
    const where = st.cat ? esc(st.cat) : st.sel && st.sel.type !== "keyword" ? `categories for target type <b>${esc(st.sel.type)}</b>` : "all categories";
    $("#tk-summary").innerHTML = `${fmt(list.length)} of ${fmt(data.tools.length)} tools · ${where}` +
      (st.target ? ` · click a tool to copy <code>${esc(st.target)}</code> and open it` : "");
    $("#tk-results").innerHTML = shown.length
      ? shown.map(card).join("") + (list.length > shown.length ? `<button id="tk-more">Show ${fmt(Math.min(PAGE, list.length - shown.length))} more</button>` : "")
      : `<p class="hint">No tools match. Try clearing filters.</p>`;
  }

  function render() {
    if (!data) return;
    $("#tk-filters").innerHTML = Object.entries(FILTERS).map(([k, f]) =>
      `<button class="tk-filter ${st.filters.has(k) ? "on" : ""}" data-filter="${k}" ${f.title ? `title="${esc(f.title)}"` : ""}>${esc(f.label)}</button>`).join("");
    $("#tk-selector").textContent = st.sel ? `detected: ${st.sel.type}` : "";
    renderTree();
    renderResults();
  }

  async function open(opts = {}) {
    root.hidden = false;
    document.body.classList.add("tk-open");
    if (opts.target !== undefined) { $("#tk-target").value = opts.target; setTarget(opts.target, false); }
    if (opts.category !== undefined) st.cat = opts.category;
    st.limit = PAGE;
    if (!data) $("#tk-results").innerHTML = `<p class="loading">Loading OSINT Framework</p>`;
    try {
      await load();
      render();
      (opts.target ? $("#tk-q") : $("#tk-target")).focus();
    } catch (err) {
      $("#tk-results").innerHTML = `<p class="error">Could not load toolkit: ${esc(err.message)}</p>`;
    }
  }

  function close() {
    root.hidden = true;
    document.body.classList.remove("tk-open");
  }

  function setTarget(v, rerender = true) {
    st.target = v.trim();
    st.sel = detectSelector(st.target);
    if (st.sel && st.sel.type !== "keyword") st.cat = null;
    st.limit = PAGE;
    if (rerender) render();
  }

  let qTimer, targetTimer;
  $("#tk-q").addEventListener("input", (e) => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => { st.q = e.target.value.trim(); st.limit = PAGE; render(); }, 120);
  });
  $("#tk-target").addEventListener("input", (e) => {
    clearTimeout(targetTimer);
    targetTimer = setTimeout(() => setTarget(e.target.value), 150);
  });
  $("#tk-filters").addEventListener("click", (e) => {
    const f = e.target.dataset.filter;
    if (!f) return;
    st.filters.has(f) ? st.filters.delete(f) : st.filters.add(f);
    st.limit = PAGE;
    render();
  });
  $("#tk-tree").addEventListener("click", (e) => {
    const tog = e.target.closest("[data-toggle]");
    if (tog && tog.textContent) {
      const k = tog.dataset.toggle;
      st.open.has(k) ? st.open.delete(k) : st.open.add(k);
      if (st.cat && st.cat.startsWith(k + SEP)) st.cat = k;
      return renderTree();
    }
    const n = e.target.closest("[data-cat]");
    if (!n) return;
    st.cat = n.dataset.cat || null;
    if (st.cat) st.open.add(st.cat);
    st.limit = PAGE;
    render();
    $("#tk-results").scrollTop = 0;
  });
  $("#tk-results").addEventListener("click", (e) => {
    if (e.target.id === "tk-more") { st.limit += PAGE; return renderResults(); }
    const a = e.target.closest("a[data-i]");
    if (a && st.target) copy(st.target);
  });
  $("#tk-close").addEventListener("click", close);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !root.hidden) close();
  });

  function copy(text) {
    navigator.clipboard?.writeText(text).then(() => toast(`Copied “${text}” — paste it into the tool`), () => {});
  }
  function toast(msg) {
    const t = $("#tk-toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(t._h);
    t._h = setTimeout(() => { t.hidden = true; }, 2500);
  }

  return { open, close };
}

function host(u) {
  try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; }
}
