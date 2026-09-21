/* Marygold Collections Admin — dashboard SPA */
(function () {
  "use strict";

  const money = n => new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN", maximumFractionDigits: 0 }).format(Number(n) || 0);
  const esc = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const STATUSES = ["Pending", "Confirmed", "Processing", "Shipped", "Delivered", "Cancelled"];

  const $ = id => document.getElementById(id);
  let currentTab = "dashboard";

  async function api(path, opts) {
    const res = await fetch(path, opts);
    let data = null;
    try { data = await res.json(); } catch (_) { /* ignore */ }
    if (res.status === 401) { location.href = "/admin/login"; throw new Error("Session expired"); }
    if (!res.ok) throw new Error((data && data.error) || "Something went wrong. Please try again.");
    return data;
  }

  function pillFor(kind) {
    const map = { ok: "pill ok", warn: "pill warn", bad: "pill bad", info: "pill info", dim: "pill dim" };
    return map[kind] || "pill dim";
  }
  function statusKind(s) {
    if (s === "Delivered" || s === "Confirmed") return "ok";
    if (s === "Cancelled") return "bad";
    if (s === "Pending") return "warn";
    if (s === "Shipped" || s === "Processing") return "info";
    return "dim";
  }
  function paymentKind(s) {
    if (s === "Paid") return "ok";
    if (s === "Failed") return "bad";
    if (s === "Refunded") return "dim";
    return "warn";
  }
  function stockKind(p) {
    if (p.stock <= 0) return { pill: "pill bad", label: "Out of stock" };
    if (p.stock < 10) return { pill: "pill warn", label: `Low · ${p.stock} left` };
    return { pill: "pill ok", label: "In stock" };
  }
  function fmtDate(iso) {
    if (!iso) return "—";
    try { return new Date(iso.replace(" ", "T") + "Z").toLocaleDateString("en-NG", { day: "numeric", month: "short", year: "numeric" }); }
    catch (_) { return String(iso).slice(0, 10); }
  }
  function fmtDateTime(iso) {
    if (!iso) return "—";
    try { return new Date(iso.replace(" ", "T") + "Z").toLocaleString("en-NG", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }); }
    catch (_) { return String(iso).slice(0, 16); }
  }
  function itemsCount(o) { return (Number(o.item_qty) || 0); }

  function showError(msg, persistMs) {
    const el = $("dashError");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(showError._t);
    showError._t = setTimeout(() => el.classList.remove("show"), persistMs || 6000);
  }

  /* Floating success / error notice shared across admin tabs. */
  function showNotice(msg, kind) {
    let el = $("dashNotice");
    if (!el) {
      el = document.createElement("div");
      el.id = "dashNotice";
      el.className = "dash-notice";
      const content = document.querySelector(".content");
      if (content) content.prepend(el);
      else document.body.appendChild(el);
    }
    el.textContent = msg;
    el.className = "dash-notice show " + (kind === "err" ? "err" : "ok");
    clearTimeout(showNotice._t);
    showNotice._t = setTimeout(() => { el.className = "dash-notice"; }, 5200);
  }

  /* ---------------- Tabs & navigation ---------------- */
  function switchTab(tab) {
    currentTab = tab;
    document.querySelectorAll(".side-link").forEach(a => a.classList.toggle("active", a.dataset.tab === tab));
    document.querySelectorAll(".tab").forEach(s => { s.style.display = s.id === "tab-" + tab ? "block" : "none"; });
    const titles = { dashboard: "Dashboard", products: "Products", categories: "Categories", orders: "Orders", customers: "Customers", subscribers: "Newsletter", inventory: "Inventory", analytics: "Analytics", settings: "Settings" };
    $("pageTitle").textContent = titles[tab] || "Dashboard";
    window.scrollTo({ top: 0 });
    if (window.innerWidth < 980) document.querySelector(".sidebar").classList.remove("open");
    loaders[tab] && loaders[tab]();
  }

  document.querySelectorAll(".side-link[data-tab]").forEach(a => {
    a.addEventListener("click", e => { e.preventDefault(); switchTab(a.dataset.tab); });
  });
  document.querySelectorAll("[data-goto]").forEach(a => {
    a.addEventListener("click", e => { e.preventDefault(); switchTab(a.dataset.goto); });
  });
  $("navToggle").addEventListener("click", () => document.querySelector(".sidebar").classList.toggle("open"));

  $("logoutBtn").addEventListener("click", async () => {
    try { await api("/api/admin/logout", { method: "POST", headers: { "Content-Type": "application/json" } }); }
    catch (_) { /* ignore */ }
    location.href = "/admin/login";
  });

  /* ---------------- Dashboard ---------------- */
  async function loadDashboard() {
    try {
      const [stats, analytics] = await Promise.all([api("/api/admin/stats"), api("/api/admin/analytics")]);
      $("statRevenue").textContent = money(stats.revenue);
      $("statOrders").textContent = stats.orders;
      $("statCustomers").textContent = stats.customers;
      $("statProducts").textContent = stats.products;
      $("statLow").textContent = stats.lowStock;
      $("statOut").textContent = stats.outOfStock;

      const recent = analytics.recentOrders || [];
      $("recentOrders").innerHTML = recent.length
        ? `<table><thead><tr><th>Order</th><th>Customer</th><th>Date</th><th>Items</th><th>Total</th><th>Payment</th><th>Status</th></tr></thead><tbody>` +
          recent.map(o => `<tr>
            <td><b>${esc(o.order_number || ("#" + o.id))}</b></td>
            <td><b>${esc(o.customer)}</b><br><small style="color:var(--admuted)">${esc(o.email)}</small></td>
            <td>${fmtDate(o.created_at)}</td>
            <td>${itemsCount(o)}</td>
            <td><b>${money(o.total)}</b></td>
            <td><span class="${pillFor(paymentKind(o.payment_status))}">${esc(o.payment_label || o.payment_status)}</span></td>
            <td><span class="${pillFor(statusKind(o.status))}">${esc(o.status)}</span></td>
          </tr>`).join("") + "</tbody></table>"
        : '<div class="empty-row">No orders yet. Share your store with customers!</div>';

      const statuses = analytics.ordersByStatus || [];
      const max = Math.max(1, ...statuses.map(s => s.count));
      $("statusBars").innerHTML = STATUSES.map(st => {
        const found = statuses.find(s => s.status === st);
        const count = found ? found.count : 0;
        const pct = Math.round((count / max) * 100);
        return `<div class="sbar"><div class="sbar-label"><span>${st}</span><b>${count}</b></div><div class="sbar-track"><div class="sbar-fill" style="width:${Math.max(3, pct)}%"></div></div></div>`;
      }).join("");

      const payments = analytics.ordersByPayment || [];
      const maxPay = Math.max(1, ...payments.map(s => s.count));
      const PAY_BUCKETS = ["Pending", "Paid", "Failed", "Refunded"];
      $("payBars").innerHTML = PAY_BUCKETS.map(pay => {
        const found = payments.find(s => s.payment_status === pay);
        const count = found ? found.count : 0;
        const pct = Math.round((count / maxPay) * 100);
        return `<div class="sbar"><div class="sbar-label"><span>${pay === "Pending" ? "Pending / COD" : pay}</span><b>${count}</b></div><div class="sbar-track"><div class="sbar-fill" style="width:${Math.max(3, pct)}%"></div></div></div>`;
      }).join("");
    } catch (err) { showError(err.message); }
  }

  /* ---------------- Products ---------------- */
  let editingProduct = null;

  let categoriesList = [];
  async function loadCategoriesIntoSelect(preferred) {
    try { categoriesList = await api("/api/categories"); }
    catch (_) { return; }
    const sel = $("pCategory");
    const current = preferred != null ? preferred : sel.value;
    sel.innerHTML = '<option value="">Select category…</option>' +
      categoriesList.map(c => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join("");
    if (current && categoriesList.some(c => c.name === current)) sel.value = current;
  }

  async function loadProducts() {
    try {
      const products = await api("/api/admin/products");
      $("productsTable").innerHTML = products.length
        ? `<table><thead><tr><th>Image</th><th>Product</th><th>Category</th><th>Price</th><th>Stock</th><th>Status</th><th>Featured</th><th style="min-width:170px">Actions</th></tr></thead><tbody>` +
          products.map(p => {
            const sk = stockKind(p);
            return `<tr>
              <td><img class="thumb" src="${esc(p.image)}" alt=""></td>
              <td><span class="pname">${esc(p.name)}</span></td>
              <td><span class="pcat">${esc(p.category)}</span></td>
              <td>${money(p.price)}</td>
              <td><b>${p.stock}</b></td>
              <td><span class="${sk.pill}">${sk.label}</span></td>
              <td>${p.featured ? '⭐' : '—'}</td>
              <td>
                <button class="action-btn" data-act="edit" data-id="${p.id}">Edit</button>
                <button class="action-btn danger" data-act="delete" data-id="${p.id}">Delete</button>
              </td>
            </tr>`;
          }).join("") + "</tbody></table>"
        : '<div class="empty-row">No products yet.</div>';
    } catch (err) { showError(err.message); }
  }

  function openProductModal() {
    editingProduct = null;
    $("productFormTitle").textContent = "Add product";
    $("productForm").reset();
    $("pRating").value = "4.5";
    $("pFeatured").checked = false;
    hideMediaPreview("image");
    hideMediaPreview("video");
    $("productError").classList.remove("show");
    $("productModal").classList.add("open");
    loadCategoriesIntoSelect();
  }

  function hideMediaPreview(kind) {
    const el = $("p" + (kind === "video" ? "VideoPreview" : "ImagePreview"));
    if (el) el.hidden = true;
  }
  function showMediaPreview(kind, src) {
    const el = $("p" + (kind === "video" ? "VideoPreview" : "ImagePreview"));
    const input = $("p" + (kind === "video" ? "VideoUrl" : "Image"));
    if (el && src && input && input.value.trim() !== src) input.value = src;
    if (el && src) {
      el.src = src;
      el.hidden = false;
    }
  }

  function bindFileUpload(fileInput, kind) {
    if (!fileInput) return;
    fileInput.addEventListener("change", async () => {
      const errEl = $("productError");
      errEl.classList.remove("show");
      const file = fileInput.files[0];
      if (!file) return;
      const urlInput = $("p" + (kind === "video" ? "VideoUrl" : "Image"));
      if (kind === "image") {
        const reader = new FileReader();
        reader.onload = e => showMediaPreview("image", e.target.result);
        reader.readAsDataURL(file);
      } else {
        showMediaPreview("video", URL.createObjectURL(file));
      }
      urlInput.value = "…uploading";
      try {
        const url = await uploadFile(file, kind);
        urlInput.value = url;
        showMediaPreview(kind, url);
      } catch (err) {
        urlInput.value = "";
        hideMediaPreview(kind);
        errEl.textContent = err.message;
        errEl.classList.add("show");
      }
      fileInput.value = "";
    });
  }

  async function uploadFile(file, kind) {
    const fd = new FormData();
    fd.append("file", file);
    const res = await fetch("/api/admin/upload?kind=" + (kind === "video" ? "video" : "image"), {
      method: "POST", body: fd, credentials: "same-origin"
    });
    let data = null;
    try { data = await res.json(); } catch (_) { /* ignore */ }
    if (!res.ok) throw new Error((data && data.error) || "Upload failed.");
    return data.url;
  }

  async function openEditModal(p) {
    editingProduct = p;
    $("productFormTitle").textContent = "Edit product";
    $("pName").value = p.name;
    $("pPrice").value = p.price;
    $("pStock").value = p.stock;
    $("pImage").value = p.image || "";
    $("pVideoUrl").value = p.video_url || "";
    $("pDescription").value = p.description || "";
    $("pRating").value = p.rating || 4.5;
    $("pFeatured").checked = !!p.featured;
    hideMediaPreview("image");
    hideMediaPreview("video");
    $("productError").classList.remove("show");
    await loadCategoriesIntoSelect(p.category);
    $("pCategory").value = p.category;
    $("productModal").classList.add("open");
    if (p.image) showMediaPreview("image", p.image);
    if (p.video_url) showMediaPreview("video", p.video_url);
  }

  $("addProductBtn").addEventListener("click", openProductModal);
  $("productModalClose").addEventListener("click", () => $("productModal").classList.remove("open"));
  $("productModalCancel").addEventListener("click", () => $("productModal").classList.remove("open"));
  $("productModal").addEventListener("click", e => { if (e.target === $("productModal")) $("productModal").classList.remove("open"); });

  bindFileUpload($("pImageFile"), "image");
  bindFileUpload($("pVideoFile"), "video");

  function bindUrlPreview(inputId, kind) {
    const input = $(inputId);
    if (!input) return;
    const apply = () => {
      const v = input.value.trim();
      if (v) showMediaPreview(kind, v);
      else hideMediaPreview(kind);
    };
    input.addEventListener("input", apply);
    input.addEventListener("paste", () => setTimeout(apply, 0));
    input.addEventListener("change", apply);
  }
  bindUrlPreview("pImage", "image");
  bindUrlPreview("pVideoUrl", "video");

  $("productForm").addEventListener("submit", async e => {
    e.preventDefault();
    const errEl = $("productError");
    errEl.classList.remove("show");
    const body = {
      name: $("pName").value.trim(),
      category: $("pCategory").value,
      price: $("pPrice").value,
      stock: $("pStock").value,
      image: $("pImage").value.trim(),
      video_url: $("pVideoUrl").value.trim(),
      description: $("pDescription").value.trim(),
      rating: $("pRating").value,
      featured: $("pFeatured").checked
    };
    try {
      if (editingProduct) {
        await api("/api/admin/products/" + editingProduct.id, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      } else {
        await api("/api/admin/products", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      }
      $("productModal").classList.remove("open");
      await loadProducts();
      if (currentTab === "inventory") await loadInventory();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.add("show");
    }
  });

  async function editById(id) {
    try {
      const products = await api("/api/admin/products");
      const p = products.find(x => x.id === Number(id));
      if (p) openEditModal(p);
    } catch (err) { showError(err.message); }
  }

  function onTableAction(containerId, handler) {
    $(containerId).addEventListener("click", e => {
      const btn = e.target.closest("[data-act]");
      if (!btn) return;
      handler(btn.dataset.act, Number(btn.dataset.id));
    });
  }

  onTableAction("productsTable", (act, id) => {
    if (act === "edit") editById(id);
    if (act === "delete") deleteProduct(id);
  });
  onTableAction("inventoryTable", (act, id) => {
    if (act === "edit") editById(id);
  });
  onTableAction("ordersTable", (act, id) => {
    if (act === "view") viewOrder(id);
  });

  async function deleteProduct(id) {
    if (!confirm("Delete this product permanently? This cannot be undone.")) return;
    try {
      await api("/api/admin/products/" + id, { method: "DELETE", headers: { "Content-Type": "application/json" } });
      await loadProducts();
      if (currentTab === "inventory") await loadInventory();
    } catch (err) { showError(err.message); }
  }

  /* ---------------- Categories ---------------- */
  let editingCategory = null;
  let categorySavedCb = null;
  let deletingCategory = null;

  async function loadCategories() {
    try {
      const cats = await api("/api/categories");
      categoriesList = cats;
      $("categoriesTable").innerHTML = cats.length
        ? `<table><thead><tr><th>Image</th><th>Name</th><th>Slug</th><th>Products</th><th>Description</th><th style="min-width:170px">Actions</th></tr></thead><tbody>` +
          cats.map(c => `<tr>
            <td>${c.image ? `<img class="thumb" src="${esc(c.image)}" alt="">` : "—"}</td>
            <td><span class="pname">${esc(c.name)}</span></td>
            <td><code style="color:var(--admuted)">/${esc(c.slug)}</code></td>
            <td><b>${c.product_count}</b></td>
            <td style="max-width:280px">${esc(c.description || "—")}</td>
            <td>
              <button class="action-btn" data-act="edit" data-id="${c.id}">Edit</button>
              <button class="action-btn danger" data-act="delete" data-id="${c.id}">Delete</button>
            </td>
          </tr>`).join("") + "</tbody></table>"
        : '<div class="empty-row">No categories yet.</div>';
    } catch (err) { showError(err.message); }
  }

  function openCategoryModal(cat, onSaved) {
    editingCategory = cat || null;
    categorySavedCb = onSaved || null;
    $("categoryFormTitle").textContent = cat ? "Edit category" : "Add category";
    $("categoryForm").reset();
    if (cat) {
      $("cName").value = cat.name;
      $("cSlug").value = cat.slug || "";
      $("cImage").value = cat.image || "";
      $("cDescription").value = cat.description || "";
    }
    $("categoryError").classList.remove("show");
    $("categoryModal").classList.add("open");
  }

  $("addCategoryBtn").addEventListener("click", () => openCategoryModal(null));
  $("addCatQuick").addEventListener("click", () => openCategoryModal(null, saved => { loadCategoriesIntoSelect(saved.name); }));
  $("categoryModalClose").addEventListener("click", () => $("categoryModal").classList.remove("open"));
  $("categoryModalCancel").addEventListener("click", () => $("categoryModal").classList.remove("open"));
  $("categoryModal").addEventListener("click", e => { if (e.target === $("categoryModal")) $("categoryModal").classList.remove("open"); });

  $("categoryForm").addEventListener("submit", async e => {
    e.preventDefault();
    const errEl = $("categoryError");
    errEl.classList.remove("show");
    const body = {
      name: $("cName").value.trim(),
      slug: $("cSlug").value.trim(),
      image: $("cImage").value.trim(),
      description: $("cDescription").value.trim()
    };
    try {
      const saved = editingCategory
        ? await api("/api/admin/categories/" + editingCategory.id, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
        : await api("/api/admin/categories", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      $("categoryModal").classList.remove("open");
      await loadCategories();
      if (categorySavedCb) { categorySavedCb(saved); categorySavedCb = null; }
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.add("show");
    }
  });

  function openCatDelete(cat) {
    deletingCategory = cat;
    $("catDeleteError").classList.remove("show");
    const n = Number(cat.product_count) || 0;
    const others = categoriesList.filter(c => c.id !== cat.id);
    if (n > 0 && others.length) {
      $("catDeleteMsg").textContent = `"${cat.name}" has ${n} product${n === 1 ? "" : "s"}. Choose a category to move them into before deleting it.`;
      $("catMoveTo").innerHTML = others.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
      $("catMoveField").style.display = "block";
    } else if (n > 0) {
      $("catDeleteMsg").textContent = `"${cat.name}" has ${n} product${n === 1 ? "" : "s"} and no other categories exist to move them to. Move or delete its products first.`;
      $("catMoveField").style.display = "none";
    } else {
      $("catDeleteMsg").textContent = `Delete "${cat.name}" permanently?`;
      $("catMoveField").style.display = "none";
    }
    $("catDeleteModal").classList.add("open");
  }

  $("catDeleteConfirm").addEventListener("click", async () => {
    if (!deletingCategory) return;
    const errEl = $("catDeleteError");
    errEl.classList.remove("show");
    const n = Number(deletingCategory.product_count) || 0;
    try {
      const headers = { "Content-Type": "application/json" };
      if (n > 0) {
        const moveTo = $("catMoveTo").value;
        if (!moveTo) { errEl.textContent = "Choose a category to move the products to."; errEl.classList.add("show"); return; }
        await api(`/api/admin/categories/${deletingCategory.id}?to=${moveTo}`, { method: "DELETE", headers });
      } else {
        await api("/api/admin/categories/" + deletingCategory.id, { method: "DELETE", headers });
      }
      $("catDeleteModal").classList.remove("open");
      deletingCategory = null;
      await loadCategories();
    } catch (err) { errEl.textContent = err.message; errEl.classList.add("show"); }
  });
  $("catDeleteModalClose").addEventListener("click", () => $("catDeleteModal").classList.remove("open"));
  $("catDeleteCancel").addEventListener("click", () => $("catDeleteModal").classList.remove("open"));
  $("catDeleteModal").addEventListener("click", e => { if (e.target === $("catDeleteModal")) $("catDeleteModal").classList.remove("open"); });

  onTableAction("categoriesTable", (act, id) => {
    if (act === "edit") { const c = categoriesList.find(x => x.id === Number(id)); if (c) openCategoryModal(c); }
    if (act === "delete") { const c = categoriesList.find(x => x.id === Number(id)); if (c) openCatDelete(c); }
  });

  /* ---------------- Orders ---------------- */
  /* Allowed payment-status transitions — mirrors the server-side whitelist. */
  const PAY_TRANSITIONS = { Pending: ["Paid", "Failed"], Paid: ["Refunded"], Failed: [], Refunded: [] };

  async function loadOrders() {
    try {
      const orders = await api("/api/admin/orders");
      $("ordersTable").innerHTML = orders.length
        ? `<table><thead><tr><th>Order</th><th>Customer</th><th>Date</th><th>Items</th><th>Total</th><th>Payment</th><th>Status</th><th>Action</th></tr></thead><tbody>` +
          orders.map((o, i) => `<tr>
            <td><b>${esc(o.order_number || ("#" + o.id))}</b></td>
            <td><b>${esc(o.customer)}</b><br><small style="color:var(--admuted)">${esc(o.email)}</small></td>
            <td>${fmtDate(o.created_at)}</td>
            <td>${itemsCount(o)}</td>
            <td><b>${money(o.total)}</b></td>
            <td><span class="${pillFor(paymentKind(o.payment_status))}" title="Payment method: ${esc(o.payment_method)}">${esc(o.payment_label || o.payment_status)}</span><br><small style="color:var(--admuted)">${esc(o.payment_method)}</small></td>
            <td><select class="status-select" data-sid="${o.id}" data-i="${i}" aria-label="Order status">
              ${STATUSES.map(s => `<option value="${s}" ${o.status === s ? "selected" : ""}>${s}</option>`).join("")}
            </select></td>
            <td><button class="action-btn" data-act="view" data-id="${o.id}">View</button></td>
          </tr>`).join("") + "</tbody></table>"
        : '<div class="empty-row">No orders yet.</div>';

      const cache = {};
      orders.forEach(o => { cache[o.id] = o; });
      const orderCache = cache;

      document.querySelectorAll("[data-sid]").forEach(sel => {
        sel.addEventListener("change", async () => {
          if (sel.disabled) return;
          const id = sel.dataset.sid;
          const previous = orderCache[id] ? orderCache[id].status : sel.options[0].value;
          sel.disabled = true;
          try {
            const updated = await api(`/api/admin/orders/${id}/status`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ status: sel.value })
            });
            if (orderCache[id]) orderCache[id].status = updated.status;
            sel.value = updated.status;
            if (updated.updated) {
              showNotice(`Order ${updated.order_number} status updated to ${updated.status}.`, "ok");
              if (updated.email && updated.email.sent === false && !updated.email.skipped) {
                showNotice("Order status updated successfully. Customer notification email failed (see server log).", "err");
              }
            } else {
              showNotice(updated.message || "No change made.", "ok");
            }
            if (currentTab === "dashboard") await loadDashboard();
            else if (currentTab === "orders") { /* ordering unchanged in list */ }
          } catch (err) {
            showError(err.message);
            sel.value = previous;
          } finally {
            sel.disabled = false;
          }
        });
      });
    } catch (err) { showError(err.message); }
  }

  function viewOrder(id) {
    (async () => {
      try {
        const detail = await api("/api/admin/orders/" + id);
        $("orderModalBody").innerHTML = orderDetailHTML(detail);
        bindOrderModal(detail.order);
        $("orderModal").classList.add("open");
      } catch (err) { showError(err.message); }
    })();
  }

  function payOptionsHTML(o) {
    const allowed = PAY_TRANSITIONS[o.payment_status] || [];
    if (!allowed.length) return '<option value="">No change available</option>';
    return '<option value="">— select —</option>' +
      allowed.map(s => `<option value="${s}">${s}</option>`).join("");
  }

  function historyHTML(history) {
    if (!history || !history.length) return '<p class="om-hint">No status changes recorded yet.</p>';
    return `<ol class="om-history">` + history.map(h => `
      <li class="om-hist-item">
        <div class="om-hist-head"><b>${esc(h.old_status || "—")} → ${esc(h.new_status)}</b><span>${esc(fmtDateTime(h.changed_at))}</span></div>
        ${h.note ? `<div class="om-hist-note">${esc(h.note)}</div>` : ""}
        <small class="om-hist-by">Changed by ${esc(h.changed_by || "system")}</small>
      </li>`).join("") + `</ol>`;
  }

  function orderDetailHTML(detail) {
    const o = detail.order || {};
    const items = detail.items || [];
    const history = detail.history || [];
    const trackingUrl = detail.tracking_url || "";
    return `
      <div class="om-head">
        <div>
          <h2>Order ${esc(o.order_number || ("#" + o.id))}</h2>
          <small style="color:var(--admuted)">Placed ${esc(fmtDateTime(o.created_at))}</small>
        </div>
        ${trackingUrl ? `<a class="track-link" href="${esc(trackingUrl)}" target="_blank" rel="noopener">View customer tracking page ↗</a>` : ""}
      </div>
      <div class="om-pills">
        <span class="${pillFor(statusKind(o.status))}">${esc(o.status)}</span>
        <span class="${pillFor(paymentKind(o.payment_status))}">${esc(o.payment_label || o.payment_status)}</span>
        <span class="pill dim">${esc(o.payment_method || "Cash on Delivery")}</span>
      </div>

      <div class="om-grid">
        <div class="om-block">
          <h4>Customer</h4>
          <b>${esc(o.customer)}</b>
          <p>${esc(o.email)}${o.phone ? ` &middot; ${esc(o.phone)}` : ""}</p>
          <p>${esc([o.address, o.city, o.state, o.country].filter(Boolean).join(", ") || "—")}</p>
        </div>
        <div class="om-block">
          <h4>Totals</h4>
          <div class="om-total"><span>Items</span><b>${o.item_count || items.length}</b></div>
          <div class="om-total"><span>Subtotal</span><b>${money(o.subtotal || o.total)}</b></div>
          <div class="om-total"><span>Delivery</span><b>${Number(o.delivery_fee) === 0 ? "Free" : money(o.delivery_fee)}</b></div>
          <div class="om-total big"><span>Total</span><b>${money(o.total)}</b></div>
        </div>
      </div>

      <div class="om-block">
        <h4>Items</h4>
        ${items.map(it => `<div style="display:flex;gap:12px;align-items:center;padding:8px 0;border-bottom:1px solid var(--adline)">
          <img class="thumb" src="${esc(it.image || "")}" alt="">
          <div style="flex:1"><b>${esc(it.product_name || "Item")}</b><br><small style="color:var(--admuted)">Qty ${it.quantity} &middot; ${money(it.price)} each</small></div>
          <b>${money(it.price * it.quantity)}</b>
        </div>`).join("") || '<p class="om-hint">No items found.</p>'}
      </div>

      <div class="om-block">
        <h4>Order status</h4>
        <div class="om-inline">
          <select id="omStatus" aria-label="Update order status">
            ${STATUSES.map(s => `<option value="${s}" ${o.status === s ? "selected" : ""}>${s}</option>`).join("")}
          </select>
          <button class="action-btn admin-active" id="omSaveStatus">Update status</button>
        </div>
        <p id="omStatusMsg" class="om-msg" role="status"></p>
        <p id="omEmailMsg" class="om-msg err"></p>
      </div>

      <div class="om-block">
        <h4>Payment status</h4>
        <div class="om-inline">
          <select id="omPayStatus" aria-label="Update payment status">${payOptionsHTML(o)}</select>
          <button class="action-btn admin-active" id="omSavePay">Update payment</button>
        </div>
        <p class="om-hint">Allowed transitions: Pending → Paid / Failed &middot; Paid → Refunded. Changes are recorded in the status history.</p>
        <p id="omPayMsg" class="om-msg" role="status"></p>
      </div>

      <div class="om-block">
        <h4>Shipping information</h4>
        <div class="om-grid2">
          <div class="om-field"><label for="omCarrier">Shipping carrier</label><input id="omCarrier" type="text" placeholder="e.g. DHL, GIG Logistics" value="${esc(o.shipping_carrier || "")}"></div>
          <div class="om-field"><label for="omTrackingNo">Tracking number</label><input id="omTrackingNo" type="text" placeholder="Carrier tracking number" value="${esc(o.tracking_number || "")}"></div>
        </div>
        <button class="action-btn admin-active" id="omSaveShipping">Save shipping info</button>
        <p id="omShipMsg" class="om-msg" role="status"></p>
      </div>

      <div class="om-block">
        <h4>Status history</h4>
        ${historyHTML(history)}
      </div>
    `;
  }

  function setMsg(id, text, kind) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = text;
    el.className = "om-msg " + (kind === "err" ? "err" : kind === "info" ? "info" : "ok");
  }

  async function refreshOrderModal(id) {
    try {
      const detail = await api("/api/admin/orders/" + id);
      $("orderModalBody").innerHTML = orderDetailHTML(detail);
      bindOrderModal(detail.order);
    } catch (err) { showError(err.message); }
  }

  async function saveOrderStatus(o, sel) {
    const next = String(sel.value || "");
    if (!next || next === o.status) {
      setMsg("omStatusMsg", next === o.status ? `Order is already ${o.status}.` : "Choose a new status.", "info");
      return;
    }
    const btn = $("omSaveStatus");
    btn.disabled = true;
    try {
      const updated = await api(`/api/admin/orders/${o.id}/status`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: next })
      });
      setMsg("omStatusMsg", updated.message || `Order status updated to ${updated.status}.`, "ok");
      if (updated.email && updated.email.sent === false && !updated.email.skipped) {
        setMsg("omEmailMsg", "Order status updated successfully, but the customer notification email failed to send (see server log).", "err");
      } else {
        setMsg("omEmailMsg", "", "");
      }
      await refreshOrderModal(o.id);
    } catch (err) {
      setMsg("omStatusMsg", err.message, "err");
      sel.value = o.status;
    } finally {
      btn.disabled = false;
    }
  }

  async function savePaymentStatus(o, sel) {
    const next = String(sel.value || "");
    const allowed = PAY_TRANSITIONS[o.payment_status] || [];
    if (!next) {
      setMsg("omPayMsg", allowed.length ? "Choose the new payment status." : "No payment change is available for this status.", "info");
      return;
    }
    if (next === o.payment_status) {
      setMsg("omPayMsg", `Payment status is already ${o.payment_status}.`, "info");
      return;
    }
    if (!allowed.includes(next)) {
      setMsg("omPayMsg", `Cannot change payment status from "${o.payment_status}" to "${next}". Allowed: ${allowed.join(" or ") || "none"}.`, "err");
      return;
    }
    const btn = $("omSavePay");
    btn.disabled = true;
    try {
      const updated = await api(`/api/admin/orders/${o.id}/payment-status`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ payment_status: next })
      });
      setMsg("omPayMsg", updated.message || `Payment status updated to ${next}.`, "ok");
      await refreshOrderModal(o.id);
    } catch (err) {
      setMsg("omPayMsg", err.message, "err");
      sel.value = "";
    } finally {
      btn.disabled = false;
    }
  }

  async function saveShipping(o) {
    const carrier = $("omCarrier").value.trim();
    const trackingNumber = $("omTrackingNo").value.trim();
    const btn = $("omSaveShipping");
    btn.disabled = true;
    try {
      await api(`/api/admin/orders/${o.id}/shipping`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ shipping_carrier: carrier, tracking_number: trackingNumber })
      });
      setMsg("omShipMsg", "Shipping information saved.", "ok");
      await refreshOrderModal(o.id);
    } catch (err) {
      setMsg("omShipMsg", err.message, "err");
    } finally {
      btn.disabled = false;
    }
  }

  function bindOrderModal(o) {
    const statusSel = $("omStatus");
    if (statusSel) {
      $("omSaveStatus").addEventListener("click", () => saveOrderStatus(o, statusSel));
      statusSel.addEventListener("change", () => setMsg("omStatusMsg", "", ""));
    }
    const paySel = $("omPayStatus");
    if (paySel) {
      $("omSavePay").addEventListener("click", () => savePaymentStatus(o, paySel));
      paySel.addEventListener("change", () => setMsg("omPayMsg", "", ""));
    }
    const shipBtn = $("omSaveShipping");
    if (shipBtn) shipBtn.addEventListener("click", () => saveShipping(o));
  }

  $("orderModalClose").addEventListener("click", () => $("orderModal").classList.remove("open"));
  $("orderModal").addEventListener("click", e => { if (e.target === $("orderModal")) $("orderModal").classList.remove("open"); });

  /* ---------------- Customers ---------------- */
  async function loadCustomers() {
    try {
      const customers = await api("/api/admin/customers");
      $("customersTable").innerHTML = customers.length
        ? `<table><thead><tr><th>Customer</th><th>Email</th><th>Phone</th><th>Location</th><th>Orders</th><th>Total spent</th><th>First seen</th></tr></thead><tbody>` +
          customers.map(c => `<tr>
            <td><b>${esc(c.name)}</b></td>
            <td>${esc(c.email)}</td>
            <td>${esc(c.phone || "—")}</td>
            <td>${esc([c.city, c.state].filter(Boolean).join(", ") || "—")}</td>
            <td>${c.order_count || 0}</td>
            <td><b>${money(c.total_spent || 0)}</b></td>
            <td>${fmtDate(c.created_at)}</td>
          </tr>`).join("") + "</tbody></table>"
        : '<div class="empty-row">No customers yet.</div>';
    } catch (err) { showError(err.message); }
  }

  /* ---------------- Inventory ---------------- */
  async function loadInventory() {
    try {
      const products = await api("/api/admin/products");
      $("inventoryTable").innerHTML = products.length
        ? `<table><thead><tr><th>Image</th><th>Product</th><th>Category</th><th>Current stock</th><th>Status</th><th>Actions</th></tr></thead><tbody>` +
          products.map(p => {
            const sk = stockKind(p);
            return `<tr>
              <td><img class="thumb" src="${esc(p.image)}" alt=""></td>
              <td><span class="pname">${esc(p.name)}</span></td>
              <td><span class="pcat">${esc(p.category)}</span></td>
              <td><b>${p.stock}</b></td>
              <td><span class="${sk.pill}">${sk.label}</span></td>
              <td><button class="action-btn" data-act="edit" data-id="${p.id}">Edit stock</button></td>
            </tr>`;
          }).join("") + "</tbody></table>"
        : '<div class="empty-row">No products yet.</div>';
    } catch (err) { showError(err.message); }
  }

  /* ---------------- Analytics ---------------- */
  async function loadAnalytics() {
    try {
      const a = await api("/api/admin/analytics");

      const sales = a.salesOverview || [];
      const maxRev = Math.max(1, ...sales.map(s => s.revenue));
      $("salesChart").innerHTML = sales.map(s => {
        const h = s.revenue ? Math.max(8, Math.round((s.revenue / maxRev) * 150)) : 3;
        return `<div class="cbar"><span class="val">${s.revenue ? (s.revenue / 1000).toFixed(0) + "k" : ""}</span><div class="bar" style="height:${h}px" title="${money(s.revenue)}"></div><small>${s.day.slice(5)}</small></div>`;
      }).join("");

      const best = a.bestSellers || [];
      $("bestSellers").innerHTML = best.length
        ? `<table><thead><tr><th>Product</th><th>Sold</th><th>Revenue</th></tr></thead><tbody>` +
          best.map(b => `<tr><td style="display:flex;align-items:center;gap:10px"><img class="thumb" src="${esc(b.image)}" alt=""><b>${esc(b.name)}</b></td><td>${b.sold}</td><td><b>${money(b.revenue)}</b></td></tr>`).join("") +
          "</tbody></table>"
        : '<div class="empty-row">No sales yet.</div>';

      const perf = a.categoryPerformance || [];
      const maxPerf = Math.max(1, ...perf.map(p => p.revenue));
      $("categoryPerf").innerHTML = `<div class="catperc">` + perf.map(p => `
        <div class="row"><b>${esc(p.category)}</b><div class="track"><div class="fill" style="width:${p.revenue ? Math.round((p.revenue / maxPerf) * 100) : 0}%"></div></div><div class="meta">${p.units} units · ${money(p.revenue)}</div></div>`).join("") + "</div>";
    } catch (err) { showError(err.message); }
  }

  /* ---------------- Subscribers ---------------- */
  let subscribersAll = [];
  let editingSubscriber = null;
  let subSearchTimer = null;

  async function refreshSubscribers() {
    try {
      const params = new URLSearchParams();
      if ($("subSearch").value.trim()) params.set("q", $("subSearch").value.trim());
      const active = document.querySelector(".sub-filter.active");
      const status = active ? active.dataset.subfilter : "all";
      if (status !== "all") params.set("status", status);
      const qs = params.toString();
      const data = await api("/api/admin/subscribers" + (qs ? "?" + qs : ""));
      subscribersAll = data.subscribers || [];

      $("subTotal").textContent = data.stats.total;
      $("subActive").textContent = data.stats.active;
      $("subUnsub").textContent = data.stats.unsubscribed;
      $("subNew").textContent = data.stats.newThisMonth;
      $("subResult").textContent = `${data.stats.active} active · ${data.stats.unsubscribed} unsubscribed`;
      if ($("nlActiveHint")) $("nlActiveHint").textContent = `${data.stats.active} active`;

      renderSubscribers();
    } catch (err) { showError(err.message); }
  }

  function renderSubscribers() {
    const rows = subscribersAll.slice();
    const sort = ($("subSort") ? $("subSort").value : "newest");
    if (sort === "email") rows.sort((a, b) => String(a.email).localeCompare(String(b.email)));
    else if (sort === "recent") rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    else if (sort === "oldest") rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));

    $("subscribersTable").innerHTML = rows.length
      ? `<table><thead><tr><th>Email</th><th>Status</th><th>Subscribed</th><th>Last updated</th><th style="min-width:160px">Actions</th></tr></thead><tbody>` +
        rows.map(s => `<tr>
          <td><b>${esc(s.email)}</b></td>
          <td><span class="${s.status === "unsubscribed" ? "pill bad" : "pill ok"}">${s.status === "unsubscribed" ? "Unsubscribed" : "Subscribed"}</span></td>
          <td>${fmtDate(s.created_at)}</td>
          <td>${fmtDate(s.updated_at)}</td>
          <td>
            <button class="action-btn" data-act="edit" data-id="${s.id}">Edit</button>
            <button class="action-btn danger" data-act="delete" data-id="${s.id}">Delete</button>
          </td>
        </tr>`).join("") + "</tbody></table>"
      : '<div class="empty-row">No subscribers found. Add one manually or share the homepage newsletter form.</div>';
  }

  function openSubscriberModal(subscriber) {
    editingSubscriber = subscriber || null;
    $("subscriberFormTitle").textContent = subscriber ? "Edit subscriber" : "Add subscriber";
    $("subscriberForm").reset();
    $("sEmail").value = subscriber ? subscriber.email : "";
    $("sStatus").value = subscriber && subscriber.status === "unsubscribed" ? "unsubscribed" : "subscribed";
    $("subscriberError").classList.remove("show");
    $("subscriberModal").classList.add("open");
  }

  $("addSubscriberBtn").addEventListener("click", () => openSubscriberModal(null));
  $("subscriberModalClose").addEventListener("click", () => $("subscriberModal").classList.remove("open"));
  $("subscriberModalCancel").addEventListener("click", () => $("subscriberModal").classList.remove("open"));
  $("subscriberModal").addEventListener("click", e => { if (e.target === $("subscriberModal")) $("subscriberModal").classList.remove("open"); });

  $("subscriberForm").addEventListener("submit", async e => {
    e.preventDefault();
    const errEl = $("subscriberError");
    errEl.classList.remove("show");
    const body = { email: $("sEmail").value.trim(), status: $("sStatus").value };
    try {
      if (editingSubscriber) {
        await api("/api/admin/subscribers/" + editingSubscriber.id, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      } else {
        await api("/api/admin/subscribers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      }
      $("subscriberModal").classList.remove("open");
      await refreshSubscribers();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.add("show");
    }
  });

  document.querySelectorAll(".sub-filter").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".sub-filter").forEach(b => b.classList.toggle("active", b === btn));
      refreshSubscribers();
    });
  });

  if ($("subSearch")) {
    $("subSearch").addEventListener("input", () => {
      clearTimeout(subSearchTimer);
      subSearchTimer = setTimeout(refreshSubscribers, 250);
    });
  }
  if ($("subSort")) {
    $("subSort").addEventListener("change", renderSubscribers);
  }

  onTableAction("subscribersTable", (act, id) => {
    if (act === "edit") { const s = subscribersAll.find(x => x.id === Number(id)); if (s) openSubscriberModal(s); }
    if (act === "delete") {
      const s = subscribersAll.find(x => x.id === Number(id));
      if (!s) return;
      if (!confirm(`Remove ${s.email} from the newsletter list permanently? This cannot be undone.`)) return;
      (async () => {
        try {
          await api("/api/admin/subscribers/" + id, { method: "DELETE", headers: { "Content-Type": "application/json" } });
          await refreshSubscribers();
        } catch (err) { showError(err.message); }
      })();
    }
  });

  /* ---------------- Newsletter broadcast ---------------- */
  const sendNewsletter = testOnly => {
    const subject = ($("nlSubject") ? $("nlSubject").value : "").trim();
    const message = ($("nlMessage") ? $("nlMessage").value : "").trim();
    const errEl = $("nlError");
    const msg = $("nlMsg");
    if (errEl) errEl.classList.remove("show");
    if (msg) msg.className = "form-msg";
    if (!subject || !message) {
      if (errEl) { errEl.textContent = "Please enter both a subject and a message."; errEl.classList.add("show"); }
      return;
    }
    const activeCount = $("subActive") ? $("subActive").textContent : "all";
    if (testOnly) {
      if (!confirm("Send a test of this newsletter to your admin email?")) return;
    } else if (!confirm(`Send this newsletter to ${activeCount} active subscriber(s)? Each receives it individually.`)) {
      return;
    }
    const btn = testOnly ? $("nlTestBtn") : $("nlSendBtn");
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = testOnly ? "Sending test…" : "Sending…";
    api("/api/admin/newsletter/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject, message, test: testOnly })
    })
      .then(data => {
        if (msg) {
          if (testOnly) {
            msg.textContent = data.sent
              ? `Test email sent successfully to ${data.to || "you"}.`
              : "Test email failed — check the server log for the error.";
          } else {
            const r = data.results || {};
            msg.textContent = `Sent to ${r.sent || 0} of ${r.total || 0} subscriber(s).${r.failed ? ` ${r.failed} failed — see the server log.` : ""}`;
          }
          msg.className = "form-msg ok";
        }
      })
      .catch(err => {
        if (msg) { msg.textContent = err.message; msg.className = "form-msg err"; }
      })
      .finally(() => {
        btn.disabled = false;
        btn.textContent = original;
      });
  };

  if ($("nlTestBtn")) $("nlTestBtn").addEventListener("click", () => sendNewsletter(true));
  if ($("nlSendBtn")) $("nlSendBtn").addEventListener("click", () => sendNewsletter(false));

  /* ---------------- Settings ---------------- */
  function loadMailStatus() {
    const mount = $("mailMeta");
    if (!mount) return;
    api("/api/admin/email-status")
      .then(st => {
        const rows = [
          ["SMTP configured", st.configured ? "Yes" : "No"],
          ["SMTP host", st.host || "—"],
          ["SMTP port", String(st.port || "—")],
          ["SMTP user", st.user_configured ? "configured" : "not configured"],
          ["SMTP password", st.password_configured ? "configured" : "not configured"],
          ["SMTP verification", st.verification],
          ["Production base URL", st.production_base_url || "—"]
        ];
        mount.innerHTML = rows.map(([k, v]) =>
          `<div style="display:flex;justify-content:space-between;gap:14px;padding:7px 0;border-bottom:1px solid var(--adline)"><b>${esc(k)}</b><span style="color:#57534e;word-break:break-all;text-align:right">${esc(v)}</span></div>`
        ).join("");
        if (st.verification_error) {
          mount.innerHTML += `<p style="color:#b91c1c;font-size:13px;margin:10px 0 0">Verification error: ${esc(st.verification_error)}</p>`;
        }
      })
      .catch(err => { mount.innerHTML = `<p style="color:#b91c1c;font-size:13.5px">${esc(err.message)}</p>`; });
  }

  async function loadSettings() {
    try {
      const me = await api("/api/admin/me");
      $("adminEmail").textContent = "Signed in as " + me.email;
    } catch (err) { showError(err.message); }
    loadMailStatus();
  }

  if ($("mailRefreshBtn")) $("mailRefreshBtn").addEventListener("click", loadMailStatus);
  if ($("testEmailBtn")) $("testEmailBtn").addEventListener("click", async () => {
    const btn = $("testEmailBtn");
    const msg = $("testEmailMsg");
    if (!msg) return;
    btn.disabled = true;
    msg.className = "form-msg";
    msg.textContent = "Sending test email…";
    try {
      const data = await api("/api/admin/test-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      });
      if (data.success) {
        msg.textContent = `${data.message}${data.to ? ` (to ${data.to})` : ""}.`;
        msg.className = "form-msg ok";
      } else {
        msg.textContent = `${data.message}${data.error ? ": " + data.error : ""}.`;
        msg.className = "form-msg err";
      }
    } catch (err) {
      msg.textContent = err.message;
      msg.className = "form-msg err";
    } finally {
      btn.disabled = false;
    }
  });

  $("passwordForm").addEventListener("submit", async e => {
    e.preventDefault();
    const errEl = $("passwordError");
    const msg = $("passwordMsg");
    errEl.classList.remove("show");
    msg.className = "form-msg";
    try {
      await api("/api/admin/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current: $("currentPassword").value, password: $("newPassword").value })
      });
      $("passwordForm").reset();
      msg.textContent = "Password updated successfully.";
      msg.className = "form-msg ok";
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.add("show");
    }
  });

  const loaders = {
    dashboard: loadDashboard,
    products: loadProducts,
    categories: loadCategories,
    orders: loadOrders,
    customers: loadCustomers,
    subscribers: refreshSubscribers,
    inventory: loadInventory,
    analytics: loadAnalytics,
    settings: loadSettings
  };

  /* ---------------- Boot ---------------- */
  async function boot() {
    try {
      const me = await api("/api/admin/me");
      $("adminEmail").textContent = "Signed in as " + me.email;
    } catch (err) { return; }
    switchTab("dashboard");
  }
  boot();
})();