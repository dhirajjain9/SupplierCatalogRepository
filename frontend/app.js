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
    const [s, c, q, d] = await Promise.all([
      api.get("/api/suppliers"), api.get("/api/catalog-items"),
      api.get("/api/quotes"), api.get("/api/documents"),
    ]);
    const set = (key, n) => {
      const el = document.querySelector(`.count[data-count="${key}"]`);
      if (el) el.textContent = n ? ` ${n}` : "";
    };
    set("suppliers", s.filter((x) => (x.type || "supplier") !== "reference").length);
    set("competitors", s.filter((x) => x.type === "reference").length);
    set("catalog", c.length); set("quotes", q.length); set("documents", d.length);
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
  document.getElementById("modal-overlay").classList.add("hidden");
  document.getElementById("modal-extra").innerHTML = "";
  setSaveLabel("Save");
  onSubmit = null;
}
document.getElementById("modal-close").addEventListener("click", closeModal);
document.getElementById("modal-cancel").addEventListener("click", closeModal);
let modalSubmitting = false;
document.getElementById("modal-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (modalSubmitting) return;  // ignore double-clicks / repeat submits
  const form = e.target;
  const saveBtn = form.querySelector('button[type=submit]');
  const values = {};
  new FormData(form).forEach((v, k) => (values[k] = v));
  modalSubmitting = true;
  if (saveBtn) saveBtn.disabled = true;
  try {
    // A handler may return false to keep the modal open (e.g. to show a summary).
    const keepOpen = await onSubmit(values, form);
    if (keepOpen !== false) closeModal();
  } catch (err) {
    toast(err.message, true);
  } finally {
    modalSubmitting = false;
    if (saveBtn) saveBtn.disabled = false;
  }
});

// --------------------------------------------------------------------------- //
// Suppliers (type=supplier) and Competitors (type=reference) — same renderer
// --------------------------------------------------------------------------- //
const SRC = {
  supplier: { tableId: "suppliers-table", searchId: "supplier-search", noun: "supplier",
              empty: "No suppliers yet", emptySub: "Add a supplier or import a catalog." },
  reference: { tableId: "competitors-table", searchId: "competitor-search", noun: "competitor",
               empty: "No competitors yet", emptySub: "Add a competitor brand or import its portfolio." },
};

async function loadSources(type) {
  const cfg = SRC[type];
  const tbody = document.querySelector(`#${cfg.tableId} tbody`);
  const q = document.getElementById(cfg.searchId).value.trim();
  tbody.innerHTML = skeletonRows(6);
  const params = new URLSearchParams({ type });
  if (q) params.set("search", q);
  const list = await api.get(`/api/suppliers?${params}`);
  if (!list.length) {
    tbody.innerHTML = q
      ? emptyState(6, ICONS.box, "No matches", `Nothing matches “${q}”.`)
      : emptyState(6, ICONS.box, cfg.empty, cfg.emptySub);
    refreshCounts();
    return;
  }
  tbody.innerHTML = list.map((s) => `<tr>
      <td>${esc(s.name)}</td>
      <td>${esc(s.contact_name) || "—"}</td>
      <td>${esc(s.email) || "—"}</td><td>${esc(s.phone) || "—"}</td>
      <td>${s.category ? `<span class="pill">${esc(s.category)}</span>` : "—"}</td>
      <td class="right">
        <button class="btn link" onclick="editSupplier(${s.id},'${type}')">Edit</button>
        <button class="btn danger-text" onclick="deleteSupplier(${s.id},'${type}')">Delete</button>
      </td></tr>`).join("");
  refreshCounts();
}
const loadSuppliers = () => loadSources("supplier");

// --------------------------------------------------------------------------- //
// Competitors — portfolio cards + drill-in summary (products by master → sub)
// --------------------------------------------------------------------------- //
async function loadCompetitors() {
  const body = document.getElementById("competitors-body");
  body.innerHTML = `<p class="muted">Loading…</p>`;
  const q = document.getElementById("competitor-search").value.trim().toLowerCase();
  const [sups, stats] = await Promise.all([
    api.get("/api/suppliers?type=reference"), api.get("/api/catalog-items/stats"),
  ]);
  let refs = sups;
  if (q) refs = refs.filter((s) => (s.name || "").toLowerCase().includes(q));
  if (!refs.length) {
    body.innerHTML = info("No competitors yet",
      "Add a competitor brand or import its portfolio (file / Google Sheet).");
    return;
  }
  // per supplier: total + master -> count, and whether classified
  const bySup = {};
  stats.forEach((r) => {
    const b = (bySup[r.supplier_id] = bySup[r.supplier_id] || { total: 0, masters: {}, unclassified: 0 });
    b.total += r.count;
    if (r.master_category) b.masters[r.master_category] = (b.masters[r.master_category] || 0) + r.count;
    else b.unclassified += r.count;
  });
  body.innerHTML = `<div class="cards comp-cards">` + refs.map((s) => {
    const b = bySup[s.id] || { total: 0, masters: {}, unclassified: 0 };
    const tops = Object.entries(b.masters).sort((a, c) => c[1] - a[1]).slice(0, 4);
    const maxN = tops.length ? tops[0][1] : 1;
    const bars = tops.map(([m, n]) =>
      `<div class="cbar"><span class="cbar-l">${esc(m)}</span>
        <span class="cbar-track"><span class="cbar-fill" style="width:${Math.round(n / maxN * 100)}%"></span></span>
        <span class="cbar-n">${n}</span></div>`).join("")
      || `<p class="muted" style="font-size:12.5px">Not categorized yet — click “Curate categories”.</p>`;
    return `<div class="ccard">
      <div class="ccard-head">
        <div><div class="ccard-name">${esc(s.name)}</div>
          <div class="muted" style="font-size:12.5px">${b.total} products${b.unclassified ? ` · ${b.unclassified} uncategorized` : ""}</div></div>
      </div>
      <div class="ccard-bars">${bars}</div>
      <div class="ccard-foot">
        <button class="btn link" onclick="viewCompetitor(${s.id})">Summary →</button>
        <span class="spacer"></span>
        <button class="btn link" onclick="editSupplier(${s.id},'reference')">Edit</button>
        <button class="btn danger-text" onclick="deleteSupplier(${s.id},'reference')">Delete</button>
      </div></div>`;
  }).join("") + `</div>`;
}

window.viewCompetitor = async function (id) {
  const body = document.getElementById("competitors-body");
  body.innerHTML = `<p class="muted">Loading…</p>`;
  const [sups, stats] = await Promise.all([
    api.get("/api/suppliers?type=reference"), api.get("/api/catalog-items/stats"),
  ]);
  const sup = sups.find((s) => s.id === id) || { name: "#" + id };
  const mine = stats.filter((r) => r.supplier_id === id);
  const total = mine.reduce((n, r) => n + r.count, 0);
  // master -> {total, subs:{sub:count}}
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
      <button class="btn" onclick="loadCompetitors()">← Competitors</button>
      <h3>${esc(sup.name)} <span class="muted">· ${total} products</span></h3>
      <span class="spacer"></span>
      <button class="btn" onclick="viewSupplierProducts(${id})">View products →</button>
    </div>
    <div class="table-wrap sum-table">${sections}</div>`;
};

// Jump to the Catalog tab filtered to this source.
window.viewSupplierProducts = function (id) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
  document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
  document.querySelector('.tab[data-tab="catalog"]').classList.add("active");
  document.getElementById("catalog").classList.add("active");
  loadCatalog().then(() => {
    const sel = document.getElementById("catalog-supplier-filter");
    if (sel) { sel.value = String(id); loadCatalog(); }
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
    loadSources(type);
  });
}

window.editSupplier = async (id, type) => {
  const s = await api.get(`/api/suppliers/${id}`);
  openModal("Edit", supplierFields(s), async (v) => {
    await api.put(`/api/suppliers/${id}`, cleanEmpty(v));
    toast("Saved");
    loadSources(type || s.type || "supplier");
  });
};

window.deleteSupplier = async (id, type) => {
  if (!confirm("Delete this and all its items, quotes and documents?")) return;
  await api.del(`/api/suppliers/${id}`);
  toast("Deleted");
  loadSources(type || "supplier");
};

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
      <button class="btn danger-text" onclick="deleteItem(${i.id})">Delete</button>
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
  const filter = document.getElementById("catalog-supplier-filter");
  const current = filter.value;
  filter.innerHTML =
    `<option value="">All sources</option>` +
    suppliersCache.map((s) => `<option value="${s.id}">${esc(s.name)}${s.type === "reference" ? " (competitor)" : ""}</option>`).join("");
  filter.value = current;

  // Master / Sub-category filters (cascading) from the curated taxonomy.
  const mSel = document.getElementById("catalog-master-filter");
  const sSel = document.getElementById("catalog-sub-filter");
  const curMaster = mSel.value, curSub = sSel.value;
  const stats = await api.get("/api/catalog-items/stats");
  const masters = [...new Set(stats.map((r) => r.master_category).filter(Boolean))].sort();
  mSel.innerHTML = `<option value="">All master categories</option>` +
    masters.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join("");
  mSel.value = masters.includes(curMaster) ? curMaster : "";
  const subs = [...new Set(stats.filter((r) => !mSel.value || r.master_category === mSel.value)
    .map((r) => r.sub_category).filter(Boolean))].sort();
  sSel.innerHTML = `<option value="">All sub-categories</option>` +
    subs.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("");
  sSel.value = subs.includes(curSub) ? curSub : "";

  const q = document.getElementById("catalog-search").value.trim();
  const params = new URLSearchParams();
  if (filter.value) params.set("supplier_id", filter.value);
  if (mSel.value) params.set("master_category", mSel.value);
  if (sSel.value) params.set("sub_category", sSel.value);
  if (q) params.set("search", q);
  const url = "/api/catalog-items" + (params.toString() ? `?${params}` : "");
  itemsCache = await api.get(url);

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
    const filtering = q || filter.value || mSel.value || sSel.value;
    const title = filtering ? "No matching items" : "No catalog items yet";
    const sub = filtering ? "Try clearing the search or filters." : "Import a catalog or add an item to begin.";
    gallery.innerHTML = `<div class="gallery-empty">${ICONS.box}<div class="empty-title">${title}</div><div class="empty-sub">${sub}</div></div>`;
    tbody.innerHTML = emptyState(6, ICONS.box, title, sub);
    refreshCounts();
    return;
  }

  if (catalogView === "gallery") {
    gallery.innerHTML = itemsCache.map((i) => catalogCard(i, thumbFor(i))).join("");
  } else {
    tbody.innerHTML = itemsCache.map((i) => {
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
          <button class="btn danger-text" onclick="deleteItem(${i.id})">Delete</button>
        </td></tr>`;
    }).join("");
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

window.deleteItem = async (id) => {
  if (!confirm("Delete this item and its quotes and documents?")) return;
  await api.del(`/api/catalog-items/${id}`);
  toast("Item deleted");
  loadCatalog();
};

document.getElementById("catalog-supplier-filter").addEventListener("change", loadCatalog);
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

async function parseXLSX(buf) {
  const z = await unzip(buf), dec = new TextDecoder();
  const xml = (name) => z[name] ? new DOMParser().parseFromString(dec.decode(z[name]), "application/xml") : null;
  const shared = []; const ss = xml("xl/sharedStrings.xml");
  if (ss) ss.querySelectorAll("si").forEach((si) => shared.push(Array.from(si.querySelectorAll("t")).map((t) => t.textContent).join("")));
  let sheetPath = "xl/worksheets/sheet1.xml";
  const wb = xml("xl/workbook.xml"), wbRels = xml("xl/_rels/workbook.xml.rels");
  if (wb && wbRels) { const first = wb.querySelector("sheets > sheet"); const rid = first && first.getAttribute("r:id");
    if (rid) { const rel = Array.from(wbRels.querySelectorAll("Relationship")).find((r) => r.getAttribute("Id") === rid); if (rel) sheetPath = "xl/" + rel.getAttribute("Target").replace(/^\/?xl\//, ""); } }
  if (!z[sheetPath]) { const k = Object.keys(z).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort(); if (k.length) sheetPath = k[0]; }
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
  const headers = grid[0] || [], rows = grid.slice(1);
  const images = []; const ctMap = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", bmp: "image/bmp", webp: "image/webp" };
  for (const dname of Object.keys(z).filter((n) => /^xl\/drawings\/drawing\d+\.xml$/.test(n))) {
    const dxml = xml(dname); const drels = xml("xl/drawings/_rels/" + dname.split("/").pop() + ".rels"); const relTarget = {};
    if (drels) drels.querySelectorAll("Relationship").forEach((r) => (relTarget[r.getAttribute("Id")] = r.getAttribute("Target")));
    dxml && dxml.querySelectorAll("*").forEach((node) => {
      if (node.localName !== "oneCellAnchor" && node.localName !== "twoCellAnchor") return;
      const fromRow = node.querySelector("from row"); if (!fromRow) return;
      const rn = parseInt(fromRow.textContent, 10) + 1;
      const blip = node.querySelector("blip"); if (!blip) return;
      const embed = blip.getAttribute("r:embed") || blip.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "embed");
      let target = relTarget[embed]; if (!target) return;
      const path = ("xl/drawings/" + target).replace(/xl\/drawings\/\.\.\//, "xl/");
      const bytes = z[path]; if (!bytes) return;
      const ext = path.split(".").pop().toLowerCase();
      images.push({ row: rn, bytes, type: ctMap[ext] || "image/png" });
    });
  }
  return { headers, rows, images };
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
  const res = await fetch("/api/images-import", { method: "POST", body: fd });
  if (!res.ok) return { images_stored: 0, images_unmatched: [filename], files_skipped: [] };
  return res.json();
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
  const res = await fetch("/api/vision/extract", { method: "POST", body: fd });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.detail || "AI extraction failed"); }
  return res.json();
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
  const r = await fetch("/api/documents", { method: "POST", body: fd });
  return r.ok;
}

// Jump to the Catalog tab, filtered to a supplier, so the user sees their gallery.
function goToSupplierCatalog(supplierId) {
  const tab = document.querySelector('.tab[data-tab="catalog"]');
  document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
  document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
  tab.classList.add("active");
  document.getElementById("catalog").classList.add("active");
  loadCatalog().then(() => {
    const sel = document.getElementById("catalog-supplier-filter");
    if (supplierId && sel) { sel.value = String(supplierId); loadCatalog(); }
  });
}

// Full AI flow: render -> extract per page (name + photo box) -> review ->
// (on Save) persist rows, then crop each product's photo and attach it.
async function runVisionFlow(file, supplier, renderSummary) {
  showModalBusy("Rendering catalog pages…");
  const pageBlobs = await renderPdfPages(file);
  const rows = []; const meta = []; let detected = null; let pagesWithProducts = 0;
  for (let i = 0; i < pageBlobs.length; i++) {
    showModalBusy(`Reading page ${i + 1} of ${pageBlobs.length} with AI…`);
    let res;
    try { res = await visionExtractPage(pageBlobs[i]); } catch (e) { res = { products: [] }; }
    if (res.supplier_name && !detected) detected = res.supplier_name;
    const found = (res.products || []).filter((p) => p && p.name);
    found.forEach((p) => { rows.push(productToRow(p, i + 1)); meta.push({ pageIdx: i, box: p.box || null }); });
    if (found.length) pagesWithProducts++;
  }

  const supplierName = supplier.name || detected || file.name.replace(/\.pdf$/i, "");
  if (!rows.length) {
    document.getElementById("modal-title").textContent = "Nothing found";
    document.getElementById("modal-fields").innerHTML =
      `<p>The AI didn't find any products in this PDF — it may not be a product ` +
      `catalog, or the pages are too low-resolution to read.</p>`;
    setSaveLabel("Save"); onSubmit = async () => {};
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
    for (const pk of pageIdxs) {
      showModalBusy(`Saving page images… (${++step}/${total})`);
      const fd = new FormData();
      fd.append("file", new File([pageBlobs[pk]], `page-${pk + 1}.jpg`, { type: "image/jpeg" }));
      if (supId) fd.append("supplier_id", supId);
      const r = await fetch("/api/documents", { method: "POST", body: fd });
      if (r.ok) pageImgs++;
    }
    // 2) Tight per-product crops where the AI gave a box.
    for (const pk of Object.keys(cropByPage)) {
      let bitmap;
      try { bitmap = await createImageBitmap(pageBlobs[pk]); } catch (e) { continue; }
      for (const i of cropByPage[pk]) {
        showModalBusy(`Cropping product photos… (${++step}/${total})`);
        const blob = await cropToBlob(bitmap, meta[i].box);
        if (blob && await uploadItemImage(ids[i], `${(rows[i].name || "item").slice(0, 40)}.jpg`, blob)) crops++;
      }
      bitmap.close && bitmap.close();
    }
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
      const parsed = await parseCatalogFile(file);
      const isPdf = /\.pdf$/i.test(file.name);
      if (kind === "catalog" && isPdf && !parsed.rows.length) {
        if (!visionEnabled) {
          throw new Error("This PDF has no readable text — it's image-based. AI extraction "
            + "isn't enabled (set ANTHROPIC_API_KEY on the server), so please upload a CSV/Excel.");
        }
        await runVisionFlow(file, supplier, renderSummary);
        return false;
      }
      const action = kind === "catalog" ? "catalog-import/rows" : "quotation-import/rows";
      summary = await importRowsBatched(action, supplier, parsed);
      if (kind === "catalog" && parsed.images && parsed.images.length) {
        summary.images_attached = (summary.images_attached || 0)
          + await attachEmbeddedImages(parsed, supplier.id);
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

// Upload .xlsx-embedded images one at a time, named by their row's SKU.
async function attachEmbeddedImages(parsed, supplierId) {
  const skuByRow = {};
  parsed.rows.forEach((r) => { if (r.sku) skuByRow[r.source_row] = r.sku; });
  let attached = 0;
  for (const img of parsed.images) {
    const sku = skuByRow[img.row];
    if (!sku) continue;
    const ext = (img.type.split("/")[1] || "png");
    const res = await uploadOneImage(`${sku}.${ext}`, img.bytes, img.type, supplierId);
    attached += res.images_stored || 0;
  }
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
  for (const e of entries) {
    showModalBusy(`Uploading images… (${stored + unmatched.length + 1}/${entries.length})`);
    const res = await uploadOneImage(e.filename, e.bytes, e.type, supplierId);
    stored += res.images_stored || 0;
    (res.images_unmatched || []).forEach((u) => unmatched.push(u));
  }
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

document.querySelectorAll("[data-import]").forEach((b) => b.addEventListener("click", () => {
  const kind = b.dataset.import, type = b.dataset.srctype;
  if (kind === "sheet") sheetFlow(type); else importFlow(kind, type);
}));

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
let taxonomyEnabled = false;
fetch("/api/taxonomy/config").then((r) => r.json()).then((c) => { taxonomyEnabled = !!c.enabled; }).catch(() => {});

async function loadCoverage() {
  const body = document.getElementById("coverage-body");
  body.innerHTML = `<p class="muted">Loading…</p>`;
  const [suppliers, items] = await Promise.all([api.get("/api/suppliers"), api.get("/api/catalog-items")]);
  suppliersCache = suppliers;
  const typeById = {}; suppliers.forEach((s) => (typeById[s.id] = s.type || "supplier"));

  // Reference-brand selector.
  const brandSel = document.getElementById("coverage-brand");
  const refs = suppliers.filter((s) => s.type === "reference");
  const cur = brandSel.value;
  brandSel.innerHTML = `<option value="">All reference brands</option>` +
    refs.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("");
  brandSel.value = cur;

  const classified = items.filter((i) => i.master_category);
  const refItems = items.filter((i) => typeById[i.supplier_id] === "reference"
    && (!brandSel.value || i.supplier_id === +brandSel.value));
  const supItems = items.filter((i) => typeById[i.supplier_id] === "supplier");

  if (!refs.length) {
    body.innerHTML = info("Add a reference brand to benchmark",
      "Mark a competitor (Nesasia, Flying Tiger…) as a “Reference brand” when adding the supplier, then import its catalog. Suppliers' coverage is measured against it.");
    return;
  }
  if (!classified.length) {
    body.innerHTML = info("Classify the catalog first",
      taxonomyEnabled ? "Click “Classify with AI” to derive categories and group every product."
        : "AI classification isn't enabled (set ANTHROPIC_API_KEY on the server).");
    return;
  }

  // Build master -> sub -> {ref, sup} counts (only from classified items).
  const tree = {};
  const tally = (list, key) => list.forEach((i) => {
    if (!i.master_category) return;
    const m = i.master_category, s = i.sub_category || "—";
    ((tree[m] = tree[m] || {})[s] = tree[m][s] || { ref: 0, sup: 0 })[key]++;
  });
  tally(refItems, "ref"); tally(supItems, "sup");

  // Coverage = of sub-categories the reference covers, how many a supplier also covers.
  let refSubs = 0, coveredSubs = 0; const gaps = [];
  Object.entries(tree).forEach(([m, subs]) => Object.entries(subs).forEach(([s, c]) => {
    if (c.ref > 0) { refSubs++; if (c.sup > 0) coveredSubs++; else gaps.push({ m, s, ref: c.ref }); }
  }));
  const pct = refSubs ? Math.round((coveredSubs / refSubs) * 100) : 0;
  gaps.sort((a, b) => b.ref - a.ref);

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
      <div class="card"><div class="card-n">${gaps.length}</div><div class="card-l">gaps (competitor has, you don't)</div></div>
    </div>
    ${gaps.length ? `<div class="gaps-box"><h3>Biggest gaps</h3>
      <div class="gap-chips">${gaps.slice(0, 16).map((g) =>
        `<span class="gap-chip">${esc(g.m)} › ${esc(g.s)} <b>${g.ref}</b></span>`).join("")}</div></div>` : ""}
    <div class="table-wrap" style="margin-top:18px"><table class="cov-table">
      <thead><tr><th>Master</th><th>Sub-category</th><th class="num">Competitor</th><th class="num">Suppliers</th><th>Status</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
}

function info(title, sub) {
  return `<div class="empty">${ICONS.box}<div class="empty-title">${esc(title)}</div><div class="empty-sub">${esc(sub)}</div></div>`;
}

// Re-derive ONE consolidated taxonomy across ALL products and re-classify
// everything into it — so product types are limited and comparable across brands.
document.getElementById("curate-ai").addEventListener("click", async () => {
  if (!taxonomyEnabled) return toast("AI isn't enabled (set ANTHROPIC_API_KEY)", true);
  if (!confirm("Re-derive one consolidated set of categories and re-classify ALL products "
    + "(competitors + suppliers) into it? This updates every product's master/sub category.")) return;
  const body = document.getElementById("competitors-body");
  try {
    const items = await api.get("/api/catalog-items");
    if (!items.length) { toast("No products to classify"); return; }
    body.innerHTML = `<p class="muted">Deriving a consolidated taxonomy from ${items.length} products…</p>`;
    const uniq = (f) => [...new Set(items.map(f).filter(Boolean))];
    const samples = uniq((i) => i.master_category).concat(uniq((i) => i.sub_category))
      .concat(uniq((i) => i.category)).concat(items.slice(0, 400).map((i) => i.name));
    const tax = await api.post("/api/taxonomy/suggest", { samples });
    const batches = chunk(items, 40);
    let done = 0;
    for (const b of batches) {
      body.innerHTML = `<p class="muted">Re-classifying products into ${(tax.categories || []).length} categories… (${done}/${items.length})</p>`;
      const res = await api.post("/api/taxonomy/classify", {
        taxonomy: tax, items: b.map((i) => ({ id: i.id, name: i.name, category: i.sub_category || i.category })),
      });
      if (res.items && res.items.length) await api.put("/api/taxonomy/save", { items: res.items });
      done += b.length;
    }
    toast(`Curated ${done} products into ${(tax.categories || []).length} categories`);
    loadCompetitors();
  } catch (err) {
    body.innerHTML = info("Curation failed", err.message);
  }
});

document.getElementById("coverage-brand").addEventListener("change", loadCoverage);

// Classify unclassified items INTO the existing (competitor) taxonomy so
// supplier and competitor products share one vocabulary; fall back to deriving
// a taxonomy only when nothing is classified yet.
document.getElementById("classify-ai").addEventListener("click", async () => {
  if (!taxonomyEnabled) return toast("AI classification isn't enabled (set ANTHROPIC_API_KEY)", true);
  const body = document.getElementById("coverage-body");
  const items = await api.get("/api/catalog-items");
  const todo = items.filter((i) => !i.master_category);
  if (!todo.length) { toast("Everything is already classified"); return loadCoverage(); }
  try {
    // Prefer the taxonomy that already exists (from competitor imports).
    const existing = items.filter((i) => i.master_category);
    let tax;
    if (existing.length) {
      const tree = {};
      existing.forEach((i) => { (tree[i.master_category] = tree[i.master_category] || new Set()).add(i.sub_category || "General"); });
      tax = { categories: Object.entries(tree).map(([m, subs]) => ({ master: m, subs: [...subs] })) };
      body.innerHTML = `<p class="muted">Aligning to the competitor taxonomy (${tax.categories.length} categories)…</p>`;
    } else {
      body.innerHTML = `<p class="muted">Deriving categories from ${items.length} products…</p>`;
      const samples = [...new Set(items.map((i) => i.category).filter(Boolean))]
        .concat(items.slice(0, 300).map((i) => i.name));
      tax = await api.post("/api/taxonomy/suggest", { samples });
    }
    const batches = chunk(todo, 40);
    let done = 0;
    for (const b of batches) {
      body.innerHTML = `<p class="muted">Classifying products… (${done}/${todo.length})</p>`;
      const res = await api.post("/api/taxonomy/classify", {
        taxonomy: tax, items: b.map((i) => ({ id: i.id, name: i.name, category: i.category })),
      });
      if (res.items && res.items.length) await api.put("/api/taxonomy/save", { items: res.items });
      done += b.length;
    }
    toast(`Classified ${done} products`);
    loadCoverage();
  } catch (err) {
    body.innerHTML = info("Classification failed", err.message);
  }
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

loadSuppliers();
refreshCounts();
