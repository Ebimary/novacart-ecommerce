/* NovaCart — Product details page */
(function () {
  "use strict";
  const { store, cart, toast, helpers, cardHTML } = window.Nova;

  const q = helpers.parseQuery();
  const id = Number(q.id);
  let product = null;
  let qty = 1;

  const root = () => document.getElementById("productRoot");
  const relatedGrid = () => document.getElementById("relatedGrid");
  const crumbCat = () => document.getElementById("crumbCat");

  function stockLine(p) {
    if (p.stock <= 0) {
      return '<span class="stock-line out"><span class="dot"></span>Out of stock</span>';
    }
    if (p.stock <= 10) {
      return `<span class="stock-line low"><span class="dot"></span>Only ${p.stock} left in stock — order soon</span>`;
    }
    return `<span class="stock-line in"><span class="dot"></span>In stock &mdash; ${p.stock} available</span>`;
  }

  function markup(p) {
    const soldOut = p.stock <= 0;
    const qtyControls = soldOut
      ? '<div class="stock-line out"><span class="dot"></span>Out of stock</div>'
      : `<div class="qty" aria-label="Quantity">
          <button type="button" id="qtyMinus" aria-label="Decrease quantity">&minus;</button>
          <b id="qtyValue">${qty}</b>
          <button type="button" id="qtyPlus" aria-label="Increase quantity">+</button>
        </div>`;
    const addBtn = soldOut
      ? '<button class="btn btn-dark" disabled>Unavailable</button>'
      : '<button class="btn btn-accent" id="addToCart">Add to Cart</button>';
    const buyBtn = soldOut ? "" : '<button class="btn btn-outline" id="buyNow">Buy Now</button>';

    return `
      <div class="pd-media">
        <img class="main-img" src="${helpers.esc(p.image || "")}" alt="${helpers.esc(p.name)}">
      </div>
      <div class="pd-info">
        <span class="pd-cat">${helpers.esc(p.category)}</span>
        <h1 class="pd-name">${helpers.esc(p.name)}</h1>
        <div class="pd-rate">
          <span class="stars" aria-hidden="true">${helpers.stars(p.rating)}</span>
          <span><b>${Number(p.rating).toFixed(1)}</b> &middot; customer rating</span>
        </div>
        <div class="pd-price">${helpers.fmt(p.price)} <small>per item</small></div>
        ${p.description ? `<p class="pd-desc">${helpers.esc(p.description)}</p>` : ""}
        ${stockLine(p)}
        <div class="pd-actions">
          ${qtyControls}
          ${addBtn}
          ${buyBtn}
        </div>
        <div class="pd-meta">
          <h4>Why you&rsquo;ll love it</h4>
          <ul class="meta-list">
            <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M20 6L9 17l-5-5"/></svg>Quality-checked before dispatch</li>
            <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 7h11v8H3z"/><path d="M14 10h4l3 3v2h-7"/><circle cx="7" cy="17" r="1.6"/><circle cx="17" cy="17" r="1.6"/></svg>Free delivery on orders over ₦100,000</li>
            <li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M3 12a9 9 0 109-9 9 9 0 00-6.4 2.6L3 8"/><path d="M3 3v5h5"/></svg>Easy 14-day returns</li>
          </ul>
        </div>
      </div>`;
  }

  function bindActions() {
    const qtyPlus = document.getElementById("qtyPlus");
    const qtyMinus = document.getElementById("qtyMinus");
    const addToCart = document.getElementById("addToCart");
    const buyNow = document.getElementById("buyNow");
    if (qtyPlus) {
      qtyPlus.addEventListener("click", () => {
        if (qty < product.stock) { qty++; document.getElementById("qtyValue").textContent = qty; }
        else toast("Only " + product.stock + " available", "err");
      });
    }
    if (qtyMinus) qtyMinus.addEventListener("click", () => {
      if (qty > 1) { qty--; document.getElementById("qtyValue").textContent = qty; }
    });
    if (addToCart) addToCart.addEventListener("click", () => {
      cart.add(product.id, qty);
      toast("Added to cart");
    });
    if (buyNow) buyNow.addEventListener("click", () => {
      cart.add(product.id, qty);
      location.href = "/checkout";
    });
  }

  function loadRelated() {
    store.get(`/api/products/${id}/related`)
      .then(products => { relatedGrid().innerHTML = products.map(p => cardHTML(p)).join(""); })
      .catch(() => { relatedGrid().innerHTML = ""; });
  }

  function load() {
    if (!id) {
      root().innerHTML = '<div style="padding:60px;text-align:center"><h1>Product not found</h1><p style="color:var(--muted)">This item may have been removed.</p><a class="btn btn-accent" href="/shop" style="margin-top:16px">Back to shop</a></div>';
      return;
    }
    store.get(`/api/products/${id}`)
      .then(p => {
        product = p;
        document.title = `${p.name} — NovaCart`;
        crumbCat().innerHTML = `<a href="/category/${encodeURIComponent(p.category_slug || "")}">${helpers.esc(p.category)}</a>`;
        root().innerHTML = markup(p);
        bindActions();
        loadRelated();
      })
      .catch(err => {
        root().innerHTML = `<div style="padding:60px;text-align:center"><h1>Product not found</h1><p style="color:var(--muted)">${helpers.esc(err.message)}</p><a class="btn btn-accent" href="/shop" style="margin-top:16px">Back to shop</a></div>`;
      });
  }

  document.addEventListener("DOMContentLoaded", load);
})();