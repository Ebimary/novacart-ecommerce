/* Marygold Collections — Cart page */
(function () {
  "use strict";
  const { store, cart, toast, helpers } = window.Nova;

  let productCache = new Map();

  const itemsEl = () => document.getElementById("cartItems");
  const emptyEl = () => document.getElementById("cartEmpty");
  const layoutEl = () => document.getElementById("cartLayout");

  async function ensureProducts() {
    const ids = [...new Set(cart.items.map(i => i.id))];
    const missing = ids.filter(id => !productCache.has(id));
    if (missing.length) {
      const all = await store.get("/api/products?limit=200");
      all.forEach(p => productCache.set(p.id, p));
      missing.filter(id => !productCache.has(id)).forEach(id => {
        const p = all.find(x => x.id === id);
        if (p) productCache.set(id, p);
      });
    }
    return ids.map(id => productCache.get(id)).filter(Boolean);
  }

  function lineTotal(sum) {
    const t = cart.calculateTotals(cart.items);
    sum.subtotal = t.subtotal;
    sum.delivery = t.delivery;
    sum.total = t.total;
  }

  function rowPrice(item) {
    const p = productCache.get(item.id);
    if (p) return Number(p.price);
    const snap = Number(item.price);
    return Number.isFinite(snap) ? snap : 0;
  }

  function render() {
    const count = cart.count();
    if (!count) {
      emptyEl().style.display = "block";
      layoutEl().style.display = "none";
      itemsEl().innerHTML = "";
      document.getElementById("sumSubtotal").textContent = helpers.fmt(0);
      document.getElementById("sumDelivery").textContent = helpers.fmt(0);
      document.getElementById("sumTotal").textContent = helpers.fmt(0);
      document.getElementById("freeDeliveryNote").style.display = "none";
      return;
    }
    emptyEl().style.display = "none";
    layoutEl().style.display = "grid";

    const sum = {};
    lineTotal(sum);

    itemsEl().innerHTML = cart.items.map((item, idx) => {
      const p = productCache.get(item.id);
      const price = rowPrice(item);
      const name = p ? p.name : "Item #" + item.id;
      const image = p ? p.image : "";
      const category = p ? p.category : "";
      const out = p ? p.stock <= item.qty : false;
      const maxNote = out ? ' <small>· max available</small>' : (p ? "" : ' <small>· syncing details…</small>');
      return `<div class="cart-item">
        <img src="${helpers.esc(image)}" alt="${helpers.esc(name)}">
        <div class="ci-main">
          <span class="ci-cat">${helpers.esc(category)}</span>
          <a class="ci-name" href="/product?id=${p ? p.id : item.id}">${helpers.esc(name)}</a>
          <span class="ci-price">${helpers.fmt(price)}${maxNote}</span>
          <div class="ci-controls">
            <div class="qty">
              <button type="button" data-act="minus" data-idx="${idx}" aria-label="Decrease quantity">&minus;</button>
              <b>${item.qty}</b>
              <button type="button" data-act="plus" data-idx="${idx}" aria-label="Increase quantity">+</button>
            </div>
            <button class="remove-btn" data-act="remove" data-idx="${idx}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/></svg> Remove</button>
          </div>
        </div>
        <div class="ci-side"><span class="ci-total">${helpers.fmt(price * Number(item.qty))}</span></div>
      </div>`;
    }).join("");

    document.getElementById("sumSubtotal").textContent = helpers.fmt(sum.subtotal);
    document.getElementById("sumDelivery").textContent = sum.delivery === 0 ? "Free" : helpers.fmt(sum.delivery);
    document.getElementById("sumTotal").textContent = helpers.fmt(sum.total);
    document.getElementById("freeDeliveryNote").style.display = cart.isFreeDelivery(sum.subtotal) ? "block" : "none";
  }

  itemsEl().addEventListener("click", e => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const items = cart.items;
    const item = items[Number(btn.dataset.idx)];
    if (!item) return;
    const p = productCache.get(item.id);
    const act = btn.dataset.act;

    if (act === "plus") {
      if (p && item.qty >= p.stock) { toast("Only " + p.stock + " of this item available", "err"); return; }
      cart.setQty(item.id, item.qty + 1);
    } else if (act === "minus") {
      cart.setQty(item.id, item.qty - 1);
    } else if (act === "remove") {
      cart.remove(item.id);
      toast("Item removed");
    }
    render();
  });

  document.addEventListener("DOMContentLoaded", async () => {
    cart.load();
    cart.refreshBadge();
    if (!cart.count()) { render(); return; }
    /* Totals come straight from the price snapshots saved with each cart item,
       so the correct subtotal/total is visible immediately — no waiting on the
       products API (which previously left the summary at ₦0 until it loaded). */
    render();
    try {
      await ensureProducts();
      cart.attachPrices([...productCache.values()]);
    } catch (err) {
      console.warn("[cart] product details could not be refreshed — totals still shown from saved prices.", err);
    }
    store.configPromise().catch(() => {}).then(() => render());
  });
})();