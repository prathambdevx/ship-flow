// Shared page helpers (accent colour, theme toggle with sound, in-app confirm). Classic script; exposes window.prflowKit.askDialog.
const $ = (s) => document.querySelector(s);
/* ---------- accent colour ---------- */
function setAccent(a, save = true) {
  document.documentElement.dataset.accent = a;
  document.querySelectorAll(".accent-pick button").forEach((b) => { b.classList.toggle("on", b.dataset.a === a); b.setAttribute("aria-checked", b.dataset.a === a); });
  if (save) try { localStorage.setItem("accent", a); } catch {}
  paintFavicon();
}
// The tab icon follows the accent: same drawing as /favicon.svg, recoloured from the live tokens.
function paintFavicon() {
  const css = getComputedStyle(document.documentElement);
  const acc = css.getPropertyValue("--gold").trim() || "#B27D14", ink = css.getPropertyValue("--on-accent").trim() || "#1a1405";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><mask id="n"><rect width="32" height="32" fill="#fff"/><circle cx="2.5" cy="16" r="3.2" fill="#000"/><circle cx="29.5" cy="16" r="3.2" fill="#000"/></mask></defs><rect x="2.5" y="7" width="27" height="18" rx="3.5" fill="${acc}" mask="url(#n)"/><path d="M21.5 9.5v13" stroke="${ink}" stroke-width="1.6" stroke-linecap="round" stroke-dasharray="1.6 2.2"/><path d="M8.2 16.2l2.9 2.9 5.4-6" fill="none" stroke="${ink}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const link = document.querySelector('link[rel="icon"]');
  if (link) link.href = "data:image/svg+xml," + encodeURIComponent(svg);
}
document.querySelectorAll(".accent-pick button").forEach((b) => b.onclick = () => setAccent(b.dataset.a));
setAccent(document.documentElement.dataset.accent || "teal", false);
window.addEventListener("storage", (e) => { if (e.key === "accent" && e.newValue) setAccent(e.newValue, false); });

/* ---------- in-app confirm / prompt (never the browser's native popups) ---------- */
// Resolves true (or the typed text when `input` is set) on confirm, false on cancel or Esc.
function askDialog({ title, body = "", yes = "OK", danger = false, input = null, ack = null }) {
  const dlg = $("#askDlg"), yesBtn = $("#askYes"), box = $("#askInput"), ackRow = $("#askAckRow"), ackBox = $("#askAck");
  $("#askTitle").textContent = title;
  $("#askBody").innerHTML = body;
  yesBtn.textContent = yes;
  yesBtn.className = danger ? "red-solid" : "gold";
  box.hidden = !input; box.value = ""; if (input) box.placeholder = input;
  ackRow.hidden = !ack; ackBox.checked = false; $("#askAckText").textContent = ack || "";
  const sync = () => { yesBtn.disabled = (ack && !ackBox.checked) || (input && !box.value.trim()); };
  ackBox.onchange = sync; box.oninput = sync; sync();
  return new Promise((resolve) => {
    const done = (v) => { dlg.close(); resolve(v); };
    yesBtn.onclick = () => done(input ? box.value.trim() : true);
    $("#askNo").onclick = () => done(false);
    dlg.oncancel = (e) => { e.preventDefault(); done(false); };
    dlg.showModal();
    (input ? box : $("#askNo")).focus();
  });
}

/* ---------- dark / light with sound (public/app.js themeToggle) ---------- */
const themeSound = new Audio("assets/theme-click.mp3");
themeSound.preload = "auto";
const currentTheme = () => document.documentElement.getAttribute("data-theme") || "light"; // light by default
function themeIcon() {
  const dark = currentTheme() === "dark", b = $("#themeToggleBtn");
  b.textContent = dark ? "☀️" : "🌙"; b.title = dark ? "Switch to light mode" : "Switch to dark mode";
}
$("#themeToggleBtn").onclick = () => {
  const next = currentTheme() === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try { localStorage.setItem("theme", next); } catch {}
  themeIcon(); paintFavicon();
  themeSound.currentTime = 0; themeSound.play().catch(() => {});
};
themeIcon();
window.prflowKit = { askDialog };
