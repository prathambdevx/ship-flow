// Card flight between columns (same algorithm as the the host page board). Global: window.animateMoves(board, firstRects, prevCol).
(function () {
  window.animateMoves = function (k, first, prevCol) {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches || !k.animate) return;
    k.querySelectorAll(".card[data-id]").forEach(function (c) {
      var id = c.dataset.id, f = first[id]; if (!f) return;
      var to = c.getBoundingClientRect(), dx = f.left - to.left, dy = f.top - to.top, colEl = c.closest(".col");
      if (prevCol[id] && prevCol[id] !== colEl.dataset.c) {
        var el = c.cloneNode(true);
        el.classList.add("flyer"); el.classList.remove("on");
        Object.assign(el.style, { left: f.left + "px", top: f.top + "px", width: f.width + "px", height: f.height + "px" });
        document.body.appendChild(el); c.style.visibility = "hidden"; colEl.classList.add("receiving");
        var lift = -Math.min(60, Math.abs(dx) * 0.12 + 18);
        el.animate([
          { transform: "translate(0,0) scale(1) rotate(0deg)", height: f.height + "px" },
          { transform: "translate(" + (-dx * 0.5) + "px, " + (-dy * 0.5 + lift) + "px) scale(1.05) rotate(" + (dx > 0 ? -1.5 : 1.5) + "deg)", offset: 0.45 },
          { transform: "translate(" + (-dx) + "px, " + (-dy) + "px) scale(1) rotate(0deg)", height: to.height + "px" },
        ], { duration: 820, easing: "cubic-bezier(.3,.7,.2,1)" }).onfinish = function () {
          el.remove(); c.style.visibility = ""; c.classList.add("landed"); colEl.classList.remove("receiving");
        };
      } else if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
        c.animate([{ transform: "translate(" + dx + "px, " + dy + "px)" }, { transform: "none" }], { duration: 420, easing: "cubic-bezier(.2,.8,.2,1)" });
      }
    });
  };
})();
