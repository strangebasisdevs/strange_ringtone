// The page's configuration arrives in escaped data-* attributes, because the
// CSP allows no inline script. Text is written with textContent only, so a
// value can never become markup.
const app = document.getElementById("app");

if (app !== null) {
  const seconds = Number.parseInt(app.dataset.maxClipSeconds ?? "", 10);
  const target = document.getElementById("max-clip-seconds");
  if (target !== null && Number.isInteger(seconds)) {
    target.textContent = String(seconds);
  }
}
