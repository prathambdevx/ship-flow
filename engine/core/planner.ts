// Plan and re-plan: planner run, validation, architect split review, then apply to State.
import { randomUUID } from "node:crypto";
import { BLOCKING_CATEGORIES, type Finding, type Plan, type PlannedTask, type PlannerResult, type Task } from "../types.ts";
import { agentBody } from "./agents.ts";
import { Transient } from "./errors.ts";
import { PLAN_SCHEMA, REVIEW_SCHEMA, planPrompt, planReposNote, planRetryPrompt, splitReviewPrompt } from "./prompts.ts";
import type { Ctx } from "./store.ts";
import { baseFor, targetProblem } from "./target.ts";
import { declineOpen, planRepoHeads } from "./worktrees.ts";
import { validatePlan } from "./validate.ts";

export function setNow(ctx: Ctx, p: Plan, text: string, tone: Plan["tone"] = "") { p.now = text; p.tone = tone; p.nowAt = ctx.now(); }

export function planError(ctx: Ctx, p: Plan, msg: string, step?: keyof Plan["steps"], askYou = false) {
  p.error = msg; p.askYou = askYou || undefined; if (step) p.steps[step] = "fail";
  setNow(ctx, p, msg, "bad");
  ctx.ev(p.id, "plan_error", { text: `Error: ${msg}`, error: msg, step });
  ctx.change();
  ctx.onPlanError?.(p, msg, step);
}

const slugify = (s: string) => s.toLowerCase().split("").map((c) => (/[a-z0-9]/.test(c) ? c : "-")).join("").split("-").filter(Boolean).join("-").slice(0, 40) || "plan";
const isBlocking = (f: { severity: string; category: string }) => f.severity === "blocking" && (BLOCKING_CATEGORIES as readonly string[]).includes(f.category);

// Planner steps in the UI list: 0 read pasted, 1 read code and data, 2 decide size, 3 split (big), 4 check (3 for small), 5 architect (big).
export async function runPlan(ctx: Ctx, planId: string): Promise<void> {
  const plan = ctx.st.plans[planId]!;
  plan.activity = []; plan.planStep = 0;
  try { await planInner(ctx, planId); }
  finally {
    const last = (plan.activity ?? []).slice(-5);
    plan.activity = undefined; plan.planStep = undefined;
    if (last.length) ctx.ev(plan.id, "planner_activity", { text: `Planner's last ${last.length} action(s)`, lines: last });
    ctx.change();
  }
}

// The planner or architect run now going for each plan, so Stop can end it.
export const planRuns = new Map<string, () => void>();

async function planInner(ctx: Ctx, planId: string): Promise<void> {
  const plan = ctx.st.plans[planId]!, ver = plan.versions.length;
  const stopped = () => !!plan.stopRequested || plan.versions.length !== ver; // an edit after Stop makes this run's answer stale
  const isEdit = plan.versions.length > 1;
  const oldTasks = plan.tasks.map((id) => ctx.st.tasks[id]).filter((t): t is Task => !!t && t.status !== "removed");
  const prevText = isEdit ? plan.versions[plan.versions.length - 2]!.text : "";
  const prev = isEdit ? { plan: { ...plan, text: prevText }, tasks: oldTasks } : undefined;
  const repoNames = ctx.ports.repos().map((r) => r.name);
  const vprev = isEdit ? { tasks: oldTasks, started: plan.started } : undefined;
  let session = randomUUID();

  const call = async (role: "planner" | "architect-reviewer", prompt: string, resume?: string, own?: string) => {
    const sid = own ?? session; // the architect gets its own session; the planner's id is already in use
    ctx.ev(plan.id, "claude_run_start", { text: `${role} is running`, role, sessionId: resume ?? sid });
    const onActivity = () => { if (role === "planner" && !plan.planStep) plan.planStep = 1; };
    const res = await ctx.ask({ role, prompt, schema: role === "planner" ? PLAN_SCHEMA : REVIEW_SCHEMA, plan: plan.id, onActivity, onStart: (k) => planRuns.set(plan.id, k), ...(resume ? { resumeId: resume } : { sessionId: sid }) })
      .finally(() => planRuns.delete(plan.id));
    if (role === "planner" && res.sessionId) { session = res.sessionId; if (res.ok) plan.plannerSession = { id: session, at: ctx.now() }; }
    ctx.ev(plan.id, "claude_run_end", { text: `${role} finished${res.ok ? "" : ` with an error: ${res.error ?? "no answer"}`}`, role, ok: res.ok, sessionId: res.sessionId ?? sid, error: res.error });
    return res;
  };
  const checkStep = (x: PlannerResult) => { plan.planStep = x.kind === "small" ? 3 : 4; ctx.change(); };
  const fail = (msg: string) => planError(ctx, plan, msg, "plan");

  setNow(ctx, plan, isEdit ? "Re-planning with your changes" : "Reading the text and planning");
  ctx.change();
  // A re-plan soon after the last one resumes that planner session, so it keeps what it read; a failed resume starts fresh.
  const last = isEdit && plan.plannerSession && ctx.now() - plan.plannerSession.at < ctx.cfg.plannerResumeMs ? plan.plannerSession.id : undefined;
  const first = planPrompt(plan.text, ctx.ports.repos(), prev) + (plan.started ? planReposNote(plan, await planRepoHeads(ctx, plan)) : "");
  let res = await call("planner", first, last);
  if (stopped()) return;
  if (last && (!res.ok || !res.structured)) {
    ctx.ev(plan.id, "planner_resume_failed", { text: `Resuming the last planner session failed (${res.error ?? "no result"}); starting a new one` });
    plan.plannerSession = undefined; session = randomUUID();
    res = await call("planner", first);
    if (stopped()) return;
  }
  if (!res.ok) throw new Transient(`The planner did not answer: ${res.error ?? "no result"}`);
  if (!res.structured) throw new Transient("The planner did not answer: no result"); // e.g. the stream cut by Mac sleep: retried on its own
  let r = res.structured as PlannerResult;
  const summary = (x: PlannerResult) => ({ kind: x.kind, size_why: x.size_why, tasks: x.tasks.map((t) => ({ label: t.label, repo: t.repo, wave: t.wave, deps: t.deps, files: t.files, action: t.action })), triage: x.triage, changes: x.changes, repo_order: x.repo_order, uncovered: x.uncovered, db_changes: x.db_changes });
  plan.planStep = 3; ctx.change();
  ctx.ev(plan.id, "planner_result", { text: `Planner returned a ${r.kind} plan with ${r.tasks.length} task(s)`, ...summary(r) });

  const recheck = async (prompt: string): Promise<string | null> => {
    res = await call("planner", prompt, session);
    if (stopped()) return "stopped";
    if (!res.ok) throw new Transient(`The planner did not answer: ${res.error ?? "no result"}`);
    if (!res.structured) throw new Transient("The planner did not answer: no result");
    r = res.structured as PlannerResult;
    ctx.ev(plan.id, "planner_result", { text: `Planner returned a corrected ${r.kind} plan with ${r.tasks.length} task(s)`, ...summary(r) });
    checkStep(r);
    const again = validatePlan(r, repoNames, vprev);
    ctx.ev(plan.id, "plan_validated", { text: again.length ? `The corrected plan still has ${again.length} problem(s)` : "The corrected plan is valid", problems: again });
    return again.length ? `The plan still has problems: ${again.join("; ")}` : null;
  };

  checkStep(r);
  const problems = validatePlan(r, repoNames, vprev);
  ctx.ev(plan.id, "plan_validated", { text: problems.length ? `The plan has ${problems.length} problem(s); the planner gets one retry` : "The plan is valid", problems });
  if (problems.length) {
    const bad = await recheck(planRetryPrompt(problems));
    if (stopped()) return;
    if (bad) return fail(bad);
  }

  const arch = needsArchitect(r.kind, r.architecture, r.tasks.filter((t) => t.action !== "remove"), ctx.cfg);
  if (r.kind === "big" && !arch.run) ctx.ev(plan.id, "architect_skipped", { text: `Architect skipped on the split: ${arch.why}` });
  // A re-plan gets the split check only for a major change (see replanMajor); a first plan always does.
  const major = replanMajor(ctx.st, plan, r, isEdit);
  if (r.kind === "big" && arch.run && !major.major) ctx.ev(plan.id, "architect_skipped", { text: `Architect skipped on this re-plan: ${major.why}`, rule: major.why });
  if (r.kind === "big" && arch.run && major.major) {
    plan.planStep = 5; ctx.change();
    const rev = await call("architect-reviewer", `${agentBody("architect-reviewer")}\n\n---\n${splitReviewPrompt(r)}`, undefined, randomUUID());
    if (stopped()) return;
    if (!rev.ok || !rev.structured) throw new Transient(`The architect-reviewer did not answer: ${rev.error ?? "no result"}`); // never count a failed review as clean
    const findings: Finding[] = ((rev.structured?.findings ?? []) as Omit<Finding, "by">[]).map((f) => ({ ...f, by: "architect-reviewer" as const }));
    const blocking = findings.filter(isBlocking);
    ctx.ev(plan.id, "architect_split_review", { text: `Architect reviewed the split: ${blocking.length} blocking, ${findings.length - blocking.length} minor`, findings });
    if (blocking.length) {
      const bad = await recheck(planRetryPrompt(blocking.map((f) => `The architect found: ${f.text}`)));
      if (stopped()) return;
      if (bad) return fail(bad);
    }
  }
  await applyPlan(ctx, plan, r, isEdit);
}

// A re-plan is major (the architect checks the split) when it adds or removes a task, changes the contract, or changes more than 2 existing tasks.
export const MAX_SMALL_CHANGES = 2;
export function replanMajor(st: Ctx["st"], plan: Plan, r: PlannerResult, isEdit: boolean): { major: boolean; why: string } {
  if (!isEdit) return { major: true, why: "a first plan" };
  const live = new Map(plan.tasks.map((id) => st.tasks[id]).filter((t): t is Task => !!t && t.status !== "removed").map((t) => [t.label, t]));
  const planned = new Set(r.tasks.filter((t) => t.action !== "remove").map((t) => t.label));
  const added = r.tasks.filter((t) => t.action === "add" || (t.action !== "remove" && !live.has(t.label))).length;
  const removed = r.tasks.filter((t) => t.action === "remove" && live.has(t.label)).length + [...live.keys()].filter((l) => !r.tasks.some((t) => t.label === l)).length;
  if (added || removed) return { major: true, why: `${added} task(s) added, ${removed} removed` };
  if ((r.contract ?? "").trim() !== (plan.contract ?? "").trim()) return { major: true, why: "the contract changed" };
  const changed = r.tasks.filter((t) => { const ex = live.get(t.label); return !!ex && planned.has(t.label) && (plan.started ? ["update", "redo", "reopen"].includes(t.action ?? "keep") : !sameFields(ex, fieldsOf(plan.id, t))); }).length;
  if (changed > MAX_SMALL_CHANGES) return { major: true, why: `${changed} existing tasks changed (more than ${MAX_SMALL_CHANGES})` };
  return { major: false, why: `no task added or removed, contract unchanged, ${changed} existing task(s) changed (limit ${MAX_SMALL_CHANGES})` };
}

const sameFields = (t: Task, f: ReturnType<typeof fieldsOf>) => JSON.stringify([t.title, t.repo, t.wave, t.deps, t.files, t.size, t.part, t.what, t.checks, t.security]) === JSON.stringify([f.title, f.repo, f.wave, f.deps, f.files, f.size, f.part, f.what, f.checks, f.security]);
const fieldsOf = (planId: string, pt: PlannedTask) => ({
  title: pt.title, repo: pt.repo, wave: pt.wave, deps: pt.deps.map((d) => `${planId}/${d}`), files: [...pt.files], size: pt.size,
  part: pt.part, what: pt.what, checks: pt.checks, bugs: pt.bugs, review: pt.review, reviewWhy: pt.review_why, security: pt.security, securityWhy: pt.security_why,
});

function newTask(planId: string, pt: PlannedTask, isNew: boolean): Task {
  return { id: `${planId}/${pt.label}`, planId, label: pt.label, ...fieldsOf(planId, pt), status: "draft", sub: "Planned · not started", isNew: isNew || undefined, notes: [], waitsOn: [], rounds: [], commits: [] };
}

export async function applyPlan(ctx: Ctx, plan: Plan, r: PlannerResult, isEdit: boolean): Promise<void> {
  const { st, ports } = ctx;
  const started = plan.started;
  const old = plan.tasks.map((id) => st.tasks[id]).filter((t): t is Task => !!t);
  const prevRemoved = new Set(old.filter((t) => t.status === "removed").map((t) => t.id));
  for (const t of old) { t.isNew = undefined; t.changed = undefined; }
  if (r.ticket?.trim() && !plan.ticketSetByYou) plan.ticket = r.ticket.trim().slice(0, 80);
  plan.architecture = r.architecture;
  plan.uncovered = r.uncovered?.length ? r.uncovered : undefined; plan.dbChanges = r.db_changes?.length ? r.db_changes : undefined; plan.prodGaps = r.prod_gaps?.length ? r.prod_gaps : undefined;
  plan.title = r.title; plan.kind = r.kind; plan.sizeWhy = r.size_why; plan.contract = r.contract; plan.acceptance = r.acceptance;
  if (!plan.slug) plan.slug = slugify(r.title);
  // The target branch follows the text until you set it; a started plan keeps the branch its code is already on.
  const want = r.target_branch?.trim() ?? "";
  let badTarget: string | null = null;
  if (!started && !plan.targetSetByYou && want !== (plan.targetBranch ?? "")) {
    plan.targetBranch = want || undefined;
    ctx.ev(plan.id, "target_set", { text: want ? `The plan says not to go to staging: it merges into ${want}` : "No target branch: the plan goes to staging", branch: want, by: "planner" });
  }
  if (!started && plan.targetBranch) badTarget = await targetProblem(ctx, plan.targetBranch, r.repo_order.map((x) => x.repo)); // a bad name stops the plan before Start
  if (started && want !== (plan.targetBranch ?? "") && !plan.targetSetByYou) ctx.ev(plan.id, "target_kept", { text: `The planner read the target branch as "${want || "staging"}"; the started plan keeps ${plan.targetBranch ?? "staging"}`, branch: want });

  let resetFrom = Infinity;
  const touch = (w: number) => { resetFrom = Math.min(resetFrom, w); };
  const seen = new Set<string>();
  const redoQueue: Task[] = [];
  for (const pt of r.tasks) {
    const id = `${plan.id}/${pt.label}`;
    seen.add(id);
    const ex = st.tasks[id];
    const fields = fieldsOf(plan.id, pt);
    if (!started) {
      if (!ex || ex.status === "removed") { st.tasks[id] = newTask(plan.id, pt, isEdit); continue; }
      ex.changed = isEdit && !sameFields(ex, fields) ? true : undefined;
      Object.assign(ex, fields);
      continue;
    }
    if (!ex) { st.tasks[id] = newTask(plan.id, pt, true); touch(pt.wave); continue; }
    let action = pt.action ?? "keep";
    if (action === "add") action = "keep";
    const done = ex.status === "done";
    if (done && (action === "update" || action === "redo" || action === "remove")) action = "reopen";
    if (action === "reopen" && !done) action = "update";
    const note = pt.note ?? (action === "reopen" && pt.action === "remove" ? "This task is no longer needed: undo its work." : undefined);
    const act = (name: string, text: string) => ctx.ev(plan.id, name, { task: ex.id, text: `${ex.label}: ${text}`, note, wasStatus: ex.status });
    if (action === "keep") continue;
    if (action === "update") { if (note) ex.notes.push(note); ex.changed = true; act("task_update", `update for the running or waiting task${note ? `: ${note}` : ""}`); continue; }
    if (action === "reopen") {
      if (note) ex.notes.push(note);
      for (const f of pt.files) if (!ex.files.includes(f)) ex.files.push(f);
      ex.status = "draft"; ex.sub = "Reopened · waits for Start"; ex.doneAt = undefined; ex.changed = true; touch(ex.wave);
      act("task_reopen", `reopened${note ? `: ${note}` : ""}`);
      continue;
    }
    if (action === "remove") { act("task_remove", "removed"); stopTask(ex); ex.status = "removed"; ex.sub = "Removed by the edit"; redoQueue.push(ex); continue; }
    if (action === "redo") {
      act("task_redo", "stopped and reset to the plan branch");
      stopTask(ex);
      Object.assign(ex, fields);
      Object.assign(ex, { status: "draft", sub: "Planned again · waits for Start", rounds: [], commits: [], sessionId: undefined, did: undefined, stat: undefined, error: undefined, startedAt: undefined, doneAt: undefined, changed: true });
      redoQueue.push(ex); touch(ex.wave);
    }
  }
  if (!started) for (const t of old) if (!seen.has(t.id)) { t.status = "removed"; t.sub = "Removed by the edit"; t.isNew = undefined; t.changed = undefined; }
  // Worktrees of redone or removed tasks are dropped so a new run starts from the plan branch.
  for (const t of redoQueue) if (t.dir) { const dir = t.dir; t.dir = undefined; t.branch = undefined; try { await ports.git.drop(t.repo, dir); } catch { /* already gone */ } }

  plan.tasks = [...r.tasks.map((t) => `${plan.id}/${t.label}`), ...plan.tasks.filter((id) => !seen.has(id))];
  const live = plan.tasks.map((id) => st.tasks[id]!).filter((t) => t.status !== "removed");
  plan.waves = Math.max(0, ...live.map((t) => t.wave));
  if (!started) plan.gates = {};

  const parts = [];
  for (const [i, ro] of r.repo_order.entries()) {
    const ex = plan.repos.find((p) => p.repo === ro.repo);
    if (ex) { ex.order = i + 1; ex.why = ro.why; if (!started) ex.base = await baseFor(ctx, plan, ro.repo); parts.push(ex); continue; }
    parts.push({ repo: ro.repo, base: await baseFor(ctx, plan, ro.repo), branch: `prflow/${plan.id.toLowerCase()}-${plan.slug}`, dir: `${ports.stageRoot}/${plan.id}/${ro.repo}`, order: i + 1, why: ro.why, stagingCommits: [] });
  }
  plan.repos = parts;
  plan.triage = r.triage?.map((row) => ({ n: row.n, text: row.text, task: row.task, leftOut: row.verdict ? { verdict: row.verdict, why: row.why ?? "", fixAnyway: plan.triage?.find((x) => x.n === row.n)?.leftOut?.fixAnyway } : undefined }));

  const labelOf = (t: Task) => `${t.label} ${t.title}`;
  const derived = isEdit ? [
    ...live.filter((t) => t.isNew).map((t) => `New: ${labelOf(t)}.`),
    ...live.filter((t) => t.changed && !t.isNew).map((t) => `Changed: ${labelOf(t)}.`),
    ...plan.tasks.map((id) => st.tasks[id]!).filter((t) => t.status === "removed" && !prevRemoved.has(t.id)).map((t) => `Removed: ${labelOf(t)}.`),
  ] : [];
  plan.changes = r.changes?.length ? r.changes : derived;
  if (isEdit) plan.versions[plan.versions.length - 1]!.changes = plan.changes;
  if (isEdit && started) plan.versions[plan.versions.length - 1]!.fixTasks = r.tasks.filter((t) => t.action && t.action !== "keep").map((t) => t.label);

  plan.error = undefined; plan.askYou = undefined;
  const drafts = live.filter((t) => t.status === "draft").length;
  if (!started) {
    plan.steps.plan = "you"; plan.needsStart = true;
    setNow(ctx, plan, `Planned: ${live.length} task${live.length === 1 ? "" : "s"} in ${plan.waves} wave${plan.waves === 1 ? "" : "s"}. Nothing runs until you press Start.`);
  } else {
    for (let w = resetFrom; w <= plan.waves; w++) plan.gates[w] = false;
    if (drafts) {
      // Only the first Start is yours: after it, every re-plan queues its new, reopened and redone tasks by itself.
      const queued = live.filter((t) => t.status === "draft");
      for (const t of queued) { t.status = "waiting"; t.sub = "Waiting for its turn"; }
      plan.needsStart = false; plan.steps.plan = "done";
      plan.steps.tasks = "run"; plan.steps.staging = ""; plan.steps.uat = ""; plan.steps.master = "";
      await declineOpen(ctx, plan.id, plan.masterPrs, "master"); plan.masterPrs = [];
      await declineOpen(ctx, plan.id, plan.stagingPrs, "staging");
      for (const r of plan.repos) r.staged = false;
      plan.landedAt = undefined; plan.cleanedAt = undefined;
      setNow(ctx, plan, `Plan changed: ${queued.map((t) => t.label).join(", ")} queued. Running tasks keep going.`);
      ctx.ev(plan.id, "started", { text: `Started by the re-plan: ${queued.map((t) => t.label).join(", ")} queued`, tasks: queued.map((t) => t.label), auto: true });
    } else { plan.steps.plan = "done"; setNow(ctx, plan, "Plan changed. Running tasks keep going."); }
  }
  for (const id of plan.tasks) { const t = ctx.st.tasks[id]; if (t && !plan.planFixHolds?.includes(id)) t.heldForPlan = undefined; } // its own update landed; only tasks of still-queued fixes stay held
  const ov = findOverlaps(ctx, plan);
  plan.overlaps = ov.length ? ov : undefined;
  if (ov.length) {
    const line = overlapLines(ov).join(" ");
    ctx.ev(plan.id, "plan_overlap", { text: line, overlaps: ov });
    plan.now = `${plan.now} ${line}`;
  }
  ctx.ev(plan.id, "plan_applied", {
    text: isEdit ? `Plan updated to version ${plan.versions.length}. ${plan.changes.join(" ")}` : `Plan made: ${live.length} task(s), ${plan.waves} wave(s)`,
    version: plan.versions.length, changes: plan.changes, tasks: live.map((t) => ({ label: t.label, status: t.status, isNew: t.isNew, changed: t.changed })),
    repos: plan.repos.map((p) => ({ repo: p.repo, base: p.base, branch: p.branch, dir: p.dir, order: p.order })), triage: plan.triage,
  });
  ctx.change();
  if (started && !live.length) planError(ctx, plan, "Every task was removed. Edit the plan or remove it.", "plan");
  else if (badTarget) planError(ctx, plan, `The target branch ${plan.targetBranch} cannot be used: ${badTarget} Set another target branch on the plan (or none for staging), then press Start.`, "plan", true);
}

// Repo + file pairs this plan's tasks share with the tasks of every other plan that is not live yet. A code check, no Claude call.
export function findOverlaps(ctx: Ctx, plan: Plan): NonNullable<Plan["overlaps"]> {
  const mine = new Map<string, Set<string>>(); // repo -> files
  const live = (p: Plan) => p.tasks.map((id) => ctx.st.tasks[id]).filter((t): t is Task => !!t && t.status !== "removed");
  for (const t of live(plan)) { const s = mine.get(t.repo) ?? new Set(); for (const f of t.files) s.add(f); mine.set(t.repo, s); }
  const out: NonNullable<Plan["overlaps"]> = [];
  for (const o of Object.values(ctx.st.plans).sort((a, b) => a.order - b.order)) {
    if (o.id === plan.id || o.steps.master === "done" || o.landedAt) continue;
    const by = new Map<string, Set<string>>();
    for (const t of live(o)) for (const f of t.files) if (mine.get(t.repo)?.has(f)) { const s = by.get(t.repo) ?? new Set(); s.add(f); by.set(t.repo, s); }
    for (const [repo, files] of by) out.push({ plan: o.id, repo, files: [...files].sort() });
  }
  return out;
}

export function overlapLines(ov: NonNullable<Plan["overlaps"]>): string[] {
  const byPlan = new Map<string, { repo: string; files: string[] }[]>();
  for (const o of ov) byPlan.set(o.plan, [...(byPlan.get(o.plan) ?? []), o]);
  return [...byPlan].map(([id, rows]) => {
    const n = rows.reduce((a, r) => a + r.files.length, 0), list = rows.flatMap((r) => r.files.map((f) => `${r.repo}/${f}`));
    return `Shares ${n} file${n === 1 ? "" : "s"} with ${id} (${list.slice(0, 5).join(", ")}${list.length > 5 ? ", ..." : ""}): run it after ${id}, or expect its master PR to be refreshed after ${id} merges.`;
  });
}

// A running task sees stopRequested and ends without touching the task again.
function stopTask(t: Task) { if (t.status === "working" || t.status === "review") t.stopRequested = true; }

// The architect runs on a big plan only when the planner says its design is big or concerning; size alone never does (21/10/2026).
export function needsArchitect(kind: string | undefined, a: { changes: boolean; why: string } | undefined, tasks: { repo: string; files: string[] }[], cfg: { architectFiles: number; architectRepos: number }): { run: boolean; why: string } {
  const files = new Set(tasks.flatMap((t) => t.files.map((f) => `${t.repo}/${f}`))).size, repos = new Set(tasks.map((t) => t.repo)).size;
  const size = `${files} file${files === 1 ? "" : "s"}, ${repos} repo${repos === 1 ? "" : "s"}`;
  if (kind !== "big") return { run: false, why: `not a big plan (${size})` };
  if (a?.changes) return { run: true, why: `design change: ${a.why}` };
  return { run: false, why: `no design change, ${size}` };
}
