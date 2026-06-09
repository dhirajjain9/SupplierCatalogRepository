"use strict";

// --------------------------------------------------------------------------- //
// API helpers
// --------------------------------------------------------------------------- //
const api = {
  async request(method, url, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.detail ? JSON.stringify(data.detail) : res.statusText);
    }
    return data;
  },
  get: (u) => api.request("GET", u),
  post: (u, b) => api.request("POST", u, b),
  put: (u, b) => api.request("PUT", u, b),
  del: (u) => api.request("DELETE", u),
};

// fetch with a hard timeout so a stalled serverless call can't freeze an import
// indefinitely — it aborts and the caller falls back / retries instead.
async function fetchWithTimeout(url, opts = {}, ms = 45000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Run an async worker over items with bounded concurrency (default 5). Keeps
// long batches of network calls fast without firing hundreds at once. The
// optional onDone(completedCount) fires after each item for progress display.
async function runPool(items, worker, limit = 5, onDone) {
  let i = 0, done = 0;
  const next = async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx], idx);
      if (onDone) onDone(++done);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, next));
}

// POST/PUT JSON with a timeout and a few retries on transient failures (network
// drop, timeout, 429 rate-limit, 5xx). Permanent 4xx errors fail fast. Used for
// the AI calls that orchestrate long jobs (taxonomy classify/save) so one slow
// or rate-limited batch can't hang or kill the whole run.
// Grey + disable the button that triggered a direct (non-modal) async action
// until it settles, ignoring repeat clicks. The button ref is captured before
// the first await (currentTarget is cleared once the handler returns).
async function withButton(ev, fn) {
  const btn = ev && (ev.currentTarget || ev.target);
  if (btn) btn.disabled = true;
  try { return await fn(); }
  finally { if (btn) btn.disabled = false; }
}

async function postJsonRetry(url, body, { method = "POST", timeoutMs = 60000, tries = 4 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < tries; attempt++) {
    let res;
    try {
      res = await fetchWithTimeout(url, {
        method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      }, timeoutMs);
    } catch (e) {                       // aborted (timeout) or network error
      lastErr = e;
      if (attempt < tries - 1) await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
      continue;
    }
    if (res.ok) return res.status === 204 ? null : await res.json().catch(() => ({}));
    if (res.status < 500 && res.status !== 429) {   // permanent — don't retry
      const e = await res.json().catch(() => ({}));
      throw new Error(e.detail || `Request failed (HTTP ${res.status})`);
    }
    // transient (429/5xx) — keep the server's detail so the real cause is shown
    const e = await res.json().catch(() => ({}));
    lastErr = new Error(e.detail || `HTTP ${res.status}`);
    if (attempt < tries - 1) await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
  }
  throw lastErr || new Error("Request failed");
}

// Turn a batch failure into a readable line that shows the *actual* server error
// (not a generic "AI was busy"), so misconfig/credit/rate-limit issues are visible.
function failureReason(err, failedCount) {
  const msg = (err && err.message) ? err.message : "Unknown error";
  return `${failedCount} couldn't be classified — ${msg}. Click again to retry the rest.`;
}
// When *every* batch failed, the cause is almost always the AI key/credits, so
// add a pointed hint.
function apiKeyHintIf(allFailed) {
  return allFailed
    ? `<p class="muted">All batches failed — this usually means the server's AI key `
      + `(<code>OPENAI_API_KEY</code> or <code>ANTHROPIC_API_KEY</code>) is invalid/expired, out of `
      + `credit, or rate-limited. Check the key and billing in Vercel.</p>`
    : "";
}

// Small in-memory caches so dropdowns/labels can resolve names by id.
let suppliersCache = [];
let itemsCache = [];

function supplierName(id) {
  const s = suppliersCache.find((x) => x.id === id);
  return s ? s.name : `#${id}`;
}
function itemName(id) {
  const i = itemsCache.find((x) => x.id === id);
  return i ? i.name : `#${id}`;
}
function esc(s) {
  return (s == null ? "" : String(s)).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}
function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const ICONS = {
  check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
  alert: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
  box: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>`,
  tag: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>`,
  doc: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>`,
  image: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`,
};

function toast(msg, isError) {
  const el = document.getElementById("toast");
  el.innerHTML = `<span class="dot">${isError ? ICONS.alert : ICONS.check}</span>${esc(msg)}`;
  el.className = "toast" + (isError ? " error" : " success");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.className = "toast hidden"), 2800);
}

// Centered empty-state row for a table body.
function emptyState(colspan, icon, title, sub) {
  return `<tr><td colspan="${colspan}" class="empty">
    ${icon}<div class="empty-title">${esc(title)}</div>
    <div class="empty-sub">${esc(sub)}</div></td></tr>`;
}

// Shimmer placeholder rows shown while data loads.
function skeletonRows(colspan, rows = 4) {
  const cells = Array.from({ length: colspan }, () => `<td><div class="skeleton"></div></td>`).join("");
  return Array.from({ length: rows }, () => `<tr class="skeleton-row">${cells}</tr>`).join("");
}

// Keep the segmented-nav count badges in sync with the data.
async function refreshCounts() {
  try {
    const c = await api.get("/api/counts");  // cheap SQL counts, not full lists
    const set = (key, n) => {
      const el = document.querySelector(`.count[data-count="${key}"]`);
      if (el) el.textContent = n ? ` ${n}` : "";
    };
    set("suppliers", c.suppliers); set("competitors", c.competitors);
    set("catalog", c.catalog); set("quotes", c.quotes); set("documents", c.documents);
  } catch (_) { /* counts are best-effort */ }
}

// --------------------------------------------------------------------------- //
// Tabs
// --------------------------------------------------------------------------- //
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    document.getElementById(tab.dataset.tab).classList.add("active");
    refreshTab(tab.dataset.tab);
  });
});

function refreshTab(name) {
  if (name === "suppliers") loadSuppliers();
  else if (name === "competitors") loadCompetitors();
  else if (name === "catalog") loadCatalog();
  else if (name === "quotes") loadQuotes();
  else if (name === "documents") loadDocuments();
  else if (name === "coverage") loadCoverage();
}

// --------------------------------------------------------------------------- //
// Modal form builder
// --------------------------------------------------------------------------- //
let onSubmit = null;

function openModal(title, fields, handler, extraFooterHtml = "") {
  document.getElementById("modal-title").textContent = title;
  document.getElementById("modal-extra").innerHTML = extraFooterHtml;
  const container = document.getElementById("modal-fields");
  container.innerHTML = "";
  fields.forEach((f) => {
    const wrap = document.createElement("div");
    wrap.className = "field";
    const label = document.createElement("label");
    label.textContent = f.label + (f.required ? " *" : "");
    let input;
    if (f.type === "textarea") {
      input = document.createElement("textarea");
    } else if (f.type === "select") {
      input = document.createElement("select");
      (f.options || []).forEach((o) => {
        const opt = document.createElement("option");
        opt.value = o.value;
        opt.textContent = o.label;
        input.appendChild(opt);
      });
    } else {
      input = document.createElement("input");
      input.type = f.type || "text";
    }
    input.name = f.name;
    if (f.required) input.required = true;
    if (f.step) input.step = f.step;
    if (f.min !== undefined) input.min = f.min;
    if (f.value != null) input.value = f.value;
    if (f.accept) input.accept = f.accept;
    wrap.appendChild(label);
    wrap.appendChild(input);
    container.appendChild(wrap);
  });
  onSubmit = handler;
  document.getElementById("modal-overlay").classList.remove("hidden");
}

function closeModal() {
  if (modalBusy) return;  // never dismiss while an operation is running
  document.getElementById("modal-overlay").classList.add("hidden");
  document.getElementById("modal-extra").innerHTML = "";
  setSaveLabel("Save");
  onSubmit = null;
}

// While an operation runs, lock the modal: grey the action button (with a
// spinner), hide the Cancel/✕ affordances, and block Esc/backdrop/X dismissal —
// so the dialog stays open and it's always clear that something is in progress.
let modalBusy = false;
function setModalBusy(on) {
  modalBusy = on;
  document.getElementById("modal-overlay").classList.toggle("busy", on);
  const saveBtn = document.querySelector("#modal-form button[type=submit]");
  if (saveBtn) saveBtn.disabled = on;
}

document.getElementById("modal-close").addEventListener("click", closeModal);
document.getElementById("modal-cancel").addEventListener("click", closeModal);
document.getElementById("modal-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (modalBusy) return;  // ignore double-clicks / repeat submits
  const form = e.target;
  const values = {};
  new FormData(form).forEach((v, k) => (values[k] = v));
  setModalBusy(true);
  try {
    // A handler may return false to keep the modal open (e.g. to show a summary).
    const keepOpen = await onSubmit(values, form);
    setModalBusy(false);
    if (keepOpen !== false) closeModal();
  } catch (err) {
    setModalBusy(false);  // unlock so the error is visible and dismissable
    toast(err.message, true);
  }
});

// --------------------------------------------------------------------------- //
// Suppliers (type=supplier) and Competitors (type=reference) — same renderer
// --------------------------------------------------------------------------- //
const SRC = {
  supplier: { bodyId: "suppliers-body", searchId: "supplier-search", noun: "supplier", back: "← Suppliers",
              empty: "No suppliers yet", emptySub: "Add a supplier or import a catalog." },
  reference: { bodyId: "competitors-body", searchId: "competitor-search", noun: "competitor", back: "← Competitors",
               empty: "No competitors yet", emptySub: "Add a competitor brand or import its portfolio." },
};

// Shared coverage view for suppliers and competitors: one card per source with
// its item count, how many categories it spans, and its top categories — plus a
// drill-in (viewSource) showing the full category-wise SKU breakdown.
async function renderSourceCards(type) {
  const cfg = SRC[type];
  const body = document.getElementById(cfg.bodyId);
  body.innerHTML = `<p class="muted">Loading…</p>`;
  const q = document.getElementById(cfg.searchId).value.trim().toLowerCase();
  const [sups, stats] = await Promise.all([
    api.get(`/api/suppliers?type=${type}`), api.get("/api/catalog-items/stats"),
  ]);
  const refs = q ? sups.filter((s) => (s.name || "").toLowerCase().includes(q)) : sups;
  if (!refs.length) {
    body.innerHTML = info(q ? "No matches" : cfg.empty, q ? `Nothing matches “${q}”.` : cfg.emptySub);
    refreshCounts();
    return;
  }
  // Per source: total items, item count per master category, and uncategorized.
  const bySup = {};
  stats.forEach((r) => {
    const b = (bySup[r.supplier_id] = bySup[r.supplier_id] || { total: 0, masters: {}, unclassified: 0 });
    b.total += r.count;
    if (r.master_category) b.masters[r.master_category] = (b.masters[r.master_category] || 0) + r.count;
    else b.unclassified += r.count;
  });
  body.innerHTML = `<div class="cards comp-cards">` + refs.map((s) => {
    const b = bySup[s.id] || { total: 0, masters: {}, unclassified: 0 };
    const catCount = Object.keys(b.masters).length;
    const tops = Object.entries(b.masters).sort((a, c) => c[1] - a[1]).slice(0, 4);
    const maxN = tops.length ? tops[0][1] : 1;
    const bars = tops.map(([m, n]) =>
      `<div class="cbar"><span class="cbar-l">${esc(m)}</span>
        <span class="cbar-track"><span class="cbar-fill" style="width:${Math.round(n / maxN * 100)}%"></span></span>
        <span class="cbar-n">${n}</span></div>`).join("")
      || `<p class="muted" style="font-size:12.5px">Not categorized yet — run “Curate categories”.</p>`;
    return `<div class="ccard">
      <div class="ccard-head"><div>
        <div class="ccard-name">${esc(s.name)}</div>
        <div class="muted" style="font-size:12.5px">${b.total} item${b.total === 1 ? "" : "s"} · ${catCount} categor${catCount === 1 ? "y" : "ies"}${b.unclassified ? ` · ${b.unclassified} uncategorized` : ""}</div>
      </div></div>
      <div class="ccard-bars">${bars}</div>
      <div class="ccard-foot">
        <button class="btn link" onclick="viewSource('${type}',${s.id})">Coverage →</button>
        <span class="spacer"></span>
        <button class="btn link" onclick="editSupplier(${s.id},'${type}')">Edit</button>
        <button class="btn danger-text" onclick="deleteSupplier(event,${s.id},'${type}')">Delete</button>
      </div></div>`;
  }).join("") + `</div>`;
  refreshCounts();
}
const loadSuppliers = () => renderSourceCards("supplier");
const loadCompetitors = () => renderSourceCards("reference");

// Drill-in: full master → sub category breakdown (with item counts) for one source.
window.viewSource = async function (type, id) {
  const cfg = SRC[type];
  const body = document.getElementById(cfg.bodyId);
  body.innerHTML = `<p class="muted">Loading…</p>`;
  const [sups, stats] = await Promise.all([
    api.get(`/api/suppliers?type=${type}`), api.get("/api/catalog-items/stats"),
  ]);
  const sup = sups.find((s) => s.id === id) || { name: "#" + id };
  const mine = stats.filter((r) => r.supplier_id === id);
  const total = mine.reduce((n, r) => n + r.count, 0);
  const tree = {};
  mine.forEach((r) => {
    const m = r.master_category || "Uncategorized";
    const t = (tree[m] = tree[m] || { total: 0, subs: {} });
    t.total += r.count;
    t.subs[r.sub_category || "—"] = (t.subs[r.sub_category || "—"] || 0) + r.count;
  });
  const masters = Object.entries(tree).sort((a, c) => c[1].total - a[1].total);
  const sections = masters.map(([m, t]) => {
    const subs = Object.entries(t.subs).sort((a, c) => c[1] - a[1]);
    return `<div class="sumrow master"><span>${esc(m)}</span><span class="num">${t.total}</span></div>` +
      subs.map(([s, n]) => `<div class="sumrow"><span>${esc(s)}</span><span class="num">${n}</span></div>`).join("");
  }).join("");
  body.innerHTML = `
    <div class="detail-head">
      <button class="btn" onclick="${type === 'reference' ? 'loadCompetitors' : 'loadSuppliers'}()">${cfg.back}</button>
      <h3>${esc(sup.name)} <span class="muted">· ${total} items · ${masters.length} categories</span></h3>
      <span class="spacer"></span>
      <button class="btn" onclick="viewSupplierProducts(${id},'${type}')">View products →</button>
    </div>
    <div class="table-wrap sum-table">${sections || '<p class="muted" style="padding:12px">No items yet.</p>'}</div>`;
};

// Jump to the Catalog tab filtered to this one source (supplier or competitor).
window.viewSupplierProducts = function (id, type = "supplier") {
  document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
  document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
  document.querySelector('.tab[data-tab="catalog"]').classList.add("active");
  document.getElementById("catalog").classList.add("active");
  loadCatalog().then(() => {
    const supSel = document.getElementById("catalog-supplier-filter");
    const compSel = document.getElementById("catalog-competitor-filter");
    if (type === "reference") { compSel.value = String(id); supSel.value = "none"; }
    else { supSel.value = String(id); compSel.value = "none"; }
    loadCatalog();
  });
};

function supplierFields(s = {}) {
  return [
    { name: "name", label: "Name", required: true, value: s.name },
    { name: "contact_name", label: "Contact name", value: s.contact_name },
    { name: "email", label: "Email", type: "email", value: s.email },
    { name: "phone", label: "Phone", value: s.phone },
    { name: "category", label: "Category", value: s.category },
    { name: "address", label: "Address", type: "textarea", value: s.address },
    { name: "notes", label: "Notes", type: "textarea", value: s.notes },
  ];
}

function cleanEmpty(values) {
  const out = {};
  Object.entries(values).forEach(([k, v]) => (out[k] = v === "" ? null : v));
  return out;
}

function addSource(type) {
  const noun = SRC[type].noun;
  openModal(`Add ${noun[0].toUpperCase() + noun.slice(1)}`, supplierFields(), async (v) => {
    await api.post("/api/suppliers", { ...cleanEmpty(v), type });
    toast(`${noun[0].toUpperCase() + noun.slice(1)} created`);
    renderSourceCards(type);
  });
}

window.editSupplier = async (id, type) => {
  const s = await api.get(`/api/suppliers/${id}`);
  openModal("Edit", supplierFields(s), async (v) => {
    await api.put(`/api/suppliers/${id}`, cleanEmpty(v));
    toast("Saved");
    renderSourceCards(type || s.type || "supplier");
  });
};

window.deleteSupplier = (ev, id, type) => withButton(ev, async () => {
  if (!confirm("Delete this and all its items, quotes and documents?")) return;
  await api.del(`/api/suppliers/${id}`);
  toast("Deleted");
  renderSourceCards(type || "supplier");
});

// Combine several suppliers/competitors into one (e.g. 6 "Circle …" rows → CIRCLE):
// move their items, photos and quotes to the target, then drop the emptied sources.
async function mergeSourcesFlow(type) {
  const noun = SRC[type].noun;
  const [sups, stats] = await Promise.all([
    api.get(`/api/suppliers?type=${type}`), api.get("/api/catalog-items/stats"),
  ]);
  if (sups.length < 2) return toast(`Need at least two ${noun}s to merge.`, true);
  const countBy = {};
  stats.forEach((r) => (countBy[r.supplier_id] = (countBy[r.supplier_id] || 0) + r.count));
  openModal(`Merge ${noun}s`, [], async () => {
    const fields = document.getElementById("modal-fields");
    const ids = [...fields.querySelectorAll(".merge-chk:checked")].map((c) => +c.dataset.id);
    const target = fields.querySelector("#merge-target").value.trim();
    if (!target) throw new Error("Enter the name to merge into (e.g. CIRCLE).");
    if (ids.length < 2) throw new Error(`Tick at least two ${noun}s to merge.`);
    fields.innerHTML = `<p class="muted">Merging ${ids.length} ${noun}s into “${esc(target)}”…</p>`;
    const r = await api.post("/api/maintenance/merge-suppliers", { source_ids: ids, target_name: target });
    fields.innerHTML = `<p><strong>Merged ${r.merged} ${noun}s</strong> into “${esc(r.target_name)}” `
      + `— ${r.items_moved} item(s) moved. 🎉</p>`
      + `<p class="muted">Tip: run 🖼 De-dupe images if the sources shared photos.</p>`;
    setSaveLabel("Done"); onSubmit = async () => {};
    renderSourceCards(type); refreshCounts();
    return false;
  });
  const rows = sups.map((s) => `<label class="merge-row" style="display:block;margin:4px 0">
      <input type="checkbox" class="merge-chk" data-id="${s.id}"> ${esc(s.name)}
      <span class="muted">· ${countBy[s.id] || 0} items</span></label>`).join("");
  document.getElementById("modal-fields").innerHTML = `
    <div class="field"><label>Merge into (name)</label>
      <input id="merge-target" type="text" placeholder="e.g. CIRCLE" autocomplete="off" /></div>
    <p class="muted">Tick the ${noun}s to combine. Their items, photos and quotes move to the target
       name (created if it doesn't exist); the ticked sources are then removed.</p>
    <input type="search" id="merge-search" placeholder="Filter ${noun}s…" style="margin-bottom:6px" />
    <div style="max-height:240px;overflow:auto;border-top:1px solid var(--border);padding-top:6px">${rows}</div>`;
  setSaveLabel("Merge");
  const fields = document.getElementById("modal-fields");
  fields.querySelector("#merge-search").addEventListener("input", (e) => {
    const term = e.target.value.toLowerCase();
    fields.querySelectorAll(".merge-row").forEach((row) =>
      (row.style.display = row.textContent.toLowerCase().includes(term) ? "" : "none"));
  });
}
document.querySelectorAll("[data-merge]").forEach((b) =>
  b.addEventListener("click", () => mergeSourcesFlow(b.dataset.srctype)));
document.querySelectorAll("[data-add-supplier]").forEach((b) =>
  b.addEventListener("click", () => addSource(b.dataset.srctype)));
document.getElementById("supplier-search").addEventListener("input", debounce(loadSuppliers, 250));
document.getElementById("competitor-search").addEventListener("input", debounce(loadCompetitors, 250));

// --------------------------------------------------------------------------- //
// Catalog items
// --------------------------------------------------------------------------- //
async function ensureSuppliers() {
  if (!suppliersCache.length) suppliersCache = await api.get("/api/suppliers");
}
async function ensureItems() {
  if (!itemsCache.length) itemsCache = await api.get("/api/catalog-items");
}

let catalogView = localStorage.getItem("catalogView") || "gallery";

function imgUrl(docId) { return `/api/documents/${docId}/download`; }

// A product card for the gallery view.
function catalogCard(i, thumbDocId) {
  const a = i.attributes || {};
  const spec = a.Material || a.Features || a.Specification || "";
  const img = thumbDocId
    ? `<img src="${imgUrl(thumbDocId)}" alt="" loading="lazy" />`
    : `<div class="ph">${ICONS.image}</div>`;
  return `<div class="pcard">
    <div class="pcard-img" onclick="viewImages(${i.id})">${img}</div>
    <div class="pcard-body">
      <div class="pcard-name" title="${esc(i.name)}">${esc(i.name)}</div>
      <div class="pcard-sub">${i.category ? `<span class="pill">${esc(i.category)}</span>` : ""}
        <span class="muted">${esc(supplierName(i.supplier_id))}</span></div>
      ${spec ? `<div class="pcard-spec">${esc(spec)}</div>` : ""}
    </div>
    <div class="pcard-foot">
      ${i.attributes && Object.keys(i.attributes).length
          ? `<button class="btn link" onclick="viewAttributes(${i.id})">Details</button>` : ""}
      <button class="btn link" onclick="editItem(${i.id})">Edit</button>
      <button class="btn danger-text" onclick="deleteItem(event,${i.id})">Delete</button>
    </div>
  </div>`;
}

function setCatalogView(view) {
  catalogView = view;
  localStorage.setItem("catalogView", view);
  document.querySelectorAll("#catalog-view-toggle button").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === view));
  document.getElementById("catalog-gallery").classList.toggle("hidden", view !== "gallery");
  document.getElementById("catalog-table-wrap").classList.toggle("hidden", view !== "table");
}

async function loadCatalog() {
  const gallery = document.getElementById("catalog-gallery");
  const tbody = document.querySelector("#catalog-table tbody");
  setCatalogView(catalogView);
  if (catalogView === "gallery") gallery.innerHTML = `<p class="muted" style="padding:8px">Loading…</p>`;
  else tbody.innerHTML = skeletonRows(6);

  await ensureSuppliers();
  const supSel = document.getElementById("catalog-supplier-filter");
  const compSel = document.getElementById("catalog-competitor-filter");
  const mSel = document.getElementById("catalog-master-filter");
  const sSel = document.getElementById("catalog-sub-filter");

  const suppliers = suppliersCache.filter((s) => (s.type || "supplier") !== "reference");
  const competitors = suppliersCache.filter((s) => (s.type || "supplier") === "reference");

  // Repopulate the two source dropdowns, preserving the current choice. Suppliers
  // default to "all"; competitors default to "none" (hidden) so the catalog shows
  // suppliers only until the user opts competitors in.
  const supVal = supSel.value || "all";
  const compVal = compSel.value || "none";
  supSel.innerHTML = `<option value="all">All suppliers</option><option value="none">None</option>` +
    suppliers.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("");
  supSel.value = [...supSel.options].some((o) => o.value === supVal) ? supVal : "all";
  compSel.innerHTML = `<option value="none">None</option><option value="all">All competitors</option>` +
    competitors.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("");
  compSel.value = [...compSel.options].some((o) => o.value === compVal) ? compVal : "none";

  // Sources in scope — drives both the cascading category options and the fetch.
  const included = new Set();
  if (supSel.value === "all") suppliers.forEach((s) => included.add(s.id));
  else if (supSel.value !== "none") included.add(+supSel.value);
  if (compSel.value === "all") competitors.forEach((s) => included.add(s.id));
  else if (compSel.value !== "none") included.add(+compSel.value);

  // Cascading category filters, constrained to the in-scope sources (only show a
  // master/sub that actually has items in scope), with a live count per option.
  const stats = await api.get("/api/catalog-items/stats");
  const inScope = stats.filter((r) => included.has(r.supplier_id));
  const sumWhere = (pred) => inScope.filter(pred).reduce((n, r) => n + r.count, 0);
  const curMaster = mSel.value, curSub = sSel.value;
  const masters = [...new Set(inScope.map((r) => r.master_category).filter(Boolean))].sort();
  mSel.innerHTML = `<option value="">All master categories</option>` +
    masters.map((m) => `<option value="${esc(m)}">${esc(m)} (${sumWhere((r) => r.master_category === m)})</option>`).join("");
  mSel.value = masters.includes(curMaster) ? curMaster : "";
  const subs = [...new Set(inScope.filter((r) => !mSel.value || r.master_category === mSel.value)
    .map((r) => r.sub_category).filter(Boolean))].sort();
  sSel.innerHTML = `<option value="">All sub-categories</option>` +
    subs.map((sb) => `<option value="${esc(sb)}">${esc(sb)} (${sumWhere((r) => r.sub_category === sb && (!mSel.value || r.master_category === mSel.value))})</option>`).join("");
  sSel.value = subs.includes(curSub) ? curSub : "";

  // Fetch the union of the supplier scope and the competitor scope. Each scope is
  // one request (a specific id, or all of a type); results are merged + de-duped.
  const q = document.getElementById("catalog-search").value.trim();
  const common = new URLSearchParams();
  if (mSel.value) common.set("master_category", mSel.value);
  if (sSel.value) common.set("sub_category", sSel.value);
  if (q) common.set("search", q);
  const mkUrl = (extra) => {
    const p = new URLSearchParams(common);
    Object.entries(extra).forEach(([k, v]) => p.set(k, v));
    return `/api/catalog-items?${p}`;
  };
  const urls = [];
  if (supSel.value === "all") urls.push(mkUrl({ source_type: "supplier" }));
  else if (supSel.value !== "none") urls.push(mkUrl({ supplier_id: supSel.value }));
  if (compSel.value === "all") urls.push(mkUrl({ source_type: "reference" }));
  else if (compSel.value !== "none") urls.push(mkUrl({ supplier_id: compSel.value }));

  itemsCache = [];
  if (urls.length) {
    const seen = new Set();
    (await Promise.all(urls.map((u) => api.get(u)))).flat().forEach((it) => {
      if (!seen.has(it.id)) { seen.add(it.id); itemsCache.push(it); }
    });
    itemsCache.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  }
  document.getElementById("catalog-count").textContent =
    itemsCache.length ? `${itemsCache.length} item${itemsCache.length === 1 ? "" : "s"}` : "";

  // Thumbnails: prefer a product's own photo, else fall back to its source-page image.
  const itemThumb = {}, pageThumb = {};
  try {
    (await api.get("/api/documents?kind=image")).forEach((d) => {
      if (d.catalog_item_id) { if (!itemThumb[d.catalog_item_id]) itemThumb[d.catalog_item_id] = d.id; }
      else if (d.supplier_id) {
        const m = /page-(\d+)\./i.exec(d.filename || "");
        if (m) pageThumb[`${d.supplier_id}|${m[1]}`] = d.id;
      }
    });
  } catch (_) { /* thumbnails are optional */ }
  const thumbFor = (i) => itemThumb[i.id]
    || pageThumb[`${i.supplier_id}|${(i.attributes || {})["Source Page"]}`]
    || null;

  if (!itemsCache.length) {
    const noSources = !included.size;
    const filtering = q || mSel.value || sSel.value || supSel.value !== "all" || compSel.value !== "none";
    const title = noSources ? "No sources selected" : filtering ? "No matching items" : "No catalog items yet";
    const sub = noSources ? "Pick a supplier or competitor above to see items."
      : filtering ? "Try clearing the search or filters." : "Import a catalog or add an item to begin.";
    gallery.innerHTML = `<div class="gallery-empty">${ICONS.box}<div class="empty-title">${title}</div><div class="empty-sub">${sub}</div></div>`;
    tbody.innerHTML = emptyState(6, ICONS.box, title, sub);
    refreshCounts();
    return;
  }

  // Cap how many we render at once so huge catalogs (1000s) don't jank the
  // main thread; the count + filters guide narrowing down.
  const CAP = 300;
  const shown = itemsCache.slice(0, CAP);
  const moreNote = itemsCache.length > CAP
    ? `<div class="more-note">Showing ${CAP} of ${itemsCache.length} — use the filters or search to narrow down.</div>`
    : "";

  if (catalogView === "gallery") {
    gallery.innerHTML = moreNote + shown.map((i) => catalogCard(i, thumbFor(i))).join("");
  } else {
    tbody.innerHTML = shown.map((i) => {
      const t = thumbFor(i);
      const thumb = t
        ? `<img class="thumb" src="${imgUrl(t)}" alt="" />`
        : `<span class="thumb thumb-ph">${ICONS.image}</span>`;
      return `<tr>
        <td><div class="cell-with-thumb">${thumb}<span>${esc(i.name)}</span></div></td>
        <td>${esc(i.sku) || "—"}</td>
        <td>${esc(supplierName(i.supplier_id))}</td><td>${esc(i.unit) || "—"}</td>
        <td>${i.category ? `<span class="pill">${esc(i.category)}</span>` : "—"}</td>
        <td class="right">
          <button class="btn link" onclick="viewImages(${i.id})">Photos</button>
          ${i.attributes && Object.keys(i.attributes).length
              ? `<button class="btn link" onclick="viewAttributes(${i.id})">Columns</button>` : ""}
          <button class="btn link" onclick="editItem(${i.id})">Edit</button>
          <button class="btn danger-text" onclick="deleteItem(event,${i.id})">Delete</button>
        </td></tr>`;
    }).join("");
    if (moreNote) tbody.insertAdjacentHTML("afterbegin", `<tr><td colspan="6">${moreNote}</td></tr>`);
  }
  refreshCounts();
}

document.querySelectorAll("#catalog-view-toggle button").forEach((b) =>
  b.addEventListener("click", () => { setCatalogView(b.dataset.view); loadCatalog(); }));

window.viewAttributes = function (id) {
  const item = itemsCache.find((x) => x.id === id);
  if (!item || !item.attributes) return;
  const rows = Object.entries(item.attributes)
    .map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`)
    .join("");
  openModal("Original Columns — " + item.name, [], async () => {});
  document.getElementById("modal-fields").innerHTML =
    `<table class="attrs"><tbody>${rows}</tbody></table>`;
  document.getElementById("modal-extra").innerHTML = "";
};

window.viewImages = async function (id) {
  const item = itemsCache.find((x) => x.id === id);
  const docs = await api.get(`/api/documents?catalog_item_id=${id}&kind=image`);
  openModal("Photos — " + (item ? item.name : id), [], async () => {});
  const grid = docs.length
    ? `<div class="gallery">${docs
        .map((d) => `<a href="/api/documents/${d.id}/download" target="_blank" title="${esc(d.filename)}">
            <img src="/api/documents/${d.id}/download" alt="${esc(d.filename)}" /></a>`)
        .join("")}</div>`
    : `<p class="muted">No images yet. Use “Import Images” to attach photos by SKU.</p>`;
  document.getElementById("modal-fields").innerHTML = grid;
  document.getElementById("modal-extra").innerHTML = "";
};

function itemFields(i = {}) {
  return [
    {
      name: "supplier_id", label: "Supplier", type: "select", required: true,
      value: i.supplier_id,
      options: suppliersCache.map((s) => ({ value: s.id, label: s.name })),
    },
    { name: "name", label: "Name", required: true, value: i.name },
    { name: "sku", label: "SKU", value: i.sku },
    { name: "unit", label: "Unit (e.g. each, kg)", value: i.unit },
    { name: "category", label: "Category", value: i.category },
    { name: "description", label: "Description", type: "textarea", value: i.description },
  ];
}

document.getElementById("add-item").addEventListener("click", async () => {
  await ensureSuppliers();
  if (!suppliersCache.length) return toast("Add a supplier first", true);
  openModal("Add Catalog Item", itemFields(), async (v) => {
    v.supplier_id = Number(v.supplier_id);
    await api.post("/api/catalog-items", cleanEmpty(v));
    toast("Item created");
    loadCatalog();
  });
});

window.editItem = async (id) => {
  await ensureSuppliers();
  const i = await api.get(`/api/catalog-items/${id}`);
  openModal("Edit Catalog Item", itemFields(i), async (v) => {
    v.supplier_id = Number(v.supplier_id);
    await api.put(`/api/catalog-items/${id}`, cleanEmpty(v));
    toast("Item updated");
    loadCatalog();
  });
};

window.deleteItem = (ev, id) => withButton(ev, async () => {
  if (!confirm("Delete this item and its quotes and documents?")) return;
  await api.del(`/api/catalog-items/${id}`);
  toast("Item deleted");
  loadCatalog();
});

document.getElementById("catalog-supplier-filter").addEventListener("change", loadCatalog);
document.getElementById("catalog-competitor-filter").addEventListener("change", loadCatalog);
document.getElementById("catalog-master-filter").addEventListener("change", () => {
  document.getElementById("catalog-sub-filter").value = "";  // reset sub when master changes
  loadCatalog();
});
document.getElementById("catalog-sub-filter").addEventListener("change", loadCatalog);
document.getElementById("catalog-search").addEventListener("input", debounce(loadCatalog, 250));

// --------------------------------------------------------------------------- //
// Client-side file parsing — files are parsed in the browser and the extracted
// rows are sent to the server in small batches, so large files (25 MB+) never
// hit the serverless upload size limit.
// --------------------------------------------------------------------------- //
const HEADER_ALIASES = {
  name: ["name","product","product name","part name","item","item name","item description","product description","title","material","model"],
  sku: ["sku","code","item code","product code","part","part number","part no","part no.","mpn"],
  unit: ["unit","uom","unit of measure"],
  category: ["category","type","product type","group","class"],
  description: ["description","desc","details","notes"],
  unit_price: ["unit price","price","cost","rate","unit cost","list price"],
  currency: ["currency","ccy","cur"],
  min_quantity: ["min quantity","min qty","moq","minimum quantity","minimum order quantity","min order qty"],
};
const ALIAS_TO_FIELD = {};
Object.entries(HEADER_ALIASES).forEach(([f, al]) => al.forEach((a) => (ALIAS_TO_FIELD[a] = f)));
const canonicalHeader = (h) => (h == null ? null : ALIAS_TO_FIELD[String(h).trim().toLowerCase()] || null);
const SUPPLIER_ALIASES = {
  name: ["supplier","supplier name","vendor","vendor name","manufacturer","brand","company","seller","supplier/vendor"],
  email: ["supplier email","vendor email","supplier e-mail"],
  phone: ["supplier phone","vendor phone","supplier contact number","supplier mobile"],
  contact_name: ["supplier contact","contact person","sales contact","contact name"],
  category: ["supplier category","supplier type"], address: ["supplier address","vendor address"],
};
const SUPPLIER_ALIAS_TO_FIELD = {};
Object.entries(SUPPLIER_ALIASES).forEach(([f, al]) => al.forEach((a) => (SUPPLIER_ALIAS_TO_FIELD[a] = f)));
const supplierHeader = (h) => (h == null ? null : SUPPLIER_ALIAS_TO_FIELD[String(h).trim().toLowerCase()] || null);
const SUPPLIER_FIELDS = ["email","phone","contact_name","category","address"];
const cleanCell = (v) => { if (v == null) return null; const s = String(v).trim(); return s || null; };

function labelHeaders(headers) {
  const labels = [], seen = {};
  headers.forEach((h, idx) => {
    let base = cleanCell(h) || "Column " + (idx + 1);
    if (seen[base]) { seen[base]++; base = base + " (" + seen[base] + ")"; } else seen[base] = 1;
    labels.push(base);
  });
  return labels;
}

function normalizeRows(headers, rawRows) {
  const result = { rows: [], warnings: [] };
  const labels = labelHeaders(headers);
  const colMap = {}, used = new Set();
  headers.forEach((h, idx) => { const c = canonicalHeader(h); if (c && !used.has(c)) { colMap[idx] = c; used.add(c); } });
  const supMap = {}, supUsed = new Set();
  headers.forEach((h, idx) => { const c = supplierHeader(h); if (c && !supUsed.has(c)) { supMap[idx] = c; supUsed.add(c); } });
  rawRows.forEach((raw, offset) => {
    const rowNo = offset + 2;
    const attributes = {};
    labels.forEach((label, idx) => { const cell = idx < raw.length ? cleanCell(raw[idx]) : null; if (cell != null) attributes[label] = cell; });
    for (let idx = labels.length; idx < raw.length; idx++) { const cell = cleanCell(raw[idx]); if (cell != null) attributes["Column " + (idx + 1)] = cell; }
    if (!Object.keys(attributes).length) return;
    const values = {};
    Object.entries(colMap).forEach(([idx, f]) => { idx = +idx; values[f] = idx < raw.length ? cleanCell(raw[idx]) : null; });
    let name = values.name;
    if (!name) { name = values.sku || Object.values(attributes)[0]; if (used.has("name")) result.warnings.push({ row: rowNo, warning: `Missing name; using "${name}"` }); }
    const row = { name, sku: values.sku || null, unit: values.unit || null, category: values.category || null,
      description: values.description || null, unit_price: null, currency: "USD", min_quantity: 1,
      source_row: rowNo, attributes, supplier_name: null, supplier_info: {} };
    Object.entries(supMap).forEach(([idx, f]) => { const val = +idx < raw.length ? cleanCell(raw[+idx]) : null; if (!val) return; if (f === "name") row.supplier_name = val; else row.supplier_info[f] = val; });
    if (values.unit_price != null) {
      const cleaned = values.unit_price.replace(/,/g, "").replace(/^[$€£\s]+/, "").trim();
      const price = parseFloat(cleaned);
      if (!isNaN(price) && price >= 0) row.unit_price = price;
      else result.warnings.push({ row: rowNo, warning: `Unparseable unit_price "${values.unit_price}"; stored in attributes only` });
    }
    if (values.currency) { const c = values.currency; if (c.length === 3 && /^[a-z]+$/i.test(c)) row.currency = c.toUpperCase();
      else result.warnings.push({ row: rowNo, warning: `Invalid currency "${c}"; defaulting to USD` }); }
    if (values.min_quantity != null) { const qn = parseInt(parseFloat(values.min_quantity), 10);
      if (!isNaN(qn) && qn >= 1) row.min_quantity = qn; else result.warnings.push({ row: rowNo, warning: `Invalid min_quantity "${values.min_quantity}"; defaulting to 1` }); }
    result.rows.push(row);
  });
  return result;
}

function parseCSV(text) {
  text = text.replace(/^﻿/, "");
  const rows = []; let row = [], field = "", q = false, i = 0;
  while (i < text.length) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else { if (c === '"') q = true; else if (c === ",") { row.push(field); field = ""; } else if (c === "\r") {} else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; } else field += c; }
    i++;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const colToIdx = (ref) => { const m = /^([A-Z]+)/.exec(ref); if (!m) return 0; let n = 0; for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
const rowOf = (ref) => parseInt(/(\d+)$/.exec(ref)[1], 10);

async function unzip(buf) {
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  let eocd = -1;
  for (let i = u8.length - 22; i >= 0; i--) { if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) throw new Error("Not a valid zip file");
  const count = dv.getUint16(eocd + 10, true); let off = dv.getUint32(eocd + 16, true);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true), compSize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true), extraLen = dv.getUint16(off + 30, true), commentLen = dv.getUint16(off + 32, true);
    const localOff = dv.getUint32(off + 42, true);
    const name = new TextDecoder().decode(u8.subarray(off + 46, off + 46 + nameLen));
    entries.push({ name, method, compSize, localOff });
    off += 46 + nameLen + extraLen + commentLen;
  }
  const out = {};
  for (const e of entries) {
    if (e.name.endsWith("/")) continue;
    const lnameLen = dv.getUint16(e.localOff + 26, true), lextraLen = dv.getUint16(e.localOff + 28, true);
    const dataStart = e.localOff + 30 + lnameLen + lextraLen;
    const comp = u8.subarray(dataStart, dataStart + e.compSize);
    let bytes;
    if (e.method === 0) bytes = comp.slice();
    else if (e.method === 8) { const ds = new DecompressionStream("deflate-raw"); const ab = await new Response(new Blob([comp]).stream().pipeThrough(ds)).arrayBuffer(); bytes = new Uint8Array(ab); }
    else continue;
    out[e.name] = bytes;
  }
  return out;
}

// --- XLSX parsing (multi-tab aware) ------------------------------------- //
async function openXlsx(buf) {
  const z = await unzip(buf), dec = new TextDecoder();
  const xml = (name) => z[name] ? new DOMParser().parseFromString(dec.decode(z[name]), "application/xml") : null;
  const shared = []; const ss = xml("xl/sharedStrings.xml");
  if (ss) ss.querySelectorAll("si").forEach((si) => shared.push(Array.from(si.querySelectorAll("t")).map((t) => t.textContent).join("")));
  return { z, xml, shared, sheets: xlsxSheetList(z, xml) };
}

// Ordered list of worksheet tabs: [{name, path}].
function xlsxSheetList(z, xml) {
  const wb = xml("xl/workbook.xml"), wbRels = xml("xl/_rels/workbook.xml.rels");
  const rel = {};
  if (wbRels) wbRels.querySelectorAll("Relationship").forEach((r) => (rel[r.getAttribute("Id")] = r.getAttribute("Target")));
  const out = [];
  if (wb) wb.querySelectorAll("sheets > sheet").forEach((s) => {
    const name = s.getAttribute("name") || `Sheet ${out.length + 1}`;
    const rid = s.getAttribute("r:id")
      || s.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
    const target = rid && rel[rid];
    const path = target ? ("xl/" + target.replace(/^\/?xl\//, "")) : null;
    if (path && z[path]) out.push({ name, path });
  });
  if (!out.length) {
    Object.keys(z).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort()
      .forEach((p, i) => out.push({ name: `Sheet ${i + 1}`, path: p }));
  }
  return out;
}

// Extract one worksheet into {headers, rows} (rows = arrays of cell strings).
function xlsxSheetGrid(xml, shared, sheetPath) {
  const sheet = xml(sheetPath); let maxRow = 0; const cellMap = {};
  if (sheet) sheet.querySelectorAll("sheetData > row").forEach((r) => {
    r.querySelectorAll("c").forEach((c) => {
      const ref = c.getAttribute("r"); if (!ref) return;
      const rn = rowOf(ref), ci = colToIdx(ref); maxRow = Math.max(maxRow, rn);
      const t = c.getAttribute("t"); let v = "";
      if (t === "s") { const vEl = c.querySelector("v"); if (vEl) v = shared[+vEl.textContent] || ""; }
      else if (t === "inlineStr") { const tEl = c.querySelector("is t"); if (tEl) v = tEl.textContent; }
      else { const vEl = c.querySelector("v"); if (vEl) v = vEl.textContent; }
      (cellMap[rn] = cellMap[rn] || {})[ci] = v;
    });
  });
  const grid = [];
  for (let rn = 1; rn <= maxRow; rn++) { const cm = cellMap[rn] || {}; const maxc = Math.max(-1, ...Object.keys(cm).map(Number)); const arr = []; for (let c = 0; c <= maxc; c++) arr.push(cm[c] !== undefined ? cm[c] : ""); grid.push(arr); }
  return { headers: grid[0] || [], rows: grid.slice(1) };
}

const _IMG_CT = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", webp: "image/webp" };
const _REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

// Images in one drawing part, each tagged with the cell row it's anchored to.
function _drawingImages(z, xml, dname) {
  const out = [];
  const dxml = xml(dname); if (!dxml) return out;
  const drels = xml("xl/drawings/_rels/" + dname.split("/").pop() + ".rels"); const relTarget = {};
  if (drels) drels.querySelectorAll("Relationship").forEach((r) => (relTarget[r.getAttribute("Id")] = r.getAttribute("Target")));
  dxml.querySelectorAll("*").forEach((node) => {
    if (node.localName !== "oneCellAnchor" && node.localName !== "twoCellAnchor") return;
    const fromRow = node.querySelector("from row"); if (!fromRow) return;
    const rn = parseInt(fromRow.textContent, 10) + 1;  // 0-based anchor → spreadsheet row
    const blip = node.querySelector("blip"); if (!blip) return;
    const embed = blip.getAttribute("r:embed") || blip.getAttributeNS(_REL_NS, "embed");
    let target = relTarget[embed]; if (!target) return;
    const path = ("xl/drawings/" + target).replace(/xl\/drawings\/\.\.\//, "xl/");
    const bytes = z[path]; if (!bytes) return;
    const ext = path.split(".").pop().toLowerCase();
    out.push({ row: rn, bytes, type: _IMG_CT[ext] || "image/png" });
  });
  return out;
}

// All embedded images across the workbook (back-compat, single-sheet).
function xlsxImages(z, xml) {
  let out = [];
  Object.keys(z).filter((n) => /^xl\/drawings\/drawing\d+\.xml$/.test(n))
    .forEach((d) => (out = out.concat(_drawingImages(z, xml, d))));
  return out;
}

// Resolve a relationship Target (possibly "../foo/bar.xml") against a part path.
function _resolveRel(fromPath, target) {
  if (target.startsWith("/")) return target.replace(/^\//, "");
  const dir = fromPath.split("/").slice(0, -1);
  target.split("/").forEach((seg) => { if (seg === "..") dir.pop(); else if (seg !== ".") dir.push(seg); });
  return dir.join("/");
}

// Images belonging to one worksheet (resolved via that sheet's drawing rel).
function xlsxSheetImages(z, xml, sheetPath) {
  const sheetXml = xml(sheetPath); if (!sheetXml) return [];
  const drawingEl = sheetXml.querySelector("drawing"); if (!drawingEl) return [];
  const rid = drawingEl.getAttribute("r:id") || drawingEl.getAttributeNS(_REL_NS, "id");
  const base = sheetPath.split("/").pop();
  const rels = xml(sheetPath.replace(/[^/]+$/, "_rels/" + base + ".rels"));
  if (!rels) return [];
  let target = null;
  rels.querySelectorAll("Relationship").forEach((r) => { if (r.getAttribute("Id") === rid) target = r.getAttribute("Target"); });
  if (!target) return [];
  return _drawingImages(z, xml, _resolveRel(sheetPath, target));
}

// Back-compat: parse just the first worksheet (single-sheet files).
async function parseXLSX(buf) {
  const ctx = await openXlsx(buf);
  const first = (ctx.sheets[0] && ctx.sheets[0].path) || "xl/worksheets/sheet1.xml";
  const { headers, rows } = xlsxSheetGrid(ctx.xml, ctx.shared, first);
  return { headers, rows, images: xlsxImages(ctx.z, ctx.xml) };
}

let _pdfReady = null;
function ensurePdfJs() {
  if (window.pdfjsLib) return Promise.resolve();
  if (_pdfReady) return _pdfReady;
  _pdfReady = new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js"; res(); };
    s.onerror = () => rej(new Error("Could not load the PDF library (internet needed for PDF import)."));
    document.head.appendChild(s);
  });
  return _pdfReady;
}
async function parsePDF(buf) {
  await ensurePdfJs();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const lines = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p); const tc = await page.getTextContent(); const byY = {};
    tc.items.forEach((it) => { const str = (it.str || "").trim(); if (!str) return; const x = it.transform[4], y = Math.round(it.transform[5]); const key = p + ":" + y; (byY[key] = byY[key] || { y, page: p, tokens: [] }).tokens.push({ x, w: it.width || 0, str }); });
    Object.values(byY).forEach((l) => lines.push(l));
  }
  lines.sort((a, b) => a.page - b.page || b.y - a.y);
  const toCells = (line) => { line.tokens.sort((a, b) => a.x - b.x); const cells = []; let cur = null; for (const t of line.tokens) { if (cur && t.x - (cur.x + cur.w) < 18) { cur.str += " " + t.str; cur.w = t.x + t.w - cur.x; } else { cur = { x: t.x, w: t.w, str: t.str }; cells.push(cur); } } return cells; };
  const rowsCells = lines.map(toCells);
  let hi = rowsCells.findIndex((cells) => cells.some((c) => canonicalHeader(c.str) === "name"));
  if (hi < 0) return { headers: [], rows: [], images: [] };
  const headerCells = rowsCells[hi]; const anchors = headerCells.map((c) => c.x + c.w / 2);
  const headers = headerCells.map((c) => c.str); const rows = [];
  for (let i = hi + 1; i < rowsCells.length; i++) { const cells = rowsCells[i]; if (!cells.length) continue; const arr = new Array(anchors.length).fill(""); cells.forEach((c) => { const cx = c.x + c.w / 2; let best = 0, bd = 1e9; anchors.forEach((a, k) => { const d = Math.abs(a - cx); if (d < bd) { bd = d; best = k; } }); arr[best] = arr[best] ? arr[best] + " " + c.str : c.str; }); rows.push(arr); }
  return { headers, rows, images: [] };
}

function readFileAs(file, as) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); if (as === "text") r.readAsText(file); else r.readAsArrayBuffer(file); });
}
async function parseCatalogFile(file) {
  const name = (file.name || "").toLowerCase();
  if (name.endsWith(".csv")) { const rows = parseCSV(await readFileAs(file, "text")); const r = normalizeRows(rows[0] || [], rows.slice(1)); r.images = []; return r; }
  if (name.endsWith(".xlsx")) { const { headers, rows, images } = await parseXLSX(await readFileAs(file, "buf")); const r = normalizeRows(headers, rows); r.images = images; return r; }
  if (name.endsWith(".pdf")) { const { headers, rows } = await parsePDF(await readFileAs(file, "buf")); const r = normalizeRows(headers, rows); r.images = []; return r; }
  throw new Error("Unsupported file type. Please upload a .csv, .xlsx or .pdf file.");
}

// --- AI translation (Chinese → English) on import ----------------------- //
let translateEnabled = false;
fetch("/api/translate/config").then((r) => r.json()).then((c) => { translateEnabled = !!c.enabled; }).catch(() => {});
const CJK_RE = /[㐀-鿿豈-﫿]/;  // CJK ideographs

// If a parsed file contains Chinese text, translate it to English in place,
// keeping the original product name in an "Original Name" attribute. Falls back
// to the original text if translation is unavailable or fails.
async function maybeTranslate(parsed) {
  if (!translateEnabled || !parsed || !parsed.rows || !parsed.rows.length) return parsed;
  const set = new Set();
  const add = (v) => { if (typeof v === "string" && CJK_RE.test(v)) set.add(v); };
  parsed.rows.forEach((r) => {
    add(r.name); add(r.category); add(r.description); add(r.unit);
    if (r.attributes) Object.entries(r.attributes).forEach(([k, v]) => { add(k); add(v); });
  });
  if (!set.size) return parsed;  // no Chinese → nothing to translate
  const uniq = [...set]; const map = {}; const BATCH = 60;
  const chunks = chunk(uniq, BATCH);
  let translated = 0; let lastErr = null;
  showModalBusy(`Translating to English… 0 / ${uniq.length}`);
  // Translate chunks in parallel (bounded) with a per-request timeout. A failed
  // or slow chunk is skipped (its strings stay in the original language) rather
  // than blocking the whole import or freezing on a stalled request.
  await runPool(chunks, async (texts) => {
    try {
      const res = await fetchWithTimeout("/api/translate", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ texts }),
      });
      if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.detail || "Translation failed"); }
      const out = (await res.json()).translations || [];
      texts.forEach((orig, k) => { if (out[k]) map[orig] = out[k]; });
    } catch (e) {
      lastErr = e;
    }
  }, 5, (n) => {
    translated = Math.min(uniq.length, n * BATCH);
    showModalBusy(`Translating to English… ${translated} / ${uniq.length}`);
  });
  if (lastErr && !Object.keys(map).length) {
    toast("Translation unavailable — importing original text. " + lastErr.message, true);
    return parsed;  // nothing translated → import originals
  }
  if (lastErr) toast("Some text couldn't be translated — imported as-is.", true);
  const tr = (v) => (typeof v === "string" && map[v]) ? map[v] : v;
  parsed.rows.forEach((r) => {
    const orig = r.name;
    const na = {};
    if (r.attributes) Object.entries(r.attributes).forEach(([k, v]) => { na[tr(k)] = tr(v); });
    if (orig && map[orig]) { r.name = map[orig]; na["Original Name"] = orig; }  // keep the original (untranslated)
    r.category = tr(r.category); r.description = tr(r.description); r.unit = tr(r.unit);
    r.attributes = na;
  });
  return parsed;
}

// Like parseCatalogFile, but for a multi-tab .xlsx it first asks which tabs to
// import (all selected by default), then concatenates them — every row tagged
// with its "Source Tab". Used by every import path (upload / Chat / Drive).
async function parseCatalogFileWithTabs(file) {
  if (!(file.name || "").toLowerCase().endsWith(".xlsx")) return parseCatalogFile(file);
  const ctx = await openXlsx(await readFileAs(file, "buf"));
  // Single sheet → no picker; multi-tab → ask which tabs (all by default).
  const chosen = ctx.sheets.length <= 1 ? ctx.sheets : await pickXlsxTabs(ctx.sheets);
  return normalizeXlsxTabs(ctx, chosen.length ? chosen : ctx.sheets);
}

// Parse the chosen tabs, merge their rows (each tagged with its "Source Tab"),
// and resolve every embedded image to its row's SKU/name so it attaches to the
// right product — handled per sheet so multi-tab row numbers don't collide.
function normalizeXlsxTabs(ctx, chosen) {
  const rows = [], warnings = [], images = [];
  chosen.forEach((s) => {
    const path = s.path || "xl/worksheets/sheet1.xml";
    const { headers, rows: raw } = xlsxSheetGrid(ctx.xml, ctx.shared, path);
    const r = normalizeRows(headers, raw);
    const byRow = {};
    r.rows.forEach((row) => { (row.attributes = row.attributes || {})["Source Tab"] = s.name; byRow[row.source_row] = row; });
    rows.push(...r.rows);
    r.warnings.forEach((w) => warnings.push({ row: w.row, warning: `[${s.name}] ${w.warning}` }));
    // Map each image (anchored at a spreadsheet row) to that row's product.
    xlsxSheetImages(ctx.z, ctx.xml, path).forEach((img) => {
      const row = byRow[img.row];
      if (row && (row.sku || row.name)) images.push({ bytes: img.bytes, type: img.type, sku: row.sku || null, name: row.name || null });
    });
  });
  return { rows, warnings, images };
}

// Render a tab checklist (with Select all) and resolve to the chosen sheets.
function pickXlsxTabs(sheets) {
  return new Promise((resolve) => {
    document.getElementById("modal-title").textContent = "Choose worksheet tabs";
    const fields = document.getElementById("modal-fields");
    fields.innerHTML = `
      <p class="muted">This Excel has ${sheets.length} tabs — pick which to import.</p>
      <label style="display:block;margin:6px 0;font-weight:600">
        <input type="checkbox" id="tab-all" checked> Select all</label>
      <div id="tab-list" style="max-height:240px;overflow:auto;border-top:1px solid #eee;padding-top:6px">
        ${sheets.map((s, i) => `<label style="display:block;margin:4px 0">
          <input type="checkbox" class="tab-chk" data-i="${i}" checked> ${esc(s.name)}</label>`).join("")}</div>
      <p id="tab-err" class="errs" style="display:none"></p>
      <div style="margin-top:12px"><button class="btn primary" id="tab-go">Import selected tabs</button></div>`;
    setSaveLabel("Close");
    const all = fields.querySelector("#tab-all");
    const chks = [...fields.querySelectorAll(".tab-chk")];
    all.addEventListener("change", () => chks.forEach((c) => (c.checked = all.checked)));
    chks.forEach((c) => c.addEventListener("change", () => (all.checked = chks.every((x) => x.checked))));
    fields.querySelector("#tab-go").addEventListener("click", () => {
      const chosen = chks.filter((c) => c.checked).map((c) => sheets[+c.dataset.i]);
      if (!chosen.length) {
        const e = fields.querySelector("#tab-err"); e.style.display = "block"; e.textContent = "Select at least one tab.";
        return;
      }
      showModalBusy("Reading selected tabs…");
      resolve(chosen);
    });
  });
}

const IMAGE_EXTS = [".jpg",".jpeg",".png",".gif",".webp",".bmp"];
const isImageName = (n) => IMAGE_EXTS.includes((n.match(/\.[^.]+$/) || [""])[0].toLowerCase());
const ctForName = (n) => ({ ".jpg":"image/jpeg",".jpeg":"image/jpeg",".png":"image/png",".gif":"image/gif",".webp":"image/webp",".bmp":"image/bmp" }[(n.match(/\.[^.]+$/) || [""])[0].toLowerCase()] || "application/octet-stream");

// --------------------------------------------------------------------------- //
// Imports: catalog (CSV/XLSX/PDF), quotation (Step 2) and product images
// --------------------------------------------------------------------------- //
const ROW_BATCH = 400;  // rows per request — keeps each payload well under the limit
const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

function mergeSummary(a, b) {
  if (!a) return { ...b, warnings: (b.warnings || []).slice() };
  const out = { ...a };
  ["rows_captured","items_created","items_updated","quotes_created","suppliers_created",
   "images_attached","rows_with_warnings","items_matched","rows_unmatched","rows_without_price",
   "images_stored"].forEach((k) => { if (typeof b[k] === "number") out[k] = (a[k] || 0) + b[k]; });
  out.warnings = (a.warnings || []).concat(b.warnings || []);
  out.item_ids = (a.item_ids || []).concat(b.item_ids || []);  // aligned to input rows
  return out;
}

async function postRows(action, supplier, rows, warnings) {
  const body = { rows, warnings: warnings || [] };
  if (supplier.id) body.supplier_id = +supplier.id;
  if (supplier.name) body.supplier_name = supplier.name;
  if (supplier.type) body.type = supplier.type;
  const res = await fetch(`/api/${action}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || "Import failed");
  return data;
}

// Import all parsed rows in batches; returns the merged summary.
async function importRowsBatched(action, supplier, parsed) {
  if (!parsed.rows.length) {
    throw new Error("No rows found in the file. For PDFs, it must contain a text-based "
      + "table (not a scanned image); otherwise try CSV or Excel.");
  }
  let agg = null;
  const batches = chunk(parsed.rows, ROW_BATCH);
  for (let bi = 0; bi < batches.length; bi++) {
    const part = await postRows(action, supplier, batches[bi], bi === 0 ? parsed.warnings : []);
    agg = mergeSummary(agg, part);
  }
  return agg;
}

// Upload one image (built from raw bytes) — each request stays under the limit.
async function uploadOneImage(filename, bytes, type, supplierId) {
  const fd = new FormData();
  fd.append("file", new File([bytes], filename, { type }));
  if (supplierId) fd.append("supplier_id", supplierId);
  try {
    const res = await fetchWithTimeout("/api/images-import", { method: "POST", body: fd });
    if (!res.ok) return { images_stored: 0, images_unmatched: [filename], files_skipped: [] };
    return res.json();
  } catch {
    return { images_stored: 0, images_unmatched: [filename], files_skipped: [] };
  }
}

// --------------------------------------------------------------------------- //
// AI vision import — for image-only catalogs (slide/brochure PDFs with no text)
// --------------------------------------------------------------------------- //
let visionEnabled = false;
fetch("/api/vision/config").then((r) => r.json()).then((c) => { visionEnabled = !!c.enabled; }).catch(() => {});

function setSaveLabel(text) {
  const b = document.querySelector("#modal-form button[type=submit]");
  if (b) b.textContent = text;
}

// Render each PDF page to a compact JPEG blob (downscaled) using pdf.js.
async function renderPdfPages(file, maxWidth = 1600) {
  await ensurePdfJs();
  const pdf = await pdfjsLib.getDocument({ data: await readFileAs(file, "buf") }).promise;
  const blobs = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(1, maxWidth / base.width);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(vp.width); canvas.height = Math.round(vp.height);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
    blobs.push(await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.82)));
  }
  return blobs;
}

async function visionExtractPage(blob) {
  const fd = new FormData();
  fd.append("file", new File([blob], "page.jpg", { type: "image/jpeg" }));
  let lastErr = "AI extraction failed";
  for (let attempt = 0; attempt < 4; attempt++) {
    let res;
    try {
      res = await fetchWithTimeout("/api/vision/extract", { method: "POST", body: fd }, 60000);
    } catch {
      lastErr = "AI extraction timed out";
      if (attempt === 3) break;
      await new Promise((r) => setTimeout(r, 800 * Math.pow(2, attempt)));
      continue;
    }
    if (res.ok) return res.json();
    const e = await res.json().catch(() => ({}));
    lastErr = e.detail || `AI extraction failed (HTTP ${res.status})`;
    // 400 = misconfig (won't fix on retry); otherwise back off and retry transient
    // / rate-limit / upstream errors a few times.
    if (res.status === 400 || attempt === 3) break;
    await new Promise((r) => setTimeout(r, 800 * Math.pow(2, attempt)));
  }
  throw new Error(lastErr);
}

function productToRow(p, page) {
  const a = {};
  if (p.specification) a["Specification"] = p.specification;
  if (p.color) a["Color"] = p.color;
  if (p.material) a["Material"] = p.material;
  if (p.features) a["Features"] = p.features;
  if (p.usage_scenario) a["Usage Scenario"] = p.usage_scenario;
  a["Source Page"] = String(page);
  return { name: p.name, sku: null, unit: null, category: p.category || null,
    description: p.features || null, unit_price: null, currency: "USD", min_quantity: 1,
    source_row: page, supplier_name: null, supplier_info: {}, attributes: a };
}

// Crop a product's photo from its page image using a normalized [x0,y0,x1,y1] box.
async function cropToBlob(bitmap, box) {
  if (!Array.isArray(box) || box.length !== 4) return null;
  let [x0, y0, x1, y1] = box;
  if ([x0, y0, x1, y1].some((n) => typeof n !== "number")) return null;
  // Tolerate boxes given as percentages.
  if (Math.max(x0, y0, x1, y1) > 1.5) { x0 /= 100; y0 /= 100; x1 /= 100; y1 /= 100; }
  const sx = Math.max(0, Math.min(x0, x1)) * bitmap.width;
  const sy = Math.max(0, Math.min(y0, y1)) * bitmap.height;
  const sw = Math.min(bitmap.width - sx, Math.abs(x1 - x0) * bitmap.width);
  const sh = Math.min(bitmap.height - sy, Math.abs(y1 - y0) * bitmap.height);
  if (sw < 12 || sh < 12) return null;
  const c = document.createElement("canvas");
  c.width = Math.round(sw); c.height = Math.round(sh);
  c.getContext("2d").drawImage(bitmap, sx, sy, sw, sh, 0, 0, c.width, c.height);
  return new Promise((res) => c.toBlob(res, "image/jpeg", 0.85));
}

async function uploadItemImage(itemId, filename, blob) {
  const fd = new FormData();
  fd.append("file", new File([blob], filename, { type: "image/jpeg" }));
  fd.append("catalog_item_id", itemId);
  try {
    const r = await fetchWithTimeout("/api/documents", { method: "POST", body: fd });
    return r.ok;
  } catch {
    return false;
  }
}

// Jump to the Catalog tab, filtered to a supplier, so the user sees their gallery.
function goToSupplierCatalog(supplierId) {
  const tab = document.querySelector('.tab[data-tab="catalog"]');
  document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
  document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
  tab.classList.add("active");
  document.getElementById("catalog").classList.add("active");
  loadCatalog().then(() => {
    const supSel = document.getElementById("catalog-supplier-filter");
    const compSel = document.getElementById("catalog-competitor-filter");
    if (supplierId && supSel) { supSel.value = String(supplierId); if (compSel) compSel.value = "none"; loadCatalog(); }
  });
}

// Full AI flow: render -> extract per page (name + photo box) -> review ->
// (on Save) persist rows, then crop each product's photo and attach it.
async function runVisionFlow(file, supplier, renderSummary) {
  showModalBusy("Rendering catalog pages…");
  const pageBlobs = await renderPdfPages(file);
  const rows = []; const meta = []; let detected = null; let pagesWithProducts = 0;
  let erroredPages = 0; let lastError = null;
  // Read pages in parallel (bounded) — each page is its own AI call, so doing
  // them concurrently turns an N-page wait into roughly N/5. Results are kept
  // per page index so rows/meta stay in page order afterward.
  const pageResults = new Array(pageBlobs.length);
  showModalBusy(`Reading 0 of ${pageBlobs.length} pages with AI…`);
  await runPool(pageBlobs, async (blob, i) => {
    try { pageResults[i] = await visionExtractPage(blob); }
    catch (e) { pageResults[i] = { products: [] }; erroredPages++; lastError = e; }
  }, 5, (n) => showModalBusy(`Reading ${n} of ${pageBlobs.length} pages with AI…`));
  pageResults.forEach((res, i) => {
    if (!res) return;
    if (res.supplier_name && !detected) detected = res.supplier_name;
    const found = (res.products || []).filter((p) => p && p.name);
    found.forEach((p) => { rows.push(productToRow(p, i + 1)); meta.push({ pageIdx: i, box: p.box || null }); });
    if (found.length) pagesWithProducts++;
  });

  const supplierName = supplier.name || detected || file.name.replace(/\.pdf$/i, "");
  if (!rows.length) {
    // If every page errored, the problem is the AI service (e.g. an invalid/expired
    // API key) — show the real error rather than the generic "nothing found".
    const allFailed = erroredPages === pageBlobs.length && lastError;
    document.getElementById("modal-title").textContent = allFailed ? "AI extraction error" : "Nothing found";
    document.getElementById("modal-fields").innerHTML = allFailed
      ? `<p>AI extraction failed on all ${pageBlobs.length} page(s).</p>`
        + `<p class="errs">${esc(lastError.message)}</p>`
        + `<p class="muted">If this mentions authentication or an API key, update `
        + `<code>ANTHROPIC_API_KEY</code> in Vercel (the previous key may have been rotated).</p>`
      : `<p>The AI didn't find any products in this PDF — it may not be a product `
        + `catalog, or the pages are too low-resolution to read.`
        + (erroredPages ? ` (${erroredPages} of ${pageBlobs.length} pages errored.)` : "") + `</p>`;
    setSaveLabel("Close"); onSubmit = async () => true;
    return;
  }

  // Review step.
  document.getElementById("modal-title").textContent = "Review extracted products";
  const list = rows.slice(0, 40).map((r) =>
    `<li>${esc(r.name)}${r.attributes.Material ? ` — <span class="muted">${esc(r.attributes.Material)}</span>` : ""}</li>`).join("");
  const more = rows.length > 40 ? `<li>…and ${rows.length - 40} more</li>` : "";
  document.getElementById("modal-fields").innerHTML = `
    <p><strong>${rows.length}</strong> product(s) found across ${pagesWithProducts} page(s),
       supplier <strong>${esc(supplierName)}</strong>.</p>
    <p class="muted">Review below, then save — each product's photo is cropped from its page.
       You can edit or delete items afterwards.</p>
    <ul class="errs">${list}${more}</ul>`;
  setSaveLabel(`Save ${rows.length} products`);

  onSubmit = async () => {
    const eff = { id: supplier.id || null, name: supplier.id ? null : supplierName, type: supplier.type };
    showModalBusy("Saving products to the catalog…");
    const summary = await importRowsBatched("catalog-import/rows", eff, { rows, warnings: [] });
    const ids = summary.item_ids || [];
    const supId = await resolveSupplierId(supplier.id, supplierName);

    // Which work units we have: one page-image per page that has products, plus
    // one crop per product that came back with a box.
    const pageIdxs = [...new Set(rows.map((_, i) => (ids[i] ? meta[i].pageIdx : null)).filter((v) => v !== null))];
    const cropByPage = {};
    rows.forEach((_, i) => { if (ids[i] && meta[i].box) (cropByPage[meta[i].pageIdx] = cropByPage[meta[i].pageIdx] || []).push(i); });
    const total = pageIdxs.length + Object.values(cropByPage).reduce((n, a) => n + a.length, 0);
    let step = 0, pageImgs = 0, crops = 0;

    // 1) Source page image per page (guaranteed fallback so every card has a photo).
    await runPool(pageIdxs, async (pk) => {
      const fd = new FormData();
      fd.append("file", new File([pageBlobs[pk]], `page-${pk + 1}.jpg`, { type: "image/jpeg" }));
      if (supId) fd.append("supplier_id", supId);
      try { const r = await fetchWithTimeout("/api/documents", { method: "POST", body: fd }); if (r.ok) pageImgs++; }
      catch { /* skip a stalled upload rather than freeze the import */ }
    }, 5, () => showModalBusy(`Saving page images… (${++step}/${total})`));

    // 2) Tight per-product crops where the AI gave a box. Decode each page's
    // bitmap once, then crop + upload in parallel.
    const cropTasks = []; const bitmaps = [];
    for (const pk of Object.keys(cropByPage)) {
      let bitmap;
      try { bitmap = await createImageBitmap(pageBlobs[pk]); } catch (e) { continue; }
      bitmaps.push(bitmap);
      for (const i of cropByPage[pk]) cropTasks.push({ bitmap, i });
    }
    await runPool(cropTasks, async ({ bitmap, i }) => {
      const blob = await cropToBlob(bitmap, meta[i].box);
      if (blob && await uploadItemImage(ids[i], `${(rows[i].name || "item").slice(0, 40)}.jpg`, blob)) crops++;
    }, 5, () => showModalBusy(`Cropping product photos… (${++step}/${total})`));
    bitmaps.forEach((b) => b.close && b.close());
    summary.images_attached = (summary.images_attached || 0) + pageImgs + crops;

    document.getElementById("modal-title").textContent = "Import Complete";
    document.getElementById("modal-fields").innerHTML = renderSummary(summary);
    document.getElementById("modal-extra").innerHTML = "";
    setSaveLabel("View catalog");
    onSubmit = async () => { closeModal(); goToSupplierCatalog(supId); };
    refreshCounts();
    return false;
  };
}

async function resolveSupplierId(id, name) {
  if (id) return +id;
  const list = await api.get("/api/suppliers");
  const s = list.find((x) => (x.name || "").trim().toLowerCase() === (name || "").trim().toLowerCase());
  return s ? s.id : null;
}

function warningList(warnings) {
  if (!warnings || !warnings.length) return "";
  const items = warnings.slice(0, 20).map((w) => `<li>Row ${w.row}: ${esc(w.warning)}</li>`).join("");
  const more = warnings.length > 20 ? `<li>…and ${warnings.length - 20} more</li>` : "";
  return `<ul class="errs">${items}${more}</ul>`;
}

const cap = (s) => s[0].toUpperCase() + s.slice(1);

// Generic upload modal. `forceType` ('supplier'|'reference') fixes which source
// type the import files under (the path decides it, not a toggle). File is parsed
// in the browser and sent in small batches / per-image, so size never hits the limit.
function openUploadModal({ title, kind, accept, fileLabel, renderSummary, extraFooter, supplierMode, forceType }) {
  const noun = forceType === "reference" ? "competitor" : "supplier";
  const opts = suppliersCache.filter((s) => !forceType || (s.type || "supplier") === forceType);
  const fields = [
    { name: "supplier_id", label: `${cap(noun)} (optional)`, type: "select",
      options: [{ value: "", label: "— Auto-detect from file —" }]
        .concat(opts.map((s) => ({ value: s.id, label: s.name }))) },
  ];
  if (supplierMode === "name") fields.push({ name: "supplier_name", label: `…or new ${noun} name (optional)` });
  fields.push({ name: "file", label: fileLabel, type: "file", required: true, accept });

  openModal(title, fields, async (v, form) => {
    const fileInput = form.querySelector('input[name="file"]');
    if (!fileInput.files.length) throw new Error("Please choose a file");
    const file = fileInput.files[0];
    const supplier = { id: v.supplier_id || null, name: (v.supplier_name || "").trim() || null, type: forceType };

    showModalBusy("Parsing file…");
    let summary;
    if (kind === "images") {
      summary = await runImageImport(file, supplier.id);
    } else {
      const parsed = await parseCatalogFileWithTabs(file);
      const isPdf = /\.pdf$/i.test(file.name);
      if (kind === "catalog" && isPdf && !parsed.rows.length) {
        if (!visionEnabled) {
          throw new Error("This PDF has no readable text — it's image-based. AI extraction "
            + "isn't enabled (set ANTHROPIC_API_KEY on the server), so please upload a CSV/Excel.");
        }
        await runVisionFlow(file, supplier, renderSummary);
        return false;
      }
      if (kind === "catalog") await maybeTranslate(parsed);
      const action = kind === "catalog" ? "catalog-import/rows" : "quotation-import/rows";
      summary = await importRowsBatched(action, supplier, parsed);
      if (kind === "catalog" && parsed.images && parsed.images.length) {
        showModalBusy(`Saving ${parsed.images.length} product image(s)…`);
        const sid = await resolveSupplierId(supplier.id, supplier.name);
        summary.images_attached = (summary.images_attached || 0)
          + await attachEmbeddedImages(parsed, sid, summary.item_ids);
      }
    }

    document.getElementById("modal-title").textContent = "Import Complete";
    document.getElementById("modal-extra").innerHTML = "";
    document.getElementById("modal-fields").innerHTML = renderSummary(summary);
    onSubmit = async () => {};
    loadCatalog();
    refreshCounts();
    return false;
  }, extraFooter || "");
}

// Show a lightweight "working" state inside the modal during a long import.
function showModalBusy(msg) {
  document.getElementById("modal-fields").innerHTML =
    `<p class="muted">${esc(msg)} This can take a moment for large files.</p>`;
  document.getElementById("modal-extra").innerHTML = "";
}

// Downscale/compress an image (raw bytes) to a small JPEG before upload, so a
// catalog full of full-resolution photos doesn't take forever to push and store.
// Returns { blob, type } — falls back to the original bytes if decoding fails
// (e.g. an exotic format the browser can't draw) or if it's already small.
async function downscaleToJpeg(bytes, type, maxDim = 1280, quality = 0.82) {
  const orig = { blob: new Blob([bytes], { type: type || "image/png" }), type: type || "image/png" };
  if (typeof createImageBitmap !== "function") return orig;
  let bmp;
  try { bmp = await createImageBitmap(orig.blob); } catch { return orig; }
  try {
    const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    // Tiny images that are already JPEG aren't worth re-encoding.
    if (scale === 1 && bytes.length < 150 * 1024 && /jpe?g/.test(type || "")) return orig;
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(bmp.width * scale));
    c.height = Math.max(1, Math.round(bmp.height * scale));
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise((res) => c.toBlob(res, "image/jpeg", quality));
    // Keep whichever is smaller (re-encoding can occasionally grow a tiny PNG).
    if (blob && blob.size < bytes.length) return { blob, type: "image/jpeg" };
    return orig;
  } catch {
    return orig;
  } finally {
    bmp.close && bmp.close();
  }
}

// Attach .xlsx-embedded images to the items they belong to. Each image carries
// the SKU/name of its anchor row; we map that to the catalog-item id the import
// just created/updated (item_ids is aligned to parsed.rows) and attach by id via
// /api/documents. Matching by id — not by an SKU-encoded filename — means images
// attach even for catalogs that have no SKU column (names only). Each photo is
// downscaled to a small JPEG first so large catalogs upload quickly.
async function attachEmbeddedImages(parsed, supplierId, itemIds) {
  const idBySku = {}, idByName = {};
  const norm = (v) => String(v).trim().toLowerCase();
  (parsed.rows || []).forEach((r, i) => {
    const id = itemIds && itemIds[i];
    if (!id) return;
    if (r.sku) idBySku[r.sku] = id;
    if (r.name) idByName[norm(r.name)] = id;
    // Chinese rows are translated before import, but the image kept the original
    // name — key on that too so the match still lands.
    const orig = r.attributes && r.attributes["Original Name"];
    if (orig) idByName[norm(orig)] = id;
  });
  const tasks = [];
  for (const img of parsed.images || []) {
    const id = (img.sku && idBySku[img.sku]) || (img.name && idByName[norm(img.name)]);
    if (id) tasks.push({ img, id });
  }
  let attached = 0;
  await runPool(tasks, async ({ img, id }) => {
    const { blob, type } = await downscaleToJpeg(img.bytes, img.type);
    const ext = (type.split("/")[1] || "jpg");
    const fd = new FormData();
    fd.append("file", new File([blob], `item-${id}.${ext}`, { type }));
    fd.append("catalog_item_id", id);
    if (supplierId) fd.append("supplier_id", supplierId);
    try { const r = await fetchWithTimeout("/api/documents", { method: "POST", body: fd }); if (r.ok) attached++; }
    catch { /* skip a stalled upload rather than freeze the import */ }
  }, 5, (n) => showModalBusy(`Saving product image(s)… ${n} / ${tasks.length}`));
  return attached;
}

// Image import: unzip in the browser (if a zip) and upload each image separately.
async function runImageImport(file, supplierId) {
  const name = (file.name || "").toLowerCase();
  let entries = [], skipped = [];
  if (name.endsWith(".zip")) {
    const z = await unzip(await readFileAs(file, "buf"));
    for (const [fn, bytes] of Object.entries(z)) {
      const base = fn.split("/").pop();
      if (!base || base.startsWith(".")) continue;
      if (isImageName(fn)) entries.push({ filename: base, bytes, type: ctForName(fn) });
      else skipped.push(base);
    }
  } else if (isImageName(name)) {
    entries.push({ filename: file.name, bytes: new Uint8Array(await readFileAs(file, "buf")), type: file.type || ctForName(name) });
  } else {
    throw new Error("Upload a .zip of images or a single image file (.jpg/.png/…).");
  }
  let stored = 0; const unmatched = [];
  await runPool(entries, async (e) => {
    // Downscale before upload, but keep the SKU filename stem (the server matches
    // images to items by it) — only the extension changes when re-encoded to JPEG.
    const { blob, type } = await downscaleToJpeg(e.bytes, e.type);
    const fname = type === "image/jpeg" ? `${e.filename.replace(/\.[^.]+$/, "")}.jpg` : e.filename;
    const res = await uploadOneImage(fname, blob, type, supplierId);
    stored += res.images_stored || 0;
    (res.images_unmatched || []).forEach((u) => unmatched.push(u));
  }, 5, (n) => showModalBusy(`Uploading images… (${n}/${entries.length})`));
  return { images_stored: stored, images_unmatched: unmatched, files_skipped: skipped };
}

const catalogSummaryHtml = (s) => `
  <p><strong>${s.rows_captured}</strong> row(s) captured —
     <strong>${s.items_created}</strong> created,
     <strong>${s.items_updated}</strong> updated,
     <strong>${s.quotes_created}</strong> quotes,
     <strong>${s.images_attached || 0}</strong> images${
       s.suppliers_created ? `, <strong>${s.suppliers_created}</strong> new source(s)` : ""}.</p>
  ${s.rows_with_warnings
      ? `<p>${s.rows_with_warnings} row(s) imported with warnings:</p>${warningList(s.warnings)}`
      : `<p>No warnings. 🎉</p>`}`;

const quotationSummaryHtml = (s) => `
  <p><strong>${s.quotes_created}</strong> quote(s) recorded across
     <strong>${s.items_matched}</strong> catalog item(s).</p>
  <p class="muted">Rows are matched to existing items by SKU.</p>
  ${(s.rows_unmatched || s.rows_without_price)
      ? `<p>${s.rows_unmatched} unmatched, ${s.rows_without_price} without a price:</p>${warningList(s.warnings)}`
      : `<p>All rows matched. 🎉</p>`}`;

const imagesSummaryHtml = (s) => {
  const unmatched = (s.images_unmatched || []).map((f) => `<li>${esc(f)}</li>`).join("");
  const skipped = (s.files_skipped || []).map((f) => `<li>${esc(f)}</li>`).join("");
  return `
    <p><strong>${s.images_stored}</strong> image(s) matched to products by SKU.</p>
    ${unmatched ? `<p>No matching SKU for:</p><ul class="errs">${unmatched}</ul>` : ""}
    ${skipped ? `<p class="muted">Skipped non-images:</p><ul class="errs">${skipped}</ul>` : ""}
    ${!unmatched && !skipped ? `<p>All images matched. 🎉</p>` : ""}`;
};

// File/AI imports — `forceType` is set by which tab's button was clicked.
async function importFlow(kind, forceType) {
  suppliersCache = await api.get("/api/suppliers");
  const isComp = forceType === "reference";
  if (kind === "catalog") {
    openUploadModal({
      title: isComp ? "Import Competitor Portfolio" : "Import Supplier Catalog",
      kind: "catalog", forceType, supplierMode: "name", accept: ".csv,.xlsx,.pdf",
      fileLabel: `${isComp ? "Portfolio" : "Catalog"} file (.csv, .xlsx, .pdf) — any size. Image-only PDFs are read by AI.`,
      extraFooter: `<a class="btn link" href="/api/catalog-import/template">Download CSV template</a>`,
      renderSummary: catalogSummaryHtml,
    });
  } else if (kind === "quotation") {
    openUploadModal({
      title: "Import Quotation (Step 2)", kind: "quotation", forceType, supplierMode: "name",
      accept: ".csv,.xlsx,.pdf", fileLabel: "Quotation file with SKU + price + MOQ — any size",
      renderSummary: quotationSummaryHtml,
    });
  } else {
    openUploadModal({
      title: "Import Product Images", kind: "images", forceType, supplierMode: "scope",
      accept: ".zip,.jpg,.jpeg,.png,.gif,.webp,.bmp",
      fileLabel: "A .zip of images, or a single image (named by SKU, e.g. BH-01.jpg)",
      renderSummary: imagesSummaryHtml,
    });
  }
}

// Guess a column mapping + first data row from preview rows (handles clean
// headers and header-less scraped sheets).
function guessMapping(rows) {
  const n = Math.max(0, ...rows.map((r) => r.length));
  let headerIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].filter((c) => canonicalHeader(c)).length >= 2) { headerIdx = i; break; }
  }
  const map = {};
  if (headerIdx >= 0) {
    rows[headerIdx].forEach((c, idx) => {
      const f = canonicalHeader(c);
      if (f === "name" && map.name == null) map.name = idx;
      else if (f === "sku" && map.sku == null) map.sku = idx;
      else if (f === "category" && map.sub_category == null) map.sub_category = idx;
      else if (f === "unit_price" && map.price == null) map.price = idx;
      else if (f === "description" && map.description == null) map.description = idx;
    });
    return { firstDataRow: headerIdx + 2, map };
  }
  // No header: name = column with the longest average text.
  const avg = [];
  for (let c = 0; c < n; c++) {
    let s = 0, k = 0;
    rows.forEach((r) => { const v = (r[c] || "").trim(); if (v) { s += v.length; k++; } });
    avg[c] = k ? s / k : 0;
  }
  let best = 0; for (let c = 1; c < n; c++) if (avg[c] > avg[best]) best = c;
  map.name = best;
  let fdr = 1;
  for (let i = 0; i < rows.length; i++) {
    const v = (rows[i][best] || "").trim();
    if (v && !/^[\d.,\s]+$/.test(v) && v.length > 3) { fdr = i + 1; break; }
  }
  return { firstDataRow: fdr, map };
}

const MAP_FIELDS = [
  ["name", "Name", true], ["sku", "SKU", false],
  ["master_category", "Master category", false], ["sub_category", "Sub-category", false],
  ["price", "Price", false], ["description", "Description", false],
];

// Import from a shared Google Sheet: preview → map columns → import.
async function sheetFlow(forceType) {
  suppliersCache = await api.get("/api/suppliers");
  const isComp = forceType === "reference"; const noun = isComp ? "competitor" : "supplier";
  const opts = suppliersCache.filter((s) => (s.type || "supplier") === forceType);
  openModal(`Import from Google Sheet${isComp ? " (Competitor)" : ""}`, [
    { name: "url", label: "Google Sheet link — share as ‘Anyone with the link’", required: true },
    { name: "tab", label: "Tab name (optional — e.g. HomeEss)" },
    { name: "supplier_id", label: `Existing ${noun} (optional)`, type: "select",
      options: [{ value: "", label: `— New ${noun} / from sheet —` }].concat(opts.map((s) => ({ value: s.id, label: s.name }))) },
    { name: "supplier_name", label: `…or new ${noun} name` },
  ], async (v) => {
    const ctx = { url: v.url, tab: (v.tab || "").trim() || null,
      supplier_id: v.supplier_id ? +v.supplier_id : null,
      supplier_name: (v.supplier_name || "").trim() || null, type: forceType };
    showModalBusy("Fetching the sheet…");
    const res = await fetch("/api/sheet-preview", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: ctx.url, tab: ctx.tab }) });
    const pv = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(pv.detail || "Couldn't read the sheet");
    renderSheetMapping(pv.rows || [], pv.ncols || 0, ctx);
    return false;
  });
}

function renderSheetMapping(rows, ncols, ctx) {
  const guess = guessMapping(rows);
  const colOpt = (sel) => `<option value="">— none —</option>` +
    Array.from({ length: ncols }, (_, c) => {
      const sample = (rows[guess.firstDataRow - 1] || [])[c] || (rows[guess.firstDataRow] || [])[c] || "";
      return `<option value="${c}" ${sel === c ? "selected" : ""}>Col ${c + 1}${sample ? " — " + esc(String(sample).slice(0, 24)) : ""}</option>`;
    }).join("");

  const previewRows = rows.slice(0, 6).map((r, ri) =>
    `<tr><td class="rownum">${ri + 1}</td>${Array.from({ length: ncols }, (_, c) =>
      `<td>${esc((r[c] || "").slice(0, 22))}</td>`).join("")}</tr>`).join("");

  const fieldRows = MAP_FIELDS.map(([f, label, req]) =>
    `<div class="field"><label>${label}${req ? " *" : ""}</label>
      <select id="map-${f}">${colOpt(guess.map[f])}</select></div>`).join("");

  document.getElementById("modal-title").textContent = "Map columns";
  document.getElementById("modal-fields").innerHTML = `
    <p class="muted">Preview — pick which column holds each field, and the first product row.</p>
    <div class="map-preview"><table><tbody>${previewRows}</tbody></table></div>
    <div class="field"><label>First product row</label>
      <input type="number" id="map-firstrow" min="1" value="${guess.firstDataRow}" /></div>
    ${fieldRows}`;
  document.getElementById("modal-extra").innerHTML = "";
  setSaveLabel("Import");

  onSubmit = async () => {
    const mapping = {};
    MAP_FIELDS.forEach(([f]) => { const val = document.getElementById(`map-${f}`).value; if (val !== "") mapping[f] = +val; });
    if (mapping.name == null) throw new Error("Please map the Name column.");
    const firstRow = Math.max(1, +document.getElementById("map-firstrow").value || 1);
    showModalBusy("Importing…");
    const body = { url: ctx.url, tab: ctx.tab, type: ctx.type, first_data_row: firstRow,
      header_row: firstRow > 1 ? firstRow - 1 : null, mapping };
    if (ctx.supplier_id) body.supplier_id = ctx.supplier_id;
    if (ctx.supplier_name) body.supplier_name = ctx.supplier_name;
    const res = await fetch("/api/sheet-import-mapped", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const s = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(s.detail || "Import failed");
    document.getElementById("modal-title").textContent = "Import Complete";
    document.getElementById("modal-fields").innerHTML = catalogSummaryHtml(s);
    setSaveLabel("Save");
    onSubmit = async () => {};
    loadCatalog(); refreshCounts();
    return false;
  };
}

// Import a catalog attachment straight from Google Chat (owner integration).
async function chatFlow(forceType) {
  const st = await api.get("/api/google/status").catch(() => ({}));
  if (!st.configured) {
    return toast("Google Chat isn't set up yet — add GOOGLE_CLIENT_ID/SECRET in Vercel.", true);
  }
  if (!st.connected) {
    openModal("Connect Google Chat", [], async () => { window.location.href = "/api/google/connect"; return false; });
    document.getElementById("modal-fields").innerHTML =
      `<p>Connect your Google account to import catalogs straight from Chat.</p>
       <p class="muted">You'll be redirected to Google to authorize, then back here.</p>`;
    setSaveLabel("Connect Google");
    return;
  }
  const noun = forceType === "reference" ? "competitor" : "supplier";
  openModal(`Import from Google Chat`, [], async () => true);  // Save just closes
  const fields = document.getElementById("modal-fields");
  fields.innerHTML = `<p class="muted">Loading your Chat spaces…</p>`;
  setSaveLabel("Close");
  let spaces = [];
  try { spaces = await api.get("/api/chat/spaces"); }
  catch (e) { fields.innerHTML = `<p class="errs">${esc(e.message)}</p>`; return; }
  // Float "WeChat transfers" (the usual catalog space) to the top so it's the default.
  spaces.sort((a, b) => (/wechat/i.test(b.displayName || "") ? 1 : 0) - (/wechat/i.test(a.displayName || "") ? 1 : 0));
  fields.innerHTML = `
    <div class="field"><label>Space / DM</label>
      <select id="chat-space">${spaces.map((s) => `<option value="${esc(s.name)}">${esc(s.displayName)}</option>`).join("")}</select></div>
    <div class="field"><label>New ${noun} name (optional)</label><input id="chat-supname" /></div>
    <div id="chat-files" class="muted">Loading files…</div>`;
  const loadFiles = async () => {
    const sp = document.getElementById("chat-space").value;
    const fc = document.getElementById("chat-files");
    fc.innerHTML = "Loading files…";
    let files = [];
    try { files = await api.get(`/api/chat/files?space=${encodeURIComponent(sp)}`); }
    catch (e) { fc.innerHTML = `<p class="errs">${esc(e.message)}</p>`; return; }
    if (!files.length) { fc.innerHTML = `<p class="muted">No file attachments in this space.</p>`; return; }
    fc.innerHTML = `
      <div class="field"><label>File</label>
        <select id="chat-file">${files.map((f, i) =>
          `<option value="${i}">${esc(f.filename || "file")}${f.sender ? " · " + esc(f.sender) : ""}</option>`).join("")}</select></div>
      <button class="btn primary" id="chat-import-btn">Import selected file</button>`;
    fc.querySelector("#chat-import-btn").addEventListener("click", () =>
      importChatFile(files[+document.getElementById("chat-file").value], forceType));
  };
  document.getElementById("chat-space").addEventListener("change", loadFiles);
  if (spaces.length) loadFiles(); else fields.querySelector("#chat-files").innerHTML = `<p class="muted">No Chat spaces found.</p>`;
}

// Import a catalog file straight from a Google Drive folder (e.g. the folder
// your WhatsApp catalogs get saved into). Reuses the Chat download+import
// pipeline — Drive files carry a driveFileId that /api/chat/download accepts.
async function driveFlow(forceType) {
  const st = await api.get("/api/google/status").catch(() => ({}));
  if (!st.configured) {
    return toast("Google isn't set up yet — add GOOGLE_CLIENT_ID/SECRET in Vercel.", true);
  }
  if (!st.connected) {
    openModal("Connect Google", [], async () => { window.location.href = "/api/google/connect"; return false; });
    document.getElementById("modal-fields").innerHTML =
      `<p>Connect your Google account to import catalogs from Drive.</p>
       <p class="muted">You'll be redirected to Google to authorize, then back here.</p>`;
    setSaveLabel("Connect Google");
    return;
  }
  const noun = forceType === "reference" ? "competitor" : "supplier";
  openModal("Import from Google Drive", [], async () => true);  // Save just closes
  const fields = document.getElementById("modal-fields");
  fields.innerHTML = `<p class="muted">Loading your Drive folders…</p>`;
  setSaveLabel("Close");
  let folders = [];
  try { folders = await api.get("/api/drive/folders"); }
  catch (e) { fields.innerHTML = `<p class="errs">${esc(e.message)}</p>`; return; }
  fields.innerHTML = `
    <div class="field"><label>Drive folder</label>
      <select id="drive-folder"><option value="">— Choose a folder —</option>${
        folders.map((f) => `<option value="${esc(f.id)}">${esc(f.name)}</option>`).join("")}</select></div>
    <div class="field"><label>…or paste a folder link</label>
      <input id="drive-link" placeholder="https://drive.google.com/drive/folders/…" /></div>
    <div class="field"><label>New ${noun} name (optional)</label><input id="chat-supname" /></div>
    <div id="chat-files" class="muted">Pick a folder to load files…</div>`;
  const loadFiles = async () => {
    const link = (document.getElementById("drive-link").value || "").trim();
    const folder = link || (document.getElementById("drive-folder").value || "");
    const fc = document.getElementById("chat-files");
    if (!folder) { fc.innerHTML = `<p class="muted">Select a folder, or paste a folder link above.</p>`; return; }
    fc.innerHTML = "Loading files…";
    let files = [];
    try { files = await api.get(`/api/drive/files?folder=${encodeURIComponent(folder)}`); }
    catch (e) { fc.innerHTML = `<p class="errs">${esc(e.message)}</p>`; return; }
    try { localStorage.setItem("driveFolder", folder); } catch (e) {}  // remember last-used
    if (!files.length) { fc.innerHTML = `<p class="muted">No files in this folder.</p>`; return; }
    fc.innerHTML = `
      <div class="field"><label>File</label>
        <select id="chat-file">${files.map((f, i) =>
          `<option value="${i}">${esc(f.filename || "file")}</option>`).join("")}</select></div>
      <button class="btn primary" id="chat-import-btn">Import selected file</button>`;
    fc.querySelector("#chat-import-btn").addEventListener("click", () =>
      importChatFile(files[+document.getElementById("chat-file").value], forceType));
  };
  document.getElementById("drive-folder").addEventListener("change", loadFiles);
  let deb; document.getElementById("drive-link").addEventListener("input", () => {
    clearTimeout(deb); deb = setTimeout(loadFiles, 600);
  });

  // Default to the server-configured folder, else the last one used on this browser.
  let def = ""; try { def = st.drive_folder || localStorage.getItem("driveFolder") || ""; } catch (e) {}
  if (def) {
    const sel = document.getElementById("drive-folder");
    if ([...sel.options].some((o) => o.value === def)) sel.value = def;
    else document.getElementById("drive-link").value = def;
    loadFiles();
  }
}

// Pull a Chat attachment into the browser in byte-range slices, so files larger
// than the serverless response limit still come through. Returns a File.
const CHAT_CHUNK = 3 * 1024 * 1024;
async function downloadChatFileChunked(f, filename) {
  const fmt = (n) => (n / (1024 * 1024)).toFixed(1) + " MB";
  const fetchChunk = async (offset) => {
    const qs = new URLSearchParams({ filename, offset: String(offset), length: String(CHAT_CHUNK) });
    if (f.resourceName) qs.set("resourceName", f.resourceName);
    if (f.driveFileId) qs.set("driveFileId", f.driveFileId);
    const res = await fetch(`/api/chat/download?${qs.toString()}`);
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.detail || "Download failed"); }
    const total = +(res.headers.get("X-Total-Size") || 0);
    return { blob: await res.blob(), total };
  };

  const first = await fetchChunk(0);
  const parts = [first.blob];
  let got = first.blob.size;
  const total = first.total || got;
  while (got < total) {
    showModalBusy(`Downloading ${filename}… ${fmt(got)} / ${fmt(total)}`);
    const next = await fetchChunk(got);
    if (!next.blob.size) break;  // guard against a stall
    parts.push(next.blob);
    got += next.blob.size;
  }
  const type = first.blob.type || "application/octet-stream";
  return new File(parts, filename, { type });
}

async function importChatFile(f, forceType) {
  // Capture the supplier name before showModalBusy wipes the chat fields.
  const supname = ((document.getElementById("chat-supname") || {}).value || "").trim();
  const supplier = { id: null, name: supname || null, type: forceType };
  const filename = f.filename || "catalog";

  // Pull the raw bytes into the browser in chunks so even large files clear the
  // serverless response limit, then run the same AI/text pipeline as direct uploads.
  showModalBusy(`Downloading ${filename}…`);
  let file;
  try {
    file = await downloadChatFileChunked(f, filename);
  } catch (e) {
    document.getElementById("modal-fields").innerHTML = `<p class="errs">${esc(e.message)}</p>`;
    setSaveLabel("Close"); onSubmit = async () => true;
    return;
  }

  try {
    showModalBusy("Parsing file…");
    const parsed = await parseCatalogFileWithTabs(file);
    if (/\.pdf$/i.test(filename) && !parsed.rows.length) {
      if (!visionEnabled) {
        throw new Error("This PDF is image-based and AI extraction isn't enabled "
          + "(set ANTHROPIC_API_KEY on the server).");
      }
      await runVisionFlow(file, supplier, catalogSummaryHtml);  // takes over the modal
      return;
    }
    await maybeTranslate(parsed);
    const summary = await importRowsBatched("catalog-import/rows", supplier, parsed);
    if (parsed.images && parsed.images.length) {
      showModalBusy(`Saving ${parsed.images.length} product image(s)…`);
      const sid = await resolveSupplierId(supplier.id, supplier.name);
      summary.images_attached = (summary.images_attached || 0)
        + await attachEmbeddedImages(parsed, sid, summary.item_ids);
    }
    document.getElementById("modal-title").textContent = "Import Complete";
    document.getElementById("modal-fields").innerHTML = catalogSummaryHtml(summary);
    setSaveLabel("Done"); onSubmit = async () => {};
    loadCatalog(); refreshCounts();
  } catch (e) {
    document.getElementById("modal-fields").innerHTML = `<p class="errs">${esc(e.message)}</p>`;
    setSaveLabel("Close"); onSubmit = async () => true;
  }
}

document.querySelectorAll("[data-import]").forEach((b) => b.addEventListener("click", () => {
  const kind = b.dataset.import, type = b.dataset.srctype;
  if (kind === "sheet") sheetFlow(type);
  else if (kind === "chat") chatFlow(type);
  else if (kind === "drive") driveFlow(type);
  else importFlow(kind, type);
}));

// Surface the result of the Google OAuth redirect.
(() => {
  const p = new URLSearchParams(location.search).get("chat");
  if (p === "connected") toast("Google Chat connected");
  else if (p === "error") toast("Google Chat connection failed", true);
  if (p) history.replaceState({}, "", location.pathname);
})();

// --------------------------------------------------------------------------- //
// Quotes
// --------------------------------------------------------------------------- //
async function loadQuotes() {
  await ensureItems();
  const filter = document.getElementById("quote-item-filter");
  const current = filter.value;
  filter.innerHTML =
    `<option value="">All catalog items</option>` +
    itemsCache.map((i) => `<option value="${i.id}">${esc(i.name)}</option>`).join("");
  filter.value = current;

  const tbody = document.querySelector("#quotes-table tbody");
  tbody.innerHTML = skeletonRows(6);
  const url =
    "/api/quotes" + (filter.value ? `?catalog_item_id=${filter.value}` : "");
  const quotes = await api.get(url);
  if (!quotes.length) {
    tbody.innerHTML = emptyState(6, ICONS.tag, "No quotes yet",
      "Import a quotation or add a price to a catalog item.");
    refreshCounts();
    return;
  }
  tbody.innerHTML = quotes
    .map(
      (q) => `<tr>
        <td>${esc(itemName(q.catalog_item_id))}</td>
        <td><span class="price">${q.unit_price.toFixed(2)}</span> ${esc(q.currency)}</td>
        <td>${q.min_quantity}</td><td>${esc(q.valid_from) || "—"}</td>
        <td>${esc(q.valid_until) || "—"}</td>
        <td class="right">
          <button class="btn link" onclick="editQuote(${q.id})">Edit</button>
          <button class="btn danger-text" onclick="deleteQuote(${q.id})">Delete</button>
        </td></tr>`
    )
    .join("");
  refreshCounts();
}

function quoteFields(q = {}) {
  return [
    {
      name: "catalog_item_id", label: "Catalog item", type: "select", required: true,
      value: q.catalog_item_id,
      options: itemsCache.map((i) => ({ value: i.id, label: i.name })),
    },
    { name: "unit_price", label: "Unit price", type: "number", step: "0.01", min: 0,
      required: true, value: q.unit_price },
    { name: "currency", label: "Currency (3-letter)", value: q.currency || "USD" },
    { name: "min_quantity", label: "Min quantity", type: "number", min: 1,
      value: q.min_quantity || 1 },
    { name: "valid_from", label: "Valid from", type: "date", value: q.valid_from },
    { name: "valid_until", label: "Valid until", type: "date", value: q.valid_until },
    { name: "notes", label: "Notes", type: "textarea", value: q.notes },
  ];
}

function prepQuote(v) {
  const out = cleanEmpty(v);
  out.catalog_item_id = Number(out.catalog_item_id);
  out.unit_price = Number(out.unit_price);
  out.min_quantity = Number(out.min_quantity || 1);
  return out;
}

document.getElementById("add-quote").addEventListener("click", async () => {
  await ensureItems();
  if (!itemsCache.length) return toast("Add a catalog item first", true);
  openModal("Add Quote", quoteFields(), async (v) => {
    await api.post("/api/quotes", prepQuote(v));
    toast("Quote created");
    loadQuotes();
  });
});

window.editQuote = async (id) => {
  await ensureItems();
  const q = await api.get(`/api/quotes/${id}`);
  openModal("Edit Quote", quoteFields(q), async (v) => {
    await api.put(`/api/quotes/${id}`, prepQuote(v));
    toast("Quote updated");
    loadQuotes();
  });
};

window.deleteQuote = async (id) => {
  if (!confirm("Delete this quote?")) return;
  await api.del(`/api/quotes/${id}`);
  toast("Quote deleted");
  loadQuotes();
};

document.getElementById("quote-item-filter").addEventListener("change", loadQuotes);

// --------------------------------------------------------------------------- //
// Documents
// --------------------------------------------------------------------------- //
async function loadDocuments() {
  const tbody = document.querySelector("#documents-table tbody");
  tbody.innerHTML = skeletonRows(6);
  await ensureSuppliers();
  await ensureItems();
  const docs = await api.get("/api/documents");
  if (!docs.length) {
    tbody.innerHTML = emptyState(6, ICONS.doc, "No documents yet",
      "Upload spec sheets, certificates or images.");
    refreshCounts();
    return;
  }
  tbody.innerHTML = docs
    .map(
      (d) => `<tr>
        <td><div class="cell-with-thumb">
          ${d.kind === "image"
            ? `<img class="thumb" src="/api/documents/${d.id}/download" alt="" />`
            : `<span class="thumb thumb-ph">${ICONS.doc}</span>`}
          <span>${esc(d.filename)}</span></div></td>
        <td>${esc(d.content_type) || "—"}</td>
        <td>${fmtSize(d.size_bytes)}</td>
        <td>${d.supplier_id ? esc(supplierName(d.supplier_id)) : "—"}</td>
        <td>${d.catalog_item_id ? esc(itemName(d.catalog_item_id)) : "—"}</td>
        <td class="right">
          <a class="btn link" href="/api/documents/${d.id}/download">Download</a>
          <button class="btn danger-text" onclick="deleteDocument(${d.id})">Delete</button>
        </td></tr>`
    )
    .join("");
  refreshCounts();
}

document.getElementById("add-document").addEventListener("click", async () => {
  await ensureSuppliers();
  await ensureItems();
  openModal(
    "Upload Document",
    [
      { name: "file", label: "File", type: "file", required: true },
      {
        name: "supplier_id", label: "Attach to supplier", type: "select",
        options: [{ value: "", label: "— none —" }].concat(
          suppliersCache.map((s) => ({ value: s.id, label: s.name }))
        ),
      },
      {
        name: "catalog_item_id", label: "Attach to catalog item", type: "select",
        options: [{ value: "", label: "— none —" }].concat(
          itemsCache.map((i) => ({ value: i.id, label: i.name }))
        ),
      },
    ],
    async (v, form) => {
      const fd = new FormData();
      const fileInput = form.querySelector('input[name="file"]');
      if (!fileInput.files.length) throw new Error("Please choose a file");
      fd.append("file", fileInput.files[0]);
      if (v.supplier_id) fd.append("supplier_id", v.supplier_id);
      if (v.catalog_item_id) fd.append("catalog_item_id", v.catalog_item_id);
      const res = await fetch("/api/documents", { method: "POST", body: fd });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.detail || "Upload failed");
      }
      toast("Document uploaded");
      loadDocuments();
    }
  );
});

window.deleteDocument = async (id) => {
  if (!confirm("Delete this document?")) return;
  await api.del(`/api/documents/${id}`);
  toast("Document deleted");
  loadDocuments();
};

// --------------------------------------------------------------------------- //
// Coverage — competitor portfolio vs supplier catalog (AI-classified taxonomy)
// --------------------------------------------------------------------------- //
let taxonomyEnabled = false, embedEnabled = false, embedModel = null;
fetch("/api/taxonomy/config").then((r) => r.json()).then((c) => {
  taxonomyEnabled = !!c.enabled; embedEnabled = !!c.embed_enabled; embedModel = c.embed_model || null;
}).catch(() => {});
// The high-volume classify step goes to the free local embeddings backend when
// it's available, else the paid LLM. (Deriving a taxonomy still needs the LLM.)
const classifyUrl = () => (embedEnabled ? "/api/taxonomy/classify-embed" : "/api/taxonomy/classify");
const classifierNote = () => embedEnabled
  ? `<p class="muted">Using the free local classifier${embedModel ? ` (${esc(embedModel)})` : ""} — no AI credits.</p>` : "";

// Latest computed gaps (competitor covers, suppliers don't), largest first —
// stashed so the "View gaps" popup can list them all.
let coverageGaps = [];
window.viewGaps = function () {
  openModal(`Biggest gaps (${coverageGaps.length})`, [], async () => {});
  const list = coverageGaps.map((g, i) =>
    `<div class="sumrow gap-row" onclick="gapToCatalog(${i})" title="Show the competitor products in this gap">
      <span>${esc(g.m)} › ${esc(g.s)}</span><span class="num">${g.ref}</span></div>`).join("");
  document.getElementById("modal-fields").innerHTML =
    `<p class="muted">Categories competitors cover that your suppliers don't — the number is how many competitor products sit in that gap. Click a row to see those products. Largest first.</p>`
    + `<div class="sum-table" style="max-height:60vh;overflow:auto">${list || '<p class="muted">No gaps. 🎉</p>'}</div>`;
  document.getElementById("modal-extra").innerHTML = "";
};

// Open the Catalog filtered to one gap's category, scoped to competitors (who
// have products there) — so you can see exactly what defines the gap.
window.gapToCatalog = async function (i) {
  const g = coverageGaps[i];
  if (!g) return;
  closeModal();
  document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
  document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
  document.querySelector('.tab[data-tab="catalog"]').classList.add("active");
  document.getElementById("catalog").classList.add("active");
  const $ = (id) => document.getElementById(id);
  await loadCatalog();                          // ensure dropdown options exist
  $("catalog-supplier-filter").value = "none";
  $("catalog-competitor-filter").value = "all";
  await loadCatalog();                          // master options now reflect competitors
  $("catalog-master-filter").value = g.m;
  await loadCatalog();                          // sub options now reflect that master
  $("catalog-sub-filter").value = g.s;
  await loadCatalog();
};

async function loadCoverage() {
  const body = document.getElementById("coverage-body");
  body.innerHTML = `<p class="muted">Loading…</p>`;
  // Use the compact stats (counts), not the full item list.
  const [suppliers, stats] = await Promise.all([
    api.get("/api/suppliers"), api.get("/api/catalog-items/stats")]);
  suppliersCache = suppliers;
  const typeById = {}; suppliers.forEach((s) => (typeById[s.id] = s.type || "supplier"));

  // Reference-brand selector.
  const brandSel = document.getElementById("coverage-brand");
  const refs = suppliers.filter((s) => s.type === "reference");
  const cur = brandSel.value;
  brandSel.innerHTML = `<option value="">All reference brands</option>` +
    refs.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("");
  brandSel.value = cur;

  const isRef = (r) => typeById[r.supplier_id] === "reference" && (!brandSel.value || r.supplier_id === +brandSel.value);
  const isSup = (r) => typeById[r.supplier_id] === "supplier";
  const classifiedTotal = stats.filter((r) => r.master_category).reduce((n, r) => n + r.count, 0);

  if (!refs.length) {
    body.innerHTML = info("Add a competitor to benchmark",
      "Add a competitor (Home Centre, Nestasia…) on the Competitors tab and import its catalog. Suppliers' coverage is measured against it.");
    return;
  }
  if (!classifiedTotal) {
    body.innerHTML = info("Curate categories first",
      taxonomyEnabled ? "On the Competitors tab, click “Curate categories” to consolidate and classify every product."
        : "AI classification isn't enabled (set ANTHROPIC_API_KEY on the server).");
    return;
  }

  // Build master -> sub -> {ref, sup} counts from the stats rows.
  const tree = {};
  const tally = (rows, key) => rows.forEach((r) => {
    if (!r.master_category) return;
    const m = r.master_category, s = r.sub_category || "—";
    ((tree[m] = tree[m] || {})[s] = tree[m][s] || { ref: 0, sup: 0 })[key] += r.count;
  });
  tally(stats.filter(isRef), "ref"); tally(stats.filter(isSup), "sup");

  // Coverage = of sub-categories the reference covers, how many a supplier also covers.
  let refSubs = 0, coveredSubs = 0; const gaps = [];
  Object.entries(tree).forEach(([m, subs]) => Object.entries(subs).forEach(([s, c]) => {
    if (c.ref > 0) { refSubs++; if (c.sup > 0) coveredSubs++; else gaps.push({ m, s, ref: c.ref }); }
  }));
  const pct = refSubs ? Math.round((coveredSubs / refSubs) * 100) : 0;
  gaps.sort((a, b) => b.ref - a.ref);
  coverageGaps = gaps;

  const masters = Object.keys(tree).sort();
  const rows = masters.map((m) => {
    const subs = Object.entries(tree[m]).sort((a, b) => b[1].ref - a[1].ref);
    const subRows = subs.map(([s, c]) => {
      const status = c.ref === 0 ? `<span class="pill gray">supplier-only</span>`
        : c.sup > 0 ? `<span class="pill ok">covered</span>` : `<span class="pill gap">gap</span>`;
      return `<tr><td></td><td>${esc(s)}</td><td class="num">${c.ref || "—"}</td>
        <td class="num">${c.sup || "—"}</td><td>${status}</td></tr>`;
    }).join("");
    const mref = subs.reduce((n, [, c]) => n + c.ref, 0), msup = subs.reduce((n, [, c]) => n + c.sup, 0);
    return `<tr class="master"><td><strong>${esc(m)}</strong></td><td></td>
      <td class="num"><strong>${mref || "—"}</strong></td><td class="num"><strong>${msup || "—"}</strong></td><td></td></tr>${subRows}`;
  }).join("");

  body.innerHTML = `
    <div class="cards">
      <div class="card"><div class="card-n">${pct}%</div><div class="card-l">category coverage</div></div>
      <div class="card"><div class="card-n">${coveredSubs}/${refSubs}</div><div class="card-l">sub-categories covered</div></div>
      <div class="card${gaps.length ? " clickable" : ""}"${gaps.length ? ' onclick="viewGaps()" title="View all gaps"' : ""}><div class="card-n">${gaps.length}</div><div class="card-l">gaps (competitor has, you don't)</div></div>
    </div>
    ${gaps.length ? `<div class="gaps-box">
      <h3>Biggest gaps</h3>
      <p class="muted" style="margin:0 0 10px">${gaps.length} categories competitors cover that your suppliers don't — top one is <strong>${esc(gaps[0].m)} › ${esc(gaps[0].s)}</strong> (${gaps[0].ref}).</p>
      <button class="btn" onclick="viewGaps()">View all ${gaps.length} gaps →</button></div>` : ""}
    <div class="table-wrap" style="margin-top:18px"><table class="cov-table">
      <thead><tr><th>Master</th><th>Sub-category</th><th class="num">Competitor</th><th class="num">Suppliers</th><th>Status</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
}

function info(title, sub) {
  return `<div class="empty">${ICONS.box}<div class="empty-title">${esc(title)}</div><div class="empty-sub">${esc(sub)}</div></div>`;
}

// Re-derive ONE consolidated taxonomy across ALL products and re-classify
// everything into it. Uses the app modal (not a blocking confirm()) so the
// click stays responsive, and shows progress.
document.getElementById("curate-ai").addEventListener("click", async () => {
  if (!taxonomyEnabled) return toast("AI isn't enabled (set ANTHROPIC_API_KEY)", true);
  const [sups, stats] = await Promise.all([api.get("/api/suppliers"), api.get("/api/catalog-items/stats")]);
  const nameById = Object.fromEntries(sups.map((s) => [s.id, s.name]));
  const typeById = Object.fromEntries(sups.map((s) => [s.id, s.type || "supplier"]));
  const totalBy = {}; let grand = 0, unclassified = 0;
  stats.forEach((r) => { totalBy[r.supplier_id] = (totalBy[r.supplier_id] || 0) + r.count; grand += r.count; if (!r.master_category) unclassified += r.count; });
  const sources = Object.entries(totalBy).map(([id, n]) => ({ id: +id, n })).sort((a, b) => b.n - a.n);

  openModal("Curate categories", [], async () => {
    const fields = document.getElementById("modal-fields");
    const scope = (fields.querySelector("#curate-scope") || {}).value || "all";
    await new Promise((r) => setTimeout(r, 0));  // let the modal paint first
    try {
      const items = await api.get("/api/catalog-items");
      if (!items.length) { fields.innerHTML = "<p>No products to classify.</p>"; setSaveLabel("Done"); onSubmit = async () => {}; return false; }
      // Always rebuild ONE consolidated taxonomy from the whole catalog so the
      // vocabulary stays global; only the re-file step below is scoped.
      fields.innerHTML = `<p class="muted">Deriving a consolidated taxonomy from ${items.length} products…</p>`;
      const uniq = (f) => [...new Set(items.map(f).filter(Boolean))];
      const samples = uniq((i) => i.master_category).concat(uniq((i) => i.sub_category))
        .concat(uniq((i) => i.category)).concat(items.slice(0, 400).map((i) => i.name));
      const tax = await postJsonRetry("/api/taxonomy/suggest", { samples }, { timeoutMs: 90000 });
      const ncat = (tax.categories || []).length;

      // What to (re-)file into the new taxonomy — scoped to save effort.
      const todo = scope === "all" ? items
        : scope === "unclassified" ? items.filter((i) => !i.master_category)
          : items.filter((i) => i.supplier_id === +scope);
      if (!todo.length) {
        fields.innerHTML = "<p>Nothing to re-file for that selection. 🎉</p>";
        setSaveLabel("Done"); onSubmit = async () => {}; loadCompetitors(); return false;
      }

      // Classify in parallel (bounded), retrying transient failures per batch and
      // saving each batch as it lands so progress is durable. A batch that still
      // fails after retries is counted, not fatal — the run always finishes.
      const batches = chunk(todo, 40);
      let done = 0, failed = 0, lastErr = null;
      await runPool(batches, async (b) => {
        try {
          const res = await postJsonRetry(classifyUrl(), {
            taxonomy: tax, items: b.map((i) => ({ id: i.id, name: i.name, category: i.sub_category || i.category })),
          });
          if (res.items && res.items.length) await postJsonRetry("/api/taxonomy/save", { items: res.items }, { method: "PUT" });
        } catch (e) {
          failed += b.length; lastErr = e;
        }
        done += b.length;
        fields.innerHTML = `<p class="muted">Filing products into ${ncat} categories… (${done}/${todo.length})</p>`;
      }, 5);

      fields.innerHTML = failed
        ? `<p><strong>Curated ${todo.length - failed} of ${todo.length}</strong> products into ${ncat} categories.</p>`
          + `<p class="errs">${esc(failureReason(lastErr, failed))}</p>${apiKeyHintIf(failed === todo.length && !embedEnabled)}`
        : `<p><strong>Curated ${done} products</strong> into ${ncat} categories. 🎉</p>`;
      setSaveLabel("Done"); onSubmit = async () => {};
      loadCompetitors(); refreshCounts();
    } catch (err) {
      fields.innerHTML = info("Curation failed", err.message);
      setSaveLabel("Close"); onSubmit = async () => {};
    }
    return false;
  });

  const opt = (s) => {
    const tag = typeById[s.id] === "reference" ? " (competitor)" : "";
    return `<option value="${s.id}">${esc(nameById[s.id] || ("#" + s.id))}${tag} — ${s.n} items</option>`;
  };
  document.getElementById("modal-fields").innerHTML = `
    <div class="field"><label>Re-file</label>
      <select id="curate-scope">
        <option value="all">All products — re-file everything (${grand})</option>
        ${unclassified ? `<option value="unclassified">Only unclassified items (${unclassified})</option>` : ""}
        ${sources.map(opt).join("")}
      </select></div>
    <p class="muted">Curate always rebuilds one consolidated taxonomy from the whole catalog. Choose
       what to re-file into it: everything, only the unclassified items, or a single source — so you
       don't re-spend AI credits on products that are already filed. Runs in parallel and always finishes.</p>
    ${classifierNote()}`;
  setSaveLabel("Curate");
});

// Bulk-assign a master/sub category to whatever items are currently in view
// (the active supplier/competitor/category/search filters) — e.g. filter to a
// supplier's "Other" pile and give them a real home. Seeds the taxonomy too, so
// future Curate keeps the category.
document.getElementById("set-category").addEventListener("click", async () => {
  if (!itemsCache.length) return toast("No items in view — filter the catalog first.", true);
  const ids = itemsCache.map((i) => i.id);
  openModal("Set category", [], async () => {
    const fields = document.getElementById("modal-fields");
    const M = (fields.querySelector("#setcat-master") || {}).value;
    const S = (fields.querySelector("#setcat-sub") || {}).value;
    const master = (M || "").trim(), sub = (S || "").trim();
    if (!master) throw new Error("Enter a master category.");
    let done = 0;
    await runPool(chunk(ids, 200), async (b) => {
      await postJsonRetry("/api/taxonomy/save",
        { items: b.map((id) => ({ id, master_category: master, sub_category: sub || null })) }, { method: "PUT" });
      done += b.length;
      fields.innerHTML = `<p class="muted">Setting category on ${done}/${ids.length} item(s)…</p>`;
    }, 4);
    fields.innerHTML = `<p><strong>Set ${ids.length} item(s)</strong> to “${esc(master)}${sub ? " › " + esc(sub) : ""}”. 🎉</p>`;
    setSaveLabel("Done"); onSubmit = async () => {};
    loadCatalog(); refreshCounts();
    return false;
  });
  const fields = document.getElementById("modal-fields");
  fields.innerHTML = `<p class="muted">Loading categories…</p>`;
  setSaveLabel(`Set category for ${ids.length}`);
  const stats = await api.get("/api/catalog-items/stats").catch(() => []);
  const masters = [...new Set(stats.map((r) => r.master_category).filter(Boolean))].sort();
  const subs = [...new Set(stats.map((r) => r.sub_category).filter(Boolean))].sort();
  fields.innerHTML = `
    <p class="muted">Assign a category to the <strong>${ids.length}</strong> item(s) currently in view
       (matching the active filters/search). Pick an existing one or type a new category.</p>
    <div class="field"><label>Master category</label>
      <input id="setcat-master" list="setcat-masters" placeholder="e.g. Home Storage & Organization" autocomplete="off" /></div>
    <datalist id="setcat-masters">${masters.map((m) => `<option value="${esc(m)}">`).join("")}</datalist>
    <div class="field"><label>Sub-category (optional)</label>
      <input id="setcat-sub" list="setcat-subs" placeholder="e.g. Bins & Waste Management" autocomplete="off" /></div>
    <datalist id="setcat-subs">${subs.map((s) => `<option value="${esc(s)}">`).join("")}</datalist>`;
});

// Preview + remove banner/summary rows that aren't real products.
document.getElementById("cleanup-junk").addEventListener("click", () => {
  openModal("Remove junk rows", [], async () => {
    const fields = document.getElementById("modal-fields");
    await new Promise((r) => setTimeout(r, 0));
    const dry = await api.post("/api/catalog-items/cleanup?dry_run=true", {});
    if (!dry.count) { fields.innerHTML = "<p>No junk rows found. 🎉</p>"; setSaveLabel("Done"); onSubmit = async () => {}; return false; }
    const list = dry.names.map((n) => `<li>${esc(n || "(blank)")}</li>`).join("");
    const more = dry.count > dry.names.length ? `<li>…and ${dry.count - dry.names.length} more</li>` : "";
    fields.innerHTML = `<p><strong>${dry.count}</strong> non-product row(s) found:</p><ul class="errs">${list}${more}</ul>`;
    setSaveLabel(`Delete ${dry.count}`);
    onSubmit = async () => {
      fields.innerHTML = `<p class="muted">Removing…</p>`;
      const r = await api.post("/api/catalog-items/cleanup", {});
      fields.innerHTML = `<p><strong>Removed ${r.count}</strong> junk row(s). 🎉</p>`;
      setSaveLabel("Done"); onSubmit = async () => {};
      loadCatalog(); refreshCounts();
      return false;
    };
    return false;
  });
  document.getElementById("modal-fields").innerHTML = `<p class="muted">Scanning for banner/summary rows that aren't real products…</p>`;
  setSaveLabel("Scan");
});

// Clean up duplicate product photos (and surface duplicate suppliers) left by
// repeated imports. Shows a report first, then removes only exact duplicates.
document.getElementById("dedupe-images").addEventListener("click", () => {
  openModal("Clean up duplicates", [], async () => {
    const fields = document.getElementById("modal-fields");
    await new Promise((r) => setTimeout(r, 0));
    const rep = await api.get("/api/maintenance/duplicates");
    const imgN = rep.duplicate_images ? rep.duplicate_images.removable : 0;
    const sups = rep.duplicate_suppliers || [];
    const supList = sups.length
      ? `<p><strong>${sups.length}</strong> duplicate supplier name(s) — review these manually:</p>`
        + `<ul class="errs">${sups.map((s) => `<li>${esc(s.name)} ×${s.count}</li>`).join("")}</ul>`
      : "";
    if (!imgN) {
      fields.innerHTML = `<p>No duplicate images found. 🎉</p>${supList}`;
      setSaveLabel("Done"); onSubmit = async () => {};
      return false;
    }
    fields.innerHTML = `<p><strong>${imgN}</strong> duplicate image(s) can be removed `
      + `(one copy of each photo is kept).</p>${supList}`;
    setSaveLabel(`Remove ${imgN}`);
    onSubmit = async () => {
      fields.innerHTML = `<p class="muted">Removing duplicates…</p>`;
      const r = await api.post("/api/maintenance/dedupe-images", {});
      fields.innerHTML = `<p><strong>Removed ${r.removed}</strong> duplicate image(s). 🎉</p>${supList}`;
      setSaveLabel("Done"); onSubmit = async () => {};
      loadCatalog(); refreshCounts();
      return false;
    };
    return false;
  });
  document.getElementById("modal-fields").innerHTML = `<p class="muted">Scanning for duplicate images…</p>`;
  setSaveLabel("Scan");
});

document.getElementById("coverage-brand").addEventListener("change", loadCoverage);

// Classify unclassified items INTO the existing (competitor) taxonomy so
// supplier and competitor products share one vocabulary; fall back to deriving
// a taxonomy only when nothing is classified yet.
const isOtherCat = (m) => /^(other|uncategorized)$/i.test((m || "").trim());
document.getElementById("classify-ai").addEventListener("click", async () => {
  if (!taxonomyEnabled && !embedEnabled) return toast("Classification isn't enabled (set ANTHROPIC_API_KEY, or the embeddings backend)", true);
  // Per source: items that still need a real category — either unclassified (no
  // master) or sitting in the "Other" bucket — so the dropdown only offers work.
  const [sups, stats] = await Promise.all([api.get("/api/suppliers"), api.get("/api/catalog-items/stats")]);
  const nameById = Object.fromEntries(sups.map((s) => [s.id, s.name]));
  const typeById = Object.fromEntries(sups.map((s) => [s.id, s.type || "supplier"]));
  const blankBy = {}, otherBy = {};
  stats.forEach((r) => {
    if (!r.master_category) blankBy[r.supplier_id] = (blankBy[r.supplier_id] || 0) + r.count;
    else if (isOtherCat(r.master_category)) otherBy[r.supplier_id] = (otherBy[r.supplier_id] || 0) + r.count;
  });
  const ids = [...new Set([...Object.keys(blankBy), ...Object.keys(otherBy)].map(Number))];
  const remaining = ids.map((id) => ({ id, u: blankBy[id] || 0, o: otherBy[id] || 0 }))
    .filter((r) => r.u + r.o > 0).sort((a, b) => (b.u + b.o) - (a.u + a.o));
  const totalU = remaining.reduce((s, r) => s + r.u, 0);
  const totalO = remaining.reduce((s, r) => s + r.o, 0);

  openModal("Classify with AI", [], async () => {
    const fields = document.getElementById("modal-fields");
    const scope = (fields.querySelector("#classify-scope") || {}).value || "all";
    const which = (fields.querySelector("#classify-which") || {}).value || "both";
    await new Promise((r) => setTimeout(r, 0));  // let the modal paint first
    try {
      const items = await api.get("/api/catalog-items");
      const inScope = scope === "all" ? items : items.filter((i) => i.supplier_id === +scope);
      const elig = (i) => {
        const blank = !i.master_category, other = isOtherCat(i.master_category);
        return which === "blank" ? blank : which === "other" ? other : (blank || other);
      };
      const todo = inScope.filter(elig);
      if (!todo.length) {
        fields.innerHTML = "<p>Nothing to (re)classify for that selection. 🎉</p>";
        setSaveLabel("Done"); onSubmit = async () => {}; loadCoverage(); return false;
      }
      // Build the taxonomy from REAL categories only (exclude Other/Uncategorized)
      // so re-filing 'Other' items is pushed toward a genuine category. Derive a
      // fresh one only if nothing real is classified yet.
      const existing = items.filter((i) => i.master_category && !isOtherCat(i.master_category));
      let tax;
      if (existing.length) {
        const tree = {};
        existing.forEach((i) => { (tree[i.master_category] = tree[i.master_category] || new Set()).add(i.sub_category || "General"); });
        tax = { categories: Object.entries(tree).map(([m, subs]) => ({ master: m, subs: [...subs] })) };
        fields.innerHTML = `<p class="muted">Aligning to the existing taxonomy (${tax.categories.length} categories)…</p>`;
      } else if (taxonomyEnabled) {
        fields.innerHTML = `<p class="muted">Deriving categories from ${items.length} products…</p>`;
        const samples = [...new Set(items.map((i) => i.category).filter(Boolean))]
          .concat(items.slice(0, 300).map((i) => i.name));
        tax = await postJsonRetry("/api/taxonomy/suggest", { samples }, { timeoutMs: 90000 });
      } else {
        // Embeddings can only file into an existing taxonomy; creating one needs the LLM.
        throw new Error("No categories exist yet. Run “Curate categories” first (that step needs the AI key) to create the taxonomy.");
      }
      const batches = chunk(todo, 40);
      let done = 0, failed = 0, lastErr = null;
      await runPool(batches, async (b) => {
        try {
          const res = await postJsonRetry(classifyUrl(), {
            taxonomy: tax, items: b.map((i) => ({ id: i.id, name: i.name, category: i.category })),
          });
          if (res.items && res.items.length) await postJsonRetry("/api/taxonomy/save", { items: res.items }, { method: "PUT" });
        } catch (e) {
          failed += b.length; lastErr = e;
        }
        done += b.length;
        fields.innerHTML = `<p class="muted">Classifying products… (${done}/${todo.length})</p>`;
      }, 5);
      fields.innerHTML = failed
        ? `<p><strong>Classified ${todo.length - failed} of ${todo.length}</strong> products.</p>`
          + `<p class="errs">${esc(failureReason(lastErr, failed))}</p>${apiKeyHintIf(failed === todo.length && !embedEnabled)}`
        : `<p><strong>Classified ${done} products.</strong> 🎉</p>`;
      setSaveLabel("Done"); onSubmit = async () => {};
      loadCoverage();
    } catch (err) {
      fields.innerHTML = info("Classification failed", err.message);
      setSaveLabel("Close"); onSubmit = async () => {};
    }
    return false;
  });

  if (!remaining.length) {
    document.getElementById("modal-fields").innerHTML = "<p>Everything is already filed into real categories. 🎉</p>";
    setSaveLabel("Done"); onSubmit = async () => { loadCoverage(); };
    return;
  }
  const opt = (r) => {
    const tag = typeById[r.id] === "reference" ? " (competitor)" : "";
    const bits = [r.u ? `${r.u} unclassified` : "", r.o ? `${r.o} in Other` : ""].filter(Boolean).join(", ");
    return `<option value="${r.id}">${esc(nameById[r.id] || ("#" + r.id))}${tag} — ${bits}</option>`;
  };
  const allBits = [totalU ? `${totalU} unclassified` : "", totalO ? `${totalO} in Other` : ""].filter(Boolean).join(", ");
  document.getElementById("modal-fields").innerHTML = `
    <div class="field"><label>Source</label>
      <select id="classify-scope">
        <option value="all">All sources — ${allBits}</option>
        ${remaining.map(opt).join("")}
      </select></div>
    <div class="field"><label>Which items</label>
      <select id="classify-which">
        <option value="both">Unclassified + items in “Other”</option>
        <option value="blank">Only unclassified</option>
        <option value="other">Only items in “Other”</option>
      </select></div>
    <p class="muted">Pick a source and which items to (re)file — e.g. one supplier’s “Other” products.
       “Other” items are pushed into a real category where one fits. Runs in parallel;
       the dialog stays open until it finishes.</p>
    ${classifierNote()}`;
  setSaveLabel("Classify");
});

// --------------------------------------------------------------------------- //
// Utilities & bootstrap
// --------------------------------------------------------------------------- //
function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// Dismiss the modal with Escape or by clicking the dimmed backdrop.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !document.getElementById("modal-overlay").classList.contains("hidden")) {
    closeModal();
  }
});
document.getElementById("modal-overlay").addEventListener("click", (e) => {
  if (e.target.id === "modal-overlay") closeModal();
});

// Dropdown menus (e.g. the Import menu): toggle on the trigger; any other click
// closes open menus (selecting a .dd-item runs its own action, then closes here).
document.addEventListener("click", (e) => {
  const toggle = e.target.closest("[data-dd-toggle]");
  const active = toggle ? toggle.closest(".dropdown") : null;
  document.querySelectorAll(".dropdown.open").forEach((d) => { if (d !== active) d.classList.remove("open"); });
  if (active) active.classList.toggle("open");
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") document.querySelectorAll(".dropdown.open").forEach((d) => d.classList.remove("open"));
});

// Point the top-bar "Google Drive" link at the configured catalog folder, if set.
fetch("/api/google/status").then((r) => r.json()).then((s) => {
  const a = document.getElementById("drive-link-top");
  if (a && s && s.drive_folder) a.href = `https://drive.google.com/drive/folders/${s.drive_folder}`;
}).catch(() => {});

loadSuppliers();
refreshCounts();
