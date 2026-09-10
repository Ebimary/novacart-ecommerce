/* NovaCart Admin — login page */
(function () {
  "use strict";
  const form = document.getElementById("loginForm");
  const errorEl = document.getElementById("loginError");
  const btn = document.getElementById("loginBtn");

  form.addEventListener("submit", e => {
    e.preventDefault();
    errorEl.style.display = "none";
    const email = document.getElementById("loginEmail").value.trim();
    const password = document.getElementById("loginPassword").value;
    if (!email || !password) {
      showError("Enter your email and password.");
      return;
    }
    btn.disabled = true;
    btn.textContent = "Signing in…";
    fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    })
      .then(r => r.json().then(data => ({ ok: r.ok, data })))
      .then(({ ok, data }) => {
        if (!ok) { throw new Error(data.error || "Login failed."); }
        location.href = "/admin";
      })
      .catch(err => {
        btn.disabled = false;
        btn.textContent = "Login";
        showError(err.message);
      });
  });

  function showError(msg) {
    errorEl.textContent = msg;
    errorEl.style.display = "block";
  }
})();