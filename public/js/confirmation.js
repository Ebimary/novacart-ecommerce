/* NovaCart — Order confirmation page */
(function () {
  "use strict";
  const { store, cart, helpers } = window.Nova;

  const q = helpers.parseQuery();
  const orderId = q.order;
  const email = q.email || "";
  const root = () => document.getElementById("confirmRoot");

  function fmtDate(iso) {
    try {
      return new Date(iso.replace(" ", "T") + "Z").toLocaleDateString("en-NG", { day: "numeric", month: "short", year: "numeric" });
    } catch (_) {
      return iso ? iso.slice(0, 10) : "";
    }
  }

  function markup(o) {
    return `
      <div class="confirm-hero">
        <div class="check-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg></div>
        <h1>Thank you, ${helpers.esc(o.customer.split(" ")[0])}!</h1>
        <p>Your order has been placed successfully. A confirmation email is on its way to <b>${helpers.esc(o.email)}</b>.</p>
      </div>

      <div class="order-card">
        <div class="order-card-head">
          <div>
            <div class="order-number">Order ${helpers.esc(o.order_number || ("#" + o.id))}</div>
            <small style="color:var(--muted)">Placed ${fmtDate(o.created_at)}</small>
          </div>
          <span class="status-pill"><span class="dot"></span>${helpers.esc(o.status)}</span>
        </div>
        <h3 style="font-size:17px;margin-bottom:14px">Items purchased</h3>
        ${(o.items || []).map(it => `
          <div class="oi-line" style="display:flex;gap:14px;align-items:center;padding:8px 0;border-bottom:1px solid var(--line-soft)">
            <img src="${helpers.esc(it.image || "")}" alt="${helpers.esc(it.product_name || "")}" style="width:58px;height:66px;object-fit:cover;border-radius:10px;background:var(--accent-soft)">
            <div style="flex:1;min-width:0">
              <b style="font-size:14.5px">${helpers.esc(it.product_name || "")}</b><br>
              <small style="color:var(--muted)">Qty ${it.quantity} &middot; ${helpers.fmt(it.price)} each</small>
            </div>
            <b>${helpers.fmt(it.price * it.quantity)}</b>
          </div>`).join("") || "<p style='color:var(--muted)'>No items found.</p>"}
        <div style="margin-top:10px">
          <div class="total-line"><span>Subtotal</span><b>${helpers.fmt(o.subtotal || o.total)}</b></div>
          <div class="total-line"><span>Delivery</span><b>${Number(o.delivery_fee) === 0 ? "Free" : helpers.fmt(o.delivery_fee)}</b></div>
          <div class="total-line big"><span>Total</span><b>${helpers.fmt(o.total)}</b></div>
          <div class="total-line"><span>Payment method</span><b>${helpers.esc(o.payment_method || "Cash on Delivery")}</b></div>
        </div>
      </div>

      <div class="order-card">
        <h3 style="font-size:17px;margin-bottom:10px">Delivery information</h3>
        <div class="ship-info" style="background:var(--accent-soft);border-radius:12px;padding:18px;font-size:14px">
          <b>${helpers.esc(o.customer)}</b>
          <p style="color:var(--ink-soft);margin:4px 0">${helpers.esc([o.address, o.city, o.state, o.country].filter(Boolean).join(", "))}</p>
          <p style="color:var(--ink-soft);margin:0">${helpers.esc(o.phone || "")} &middot; ${helpers.esc(o.email)}</p>
        </div>
      </div>

      <div style="display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin-top:10px">
        <a class="btn btn-accent" href="/shop">Continue Shopping</a>
        <a class="btn btn-outline" href="/">Back to Home</a>
      </div>
    `;
  }

  function load() {
    if (!orderId || !email) {
      root().innerHTML = `<div style="text-align:center;padding:60px"><h1>Order details unavailable</h1><p style="color:var(--muted)">We couldn't find that order. If you just placed it, try the link from your confirmation email.</p><a class="btn btn-accent" href="/shop" style="margin-top:14px">Continue Shopping</a></div>`;
      return;
    }
    store.get(`/api/orders/${encodeURIComponent(orderId)}?email=${encodeURIComponent(email)}`)
      .then(o => { root().innerHTML = markup(o); })
      .catch(err => {
        root().innerHTML = `<div style="text-align:center;padding:60px"><h1>Order not found</h1><p style="color:var(--muted)">${helpers.esc(err.message)}</p><a class="btn btn-accent" href="/shop" style="margin-top:14px">Continue Shopping</a></div>`;
      });
  }

  document.addEventListener("DOMContentLoaded", () => {
    cart.load();
    cart.refreshBadge();
    load();
  });
})();