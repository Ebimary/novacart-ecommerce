/* Marygold Collections — Customer order tracking page.
   Uses the secure tracking token from the link, or an order-number + email
   lookup. Never accepts a bare order ID. */
(function () {
  "use strict";
  const { store, cart, helpers, toast } = window.Nova;

  const $ = id => document.getElementById(id);
  const q = helpers.parseQuery();
  const pageToken = (q.token || "").trim();

  const STATUSES = ["Pending", "Confirmed", "Processing", "Shipped", "Delivered", "Cancelled"];

  function fmtDateTime(iso) {
    if (!iso) return "";
    try {
      return new Date(iso.replace(" ", "T") + "Z").toLocaleString("en-NG", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
    } catch (_) { return String(iso || "").slice(0, 16); }
  }

  function pillClass(kind, value) {
    const map = {
      Pending: "track-pill track-pill-warn",
      Confirmed: "track-pill track-pill-ok",
      Processing: "track-pill track-pill-info",
      Shipped: "track-pill track-pill-info",
      Delivered: "track-pill track-pill-ok",
      Cancelled: "track-pill track-pill-bad"
    };
    if (kind === "payment") {
      if (value === "Paid") return "track-pill track-pill-ok";
      if (value === "Failed") return "track-pill track-pill-bad";
      if (value === "Refunded") return "track-pill track-pill-dim";
      return "track-pill track-pill-warn";
    }
    return map[value] || "track-pill track-pill-dim";
  }

  /* ---- Timeline ---------------------------------------------------- */
  const STEPS = [
    { key: "", label: "Order Placed" },
    { key: "Confirmed", label: "Confirmed" },
    { key: "Processing", label: "Processing" },
    { key: "Shipped", label: "Shipped" },
    { key: "Delivered", label: "Delivered" }
  ];
  function stepIndexFor(status) {
    const map = { Pending: 0, Confirmed: 1, Processing: 2, Shipped: 3, Delivered: 4 };
    return map[status] != null ? map[status] : 0;
  }

  function buildTimeline(o) {
    /* Map each reached status to the last time that status was recorded. */
    const times = { "": o.created_at };
    const history = o.history || [];
    for (const h of history) {
      if (h.new_status && STATUSES.includes(h.new_status)) times[h.new_status] = h.changed_at;
    }
    const reached = stepIndexFor(String(o.status || "Pending"));
    const timeline = $("trkTimeline");
    timeline.innerHTML = STEPS.map((step, i) => {
      const done = i <= reached;
      const current = i === reached && String(o.status) !== "Delivered";
      return `
        <li class="t-step ${done ? "done" : ""} ${current ? "current" : ""}" role="listitem" ${current ? 'aria-current="step"' : ""}>
          <span class="t-dot" aria-hidden="true">${done ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg>' : ""}</span>
          <span class="t-body">
            <b>${helpers.esc(step.label)}</b>
            ${done && times[step.key] ? `<small>${helpers.esc(fmtDateTime(times[step.key]))}</small>` : ""}
          </span>
        </li>`;
    }).join("") +
    `<span class="track-a11y-note">Current status: ${helpers.esc(o.status)}</span>`;
  }

  function renderCancelled(o) {
    const timeline = $("trkTimeline");
    timeline.innerHTML = `
      <li class="t-step done" role="listitem">
        <span class="t-dot" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg></span>
        <span class="t-body"><b>Order Placed</b>${o.created_at ? `<small>${helpers.esc(fmtDateTime(o.created_at))}</small>` : ""}</span>
      </li>
      <li class="t-step cancel" role="listitem" aria-current="step">
        <span class="t-dot" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M18 6L6 18M6 6l12 12"/></svg></span>
        <span class="t-body"><b>Order Cancelled</b><small>${o.status_updated_at ? helpers.esc(fmtDateTime(o.status_updated_at)) : ""}</small></span>
      </li>
      <p class="cancel-note">This order has been cancelled.</p>`;
  }

  /* ---- Detail + shipping rendering ---------------------------------- */
  function renderItems(items) {
    return (items || []).map(it => `
      <div class="oi-line" style="display:flex;gap:14px;align-items:center;padding:8px 0;border-bottom:1px solid var(--line-soft)">
        <img src="${helpers.esc(it.image || "")}" alt="${helpers.esc(it.product_name || "")}" style="width:56px;height:64px;object-fit:cover;border-radius:10px;background:var(--accent-soft)">
        <div style="flex:1;min-width:0">
          <b style="font-size:14.5px">${helpers.esc(it.product_name || "Item")}</b><br>
          <small style="color:var(--muted)">Qty ${Number(it.quantity)} &middot; ${helpers.fmt(it.price)} each</small>
        </div>
        <b>${helpers.fmt(Number(it.price) * Number(it.quantity))}</b>
      </div>`).join("") || "<p style='color:var(--muted)'>No items found.</p>";
  }

  function renderDetails(o) {
    $("trkOrderNo").textContent = o.order_number || ("#" + o.id);
    $("trkCustomer").textContent = o.customer || "";
    $("trkPills").innerHTML = `
      <span class="${pillClass("status", o.status)}">${helpers.esc(o.status)}</span>
      <span class="${pillClass("payment", o.payment_status)}">${helpers.esc(o.payment_label || o.payment_status)}</span>
      <span class="track-pill track-pill-dim">${helpers.esc(o.payment_method || "Cash on Delivery")}</span>`;

    $("trkDetails").innerHTML = `
      <div class="td-row"><dt>Order number</dt><dd>${helpers.esc(o.order_number || ("#" + o.id))}</dd></div>
      <div class="td-row"><dt>Order date</dt><dd>${helpers.esc(fmtDateTime(o.created_at))}</dd></div>
      <div class="td-row"><dt>Customer</dt><dd>${helpers.esc(o.customer || "")}</dd></div>
      <div class="td-row"><dt>Total</dt><dd><b>${helpers.fmt(o.total)}</b></dd></div>
      <div class="td-row"><dt>Payment method</dt><dd>${helpers.esc(o.payment_method || "Cash on Delivery")}</dd></div>
      <div class="td-row"><dt>Payment status</dt><dd>${helpers.esc(o.payment_label || o.payment_status)}</dd></div>
      <div class="td-row"><dt>Order status</dt><dd>${helpers.esc(o.status || "Pending")}</dd></div>
      <div class="td-row"><dt>Delivery</dt><dd>${Number(o.delivery_fee) === 0 ? "Free" : helpers.fmt(o.delivery_fee)}</dd></div>`;

    const ship = $("shipCard");
    const carrier = String(o.shipping_carrier || "");
    const trackingNumber = String(o.tracking_number || "");
    if (carrier || trackingNumber) {
      const links = o.carrier_links || {};
      ship.hidden = false;
      $("trkShipping").innerHTML = `
        ${carrier ? `<p class="ship-line"><span>Shipped via</span><b>${helpers.esc(carrier)}</b></p>` : ""}
        ${trackingNumber ? `<p class="ship-line"><span>Tracking number</span><b>${helpers.esc(trackingNumber)}</b></p>` : ""}
        ${links.url ? `<a class="btn btn-accent btn-sm" href="${helpers.esc(links.url)}" target="_blank" rel="noopener">Track Shipment ↗</a>` : ""}`;
    } else {
      ship.hidden = true;
    }

    const wa = $("waCard");
    if (o.whatsapp_url) {
      wa.hidden = false;
      $("waLink").href = o.whatsapp_url;
    } else {
      wa.hidden = true;
    }

    const hist = $("historyCard");
    const history = o.history || [];
    if (history.length) {
      hist.hidden = false;
      $("trkHistory").innerHTML = history.map((h, i) => {
        const label = i === 0 && (!h.old_status || h.old_status === "Pending")
          ? "Order placed"
          : (h.new_status || "Order placed");
        return `
          <li class="th-item">
            <span class="th-check" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg></span>
            <span class="th-body">
              <b>${helpers.esc(label)}</b>
              <small>${helpers.esc(fmtDateTime(h.changed_at))}</small>
            </span>
            ${h.note ? `<em>${helpers.esc(h.note)}</em>` : ""}
          </li>`;
      }).join("");
    } else {
      hist.hidden = true;
    }
  }

  /* ---- Main render -------------------------------------------------- */
  function render(o) {
    $("lookupSection").style.display = "none";
    $("trackResult").hidden = false;
    renderDetails(o);

    const status = String(o.status || "Pending");
    if (status === "Cancelled") renderCancelled(o);
    else buildTimeline(o);

    /* Items card */
    const itemsCard = $("itemsCard");
    if (itemsCard) {
      itemsCard.hidden = false;
      itemsCard.innerHTML = `<h3 style="font-size:19px;margin-bottom:14px">Items purchased</h3>${renderItems(o.items)}` +
        `<div style="margin-top:12px">
          <div class="total-line"><span>Subtotal</span><b>${helpers.fmt(o.subtotal)}</b></div>
          <div class="total-line"><span>Delivery</span><b>${Number(o.delivery_fee) === 0 ? "Free" : helpers.fmt(o.delivery_fee)}</b></div>
          <div class="total-line big"><span>Total</span><b>${helpers.fmt(o.total)}</b></div>
        </div>`;
    }

    $("trackResult").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function showNotFound(title, message) {
    $("lookupSection").style.display = "";
    $("trackResult").hidden = true;
    const err = $("lookupError");
    err.style.display = "block";
    err.textContent = message || "We couldn't find that order.";
    $("lookupSection").scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function loadByToken(token) {
    store.get("/api/track-order?token=" + encodeURIComponent(token))
      .then(o => {
        render(o);
        /* Remove the token from the address bar so it isn't shared accidentally. */
        if (history.replaceState) history.replaceState(null, "", "/track-order");
      })
      .catch(err => showNotFound("", err.message));
  }

  /* ---- Lookup form -------------------------------------------------- */
  function bindLookup() {
    const form = $("lookupForm");
    form.addEventListener("submit", e => {
      e.preventDefault();
      const err = $("lookupError");
      err.style.display = "none";
      const orderNo = $("lookupOrderNo").value.trim();
      const email = $("lookupEmail").value.trim();
      if (!orderNo || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        err.textContent = "Please enter both your order number and the email you ordered with.";
        err.style.display = "block";
        return;
      }
      const btn = $("lookupBtn");
      btn.disabled = true;
      btn.textContent = "Looking up…";
      store.post("/api/track-lookup", { order_number: orderNo, email })
        .then(o => {
          render(o);
          $("lookupSection").style.display = "none";
        })
        .catch(err2 => {
          showNotFound("", err2.message);
          $("lookupSection").style.display = "";
        })
        .finally(() => {
          btn.disabled = false;
          btn.textContent = "Track Order";
        });
    });

    $("lookupAgainBtn").addEventListener("click", () => {
      $("trackResult").hidden = true;
      $("lookupSection").style.display = "";
      const err = $("lookupError");
      err.style.display = "none";
      $("lookupSection").scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  function init() {
    cart.load();
    cart.refreshBadge();
    bindLookup();
    if (pageToken && pageToken.length >= 20) {
      loadByToken(pageToken);
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();