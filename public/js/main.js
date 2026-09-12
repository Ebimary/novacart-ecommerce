/* Marygold Collections — shared storefront behaviour (every customer page) */
(function () {
  "use strict";

  const CART_KEY = "novaCart";
  const CATEGORY_META = {
    Clothing: { image: "https://images.unsplash.com/photo-1441986300917-64674bd600d8?auto=format&fit=crop&w=700&q=80", blurb: "Tailored and everyday essentials" },
    Shoes: { image: "https://images.unsplash.com/photo-1590874103328-eac38a683ce7?auto=format&fit=crop&w=700&q=80", blurb: "From sneakers to statement styles" },
    Jewelry: { image: "https://images.unsplash.com/photo-1599643478518-a784e5dc4c8f?auto=format&fit=crop&w=700&q=80", blurb: "Pieces that finish every outfit" },
    Accessories: { image: "https://images.unsplash.com/photo-1523170335258-f5ed11844a49?auto=format&fit=crop&w=700&q=80", blurb: "Watches, belts and finishing touches" },
    Bags: { image: "https://images.unsplash.com/photo-1584917865442-de89df76afd3?auto=format&fit=crop&w=700&q=80", blurb: "Carry everyday in style" }
  };

  const store = {
    config: null,
    async configPromise() {
      if (!store.config) store.config = await store.get("/api/config");
      return store.config;
    },
    get(url) {
      return fetch(url).then(r => handleStatus(r));
    },
    post(url, body) {
      return fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {})
      }).then(r => handleStatus(r));
    }
  };

  async function handleStatus(r) {
    let data = null;
    try { data = await r.json(); } catch (_) { /* no body */ }
    if (!r.ok) {
      const err = new Error((data && data.error) || "Something went wrong. Please try again.");
      err.status = r.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  const helpers = {
    fmt(n) {
      return new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN", maximumFractionDigits: 0 }).format(Number(n) || 0);
    },
    esc(s) {
      return String(s == null ? "" : s)
        .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
    },
    stars(rating) {
      const r = Math.round(Number(rating) || 0);
      return "★★★★★".slice(0, Math.max(0, Math.min(5, r))) + "☆☆☆☆☆".slice(0, 5 - Math.max(0, Math.min(5, r)));
    },
    parseQuery() {
      const out = {};
      new URLSearchParams(location.search).forEach((v, k) => { out[k] = v; });
      return out;
    }
  };

  /* ---------------- Cart ---------------- */
  const cart = {
    items: [],
    load() {
      try { cart.items = JSON.parse(localStorage.getItem(CART_KEY) || "[]"); } catch (_) { cart.items = []; }
      return cart.items;
    },
    save() { localStorage.setItem(CART_KEY, JSON.stringify(cart.items)); },
    count() { return cart.items.reduce((s, i) => s + (Number(i.qty) || 0), 0); },
    add(id, qty) {
      const items = cart.items;
      const existing = items.find(i => i.id === id);
      if (existing) existing.qty += qty || 1;
      else items.push({ id, qty: qty || 1 });
      cart.save();
      cart.refreshBadge();
    },
    setQty(id, qty) {
      const it = cart.items.find(i => i.id === id);
      if (!it) return;
      it.qty = qty;
      if (it.qty < 1) cart.items = cart.items.filter(i => i.id !== id);
      cart.save();
    },
    change(id, delta) {
      const it = cart.items.find(i => i.id === id);
      if (it) cart.setQty(id, it.qty + delta);
    },
    remove(id) { cart.items = cart.items.filter(i => i.id !== id); cart.save(); cart.refreshBadge(); },
    refreshBadge() {
      const count = cart.count();
      document.querySelectorAll("#cartCount").forEach(el => { el.textContent = count; el.style.display = count ? "grid" : "none"; });
    },
    deliveryFee(subtotal) {
      return store.config.deliveryFee || 2500;
    },
    isFreeDelivery(subtotal) {
      return subtotal >= (store.config.freeDeliveryThreshold || 100000);
    }
  };

  function refreshCartBadges() {
    cart.load();
    cart.refreshBadge();
  }

  /* ---------------- Toast ---------------- */
  let toastTimer = null;
  function toast(message, type) {
    let el = document.querySelector("#toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "toast";
      el.className = "toast";
      document.body.appendChild(el);
    }
    el.innerHTML = (type === "err" ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/></svg>' : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>') +
      `<span>${helpers.esc(message)}</span>`;
    el.classList.remove("err");
    if (type === "err") el.classList.add("err");
    requestAnimationFrame(() => el.classList.add("show"));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
  }

  /* ---------------- Product card ---------------- */
  function cardHTML(p, opts) {
    const out = p.stock <= 0;
    const badge = opts && opts.featuredLabel && p.featured ? '<span class="card-badge">Featured</span>' : "";
    const sold = out ? '<div class="card-soldout"><span>Out of stock</span></div>' : "";
    const addBtn = out
      ? '<button class="btn btn-dark btn-sm" disabled>Out of Stock</button>'
      : `<button class="btn btn-accent btn-sm add-btn" data-id="${p.id}">Add to Cart</button>`;
    return `<article class="card">
      <a class="card-media" href="/product?id=${p.id}" aria-label="${helpers.esc(p.name)}">
        ${badge}
        ${sold}
        <img src="${helpers.esc(p.image || "")}" alt="${helpers.esc(p.name)}" loading="lazy">
      </a>
      <div class="card-body">
        <span class="card-cat">${helpers.esc(p.category)}</span>
        <h3 class="card-name"><a href="/product?id=${p.id}">${helpers.esc(p.name)}</a></h3>
        <div class="card-rate"><span class="stars">${helpers.stars(p.rating)}</span><span>${Number(p.rating).toFixed(1)}</span></div>
        <div class="card-foot">
          <span class="price">${helpers.fmt(p.price)}</span>
          ${addBtn}
        </div>
      </div>
    </article>`;
  }

  /* ---------------- Nav / header behaviour ---------------- */
  function initHeader() {
    const menuToggle = document.getElementById("menuToggle");
    const mobileMenu = document.getElementById("mobileMenu");
    const mmClose = document.getElementById("mmClose");
    const mmScrim = document.getElementById("mmScrim");
    const searchToggle = document.getElementById("searchToggle");
    const searchOverlay = document.getElementById("searchOverlay");
    const searchClose = document.getElementById("searchClose");
    const searchInput = document.getElementById("searchInput");
    const searchForm = document.getElementById("searchForm");
    const dropItem = document.querySelector(".nav-item.has-drop");

    if (menuToggle && mobileMenu) {
      const open = () => {
        mobileMenu.classList.add("open");
        menuToggle.classList.add("open");
        menuToggle.setAttribute("aria-expanded", "true");
        document.body.style.overflow = "hidden";
      };
      const close = () => {
        mobileMenu.classList.remove("open");
        menuToggle.classList.remove("open");
        menuToggle.setAttribute("aria-expanded", "false");
        document.body.style.overflow = "";
      };
      menuToggle.addEventListener("click", () => mobileMenu.classList.contains("open") ? close() : open());
      if (mmClose) mmClose.addEventListener("click", close);
      if (mmScrim) mmScrim.addEventListener("click", close);
      document.addEventListener("keydown", e => { if (e.key === "Escape" && mobileMenu.classList.contains("open")) close(); });
    }

    if (searchToggle && searchOverlay) {
      const open = () => {
        searchOverlay.classList.add("open");
        searchToggle.setAttribute("aria-expanded", "true");
        setTimeout(() => searchInput && searchInput.focus(), 60);
      };
      const close = () => {
        searchOverlay.classList.remove("open");
        searchToggle.setAttribute("aria-expanded", "false");
      };
      searchToggle.addEventListener("click", () => searchOverlay.classList.contains("open") ? close() : open());
      if (searchClose) searchClose.addEventListener("click", close);
      document.addEventListener("keydown", e => { if (e.key === "Escape") close(); });
    }

    if (searchForm && searchInput) {
      searchForm.addEventListener("submit", e => {
        e.preventDefault();
        const q = searchInput.value.trim();
        const base = window.APP_SHOP_URL || "/shop";
        location.href = q ? `${base}?q=${encodeURIComponent(q)}` : base;
      });
    }

    if (dropItem) {
      dropItem.querySelector(".drop-btn").addEventListener("click", e => {
        e.preventDefault();
        dropItem.classList.toggle("open");
      });
      document.addEventListener("click", e => {
        if (dropItem.classList.contains("open") && !dropItem.contains(e.target)) dropItem.classList.remove("open");
      });
    }

    document.addEventListener("click", e => {
      const addBtn = e.target.closest(".add-btn");
      if (!addBtn) return;
      const id = Number(addBtn.dataset.id);
      cart.add(id, 1);
      toast("Added to cart");
    });
  }

  function initCategoryCards() {
    /* Fallback imagery for the homepage "Shop by category" grid when the
       category has no custom image yet. */
    document.querySelectorAll("[data-cat-card]").forEach(el => {
      const cat = el.dataset.catCard;
      const meta = CATEGORY_META[cat] || {};
      const img = meta.image || "https://images.unsplash.com/photo-1441986300917-64674bd600d8?auto=format&fit=crop&w=700&q=80";
      el.innerHTML = `<img src="${img}" alt="${helpers.esc(cat)} collection" loading="lazy">` +
        `<span class="cat-label"><b>${helpers.esc(cat)}</b><small>${helpers.esc(meta.blurb || "Shop the collection")}</small></span>`;
    });
  }

  function catCardHTML(c) {
    const meta = CATEGORY_META[c.name] || {};
    const img = c.image || meta.image || "https://images.unsplash.com/photo-1441986300917-64674bd600d8?auto=format&fit=crop&w=700&q=80";
    const n = Number(c.product_count) || 0;
    const sub = n > 0
      ? `${n} product${n === 1 ? "" : "s"}`
      : (c.description || meta.blurb || "Shop the collection");
    return `<a class="cat-card" href="/category/${encodeURIComponent(c.slug)}" aria-label="Shop ${helpers.esc(c.name)}">
      <img src="${helpers.esc(img)}" alt="${helpers.esc(c.name)} collection" loading="lazy">
      <span class="cat-label"><b>${helpers.esc(c.name)}</b><small>${helpers.esc(sub)}</small></span>
    </a>`;
  }

  function fillCategoryLinks(cats) {
    if (!cats || !cats.length) return;
    const links = cats.map(c =>
      `<a href="/category/${encodeURIComponent(c.slug)}">${helpers.esc(c.name)}</a>`
    ).join("");

    const navDrop = document.querySelector(".nav-item.has-drop .dropdown");
    if (navDrop) navDrop.innerHTML = links;

    const mmCats = document.querySelector(".mm-cats");
    if (mmCats) mmCats.innerHTML = links;

    document.querySelectorAll(".footer-col").forEach(col => {
      const h4 = col.querySelector("h4");
      if (h4 && /^categories$/i.test(h4.textContent.trim())) {
        col.querySelectorAll("a").forEach(a => a.remove());
        h4.insertAdjacentHTML("afterend", links);
      }
    });
  }

  function initDynamicCategories() {
    store.get("/api/categories")
      .then(cats => {
        window.Nova.categories = cats;
        fillCategoryLinks(cats);
        const catGrid = document.getElementById("catGrid");
        if (catGrid && cats.length) catGrid.innerHTML = cats.map(catCardHTML).join("");
      })
      .catch(() => { /* keep static/fallback markup */ });
  }

  function initFooterYear() {
    const y = document.getElementById("year");
    if (y) y.textContent = new Date().getFullYear();
  }

  /* One shared footer for every storefront page. The markup lives in a single
     file (public/components/footer.html); each page just ships an empty
     <footer data-site-footer></footer> that is filled here. Admin pages never
     load main.js, so they stay footer-free automatically. */
  function initSiteFooter() {
    const host = document.querySelector("[data-site-footer]");
    if (!host) return;
    fetch("/components/footer.html", { cache: "no-cache" })
      .then(r => {
        if (!r.ok) throw new Error("footer unavailable");
        return r.text();
      })
      .then(html => {
        host.innerHTML = html;
        initFooterYear();
        const cats = window.Nova && window.Nova.categories;
        if (cats && cats.length) fillCategoryLinks(cats);
      })
      .catch(() => { /* keep static/fallback markup, if any */ });
  }

  const WA_ICON = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><path d="M20.52 3.48A11.86 11.86 0 0 0 12.06 0C5.5 0 .16 5.34.16 11.91c0 2.1.55 4.15 1.59 5.96L.05 24l6.28-1.65a11.91 11.91 0 0 0 5.73 1.46h.01c6.56 0 11.9-5.34 11.9-11.91 0-3.18-1.24-6.17-3.45-8.42ZM12.07 21.8h-.01a9.88 9.88 0 0 1-5.04-1.38l-.36-.21-3.73.98 1-3.64-.23-.37a9.88 9.88 0 0 1-1.52-5.27C2.18 6.47 6.61 2.05 12.06 2.05c2.64 0 5.12 1.03 6.99 2.9a9.85 9.85 0 0 1 2.9 7c0 5.45-4.43 9.87-9.88 9.87Zm5.41-7.4c-.3-.15-1.77-.87-2.04-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.17-.17.2-.35.22-.65.07-.3-.15-1.25-.46-2.38-1.47-.88-.79-1.47-1.77-1.64-2.07-.17-.3-.02-.46.13-.61.14-.14.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.07-.15-.67-1.62-.92-2.22-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.79.37-.27.3-1.04 1.02-1.04 2.49s1.07 2.89 1.22 3.09c.15.2 2.1 3.21 5.09 4.5.71.31 1.27.5 1.7.64.71.23 1.35.2 1.86.12.57-.09 1.77-.72 2.02-1.42.25-.7.25-1.3.17-1.42-.07-.12-.27-.2-.57-.35Z"/></svg>';

  function initWhatsAppFloat() {
    if (document.querySelector(".wa-float")) return;
    store.configPromise()
      .then(cfg => {
        if (!cfg.whatsappUrl || document.querySelector(".wa-float")) return;
        const a = document.createElement("a");
        a.className = "wa-float";
        a.href = cfg.whatsappUrl;
        a.setAttribute("aria-label", "Chat with us on WhatsApp");
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.innerHTML = WA_ICON + '<span class="wa-tip" aria-hidden="true">Chat with us</span>';
        document.body.appendChild(a);
      })
      .catch(() => { /* no WhatsApp number configured — skip the button */ });
  }

  document.addEventListener("DOMContentLoaded", () => {
    refreshCartBadges();
    initHeader();
    initCategoryCards();
    initSiteFooter();
    initFooterYear();
    initDynamicCategories();
    initWhatsAppFloat();
    store.configPromise().catch(() => {});
  });

  window.Nova = { store, cart, toast, helpers, cardHTML, CATEGORY_META, catCardHTML, categories: null };
})();