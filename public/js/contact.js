/* NovaCart — Contact page */
(function () {
  "use strict";
  const { store, helpers } = window.Nova;

  const form = document.getElementById("contactForm");
  if (!form) return;

  const msg = document.getElementById("contactMsg");
  const err = document.getElementById("contactError");

  form.addEventListener("submit", e => {
    e.preventDefault();
    err.classList.remove("show");
    const payload = {
      name: document.getElementById("cName").value.trim(),
      email: document.getElementById("cEmail").value.trim(),
      subject: document.getElementById("cSubject").value.trim(),
      message: document.getElementById("cMessage").value.trim()
    };
    if (payload.name.length < 2 || payload.message.length < 5) {
      err.textContent = "Please provide your name and a message.";
      err.classList.add("show");
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) {
      err.textContent = "Please provide a valid email address.";
      err.classList.add("show");
      return;
    }
    store.post("/api/contact", payload)
      .then(() => {
        msg.textContent = "Thanks! Your message has been sent — we'll reply shortly.";
        msg.className = "form-msg ok";
        form.reset();
      })
      .catch(error => {
        err.textContent = error.message;
        err.classList.add("show");
        msg.className = "form-msg";
      });
  });
})();