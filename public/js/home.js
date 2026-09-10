/* Marygold Collections — homepage behaviours */
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
        .then(data => {
          msg.textContent = data && data.already
            ? "You're already on the list — we'll be in touch soon."
            : "Thanks for subscribing! Watch your inbox for the next drop.";
          msg.className = "form-msg ok";
          form.querySelector("input").value = "";
        })
        .catch(err => {
          msg.textContent = err.message;
          msg.className = "form-msg err";
        });
    });
  }

  /* ---------------- Hero slideshow ---------------- */
  const HERO_SLIDES = [
    { eyebrow: "New season · 2026", title: "Discover your everyday style", sub: "Curated fashion, footwear, accessories and jewelry designed for every moment.", actions: [{ label: "Shop Now", href: "/shop", primary: true }, { label: "Explore Collection", href: "/shop" }] },
    { eyebrow: "Clothing", title: "Built for real life, styled for yours", sub: "Tailored basics and statement pieces that move with you from day to night.", actions: [{ label: "Shop Clothing", href: "/shop?category=Clothing", primary: true }, { label: "Explore Collection", href: "/shop" }] },
    { eyebrow: "Shoes", title: "Sneakers with the speed to pull away", sub: "From everyday classics to performance-ready pairs that keep pace with your ambition.", actions: [{ label: "Shop Shoes", href: "/shop?category=Shoes", primary: true }, { label: "Explore Collection", href: "/shop" }] },
    { eyebrow: "Accessories", title: "Time is the finest detail", sub: "Watches, belts and finishing touches that complete every outfit — and every moment.", actions: [{ label: "Shop Accessories", href: "/shop?category=Accessories", primary: true }, { label: "Explore Collection", href: "/shop" }] },
    { eyebrow: "Jewelry", title: "A push for what's next", sub: "Statement pieces with a polished finish, made to be noticed.", actions: [{ label: "Shop Jewelry", href: "/shop?category=Jewelry", primary: true }, { label: "Explore Collection", href: "/shop" }] }
  ];

  function initHeroSlideshow() {
    const hero = document.getElementById("hero");
    const slides = document.querySelectorAll(".hero-slide");
    if (!hero || slides.length < 2) return;

    const copyWrap = document.getElementById("heroCopy");
    const knob = document.getElementById("heroKnob");
    const dotsWrap = document.getElementById("heroDots");
    const prevBtn = document.getElementById("heroPrev");
    const nextBtn = document.getElementById("heroNext");
    if (!copyWrap || !knob || !dotsWrap || !prevBtn || !nextBtn) return;

    const INTERVAL = 6000;               /* 6s per slide */
    const HOLD = 9000;                   /* user interaction pause */
    const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const autoplay = reduced ? false : true;

    const fields = {
      eyebrow: copyWrap.querySelector('[data-hero-field="eyebrow"]'),
      title: copyWrap.querySelector('[data-hero-field="title"]'),
      sub: copyWrap.querySelector('[data-hero-field="sub"]'),
      actions: copyWrap.querySelector('[data-hero-field="actions"]')
    };
    const paintCopy = i => {
      const s = HERO_SLIDES[i];
      if (!s) return;
      copyWrap.classList.add("swap");
      setTimeout(() => {
        fields.eyebrow.textContent = s.eyebrow;
        fields.title.textContent = s.title;
        fields.sub.textContent = s.sub;
        fields.actions.innerHTML = s.actions.map(a =>
          `<a class="btn ${a.primary ? "btn-accent" : "btn-ghost"}" href="${helpers.esc(a.href)}">${helpers.esc(a.label)}</a>`
        ).join("");
        copyWrap.classList.remove("swap");
      }, 140);
    };

    const dots = HERO_SLIDES.map((s, i) => {
      const d = document.createElement("button");
      d.type = "button";
      d.className = "hero-dot" + (i === 0 ? " is-active" : "");
      d.setAttribute("role", "tab");
      d.setAttribute("aria-label", "Slide " + (i + 1));
      d.addEventListener("click", () => goTo(i, true));
      dotsWrap.appendChild(d);
      return d;
    });

    let current = 0;
    let autoTimer = null;
    let holdTimer = null;
    let paused = false;

    const stopTimer = t => { if (t) { clearTimeout(t); } return null; };

    function goTo(to, user) {
      const n = slides.length;
      to = ((to % n) + n) % n;
      current = to;
      slides.forEach((s, i) => s.classList.toggle("is-active", i === to));
      dots.forEach((d, i) => d.classList.toggle("is-active", i === to));
      knob.classList.remove("paused");
      knob.style.width = "";
      paintCopy(to);
      if (user) { pause(); holdToResume(); }
      else if (!paused) schedule();
    }

    function schedule() {
      if (!autoplay || paused) return;
      autoTimer = stopTimer(autoTimer);
      knob.classList.add("paused");
      autoTimer = setTimeout(() => goTo(current + 1, false), INTERVAL);
    }
    function pause() {
      paused = true;
      autoTimer = stopTimer(autoTimer);
      knob.classList.remove("paused");
      knob.style.width = "";
    }
    function resume() {
      paused = false;
      holdTimer = stopTimer(holdTimer);
      goTo(current, false);
    }
    function holdToResume() {
      holdTimer = stopTimer(holdTimer);
      holdTimer = setTimeout(resume, HOLD);
    }

    prevBtn.addEventListener("click", () => goTo(current - 1, true));
    nextBtn.addEventListener("click", () => goTo(current + 1, true));
    knob.addEventListener("pointerdown", () => { pause(); holdToResume(); });

    hero.addEventListener("mouseenter", () => { if (autoplay) pause(); });
    hero.addEventListener("mouseleave", () => { if (autoplay) resume(); });
    document.addEventListener("visibilitychange", () => { if (document.hidden) pause(); else if (autoplay) resume(); });

    paintCopy(0);
    if (autoplay) schedule();
  }

  function init() {
    initHeroSlideshow();
    loadFeatured();
    loadBestSellers();
    initNewsletter();
  }

  document.addEventListener("DOMContentLoaded", init);
})();