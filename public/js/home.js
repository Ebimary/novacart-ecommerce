/* NovaCart — homepage behaviours */
(function () {
  "use strict";
  const { store, toast, helpers, cardHTML } = window.Nova;

  function loadFeatured() {
    const grid = document.getElementById("featuredGrid");
    if (!grid) return;
    store.get("/api/home")
      .then(data => {
        const products = (data.featured || []).length ? data.featured : [];
        grid.innerHTML = products.length
          ? products.map(p => cardHTML(p, { featuredLabel: true })).join("")
          : '<div class="no-result"><p>No featured products yet.</p></div>';
      })
      .catch(() => {
        grid.innerHTML = '<div class="no-result"><p>Could not load products. Please try again shortly.</p></div>';
      });
  }

  function loadBestSellers() {
    const grid = document.getElementById("bestsellerGrid");
    if (!grid) return;
    store.get("/api/home")
      .then(data => {
        const products = (data.bestsellers || []).filter(p => p.sold > 0);
        grid.innerHTML = products.length
          ? products.map(p => cardHTML(p)).join("")
          : '<div class="no-result"><p>Sales data coming soon — be the first to order!</p></div>';
      })
      .catch(() => {
        grid.innerHTML = '<div class="no-result"><p>Could not load products.</p></div>';
      });
  }

  function initNewsletter() {
    const form = document.getElementById("newsletterForm");
    if (!form) return;
    form.addEventListener("submit", e => {
      e.preventDefault();
      const email = document.getElementById("newsletterEmail").value.trim();
      const msg = document.getElementById("newsletterMsg");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        msg.textContent = "Please enter a valid email address.";
        msg.className = "form-msg err";
        return;
      }
      store.post("/api/newsletter", { email })
        .then(() => {
          msg.textContent = "Thanks for subscribing! Watch your inbox for the next drop.";
          msg.className = "form-msg ok";
          form.querySelector("input").value = "";
        })
        .catch(err => {
          msg.textContent = err.message;
          msg.className = "form-msg err";
        });
    });
  }

  function init() {
    loadFeatured();
    loadBestSellers();
    initNewsletter();
  }

  document.addEventListener("DOMContentLoaded", init);
})();