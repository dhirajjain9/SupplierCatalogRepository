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

function toast(msg, isError) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = "toast" + (isError ? " error" : "");
  setTimeout(() => (el.className = "toast hidden"), 3000);
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

function openModal(title, fields, handler) {
  document.getElementById("modal-title").textContent = title;
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
    await onSubmit(values, form);
    closeModal();
  } catch (err) {
    toast(err.message, true);
  }
});

// --------------------------------------------------------------------------- //
// Suppliers
// --------------------------------------------------------------------------- //
async function loadSuppliers() {
  const q = document.getElementById("supplier-search").value.trim();
  const url = "/api/suppliers" + (q ? `?search=${encodeURIComponent(q)}` : "");
  suppliersCache = await api.get(url);
  const tbody = document.querySelector("#suppliers-table tbody");
  if (!suppliersCache.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty">No suppliers yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = suppliersCache
    .map(
      (s) => `<tr>
        <td>${esc(s.name)}</td><td>${esc(s.contact_name)}</td>
        <td>${esc(s.email)}</td><td>${esc(s.phone)}</td>
        <td>${s.category ? `<span class="pill">${esc(s.category)}</span>` : ""}</td>
        <td class="right">
          <button class="btn link" onclick="editSupplier(${s.id})">Edit</button>
          <button class="btn danger-text" onclick="deleteSupplier(${s.id})">Delete</button>
        </td></tr>`
    )
    .join("");
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
  await ensureSuppliers();
  const filter = document.getElementById("catalog-supplier-filter");
  const current = filter.value;
  filter.innerHTML =
    `<option value="">All suppliers</option>` +
    suppliersCache.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("");
  filter.value = current;

  const q = document.getElementById("catalog-search").value.trim();
  const params = new URLSearchParams();
  if (filter.value) params.set("supplier_id", filter.value);
  if (q) params.set("search", q);
  const url = "/api/catalog-items" + (params.toString() ? `?${params}` : "");
  itemsCache = await api.get(url);

  const tbody = document.querySelector("#catalog-table tbody");
  if (!itemsCache.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty">No catalog items yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = itemsCache
    .map(
      (i) => `<tr>
        <td>${esc(i.name)}</td><td>${esc(i.sku)}</td>
        <td>${esc(supplierName(i.supplier_id))}</td><td>${esc(i.unit)}</td>
        <td>${i.category ? `<span class="pill">${esc(i.category)}</span>` : ""}</td>
        <td class="right">
          <button class="btn link" onclick="editItem(${i.id})">Edit</button>
          <button class="btn danger-text" onclick="deleteItem(${i.id})">Delete</button>
        </td></tr>`
    )
    .join("");
}

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
document.getElementById("catalog-search").addEventListener("input", debounce(loadCatalog, 250));

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

  const url =
    "/api/quotes" + (filter.value ? `?catalog_item_id=${filter.value}` : "");
  const quotes = await api.get(url);
  const tbody = document.querySelector("#quotes-table tbody");
  if (!quotes.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty">No quotes yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = quotes
    .map(
      (q) => `<tr>
        <td>${esc(itemName(q.catalog_item_id))}</td>
        <td>${q.unit_price.toFixed(2)} ${esc(q.currency)}</td>
        <td>${q.min_quantity}</td><td>${esc(q.valid_from)}</td>
        <td>${esc(q.valid_until)}</td>
        <td class="right">
          <button class="btn link" onclick="editQuote(${q.id})">Edit</button>
          <button class="btn danger-text" onclick="deleteQuote(${q.id})">Delete</button>
        </td></tr>`
    )
    .join("");
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
  await ensureSuppliers();
  await ensureItems();
  const docs = await api.get("/api/documents");
  const tbody = document.querySelector("#documents-table tbody");
  if (!docs.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty">No documents yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = docs
    .map(
      (d) => `<tr>
        <td>${esc(d.filename)}</td><td>${esc(d.content_type)}</td>
        <td>${fmtSize(d.size_bytes)}</td>
        <td>${d.supplier_id ? esc(supplierName(d.supplier_id)) : ""}</td>
        <td>${d.catalog_item_id ? esc(itemName(d.catalog_item_id)) : ""}</td>
        <td class="right">
          <a class="btn link" href="/api/documents/${d.id}/download">Download</a>
          <button class="btn danger-text" onclick="deleteDocument(${d.id})">Delete</button>
        </td></tr>`
    )
    .join("");
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

loadSuppliers();
