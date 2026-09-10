/* Marygold Collections — unsubscribe page behaviour (token in query string) */
(function () {
  "use strict";

  function $(id) { return document.getElementById(id); }

  function show(id) {
    ["state-checking", "state-confirm", "state-removed", "state-invalid"]
      .forEach(s => $(s).classList.toggle("hidden", s !== id));
  }

  function clean(u) {
    if (!u) return "";
    try { return decodeURIComponent(u).trim().toLowerCase(); } catch (_) { return u.trim().toLowerCase(); }
  }

  function unsub(token, button) {
    button.disabled = true;
    const label = button.textContent;
    button.textContent = "Unsubscribing…";
    fetch("/api/unsubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token })
    })
      .then(async r => {
        let data = null;
        try { data = await r.json(); } catch (_) { /* ignore */ }
        if (!r.ok) throw new Error((data && data.error) || "Something went wrong.");
        $("removed-email").textContent = clean(data.email);
        show("state-removed");
      })
      .catch(err => {
        button.disabled = false;
        button.textContent = label;
        $("confirm-err").textContent = err.message;
        $("confirm-err").classList.remove("hidden");
      });
  }

  document.addEventListener("DOMContentLoaded", () => {
    const token = (new URLSearchParams(location.search).get("token") || "").trim();
    if (!token) { show("state-invalid"); return; }
    show("state-checking");
    $("btnConfirm").addEventListener("click", () => unsub(token, $("btnConfirm")));
  });
})();