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
    set("suppliers", s.length); set("catalog", c.length);
    set("quotes", q.length); set("documents", d.length);
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
  else if (name === "catalog") loadCatalog();
  else if (name === "quotes") loadQuotes();
  else if (name === "documents") loadDocuments();
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
  onSubmit = null;
}
document.getElementById("modal-close").addEventListener("click", closeModal);
document.getElementById("modal-cancel").addEventListener("click", closeModal);
document.getElementById("modal-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.target;
  const values = {};
  new FormData(form).forEach((v, k) => (values[k] = v));
  try {
    // A handler may return false to keep the modal open (e.g. to show a summary).
    const keepOpen = await onSubmit(values, form);
    if (keepOpen !== false) closeModal();
  } catch (err) {
    toast(err.message, true);
  }
});

// --------------------------------------------------------------------------- //
// Suppliers
// --------------------------------------------------------------------------- //
async function loadSuppliers() {
  const tbody = document.querySelector("#suppliers-table tbody");
  const q = document.getElementById("supplier-search").value.trim();
  tbody.innerHTML = skeletonRows(6);
  const url = "/api/suppliers" + (q ? `?search=${encodeURIComponent(q)}` : "");
  suppliersCache = await api.get(url);
  if (!suppliersCache.length) {
    tbody.innerHTML = q
      ? emptyState(6, ICONS.box, "No matches", `Nothing matches “${q}”.`)
      : emptyState(6, ICONS.box, "No suppliers yet", "Add your first supplier to get started.");
    refreshCounts();
    return;
  }
  tbody.innerHTML = suppliersCache
    .map(
      (s) => `<tr>
        <td>${esc(s.name)}</td><td>${esc(s.contact_name) || "—"}</td>
        <td>${esc(s.email) || "—"}</td><td>${esc(s.phone) || "—"}</td>
        <td>${s.category ? `<span class="pill">${esc(s.category)}</span>` : "—"}</td>
        <td class="right">
          <button class="btn link" onclick="editSupplier(${s.id})">Edit</button>
          <button class="btn danger-text" onclick="deleteSupplier(${s.id})">Delete</button>
        </td></tr>`
    )
    .join("");
  refreshCounts();
}

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
  // Convert empty strings to null so optional fields stay unset.
  const out = {};
  Object.entries(values).forEach(([k, v]) => (out[k] = v === "" ? null : v));
  return out;
}

document.getElementById("add-supplier").addEventListener("click", () => {
  openModal("Add Supplier", supplierFields(), async (v) => {
    await api.post("/api/suppliers", cleanEmpty(v));
    toast("Supplier created");
    loadSuppliers();
  });
});

window.editSupplier = async (id) => {
  const s = await api.get(`/api/suppliers/${id}`);
  openModal("Edit Supplier", supplierFields(s), async (v) => {
    await api.put(`/api/suppliers/${id}`, cleanEmpty(v));
    toast("Supplier updated");
    loadSuppliers();
  });
};

window.deleteSupplier = async (id) => {
  if (!confirm("Delete this supplier and all its items, quotes and documents?")) return;
  await api.del(`/api/suppliers/${id}`);
  toast("Supplier deleted");
  loadSuppliers();
};

document.getElementById("supplier-search").addEventListener("input", debounce(loadSuppliers, 250));

// --------------------------------------------------------------------------- //
// Catalog items
// --------------------------------------------------------------------------- //
async function ensureSuppliers() {
  if (!suppliersCache.length) suppliersCache = await api.get("/api/suppliers");
}
async function ensureItems() {
  if (!itemsCache.length) itemsCache = await api.get("/api/catalog-items");
}

async function loadCatalog() {
  const tbody = document.querySelector("#catalog-table tbody");
  tbody.innerHTML = skeletonRows(6);
  await ensureSuppliers();
  const filter = document.getElementById("catalog-supplier-filter");
  const current = filter.value;
  filter.innerHTML =
    `<option value="">All suppliers</option>` +
    suppliersCache.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("");
  filter.value = current;

  // Populate the product-type (category) filter from distinct categories.
  const catFilter = document.getElementById("catalog-category-filter");
  const currentCat = catFilter.value;
  const categories = await api.get("/api/catalog-items/categories");
  catFilter.innerHTML =
    `<option value="">All product types</option>` +
    categories.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
  catFilter.value = currentCat;

  const q = document.getElementById("catalog-search").value.trim();
  const params = new URLSearchParams();
  if (filter.value) params.set("supplier_id", filter.value);
  if (catFilter.value) params.set("category", catFilter.value);
  if (q) params.set("search", q);
  const url = "/api/catalog-items" + (params.toString() ? `?${params}` : "");
  itemsCache = await api.get(url);

  // One request for image thumbnails, mapped to the first photo per item.
  const thumbs = {};
  try {
    (await api.get("/api/documents?kind=image")).forEach((d) => {
      if (d.catalog_item_id && !thumbs[d.catalog_item_id]) thumbs[d.catalog_item_id] = d.id;
    });
  } catch (_) { /* thumbnails are optional */ }

  if (!itemsCache.length) {
    const filtering = q || filter.value || catFilter.value;
    tbody.innerHTML = filtering
      ? emptyState(6, ICONS.box, "No matching items", "Try clearing the search or filters.")
      : emptyState(6, ICONS.box, "No catalog items yet", "Import a catalog or add an item to begin.");
    refreshCounts();
    return;
  }
  tbody.innerHTML = itemsCache
    .map((i) => {
      const thumb = thumbs[i.id]
        ? `<img class="thumb" src="/api/documents/${thumbs[i.id]}/download" alt="" />`
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
    })
    .join("");
  refreshCounts();
}

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
document.getElementById("catalog-category-filter").addEventListener("change", loadCatalog);
document.getElementById("catalog-search").addEventListener("input", debounce(loadCatalog, 250));

// --------------------------------------------------------------------------- //
// Imports: catalog (CSV/XLSX/PDF), quotation (Step 2) and product images
// --------------------------------------------------------------------------- //
function warningList(warnings) {
  if (!warnings || !warnings.length) return "";
  const items = warnings.slice(0, 20).map((w) => `<li>Row ${w.row}: ${esc(w.warning)}</li>`).join("");
  const more = warnings.length > 20 ? `<li>…and ${warnings.length - 20} more</li>` : "";
  return `<ul class="errs">${items}${more}</ul>`;
}

// Generic upload modal. Supplier is OPTIONAL: it can come from a "Supplier"
// column in the file, or be chosen/typed here — adding a supplier first is not
// required. `supplierMode`: "name" shows existing-picker + new-name field
// (catalog/quotation); "scope" shows only an optional existing-picker (images).
function openUploadModal({ title, action, accept, fileLabel, renderSummary, extraFooter, supplierMode }) {
  const fields = [
    { name: "supplier_id", label: "Supplier (optional)", type: "select",
      options: [{ value: "", label: "— Auto-detect from file —" }]
        .concat(suppliersCache.map((s) => ({ value: s.id, label: s.name }))) },
  ];
  if (supplierMode === "name") {
    fields.push({ name: "supplier_name", label: "…or new supplier name (optional)" });
  }
  fields.push({ name: "file", label: fileLabel, type: "file", required: true, accept });

  openModal(
    title,
    fields,
    async (v, form) => {
      const fileInput = form.querySelector('input[name="file"]');
      if (!fileInput.files.length) throw new Error("Please choose a file");
      const fd = new FormData();
      fd.append("file", fileInput.files[0]);
      if (v.supplier_id) fd.append("supplier_id", v.supplier_id);
      if (v.supplier_name && v.supplier_name.trim()) fd.append("supplier_name", v.supplier_name.trim());
      const res = await fetch(`/api/${action}`, { method: "POST", body: fd });
      const summary = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(summary.detail || "Import failed");
      document.getElementById("modal-title").textContent = "Import Complete";
      document.getElementById("modal-extra").innerHTML = "";
      document.getElementById("modal-fields").innerHTML = renderSummary(summary);
      onSubmit = async () => {};  // next "Save" just closes
      loadCatalog();
      refreshCounts();
      return false;               // keep modal open to show the summary
    },
    extraFooter || ""
  );
}

document.getElementById("import-catalog").addEventListener("click", async () => {
  await ensureSuppliers();
  openUploadModal({
    title: "Import Catalog",
    action: "catalog-import",
    supplierMode: "name",
    accept: ".csv,.xlsx,.pdf",
    fileLabel: "Catalog file (.csv, .xlsx, .pdf)",
    extraFooter: `<a class="btn link" href="/api/catalog-import/template">Download CSV template</a>`,
    renderSummary: (s) => `
      <p><strong>${s.rows_captured}</strong> row(s) captured —
         <strong>${s.items_created}</strong> created,
         <strong>${s.items_updated}</strong> updated,
         <strong>${s.quotes_created}</strong> quotes,
         <strong>${s.images_attached || 0}</strong> images${
           s.suppliers_created ? `, <strong>${s.suppliers_created}</strong> new supplier(s)` : ""}.</p>
      <p class="muted">Tip: include a “Supplier” column to file items under different suppliers.</p>
      ${s.rows_with_warnings
          ? `<p>${s.rows_with_warnings} row(s) imported with warnings:</p>${warningList(s.warnings)}`
          : `<p>No warnings. 🎉</p>`}`,
  });
});

document.getElementById("import-quotation").addEventListener("click", async () => {
  await ensureSuppliers();
  openUploadModal({
    title: "Import Quotation (Step 2)",
    action: "quotation-import",
    supplierMode: "name",
    accept: ".csv,.xlsx,.pdf",
    fileLabel: "Quotation file with SKU + price + MOQ",
    renderSummary: (s) => `
      <p><strong>${s.quotes_created}</strong> quote(s) recorded across
         <strong>${s.items_matched}</strong> catalog item(s).</p>
      <p class="muted">Rows are matched to existing items by SKU.</p>
      ${(s.rows_unmatched || s.rows_without_price)
          ? `<p>${s.rows_unmatched} unmatched, ${s.rows_without_price} without a price:</p>
             ${warningList(s.warnings)}`
          : `<p>All rows matched. 🎉</p>`}`,
  });
});

document.getElementById("import-images").addEventListener("click", async () => {
  await ensureSuppliers();
  openUploadModal({
    title: "Import Product Images",
    action: "images-import",
    supplierMode: "scope",
    accept: ".zip,.jpg,.jpeg,.png,.gif,.webp,.bmp",
    fileLabel: "A .zip of images, or a single image (named by SKU, e.g. BH-01.jpg)",
    renderSummary: (s) => {
      const unmatched = (s.images_unmatched || []).map((f) => `<li>${esc(f)}</li>`).join("");
      const skipped = (s.files_skipped || []).map((f) => `<li>${esc(f)}</li>`).join("");
      return `
        <p><strong>${s.images_stored}</strong> image(s) matched to products by SKU.</p>
        ${unmatched ? `<p>No matching SKU for:</p><ul class="errs">${unmatched}</ul>` : ""}
        ${skipped ? `<p class="muted">Skipped non-images:</p><ul class="errs">${skipped}</ul>` : ""}
        ${!unmatched && !skipped ? `<p>All images matched. 🎉</p>` : ""}`;
    },
  });
});

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
