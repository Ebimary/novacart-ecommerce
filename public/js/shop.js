/* NovaCart — Shop page: search, filter, sort */
(function () {
  "use strict";
  const { store, cart, toast, helpers, cardHTML } = window.Nova;

  const q = helpers.parseQuery();
  const state = {
    category: q.category && q.category !== "All" ? q.category : "All",
    q: q.q || "",
    sort: q.sort || "newest",
    min: q.min || "",
    max: q.max || ""
  };

  const els = {
    grid: () => document.getElementById("shopGrid"),
    count: () => document.getElementById("resultCount"),
    noResult: () => document.getElementById("noResult"),
    search: () => document.getElementById("shopSearch"),
    searchClear: () => document.getElementById("shopSearchClear"),
    sort: () => document.getElementById("sortSelect"),
    min: () => document.getElementById("minPrice"),
    max: () => document.getElementById("maxPrice"),
    apply: () => document.getElementById("applyFilters"),
    clear: () => document.getElementById("clearFilters"),
    noResultClear: () => document.getElementById("noResultClear"),
    chips: () => document.getElementById("activeChips"),
    filterPanel: () => document.getElementById("filterPanel"),
    mobileFilterBtn: () => document.getElementById("mobileFilterBtn"),
    cats: () => document.getElementById("filterCats")
  };

  function bind() {
    els.search().value = state.q;
    els.sort().value = state.sort;
    els.min().value = state.min;
    els.max().value = state.max;

    let debounce;
    els.search().addEventListener("input", e => {
      clearTimeout(debounce);
      debounce = setTimeout(() => { state.q = e.target.value.trim(); renderChips(); load(); }, 300);
    });
    els.searchClear().addEventListener("click", () => { state.q = ""; els.search().value = ""; renderChips(); load(); });

    els.sort().addEventListener("change", e => { state.sort = e.target.value; load(); });
    els.apply().addEventListener("click", applyPrice);
    els.clear().addEventListener("click", clearAll);
    els.noResultClear().addEventListener("click", clearAll);
    els.mobileFilterBtn().addEventListener("click", () => els.filterPanel().classList.toggle("open"));
    els.min().addEventListener("keydown", e => { if (e.key === "Enter") applyPrice(); });
    els.max().addEventListener("keydown", e => { if (e.key === "Enter") applyPrice(); });

    renderCats();
  }

  function renderCats() {
    store.get("/api/categories").then(cats => {
      const cur = state.category;
      const rows = cats.map(c => {
        const count = Number(c.product_count) || 0;
        return `<label class="${cur === c.name ? "active" : ""}">
          <input type="radio" name="cat" value="${helpers.esc(c.name)}" ${cur === c.name ? "checked" : ""}>
          <span>${helpers.esc(c.name)}</span><small>${count ? `(${count})` : ""}</small>
        </label>`;
      }).join("");
      els.cats().innerHTML = `<label class="${cur === "All" ? "active" : ""}">
          <input type="radio" name="cat" value="All" ${cur === "All" ? "checked" : ""}>
          <span>All</span><small></small>
        </label>` + rows;
      els.cats().addEventListener("change", onCatChange);
    }).catch(() => {
      els.cats().addEventListener("change", onCatChange);
    });
  }

  function onCatChange(e) {
    const v = e.target.value;
    if (!v) return;
    state.category = v;
    els.cats().querySelectorAll("label").forEach(l =>
      l.classList.toggle("active", l.querySelector("input").value === v)
    );
    renderChips();
    load();
  }

  function applyPrice() {
    state.min = els.min().value.trim();
    state.max = els.max().value.trim();
    renderChips();
    load();
    if (window.innerWidth < 1080) els.filterPanel().classList.remove("open");
  }

  function clearAll() {
    state.category = "All";
    state.q = "";
    state.sort = "newest";
    state.min = "";
    state.max = "";
    els.search().value = "";
    els.min().value = "";
    els.max().value = "";
    els.sort().value = "newest";
    els.cats().querySelectorAll("label").forEach(l => {
      const active = l.querySelector("input").value === "All";
      l.classList.toggle("active", active);
      l.querySelector("input").checked = active;
    });
    renderChips();
    load();
  }

  function renderChips() {
    const chips = [];
    if (state.q) chips.push({ key: "q", label: `"${state.q}"` });
    if (state.category !== "All") chips.push({ key: "cat", label: state.category });
    if (state.min) chips.push({ key: "min", label: `Min ₦${formatNum(state.min)}` });
    if (state.max) chips.push({ key: "max", label: `Max ₦${formatNum(state.max)}` });

    const wrap = els.chips();
    wrap.innerHTML = chips.map(c => `<span class="chip">${helpers.esc(c.label)} <button aria-label="Remove filter" data-chip="${c.key}">&times;</button></span>`).join("") +
      (chips.length ? '<button class="chip clear" data-chip="all">Clear filters</button>' : "");
    wrap.querySelectorAll("[data-chip]").forEach(btn => {
      btn.addEventListener("click", () => {
        const k = btn.dataset.chip;
        if (k === "all") { clearAll(); return; }
        if (k === "q") { state.q = ""; els.search().value = ""; }
        if (k === "cat") { state.category = "All"; recheckCats(); }
        if (k === "min") { state.min = ""; els.min().value = ""; }
        if (k === "max") { state.max = ""; els.max().value = ""; }
        renderChips();
        load();
      });
    });
  }

  function recheckCats() {
    els.cats().querySelectorAll("label").forEach(l => {
      const active = l.querySelector("input").value === state.category;
      l.classList.toggle("active", active);
      l.querySelector("input").checked = active;
    });
  }

  function formatNum(n) { return Number(n).toLocaleString("en-NG"); }

  function buildUrl() {
    const p = new URLSearchParams();
    if (state.q) p.set("q", state.q);
    if (state.category !== "All") p.set("category", state.category);
    if (state.sort !== "newest") p.set("sort", state.sort);
    if (state.min) p.set("min", state.min);
    if (state.max) p.set("max", state.max);
    const s = p.toString();
    history.replaceState(null, "", s ? "/shop?" + s : "/shop");
    return "/api/products?" + s;
  }

  function load() {
    els.count().textContent = "…";
    store.get(buildUrl())
      .then(products => {
        els.count().textContent = products.length;
        els.grid().innerHTML = products.map(p => cardHTML(p)).join("");
        els.noResult().style.display = products.length ? "none" : "block";
      })
      .catch(err => {
        els.count().textContent = "0";
        els.grid().innerHTML = "";
        els.noResult().style.display = "block";
        els.noResult().querySelector("p").textContent = err.message;
      });
  }

  document.addEventListener("DOMContentLoaded", () => {
    bind();
    load();
  });
})();