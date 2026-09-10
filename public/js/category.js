/* NovaCart — Category page: banner, search and sort within a category */
(function () {
  "use strict";
  const { store, helpers, cardHTML, CATEGORY_META } = window.Nova;

  const match = location.pathname.match(/^\/category\/([^/]+)/) || [];
  const rawSlug = match[1] ? decodeURIComponent(match[1]) : "";

  const state = { slug: "", q: "", sort: "featured" };

  const els = {
    banner: () => document.getElementById("catBanner"),
    crumb: () => document.getElementById("catCrumb"),
    name: () => document.getElementById("catName"),
    desc: () => document.getElementById("catDesc"),
    meta: () => document.getElementById("catMeta"),
    count: () => document.getElementById("resultCount"),
    grid: () => document.getElementById("catGrid"),
    noResult: () => document.getElementById("catNoResult"),
    noResultMsg: () => document.getElementById("catNoResultMsg"),
    search: () => document.getElementById("catSearch"),
    searchClear: () => document.getElementById("catSearchClear"),
    sort: () => document.getElementById("catSort"),
    noResultClear: () => document.getElementById("catNoResultClear")
  };

  function buildUrl() {
    const p = new URLSearchParams();
    p.set("slug", state.slug);
    if (state.q) p.set("q", state.q);
    if (state.sort && state.sort !== "featured") p.set("sort", state.sort);
    const s = p.toString();
    history.replaceState(null, "", "/category/" + encodeURIComponent(state.slug) + (s ? "?" + s : ""));
    return "/api/products?" + s;
  }

  function load() {
    els.count().textContent = "…";
    store.get(buildUrl()).then(products => {
      els.count().textContent = products.length;
      els.grid().innerHTML = products.map(p => cardHTML(p)).join("");
      els.noResult().style.display = products.length ? "none" : "block";
      els.noResultMsg().textContent = state.q
        ? `We couldn't find any “${helpers.esc(state.q)}” products in this category. Try different keywords.`
        : "No products in this category yet. Check back soon.";
    }).catch(err => {
      els.count().textContent = "0";
      els.grid().innerHTML = "";
      els.noResult().style.display = "block";
      els.noResultMsg().textContent = err.message;
    });
  }

  function showMissing() {
    document.title = "Category not found — NovaCart";
    els.name().textContent = "Category not found";
    els.meta().textContent = "The category you’re looking for doesn’t exist. It may have been renamed or removed.";
    els.noResult().style.display = "block";
    els.noResultMsg().textContent = "This category could not be found on NovaCart.";
    document.getElementById("catSearchClear").style.display = "none";
    document.querySelector("#main .shop-bar").style.display = "none";
  }

  function init() {
    if (!rawSlug) { showMissing(); return; }

    store.get(`/api/categories?slug=${encodeURIComponent(rawSlug)}`).then(cats => {
      if (!cats || !cats.length) { showMissing(); return; }
      const c = cats[0];

      state.slug = c.slug;
      document.title = `${c.name} — NovaCart`;
      document.querySelector('meta[name="description"]').setAttribute("content",
        c.description || `Shop ${c.name} at NovaCart. Browse ${c.name} products online.`);
      els.crumb().textContent = c.name;
      els.name().textContent = c.name;
      if (c.description) els.desc().textContent = c.description;
      const meta = CATEGORY_META[c.name] || {};
      const img = c.image || meta.image;
      if (img) els.banner().style.backgroundImage = `url("${helpers.esc(img)}")`;
      if (c.product_count > 0) {
        els.meta().textContent = `${Number(c.product_count)} product${c.product_count === 1 ? "" : "s"} in this category`;
      }

      let debounce;
      els.search().addEventListener("input", e => {
        clearTimeout(debounce);
        debounce = setTimeout(() => { state.q = e.target.value.trim(); load(); }, 300);
      });
      els.searchClear().addEventListener("click", () => { state.q = ""; els.search().value = ""; load(); });
      els.sort().addEventListener("change", e => { state.sort = e.target.value; load(); });
      els.noResultClear().addEventListener("click", () => { state.q = ""; els.search().value = ""; load(); });

      load();
    }).catch(err => {
      showMissing();
      els.noResultMsg().textContent = err.message;
    });
  }

  document.addEventListener("DOMContentLoaded", init);
})();