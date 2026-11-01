// prflow Tasks page. Plain JS: polls GET {base}/state, renders, and sends the writes in DESIGN.md "HTTP".
(function () {
  // Names a host can set (window.prflowHost.names); the defaults fit any project.
  const NM = Object.assign({ release: "the release pipeline", git: "the git host", testUser: "the test user" }, (window.prflowHost && window.prflowHost.names) || {});
  "use strict";
  const meta = (n, d) => document.querySelector('meta[name="' + n + '"]')?.content || d;
  const BASE = meta("prflow-base", "/api/prflow").replace(/\/$/, "");
  const HOME = meta("prflow-home", "/");
  if (!window.prflowHost) document.querySelector(".modes")?.remove(); // no host board (ship ui): no Board switch
  const AI = meta("td-app-name", "Claude"); // the host names the AI it shows (a portable UI keeps Claude by default)
  const $ = (s) => document.querySelector(s);
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
  const plural = (n, w) => n + " " + w + (n === 1 ? "" : "s");
  const safeUrl = (u) => (/^https?:\/\//i.test(String(u || "")) ? esc(u) : "#");

  let S = null, lastText = "", offline = false, pauseSig = "";
  let sel = "all", open = null, openPid = null, dtab = "steps", restored = false, editing = null, EV = {}, evSig = {};
  const busy = new Set(), prevCol = {}, asked = new Set();
  const PALETTE = ["var(--gold)", "var(--blue)", "#9b6fd6", "#2a9d8f", "#e07360", "var(--ok)"];

  // IST 12-hour from epoch ms
  const tf = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "Asia/Kolkata" });
  const clock = (ms) => (ms ? tf.format(new Date(ms)).toUpperCase().replace(/ /g, " ") : "");
  const ist = (ms) => (ms ? clock(ms) + " IST" : "");
  // Live planning: "10:02:05" (IST, 12-hour, seconds; AM/PM only in the tooltip).
  const tfs = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true, timeZone: "Asia/Kolkata" });
  const clockS = (ms) => tfs.format(new Date(ms)).replace(/ ?[AP]M$/i, "");
  const PLAN_STEPS = { big: ["Read what you pasted", "Read the code and the data", "Decide the size", "Split into tasks and waves", "Check the split (files, waves, dependencies)", "architect-reviewer (Opus) checks the split"],
    small: ["Read what you pasted", "Read the code and the data", "Decide the size", "Check the plan"], list: ["Read the bug list", "Check each bug in the code and data", "Group bugs with the same cause", "Leave out bugs that are not real, with the reason", "Check the split (files, dependencies)"] };
  // An activity line is "Read: file", "Grep: pattern" or a short sentence: kind is the part before the first ": ", else the first word.
  function parseLine(line) {
    const l = String(line || ""), i = l.indexOf(": ");
    if (i > 0 && i <= 24 && !/\s/.test(l.slice(0, i))) return [l.slice(0, i), l.slice(i + 2)];
    const w = l.split(" ");
    return w.length <= 3 ? [w[0], w.slice(1).join(" ")] : ["Thinking", l];
  }
  const baseName = (w) => String(w).split("/").pop().trim();
  const lastAct = (a) => { const x = a?.length ? parseLine(a[a.length - 1].line) : null; return x ? (x[0] === "Thinking" ? "Thinking" : x[0] + (x[1] ? " " + baseName(x[1]) : "")) : ""; };
  function liveBox(acts, n, title) {
    const rows = (acts || []).slice(-n);
    return '<div class="pl-live' + (n < 5 ? " sm" : "") + '"><div class="pl-h">' + esc(title) + " <span>live</span></div>" + (rows.length ? rows.map((a, k) => {
      const [kind, what] = parseLine(a.line);
      return '<div class="pl-l ' + (k === rows.length - 1 ? "last" : "") + '"><span class="pl-t" title="' + esc(ist(a.at)) + '">' + esc(clockS(a.at)) + "</span><b>" + esc(kind) + '</b><span class="pl-w" title="' + esc(what) + '">' + esc(what) + "</span></div>";
    }).join("") : '<div class="pl-l"><span class="pl-t"></span><b></b><span class="pl-w">Waiting for the first action…</span></div>') + "</div>";
  }
  function planningRow(p, at) {
    const steps = PLAN_STEPS[p.kind] || PLAN_STEPS.big, k = Math.max(0, Math.min(p.planStep || 0, steps.length - 1));
    const list = '<div class="pl-steps">' + steps.map((name, i) => '<div class="pl-s ' + (i < k ? "done" : i === k ? "run" : "") + '"><i></i>' + esc(name) + (i === k ? ' <span class="pl-now">· now</span>' : "") + "</div>").join("") + "</div>";
    return ["run", "Planning · step " + (k + 1) + " of " + steps.length, "" + AI + " (Opus): " + steps[k].toLowerCase(), at, list + liveBox(p.activity, 5, "What " + AI + " is doing")];
  }

  // The staging test while it runs: its 3 steps, the scenarios it planned, and the tester's last actions.
  const UAT_STEPS = ["Write the test: scenarios, API calls and checks", "Run the calls on UAT", "Judge the result"];
  function uatLive(p) {
    const k = Math.max(0, Math.min(p.uatStep ?? 0, 2));
    const list = '<div class="pl-steps">' + UAT_STEPS.map((name, i) => '<div class="pl-s ' + (i < k ? "done" : i === k ? "run" : "") + '"><i></i>' + esc(name) + (i === k ? ' <span class="pl-now">· now</span>' : "") + "</div>").join("") + "</div>";
    const sc = p.uatScenarios?.length ? '<ul class="cf-res">' + p.uatScenarios.map((x) => "<li>○ " + esc(x.task) + " · " + esc(x.what) + "</li>").join("") + "</ul>" : "";
    return list + sc + (k === 1 ? "" : liveBox(p.activity, 5, "What " + AI + " is doing"));
  }

  // What the tasks leave to a person: parts no task covers, and database changes to run on staging and prod.
  // One plain line per plan whose files this plan shares: run it after that plan, or expect its master PR to be refreshed.
  function overlapLines(p) {
    const by = {};
    for (const o of p.overlaps || []) (by[o.plan] ??= []).push(...o.files.map((f) => o.repo + "/" + f));
    return Object.entries(by).map(([id, fs]) => "Shares " + plural(fs.length, "file") + " with " + id + " (" + fs.slice(0, 5).join(", ") + (fs.length > 5 ? ", ..." : "") + "): run it after " + id + ", or expect its master PR to be refreshed after " + id + " merges.");
  }
  function gapsHtml(p) {
    const u = p.uncovered || [], db = p.dbChanges || [], ov = overlapLines(p);
    if (!u.length && !db.length && !ov.length) return "";
    return '<div class="blk gaps">' + (ov.length ? "<h3>Overlaps with other plans</h3><ul>" + ov.map((x) => "<li>" + esc(x) + "</li>").join("") + "</ul>" : "") + (u.length ? "<h3>Not covered by any task</h3><ul>" + u.map((x) => "<li><b>" + esc(x.part) + "</b> · " + esc(x.why) + "</li>").join("") + "</ul>" : "") +
      (db.length ? "<h3>Database changes to run by hand (staging, then prod)</h3><ul>" + db.map((x) => "<li><b>" + esc(x.database) + "</b> · " + esc(x.why) + "<pre>" + esc(x.sql) + "</pre></li>").join("") + "</ul>" : "") + "</div>";
  }

  const COLS = [["wait", "Waiting", "Waits for its dependencies"], ["work", "Working", "Executor and reviewer subagents"], ["review", "Review & build", "Merging into the plan branch"], ["done", "Done", "Built and tested"], ["you", "Ready for you", "Merge the master PRs"]];
  const colOf = (t) => (t.status === "working" || t.status === "failed" ? "work" : t.status === "review" ? "review" : t.status === "done" ? "done" : "wait");
  const colorOf = (p) => PALETTE[(parseInt(String(p.id).replace(/\D/g, ""), 10) || 0) % PALETTE.length];
  const kindOf = (p) => p.kind || "small";
  const planById = (id) => S?.plans.find((p) => p.id === id);
  const tasksOf = (p) => p.tasks.map((id) => S.tasks[id]).filter((t) => t && t.status !== "removed");
  const taskByRef = (p, ref) => S.tasks[ref] || S.tasks[p.id + "/" + ref];
  const waveCount = (p) => Math.max(p.waves || 0, ...tasksOf(p).map((t) => t.wave || 1), 0);
  const pct = (p) => Math.round(S.progress?.plans?.[p.id] ?? 0);
  // A master merge runs (the user pressed Merge): it needs nothing from him until it ends.
  const merging = (p) => p.steps.master === "you" && (!!p.merging || p.release?.state === "running" || p.release?.state === "starting"); // merged PRs alone are not a merge in progress: a stopped run can be clicked again
  // From the release pipeline's log (ADR-0011): each PR's step in the release run.
  function mergeLine(p) {
    const prs = p.masterPrs.slice().sort((a, b) => a.order - b.order), m = prs.filter((r) => r.state === "merged").length;
    const at = (k) => prs.find((r) => r.run === k), cur = at("failed") || at("tag") || at("deploying") || at("merging");
    const what = !cur ? (p.release?.state === "running" ? "release run #" + p.release.run : "") : cur.run === "tag" ? "waiting for the " + cur.repo + " release" : cur.run === "failed" ? cur.repo + " failed" : (cur.run === "deploying" ? "deploying " : "merging ") + cur.repo;
    return [m + "/" + prs.length + " merged", what, cur?.run === "deploying" ? cur.id : undefined];
  }
  const wdOn = () => false; // no watchdog: plans run from a terminal session (/ship, ADR-0017)
  const forYouKind = (p) => (wdOn(p) ? "watchdog" : p.error ? "error" : p.steps.plan === "you" ? "start" : p.steps.master === "you" || p.steps.master === "done" ? "master" : null);
  const openMaster = (p) => p.masterPrs.filter((r) => r.state === "open").length || p.masterPrs.length;
  const visiblePlans = () => S.plans.filter((p) => sel === "all" || sel === p.id);
  const ptag = (p) => '<span class="ptag" style="--pc:' + colorOf(p) + '">' + esc(p.id) + "</span>";
  const btn = (label, cls, a, attrs) => '<button class="' + cls + '" data-a="' + a + '" ' + (attrs || "") + ">" + label + "</button>";

  // ---------- network ----------
  async function refresh() {
    try {
      const r = await fetch(BASE + "/state", { cache: "no-store" });
      if (!r.ok) throw new Error(String(r.status));
      const text = await r.text();
      const was = offline; offline = false;
      if (text !== lastText) { lastText = text; S = JSON.parse(text); render(); } else if (was) render();
      if (!restored) { restored = true; restoreHash(); }
    } catch (e) { if (!offline) { offline = true; if (S) render(); else showFirstError(); } }
    await pollEvents(); await pollBanner(); await pollWatchdog();
  }
  // The host's watchdog table (GET {base}/watchdog), every 10 s: the sidebar button, the pill, and the open table.
  let WD = [], wdAt = 0;
  async function pollWatchdog(force) {
    return; // the watchdog is gone from the page (ADR-0017)
    if (!force && Date.now() - wdAt < 10_000) return;
    wdAt = Date.now();
    try { const r = await fetch(BASE + "/watchdog", { cache: "no-store" }); if (!r.ok) return; WD = await r.json(); } catch (e) { return; }
    renderWdBtn(); if ($("#wdDlg").open) $("#wdBody").innerHTML = wdTable(WD);
  }
  // events of the open drawer's plan only; redraws the drawer when they change
  async function pollEvents() {
    const pid = !open ? null : open === "plan" ? openPid : S?.tasks[open]?.planId; if (!pid) return;
    try {
      const r = await fetch(BASE + "/plans/" + pid + "/events", { cache: "no-store" }); if (!r.ok) return;
      const text = await r.text(); if (evSig[pid] === text && EV[pid]) return;
      evSig[pid] = text; EV = { [pid]: JSON.parse(text) };
      if (open && S) renderDetail();
    } catch (e) { /* next poll retries */ }
  }
  function showFirstError() {
    $("#kanban").innerHTML = '<div class="blank"><h2>Cannot reach the server</h2><p>Trying again every 2 seconds.</p></div>';
  }
  async function post(path, body) {
    if (busy.has(path)) return null;
    busy.add(path); applyBusy();
    try {
      const r = await fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json", "X-TD-Token": meta("td-token", "") }, body: JSON.stringify(body || {}) });
      const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch (e) { /* not JSON */ }
      if (!r.ok || !j || j.ok === false) return { error: j?.error || "The request failed (" + r.status + ")." };
      refresh(); return j;
    } catch (e) { return { error: "Cannot reach the server." }; } finally { busy.delete(path); applyBusy(); }
  }
  async function act(path, body) { const j = await post(path, body); if (j?.error) toast(j.error); return j && !j.error ? j : null; }
  function applyBusy() { document.querySelectorAll("[data-key]").forEach((b) => { b.disabled = busy.has(b.dataset.key); }); }
  let toastTimer = 0;
  function toast(msg) {
    const el = $("#toast"); el.textContent = msg; el.classList.add("show");
    try { el.hidePopover?.(); el.showPopover?.(); } catch (e) { /* no popover support */ }
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.classList.remove("show"); try { el.hidePopover?.(); } catch (e) { /* ignore */ } }, 6000);
  }

  // ---------- usage banner ----------
  async function pollBanner() {
    let p = null;
    try { p = (await window.prflowHost?.claudePause?.()) || null; } catch (e) { p = null; }
    const sig = JSON.stringify(p); if (sig === pauseSig) return; pauseSig = sig;
    const el = $("#claudeBanner"), on = !!p && typeof p === "object";
    document.body.classList.toggle("has-banner", on); el.hidden = !on; el.className = on ? "claude-banner " + (p.kind === "auth" ? "auth" : "limit") : "";
    if (!on) { el.innerHTML = ""; return; }
    const until = p.until ? " until <b>" + esc(ist(p.until)) + "</b>" : "", n = p.waiting || 0;
    el.innerHTML = p.kind === "auth"
      ? "<span>⏸ <b>" + AI + " is signed out.</b> Steps wait until you sign in again.</span>"
      : "<span>⏸ <b>" + (n ? plural(n, "step") + " paused:" : "Steps paused:") + "</b> " + AI + " is out of usage" + until + ". They continue on their own then.</span>" + (window.prflowHost?.resume ? '<button id="claudeResume">Resume now</button>' : "");
    const rb = $("#claudeResume");
    if (rb) rb.onclick = async () => { rb.disabled = true; rb.textContent = "Resuming…"; try { await window.prflowHost.resume(); } catch (e) { toast("Could not resume."); } pauseSig = ""; pollBanner(); };
  }

  // ---------- watchdog (a host feature: plan.watchdog and GET {base}/watchdog; both may be missing) ----------
  const DOG = '<svg class="wd-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 4 6v6c0 4.4 3.4 8.3 8 9 4.6-.7 8-4.6 8-9V6l-8-3Z"/><path d="m9 12 2 2 4-4"/></svg>';
  const istDay = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(ms);
  const isToday = (ms) => !!ms && istDay(ms) === istDay(Date.now());
  function wdLine(w) {
    return ""; // no watchdog on the page (ADR-0017)
    if (w.state === "working") return '<span class="wdpill work" title="' + esc(w.why) + '">' + DOG + "Watchdog · run " + w.runs + (w.maxRuns ? " of " + w.maxRuns : "") + "</span>";
    if (w.state === "fixed") return '<span class="wdpill">' + DOG + "Fixed · waiting to restart</span>";
    if (w.state === "needs") return '<span class="wdpill cap" title="' + esc(w.needs) + '">' + DOG + "Watchdog: " + (w.maxRuns && w.runs >= w.maxRuns ? w.runs + " of " + w.maxRuns + " runs used" : "needs you") + "</span>";
    const bits = [isToday(w.lastFixAt) && w.fixes ? "Watchdog fixed " + plural(w.fixes, "stop") + " · " + clock(w.lastFixAt) : "", w.kept && isToday(w.kept.at) ? "Watchdog: kept mergeable after " + w.kept.after + " merged · " + clock(w.kept.at) : ""].filter(Boolean);
    return bits.length ? '<span class="wdpill">' + DOG + esc(bits.join(" · ")) + "</span>" : "";
  }
  function wdBox(w, key) {
    return ""; // no watchdog on the page (ADR-0017)
    if (!w || (!w.steps?.length && !w.needs) || (w.state === "done" && (w.dismissedAt || !w.lastFixAt)) || (w.state === "needs" && w.dismissedAt)) return "";
    const done = w.state === "done", cls = done || w.state === "fixed" ? "ok" : w.state === "needs" ? "cap" : "";
    const title = done ? "Watchdog fixed it" : w.state === "fixed" ? "Watchdog fixed it · waiting to restart" : w.state === "needs" ? "Watchdog handed it to you" : "Watchdog";
    const row = WD.find((r) => r.key === key && r.bug), bug = w.bug || row?.bug, fix = w.fix || (row?.fix !== "—" ? row?.fix : ""); // short lines; older runs only have them in the table
    const lead = w.state === "needs" ? "<b>Needs you:</b> " + esc(w.needs) : w.cause ? '<span class="wd1" title="' + esc(w.cause) + '"><b>Cause:</b> ' + esc(bug || w.cause) + "</span>" + (w.summary ? '<span class="wd1" title="' + esc(w.summary) + '"><b>Fix:</b> ' + esc(fix || w.summary) + "</span>" : "") : esc(w.doing || "The watchdog (Opus, outside the sandbox) is reading the plan's events and the code to find out why.");
    const span = w.startedAt ? clock(w.startedAt) : "";
    const steps = (w.steps || []).filter((x, i) => !(i === 0 && x.text === w.why)).map((x) => (x.text === "Continue" ? { ...x, text: "Continue the plan" } : x));
    return '<div class="wdbox ' + cls + '"><h3>' + DOG + title + '<span class="when">' + esc(span) + "</span>" + (done ? '<button class="x" data-a="wd-dismiss" data-id="' + esc(key) + '" title="Hide (the Watchdog table keeps it)">✕</button>' : "") + '</h3><p class="lead">' + lead + "</p>" +
      (steps.length && !done ? "<ul>" + steps.map((x) => '<li class="' + esc(x.state) + '"><span class="d"></span><span>' + esc(x.text) + '</span><span class="t">' + (x.at ? esc(clock(x.at)) : "") + "</span></li>").join("") + "</ul>" : "") +
      (w.files?.length ? '<div class="files">' + w.files.map((f) => "<div><span>" + esc(f.change) + "</span> " + esc(f.path) + "</div>").join("") + "</div>" : "") +
      '<div class="guard">Can\'t push to master or main, merge, or write to the prod database or prod branches. Run ' + w.runs + (w.maxRuns ? " of " + w.maxRuns : "") + " today" + (done ? " · still watching this plan until its master PRs are merged" : "") + ".</div></div>";
  }
  // The central findings list: every finding of every review, with its status (GET {base}/findings).
  let FD = [], fdView = { status: "open", plan: "all" };
  const FD_ORDER = ["harmful", "minor", "trivial", "open", "not fixed", "being fixed", "partly fixed", "sent to planner", "sent", "accepted", "fixed"];
  async function loadFindings() { $("#fdBody").innerHTML = '<p class="legend">Loading…</p>'; try { FD = await (await fetch(BASE + "/findings")).json(); } catch (e) { FD = []; } renderFindings(); }
  function renderFindings() {
    const inPlan = FD.filter((r) => fdView.plan === "all" || r.plan === fdView.plan);
    const count = (s) => inPlan.filter((r) => s === "all" || r.status === s).length;
    const shown = inPlan.filter((r) => fdView.status === "all" || r.status === fdView.status).sort((a, b) => FD_ORDER.indexOf(a.status) - FD_ORDER.indexOf(b.status) || (a.plan < b.plan ? 1 : -1) || b.at - a.at);
    const plans = [...new Set([...FD.map((r) => r.plan), ...(fdView.plan !== "all" ? [fdView.plan] : [])])]; // the plan you came from, even with no findings yet
    const bar = '<div class="fd-bar">' + ["all", ...FD_ORDER].filter((s) => s === "all" || count(s)).map((s) => btn((s === "all" ? "All" : s[0].toUpperCase() + s.slice(1)) + " · " + count(s), "sm" + (fdView.status === s ? " on" : ""), "fd-filter", 'data-k="status" data-v="' + esc(s) + '"')).join("") +
      '<span class="grow2"></span><select onchange="this.dispatchEvent(new CustomEvent(\'fdplan\',{bubbles:true,detail:this.value}))"><option value="all">All plans</option>' + plans.map((p) => '<option value="' + esc(p) + '"' + (fdView.plan === p ? " selected" : "") + ">" + esc(p) + "</option>").join("") + "</select></div>";
    const rows = shown.slice(0, 600).map((r) => '<tr><td><span class="fd-s ' + esc(r.status.replace(/ /g, "-")) + '">' + esc(r.status === "fixed" ? "Fixed" : r.status) + '</span></td><td class="d">' + esc(r.plan) + " · " + esc(r.label) + " r" + r.round + '</td><td class="d">' + esc(r.severity) + " · " + esc(r.category) + "</td><td>" + esc(r.short) + (r.note ? '<div class="note">' + esc(r.status === "fixed" && r.severity === "blocking" ? "Fixed: " : "") + esc(r.note) + "</div>" : "") + (r.file ? '<div class="note"><code>' + esc(r.file.split("/").pop() + (r.line ? ":" + r.line : "")) + "</code></div>" : "") + "</td></tr>").join("");
    $("#fdBody").innerHTML = bar + (shown.length ? '<table class="fd-t"><thead><tr><th>Status</th><th>Where</th><th>Kind</th><th>Finding</th></tr></thead><tbody>' + rows + "</tbody></table>" + (shown.length > 600 ? '<p class="legend">Showing the first 600 of ' + shown.length + ". Pick a plan or a status to narrow it.</p>" : "") : '<p class="legend">Nothing here.</p>');
  }
  document.addEventListener("fdplan", (e) => { fdView.plan = e.detail; renderFindings(); });

  function wdTable(rows) {
    if (!rows.length) return '<p class="legend">The watchdog has not stepped in yet.</p>';
    const cls = { Fixed: "ok", Fixing: "run", "Needs you": "bad" };
    const when = (ms) => (isToday(ms) ? clock(ms) : new Date(ms).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" }) + " " + clock(ms));
    return '<table class="wdt"><thead><tr><th>When</th><th>Plan / ticket</th><th>Stuck at</th><th>Bug</th><th>Fix</th><th>Changed</th><th>Then</th><th>Status</th></tr></thead><tbody>' + rows.map((r) => '<tr><td class="w">' + esc(when(r.at)) + '</td><td class="id">' + esc(r.name) + "</td><td>" + esc(r.stuckAt) + "</td><td>" + esc(r.bug) + "</td><td>" + esc(r.fix) + "</td><td><code>" + esc(r.files || "—") + "</code></td><td>" + esc(r.then) + '</td><td class="' + (cls[r.status] || "") + '">' + esc(r.status) + "</td></tr>").join("") + "</tbody></table>";
  }
  // The global pill: fixing (a plan or a code fix), someone needs you, or how many plans it watches.
  function wdPill(all) {
    return ""; // no watchdog on the page (ADR-0017)
    const act = all.find((p) => p.watchdog?.state === "working"), fixRow = WD.find((r) => r.kind === "fix" && r.status === "Fixing");
    if (act || fixRow) return '<span class="wdpill work" title="The watchdog is fixing a stopped plan or code fix">' + DOG + "Watchdog: fixing " + esc(act ? act.id : fixRow.name) + "</span>";
    const need = all.find((p) => p.watchdog?.state === "needs" && p.error);
    if (need) return '<span class="wdpill cap" title="' + esc(need.watchdog.needs) + '">' + DOG + esc(need.id) + " needs you</span>";
    const n = all.filter((p) => p.started && p.steps.master !== "done").length, kept = all.reduce((a, p) => a + (p.watchdog && isToday(p.watchdog.kept?.at) ? p.watchdog.keptCount || 0 : 0), 0);
    return n ? '<span class="wdpill" title="Watches every started plan and ticket code fix until its master PRs are merged">' + DOG + "Watchdog: watching " + plural(n, "plan") + (kept ? " · kept " + kept + " mergeable" : "") + "</span>" : "";
  }
  function renderWdBtn() {
    const b = $("#wdBtn"); if (!b) return;
    const names = (st) => [...new Set(WD.filter((r) => r.status === st).map((r) => r.name))].join(", "); // amber fixing, red stuck, else green
    const [cls, text] = names("Fixing") ? ["work", "Watchdog: fixing " + names("Fixing")] : names("Needs you") ? ["bad", "Watchdog: " + names("Needs you") + " stuck"] : ["", "Watchdog: all clear"];
    b.className = "wdbtn" + (cls ? " " + cls : "");
    b.innerHTML = DOG + esc(text);
  }

  // ---------- derived views ----------
  function where(p) {
    const s = p.steps, ks = tasksOf(p);
    if (p.error) return ["bad", "Needs attention"];
    if (p.stopRequested) return ["", "Stopping"];
    if (s.master === "done") return ["ok", p.liveVia ? "Already live through " + p.liveVia : "Live on prod"];
    if (s.master === "you") return ["you", "Waiting for your merge · " + plural(p.masterPrs.length, "master PR")];
    if (p.landedAt) return ["ok", "Merged into " + p.targetBranch];
    if (s.plan === "you") return ["you", p.kind === "promote" ? "Promotion · press Start" : "Planned · press Start"];
    if (s.plan === "run" || (!p.kind && !p.started)) { const la = lastAct(p.activity); return ["", ((p.versions?.length || 0) > 1 ? "Planning again" : "Planning") + (la ? " · " + la : "")]; }
    // Past the UAT test (or a port plan, which skips it): the master PRs are being made; say which repo.
    if (p.stagingOnly && s.uat === "done") return ["ok", "Done on staging · staging only, no master PRs"];
    if (s.uat === "done" && s.master !== "you") return ["", "Master PRs: " + p.masterPrs.length + " of " + ((p.repos || []).filter((r) => r.stagingCommits?.length).length || p.masterPrs.length)];
    if (s.uat === "fail") return ["bad", "UAT check failed · sent back"];
    if (s.uat) { const la = s.uat === "run" ? lastAct(p.activity) : ""; return ["", "Testing on UAT" + (la ? " · " + la : "")]; }
    if (s.staging) return ["", p.now || "Merging to staging"];
    if (ks.some((t) => t.status === "failed")) return ["bad", "A task needs attention"];
    if (kindOf(p) === "small") return ["", "Fixing · one task"];
    if (kindOf(p) === "list") return ["", "Fixing · " + plural(ks.length, "task") + " in parallel"];
    const w = Math.min(...ks.filter((t) => t.status !== "done").map((t) => t.wave || 1), 99);
    if (p.gating) return ["", "Wave " + p.gating.wave + " gate · checking " + p.gating.i + "/" + p.gating.n];
    return ["", w === 99 ? "Wave gate" : "Wave " + w + " of " + waveCount(p)];
  }
  function sizeTag(p) {
    const ks = tasksOf(p);
    if (p.kind === "promote") return '<span class="size big">Promote · ' + esc(p.promotes) + " · " + plural(p.repos.length, "repo") + "</span>";
    if (p.kind === "port") return '<span class="size big">Port · ' + plural(p.repos.reduce((a, r) => a + r.stagingCommits.length, 0), "commit") + " · " + plural(p.repos.length, "repo") + "</span>";
    if (p.steps.plan === "run" || !ks.length || !p.kind) return '<span class="size">Planning…</span>';
    if (p.kind === "list") return '<span class="size big">' + (p.triage?.length || 0) + " bugs → " + plural(ks.length, "task") + "</span>";
    return p.kind === "big" ? '<span class="size big">Big · ' + plural(ks.length, "task") + " · " + plural(waveCount(p), "wave") + "</span>" : '<span class="size small">Small · 1 task</span>';
  }
  function trackOf(p) {
    const ks = tasksOf(p), n = ks.length, s = p.steps, k = kindOf(p), out = [];
    if (k === "port") return [["Port", "done", "Already on staging"], ["Master PRs", s.master, s.master === "done" ? p.masterPrs.filter((r) => r.state === "merged").length + "/" + p.masterPrs.length + " merged" : "You merge"]];
    if (k === "promote") out.push(["Promote", s.plan === "you" ? "you" : "done", p.promotes + " → staging" + (s.plan === "you" ? " · you press Start" : "")]);
    else out.push(["Plan", s.plan, s.plan === "run" ? "" + AI + " is planning" : s.plan === "you" ? plural(n, "task") + " · you press Start" : plural(n, "task")]);
    const failed = ks.some((t) => t.status === "failed"), allDone = n > 0 && ks.every((t) => t.status === "done");
    if (k === "big") {
      for (let w = 1; w <= waveCount(p); w++) {
        const ids = ks.filter((t) => t.wave === w), done = !!p.gates[w];
        const st = done ? "done" : ids.some((t) => t.status === "failed") ? "fail" : p.started && (w === 1 || p.gates[w - 1]) ? "run" : "";
        const gi = p.gating?.wave === w ? p.gating : null;
        out.push(["Wave " + w, st, gi ? (S.config?.buildEachTask === false ? "Tests are running: " : "Gate: building ") + gi.repo + " (" + gi.i + " of " + gi.n + ")" : ids.map((t) => t.label).join(", ") + (ids.length > 1 ? " in parallel" : "")]);
      }
    } else if (k !== "promote") {
      out.push(["Fix", allDone ? "done" : failed ? "fail" : p.started ? "run" : "", k === "list" && n > 1 ? plural(n, "task") + " in parallel" : "One task"]);
    }
    const repos = Math.max(p.repos.length, 1);
    if (p.targetBranch) { // a target plan ends at its merge: no staging deploy, UAT test or master PR
      out.push(["Merge into " + p.targetBranch, s.staging, plural(repos, "repo") + (repos > 1 ? ", in order" : "")]);
      out.push(["Staging, UAT, master", p.landedAt ? "done" : "", "Targets " + p.targetBranch + ", not staging"]);
      return out;
    }
    out.push(["Merge to staging", s.staging, plural(repos, "repo") + (repos > 1 ? ", in order" : "")]);
    out.push(["Test on UAT", s.uat, p.uat && p.uat.tries > 1 ? "Try " + p.uat.tries : k === "list" ? "One check per bug" : k === "small" ? "Repeat the bug's steps" : "Real API calls"]);
    const merged = p.masterPrs.filter((r) => r.state === "merged").length;
    if (!p.stagingOnly) out.push([k === "small" ? "Master PR" : "Master PRs", s.master, s.master === "done" ? merged + "/" + p.masterPrs.length + " merged" : "You merge"]); // staging only: the strip ends at the UAT test
    return out;
  }

  // ---------- render ----------
  function render() {
    if (!S) return;
    if (sel !== "all" && !planById(sel)) sel = "all";
    if (open && open !== "plan" && !S.tasks[open]) closeDetail(true);
    const vis = visiblePlans(), keys = vis.flatMap((p) => tasksOf(p).map((t) => t.id));
    const counts = Object.fromEntries(COLS.map(([k]) => [k, 0]));
    keys.forEach((id) => counts[colOf(S.tasks[id])]++);
    counts.you = vis.filter(forYouKind).length;
    const hot = vis.some((p) => ["start", "error"].includes(forYouKind(p)) || (p.steps.master === "you" && !merging(p)));
    $("#nav").innerHTML = COLS.map(([k, n]) => '<button data-a="nav" data-id="' + k + '"><span class="sw" style="background:' + (k === "done" ? "var(--ok)" : k === "you" ? "var(--gold)" : k === "wait" ? "var(--faint)" : "var(--blue)") + '"></span>' + n + '<span class="n' + (k === "you" && hot ? " hot" : "") + '">' + counts[k] + "</span></button>").join("");
    const kb = $("#kanban");
    if (!S.plans.length) {
      ["#planbar", "#gprog", "#plans"].forEach((s) => { $(s).style.display = "none"; });
      kb.style.display = "block";
      kb.innerHTML = '<div class="blank"><h2>Nothing to do yet</h2><p>Plan the change with Claude Code in a terminal, then run /ship there; it shows up here. Earlier: ' + AI + ' decides the size first: a bug runs as one task; a big plan is split into tasks that run in parallel where they can. You can paste more while others run.</p>' + btn("Paste a plan or bug", "gold", "paste") + "</div>";
      return;
    }
    ["#gprog", "#plans", "#kanban"].forEach((s) => { $(s).style.display = ""; });
    const all = S.plans, g = $("#gprog"), shown = planById(sel) ? [planById(sel)] : all; // a picked plan: its own progress
    g.className = "gprog " + (shown.every((p) => p.steps.master === "done" || (p.stagingOnly && p.steps.uat === "done")) ? "ok" : shown.some((p) => p.tone === "bad" || p.error) ? "bad" : "");
    g.innerHTML = progHtml(all, planById(sel));
    const cur0 = planById(sel), list = plistHtml(all);
    $("#plans").className = "views slim";
    $("#plans").innerHTML = // narrow screens only: the sidebar list as a dropdown
      '<button class="pick-dd" data-a="plist-dd" aria-expanded="' + ddOpen + '">Showing ' + esc(cur0 ? cur0.id : "All work") + " ▾</button>" + (ddOpen ? '<div class="plist pop">' + list + "</div>" : "");
    $("#plist").innerHTML = list;
    const pb = $("#planbar"), cur = planById(sel);
    if (!cur) pb.style.display = "none";
    else { // redraw only on a change, and keep the waves row where you scrolled it
      pb.style.display = "";
      const html = planbarHtml(cur);
      if (html !== pb.dataset.html || cur.id !== pb.dataset.pid) {
        const sx = cur.id === pb.dataset.pid ? pb.querySelector(".waves")?.scrollLeft ?? 0 : 0;
        pb.innerHTML = html; pb.dataset.html = html; pb.dataset.pid = cur.id;
        const wv = pb.querySelector(".waves"); if (wv && sx) wv.scrollLeft = sx;
      }
    }
    const first = {};
    kb.querySelectorAll(".card[data-id]").forEach((c) => { first[c.dataset.id] = c.getBoundingClientRect(); });
    kb.innerHTML = COLS.map(([key, name, hint]) => {
      if (S.config?.buildEachTask === false) { if (key === "review") name = "Review"; if (key === "done") hint = "Reviewed · tests run at the last gate"; } // no build per task
      const cards = key === "you" ? vis.filter(forYouKind).map(planCard).join("") : keys.filter((id) => colOf(S.tasks[id]) === key).map(cardHtml).join("");
      return '<div class="col" data-c="' + key + '"><div class="col-head"><span class="col-name">' + name + '<span class="n">' + counts[key] + "</span></span><small title=\"" + esc(hint) + "\">" + hint + '</small></div><div class="col-body">' + (cards || '<div class="empty">Nothing here</div>') + "</div></div>";
    }).join("");
    window.animateMoves?.(kb, first, prevCol);
    kb.querySelectorAll(".card[data-id]").forEach((c) => { prevCol[c.dataset.id] = c.closest(".col").dataset.c; });
    if (open) renderDetail(); applyBusy();
  }
  function progHtml(all, cur) {
    const w = (p) => tasksOf(p).length || 1, total = all.reduce((a, p) => a + w(p), 0);
    const one = cur ? [cur] : all, v = cur ? pct(cur) : Math.round(S.progress?.all ?? (all.reduce((a, p) => a + pct(p) * w(p), 0) / total));
    const ks = one.flatMap(tasksOf), done = ks.filter((t) => t.status === "done").length;
    const you = one.filter((p) => (forYouKind(p) && forYouKind(p) !== "master" || p.steps.master === "you") && !merging(p) && !wdOn(p)).length, label = cur ? cur.id : "All work";
    return '<span class="pct">' + v + '%</span><div class="gbar" role="progressbar" aria-label="' + esc(label) + '" aria-valuenow="' + v + '" aria-valuemin="0" aria-valuemax="100"><span style="width:' + v + '%"></span></div><span class="gtxt"><b>' + esc(label) + "</b> · " + (cur ? "" : all.length + " pasted · ") + (you ? '<b class="you-n">' + (cur ? "waiting for you" : you + " waiting for you") + "</b> · " : "") + done + "/" + ks.length + " tasks done" + (offline ? ' · <span class="off">offline, retrying</span>' : "") + " " + wdPill(all) + "</span>";
  }
  const isBusy = (p) => tasksOf(p).some((t) => t.status === "working" || t.status === "review") || Object.values(p.steps).includes("run");
  // The plans list in the sidebar (and the dropdown on narrow screens): grouped by what it needs, no per-plan colours.
  let ddOpen = false, liveOpen = false;
  try { liveOpen = localStorage.getItem("prflow.liveOpen") === "1"; } catch (e) { /* no storage */ }
  function plistHtml(all) {
    const st = (p) => {
      const w = p.watchdog;
      if (wdOn(p)) return ["need", "dog", w.state === "fixed" ? "Watchdog: restarting" : "Watchdog fixing"];
      if (p.error) return p.askYou ? ["need", "you", "Needs you"] : ["need", "bad", w?.state === "needs" ? "Needs you" : "Stopped"];
      if (p.steps.master === "done") return ["live", "ok", p.liveVia ? "Live through " + p.liveVia : "Live on prod"];
      if (p.stagingOnly && p.steps.uat === "done") return ["live", "ok", "Done on staging"]; // staging only: no master PRs
      if (merging(p) && p.release?.waitTag) return ["need", "you", "Release " + p.release.waitTag.repo + " in " + NM.git + ""]; // the run waits for the user's click
      if (merging(p)) { const [m, d] = mergeLine(p); return ["dep", "dep", (d.startsWith("deploying") ? "Deploying: " : "Merging: ") + m.replace(" merged", "")]; } // short enough for the sidebar
      if (p.landedAt) return ["live", "ok", "Merged into " + p.targetBranch];
      if (p.steps.master === "you") return ["need", "you", "Merge: " + plural(p.masterPrs.filter((r) => r.state === "open").length || p.masterPrs.length, "PR")];
      if (p.steps.plan === "you") return ["need", "you", p.kind === "promote" ? "Promotion · press Start" : "Planned · press Start"];
      return ["run", "run", where(p)[1]];
    };
    const rows = [...all].sort((a, b) => b.order - a.order).map((p) => [p, ...st(p)]), grp = (g) => rows.filter((r) => r[1] === g); // newest plan first
    const row = ([p, , dot, txt]) => '<button class="pr ' + (sel === p.id ? "on" : "") + '" data-a="pick" data-id="' + esc(p.id) + '" title="' + esc(p.title) + '"><span class="d k-' + dot + '"></span><span class="id">' + esc(p.id) + '</span><span class="tt">' + esc(p.title) + '</span><span class="sub ' + (dot === "ok" || dot === "run" || dot === "dep" ? "" : "k-" + dot) + '">' + esc(txt) + "</span></button>";
    const need = grp("need"), dep = grp("dep"), run = grp("run"), live = grp("live");
    return '<button class="pr all ' + (sel === "all" ? "on" : "") + '" data-a="pick" data-id="all"><span class="d"></span><span class="tt"><b>All work</b></span><span class="n">' + all.length + "</span></button>" +
      (need.length ? '<div class="gh">Needs you <span class="c">' + need.length + "</span></div>" + need.map(row).join("") : "") +
      (dep.length ? '<div class="gh">Merging / deploying <span class="c">' + dep.length + "</span></div>" + dep.map(row).join("") : "") +
      (run.length ? '<div class="gh">Running <span class="c">' + run.length + "</span></div>" + run.map(row).join("") : "") +
      (live.length ? '<button class="gh fold" data-a="plist-fold" aria-expanded="' + liveOpen + '">Live <span class="c">' + live.length + '</span><span class="ar">' + (liveOpen ? "▾" : "▸") + "</span></button>" + (liveOpen ? live.map(row).join("") : "") : "");
  }
  // A terminal plan (/ship): the Claude Code session that runs it and each subagent it started, live from its hooks.
  function ago(at) { const s = Math.max(0, Math.round((Date.now() - at) / 1000)); return s < 60 ? s + "s" : s < 3600 ? Math.round(s / 60) + "m" : Math.round(s / 3600) + "h"; }
  const ROLE = { executor: "Executor", reviewer: "Reviewer", signoff: "Sign-off", security: "Security", debugger: "Debugger", tester: "Tester" };
  const roleOf = (type) => { const k = String(type || "").replace(/^.*:/, ""); return ROLE[k] || k.charAt(0).toUpperCase() + k.slice(1) || "Agent"; };
  // One action, short: no "cd <folder>;" prefix, home as ~, no long absolute paths.
  const shortAct = (s) => String(s || "").replace(/^(Bash: )?cd [^;&]+(;|&&)\s*/, "$1").replace(/\/(?:private|tmp|var)\/[^\s"']*\/([^/\s"']+)/g, "$1").replace(/\/Users\/[^/\s]+/g, "~").replace(/~\/Desktop\/Repos\//g, "").replace(/\s+/g, " ").trim();
  function termBox(p) {
    const t = p.terminal; if (!t) return "";
    const fresh = t.lastSeenAt && Date.now() - t.lastSeenAt < 120000;
    const ags = (t.agents || []).slice().sort((a, b) => (b.doingAt || b.startedAt) - (a.doingAt || a.startedAt));
    const running = ags.filter((a) => !a.endedAt), done = ags.filter((a) => a.endedAt);
    const card = (a) => {
      const role = roleOf(a.type), act = a.endedAt ? a.result || "" : shortAct(a.doing) || "Starting…";
      return '<div class="tm-c ' + (a.endedAt ? "end" : "run") + '"><div class="tm-c1"><span class="d"></span><span class="tm-role r-' + esc(role.toLowerCase().replace(/[^a-z]/g, "")) + '">' + esc(role) + "</span>" +
        '<b class="tm-task">' + esc(a.task || "Plan") + "</b>" + (a.desc ? '<span class="tm-desc" title="' + esc(a.desc) + '">' + esc(a.desc.replace(/^T\d+\s*/, "")) + "</span>" : "") +
        '<span class="tm-meta">' + (a.model ? esc(a.model) + " · " : "") + (a.endedAt ? "finished " + ago(a.endedAt) + " ago" : ago(a.startedAt) + " · " + (a.tools || 0) + " tools") + "</span></div>" +
        '<div class="tm-act" title="' + esc(act) + '">' + (a.endedAt ? "" : "<i>now</i> ") + esc(act) + "</div></div>";
    };
    const testerOn = running.some((a) => roleOf(a.type) === "Tester");
    return '<div class="tmbox"><div class="tm-h"><span class="tm-dot ' + (fresh ? "on" : "") + '"></span><code title="The Claude Code session that runs this plan; every agent below is its subagent">' + esc(t.session.slice(0, 8)) + "</code>" +
      (t.cwd ? '<span class="sub">' + esc(t.cwd.replace(/^\/Users\/[^/]+/, "~")) + "</span>" : "") + '<span class="sub r">' + (t.lastSeenAt ? "last seen " + ago(t.lastSeenAt) + " ago" : "no event yet") + "</span></div>" +
      (t.master ? '<div class="tm-c master"><div class="tm-c1"><span class="d"></span><span class="tm-role r-master">Master</span><span class="tm-meta">' + esc(clockS(t.master.at)) + '</span></div><div class="tm-act" title="' + esc(t.master.line) + '">' + esc(shortAct(t.master.line)) + "</div></div>" : "") +
      (t.uat && !t.uat.answer && !testerOn ? '<div class="tm-wait">Staging test is waiting for the master to start its tester subagent.</div>' : "") +
      (t.sweep && !t.sweep.answer ? '<div class="tm-wait">Last review is waiting: ' + t.sweep.items.length + " minor findings to level.</div>" : "") +
      '<div class="tm-g">Subagents running <span>' + running.length + "</span></div>" + (running.length ? running.map(card).join("") : '<div class="tm-empty">None right now.</div>') +
      (done.length ? '<details class="tm-done"><summary>Subagents finished <span>' + done.length + "</span></summary>" + done.slice(0, 30).map(card).join("") + "</details>" : "") + "</div>";
  }
  function planbarHtml(p) {
    const s = p.steps, ks = tasksOf(p), done = ks.filter((t) => t.status === "done").length, k = kindOf(p);
    const running = p.started && !p.error && !p.landedAt && s.master !== "you" && s.master !== "done";
    const canRetry = (p.error || p.stopRequested || ks.some((t) => t.status === "failed")) && !wdOn(p);
    const top = '<div class="pb-top"><div class="pb-l">' + ptag(p) + "<h1>" + esc(p.title) + "</h1>" + sizeTag(p) + '<span class="sub">pasted ' + esc(ist(p.pastedAt)) + " · " + (k === "port" ? "already on staging" : k === "promote" ? esc(p.promotes) + " → staging" : ks.length ? done + "/" + plural(ks.length, "task") + " done" : "sizing") + '</span></div><div class="pb-act">' +
      (false && canRetry ? btn("Retry", "sm", "retry", 'data-id="' + esc(p.id) + '" data-key="/plans/' + esc(p.id) + '/retry"') : "") +
      (running && !p.stopRequested ? btn("Stop", "sm bare", "stop", 'data-id="' + esc(p.id) + '" data-key="/plans/' + esc(p.id) + '/stop"') : p.stopRequested ? '<span class="sub">Stopping…</span>' : "") +
      (p.deleting ? '<span class="sub">Deleting…</span>' : merging(p) ? "" : btn("Delete", "sm bare", "delete", 'data-id="' + esc(p.id) + '" data-key="/plans/' + esc(p.id) + '/delete"')) +
      btn("Progress", "sm", "plan", 'data-id="' + esc(p.id) + '" data-tab="progress"') + btn(k === "big" ? "Plan" : k === "list" ? "List" : "Bug", "sm", "plan", 'data-id="' + esc(p.id) + '" data-tab="plan"') + btn("PRs", "sm", "plan", 'data-id="' + esc(p.id) + '" data-tab="prs"') +
      (s.master === "you" && !merging(p) ? btn("Merge master PR" + (p.masterPrs.length > 1 ? "s" : ""), "sm gold", "plan", 'data-id="' + esc(p.id) + '" data-tab="prs"') : "") +
      (p.targetBranch ? '<span class="sub" title="Merge to master is off for this plan">Targets ' + esc(p.targetBranch) + ", not staging</span>" : "") + "</div></div>";
    const track = '<div class="ptrack">' + trackOf(p).map(([n, st, sub]) => '<div class="pstep ' + esc(wdOn(p) && st === "fail" ? "dog" : st) + '"><div class="bar"></div><b>' + esc(n) + "</b><small>" + esc(sub) + "</small></div>").join("") + "</div>";
    const now = '<div class="pnow ' + esc(wdOn(p) && p.watchdog.steps?.[2]?.state !== "wait" ? "dog" : p.tone) + " " + (s.plan === "you" ? "waiting-you" : "") + '"><i></i><span>' + esc(p.error && !(wdOn(p) && p.watchdog.steps?.[2]?.state !== "wait") ? "Stopped: " + p.error : s.plan === "run" && p.activity?.length ? "Planning · " + lastAct(p.activity) : p.now) + (p.nowAt ? ' <span class="at">· ' + esc(ist(p.nowAt)) + "</span>" : "") + "</span></div>";
    const ver = p.versions?.length ? p.versions[p.versions.length - 1].n : 1;
    const ch = p.changes?.length && p.needsStart && !changesHidden.has(p.id + "#" + ver) ? '<div class="changes"><b>What changed in version ' + ver + '<button class="x" data-a="changes-x" data-id="' + esc(p.id) + '" data-n="' + ver + '" title="Hide (shows again for the next version)">✕</button></b>' + p.changes.map((c) => "<span>" + esc(c) + "</span>").join("") + "</div>" : "";
    const wl = wdLine(p.watchdog), wd = (wl ? '<div class="wdl">' + wl + "</div>" : "") + wdBox(p.watchdog, p.id);
    return top + track + now + termBox(p) + wd + ch // minor findings live on the Findings page (sidebar), not here + (k === "big" && ks.length ? wavesHtml(p) : k === "list" && ks.length ? triageHtml(p) : "");
  }
  // Every minor finding the task rounds let through, kept so none is lost. The last review marks harmful ones; you decide every one.
  const openMinorsOf = (p) => (S.minors?.[p.id] || []).filter((m) => !m.decided && (!m.status || ["open", "harmful", "minor", "trivial"].includes(m.status))).sort((a, b) => lvlRank(a) - lvlRank(b));
  const lvlOf = (m) => (m.status === "harmful" ? "harmful" : m.checked?.still ? m.checked.level || "minor" : "");
  const lvlRank = (m) => ({ harmful: 0, minor: 1, trivial: 2 })[lvlOf(m)] ?? 3; // harmful, then minor, then trivial, then not yet checked
  let changesHidden = new Set(); // "P-06#12": a "what changed" box you closed; the next version shows again
  try { changesHidden = new Set(JSON.parse(localStorage.getItem("prflow.changesHidden") || "[]")); } catch (e) { /* no storage */ }
  let minorsOpen = false; const minorGroupsOpen = new Set(); // the box is closed by default; it and each task's list stay as you left them
  try { minorsOpen = localStorage.getItem("prflow.minorsOpen") === "1"; } catch (e) { /* no storage */ }
  function minorsHtml(p) {
    const ms = openMinorsOf(p); if (!ms.length) return "";
    const st = p.steps, canSend = !!p.terminal && !(st.staging === "run" || st.uat === "run" || st.master === "you" || st.master === "done" || p.merging); // as sendBackTask allows
    const checked = ms.every((m) => m.checked);
    const groups = {}; for (const m of ms) (groups[m.label] ||= []).push(m);
    const li = (m) => findingLi(m.finding).replace('<li class="fnd">', '<li class="fnd' + (m.status === "harmful" ? " harm" : "") + '">' + (lvlOf(m) ? '<span class="fd-s ' + lvlOf(m) + '">' + lvlOf(m)[0].toUpperCase() + lvlOf(m).slice(1) + "</span> " : "") + '<span class="mtag">' + esc(m.finding.category) + " · round " + m.round + "</span>")
      .replace(/<\/li>$/, (m.checked ? '<div class="fnd-f"><b>Last review:</b> ' + esc(m.checked.why) + "</div>" : "") + '<div class="cbtn">' + (canSend ? btn("Send back", "sm", "minor", 'data-id="' + esc(p.id) + '" data-n="' + esc(m.key) + '" data-c="send"') : "") + btn("Accept", "sm bare", "minor", 'data-id="' + esc(p.id) + '" data-n="' + esc(m.key) + '" data-c="accept"') + "</div></li>");
    const head = '<button class="mhead" data-a="minors-fold" aria-expanded="' + minorsOpen + '"><b>Minor findings to decide · ' + ms.length + '</b><span class="ar">' + (minorsOpen ? "▴" : "▾") + "</span></button>";
    if (!minorsOpen) return '<div class="minors">' + head + "</div>";
    return '<div class="minors">' + head + '<span class="sub">' +
      (checked ? "The last review checked these against the final code: they are still there" + (ms.some((m) => lvlOf(m)) ? ", sorted Harmful, then Minor, then Trivial" : "") + ". Fixed ones are under Findings. " : "Kept from every review round. The last review checks them against the final code when every task is done, and sends harmful ones back by itself. ") +
      (canSend ? "Send one back to its writer as blocking, or accept it." : "The plan is at its master PRs: accept each one, or edit the plan to fix it.") + "</span>" +
      Object.entries(groups).map(([l, g]) => '<details class="mgrp" data-g="' + esc(p.id + "/" + l) + '"' + (minorGroupsOpen.has(p.id + "/" + l) ? " open" : "") + "><summary>" + esc(l) + " · " + plural(g.length, "finding") + '</summary><ul class="fnd-l">' + g.map(li).join("") + "</ul></details>").join("") + "</div>";
  }
  const minorsLine = (p) => { const ms = p ? openMinorsOf(p) : [], n = ms.length, h = ms.filter((m) => m.status === "harmful").length; return n ? "<p><b>" + (h ? plural(h, "harmful finding") + " not fixed" + (n > h ? ", and " + plural(n - h, "other minor finding") : "") : plural(n, "minor finding")) + " not decided.</b> No review round will look at them again. Decide them on the plan first, or go on anyway.</p>" : ""; };
  function chip(t, text) {
    return '<div class="chip ' + esc(t.status) + '" role="button" tabindex="0" data-a="task" data-id="' + esc(t.id) + '"><i></i><span class="id">' + esc(t.label) + '</span><span class="t">' + esc(text ?? t.title) + "</span></div>";
  }
  function wavesHtml(p) {
    const ks = tasksOf(p), ws = [];
    for (let w = 1; w <= waveCount(p); w++) {
      const ids = ks.filter((t) => t.wave === w); if (!ids.length) continue;
      const gi = p.gating?.wave === w ? p.gating : null;
      ws.push('<div class="wave"><h4>Wave ' + w + (ids.length > 1 ? " · parallel" : "") + '<span class="g ' + (p.gates[w] ? "ok" : gi ? "run" : "") + '" title="' + (gi ? "Building " + esc(gi.repo) + " with every task of this wave together" : "After every task: a full build and all tests of each repo, with the wave's changes together") + '">' + (p.gates[w] ? "✓ gate" : gi ? "gate: checking " + gi.i + "/" + gi.n : "gate") + "</span></h4>" + ids.map((t) => chip(t)).join("") + "</div>");
    }
    return '<div class="waves">' + ws.join('<div class="arrow">→</div>') + '<div class="wave-why"><b style="color:var(--ink-2)">Wave:</b> a group of tasks that run at the same time because they change different files. The next wave starts only when every task before it is done and the full build passes (the gate).</div></div>';
  }
  const VERDICT = { not_a_bug: "Not a bug", already_fixed: "Already fixed", needs_info: "Needs info", duplicate: "Duplicate" };
  function triageHtml(p) {
    return '<div class="triage">' + (p.triage || []).map((r) => {
      const t = r.task ? taskByRef(p, r.task) : null;
      const right = t ? chip(t, t.bugs && t.bugs.length > 1 ? "with #" + t.bugs.filter((b) => b !== r.n).join(", #") : t.title)
        : '<span class="lo"><b>' + esc(VERDICT[r.leftOut?.verdict] || "Left out") + "</b><span>" + esc(r.leftOut?.why || "") + "</span>" + (!r.leftOut ? "" : r.leftOut.fixAnyway ? '<button class="sm" disabled>Asked to fix</button>' : "") + "</span>";
      return '<div class="tr ' + (t ? "" : "out") + '"><span class="bn">#' + r.n + '</span><span class="bt">' + esc(r.text) + "</span>" + right + "</div>";
    }).join("") + "</div>";
  }
  // A done task's line follows its repo through the plan: plan branch → staging (which PR, which deploy) → UAT → master → live.
  function doneLine(t, p) {
    if (t.status !== "done") return null;
    const s = p.steps, part = (p.repos || []).find((r) => r.repo === t.repo), spr = (p.stagingPrs || []).filter((r) => r.repo === t.repo).pop(), mpr = (p.masterPrs || []).find((r) => r.repo === t.repo);
    if (s.master === "done") return ["Live on prod" + (mpr ? " · " + t.repo + " #" + mpr.id : ""), false];
    if (p.stagingOnly && s.uat === "done") return ["Done on staging" + (spr ? " · " + t.repo + " #" + spr.id : "") + " · no master PR (staging only)", false];
    if (p.targetBranch && part?.staged) return ["In " + p.targetBranch + (spr ? " (PR #" + spr.id + ")" : "") + (p.landedAt ? " · build and tests pass" : " · waits for the other repos"), false];
    if (s.master === "you" && mpr) return ["On staging · master PR #" + mpr.id + " ready for your merge", false];
    if (s.master === "run") return ["On staging · master PR being made", true];
    if (s.uat === "run") return ["On staging · the staging test is running", true];
    if (s.uat === "done" && !s.master && !p.error) return ["On staging · staging test passed · making the master PR", true];
    if (s.uat === "done") return ["On staging · staging test passed", false];
    if (part?.staged) return ["On staging" + (spr ? " (PR #" + spr.id + ")" : "") + " · waits for the other repos, then the staging test", false];
    // A repo merged by an earlier run is already on staging; a plan edit can send it again with new commits.
    const on = spr?.state === "merged" ? "On staging (PR #" + spr.id + ")" : "";
    if (s.staging === "run") {
      const now = String(p.now || "");
      if (now.startsWith("architect-reviewer")) return [(on || "Built") + " · architect (Opus) is reviewing the whole plan before staging", true];
      if (now.startsWith(t.repo + " (")) return [(on ? on + " · " : "Going to staging · ") + now.split(": ").slice(1).join(": "), true];
      return [(on || "Done") + " · waits for its repo's turn to go to staging", false];
    }
    if (on) return [on + " · waits for the rest of the plan", false];
    return [p.gates && Object.keys(p.gates).length && p.gates[p.waves] ? "Done · build and tests pass · not on staging yet" : "Done · reviewed · builds at the last gate", false];
  }
  // Links to a plan's PRs (staging and master), newest first; only real http(s) links, so a dry run shows none.
  function prLinks(p, repo) {
    const prs = [...(p.stagingPrs || []).map((r) => [p.targetBranch ? "Target" : "Staging", r]), ...(p.masterPrs || []).map((r) => ["Master", r])].filter(([, r]) => (!repo || r.repo === repo) && /^https?:\/\//.test(r.url || ""));
    if (!prs.length) return "";
    return '<div class="pr-links">' + prs.map(([k, r]) => '<a href="' + esc(r.url) + '" target="_blank" rel="noopener">' + k + " PR #" + esc(r.id) + (repo ? "" : " · " + esc(r.repo)) + " ↗</a>" + '<span class="pr-st">' + esc(r.state === "merged" ? (r.byHand ? "merged · deploy by hand" : r.deployed ? "merged · deployed" : "merged") : r.state) + "</span>").join("") + "</div>";
  }
  function cardHtml(id) {
    const t = S.tasks[id], p = planById(t.planId); if (!p) return "";
    const dl = doneLine(t, p), live = !!dl?.[1];
    const cls = live ? "s-live" : t.status === "done" ? "s-done" : t.status === "failed" ? "s-fail" : t.status === "waiting" || t.status === "draft" ? "" : "s-work";
    const lab = (d) => String(d).split("/").pop();
    const dd = t.deps.map((d) => '<span class="d ' + (S.tasks[d]?.status === "done" ? "ok" : "") + '">' + (S.tasks[d]?.status === "done" ? "✓ " : "") + esc(lab(d)) + "</span>").join("");
    const deps = dd ? '<div class="deps">' + (t.waitsOn?.length ? "Also after " : "Waits for ") + dd + "</div>" : "";
    const wv = kindOf(p) === "big" ? "Wave " + t.wave + " · " + t.size : kindOf(p) === "list" ? "Bug " + (t.bugs || []).join(", ") + " · " + t.size : "One task · " + t.size;
    return '<div class="card ' + (open === id ? "on" : "") + " " + (t.status === "draft" ? "tdraft" : "") + '" data-id="' + esc(id) + '" data-a="task" tabindex="0"><div class="card-top">' + ptag(p) + '<span class="no">' + esc(t.label) + "</span>" + (t.isNew ? '<span class="newtag">NEW</span>' : "") + (t.changed && !t.isNew ? '<span class="newtag">CHANGED</span>' : "") + (t.status === "working" || t.status === "review" || live ? '<i class="live-dot" title="' + (live ? "Going to staging or deploying now" : "Working now") + '"></i>' : "") + '<span class="wv">' + esc(wv) + '</span></div><div class="repo">' + esc(t.repo) + '</div><div class="m">' + esc(t.title) + '</div><div class="s ' + cls + '"><i></i><span>' + esc(dl?.[0] || t.sub) + "</span></div>" + (t.status === "waiting" || t.status === "draft" ? deps : "") + "</div>";
  }
  function planCard(p) {
    const kind = forYouKind(p), pid = esc(p.id), n = p.masterPrs.length, live = p.steps.master === "done";
    if (kind === "watchdog") {
      const w = p.watchdog, starting = w.state === "working" && w.steps?.[2]?.state === "wait" && !!p.error, fixing = w.state === "working" && !starting;
      const label = starting ? "Stopped" : fixing ? "Watchdog fixing" : "Watchdog fixed it";
      const line = starting ? p.error : fixing ? w.doing || w.why || "Reading why it stopped" : (w.summary || "") + " · restarting when nothing is busy, then Retry";
      return '<div class="card plan ' + (starting ? "stopcard" : "wdcard") + '" data-id="' + pid + '-wd" data-a="pick" data-id2="' + pid + '" tabindex="0"><div class="card-top">' + ptag(p) + '<span class="you ' + (starting ? "bad" : "dog") + '">' + label + '</span></div><div class="m">' + esc(p.title) + '</div><div class="s ' + (starting ? "s-fail" : "s-work") + '"><i></i><span>' + esc(line) + '</span></div><div class="wdl">' + (starting ? '<span class="wdpill work">' + DOG + "Watchdog is starting</span>" : wdLine(w)) + '</div><div class="cbtn"><button class="sm" disabled>Edit plan</button><button class="sm" disabled title="The watchdog is on it">Retry</button></div></div>';
    }
    if (kind === "error") {
      const needs = p.watchdog?.state === "needs" ? p.watchdog : null, wl = wdLine(p.watchdog);
      return '<div class="card plan err" data-id="' + pid + '-error" data-a="pick" data-id2="' + pid + '" tabindex="0"><div class="card-top">' + ptag(p) + '<span class="you ' + (p.askYou ? "" : "bad") + '">' + (needs || p.askYou ? "Needs you" : "Stopped") + '</span></div><div class="m">' + esc(p.title) + '</div><div class="errtxt">' + esc(needs ? needs.needs : p.error) + "</div>" + (wl ? '<div class="wdl">' + wl + "</div>" : "") + '<div class="cbtn">' +  "" + "</div></div>";
    }
    if (kind === "start") {
      const ks = tasksOf(p), v = p.versions?.length || 1;
      return '<div class="card plan" data-id="' + pid + '-start" data-a="pick" data-id2="' + pid + '" tabindex="0"><div class="card-top">' + ptag(p) + '<span class="you">Press Start</span></div><div class="m">' + esc(p.title) + '</div><div class="s s-approve"><i></i><span>' + (p.kind === "promote" ? esc(p.promotes) + " → staging · " + plural(p.repos.length, "repo") : "Planned" + (v > 1 ? " (version " + v + ")" : "") + " · " + plural(ks.length, "task") + (p.targetBranch ? " · into " + esc(p.targetBranch) : "")) + " · nothing runs yet</span></div>" + ((p.uncovered?.length || p.dbChanges?.length || p.overlaps?.length) ? '<div class="errtxt">' + esc([p.uncovered?.length ? plural(p.uncovered.length, "part") + " not covered by any task" : "", p.dbChanges?.length ? plural(p.dbChanges.length, "database change") + " to run by hand" : "", p.overlaps?.length ? "shares files with " + [...new Set(p.overlaps.map((o) => o.plan))].join(", ") : ""].filter(Boolean).join(" · ")) + " · see Progress</div>" : "") + "<div class=\"cbtn\">" + (p.kind === "promote" ? "" : btn("Edit plan", "sm", "edit", 'data-id="' + pid + '"')) + btn("Start", "sm gold", "start", 'data-id="' + pid + '" data-key="/plans/' + pid + '/start"') + "</div></div>";
    }
    const merged = p.masterPrs.filter((r) => r.state === "merged").length, mg = !live && merging(p), [ml, md, depId] = mg ? mergeLine(p) : [];
    const status = live ? merged + "/" + n + " merged by you · live on prod" : mg ? ml + (md ? " · " + md + (md.startsWith("deploying") ? " to prod" : "") : "") : "UAT passed · " + (n > 1 ? n + " master PRs, merge in order" : "1 master PR");
    return '<div class="card plan" data-id="' + pid + '" data-a="plan" data-tab="progress" tabindex="0"><div class="card-top">' + ptag(p) + '<span class="you' + (mg ? " merging" : "") + '">' + (live ? "Live" : mg ? "Merging" : "Your merge") + '</span></div><div class="m">' + esc(p.title) + '</div><div class="s ' + (live ? "s-done" : mg ? "s-dep" : "s-approve") + '"><i></i><span>' + esc(status) + '</span></div><div class="prs">' + p.masterPrs.slice().sort((a, b) => a.order - b.order).map((r) => '<a href="' + safeUrl(r.url) + '" target="_blank" rel="noopener">' + (r.state === "merged" ? "✓ " : "") + esc(r.repo) + " #" + r.id + (mg && r.id === depId ? ' <span class="dep">deploying</span>' : "") + "</a>").join("") + "</div></div>";
  }

  // ---------- drawer ----------
  function openPlan(pid, tab) { open = "plan"; openPid = pid; dtab = tab; renderDetail(); }
  // The open drawer and its tab live in the URL hash, so a reload opens it again.
  function saveHash() {
    const d = open === "plan" ? "plan=" + encodeURIComponent(openPid) + "&tab=" + dtab : open ? "task=" + encodeURIComponent(open) + "&tab=" + dtab : "";
    const h = [sel !== "all" ? "view=" + encodeURIComponent(sel) : "", d].filter(Boolean).join("&"); // the plan picked in the sidebar survives a reload
    if (("#" + h) !== (location.hash || "#")) history.replaceState(null, "", location.pathname + location.search + (h ? "#" + h : ""));
  }
  function restoreHash() {
    const q = new URLSearchParams(location.hash.slice(1)), pid = q.get("plan"), tid = q.get("task"), tab = q.get("tab"), view = q.get("view");
    if (view && planById(view)) { sel = view; render(); }
    if (pid && planById(pid)) openPlan(pid, tab || "progress");
    else if (tid && S.tasks[tid]) { open = tid; dtab = tab || "steps"; renderDetail(); render(); }
    else return;
    pollEvents();
  }
  function closeDetail(quiet) { open = null; saveHash(); $("#detail").classList.remove("open"); $("#scrim").classList.remove("open"); if (!quiet) render(); }
  function renderDetail() {
    const d = $("#detail"), wasOpen = d.classList.contains("open"), key = open + "|" + dtab, sc = d.dataset.key === key ? d.scrollTop : 0;
    if (open === "plan") { if (!planById(openPid)) return closeDetail(true); planDetail(d, planById(openPid)); }
    else taskDetail(d, S.tasks[open]);
    d.dataset.key = key; d.classList.add("open"); $("#scrim").classList.add("open"); saveHash();
    if (sc) d.scrollTop = sc;
    if (!wasOpen) d.querySelector('[data-a="close"]')?.focus();
    applyBusy();
  }
  function taskDetail(d, t) {
    const p = planById(t.planId), st = t.status, k = kindOf(p), ks = tasksOf(p);
    const badge = { draft: ["", "Planned"], waiting: ["", "Waiting"], working: ["diagnosing", "Working"], review: ["diagnosing", S.config?.buildEachTask === false ? "Review" : "Review & build"], done: ["done", "Done"], failed: ["bad", "Sent back"] }[st] || ["", st];
    const tabs = [["steps", "Steps"], ["loop", "Review loop"], ["what", "What it does"]];
    const dl = (x) => String(x).split("/").pop();
    const meta = k === "list" ? "<span>Fixes bug " + esc((t.bugs || []).join(" and ")) + "</span><span>Size " + t.size + "</span><span>Runs in parallel with the other " + (ks.length - 1) + "</span>"
      : k === "big" ? "<span>Wave " + t.wave + "</span><span>Size " + t.size + "</span><span>" + (t.deps.length ? "Waits for " + esc(t.deps.map(dl).join(", ")) : "Waits for nothing") + "</span>"
      : "<span>One task (small)</span><span>Size " + t.size + "</span>";
    d.innerHTML = '<div class="d-head"><div class="d-top"><div><h2>' + ptag(p) + " " + esc(t.label) + " · " + esc(t.title) + '</h2><div class="d-meta"><span>' + esc(t.repo) + "</span>" + meta + "</div>" + (t.branch ? '<div class="d-meta"><span>Branch <code>' + esc(t.branch) + "</code></span>" + (t.dir ? '<span title="' + esc(t.dir) + '">Worktree …/' + esc(String(t.dir).split("/").slice(-2).join("/")) + "</span>" : "") + "<span>Merges into <code>" + esc((p.repos || []).find((r) => r.repo === t.repo)?.branch || "the plan branch") + "</code></span></div>" : "") + prLinks(p, t.repo) + '</div><span class="badge ' + badge[0] + '">' + badge[1] + "</span>" + btn("Close", "bare", "close") + "</div>" + roleHtml(t, p, ks) +
      '<div class="tabs" role="tablist">' + tabs.map(([x, n]) => '<button role="tab" class="' + (dtab === x ? "on" : "") + '" data-a="tab" data-id="' + x + '">' + n + (x === "loop" && t.rounds.length ? '<span class="cnt">' + t.rounds.length + "</span>" : "") + "</button>").join("") + "</div></div>" +
      '<div class="d-body">' + (dtab === "what" ? whatTab(t, p) : dtab === "steps" ? stepsTab(t, p) : loopTab(t)) + "</div>";
  }
  function roleHtml(t, p, ks) {
    const n = ks.findIndex((x) => x.id === t.id) + 1, unlocks = ks.filter((x) => x.deps.includes(t.id)), k = kindOf(p);
    const top = k === "list" ? '<div class="role"><span class="rl">BUG' + ((t.bugs || []).length > 1 ? "S" : "") + " IT FIXES · #" + esc((t.bugs || []).join(" AND #")) + "</span><div>" + esc(t.part) + "</div></div>"
      : ks.length === 1 ? '<div class="role"><span class="rl">THE WHOLE FIX · ONE TASK</span><div>' + esc(t.part) + "</div></div>"
      : '<div class="role"><span class="rl">ITS PART OF THE PLAN · ' + n + " OF " + ks.length + "</span><div>" + esc(t.part) + '</div><div class="un">' + esc(unlocks.length ? "Unlocks " + unlocks.map((x) => x.label).join(", ") + " (" + unlocks.map((x) => x.title.toLowerCase()).join("; ") + ")." : "The last part: nothing waits for it.") + "</div></div>";
    return top + (t.status === "done" && t.did ? '<div class="role did"><span class="rl">WHAT IT DID</span><div>' + esc(t.did) + (t.stat ? " " + esc(t.stat) : "") + "</div></div>" : "");
  }
  function whatTab(t, p) {
    const ok = t.status === "done";
    const notes = t.notes?.length ? '<div class="blk"><h3>Updates from your edit</h3><ul class="plain">' + t.notes.map((x) => "<li>" + esc(x) + "</li>").join("") + "</ul></div>" : "";
    return '<div class="blk"><h3>In short</h3><ul class="plain">' + t.what.map((w) => "<li>" + esc(w) + "</li>").join("") + "</ul></div>" + notes +
      '<div class="blk"><h3>Now</h3><div class="s ' + (t.status === "failed" ? "s-fail" : "") + '" style="font-size:13.5px;color:var(--ink-2)">' + esc(t.sub) + (t.error ? "<br>" + esc(t.error) : "") + "</div>" + (t.status === "failed" ? '<div class="cbtn" style="margin-top:8px">' + btn("Keep merged code", "sm", "keep", 'data-id="' + esc(t.id) + '" title="Mark it done with the code already in the plan branch; drops this failed attempt"') + "</div>" : "") + "</div>" +
      '<div class="blk"><h3>Tests this task writes</h3><ul class="checks">' + t.checks.map((c) => '<li class="' + (ok ? "ok" : "") + '">' + esc(c) + "</li>").join("") + '</ul><p class="legend">These run in the build with every old test. After staging, the UAT test runs on top (see the plan\'s UAT test tab).</p></div>' +
      '<div class="blk"><h3>Files only this task may change</h3><div class="files">' + esc(t.files.join("\n")) + '</div><p class="legend">' + (kindOf(p) !== "small" ? "Tasks that run at the same time never share a file. A task that needs another task's file stops and says so." : "A fix that needs more files than this stops and says so.") + "</p></div>";
  }
  // ---------- step track (rows copy the board's code-fix drawer: .cf-track) ----------
  const evs = (pid) => EV[pid] || [];
  const lastEv = (list, f) => { for (let i = list.length - 1; i >= 0; i--) if (f(list[i])) return list[i]; return null; };
  const cfRow = (st, name, sub, at, extra) => '<li class="cf-' + (st || "wait") + '"><span class="cf-dot" aria-hidden="true"></span><div><div class="cf-name">' + name + "</div>" + (sub ? '<div class="cf-sub">' + esc(sub) + "</div>" : "") + (extra || "") + '</div><span class="cf-when">' + esc(clock(at)) + "</span></li>";
  const prLink = (r) => (r ? '<a class="cf-link" href="' + safeUrl(r.url) + '" target="_blank" rel="noopener">PR #' + esc(r.id) + "</a>" : "");
  const FROM = { uat: "the UAT test", gate: "the wave gate", architect: "the architect review", edit: "your edit" };
  // A finding as one short bullet: the problem, what was changed for it, and the reviewer's full text folded away.
  const firstLine = (s) => { const all = String(s || "").split(/(?<=[.!?])\s/), t = all.find((x) => x.split(/\s+/).length >= 4) || all[0] || ""; return t.length > 180 ? t.slice(0, 177) + "…" : t; }; // older rounds have no short line
  // st: what happened to a blocking finding (server: core/minors.ts blockingStates), shown as a tag and a note.
  const BS_LABEL = { fixed: "Fixed", "partly fixed": "Partly fixed", "not fixed": "Not fixed", "being fixed": "Being fixed", "sent to planner": "Sent to the planner" };
  const findingLi = (f, fixed, st) => '<li class="fnd"><div class="fnd-p">' + (st ? '<span class="fd-s ' + esc(st.status.replace(/ /g, "-")) + '">' + esc(BS_LABEL[st.status] || st.status) + "</span> " : "") + esc(f.short || firstLine(f.text)) + "</div>" +
    (st ? (st.note ? '<div class="' + (st.status === "fixed" ? "fnd-f" : "fnd-n") + '">' + (st.status === "fixed" ? "<b>Fixed:</b> " : "") + esc(st.note) + "</div>" : "") : fixed ? '<div class="fnd-f"><b>Fixed:</b> ' + esc(fixed) + "</div>" : "") +
    '<details class="fnd-d"><summary>Details' + (f.file ? " · " + esc(f.file.split("/").pop() + (f.line ? ":" + f.line : "")) : "") + "</summary><div>" + esc(f.text) + (f.file ? " <code>" + esc(f.file + (f.line ? ":" + f.line : "")) + "</code>" : "") + "</div></details></li>";
  const findingsList = (r, sts) => '<ul class="fnd-l">' + r.blocking.map((f, i) => findingLi(f, r.fixed?.[i], sts?.[i])).join("") + "</ul>" + (r.fix && !r.fixed?.length ? '<div class="fnd-f"><b>Writer\'s change:</b> ' + esc(r.fix) + "</div>" : "");
  function roundsHtml(rs, t) {
    if (!rs.length) return "";
    const sts = S.blocking?.[t.id] || [];
    return '<div class="rv-loop">' + rs.map((r, ri) => {
      const bad = r.blocking.length > 0;
      return '<div class="rv ' + (bad ? "bad" : "ok") + '"><div class="rv-h"><b>Round ' + r.n + "</b><span>" + esc((r.by || []).join(" + ") || "code-reviewer") + " · " + esc(clock(r.at)) + '</span><span class="tag2 ' + (bad ? "bad" : "ok") + '">' + (bad ? "Blocking" : "Clean") + "</span></div>" +
        (bad ? findingsList(r, sts[ri]) : '<div class="rv-b">No blocking findings.</div>') +
        (r.minor?.length ? '<div class="rv-m">' + plural(r.minor.length, "minor finding") + ", not looped</div>" : "") +
        (FROM[r.source] ? '<div class="rv-n">Sent back by ' + FROM[r.source] + "</div>" : "") + "</div>";
    }).join("") + "</div>";
  }
  function stepsTab(t, p) {
    const list = evs(p.id).filter((e) => e.task === t.id), ev = (n) => lastEv(list, (e) => e.event === n), last = list[list.length - 1], s = t.status;
    const perTask = S.config?.buildEachTask !== false; // off: tasks are only reviewed; each repo builds once at the last gate
    const building = perTask && s === "working" && (/^(build|compil)|tests are running|debugger/i.test(t.sub) || (last && ["build", "debugger_start", "debugger_end"].includes(last.event)));
    const cur = s === "draft" ? 0 : s === "waiting" ? 1 : s === "working" ? (building ? 3 : 2) : s === "review" ? 4 : s === "done" ? 6 : t.rounds.length || ev("review_start") ? 4 : ev("build") ? 3 : 2;
    const st = (n) => (n < cur ? "done" : n === cur ? (s === "failed" ? "fail" : s === "draft" ? "wait" : "run") : "wait");
    const sub = (n, idle) => (n === cur && s !== "draft" ? (s === "failed" ? t.error || t.sub : t.sub) : idle);
    const dl = (d) => String(d).split("/").pop(), part = p.repos.find((r) => r.repo === t.repo);
    const waitIdle = (t.deps.length ? t.deps.map(dl).join(", ") + " must be done first" : "Nothing to wait for") + (t.waitsOn?.length ? "\nAlso waits for " + t.waitsOn.join(", ") + " (same files)" : "");
    const nr = t.rounds.length, live = (n) => (n === cur && (s === "working" || s === "review") && t.activity?.length ? liveBox(t.activity, 3, "What it is doing") : "");
    const rows = [
      cfRow(s === "draft" ? "wait" : "done", "Planned", s === "draft" ? "Waits for you to press Start" : "Started", s === "draft" ? 0 : p.startedAt || ev("task_waits")?.at || p.pastedAt),
      cfRow(st(1), "Waits for its tasks", sub(1, waitIdle), ev("task_waits")?.at),
      cfRow(st(2), "Writing the code and its tests", sub(2, "executor (Sonnet), in its own worktree, only its files"), ev("executor_start")?.at, live(2)),
      ...(perTask ? [cfRow(st(3), "Build and all tests", sub(3, "New and old tests. A failing test goes to debugger (Sonnet)"), ev("build")?.at, live(3))] : []),
      cfRow(st(4), "Review" + (nr ? " · " + plural(nr, "round") : ""), sub(4, t.review === false && !t.security ? "No code review: " + (t.reviewWhy || "small mechanical change") + (perTask ? ". Build, tests and the UAT test still check it" : ". The last gate's build and the UAT test still check it") : "code-reviewer (Opus)" + (t.security ? "; security-reviewer (Opus): " + (t.securityWhy || "the planner flagged it") : "; no security review" + (t.securityWhy ? ": " + t.securityWhy : ""))), ev("review_start")?.at, roundsHtml(t.rounds, t) + live(4)),
      cfRow(s === "done" ? "done" : "wait", "Merged into the plan branch", s === "done" ? t.sub : (part?.branch || p.slug) + " in " + t.repo, ev("merge")?.at || (s === "done" ? t.doneAt : 0)),
    ];
    if (s === "done") rows.push(...laterRows(t, p, part));
    return '<div class="blk"><ul class="cf-track">' + rows.join("") + "</ul></div>";
  }
  // After the task is merged into the plan branch, its repo goes to staging, the staging test runs, then the master PR.
  function laterRows(t, p, part) {
    const all = evs(p.id), pev = (n, f) => lastEv(all, (e) => e.event === n && (!f || f(e))), ps = p.steps;
    const spr = p.stagingPrs.filter((r) => r.repo === t.repo).pop(), mpr = p.masterPrs.filter((r) => r.repo === t.repo).pop();
    const stagedNow = !!part?.staged || ps.staging === "done";
    const arch = ps.staging === "run" && String(p.now || "").startsWith("architect-reviewer");
    const stgSt = stagedNow ? "done" : ps.staging === "fail" ? "fail" : ps.staging === "run" && (arch || String(p.now || "").startsWith(t.repo + " (")) ? "run" : "wait";
    const stgSub = arch ? "architect-reviewer (Opus) is reviewing the whole plan before anything goes to staging" : stagedNow ? (spr ? "Staging PR #" + spr.id + " merged into " + (part?.base || "staging") + (spr.byHand ? " · not deployed: no pipeline deploys " + t.repo : " · deployed to UAT") : "Nothing new to merge")
      : stgSt === "run" ? p.now : ps.staging === "fail" ? p.error || "Stopped" : "Waits for the other tasks and repos in the plan";
    const mine = ps.uat ? (p.uat?.checks || []).filter((c) => c.task === t.label) : []; // a waiting test shows no checks from an earlier run
    const uSt = ps.uat === "done" ? "done" : ps.uat === "fail" ? "fail" : ps.uat === "run" ? "run" : "wait";
    const uSub = ps.uat === "run" ? "Step " + ((p.uatStep ?? 0) + 1) + " of 3 · " + (p.now || "running") : ps.uat === "done" ? (mine.length ? plural(mine.length, "check") + " for this task passed" : "Every check passed") : ps.uat === "fail" ? "A check failed; sent back to its task" : "Runs once every repo is on staging";
    const mineHtml = mine.length ? '<ul class="cf-res">' + mine.map((u) => '<li class="' + (u.ok === false ? "bad" : "") + '">' + (u.ok === true ? "✓" : u.ok === false ? "✗" : "○") + " " + esc(u.what) + (u.detail ? " · " + esc(u.detail) : "") + "</li>").join("") + "</ul>" : "";
    const making = ps.uat === "done" && (ps.master === "" || ps.master === "run") && !p.error;
    const mSt = mpr ? (mpr.state === "merged" ? "done" : "run") : making ? "run" : "wait";
    const mSub = !mpr && making ? (p.now || "Making the master PRs") : mpr ? "#" + mpr.id + " " + (mpr.state === "merged" ? "merged" + (mpr.byHand ? " · deploy " + t.repo + " by hand" : mpr.deployed ? " · live on prod" : "") : "open · merges only on your click") : "Opens after the staging test passes";
    return [
      cfRow(stgSt, "To staging · " + esc(t.repo), stgSub, pev("pr_merged", (e) => e.repo === t.repo)?.at, prLinks(p, t.repo)),
      cfRow(uSt, "Staging test on UAT", uSub, (pev("uat_result") || pev("uat_start"))?.at, ps.uat === "run" ? uatLive(p) : mineHtml),
      cfRow(mSt, "Master PR · " + esc(t.repo), mSub, pev("pr_created", (e) => e.repo === t.repo && e.id === mpr?.id)?.at),
    ];
  }
  const SM = { run: "run", done: "done", fail: "fail", you: "you" };
  // Release steps (ADR-0011): the prod writes Merge runs around the master PRs, in the order they run.
  const RS_KIND = { preflight: "Preflight (read only)", sql: "Prod SQL", config: "Config edit", release: "Library release" };
  const RS_ST = { done: "done", run: "run", fail: "fail", manual: "you" };
  const rsKey = (x) => (x.before ? "before:" + x.before : x.after ? "after:" + x.after : "start");
  const rsOf = (p, key) => (p.releaseSteps || []).filter((x) => rsKey(x) === key);
  const byOrder = (p) => p.masterPrs.slice().sort((a, b) => a.order - b.order);
  function rsLine(x) {
    if (x.kind === "config") return x.config.repo + " " + x.config.branch + ": " + x.config.file + " · adds " + plural(x.config.add.length, "line") + " below " + x.config.under.trim();
    if (x.kind === "release") return "" + NM.release + " waits for the " + x.lib + "-" + x.version + " tag before it merges a PR that needs it; click Create Release Version in " + x.lib + "'s master pipeline when the board asks. Checked again after the run";
    const ok = x.kind === "preflight" ? " · OK when " + (x.checks?.length ? x.checks.map((c) => "query " + c.query + (c.expect === "no_rows" ? " returns no rows" : " shows " + c.column + " = true")).join(", ") : "every query runs") : "";
    return x.database + " · " + (x.file ? x.file.repo + "/" + x.file.path + " at " + String(x.ref || "").slice(0, 8) : "inline SQL") + ok;
  }
  function rsItem(x) {
    const more = x.kind === "config" ? '<pre class="rs-pre">' + esc(x.config.add.join("\n")) + "</pre>" : x.text ? '<details><summary>Show the SQL</summary><pre class="rs-pre">' + esc(x.text) + "</pre></details>" : "";
    return '<li class="rs-' + esc(x.kind) + (x.state === "done" ? " rs-done" : "") + '"><b>' + esc(RS_KIND[x.kind] + ": " + x.title) + "</b>" + (x.state === "done" ? ' <span class="rs-tag">done · skipped</span>' : "") + '<div class="rs-sub">' + esc(rsLine(x)) + "</div>" + more + "</li>";
  }
  const runLine = (p) => { const n = (p?.masterPrs || []).filter((r) => r.state === "open").length; return "Then " + NM.release + " merges these " + plural(n, "PR") + " in dependency order and waits for each deploy"; };
  function rsOrder(p) {
    const prs = byOrder(p), open = prs.filter((r) => r.state === "open"), out = rsOf(p, "start").map(rsItem);
    const before = (p.releaseSteps || []).filter((x) => x.before);
    out.push(...prs.flatMap((r) => before.filter((x) => x.before === r.repo)).map(rsItem), ...before.filter((x) => !prs.some((r) => r.repo === x.before)).map(rsItem));
    if (open.length) out.push('<li class="rs-pr"><b>' + esc(runLine(p)) + '</b><div class="rs-sub">' + esc(open.map((r) => r.repo + " #" + r.id).join(", ")) + ". One " + NM.git + " run; it stops at the first failed merge or deploy.</div></li>");
    for (const r of prs) out.push(...rsOf(p, "after:" + r.repo).map(rsItem));
    (p.releaseSteps || []).filter((x) => x.after && !prs.some((r) => r.repo === x.after)).forEach((x) => out.push(rsItem(x)));
    return out;
  }
  // the user's prod-write rule: two confirms. The first lists every write; the second says plainly that it writes to prod.
  async function releaseMerge(p) {
    const ask = window.prflowKit.askDialog, todo = (p.releaseSteps || []).filter((x) => x.state !== "done"), n = (k) => todo.filter((x) => x.kind === k);
    const ok1 = await ask({ title: "Merge to master and run the prod steps?", body: "<p>One click runs every step below, in this order. A failed check or step stops it there; nothing after it runs.</p><ol class=\"rs-list\">" + rsOrder(p).join("") + "</ol>", yes: "Continue" });
    if (!ok1) return;
    const dbs = [...new Set(n("sql").map((x) => x.database))], open = p.masterPrs.filter((r) => r.state === "open").length;
    const lines = [n("sql").length ? plural(n("sql").length, "SQL script") + " on prod " + dbs.join(", ") : "", ...n("config").map((x) => "A push to " + x.config.repo + " " + x.config.branch + " (" + x.config.file + ")"), open ? runLine(p) + " on prod" : ""].filter(Boolean);
    const ok2 = await ask({ title: "Write to prod?", body: '<div class="ask-flags"><b>This writes to prod.</b><ul>' + lines.map((l) => "<li>" + esc(l) + "</li>").join("") + "</ul></div><p>A wrong script runs on prod from this click. Press Yes only if you read every step.</p>", yes: "Yes, write to prod", danger: true });
    if (ok2) act("/plans/" + p.id + "/merge-master", { prodWrites: true });
  }

  const STG = ["deploy_check", "rebase", "staging_commits", "push", "pr_created", "pr_merged", "deploy_wait"];
  // Each repo's plan branch (every task merges into it) → the branch it goes into next.
  function branchesBox(p) {
    const parts = (p.repos || []).slice().sort((a, b) => a.order - b.order);
    if (!parts.length) return "";
    return '<div class="blk"><h3>Branches</h3>' + parts.map((x) => '<p style="margin:4px 0"><b>' + esc(x.repo) + '</b>: <code>' + esc(x.branch) + '</code> → <code>' + esc(x.base) + "</code></p>").join("") + "</div>";
  }
  function progressTab(p) {
    const list = evs(p.id), ev = (n, f) => lastEv(list, (e) => e.event === n && (!f || f(e)));
    const ks = tasksOf(p), s = p.steps, k = kindOf(p), n = ks.length, rows = [], past = !!(s.staging || s.uat || s.master);
    const R = (st, name, sub, at, extra) => rows.push({ st, name, sub: sub || "", at: at || 0, extra: extra || "" });
    const v = p.versions?.length || 1, planning = s.plan === "run";
    if (planning) R(...planningRow(p, p.versions?.[v - 1]?.at || p.pastedAt));
    else if (s.plan === "fail") R("fail", "Planning stopped", "Replace the text, or press Retry", p.nowAt);
    else R("done", "Planned", plural(n, "task") + (v > 1 ? " · version " + v : ""), p.versions?.[v - 1]?.at || p.pastedAt);
    R(s.plan === "you" ? "you" : p.started ? "done" : "wait", s.plan === "you" ? "Waiting for you" : "You pressed Start", s.plan === "you" ? "Press Start when the plan looks right" : "", p.startedAt || ev("started")?.at);
    const allDone = n > 0 && ks.every((t) => t.status === "done");
    if (k === "big") {
      for (let w = 1; w <= waveCount(p); w++) {
        const ids = ks.filter((t) => t.wave === w); if (!ids.length) continue;
        const done = !!p.gates[w] || past, d = ids.filter((t) => t.status === "done").length, run = !done && p.started && (w === 1 || p.gates[w - 1]);
        const st = done ? "done" : ids.some((t) => t.status === "failed") ? "fail" : run ? "run" : "wait";
        const finalOnly = S.config?.buildEachTask === false, lastW = w === Math.max(...ks.map((t) => t.wave)); // no build per wave: only the last wave builds
        R(st, "Wave " + w + ": " + esc(ids.map((t) => t.label).join(", ")), done ? (finalOnly && !lastW ? "Done · no build here: each repo builds once, after the last wave" : finalOnly ? "Final build and every test green" : "Gate passed: full build and every test green") : run ? (p.gating?.wave === w ? "Gate: full build and all tests of " + p.gating.repo + ", with every task's change together (" + p.gating.i + " of " + p.gating.n + ")" : d + "/" + ids.length + " tasks done" + (d === ids.length ? " · the gate starts next" : "")) : "Waits for the wave before it", ev("gate", (e) => e.wave === w)?.at);
      }
      // Running only while the plan says so; done from the plan's own record, since its event can scroll out of the recent list.
      const ar = ev("architect_plan_review"), arNow = String(p.now || "").startsWith("architect-reviewer"), arDone = !!(ar || p.archReview || p._x?.architect);
      R(arNow ? "run" : arDone || past ? "done" : "wait", "architect-reviewer reads the whole branch", arNow ? "Reading the whole plan diff" : ar ? ar.text : arDone ? "Reviewed the whole plan diff" : "", (ar || ev("claude_run_start"))?.at);
      // The last review of the open minor findings runs inside the merge step, before any repo merges.
      const msStart = ev("claude_run_start", (e) => /minor findings/.test(e.text || "")), ms = ev("minor_sweep"), msRun = !!msStart && (!ms || ms.at < msStart.at) && s.staging === "run";
      if (msRun || ms) R(msRun ? "run" : "done", "code-reviewer: last review of the minor findings", msRun ? msStart.text : ms.text, (msRun ? msStart : ms).at);
    } else {
      const fail = ks.some((t) => t.status === "failed"), run = !allDone && ks.filter((t) => t.status === "working" || t.status === "review");
      R(allDone || past ? "done" : fail ? "fail" : p.started ? "run" : "wait", k === "list" && n > 1 ? "Fix: " + plural(n, "task") + " in parallel" : "Fix: one task", allDone || past ? "Done, built and reviewed" : p.started ? (run.length ? run : ks).map((t) => t.label + ": " + t.sub).join("\n") : "");
    }
    const parts = p.repos.slice().sort((a, b) => a.order - b.order), prOf = (r) => p.stagingPrs.filter((x) => x.repo === r).pop(); // the newest PR: a retry declines and replaces older ones
    const stage = (part) => lastEv(list, (e) => e.repo === part.repo && !e.task && STG.includes(e.event) && !(e.event === "pr_created" && e.dest && e.dest !== part.base));
    const sdone = parts.map((part) => { const dep = lastEv(list, (e) => e.event === "deploy_wait" && e.repo === part.repo); return dep?.ok === true || !!part.staged || s.staging === "done" || !!s.uat || !!s.master; });
    const first = sdone.indexOf(false);
    // While the last minor-findings review runs, no repo merges yet: show the first repo as waiting, not running.
    const sweepRun = (() => { const a = ev("claude_run_start", (e) => /minor findings/.test(e.text || "")), b = ev("minor_sweep"); return !!a && (!b || b.at < a.at) && s.staging === "run"; })();
    const viaRel = !p.targetBranch && parts.length > 0, curRel = parts.findIndex((x) => (p.now || "").startsWith(x.repo + " (")); // staging merges through the release pipeline (when the host sets stagingRunner)
    if (!parts.length) R(SM[s.staging] || "wait", "Staging", "");
    parts.forEach((part, i) => {
      const pr = prOf(part.repo), e = stage(part), dep = lastEv(list, (x) => x.event === "deploy_wait" && x.repo === part.repo);
      const failAt = s.staging === "fail" && p.error ? parts.findIndex((x) => p.error.includes(" in " + x.repo + " ")) : -1;
      const st = sdone[i] ? "done" : (failAt >= 0 ? i === failAt : i === first) && (dep?.ok === false || s.staging === "fail") ? "fail" : i === first && s.staging === "run" && !sweepRun ? "run" : "wait";
      const text = st === "wait" ? (i === first && sweepRun ? "Waits for the last review of the minor findings" : "Opens when its turn comes") : (sdone[i] && dep ? dep.text : e?.text || (sdone[i] ? "Merged and deployed to UAT" : "Starting")) + (st === "run" && e?.event === "pr_merged" ? " · deploying to UAT" : "");
      if (viaRel && !sdone[i]) { // the release pipeline mode: PRs are made one by one, then one run merges them all
        const ready = pr && pr.state === "open" && !pr.run && (curRel < 0 || i < curRel), now_ = i === curRel, rn = p.stagingRelease?.run ? "release run #" + p.stagingRelease.run : "the release run";
        const inRun = pr && (pr.run === "merging" || pr.run === "deploying" || pr.state === "merged"); // the release run has it now
        const vst = (pr?.run === "failed" || (s.staging === "fail" && (failAt >= 0 ? i === failAt : now_))) ? "fail" : inRun ? "run" : ready ? "done" : now_ && s.staging === "run" ? "run" : "wait";
        const vtx = vst === "fail" ? p.error || "Stopped" : inRun ? (pr.state === "merged" ? "PR #" + pr.id + " merged by " + rn + " · deploying to UAT" : "PR #" + pr.id + " being merged by " + rn) : ready ? "PR #" + pr.id + " open · waits for the " + NM.release + " run" : now_ ? (p.now || "").replace(/^[\w.-]+ \(\d+ of \d+\):\s*/, "") : "PR is made when its turn comes; " + NM.release + " merges it";
        return R(vst, "Staging PR · " + esc(part.repo), vtx, e?.at, prLink(pr));
      }
      R(st, (viaRel ? "Staging PR · " : "Staging · ") + esc(part.repo), viaRel && st === "wait" && text === "Opens when its turn comes" ? "PR is made when its turn comes; " + NM.release + " merges it" : text, e?.at, prLink(pr));
    });
    // Staging PRs of a staging plan merge in one the release pipeline run (TARGET=staging), like the master merge.
    if (viaRel) {
      const sr = p.stagingRelease, sf = sr?.failed, srLink = sr?.url ? '<a class="cf-link" href="' + safeUrl(sr.url) + '" target="_blank" rel="noopener">Run #' + esc(sr.run) + " in " + NM.git + " ↗</a>" : "";
      const srSt = !sr ? (s.staging === "done" || s.uat || s.master ? "done" : "wait") : sr.state === "done" ? "done" : sr.state === "fail" ? "fail" : "run";
      const srSub = !sr ? "One run merges every staging PR above, in dependency order, and waits for each deploy to UAT"
        : sr.state === "fail" ? (sf?.repo ? "Failed at " + sf.repo + (sf.step ? ", step '" + sf.step + "'" : "") + "\n" : "Stopped\n") + (sf?.reason || sr.result || "")
        : sr.state === "done" ? "Every staging PR merged and deployed" : (sr.state === "starting" ? "Starting" : "Running") + " · " + plural((sr.prs || []).length, "PR");
      R(srSt, sr?.run ? "Staging release run #" + esc(sr.run) + " (" + NM.release + ")" : "Staging release run (" + NM.release + ")", srSub, sr?.startedAt, srLink);
    }
    const checks = p.uat?.checks?.length ? '<ul class="cf-res">' + p.uat.checks.map((u) => '<li class="' + (u.ok === false ? "bad" : "") + '">' + (u.ok === true ? "✓" : u.ok === false ? "✗" : "○") + " " + esc(u.what) + (u.detail ? " · " + esc(u.detail) : "") + "</li>").join("") + "</ul>" : "";
    const sb = ev("send_back", (e) => e.source === "uat"), tries = p.uat?.tries || 0;
    R(SM[s.uat] || "wait", "Test on UAT (real API, " + NM.testUser + ")", s.uat === "fail" ? "A check failed; sent back to its task" + (sb ? "\n" + sb.text : "") : s.uat === "run" ? (ev("uat_start")?.text || "Running the checks") + " · step " + ((p.uatStep ?? 0) + 1) + " of 3" : s.uat === "done" ? "Every check passed" + (tries > 1 ? " · try " + tries : "") : "", (ev("uat_result") || ev("uat_start"))?.at, s.uat === "run" ? uatLive(p) : checks);
    const mp = p.masterPrs.slice().sort((a, b) => a.order - b.order), mcre = (r) => ev("pr_created", (e) => e.repo === r.repo && e.id === r.id)?.at;
    // The master PRs are being made (and any drift ported) between the passed test and "you".
    const making = s.uat === "done" && (s.master === "" || s.master === "run") && !p.error;
    if (!mp.length) R(s.master === "fail" ? "fail" : making ? "run" : "wait", "Master PR", making ? p.now || "Making the master PRs" : s.master === "fail" ? p.error || "Stopped" : "Opens after the UAT test passes");
    mp.forEach((r) => R("done", "Master PR · " + esc(r.repo), "#" + r.id + " " + r.state + (r.why ? " · " + r.why : ""), mcre(r), prLink(r)));
    // Repos whose master PR is not made yet: the one being made now, then the ones waiting (ports have many).
    if (mp.length && (making || s.master === "fail")) { const cur = (/^([\w.-]+):/.exec(p.now || "") || [])[1];
      (p.repos || []).slice().sort((a, b) => a.order - b.order).filter((x) => !mp.some((r) => r.repo === x.repo)).forEach((x) =>
        R(x.repo === cur ? (s.master === "fail" ? "fail" : "run") : "wait", "Master PR · " + esc(x.repo), x.repo === cur ? (s.master === "fail" ? p.error || "Stopped" : (p.now || "").replace(/^[\w.-]+:\s*/, "")) : "Waits for the repos before it")); }
    const clicked = ev("merge_master_clicked"), nm = mp.filter((r) => r.state === "merged").length, rel = p.release;
    const mg = merging(p), left = openMaster(p); // pressed once: no second click while it runs
    const mergeAll = s.master === "you" ? '<div class="cbtn" style="margin-top:8px">' + (mg ? '<button class="sm" disabled>Merging… ' + nm + "/" + mp.length + " merged</button>" : btn(nm ? "Merge the " + plural(left, "open master PR") : "Merge all " + plural(mp.length, "master PR"), "sm gold", "merge", 'data-id="' + esc(p.id) + '" data-n="' + left + '" data-key="/plans/' + esc(p.id) + '/merge-master"')) + "</div>" : "";
    R(s.master === "you" ? "you" : s.master === "done" || s.master === "run" || clicked ? "done" : "wait", "Your merge", s.master === "you" ? (mg ? "You pressed Merge · " + nm + "/" + mp.length + " merged" : "Waiting for you: one click runs the prod steps, then " + NM.release + " merges every master PR in dependency order and waits for each deploy") : s.master === "done" || clicked ? nm + "/" + mp.length + " merged by you" : "", clicked?.at, mergeAll);
    const rsRow = (x) => R(RS_ST[x.state] || "wait", esc(RS_KIND[x.kind] + " · " + x.title), x.state === "fail" || x.state === "manual" ? x.error || "" : x.result || rsLine(x), x.at);
    rsOf(p, "start").forEach(rsRow);
    (p.releaseSteps || []).filter((x) => x.before).sort((a, b) => mp.findIndex((r) => r.repo === a.before) - mp.findIndex((r) => r.repo === b.before)).forEach(rsRow);
    // The the release pipeline run (ADR-0011): one row with its the git host link, then one row per PR from the runner's log.
    const runLink = rel?.url ? '<a class="cf-link" href="' + safeUrl(rel.url) + '" target="_blank" rel="noopener">Run #' + esc(rel.run) + " in " + NM.git + " ↗</a>" : "";
    const f = rel?.failed, relSt = !rel ? "wait" : rel.state === "done" || s.master === "done" ? "done" : rel.state === "fail" ? "fail" : rel.waitTag ? "you" : "run";
    const relSub = !rel ? "Merges the open PRs in dependency order: libraries first, the gateway next to last, the front end last" : rel.state === "fail" ? (f?.repo ? "Failed at " + f.repo + (f.step ? ", step '" + f.step + "'" : "") + "\n" : "Stopped\n") + (f?.reason || rel.result || "")
      : rel.state === "done" ? "Every PR merged and deployed" + (rel.runs?.length > 1 ? " · carried on in runs " + rel.runs.map((x) => "#" + x.run).join(", ") : "")
        : rel.waitTag ? "Waiting for tag " + rel.waitTag.tag + ": click Create Release Version in " + rel.waitTag.repo + "'s master pipeline (it waits up to 25 minutes)" : (rel.state === "starting" ? "Starting" : "Running") + " · " + plural(rel.prs.length, "PR") + (rel.runs?.length > 1 ? " · hand-off to run #" + rel.run : "");
    R(relSt, rel?.run ? "Release run #" + esc(rel.run) : "Release run (" + NM.release + ")", relSub, rel?.startedAt, runLink);
    const pipeLink = (r) => (r.pipeline ? '<a class="cf-link" href="' + safeUrl(r.pipeline) + '" target="_blank" rel="noopener">Pipeline ↗</a>' : "");
    mp.forEach((r) => {
      const e = lastEv(list, (x) => x.repo === r.repo && ["master_merged", "master_deploy", "master_deploy_manual"].includes(x.event));
      const done = r.deployed || s.master === "done", st = done ? "done" : r.run === "failed" ? "fail" : r.run === "tag" ? "you" : r.run === "deploying" ? "dep" : r.run === "merging" ? "run" : "wait";
      const sub = done ? (r.byHand ? "Merged · " + r.byHand : "Merged and deployed") : r.run === "failed" ? (f?.repo === r.repo ? (f.step ? "Step '" + f.step + "' failed: " : "") + f.reason : r.state === "merged" ? "Merged; its prod pipeline did not pass" : "Not merged")
        : r.run === "tag" ? "Merged and deployed · waiting for tag " + r.tag + ": click Create Release Version in " + r.repo + "'s master pipeline" : r.run === "deploying" ? "Merged · waiting for its master pipeline" : r.run === "merging" ? "Merging" : rel?.state === "running" && r.state === "open" ? "Waits for its turn in the run" : r.state === "merged" ? "Merged" : "";
      R(st, "Prod deploy · " + esc(r.repo) + " #" + esc(r.id), sub, e?.at, pipeLink(r));
    });
    mp.forEach((r) => rsOf(p, "after:" + r.repo).forEach(rsRow));
    (p.releaseSteps || []).filter((x) => x.after && !mp.some((r) => r.repo === x.after)).forEach(rsRow);
    R(s.master === "done" ? "done" : "wait", "Live", s.master === "done" ? (p.liveVia ? "Already live through " + p.liveVia + ": its merge carried this change" : "Live on prod") : "", p.liveAt);
    if (k === "port") { // no tasks, staging PRs or UAT test: one row says what is taken to master
      const keep = rows.filter((r) => !/^(Planned|You pressed Start|Waiting for you|Wave |Fix|architect-reviewer|Staging|Test on UAT)/.test(r.name));
      rows.splice(0, rows.length, { st: "done", name: "Already merged and tested on staging", sub: p.repos.slice().sort((a, b) => a.order - b.order).map((r) => r.repo + ": " + plural(r.stagingCommits.length, "commit")).join(" · "), at: p.pastedAt, extra: "" }, ...keep);
    }
    if (p.targetBranch) { // a target plan ends at the merge into its branch
      const end = rows.findIndex((r) => r.name.startsWith("Test on UAT"));
      rows.forEach((r) => { if (r.name.startsWith("Staging · ")) { r.name = "Into " + esc(p.targetBranch) + " · " + r.name.slice(10); if (r.sub === "Merged and deployed to UAT") r.sub = "Merged into " + p.targetBranch; } });
      rows.splice(end, rows.length - end, { st: p.landedAt ? "done" : "wait", name: "Done in " + esc(p.targetBranch), sub: "Targets " + p.targetBranch + ", not staging: no staging deploy, UAT test or master PR. Promote " + p.targetBranch + " to staging when the feature is ready.", at: p.landedAt || 0, extra: "" });
    }
    const relFail = p.release?.state === "fail" && /^(Release run #|[\w.-]+ did not start)/.test(p.error || ""); // the run rows already say where and why
    if (p.error && !relFail) { const i = [rows.findIndex((r) => r.st === "fail"), rows.findIndex((r) => r.st === "run"), rows.findIndex((r) => r.st === "you"), rows.findIndex((r) => r.st !== "done")].find((x) => x >= 0); if (i >= 0) { rows[i].st = "fail"; rows[i].sub = p.error; } }
    return gapsHtml(p) + '<div class="blk"><ul class="cf-track">' + rows.map((r) => cfRow(r.st, r.name, r.sub, r.at, r.extra)).join("") + "</ul></div>";
  }
  const SENT = { uat: "sent back by the UAT test · executor fixed it · reviewed again", gate: "sent back by the wave gate · executor fixed it · reviewed again", architect: "sent back by the architect review · executor fixed it · reviewed again", edit: "sent back by your edit · executor fixed it · reviewed again" };
  function loopTab(t) {
    if (!t.rounds.length) return '<div class="blk"><p class="legend">No review yet. code-reviewer (Opus) reviews once executor (Sonnet) has written the code.</p></div>';
    const fl = (f) => findingLi(f);
    return '<div class="blk"><div class="loop">' + t.rounds.map((r, n) => {
      const bad = r.blocking.length > 0;
      return (n ? '<div class="back-arrow">↑ ' + (r.source === "review" ? "executor (Sonnet) fixed it · reviewed again" : SENT[r.source] || "fixed · reviewed again") + "</div>" : "") +
        '<div class="round"><span class="v ' + (bad ? "bad" : "ok") + '">' + (bad ? "Blocking" : "Clean") + "</span><b>Round " + r.n + '</b><span class="who">' + esc((r.by || []).join(" + ") || "code-reviewer") + " · " + esc(clock(r.at)) + "</span>" +
        (bad ? findingsList(r, S.blocking?.[t.id]?.[n]) : "<div>No blocking findings.</div>") +
        (r.minor.length ? '<div style="margin-top:6px;color:var(--dim)">' + plural(r.minor.length, "minor finding") + ", not looped:</div><ul>" + r.minor.map(fl).join("") + "</ul>" : "") +
        "</div>";
    }).join("") + '</div><p class="legend"><b>Loops only on blocking findings:</b> a security hole, a wrong result, lost or wrong data, a crash, a broken build, or code that will clearly cause bugs. Style, naming, docs, test coverage and small clean-ups never loop; they are listed on the PR. Up to 5 rounds. The same finding twice in a row stops the task and tells you why.</p></div>';
  }
  function prRow(r, k, mode) {
    const tag = mode === "master" ? '<a class="tag ' + (r.state === "merged" ? "ok" : "") + '" href="' + safeUrl(r.url) + '" target="_blank" rel="noopener" title="Open the PR in ' + NM.git + '">' + (r.state === "merged" ? "✓ live" : r.state === "declined" ? "declined" : "open ↗") + "</a>" : "<span></span>";
    const sm = mode === "master" ? r.why || "" : r.state === "merged" ? "Merged · deployed to UAT" : r.state === "declined" ? "Declined" : "Open";
    return '<div class="pr"><span class="n">' + (k + 1) + '</span><div><a href="' + safeUrl(r.url) + '" target="_blank" rel="noopener">' + esc(r.repo) + " #" + r.id + "</a><small>" + esc(sm) + "</small></div>" + tag + "</div>";
  }
  function planDetail(d, p) {
    const k = kindOf(p), list = k === "list", big = k === "big", ks = tasksOf(p), s = p.steps;
    const port = k === "port";
    const tabs = port ? [["progress", "Progress"], ["plan", "Port"], ["prs", "PRs"]] : [["progress", "Progress"], ["plan", list ? "List" : big ? "Plan" : "Bug"], ["tasks", list ? "Sorted" : big ? "Tasks" : "Size"], ["uat", "UAT test"], ["prs", "PRs"]];
    const portBox = port ? '<div class="blk"><h3>Commits taken to master</h3><ul>' + p.repos.slice().sort((a, b) => a.order - b.order).map((r) => "<li><b>" + esc(r.repo) + "</b> · " + plural(r.stagingCommits.length, "commit") + (r.why ? " · " + esc(r.why) : "") + "<pre>" + esc(r.stagingCommits.map((c) => c.slice(0, 10)).join("\n")) + "</pre></li>").join("") + "</ul></div>" : "";
    if (!tabs.some((x) => x[0] === dtab)) dtab = "progress";
    const sizeBox = '<div class="sizebox"><span class="rl">HOW CLAUDE SIZED IT</span>' + (p.sizeWhy ? "<div>" + esc(p.sizeWhy) + "</div>" : "<div>Still reading it.</div>") + '<div class="legend" style="margin:0">One task when the change is in one repo, a few files, and no part waits for another. Split when it spans repos or has parts that depend on each other. A bug list: bugs with the same cause in the same files go in one task; a bug that is not real is left out with the reason.</div></div>';
    const vs = p.versions || [], v = vs[vs.length - 1];
    const waits = ks.filter((t) => t.waitsOn?.length).map((t) => esc(t.label) + " waits for " + esc(t.waitsOn.map((x) => String(x).replace("/", " ")).join(", ")) + " (same files).");
    const body = {
      progress: termBox(p) + wdBox(p.watchdog, p.id) + branchesBox(p) + progressTab(p),
      plan: (port ? portBox : '<div class="blk">' + sizeBox + "</div>") + '<div class="blk"><h3>' + (port ? "Why these go to master" : "What you pasted") + (vs.length > 1 ? " · version " + v.n + " (edited " + esc(ist(v.at)) + ")" : "") + '</h3><div class="md">' + esc(p.text) + "</div>" +
        vs.slice(0, -1).reverse().map((x) => '<details class="oldv"><summary>Version ' + x.n + " · " + esc(ist(x.at)) + '</summary><div class="md" style="margin-top:6px">' + esc(x.text) + "</div></details>").join("") + "</div>" +
        (p.contract ? '<div class="blk"><h3>Frozen contract</h3><p class="legend" style="margin:0">Every task uses these fields as written. Only the lead run may change them, and it tells you.</p><div class="files" style="margin-top:8px">' + esc(p.contract) + "</div></div>" : "") +
        (p.acceptance?.length ? '<div class="blk"><h3>Acceptance</h3><ul class="plain">' + p.acceptance.map((a) => "<li>" + esc(a) + "</li>").join("") + "</ul></div>" : "") +
        (waits.length ? '<div class="blk"><h3>Next to other work</h3><p class="legend" style="margin:0">' + waits.join(" ") + " Staging merges in one repo take turns.</p></div>" : ""),
      tasks: '<div class="blk">' + sizeBox + '</div><div class="blk"><h3>' + (list ? "Each bug and its task" : big ? "How " + AI + " split it" : "The one task") + "</h3>" + (!ks.length ? '<p class="legend">Still sizing.</p>' : list ? triageHtml(p) : big ? wavesHtml(p) + '<p class="legend">Same wave: no shared files, so they run in parallel. A later wave starts only when the gate passes: full build and every test green on the plan branch.</p>' : chip(ks[0], ks[0].title)) + "</div>",
      uat: '<div class="blk"><h3>Staging test on UAT (real API, ' + NM.testUser + ')</h3>' + (p.uat?.checks?.length ? '<ul class="checks">' + p.uat.checks.map((u) => '<li class="' + (u.ok === true ? "ok" : u.ok === false ? "bad" : "") + '">' + esc(u.what) + (u.detail ? " · " + esc(u.detail) : "") + "</li>").join("") + "</ul>" + (p.uat.proof ? '<div class="files" style="margin-top:8px">' + esc(p.uat.proof) + "</div>" : "") : '<p class="legend">Runs after ' + (p.repos.length > 1 ? "all " + p.repos.length + " staging PRs are" : "the staging PR is") + " merged and deployed to UAT.</p>") +
        '<p class="legend">Two kinds of test: each task\'s own tests run in the build first. This one runs after the deploy and calls the real UAT API. ' + (list ? "One check per fixed bug, repeating its steps." : big ? "Checks come from the plan's Acceptance list." : "Checks repeat the steps from the bug.") + ' A failed check goes back to the task that owns it, then the test runs again.</p><p class="legend"><b>Each scenario once:</b> the main path, plus each variant that can go differently (an edge value, a refusal, a second store, a repeat). No two checks prove the same thing. Data is checked in the staging database before and after.</p></div>',
      prs: '<div class="blk"><h3>Staging PR' + (p.stagingPrs.length > 1 ? "s" : "") + "</h3>" + (p.stagingPrs.length ? '<div class="prlist">' + p.stagingPrs.slice().sort((a, b) => a.order - b.order).map((r, i) => prRow(r, i, "staging")).join("") + "</div>" : '<p class="legend">Opens when ' + (big ? "all tasks are" : "the fix is") + " done.</p>") + "</div>" +
        '<div class="blk"><h3>Master PR' + (p.masterPrs.length > 1 ? "s: merge in this order" : "") + "</h3>" + (p.masterPrs.length ? '<div class="prlist">' + p.masterPrs.slice().sort((a, b) => a.order - b.order).map((r, i) => prRow(r, i, "master")).join("") + "</div>" : '<p class="legend">Opened after the UAT test passes. The same commits, cherry-picked onto master.</p>') + "</div>",
    }[dtab];
    const badge = wdOn(p) ? ["dog", p.watchdog.state === "fixed" ? "Watchdog fixed it" : "Watchdog fixing"] : p.error ? ["bad", "Needs attention"] : s.master === "you" ? ["approve", "Your merge"] : s.master === "done" ? ["done", "Live"] : p.landedAt ? ["done", "In " + esc(p.targetBranch)] : s.plan === "you" ? ["approve", "Planned"] : ["diagnosing", "Running"];
    const nrepo = Math.max(p.repos.length, 1);
    const meta = port ? plural(p.repos.reduce((a, r) => a + r.stagingCommits.length, 0), "commit") + " · " + plural(nrepo, "repo") : p.kind && ks.length ? (list ? (p.triage?.length || 0) + " bugs · " + plural(ks.length, "task") + " · " + plural(nrepo, "repo") : big ? plural(ks.length, "task") + " · " + plural(waveCount(p), "wave") + " · " + plural(nrepo, "repo") : "1 task · 1 repo") : "Sizing";
    const nm = openMaster(p);
    d.innerHTML = '<div class="d-head"><div class="d-top"><div><h2>' + ptag(p) + " " + esc(p.title) + '</h2><div class="d-meta"><span>' + esc(meta) + "</span><span>Pasted " + esc(ist(p.pastedAt)) + '</span><button class="tkt" data-a="ticket" data-id="' + esc(p.id) + '" title="Goes at the start of every PR title">' + (p.ticket ? "Ticket " + esc(p.ticket) : "Add ticket number") + "</button>" + (port || p.kind === "promote" ? "" : '<button class="tkt" data-a="target" data-id="' + esc(p.id) + '" title="' + (p.started ? "Set before Start only" : "Merge into a long-lived branch instead of staging") + '">' + (p.targetBranch ? "Target " + esc(p.targetBranch) : "Goes to staging") + "</button>") + "</div>" + prLinks(p, null) + '</div><span class="badge ' + badge[0] + '">' + badge[1] + "</span>" + btn("Close", "bare", "close") + "</div>" +
      '<div class="tabs" role="tablist">' + tabs.map(([x, n]) => '<button role="tab" class="' + (dtab === x ? "on" : "") + '" data-a="tab" data-id="' + x + '">' + n + "</button>").join("") + "</div></div>" +
      '<div class="d-body">' + body + "</div>" +
      (dtab === "prs" && s.master === "you" ? '<div class="d-foot"><span class="fmsg">' + "" + NM.release + " merges in dependency order and waits for each deploy." + "</span>" + (merging(p) ? '<button disabled>Merging…' + (p.release?.run ? " run #" + p.release.run + " ·" : "") + " " + p.masterPrs.filter((r) => r.state === "merged").length + "/" + p.masterPrs.length + " merged</button>" : btn("Merge master PR" + (p.masterPrs.length > 1 ? "s in order" : ""), "gold", "merge", 'data-id="' + esc(p.id) + '" data-n="' + nm + '" data-key="/plans/' + esc(p.id) + '/merge-master"')) + "</div>" : "");
  }

  // ---------- dialog ----------
  function dialog(pid) {
    editing = pid; const p = pid ? planById(pid) : null, dlg = $("#planDlg");
    $("#dlgTitle").textContent = p ? "Edit " + p.id + " and plan again" : "Paste a plan or a bug";
    $("#planYes").textContent = p ? "Plan again" : "Plan it";
    $("#dlgLead").style.display = $("#asIs").style.display = p ? "none" : "";
    const n = $("#editNote"); n.style.display = p ? "" : "none";
    n.innerHTML = !p ? "" : p.started ? "<b>Already started.</b> Tasks that are done or running stay as they are. " + AI + " plans the rest again and shows what changed. The changed tasks wait until you press Start again." : "<b>Nothing has run yet,</b> so " + AI + " plans every task again and shows what changed. Nothing runs until you press Start.";
    $("#planTxt").value = p ? p.text : ""; $("#dlgErr").hidden = true;
    if (!dlg.open) dlg.showModal(); $("#planTxt").focus();
  }
  async function submitDialog() {
    const text = $("#planTxt").value.trim(), err = $("#dlgErr");
    if (!text) { err.textContent = "Paste something first."; err.hidden = false; return; }
    const path = editing ? "/plans/" + editing + "/edit" : "/plans", yes = $("#planYes");
    yes.dataset.key = path; err.hidden = true;
    const j = await post(path, editing ? { text, replace: true } : { text });
    if (!j || j.error) { err.textContent = j?.error || "Could not send."; err.hidden = false; return; }
    $("#planDlg").close(); if (!editing) $("#planTxt").value = "";
  }

  // ---------- events ----------
  document.addEventListener("click", (e) => {
    if (e.target.closest("a")) return;
    const el = e.target.closest("[data-a]"); if (!el) return;
    const a = el.dataset.a, id = el.dataset.id;
    if (a === "pick") { const pid = el.dataset.id2 || id; sel = sel === pid ? "all" : pid; ddOpen = false; saveHash(); render(); }
    else if (a === "changes-x") { changesHidden.add(id + "#" + el.dataset.n); try { localStorage.setItem("prflow.changesHidden", JSON.stringify([...changesHidden].slice(-50))); } catch (e) { /* no storage */ } render(); }
    else if (a === "minors-fold") { minorsOpen = !minorsOpen; try { localStorage.setItem("prflow.minorsOpen", minorsOpen ? "1" : "0"); } catch (e) { /* no storage */ } render(); }
    else if (a === "plist-fold") { liveOpen = !liveOpen; try { localStorage.setItem("prflow.liveOpen", liveOpen ? "1" : "0"); } catch (e) { /* no storage */ } render(); }
    else if (a === "plist-dd") { ddOpen = !ddOpen; render(); }
    else if (a === "task") { open = id; dtab = "steps"; renderDetail(); render(); pollEvents(); }
    else if (a === "plan") { openPlan(id, el.dataset.tab || "progress"); pollEvents(); }
    else if (a === "close") closeDetail();
    else if (a === "tab") { dtab = id; renderDetail(); $("#detail").querySelector('[data-a="tab"][data-id="' + id + '"]')?.focus(); }
    else if (a === "edit") dialog(id);
    else if (a === "paste") dialog(null);
    else if (a === "start") act("/plans/" + id + "/start");
    else if (a === "stop") act("/plans/" + id + "/stop");
    else if (a === "delete") { const pl = planById(id); window.prflowKit.askDialog({ title: "Delete " + id + "?", body: "<p>" + esc(pl?.title || "") + "</p><p>It leaves this board only. Nothing stops: the plan, its worktrees, its branches and PRs, and its terminal session all stay.</p>", yes: "Remove " + id }).then((ok) => { if (ok) act("/plans/" + id + "/delete").then((j) => { if (j) { toast(id + " deleted"); if (sel === id) { sel = "all"; saveHash(); } render(); } }); }); }
    else if (a === "keep") { const tk = S.tasks[id]; window.prflowKit.askDialog({ title: "Keep " + tk.label + "'s merged code?", body: "<p>" + esc(tk.label) + " is marked done with the code already in the plan branch. This failed attempt is dropped.</p>", yes: "Keep merged code" }).then((ok) => { if (ok) act("/plans/" + tk.planId + "/keep", { task: id }); }); }
    else if (a === "ticket") { const v = window.prompt("Ticket number for this plan's PR titles (for example BOM-10046). Leave empty to remove.", planById(id)?.ticket || ""); if (v !== null) act("/plans/" + id + "/ticket", { ticket: v }); }
    else if (a === "target") {
      const pl = planById(id);
      if (pl?.started) toast("This plan has started on " + (pl.targetBranch || "staging") + ". Make a new plan for another branch.");
      else { const v = window.prompt("Branch this plan builds on and merges into instead of staging (for example feat/payments). Leave empty to go to staging.", pl?.targetBranch || ""); if (v !== null) act("/plans/" + id + "/target", { branch: v.trim() }); }
    }
    else if (a === "minor") act("/plans/" + id + "/minor", { key: el.dataset.n, choice: el.dataset.c }).then((j) => { if (j) toast(el.dataset.c === "send" ? "Sent back to its writer" : "Accepted"); });
    else if (a === "promote") {
      const pl = planById(id), go = () => act("/plans/promote", { branch: pl?.targetBranch }).then((j) => { if (j?.id) { sel = j.id; saveHash(); render(); } });
      if (minorsLine(pl)) window.prflowKit.askDialog({ title: "Promote " + pl.targetBranch + " to staging?", body: minorsLine(pl), yes: "Promote anyway" }).then((ok) => { if (ok) go(); }); else go();
    }
    else if (a === "retry") act("/plans/" + id + "/retry");
    else if (a === "fix") act("/plans/" + id + "/fix-anyway", { n: Number(el.dataset.n) }).then((j) => { if (j) { asked.add(id + "#" + el.dataset.n); render(); } });
    else if (a === "merge" && planById(id)?.releaseSteps?.some((x) => x.state !== "done")) releaseMerge(planById(id));
    else if (a === "merge") {
      const pl = planById(id), n = Number(el.dataset.n) || 1;
      const order = (pl?.masterPrs || []).slice().sort((x, y) => x.order - y.order).filter((r) => r.state !== "merged").map((r) => "<li>" + esc(r.repo) + " #" + esc(r.id) + "</li>").join("");
      const db = (pl?.dbChanges?.length && window.prflowHost?.dbRows?.(pl.dbChanges)) || (pl?.dbChanges || []).map((x) => "<li><b>" + esc(x.database) + "</b><pre>" + esc(x.sql) + "</pre></li>").join("");
      const gaps = (pl?.prodGaps || []).map((x) => "<li><b>" + esc(x.task) + " · " + esc(x.repo) + "</b>: " + esc(x.what) + "</li>").join("");
      window.prflowKit.askDialog({ title: "Merge to master and deploy?", body: "<p>" + esc(runLine(pl).replace(/^Then e/, "E")) + ":</p><ol>" + order + "</ol>" + (db ? '<p><b>Run these database changes on prod first.</b> The new code fails without them:</p><ul>' + db + "</ul>" : "") + minorsLine(pl) + (gaps ? '<p><b>Not on prod master yet.</b> The plan relies on this UAT-branch code; release it first or the change may not work on prod:</p><ul>' + gaps + "</ul>" : ""), yes: "Merge and deploy", danger: true }).then((ok) => { if (ok) act("/plans/" + id + "/merge-master"); });
      window.prflowHost?.wireDb?.(id, document.querySelector("#askYes")); // the host checks each change on prod and can run it
    }
    else if (a === "nav") document.querySelector('.col[data-c="' + id + '"]')?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    else if (a === "board") location.href = HOME;
    else if (a === "findings") { fdView.plan = sel && sel !== "all" && S.plans.some((x) => x.id === sel) ? sel : "all"; $("#fdDlg").showModal(); loadFindings(); } // opens on the plan you are looking at
    else if (a === "fd-close") $("#fdDlg").close();
    else if (a === "fd-filter") { fdView[el.dataset.k] = el.dataset.v; renderFindings(); }
    else if (a === "watchdog") { $("#wdBody").innerHTML = wdTable(WD); $("#wdDlg").showModal(); pollWatchdog(true); }
    else if (a === "wd-close") $("#wdDlg").close();
    else if (a === "wd-dismiss") act("/watchdog/dismiss", { key: id });
  });
  document.addEventListener("toggle", (e) => { const g = e.target?.dataset?.g; if (g) { if (e.target.open) minorGroupsOpen.add(g); else minorGroupsOpen.delete(g); } }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && open && !$("#planDlg").open) closeDetail();
    if ((e.key === "Enter" || e.key === " ") && e.target.matches('.card[data-a], .chip[data-a]')) { e.preventDefault(); e.target.click(); }
  });
  $("#planTxt").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submitDialog(); } });
  $("#planTxt").addEventListener("dragover", (e) => e.preventDefault());
  $("#planTxt").addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (!f) return; e.preventDefault(); f.text().then((t) => { $("#planTxt").value = t; }); });
  $("#planNo").addEventListener("click", () => $("#planDlg").close());
  $("#planYes").addEventListener("click", submitDialog);

  (function loop() { refresh().finally(() => setTimeout(loop, 2000)); })();
})();
