/* NovaCart Admin — dashboard SPA */
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
    if (s === "Delivered") return "ok";
    if (s === "Cancelled") return "bad";
    if (s === "Pending") return "warn";
    if (s === "Shipped") return "info";
    if (s === "Confirmed" || s === "Processing") return "dim";
    return "dim";
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
  function itemsCount(o) { return (Number(o.item_qty) || 0); }

  function showError(msg, persistMs) {
    const el = $("dashError");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(showError._t);
    showError._t = setTimeout(() => el.classList.remove("show"), persistMs || 6000);
  }

  /* ---------------- Tabs & navigation ---------------- */
  function switchTab(tab) {
    currentTab = tab;
    document.querySelectorAll(".side-link").forEach(a => a.classList.toggle("active", a.dataset.tab === tab));
    document.querySelectorAll(".tab").forEach(s => { s.style.display = s.id === "tab-" + tab ? "block" : "none"; });
    const titles = { dashboard: "Dashboard", products: "Products", categories: "Categories", orders: "Orders", customers: "Customers", inventory: "Inventory", analytics: "Analytics", settings: "Settings" };
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
        ? `<table><thead><tr><th>Order</th><th>Customer</th><th>Date</th><th>Items</th><th>Total</th><th>Status</th></tr></thead><tbody>` +
          recent.map(o => `<tr>
            <td><b>${esc(o.order_number || ("#" + o.id))}</b></td>
            <td><b>${esc(o.customer)}</b><br><small style="color:var(--admuted)">${esc(o.email)}</small></td>
            <td>${fmtDate(o.created_at)}</td>
            <td>${itemsCount(o)}</td>
            <td><b>${money(o.total)}</b></td>
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
    $("productError").classList.remove("show");
    $("productModal").classList.add("open");
    loadCategoriesIntoSelect();
  }

  async function openEditModal(p) {
    editingProduct = p;
    $("productFormTitle").textContent = "Edit product";
    $("pName").value = p.name;
    $("pPrice").value = p.price;
    $("pStock").value = p.stock;
    $("pImage").value = p.image;
    $("pDescription").value = p.description || "";
    $("pRating").value = p.rating || 4.5;
    $("pFeatured").checked = !!p.featured;
    $("productError").classList.remove("show");
    await loadCategoriesIntoSelect(p.category);
    $("pCategory").value = p.category;
    $("productModal").classList.add("open");
  }

  $("addProductBtn").addEventListener("click", openProductModal);
  $("productModalClose").addEventListener("click", () => $("productModal").classList.remove("open"));
  $("productModalCancel").addEventListener("click", () => $("productModal").classList.remove("open"));
  $("productModal").addEventListener("click", e => { if (e.target === $("productModal")) $("productModal").classList.remove("open"); });

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
            <td><span class="${pillFor(o.payment_status === "Paid" ? "ok" : "warn")}">${esc(o.payment_status)}</span><br><small style="color:var(--admuted)">${esc(o.payment_method)}</small></td>
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
          const id = sel.dataset.sid;
          try {
            const updated = await api(`/api/admin/orders/${id}/status`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: sel.value }) });
            if (orderCache[id]) orderCache[id].status = updated.status;
            if (currentTab === "dashboard") await loadDashboard();
          } catch (err) { showError(err.message); sel.value = orderCache[id].status; }
        });
      });
    } catch (err) { showError(err.message); }
  }

  function viewOrder(id) {
    (async () => {
    try {
      const orders = await api("/api/admin/orders");
      const o = orders.find(x => x.id === Number(id));
      if (!o) return;
      const detail = await api(`/api/orders/${encodeURIComponent(o.order_number || o.id)}?email=${encodeURIComponent(o.email)}`);
      const items = detail.items || [];
      $("orderModalBody").innerHTML = `
        <h2>Order ${esc(o.order_number || ("#" + o.id))}</h2>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">
          <span class="${pillFor(statusKind(o.status))}">${esc(o.status)}</span>
          <span class="${pillFor(o.payment_status === "Paid" ? "ok" : "warn")}">${esc(o.payment_status)}</span>
          <span class="pill dim">${esc(o.payment_method)}</span>
        </div>
        ${items.map(it => `<div style="display:flex;gap:12px;align-items:center;padding:8px 0;border-bottom:1px solid var(--adline)">
          <img class="thumb" src="${esc(it.image || "")}" alt="">
          <div style="flex:1"><b>${esc(it.product_name || "Item")}</b><br><small style="color:var(--admuted)">Qty ${it.quantity} · ${money(it.price)} each</small></div>
          <b>${money(it.price * it.quantity)}</b>
        </div>`).join("")}
        <div style="margin-top:12px">
          <div class="om-total"><span>Subtotal</span><b>${money(detail.subtotal || detail.total)}</b></div>
          <div class="om-total"><span>Delivery</span><b>${Number(detail.delivery_fee) === 0 ? "Free" : money(detail.delivery_fee)}</b></div>
          <div class="om-total big"><span>Total</span><b>${money(detail.total)}</b></div>
        </div>
        <div style="margin-top:16px;background:var(--accent-soft);border-radius:12px;padding:16px;font-size:14px">
          <b>${esc(detail.customer)}</b>
          <p style="color:var(--adsoft);margin:4px 0">${esc([detail.address, detail.city, detail.state, detail.country].filter(Boolean).join(", "))}</p>
          <p style="color:var(--adsoft)">${esc(detail.phone || "")} · ${esc(detail.email)}</p>
          <p style="color:var(--admuted);margin-top:6px;font-size:12.5px">Placed ${fmtDate(detail.created_at)}</p>
        </div>`;
      $("orderModal").classList.add("open");
    } catch (err) { showError(err.message); }
    })();
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

  /* ---------------- Settings ---------------- */
  async function loadSettings() {
    try {
      const me = await api("/api/admin/me");
      $("adminEmail").textContent = "Signed in as " + me.email;
    } catch (err) { showError(err.message); }
  }

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