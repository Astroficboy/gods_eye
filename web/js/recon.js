import { api, esc, table, link, toolkitButton } from "./util.js";

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6 = /^[0-9a-f:]+:[0-9a-f:]*$/i;

/** Infrastructure recon: domain → DNS / crt.sh / RDAP, IP → geo / ASN / RDAP / PTR. */
export function initRecon({ map, layer, showTab }) {
  const $ = (s) => document.querySelector(s);
  const out = $("#recon-out");

  async function run(target) {
    target = target.trim();
    if (!target) return;
    showTab("recon");
    $("#recon-q").value = target;
    const isIp = IPV4.test(target) || IPV6.test(target);
    out.innerHTML = `<p class="loading">Running ${isIp ? "IP" : "domain"} recon on ${esc(target)}</p>`;
    try {
      if (isIp) {
        const d = await api(`recon/ip?addr=${encodeURIComponent(target)}`);
        out.innerHTML = ipHtml(d);
        plotIp(d);
      } else {
        const d = await api(`recon/domain?name=${encodeURIComponent(target)}`);
        out.innerHTML = domainHtml(d);
        // Geolocate the domain's A records so they show up on the map.
        const ips = Array.isArray(d.dns.A) ? d.dns.A.filter((ip) => IPV4.test(ip)).slice(0, 5) : [];
        for (const ip of ips) api(`recon/ip?addr=${ip}`).then((r) => plotIp(r, d.domain)).catch(() => {});
      }
    } catch (err) {
      out.innerHTML = `<p class="error">${esc(err.message)}</p>`;
    }
  }

  function plotIp(d, label) {
    const g = d.geo;
    if (!g || g.success === false || g.latitude == null) return;
    const title = label ? `${label} → ${d.ip}` : d.ip;
    const m = L.circleMarker([g.latitude, g.longitude], { radius: 8, color: "#ff4fa3", weight: 2, fillColor: "#ff4fa3", fillOpacity: 0.3 })
      .bindPopup(`<b>${esc(title)}</b>` + table([
        ["Location", esc([g.city, g.region, g.country].filter(Boolean).join(", "))],
        ["ASN", esc(`AS${g.connection?.asn ?? "?"} ${g.connection?.org ?? ""}`)],
        ["ISP", esc(g.connection?.isp)],
      ]))
      .addTo(layer.group);
    if (layer.on && !map.hasLayer(layer.group)) layer.group.addTo(map);
    const count = document.querySelector("#count-recon");
    if (count) count.textContent = layer.group.getLayers().length;
    if (!label) map.flyTo([g.latitude, g.longitude], 8);
    else m.openPopup();
  }

  $("#recon-form").addEventListener("submit", (e) => { e.preventDefault(); run($("#recon-q").value); });
  out.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-recon]");
    if (chip) run(chip.dataset.recon);
  });
}

function list(v, recon = false) {
  if (v && v.error) return `<span class="error">${esc(v.error)}</span>`;
  if (!v || !v.length) return `<span class="hint">none</span>`;
  return `<div class="chips">${v.map((x) => recon
    ? `<span class="chip" data-recon="${esc(x)}" title="Recon ${esc(x)}">${esc(x)}</span>`
    : `<span>${esc(x)}</span>`).join("<br>")}</div>`;
}

function rdapHtml(r) {
  if (!r) return "";
  if (r.error) return `<p class="error">RDAP: ${esc(r.error)}</p>`;
  const ev = r.events || {};
  return table([
    ["Handle", esc(r.handle)],
    ["Name", esc(r.name)],
    ["Range", r.range ? esc(r.range.join(" – ")) : ""],
    ["Country", esc(r.country)],
    ["Registered", esc(ev.registration)],
    ["Updated", esc(ev["last changed"])],
    ["Expires", esc(ev.expiration)],
    ["Status", esc((r.status || []).join(", "))],
    ["Entities", (r.entities || []).map((e) => `${esc(e.name)} <span class="hint">(${esc(e.roles.join(", "))})</span>`).join("<br>")],
  ]);
}

function domainHtml(d) {
  const ipLike = (v) => Array.isArray(v) ? v.filter((x) => IPV4.test(x) || IPV6.test(x)) : v;
  const subs = d.subdomains;
  return `<h2>${esc(d.domain)}</h2>` + table([
    ["A", list(ipLike(d.dns.A), true)],
    ["AAAA", list(d.dns.AAAA)],
    ["CNAME", list(d.dns.CNAME)],
    ["MX", list(d.dns.MX)],
    ["NS", list(d.dns.NS)],
    ["TXT", list(d.dns.TXT)],
  ]) +
  `<h2>Registration (RDAP)</h2>${rdapHtml(d.rdap)}` +
  `<h2>Subdomains via certificate transparency ${Array.isArray(subs) ? `(${subs.length})` : ""}</h2>` +
  (Array.isArray(subs) ? list(subs.slice(0, 400), true) : `<p class="error">${esc(subs?.error)}</p>`) +
  `<h2>Pivot</h2><p>${[
    link(`https://web.archive.org/web/*/${d.domain}`, "Wayback"),
    link(`https://urlscan.io/search/#domain:${d.domain}`, "urlscan"),
    link(`https://www.shodan.io/search?query=hostname:${d.domain}`, "Shodan"),
    link(`https://search.censys.io/search?resource=hosts&q=${d.domain}`, "Censys"),
    link(`https://www.virustotal.com/gui/domain/${d.domain}`, "VirusTotal"),
    link(`https://securitytrails.com/domain/${d.domain}/dns`, "SecurityTrails"),
  ].join(" · ")}</p>${toolkitButton("Domain Name", d.domain, "All domain tools")}`;
}

function ipHtml(d) {
  const g = d.geo || {};
  const geo = g.error || g.success === false
    ? `<p class="error">${esc(g.error || g.message || "geolocation failed")}</p>`
    : table([
      ["Location", esc([g.city, g.region, g.country].filter(Boolean).join(", "))],
      ["Coordinates", esc(`${g.latitude}, ${g.longitude}`)],
      ["ASN", esc(`AS${g.connection?.asn ?? "?"}`)],
      ["Org", esc(g.connection?.org)],
      ["ISP", esc(g.connection?.isp)],
      ["Timezone", esc(g.timezone?.id)],
    ]);
  return `<h2>${esc(d.ip)}</h2>${geo}` +
    `<h2>Reverse DNS</h2>${list(d.ptr)}` +
    `<h2>Network (RDAP)</h2>${rdapHtml(d.rdap)}` +
    `<h2>Pivot</h2><p>${[
      link(`https://www.shodan.io/host/${d.ip}`, "Shodan"),
      link(`https://search.censys.io/hosts/${d.ip}`, "Censys"),
      link(`https://www.abuseipdb.com/check/${d.ip}`, "AbuseIPDB"),
      link(`https://www.virustotal.com/gui/ip-address/${d.ip}`, "VirusTotal"),
      link(`https://bgp.he.net/ip/${d.ip}`, "bgp.he.net"),
    ].join(" · ")}</p>${toolkitButton("IP & MAC Address", d.ip, "All IP tools")}`;
}
