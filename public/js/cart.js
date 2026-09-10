/* NovaCart — Cart page */
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
    sum.subtotal = 0;
    for (const item of cart.items) {
      const p = productCache.get(item.id);
      if (p) sum.subtotal += p.price * item.qty;
    }
    sum.delivery = cart.isFreeDelivery(sum.subtotal) ? 0 : cart.deliveryFee(sum.subtotal);
    sum.total = sum.subtotal + sum.delivery;
  }

  function render() {
    const count = cart.count();
    if (!count) {
      emptyEl().style.display = "block";
      layoutEl().style.display = "none";
      return;
    }
    emptyEl().style.display = "none";
    layoutEl().style.display = "grid";

    const sum = {};
    lineTotal(sum);

    itemsEl().innerHTML = cart.items.map((item, idx) => {
      const p = productCache.get(item.id);
      if (!p) return "";
      const out = p.stock <= item.qty;
      return `<div class="cart-item">
        <img src="${helpers.esc(p.image)}" alt="${helpers.esc(p.name)}">
        <div class="ci-main">
          <span class="ci-cat">${helpers.esc(p.category)}</span>
          <a class="ci-name" href="/product?id=${p.id}">${helpers.esc(p.name)}</a>
          <span class="ci-price">${helpers.fmt(p.price)}${out ? ' <small>· max available</small>' : ""}</span>
          <div class="ci-controls">
            <div class="qty">
              <button type="button" data-act="minus" data-idx="${idx}" aria-label="Decrease quantity">&minus;</button>
              <b>${item.qty}</b>
              <button type="button" data-act="plus" data-idx="${idx}" aria-label="Increase quantity">+</button>
            </div>
            <button class="remove-btn" data-act="remove" data-idx="${idx}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/></svg> Remove</button>
          </div>
        </div>
        <div class="ci-side"><span class="ci-total">${helpers.fmt(p.price * item.qty)}</span></div>
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
    try {
      await ensureProducts();
    } catch (err) {
      itemsEl().innerHTML = `<p style="color:var(--danger)">${helpers.esc(err.message)}</p>`;
      return;
    }
    render();
  });
})();