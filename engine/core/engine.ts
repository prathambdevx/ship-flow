// createEngine: the tick loop, the actions, recovery and the public API.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { dropBuildOutput, dropPlanDirs, dropTaskDirs } from "./worktrees.ts";
import { DEFAULTS, type Config } from "../config.ts";
import type { Ports } from "../ports.ts";
import { BLOCKING_CATEGORIES, actionKey, type Action, type Finding, type Plan, type PlanEvent, type PlannedTask, type PlannerResult, type Round, type State, type Terminal, type TerminalTest } from "../types.ts";
import { DONE_ON_STAGING, mergeMaster as runMergeMaster, prTitle, runGate, runMaster, runRefresh, runStaging, runUat } from "./pipeline.ts";
import { applyPlan, planError, planRuns, runPlan, setNow } from "./planner.ts";
import { validatePlan } from "./validate.ts";
import { nextActions } from "./scheduler.ts";
import { isDeliberate } from "./errors.ts";
import { lockLine } from "./locks.ts";
import { openMinors } from "./minors.ts";
import { baseFor, nameProblem, targetProblem } from "./target.ts";
import { runTask, sendBack } from "./task.ts";
import { RECOVER_SCHEMA, recoverPrompt } from "./prompts.ts";
import { setReleaseSteps as storeSteps } from "./release.ts";
import { clock, createCtx, readEvents, readPlanLog } from "./store.ts";

const STEP_OF = { plan: "plan", gate: "tasks", staging: "staging", uat: "uat", master: "master" } as const;
const WAITING = "Waiting for its turn";
const DELAYS = [60_000, 300_000, 900_000]; // 1, 5 and 15 minutes
const BEAT_MS = 30_000, WAKE_GAP = 120_000, WAKE_GRACE = 120_000; // a gap over WAKE_GAP between beats means the Mac slept

export function createEngine(ports: Ports, config: Partial<Config> = {}) {
  const cfg: Config = { ...DEFAULTS, ...config, models: { ...DEFAULTS.models, ...config.models } };
  const ctx = createCtx(ports, cfg);
  const { st, inflight } = ctx;
  const lockSubs = new Map<string, string>();
  // Transient failures: retried on their own. A deliberate stop (Deliberate) is never retried.
  const tries = new Map<string, { n: number; planId: string }>();
  const holds = new Map<string, { planId: string; release(): void }>();
  let lastBeat = ctx.now(), wake: { from: number; to: number } | null = null, timer: ReturnType<typeof setInterval> | undefined;
  const planOf = (id: string): Plan => { const p = st.plans[id]; if (!p) throw new Error(`There is no plan ${id}.`); return p; };
  // A host watchdog takes every plan error instead of the recovery run (setErrorHook); recovering: recovery runs now.
  let errorHook: ((p: Plan, msg: string, step?: keyof Plan["steps"]) => void) | null = null;
  let refreshHook: ((planId: string, after: string, repos: string[], ok: boolean) => void) | null = null; // a master PR refresh ended
  const recovering = new Set<string>();

  const fixesText = (fixes: string[]) => `Changes to the plan from the task reviewers, the watchdog or a queued edit (problems in the plan itself, which no task's writer can fix). Make them; keep everything else:\n${fixes.map((f) => `- ${f}`).join("\n")}`;

  function tick(): void {
    finishDeletes();
    for (const p of Object.values(st.plans)) if (p.planFixes?.length && !p.terminal && !cfg.terminalOnly && p.steps.plan !== "run" && !busy(p) && !p.stopRequested) {
      const fixes = [...new Set(p.planFixes)], holds = p.planFixHolds ?? []; p.planFixes = []; p.planFixHolds = undefined; // one re-plan takes every queued fix; an identical one is applied once
      try { edit(p.id, fixesText(fixes), { add: true, hold: holds }); p.versions[p.versions.length - 1]!.fixes = fixes; }
      catch (e) { p.planFixes = fixes; p.planFixHolds = holds; ctx.ev(p.id, "plan_fix_wait", { text: `Plan fixes wait: ${e instanceof Error ? e.message : e}` }); }
    }
    if (cfg.cleanFinished) void cleanFinishedPlans();
    const { actions, waitsOn } = nextActions(st, cfg, inflight);
    let dirty = false;
    for (const t of Object.values(st.tasks)) {
      const w = t.status === "waiting" ? waitsOn[t.id] ?? [] : [];
      if (w.length) {
        const line = lockLine(st, t.id);
        if (JSON.stringify(w) !== JSON.stringify(t.waitsOn) || (line && t.sub !== line)) {
          t.waitsOn = w; if (line) { t.sub = line; lockSubs.set(t.id, line); }
          ctx.ev(t.planId, "task_waits", { task: t.id, text: line ?? `${t.label} waits for ${w.join(", ")}`, waitsOn: w });
          dirty = true;
        }
      } else if (t.waitsOn.length || lockSubs.has(t.id)) {
        if (lockSubs.get(t.id) === t.sub && t.status === "waiting") t.sub = WAITING;
        t.waitsOn = []; lockSubs.delete(t.id); dirty = true;
      }
    }
    if (dirty) ctx.change();
    for (const a of actions) launch(a);
  }
  ctx.tick = tick;

  // Every action the scheduler starts is logged with its end, outcome and time taken.
  const ACTION_TEXT = { plan: "planning", gate: "wave gate", staging: "the staging step", uat: "the staging test", master: "the master PRs" } as const;
  function launch(a: Action): void {
    const key = actionKey(a);
    if (inflight.has(key)) return;
    inflight.add(key);
    const t = a.kind === "task" ? st.tasks[a.task] : undefined, pid = t?.planId ?? (a.kind === "task" ? undefined : a.plan), t0 = ctx.now();
    const what = a.kind === "task" ? `task ${t?.label ?? a.task}` : a.kind === "gate" ? `the wave ${a.wave} gate` : ACTION_TEXT[a.kind];
    if (pid) ctx.ev(pid, "action_start", { task: t?.id, text: `Scheduler started ${what}`, action: key });
    let err: string | undefined;
    run(a).then(() => tries.delete(key)).catch((e) => { err = e instanceof Error ? e.message : String(e); onError(a, e); })
      .finally(() => { inflight.delete(key); if (pid) ctx.ev(pid, "action_end", { task: t?.id, text: `${what[0]!.toUpperCase()}${what.slice(1)} ${err ? `stopped: ${err.slice(0, 200)}` : "finished"}`, action: key, ok: !err, ms: ctx.now() - t0 }); queueMicrotask(tick); });
  }

  // Called every 30 s. A gap over 2 minutes means the Mac slept: log it and retry every waiting transient failure now.
  function heartbeat(): void {
    const now = ctx.now(), from = lastBeat;
    lastBeat = now;
    if (cfg.watchMasterPrs) void watchMasterPrs().catch(() => {});
    if (cfg.cleanFinished) void cleanFinishedPlans();
    if (now - from <= WAKE_GAP) return;
    wake = { from, to: now };
    const text = `The computer was asleep from ${clock(from)} to ${clock(now)}; resuming`;
    for (const p of Object.values(st.plans)) if (p.steps.master !== "done") ctx.ev(p.id, "woke", { text, from, to: now });
    tries.clear();
    for (const h of [...holds.values()]) h.release();
    tick();
  }

  interface Retry { task?: string; set(msg: string, at?: number): void; clear(): void; giveUp(msg: string): void; resume?: () => void }
  function transient(key: string, planId: string, e: unknown, o: Retry): void {
    heartbeat();
    const full = e instanceof Error ? e.message : String(e), short = full.split("\n")[0]!.slice(0, 120), max = cfg.transientRetries;
    const at0 = ctx.now(), rush = !!wake && at0 >= wake.from && at0 <= wake.to + WAKE_GRACE; // failed during or just after a sleep
    const n = rush ? 1 : (tries.get(key)?.n ?? 0) + 1;
    if (!rush && n > max) { tries.delete(key); return o.giveUp(full); }
    tries.set(key, { n: rush ? 0 : n, planId });
    const delay = rush ? 0 : DELAYS[Math.min(n - 1, DELAYS.length - 1)]!, at = at0 + delay;
    ctx.ev(planId, "retry_scheduled", { task: o.task, text: rush ? `Retrying on its own now (the computer was asleep) after: ${full}` : `Retrying on its own (try ${n} of ${max}) after: ${full}`, try: n, of: max, delayMs: delay, error: full });
    if (!delay) { o.set(`Retrying on its own now: ${short}`); ctx.change(); return; }
    o.set(`Retrying on its own at ${clock(at)} (try ${n} of ${max}): ${short}`, at); ctx.change();
    const hold = { planId, release() { if (holds.get(key) !== hold) return; holds.delete(key); o.clear(); ctx.ev(planId, "retry_resumed", { task: o.task, text: `Retrying now (try ${n} of ${max})`, try: n }); ctx.change(); (o.resume ?? tick)(); } };
    holds.set(key, hold);
    void ctx.sleep(delay).then(() => hold.release());
  }

  function clearHolds(planId: string): void {
    for (const [k, h] of [...holds]) if (h.planId === planId) holds.delete(k);
    for (const [k, v] of [...tries]) if (v.planId === planId) tries.delete(k);
    const p = st.plans[planId];
    if (p) p.retryAt = undefined;
    for (const t of Object.values(st.tasks)) if (t.planId === planId && t.retryAt) { t.retryAt = undefined; if (t.status === "waiting") t.sub = WAITING; }
  }

  const run = (a: Action): Promise<void> =>
    a.kind === "plan" ? runPlan(ctx, a.plan) : a.kind === "task" ? runTask(ctx, a.task)
      : a.kind === "gate" ? runGate(ctx, a.plan, a.wave) : a.kind === "staging" ? runStaging(ctx, a.plan)
        : a.kind === "uat" ? runUat(ctx, a.plan) : runMaster(ctx, a.plan);

  function onError(a: Action, e: unknown): void {
    const msg = e instanceof Error ? e.message : String(e), key = actionKey(a);
    try {
      if (a.kind === "task") {
        const t = st.tasks[a.task];
        if (!t) return;
        const fail = (m: string) => { t.status = "failed"; t.error = m; t.sub = `Failed: ${m.slice(0, 300)}`; ctx.ev(t.planId, "task_failed", { task: t.id, text: `${t.label} failed: ${m}`, error: m }); ctx.change(); };
        if (isDeliberate(e)) return fail(msg);
        transient(key, t.planId, e, { task: t.id, giveUp: fail, set: (m, at) => { t.status = "waiting"; t.error = undefined; t.retryAt = at; t.sub = m; }, clear: () => { t.retryAt = undefined; if (t.status === "waiting") t.sub = WAITING; } });
      } else {
        const p = planOf(a.plan);
        if (isDeliberate(e)) return planError(ctx, p, msg, STEP_OF[a.kind]);
        transient(key, p.id, e, { giveUp: (m) => planError(ctx, p, m, STEP_OF[a.kind]), set: (m, at) => { p.retryAt = at; setNow(ctx, p, m); }, clear: () => { p.retryAt = undefined; } });
      }
    } catch { /* the loop must never crash */ }
  }

  // targetBranch: merge into this branch instead of staging (you set it; the planner may not change it).
  function submit(text: string, opts: { targetBranch?: string } = {}): string {
    text = (text ?? "").trim();
    if (!text) throw new Error("Paste some text first.");
    const target = opts.targetBranch?.trim() || undefined, bad = target ? nameProblem(target) : null;
    if (bad) throw new Error(bad);
    const seq = ++st.seq, id = `P-${String(seq).padStart(2, "0")}`, now = ctx.now();
    const order = Math.max(0, ...Object.values(st.plans).map((p) => p.order)) + 1;
    st.plans[id] = {
      id, title: text.split("\n")[0]!.replace(/^#+\s*/, "").slice(0, 60), text, versions: [{ n: 1, at: now, text, changes: [] }], pastedAt: now, order, acceptance: [], tasks: [], waves: 0, gates: {},
      steps: { plan: "run", tasks: "", staging: "", uat: "", master: "" }, now: "Reading the text and planning", tone: "", nowAt: now,
      started: false, needsStart: false, slug: "", repos: [], stagingPrs: [], masterPrs: [], ...(target ? { targetBranch: target, targetSetByYou: true } : {}),
    };
    if (target) ctx.ev(id, "target_set", { text: `You set the target branch: the plan merges into ${target}, not staging`, branch: target, by: "you" });
    ctx.ev(id, "plan_submitted", { text: `Plan pasted (${text.length} characters): ${text.slice(0, 200).replace(/\s+/g, " ")}`, version: 1, hash: createHash("sha256").update(text).digest("hex"), first200: text.slice(0, 200), length: text.length });
    ctx.change(); tick();
    return id;
  }

  function busy(p: Plan): boolean {
    return [...inflight].some((k) => { const [kind, rest] = k.split(":"); return kind !== "task" && rest === p.id; });
  }

  // add: the text is an update appended to the plan text; without it, the text replaces the plan (the edit dialog sends it whole).
  function edit(planId: string, text: string, opts: { add?: boolean; hold?: string[] } = {}): void {
    const p = planOf(planId);
    p.recoveries = 0;
    text = (text ?? "").trim();
    if (!text) throw new Error("Paste the changed text first.");
    if (opts.add) text = `${p.text.trimEnd()}\n\n## Update ${new Date(ctx.now()).toLocaleDateString("en-CA")}\n${text}`;
    if (p.steps.master === "done") throw new Error("This plan is already live on prod and cannot be edited.");
    if (p.kind === "port") throw new Error("A port plan has no tasks to plan again. Make a new port plan instead.");
    if (p.kind === "promote") throw new Error("A promotion plan has no tasks to plan again. Make a new promotion instead.");
    const stoppedPlanning = (k: string) => p.stopRequested && k === `plan:${p.id}`; // a stopped planning run is ending; its answer is dropped
    if ((p.steps.plan === "run" && !p.stopRequested) || [...inflight].some((k) => !k.startsWith("task:") && k.split(":")[1] === p.id && !stoppedPlanning(k))) throw new Error("The plan is busy right now. Wait for it, or press Stop first.");
    const now = ctx.now();
    clearHolds(p.id);
    p.text = text; p.versions.push({ n: p.versions.length + 1, at: now, text, changes: [] });
    if (opts.hold) holdIds(p, opts.hold); else holdNamed(p, opts.add ? text.split("\n## Update ").at(-1)! : text); // an explicit list holds only those tasks
    p.steps.plan = "run"; p.error = undefined; p.askYou = undefined; p.stopRequested = undefined; // an edit is a go: a plan stopped before it re-plans
    setNow(ctx, p, "Re-planning with your changes");
    ctx.ev(p.id, "plan_edited", { text: `Plan edited: version ${p.versions.length} (${text.length} characters): ${text.slice(0, 200).replace(/\s+/g, " ")}`, version: p.versions.length, hash: createHash("sha256").update(text).digest("hex"), first200: text.slice(0, 200), length: text.length });
    ctx.change(); tick();
  }

  function start(planId: string): void {
    const p = planOf(planId);
    if (p.steps.plan === "run") throw new Error("The plan is not ready yet.");
    if (p.kind === "promote") {
      if (p.started) throw new Error("There is nothing to start.");
      p.started = true; p.startedAt = ctx.now(); p.needsStart = false; p.steps.plan = "done";
      setNow(ctx, p, `Started: taking ${p.promotes} to staging`);
      ctx.ev(p.id, "started", { text: `Started: ${p.promotes} goes to staging in ${p.repos.map((r) => r.repo).join(", ")}` });
      ctx.change(); tick(); return;
    }
    const drafts = p.tasks.map((id) => st.tasks[id]!).filter((t) => t && t.status === "draft");
    if (!drafts.length || !(p.needsStart || !p.started)) throw new Error("There is nothing to start.");
    for (const t of drafts) { t.status = "waiting"; t.sub = WAITING; t.isNew = undefined; t.changed = undefined; }
    p.started = true; p.startedAt ??= ctx.now(); p.needsStart = false; p.steps.plan = "done"; p.steps.tasks = "run";
    setNow(ctx, p, `Started: ${drafts.length} task${drafts.length === 1 ? "" : "s"} queued`);
    ctx.ev(p.id, "started", { text: `Started: ${drafts.map((t) => t.label).join(", ")} queued`, tasks: drafts.map((t) => t.label) });
    ctx.change(); tick();
  }

  // Any plan, except while its merge or release runs. Its branches and PRs stay in the git host; its id is never given out again (st.seq).
  function remove(planId: string): void {
    const p = planOf(planId);
    if (p.merging || p.release?.state === "running" || p.stagingRelease?.state === "running" || p.stagingRelease?.state === "starting" || inflight.has(`merge:${p.id}`))
      throw new Error("A merge or release is running for this plan. Wait for it to end, then delete.");
    p.stopRequested = true; p.deleting = true; planRuns.get(p.id)?.();
    for (const id of p.tasks) { const t = st.tasks[id]; if (t && (t.status === "working" || t.status === "review")) t.stopRequested = true; }
    clearHolds(p.id);
    setNow(ctx, p, "Deleting: waiting for its runs to end");
    ctx.ev(p.id, "plan_delete", { text: "You deleted this plan" });
    ctx.change(); finishDeletes();
  }
  // A deleted plan leaves the state once nothing of it runs; its worktree folders go too.
  function finishDeletes(): void {
    for (const p of Object.values(st.plans)) {
      if (!p.deleting || [...inflight].some((k) => k.split(":")[1] === p.id || k.startsWith(`task:${p.id}/`))) continue;
      void dropPlanDirs(ctx, p, "Deleted"); // reads the task folders before the tasks go
      for (const id of p.tasks) delete st.tasks[id];
      delete st.plans[p.id];
      ctx.ev(p.id, "plan_deleted", { text: "Plan deleted. Its branches and PRs stay in the git host." });
    }
    ctx.change();
  }

  function stop(planId: string): void {
    const p = planOf(planId);
    p.stopRequested = true;
    if (p.steps.plan === "run") { p.steps.plan = "fail"; planRuns.get(p.id)?.(); } // planning ends now, so the text can be replaced straight away
    setNow(ctx, p, "Stopped. Press Retry to carry on.");
    ctx.ev(p.id, "stopped_by_user", { text: "You pressed Stop" });
    ctx.change();
  }

  // A plan error after its tasks: one Opus run decides to retry, send a task back, or wait for a person. At most 3 a plan.
  const MAX_RECOVERIES = 3;
  ctx.onPlanError = (p, msg, step) => {
    if (p.terminal) return; // the terminal reads the error and fixes it; no watchdog or recovery run
    if (errorHook) { try { errorHook(p, msg, step); } catch { /* the loop must never crash */ } return; }
    if (!step || !["tasks", "staging", "uat", "master"].includes(step) || p.stopRequested) return;
    if ((p.recoveries ?? 0) >= MAX_RECOVERIES) { ctx.ev(p.id, "recovery_skipped", { text: `No recovery run: ${MAX_RECOVERIES} of ${MAX_RECOVERIES} used for this plan`, step }); return; }
    p.recoveries = (p.recoveries ?? 0) + 1;
    const n = p.recoveries, id = p.id;
    setNow(ctx, p, `Stopped; the recovery run (Opus) is working out how to carry on (${n} of ${MAX_RECOVERIES})`, "bad"); ctx.change();
    recovering.add(id);
    (async () => {
      const live = p.tasks.map((t) => st.tasks[t]).filter((t) => t && t.status !== "removed") as (typeof st.tasks)[string][];
      const recent = readEvents(ports.dataDir, id, 40).map((e: any) => e.text).filter(Boolean);
      const res = await ctx.ask({ role: "planner", prompt: recoverPrompt(p, msg, live.map((t) => ({ label: t.label, repo: t.repo, title: t.title, files: t.files })), recent), schema: RECOVER_SCHEMA, sessionId: randomUUID(), plan: id });
      const cur = st.plans[id];
      if (!cur || cur.error !== msg || cur.stopRequested) { ctx.ev(id, "recovery_dropped", { text: "Recovery run answer dropped: a person acted meanwhile" }); return; }
      const r = res.structured as { action: string; task: string; finding: string; why: string } | undefined;
      if (!res.ok || !r || !["retry", "send_back", "person"].includes(r.action)) { ctx.ev(id, "recovery", { text: `Recovery run did not answer: ${res.error ?? "no result"}`, action: "none" }); setNow(ctx, cur, `Stopped: ${msg} (the recovery run did not answer)`, "bad"); ctx.change(); return; }
      ctx.ev(id, "recovery", { text: `Recovery run: ${r.action}${r.task ? ` ${r.task}` : ""}: ${r.why}`, action: r.action, task: r.task, finding: r.finding, why: r.why });
      const t = live.find((x) => x.label === r.task);
      if (r.action === "retry") { await ctx.sleep(60_000); if (st.plans[id]?.error === msg) retry(id, "The recovery run retried it"); }
      else if (r.action === "send_back" && t) {
        cur.error = undefined; cur.askYou = undefined; cur.tone = "";
        for (const k of Object.keys(cur.steps) as (keyof Plan["steps"])[]) if (cur.steps[k] === "fail") cur.steps[k] = "";
        sendBack(ctx, cur, t, [{ severity: "blocking", category: "correctness", text: r.finding, by: "architect-reviewer" }], "recovery", "The recovery run");
        cur.steps.staging = ""; cur.steps.tasks = "run";
        setNow(ctx, cur, `The recovery run sent ${t.label} back: ${r.finding.slice(0, 120)}`); ctx.change(); tick();
      } else { setNow(ctx, cur, `Needs you: ${r.why}`, "bad"); ctx.change(); }
    })().catch((e) => { const cur = st.plans[id]; if (cur) { ctx.ev(id, "recovery", { text: `Recovery run failed: ${e?.message ?? e}`, action: "none" }); setNow(ctx, cur, `Stopped: ${msg} (recovery failed: ${e?.message ?? e})`, "bad"); ctx.change(); } }).finally(() => recovering.delete(id));
  };

  // A person ran the plan's database changes on staging by hand (the runner refuses rows and multi-statement blocks).
  function dbDone(planId: string): void {
    const p = planOf(planId);
    if (!p.dbChanges?.length) throw new Error("This plan has no database changes.");
    p.dbDoneAt = ctx.now();
    ctx.ev(p.id, "staging_db", { text: "You marked the database changes as run on staging by a person", ok: true });
    ctx.change();
  }

  function retry(planId: string, who = "You pressed Retry"): void {
    const p = planOf(planId);
    p.error = undefined; p.askYou = undefined; p.stopRequested = undefined; p.tone = "";
    if (who === "You pressed Retry" && p.watchdog) { p.watchdog.runs = 0; p.watchdog.needs = undefined; if (p.watchdog.state === "needs") p.watchdog.state = "done"; } // a person's Retry gives the watchdog its runs back
    clearHolds(p.id);
    (p as any)._x = { ...(p as any)._x, sendBacks: 0 };
    for (const id of p.tasks) {
      const t = st.tasks[id];
      if (!t) continue;
      if (!inflight.has(`task:${t.id}`)) t.stopRequested = false; // an old run that is still ending must still stop
      if (t.status === "failed" && t.needsYou && who !== "You pressed Retry" && !who.startsWith("The watchdog retried it")) continue; // the total round cap: your Retry or the watchdog's
      if (t.status === "failed") { t.status = "waiting"; t.error = undefined; t.sub = WAITING; if (t.needsYou) { t.needsYou = false; t.roundBase = t.rounds.length; } }
    }
    // After a failed staging test, staging runs again first: a fix committed on the plan branch since then must deploy (P-17).
    if (p.steps.uat === "fail" && p.steps.staging === "done") p.steps.staging = "";
    for (const k of Object.keys(p.steps) as (keyof Plan["steps"])[]) if (p.steps[k] === "fail") p.steps[k] = k === "plan" ? "run" : "";
    setNow(ctx, p, "Trying again");
    ctx.ev(p.id, "retry", { text: who });
    ctx.change(); tick();
  }

  function fixAnyway(planId: string, n: number): void {
    const p = planOf(planId);
    const row = p.triage?.find((r) => r.n === n && r.leftOut);
    if (!row) throw new Error(`Bug ${n} is not in the left-out list.`);
    row.leftOut!.fixAnyway = true;
    ctx.ev(p.id, "fix_anyway", { text: `You asked to fix bug ${n} anyway`, n });
    edit(planId, `${p.text}\n\nAlso fix bug ${n}: ${row.text}`);
  }

  // A failed or sent-back task whose code already reached the plan branch: keep that code, drop the later attempt.
  function keepCode(planId: string, taskId: string): void {
    const p = planOf(planId), t = st.tasks[taskId];
    if (!t || t.planId !== p.id) throw new Error(`There is no task ${taskId} in ${p.id}.`);
    if (inflight.has(`task:${t.id}`)) throw new Error(`${t.label} is running. Press Stop first.`);
    if (t.status !== "failed" && t.status !== "waiting") throw new Error(`${t.label} is ${t.status}; only a failed or waiting task can keep its merged code.`);
    if (!readEvents(ports.dataDir, p.id, Infinity).some((e) => e.event === "merge" && e.task === t.id && e.ok === true)) throw new Error(`${t.label} was never merged into the plan branch, so there is no code to keep.`);
    t.status = "done"; t.error = undefined; t.notes = []; t.doneAt = ctx.now(); t.sub = "Kept the code already in the plan branch (your call)";
    ctx.ev(p.id, "task_kept", { task: t.id, text: `You kept ${t.label}'s code in the plan branch; its later unmerged attempt was dropped` });
    ctx.change(); tick();
  }

  // A done task goes back to its writer with your finding, like a send-back from the gate or the staging test.
  function sendBackTask(planId: string, label: string, text: string): void {
    const p = planOf(planId), t = st.tasks[`${planId}/${label}`], why = (text ?? "").trim();
    if (!t || t.status === "removed") throw new Error(`There is no task ${label} in ${planId}.`);
    if (!why) throw new Error("Say what is wrong, so the writer can fix it.");
    if (inflight.has(`task:${t.id}`) || t.status !== "done") throw new Error(`${t.label} is ${t.status}; only a done task can be sent back.`);
    if (p.steps.staging === "run" || p.steps.uat === "run" || p.steps.master === "you" || p.steps.master === "done" || p.merging) throw new Error("The plan is past its tasks (staging, the staging test or master). Edit the plan instead.");
    sendBack(ctx, p, t, [{ severity: "blocking", category: "correctness", text: why.slice(0, 4000), by: "code-reviewer" }], "edit", "You");
    p.steps.staging = ""; p.steps.uat = ""; p.steps.tasks = "run"; p.landedAt = undefined; p.cleanedAt = undefined;
    setNow(ctx, p, `${t.label} sent back to its writer: ${why.slice(0, 120)}`);
    ctx.change(); tick();
  }

  // An open minor finding: send it back to the task's writer as blocking, or accept it as it is.
  function decideMinor(planId: string, key: string, choice: "accept" | "send"): void {
    const p = planOf(planId), m = openMinors(st, p).find((x) => x.key === key);
    if (!m) throw new Error("That finding is no longer open: the task changed since. Reload the page.");
    const why = `${m.finding.text}${m.finding.file ? ` (${m.finding.file}${m.finding.line ? `:${m.finding.line}` : ""})` : ""}`;
    if (choice === "send" && m.label === "Architect") queueEdit(planId, `The user sent back the architect's finding (no task owns it): ${why}`); // the planner decides
    else if (choice === "send") sendBackTask(planId, m.label, `A minor finding from review round ${m.round}, sent back by you as blocking: ${why}`);
    p.minorCalls = { ...p.minorCalls, [key]: choice === "send" ? "sent" : "accepted" };
    ctx.ev(p.id, "minor_decided", { task: m.task, key, choice, text: `${m.label}: ${choice === "send" ? "sent back" : "accepted"} the minor finding "${(m.finding.short ?? m.finding.text).slice(0, 120)}"` });
    ctx.change();
  }

  // Held tasks: only the ones a fix changes (an explicit id list), or, with no list, the tasks the text names by label (T11).
  function holdIds(p: Plan, ids: string[]): void {
    if (!p.started) return;
    for (const id of ids) {
      const t = p.tasks.includes(id) ? st.tasks[id] : undefined;
      if (!t || ["done", "removed", "draft"].includes(t.status) || t.heldForPlan) continue;
      t.heldForPlan = true;
      ctx.ev(p.id, "task_held", { task: t.id, text: `${t.label} is held until the plan change that changes it is planned` });
    }
  }
  const namedIds = (p: Plan, text: string): string[] => { const named = new Set(text.match(/\bT\d+\b/g) ?? []); return p.tasks.filter((id) => named.has(st.tasks[id]?.label ?? "")); };
  const holdNamed = (p: Plan, text: string): void => holdIds(p, namedIds(p, text));
  const idsOf = (p: Plan, list: string[]): string[] => list.map((x) => (x.includes("/") ? x : `${p.id}/${x}`)).filter((id) => p.tasks.includes(id)); // a label (T5) or a task id

  // An added edit while the plan is busy is queued, not refused; a whole-text replace still needs a free plan.
  // A free plan takes the edit together with every fix already queued, in one re-plan.
  function editOrQueue(planId: string, text: string, tasks?: string[]): "applied" | "queued" {
    const p = planOf(planId);
    if (p.steps.plan === "run" || busy(p)) { queueEdit(planId, text, tasks); return "queued"; }
    if (!p.planFixes?.length) { edit(planId, text, { add: true, ...(tasks ? { hold: idsOf(p, tasks) } : {}) }); return "applied"; }
    const fixes = [...new Set([...p.planFixes, text.trim()])], holds = [...new Set([...(p.planFixHolds ?? []), ...(tasks ? idsOf(p, tasks) : namedIds(p, text))])];
    const was = { f: p.planFixes, h: p.planFixHolds }; p.planFixes = []; p.planFixHolds = undefined;
    try { edit(planId, fixesText(fixes), { add: true, hold: holds }); p.versions[p.versions.length - 1]!.fixes = fixes; } catch (e) { p.planFixes = was.f; p.planFixHolds = was.h; throw e; }
    return "applied";
  }

  // A plan change that waits until the plan is free (no re-plan or plan step running); tick applies every queued one in one re-plan.
  // tasks: ids (or labels) of the tasks this change changes; only those are held. No list: the tasks the text names are held.
  function queueEdit(planId: string, text: string, tasks?: string[]): void {
    const p = planOf(planId), t = (text ?? "").trim();
    if (!t) return;
    if (p.planFixes?.includes(t)) { ctx.ev(p.id, "plan_fix_duplicate", { text: `The same plan change is already queued; not queued again: ${t.slice(0, 200)}` }); return; }
    const ids = tasks ? idsOf(p, tasks) : namedIds(p, t);
    holdIds(p, ids);
    p.planFixHolds = [...new Set([...(p.planFixHolds ?? []), ...ids])];
    p.planFixes = [...(p.planFixes ?? []), t];
    ctx.ev(p.id, "plan_fix_queued", { text: `Plan change queued; the planner applies it when the plan is free: ${t.slice(0, 200)}`, tasks: ids });
    ctx.change(); tick();
  }

  function reorder(planId: string, beforeId: string | null): void {
    const p = planOf(planId);
    if (beforeId && !st.plans[beforeId]) throw new Error(`There is no plan ${beforeId}.`);
    const list = Object.values(st.plans).sort((a, b) => a.order - b.order).filter((x) => x.id !== p.id);
    const at = beforeId ? list.findIndex((x) => x.id === beforeId) : list.length;
    list.splice(at, 0, p);
    list.forEach((x, i) => { x.order = i + 1; });
    ctx.ev(p.id, "reordered", { text: beforeId ? `Moved before ${beforeId}` : "Moved to the end of the queue", before: beforeId });
    ctx.change(); tick();
  }

  // Points the plan at an existing tester session (e.g. one from before uatSession was saved); the next staging test continues it.
  function setUatSession(planId: string, sessionId: string): void {
    const p = planOf(planId);
    if (!/^[0-9a-f-]{36}$/.test(sessionId)) throw new Error("Send a session id (a UUID).");
    p.uatSession = sessionId;
    ctx.ev(p.id, "uat_session", { text: `The next staging test continues tester session ${sessionId}` });
    ctx.change();
  }

  // Staging only: the plan ends once it is on staging and its staging test passed; it raises no master PRs.
  function setStagingOnly(planId: string, on: boolean): void {
    const p = planOf(planId);
    if (p.steps.master === "you" || p.steps.master === "done") throw new Error("Its master PRs are already raised.");
    p.stagingOnly = on || undefined;
    ctx.ev(p.id, "staging_only", { text: on ? "Staging only: no master PRs; the plan ends once staging is deployed and tested" : "Staging only turned off: master PRs come after the staging test" });
    if (on && p.steps.uat === "done") { // finished: a stop in the master step no longer matters
      if (p.steps.master === "fail") { p.steps.master = ""; p.error = undefined; p.askYou = undefined; }
      setNow(ctx, p, DONE_ON_STAGING, "ok");
    }
    ctx.change();
  }

  function setTicket(planId: string, ticket: string): void {
    const p = planOf(planId), t = ticket.trim();
    if (t.length > 80) throw new Error("The ticket number is too long (80 characters at most).");
    p.ticket = t || undefined; p.ticketSetByYou = !!t;
    ctx.ev(p.id, "ticket", { text: t ? `Ticket set to ${t}; PR titles start with it` : "Ticket removed", ticket: t });
    ctx.change();
    // Open PRs get the new title too; a merged one keeps its old title.
    for (const r of [...p.stagingPrs, ...p.masterPrs].filter((x) => x.state === "open"))
      ports.prs.retitle?.(r.repo, r.id, prTitle(p)).then(() => ctx.ev(p.id, "pr_retitled", { text: `${r.repo}: PR #${r.id} renamed to "${prTitle(p)}"`, repo: r.repo, id: r.id }),
        (e) => ctx.ev(p.id, "pr_retitle_failed", { text: `${r.repo}: PR #${r.id} not renamed: ${e?.message ?? e}`, repo: r.repo, id: r.id }));
  }

  // The target branch can change only before Start: after it, the plan's code is already on its branch.
  async function setTarget(planId: string, branch: string): Promise<void> {
    const p = planOf(planId), b = branch.trim();
    if (p.kind === "port" || p.kind === "promote") throw new Error("This plan has no target branch.");
    if (p.started) throw new Error(`The plan has started on ${p.targetBranch ?? "staging"}. Make a new plan for another branch.`);
    if (p.steps.plan === "run") throw new Error("The plan is being planned. Wait for it, then set the branch.");
    const bad = b ? await targetProblem(ctx, b, p.repos.map((r) => r.repo)) : null;
    if (bad) throw new Error(bad);
    p.targetBranch = b || undefined; p.targetSetByYou = true;
    for (const r of p.repos) r.base = await baseFor(ctx, p, r.repo);
    ctx.ev(p.id, "target_set", { text: b ? `You set the target branch: the plan merges into ${b}, not staging` : "You removed the target branch: the plan goes to staging", branch: b, by: "you" });
    if (p.error && p.askYou && p.steps.plan === "fail" && p.tasks.length) { // the planner's branch could not be used; yours can
      p.error = undefined; p.askYou = undefined; p.steps.plan = "you"; p.needsStart = true;
      setNow(ctx, p, "Planned. Nothing runs until you press Start.");
    }
    ctx.change();
  }

  // A promotion plan: every plan merged into `branch` goes to staging together, then the normal staging test and master PRs.
  async function promote(input: { branch?: unknown }): Promise<string> {
    const b = String(input?.branch ?? "").trim();
    if (!b) throw new Error("Send the target branch to promote.");
    const all = Object.values(st.plans).sort((x, y) => x.order - y.order);
    const from = all.filter((p) => p.targetBranch === b && p.landedAt), still = all.filter((p) => p.targetBranch === b && !p.landedAt);
    if (!from.length) throw new Error(`No plan has merged into ${b} yet, so there is nothing to promote.`);
    const dup = all.find((p) => p.kind === "promote" && p.promotes === b && p.steps.master !== "done");
    if (dup) throw new Error(`${dup.id} already takes ${b} to staging. Finish it first.`);
    const repos = [...new Set(from.flatMap((p) => [...p.repos].sort((x, y) => x.order - y.order).map((r) => r.repo)))];
    const bases = await Promise.all(repos.map((repo) => ports.git.stagingBranch(repo)));
    const bad = await targetProblem(ctx, b, repos);
    if (bad) throw new Error(bad);
    const seq = ++st.seq, id = `P-${String(seq).padStart(2, "0")}`; // no await from here: two calls never share an id
    const slug = `promote-${b.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`.slice(0, 40);
    const parts: Plan["repos"] = repos.map((repo, i) => ({ repo, base: bases[i]!, from: b, branch: `prflow/${id.toLowerCase()}-${slug}`, dir: `${ports.stageRoot}/${id}/${repo}`, order: i + 1, why: `Merge order of ${from.find((p) => p.repos.some((r) => r.repo === repo))!.id}`, stagingCommits: [] }));
    const db = from.flatMap((p) => p.dbChanges ?? []).filter((d, i, a) => a.findIndex((x) => x.database === d.database && x.sql === d.sql) === i);
    const tickets = [...new Set(from.map((p) => p.ticket).filter(Boolean))].join(", ").slice(0, 80);
    const text = [`Take everything merged into ${b} to staging, test it on UAT, then open the master PRs.`, "", "Plans merged into it:", ...from.map((p) => `- ${p.id} ${p.title}`),
      ...(still.length ? ["", `Not included (not merged into ${b} yet): ${still.map((p) => p.id).join(", ")}`] : []), "", ...from.map((p) => `## ${p.id} ${p.title}
${p.text.slice(0, 3000)}`)].join("\n");
    const now = ctx.now(), order = Math.max(0, ...all.map((p) => p.order)) + 1;
    st.plans[id] = {
      id, title: `Promote ${b} to staging`, text, versions: [{ n: 1, at: now, text, changes: [] }], pastedAt: now, order, kind: "promote", promotes: b,
      acceptance: [...new Set(from.flatMap((p) => p.acceptance))], tasks: [], waves: 0, gates: {},
      steps: { plan: "you", tasks: "done", staging: "", uat: "", master: "" }, now: `Ready: takes ${b} to staging in ${repos.length} repo${repos.length === 1 ? "" : "s"}, then the staging test and master PRs. Nothing runs until you press Start.`, tone: "", nowAt: now,
      started: false, needsStart: true, slug, repos: parts, stagingPrs: [], masterPrs: [], ticket: tickets || undefined, dbChanges: db.length ? db : undefined,
    };
    ctx.ev(id, "plan_promote", { text: `Promotion made: ${b} to staging in ${repos.join(", ")} (${from.map((p) => p.id).join(", ")})`, branch: b, plans: from.map((p) => p.id), repos });
    ctx.change();
    return id;
  }

  // prodWrites: the merge dialog's second confirm. A plan with release steps not done merges only with it.
  async function mergeMaster(planId: string, opts: { prodWrites?: boolean } = {}): Promise<void> {
    const p = planOf(planId);
    if (p.steps.master !== "you" || !p.masterPrs.length) throw new Error("There are no master PRs waiting for you.");
    if (p.error) throw new Error("The plan has an error. Press Retry first.");
    if (!ports.release) throw new Error("This backend has no release runner. Merge the master PRs on the git host.");
    if (p.releaseSteps?.some((s) => s.state !== "done") && opts.prodWrites !== true) throw new Error("This merge also writes to prod (release steps). Confirm both prompts in the merge dialog.");
    if (inflight.has(`merge:${planId}`)) throw new Error("The merge is already running.");
    if (inflight.has(`refresh:${planId}`)) throw new Error("The master PRs are being refreshed after another plan merged. Wait a moment, then merge.");
    ctx.ev(p.id, "merge_master_clicked", { text: "You pressed Merge to master and deploy" });
    p.merging = ctx.now(); ctx.change();
    launchMerge(planId);
  }

  // A host with no release runner: the user merges the master PRs on the git host. Poll them; when all are merged, the plan is live.
  let watching = false;
  async function watchMasterPrs(): Promise<void> {
    if (watching) return;
    watching = true;
    try {
      for (const p of Object.values(st.plans)) {
        if (p.steps.master !== "you" || p.error || !p.masterPrs.length) continue;
        let changed = false;
        for (const pr of p.masterPrs.filter((r) => r.state === "open")) {
          const s = await ports.prs.state(pr.repo, pr.id).catch(() => "open" as const);
          if (s === "merged") { pr.state = "merged"; changed = true; ctx.ev(p.id, "master_merged", { text: `${pr.repo}: master PR #${pr.id} was merged on the git host`, repo: pr.repo, id: pr.id }); }
        }
        if (p.masterPrs.every((r) => r.state === "merged")) {
          await dropPlanDirs(ctx, p);
          p.steps.master = "done"; p.liveAt = ctx.now();
          setNow(ctx, p, `${p.masterPrs.length}/${p.masterPrs.length} master PRs merged. Live.`, "ok");
          ctx.ev(p.id, "live", { text: "All master PRs merged. Live." });
          changed = true;
        }
        if (changed) ctx.change();
      }
    } finally { watching = false; }
  }

  // The prod steps Merge runs around the master PRs. Only while the plan waits for your merge.
  async function setReleaseSteps(planId: string, steps: unknown): Promise<void> {
    const p = planOf(planId);
    if (p.steps.master !== "you" || !p.masterPrs.length) throw new Error("Release steps can be set only while the master PRs wait for your merge.");
    if (p.merging || inflight.has(`merge:${planId}`)) throw new Error("The merge is running. Wait for it to stop first.");
    if (inflight.has(`refresh:${planId}`)) throw new Error("The master PRs are being refreshed. Wait a moment, then try again.");
    if (p.releaseSteps?.some((s) => s.state === "run")) throw new Error("A release step is running.");
    await storeSteps(ctx, p, steps);
  }

  function launchMerge(planId: string): void {
    const key = `merge:${planId}`, p = planOf(planId);
    inflight.add(key);
    runMergeMaster(ctx, planId).then(() => tries.delete(key)).catch((e) => {
      try { transient(key, planId, e, { giveUp: (m) => planError(ctx, p, `Merge to master stopped: ${m}`), set: (m) => setNow(ctx, p, m), clear: () => {}, resume: () => { if (!inflight.has(key) && p.steps.master === "you" && !p.error) launchMerge(planId); } }); } catch { /* the loop must never crash */ }
    }).finally(() => {
      inflight.delete(key);
      if (p.steps.master === "done") refreshOthers(p);
      if (p.steps.master === "done" || p.error) { p.merging = undefined; ctx.change(); } // a transient wait keeps it: the merge is still on
      queueMicrotask(tick);
    });
  }

  // A plan just went live: every other plan waiting for its merge gets its open master PRs rebuilt in the repos that plan changed.
  function refreshOthers(merged: Plan): void {
    const repos = [...new Set(merged.masterPrs.filter((r) => r.state === "merged").map((r) => r.repo))];
    if (!repos.length) return;
    for (const o of Object.values(st.plans).sort((a, b) => a.order - b.order)) {
      if (o.id === merged.id || o.steps.master !== "you" || o.error || o.stopRequested || o.merging || inflight.has(`merge:${o.id}`)) continue;
      const hit = o.masterPrs.filter((r) => r.state === "open" && repos.includes(r.repo)).map((r) => r.repo);
      if (hit.length) launchRefresh(o.id, merged.id, hit);
    }
  }

  function launchRefresh(planId: string, mergedId: string, repos: string[]): Promise<void> {
    const key = `refresh:${planId}`, o = planOf(planId);
    if (inflight.has(key)) return Promise.resolve();
    inflight.add(key);
    ctx.ev(planId, "refresh_start", { text: `Rebuilding the master PR in ${repos.join(", ")} (after ${mergedId} merged)`, repos, after: mergedId });
    return runRefresh(ctx, planId, mergedId, repos).catch((e) => { try { planError(ctx, o, `Master moved when ${mergedId} merged, and refreshing the master PR failed: ${e instanceof Error ? e.message : String(e)}`, "master"); } catch { /* the loop must never crash */ } })
      .finally(() => { inflight.delete(key); ctx.ev(planId, "refresh_end", { text: o.error ? `Master PR rebuild failed: ${o.error.slice(0, 200)}` : `Master PR rebuilt in ${repos.join(", ")}`, repos, ok: !o.error }); try { refreshHook?.(planId, mergedId, repos, !o.error); } catch { /* the loop must never crash */ } queueMicrotask(tick); });
  }

  // Keeps waiting plans mergeable, never merging: an open master PR that no longer merges cleanly is rebuilt on the
  // latest master (runRefresh; a failure is a plan error); an open staging PR that no longer merges is returned to the host.
  let sweeping = false;
  async function sweep(): Promise<{ refreshed: { plan: string; repos: string[]; after: string; ok: boolean }[]; stale: { plan: string; repo: string; id: number }[] }> {
    const out = { refreshed: [] as { plan: string; repos: string[]; after: string; ok: boolean }[], stale: [] as { plan: string; repo: string; id: number }[] };
    const clean = ports.git.mergesCleanly;
    if (!clean || sweeping) return out;
    sweeping = true;
    const idle = (p: Plan) => !p.error && !p.stopRequested && !p.merging && !busy(p);
    const check = (repo: string, head: string, target: string) => clean(repo, head, target).catch(() => null);
    try {
      for (const p of Object.values(st.plans).sort((a, b) => a.order - b.order)) {
        if (!idle(p)) continue;
        if (p.steps.master === "you") {
          const bad: string[] = [];
          for (const r of p.masterPrs.filter((x) => x.state === "open" && x.head)) {
            const ok = await check(r.repo, r.head!, await ports.git.masterBranch(r.repo));
            ctx.ev(p.id, "sweep_checked", { text: `${r.repo} master PR #${r.id}: ${ok === true ? "merges cleanly" : ok === false ? "no longer merges cleanly" : "could not check"}`, repo: r.repo, id: r.id, clean: ok });
            if (ok === false) bad.push(r.repo);
          }
          if (bad.length && idle(p) && p.steps.master === "you") {
            const after = Object.values(st.plans).filter((o) => o.liveAt && o.masterPrs.some((r) => r.state === "merged" && bad.includes(r.repo))).sort((a, b) => b.liveAt! - a.liveAt!)[0]?.id ?? "another change";
            ctx.ev(p.id, "sweep_conflict", { text: `${bad.join(", ")}: the master PR no longer merges cleanly; rebuilding it on the latest master`, repos: bad });
            await launchRefresh(p.id, after, bad);
            out.refreshed.push({ plan: p.id, repos: bad, after, ok: !st.plans[p.id]?.error });
          }
        }
        if (p.steps.staging === "run" || p.steps.staging === "done") continue; // the staging step merges its own PRs
        for (const r of p.stagingPrs.filter((x) => x.state === "open" && x.head)) {
          const part = p.repos.find((x) => x.repo === r.repo);
          const ok = await check(r.repo, r.head!, part?.base ?? (await ports.git.stagingBranch(r.repo)));
          ctx.ev(p.id, "sweep_checked", { text: `${r.repo} staging PR #${r.id}: ${ok === true ? "merges cleanly" : ok === false ? "no longer merges cleanly" : "could not check"}`, repo: r.repo, id: r.id, clean: ok, staging: true });
          if (ok === false) out.stale.push({ plan: p.id, repo: r.repo, id: r.id });
        }
      }
    } finally { sweeping = false; }
    return out;
  }

  // A plan from staging commits that are already merged and tested: no tasks; the scheduler goes straight to the master PRs.
  async function port(input: { title: string; text: string; ticket?: string; repos: { repo: string; order: number; why?: string; commits: string[] }[]; db_changes?: { database: string; sql: string; why?: string }[] }): Promise<string> {
    const title = String(input?.title ?? "").trim(), text = String(input?.text ?? "").trim();
    if (!title) throw new Error("Send a title.");
    if (!text) throw new Error("Send the text: what these commits do and why they go to master.");
    if (!Array.isArray(input.repos) || !input.repos.length) throw new Error("Send at least one repo with its commits.");
    if (input.db_changes !== undefined && !Array.isArray(input.db_changes)) throw new Error("Send db_changes as a list.");
    const db = (input.db_changes ?? []).map((d) => ({ database: String(d.database ?? ""), sql: String(d.sql ?? ""), why: String(d.why ?? "") }));
    if (db.some((d) => !d.database || !d.sql)) throw new Error("Each db_changes item needs a database and sql.");
    if (!ports.git.verifyCommits) throw new Error("This host cannot check commits, so it cannot make a port plan.");
    const known = new Set(ports.repos().map((r) => r.name)), seen = new Set<string>(), checked: { r: (typeof input.repos)[number]; base: string; commits: string[] }[] = [];
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "port";
    for (const r of input.repos) {
      const repo = String(r?.repo ?? "");
      if (!known.has(repo)) throw new Error(`"${repo}" is not a repo prflow can use.`);
      if (seen.has(repo)) throw new Error(`The repo ${repo} is listed twice.`);
      seen.add(repo);
      if (!Number.isFinite(r.order)) throw new Error(`Send a number in "order" for ${repo}.`);
      const commits = Array.isArray(r.commits) ? r.commits.map((c) => String(c).trim()) : [];
      if (!commits.length || commits.some((c) => !/^[0-9a-f]{7,40}$/i.test(c))) throw new Error(`${repo}: send "commits" as commit hashes (7 to 40 hex characters), oldest first.`);
      if (new Set(commits).size !== commits.length) throw new Error(`${repo}: a commit is listed twice.`);
      const uat = await ports.git.stagingBranch(repo), bad = await ports.git.verifyCommits(repo, uat, commits);
      if (bad) throw new Error(`${repo}: ${bad}`);
      checked.push({ r, base: uat, commits });
    }
    const seq = ++st.seq, id = `P-${String(seq).padStart(2, "0")}`; // no await from here: two calls never share an id
    const parts: Plan["repos"] = checked.map(({ r, base, commits }) => ({ repo: r.repo, base, branch: `prflow/${id.toLowerCase()}-${slug}`, dir: `${ports.stageRoot}/${id}/${r.repo}`, order: r.order, why: r.why?.trim() || undefined, stagingCommits: commits, staged: true })).sort((a, b) => a.order - b.order);
    const now = ctx.now(), order = Math.max(0, ...Object.values(st.plans).map((p) => p.order)) + 1, ticket = input.ticket?.trim().slice(0, 80);
    st.plans[id] = {
      id, title: title.slice(0, 120), text, versions: [{ n: 1, at: now, text, changes: [] }], pastedAt: now, order, kind: "port", acceptance: [], tasks: [], waves: 0, gates: {},
      steps: { plan: "done", tasks: "done", staging: "done", uat: "done", master: "" }, now: "Already merged and tested on staging; making the master PRs", tone: "", nowAt: now,
      started: true, startedAt: now, needsStart: false, slug, repos: parts, stagingPrs: [], masterPrs: [], ticket: ticket || undefined, ticketSetByYou: ticket ? true : undefined, dbChanges: db.length ? db : undefined,
    };
    ctx.ev(id, "plan_ported", { text: `Port plan made: ${parts.map((r) => `${r.repo} ${r.stagingCommits.length} commit(s)`).join(", ")} from staging to master`, repos: parts.map((r) => ({ repo: r.repo, commits: r.stagingCommits })) });
    ctx.change(); tick();
    return id;
  }

  // True when nothing runs or waits its turn for this plan: no action in flight, no retry waiting, nothing the
  // scheduler would start, no wait for another plan's file or a free slot. A host watchdog reads it to find a hang.
  function quiet(planId: string): boolean {
    const p = planOf(planId), keys = [...inflight];
    const mine = (k: string) => { const [kind, rest] = k.split(":"); return kind === "task" ? st.tasks[rest!]?.planId === p.id : rest === p.id; };
    if (keys.some(mine) || recovering.has(p.id) || p.retryAt || [...holds.values()].some((h) => h.planId === p.id)) return false;
    const ts = p.tasks.map((id) => st.tasks[id]).filter((t): t is NonNullable<typeof t> => !!t && t.status !== "removed");
    if (ts.some((t) => t.retryAt)) return false;
    if (nextActions(st, cfg, inflight).actions.some((a) => (a.kind === "task" ? st.tasks[a.task]?.planId : a.plan) === p.id)) return false;
    const waiting = ts.filter((t) => t.status === "waiting"), taskSlots = keys.filter((k) => k.startsWith("task:")).length;
    if (waiting.some((t) => t.waitsOn.length) || (waiting.length && taskSlots >= cfg.maxTasks)) return false;
    return !(p.steps.plan === "run" && keys.filter((k) => k.startsWith("plan:")).length >= cfg.maxPlanning);
  }

  function setWatchdog(planId: string, w: Plan["watchdog"], now?: { text: string; tone?: Plan["tone"] }): void {
    const p = planOf(planId);
    p.watchdog = w;
    if (now) setNow(ctx, p, now.text, now.tone ?? "");
    ctx.change();
  }

  function recover(): void {
    inflight.clear(); holds.clear(); tries.clear(); lastBeat = ctx.now();
    for (const r of Object.values(st.runs ?? {})) r.cut = true; // runs the restart ended: the next same call resumes each one
    for (const p of Object.values(st.plans)) { // a gate cut by a restart runs again; a gate whose wave has a task not done is not passed
      p.retryAt = undefined; p.gating = undefined;
      for (const w of Object.keys(p.gates).map(Number)) if (p.gates[w] && p.tasks.some((id) => st.tasks[id] && st.tasks[id]!.status !== "removed" && st.tasks[id]!.wave <= w && st.tasks[id]!.status !== "done")) p.gates[w] = false;
    }
    // A merge the user started carries on after a restart; it skips the PRs already merged.
    for (const p of Object.values(st.plans)) if (p.merging && p.steps.master === "you" && !p.error) { ctx.ev(p.id, "merge_resumed", { text: "The backend restarted; carrying on with your merge" }); launchMerge(p.id); }
    for (const t of Object.values(st.tasks)) if (t.retryAt) { t.retryAt = undefined; if (t.status === "waiting") t.sub = WAITING; }
    // A port plan whose master PRs were made before the final port review existed: run the master step again; it keeps the PRs and reviews once.
    for (const p of Object.values(st.plans)) if (p.kind === "port" && p.steps.master === "you" && !p.merging && !p.error && !p.finalReview && p.masterPrs.some((r) => r.state === "open")) { p.steps.master = ""; ctx.ev(p.id, "final_port_review_due", { text: "The backend restarted; the final port review runs once on the open master PRs" }); }
    if (!timer) { timer = setInterval(heartbeat, BEAT_MS); (timer as { unref?: () => void }).unref?.(); }
    for (const t of Object.values(st.tasks)) {
      if (t.status === "working" || t.status === "review") { t.status = "waiting"; t.sub = "Carries on after the restart"; ctx.ev(t.planId, "recovered", { task: t.id, text: `${t.label} carries on after the restart` }); }
    }
    backfillArchFindings(); backfillPlanFixes();
    void sweepDisk();
    ctx.change(); tick();
  }

  // After a restart: leftovers from before the clean-up existed. Live plans lose their folders, landed ones their task folders,
  // done tasks their build output. A failure is logged and costs only space.
  function backfillArchFindings(): void {
    for (const p of Object.values(st.plans)) {
      if (p.archFindings || p.steps.master === "done") continue;
      const runs = readEvents(ports.dataDir, p.id, Infinity).filter((e) => e.event === "architect_plan_review" && Array.isArray(e.findings));
      const kept = runs.map((e) => ({ at: e.at, findings: (e.findings as Finding[]).filter((f) => f.severity !== "blocking" || !(BLOCKING_CATEGORIES as readonly string[]).includes(f.category)) })).filter((r) => r.findings.length);
      if (kept.length) p.archFindings = kept;
    }
  }

  // Versions made from plan fixes before they were recorded: the fixes from the version's own update, the tasks from the events.
  function backfillPlanFixes(): void {
    const HEAD = "Changes to the plan from the task reviewers";
    for (const p of Object.values(st.plans)) {
      if (!p.planFixesSent?.length || p.steps.master === "done") continue;
      let found = false;
      for (const v of p.versions) {
        const update = v.text.split("\n## Update ").at(-1) ?? "";
        if (v.fixes || v.n === 1 || !update.includes(HEAD)) continue;
        v.fixes = update.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2)); found = true;
      }
      if (!found) continue;
      let lastResult: any;
      for (const e of readEvents(ports.dataDir, p.id, Infinity)) {
        if (e.event === "planner_result") lastResult = e;
        const v = e.event === "plan_applied" && typeof e.version === "number" ? p.versions[e.version - 1] : undefined;
        if (v?.fixes && !v.fixTasks) v.fixTasks = (lastResult?.tasks ?? []).filter((t: any) => t.action && t.action !== "keep").map((t: any) => String(t.label));
      }
    }
  }

  // cleanFinished: a finished plan (live, merged into its target, or staging-only and tested) loses its worktree folders once; branches stay.
  async function cleanFinishedPlans(): Promise<void> {
    for (const p of Object.values(st.plans)) {
      const done = p.steps.master === "done" || !!p.landedAt || (!!p.stagingOnly && p.steps.uat === "done");
      if (!done || p.cleanedAt || busy(p) || p.merging || p.steps.plan === "run") continue;
      p.cleanedAt = ctx.now(); // set first: a second tick must not start it again
      try { await dropPlanDirs(ctx, p, "Finished"); } catch (e) { console.error("[engine] clean-up failed:", e); }
      ctx.change();
    }
  }

  async function sweepDisk(): Promise<void> {
    try {
      for (const p of Object.values(st.plans)) {
        const root = `${ports.stageRoot}/${p.id}`;
        if (!existsSync(root) || !readdirSync(root).length) continue;
        if (p.steps.master === "done") await dropPlanDirs(ctx, p);
        else if (p.landedAt) await dropTaskDirs(ctx, p);
        else for (const id of p.tasks) { const t = st.tasks[id]; if (t?.status === "done") dropBuildOutput(t.dir); }
      }
    } catch (e) { console.error("[prflow] disk clean-up failed:", e); }
  }

  // ---- Terminal plans (/ship): a Claude Code session and its subagents do the Claude work; the engine runs the fixed steps.
  const termPlan = (planId: string): Plan => { const p = planOf(planId); if (!p.terminal) throw new Error(`${planId} is not a terminal plan.`); return p; };
  const termTask = (p: Plan, label: string) => { const t = st.tasks[`${p.id}/${label}`]; if (!t || t.status === "removed") throw new Error(`${p.id} has no task ${label}.`); return t; };

  // The plan the terminal made, registered and started at once: no planner, architect or Start click.
  async function adopt(r: PlannerResult, term: { session: string; cwd?: string }, opts: { text?: string; stagingOnly?: boolean } = {}): Promise<string> {
    const problems = validatePlan(r, ports.repos().map((x) => x.name));
    if (problems.length) throw new Error(`The plan has problems: ${problems.join("; ")}`);
    const text = opts.text?.trim() || r.title, seq = ++st.seq, id = `P-${String(seq).padStart(2, "0")}`, now = ctx.now();
    const order = Math.max(0, ...Object.values(st.plans).map((p) => p.order)) + 1;
    st.plans[id] = {
      id, title: r.title, text, versions: [{ n: 1, at: now, text, changes: [] }], pastedAt: now, order, acceptance: [], tasks: [], waves: 0, gates: {},
      steps: { plan: "", tasks: "", staging: "", uat: "", master: "" }, now: "Registered from the terminal", tone: "", nowAt: now,
      started: false, needsStart: false, slug: "", repos: [], stagingPrs: [], masterPrs: [], terminal: { session: term.session, cwd: term.cwd, at: now, agents: [] },
    };
    const p = st.plans[id]!;
    ctx.ev(id, "terminal_plan", { text: `Plan registered from the terminal session ${term.session.slice(0, 8)} (${r.tasks.length} tasks)`, session: term.session, cwd: term.cwd });
    await applyPlan(ctx, p, r, false);
    if (p.error) throw new Error(p.error);
    if (opts.stagingOnly) p.stagingOnly = true;
    start(id);
    return id;
  }

  // Delete on the page hides the plan: nothing stops and nothing is removed.
  function hide(planId: string): void {
    const p = planOf(planId);
    p.hidden = true;
    ctx.ev(p.id, "plan_hidden", { text: "Removed from the board. The plan, its worktrees and its terminal session stay." });
    ctx.change();
  }

  // An engine plan handed to a terminal session: from now on its Claude steps are that session's.
  function attach(planId: string, term: { session: string; cwd?: string }): void {
    const p = planOf(planId);
    if (p.steps.master === "done") throw new Error(`${planId} is already live.`);
    p.terminal = { ...(p.terminal ?? { agents: [] }), session: term.session, cwd: term.cwd, at: ctx.now(), agents: p.terminal?.agents ?? [] };
    if (p.watchdog?.state === "working" || p.watchdog?.state === "needs") p.watchdog = { ...p.watchdog, state: "done", doing: undefined, endedAt: ctx.now(), summary: "Handed to a terminal session" };
    ctx.ev(p.id, "terminal_plan", { text: `Handed to the terminal session ${term.session.slice(0, 8)}`, session: term.session, cwd: term.cwd });
    ctx.change();
  }

  // The current plan as a planner result, so a patch of a few tasks can be merged into it and checked like a re-plan.
  function asResult(p: Plan): PlannerResult {
    const live = p.tasks.map((id) => st.tasks[id]!).filter((t) => t && t.status !== "removed");
    return {
      title: p.title, ticket: p.ticket ?? "", target_branch: p.targetBranch ?? "", kind: (p.kind ?? "big") as PlannerResult["kind"], size_why: p.sizeWhy ?? "", contract: p.contract,
      acceptance: p.acceptance, architecture: p.architecture ?? { changes: false, why: "" }, uncovered: p.uncovered ?? [], db_changes: p.dbChanges ?? [], prod_gaps: p.prodGaps ?? [],
      repo_order: [...p.repos].sort((a, b) => a.order - b.order).map((r) => ({ repo: r.repo, why: r.why ?? "" })),
      tasks: live.map((t): PlannedTask => ({ label: t.label, title: t.title, repo: t.repo, wave: t.wave, deps: t.deps.map((d) => d.split("/").pop()!), files: t.files, size: t.size, part: t.part,
        what: t.what, checks: t.checks, bugs: t.bugs, review: t.review ?? true, review_why: t.reviewWhy ?? "", security: t.security, security_why: t.securityWhy ?? "", action: "keep" })),
    } as PlannerResult;
  }

  // A re-plan from the terminal: only the tasks that change (update, redo, reopen, add, remove); every other task keeps going.
  async function replanPatch(planId: string, patch: { tasks: (Partial<PlannedTask> & { label: string; action: NonNullable<PlannedTask["action"]> })[]; acceptance?: string[]; changes?: string[]; why?: string }): Promise<string[]> {
    const p = termPlan(planId), r = asResult(p);
    if (p.steps.plan === "run") throw new Error("A re-plan is already running.");
    for (const pt of patch.tasks ?? []) {
      const i = r.tasks.findIndex((t) => t.label === pt.label);
      if (pt.action === "add") { if (i >= 0) throw new Error(`${pt.label} already exists; use update.`); r.tasks.push(pt as PlannedTask); continue; }
      if (i < 0) throw new Error(`${p.id} has no task ${pt.label}.`);
      r.tasks[i] = { ...r.tasks[i]!, ...pt };
    }
    if (patch.acceptance?.length) r.acceptance = patch.acceptance;
    r.changes = patch.changes;
    const old = p.tasks.map((id) => st.tasks[id]!).filter((t) => t && t.status !== "removed");
    const problems = validatePlan(r, ports.repos().map((x) => x.name), { tasks: old, started: p.started });
    if (problems.length) throw new Error(`The patch has problems: ${problems.join("; ")}`);
    const now = ctx.now(), why = patch.why?.trim() || "Re-plan from the terminal";
    p.text = `${p.text}\n\n## Update ${p.versions.length + 1} (terminal)\n${why}`;
    p.versions.push({ n: p.versions.length + 1, at: now, text: p.text, changes: [] });
    ctx.ev(p.id, "terminal_replan", { text: `Terminal re-plan: ${patch.tasks.map((t) => `${t.label} ${t.action}`).join(", ")}. ${why}`, tasks: patch.tasks.map((t) => ({ label: t.label, action: t.action })) });
    await applyPlan(ctx, p, r, true);
    ctx.change(); tick();
    return p.changes ?? [];
  }

  // The terminal says a task is written and signed off: the engine merges it into the plan branch.
  function taskDone(planId: string, label: string, did: string): void {
    const p = termPlan(planId), t = termTask(p, label);
    if (t.status !== "working" || !t.terminal?.readyAt) throw new Error(`${label} is not waiting for the terminal (it is ${t.status}: ${t.sub}).`);
    t.terminal = { ...t.terminal, done: { did: did.trim() || "no summary", at: ctx.now() } };
    ctx.ev(p.id, "terminal_done", { task: t.id, text: `Terminal: ${label} is done; merging it into the plan branch`, did });
    ctx.change();
  }

  // One review round from the terminal's reviewer, for the task card, the findings list and the PR's minor list.
  function addRound(planId: string, label: string, r: Pick<Round, "blocking" | "minor"> & { by?: Round["by"]; reviewer?: Round["reviewer"]; fix?: string }): Round {
    const p = termPlan(planId), t = termTask(p, label);
    const norm = (fs: Finding[] | undefined, sev: Finding["severity"]) => (fs ?? []).map((f) => ({ ...f, severity: sev, category: f.category ?? (sev === "blocking" ? "correctness" : "other"), by: f.by ?? "code-reviewer" }));
    const round: Round = { n: t.rounds.length + 1, at: ctx.now(), source: "review", by: r.by?.length ? r.by : ["code-reviewer"], blocking: norm(r.blocking, "blocking"), minor: norm(r.minor, "minor"), reviewer: r.reviewer, fix: r.fix };
    t.rounds.push(round);
    t.sub = round.blocking.length ? `Review round ${round.n}: ${round.blocking.length} blocking; the terminal's executor is fixing` : `Review round ${round.n} (${round.reviewer ?? "review"}): clean`;
    ctx.ev(p.id, "terminal_round", { task: t.id, text: `${label} round ${round.n} (${round.reviewer ?? "review"}): ${round.blocking.length} blocking, ${round.minor.length} minor`, blocking: round.blocking, minor: round.minor });
    ctx.change();
    return round;
  }

  function sweepAnswer(planId: string, items: { n: number; still: boolean; level: string; why: string }[]): void {
    const p = termPlan(planId);
    if (!p.terminal!.sweep) throw new Error(`${planId} is not waiting for the last review.`);
    if (!Array.isArray(items) || !items.length) throw new Error("Send \"items\": one {n, still, level, why} per finding.");
    p.terminal!.sweep.answer = items.map((v) => ({ n: Number(v.n), still: !!v.still, level: ["harmful", "minor", "trivial"].includes(v.level) ? v.level : "minor", why: String(v.why ?? "") }));
    ctx.change();
  }

  function portAnswer(planId: string, ok: boolean, note?: string): void {
    const p = termPlan(planId);
    if (!p.terminal!.port) throw new Error(`${planId} is not waiting for a master port.`);
    p.terminal!.port.answer = { ok, note: note?.slice(0, 500) };
    ctx.change();
  }

  function uatAnswer(planId: string, a: TerminalTest): void {
    const p = termPlan(planId);
    if (!p.terminal!.uat) throw new Error(`${planId} is not waiting for a staging test.`);
    p.terminal!.uat.answer = { exercised: !!a.exercised, passed: !!a.passed, proof: String(a.proof ?? ""), checks: (a.checks ?? []).slice(0, 30) };
    ctx.change();
  }

  // Hook events and notes from the terminal session: what the master and each subagent do now.
  function terminalUpdate(planId: string, fn: (t: Terminal, p: Plan) => void, save = false): void {
    const p = st.plans[planId];
    if (!p?.terminal) return;
    fn(p.terminal, p);
    if (save) ctx.change(); else ctx.changeSoon();
  }

  return {
    state: (): State => st,
    events: (planId: string): PlanEvent[] => readEvents(ports.dataDir, planId, 200),
    log: (planId: string): string | null => readPlanLog(ports.dataDir, planId),
    submit, port, promote, setTarget, setStagingOnly, setUatSession, sendBackTask, decideMinor, queueEdit, editOrQueue, edit, start, stop, remove, retry, dbDone, fixAnyway, reorder, setTicket, keepCode, mergeMaster, watchMasterPrs, setReleaseSteps, tick, recover, heartbeat,
    note: (planId: string, event: string, extra: Record<string, unknown>) => { ctx.ev(planId, event, extra); ctx.change(); }, // a host action on the plan, for its log
    quiet, setWatchdog, sweep, inflightKeys: (): string[] => [...inflight],
    ev: (planId: string, event: string, extra: Record<string, unknown>) => { if (st.plans[planId]) ctx.ev(planId, event, extra); }, // a log line only, no save
    setHooks: (h: { error?: typeof errorHook; refreshed?: typeof refreshHook }) => { errorHook = h.error ?? null; refreshHook = h.refreshed ?? null; },
    adopt, attach, hide, replanPatch, taskDone, addRound, uatAnswer, sweepAnswer, portAnswer, terminalUpdate,
    config: cfg,
  };
}
export type Engine = ReturnType<typeof createEngine>;
