/* NovaCart — Checkout page */
(function () {
  "use strict";
  const { store, cart, toast, helpers } = window.Nova;

  let productCache = new Map();
  let submitting = false;

  const form = () => document.getElementById("checkoutForm");
  const errorEl = () => document.getElementById("formError");
  const submitBtn = () => document.getElementById("placeOrder");

  function showError(msg) {
    const el = errorEl();
    el.textContent = msg;
    el.classList.add("show");
    window.scrollTo({ top: document.getElementById("main").offsetTop - 120, behavior: "smooth" });
  }
  function clearError() { errorEl().classList.remove("show"); }

  function markInvalid(input, invalid) {
    input.closest(".field").classList.toggle("invalid", invalid);
    return invalid;
  }

  function validate() {
    let ok = true;
    const checks = [
      { el: document.getElementById("name"), test: v => v.trim().length >= 2 },
      { el: document.getElementById("email"), test: v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) },
      { el: document.getElementById("phone"), test: v => v.replace(/[^\d]/g, "").length >= 7 },
      { el: document.getElementById("address"), test: v => v.trim().length >= 5 },
      { el: document.getElementById("city"), test: v => v.trim().length >= 2 },
      { el: document.getElementById("state"), test: v => v.trim().length >= 2 },
      { el: document.getElementById("country"), test: v => v.trim().length >= 2 }
    ];
    checks.forEach(c => { if (markInvalid(c.el, !c.test(c.el.value))) ok = false; });
    return ok;
  }

  function refreshTotals() {
    let subtotal = 0;
    for (const item of cart.items) {
      const p = productCache.get(item.id);
      if (p) subtotal += p.price * item.qty;
    }
    const delivery = cart.isFreeDelivery(subtotal) ? 0 : cart.deliveryFee(subtotal);
    document.getElementById("ckSubtotal").textContent = helpers.fmt(subtotal);
    document.getElementById("ckDelivery").textContent = delivery === 0 ? "Free" : helpers.fmt(delivery);
    document.getElementById("ckTotal").textContent = helpers.fmt(subtotal + delivery);
  }

  function renderSummary() {
    const box = document.getElementById("checkoutItems");
    box.innerHTML = cart.items.map((item, idx) => {
      const p = productCache.get(item.id);
      if (!p) return "";
      return `<div class="oi-line">
        <img src="${helpers.esc(p.image)}" alt="">
        <div class="oi-line-info"><b>${helpers.esc(p.name)}</b><small>Qty ${item.qty} &middot; ${helpers.fmt(p.price)}</small></div>
        <b>${helpers.fmt(p.price * item.qty)}</b>
      </div>`;
    }).join("");
    refreshTotals();
  }

  form().addEventListener("submit", e => {
    e.preventDefault();
    if (submitting) return;
    clearError();
    if (!cart.count()) { showError("Your cart is empty. Add something before checking out."); return; }
    if (!validate()) { showError("Please review the highlighted fields."); return; }

    const payload = {
      name: document.getElementById("name").value.trim(),
      email: document.getElementById("email").value.trim(),
      phone: document.getElementById("phone").value.trim(),
      address: document.getElementById("address").value.trim(),
      city: document.getElementById("city").value.trim(),
      state: document.getElementById("state").value.trim(),
      country: document.getElementById("country").value.trim(),
      payment_method: document.querySelector('input[name="pay"]:checked').value,
      items: cart.items.map(i => ({ productId: i.id, quantity: i.qty }))
    };

    submitting = true;
    submitBtn().disabled = true;
    submitBtn().textContent = "Placing order…";

    store.post("/api/orders", payload)
      .then(data => {
        cart.items = [];
        cart.save();
        cart.refreshBadge();
        const orderId = data.order && data.order.id;
        location.href = "/confirmation?order=" + orderId + "&email=" + encodeURIComponent(payload.email);
      })
      .catch(err => {
        submitting = false;
        submitBtn().disabled = false;
        submitBtn().textContent = "Place Order";
        showError(err.message);
      });
  });

  document.addEventListener("DOMContentLoaded", async () => {
    cart.load();
    cart.refreshBadge();
    if (!cart.count()) {
      document.getElementById("checkoutEmpty").style.display = "block";
      return;
    }
    document.getElementById("checkoutLayout").style.display = "grid";
    try {
      const all = await store.get("/api/products?limit=200");
      all.forEach(p => productCache.set(p.id, p));
      const missing = cart.items.filter(i => !productCache.has(i.id));
      if (missing.length) {
        document.getElementById("checkoutEmpty").querySelector("h2").textContent = "Some items are unavailable";
        document.getElementById("checkoutEmpty").querySelector("p").textContent = "A product in your cart is no longer available. Please update your cart.";
        document.getElementById("checkoutLayout").style.display = "none";
        document.getElementById("checkoutEmpty").style.display = "block";
        return;
      }
      renderSummary();
    } catch (err) {
      document.getElementById("checkoutLayout").style.display = "none";
      document.getElementById("checkoutEmpty").querySelector("h2").textContent = "Couldn't load your cart";
      document.getElementById("checkoutEmpty").querySelector("p").textContent = err.message;
      document.getElementById("checkoutEmpty").style.display = "block";
    }
  });
})();