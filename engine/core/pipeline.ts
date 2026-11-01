// Plan steps after the tasks: wave gate, staging, staging test, master PRs and merge master.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { BLOCKING_CATEGORIES, type TerminalTest, type Finding, type Plan, type PrRef, type ReleaseRun, type RepoPart, type Task } from "../types.ts";
import { agentBody } from "./agents.ts";
import { Transient } from "./errors.ts";
import { allMinors, carriedMinors, sweepKey } from "./minors.ts";
import { needsArchitect, planError, setNow } from "./planner.ts";
import { dropNetZero } from "./netzero.ts";
import { findLibVersions, onlyVersionLines, pinVersions, type LibPin } from "./libs.ts";
import { EXEC_SCHEMA, FINAL_PORT_SCHEMA, FIX_SCHEMA, PR_SCHEMA, REVIEW_SCHEMA, SWEEP_SCHEMA, WHOLE_PLAN_DIFF, archFollowUpPrompt, debugPrompt, finalPortReviewPrompt, fixPrompt, portPrompt, portReviewPrompt, prWritePrompt, reviewPrompt, sweepPrompt } from "./prompts.ts";
import { readEvents, type Ctx } from "./store.ts";
import { groupOf, runGroup } from "./release.ts";
import { parseRunLog, type RunLog } from "./runlog.ts";
import { sendBack } from "./task.ts";
import { ensureTarget } from "./target.ts";
import { declineOpen, dropPlanDirs, dropTaskDirs, ensureDir, installPlanLibs, planLock, planRepoHeads, resetDir, wholeGuard } from "./worktrees.ts";

class Halt extends Error {}
interface Extra { sendBacks: number; architect: boolean; stagedRepos: string[] }
const extra = (p: Plan): Extra => ((p as any)._x ??= { sendBacks: 0, architect: false, stagedRepos: [] });
const liveTasks = (ctx: Ctx, p: Plan) => p.tasks.map((id) => ctx.st.tasks[id]!).filter((t) => t && t.status !== "removed");
const ordered = (p: Plan) => [...p.repos].sort((a, b) => a.order - b.order);
const prTag = (p: Plan) => `[${p.ticket ? `${p.ticket} · ` : ""}${p.id}]`; // ticket and plan number, e.g. [BOM-10046 · P-01]
export const prTitle = (p: Plan) => `${prTag(p)} ${p.title}`;
export const DONE_ON_STAGING = "Done on staging: deployed and tested. Staging only, so no master PRs (its go-live is done later).";
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function prBody(p: Plan, tasks: Task[], tail: string[]): string {
  if (p.kind === "port" || p.kind === "promote") return [p.title, "", p.text.slice(0, 3000), "", ...tail].join("\n"); // no tasks
  const minors = new Set<string>();
  for (const t of tasks) { const last = [...t.rounds].reverse().find((r) => r.source === "review" && r.by.includes("code-reviewer")); for (const f of last?.minor ?? []) minors.add(`${f.text}${f.file ? ` (${f.file})` : ""}`); }
  return [p.title, "", "What changed:", ...tasks.map((t) => `- ${t.label} ${t.title}: ${t.did ?? "no summary"}`),
    ...(minors.size ? ["", "Minor findings not fixed:", ...[...minors].map((m) => `- ${m}`)] : []), "", ...tail].join("\n");
}

// Title and description in the host's house style (a read-only writer run); the plain list when there is no style or it fails.
export async function writePr(ctx: Ctx, p: Plan, repo: string, dest: string, tasks: Task[], diff: string, tail: string[]): Promise<{ title: string; body: string }> {
  const plain = { title: prTitle(p), body: prBody(p, tasks, tail) };
  const style = ctx.ports.prStyle?.();
  if (!style) return plain;
  try {
    const res = await ctx.ask({ role: "executor", prompt: prWritePrompt(style, p, repo, dest, plain.body, diff), schema: PR_SCHEMA, sessionId: randomUUID(), plan: p.id });
    const t = String(res.structured?.title ?? "").trim(), d = String(res.structured?.description ?? "").trim();
    if (!res.ok || !t || !d) return plain;
    ctx.ev(p.id, "pr_written", { text: `${repo}: PR text written in the house style ("${t}")`, repo, dest });
    return { title: `${prTag(p)} ${t}`, body: d };
  } catch { return plain; }
}

const guarded = (ctx: Ctx, p: Plan) => async <T>(v: Promise<T>): Promise<T> => { const r = await v; if (p.stopRequested) throw new Halt(); return r; };

// Builds each repo worktree; a failed build goes to the debugger, up to `tries` times. Returns the tail when it still fails.
async function buildParts(ctx: Ctx, p: Plan, parts: RepoPart[], tries: number, label: string): Promise<string | null> {
  const g = guarded(ctx, p);
  for (const part of parts) {
    let dropped = false;
    for (let fix = 0; ; fix++) {
      if (!label.startsWith("Master")) await g(installPlanLibs(ctx, p, part.repo, part.dir)); // master builds use released libraries
      const b = await g(ctx.ports.build(part.dir));
      ctx.ev(p.id, "build", { text: `${label}: build of ${part.repo} ${b.ok ? "passed" : b.ran ? "failed" : "did not run"}`, repo: part.repo, ok: b.ok, ran: b.ran, tail: b.tail.slice(0, 2000) });
      if (b.ok || !b.ran) break;
      // On master, a test this plan added that master can't compile (no test setup there) is left out: it ran on staging.
      if (label === "Master" && ctx.ports.git.existsAt && !dropped) {
        const changed = await g(ctx.ports.git.changedFiles(part.dir, `origin/${part.base}`));
        const tests: string[] = [];
        for (const f of changed) if (/(^|\/)src\/test\//.test(f) && b.tail.includes(f) && !(await ctx.ports.git.existsAt(part.dir, `origin/${part.base}`, f))) tests.push(f);
        if (tests.length) {
          dropped = true;
          for (const f of tests) rmSync(join(part.dir, f), { force: true });
          await g(ctx.ports.git.commitAll(part.dir, `[${p.id}] leave out tests ${part.base} cannot compile (they ran on staging)`));
          ctx.ev(p.id, "master_tests_dropped", { text: `${part.repo}: left out ${tests.length} plan test(s) that ${part.base} cannot compile: ${tests.join(", ")}`, repo: part.repo, files: tests });
          fix--; continue;
        }
      }
      if (fix >= tries || p.terminal) return b.tail.slice(-1500); // a terminal plan: the terminal fixes the build
      const sid = randomUUID();
      ctx.ev(p.id, "debugger_start", { text: `debugger (${cap(ctx.cfg.models.debugger)}) is fixing the ${part.repo} build (try ${fix + 1} of ${tries})`, sessionId: sid });
      // Whatever way the debugger ends, its edits are committed or dropped: the worktree is never left dirty.
      let d: Awaited<ReturnType<Ctx["ask"]>>;
      try {
        d = await ctx.ask({ role: "debugger", prompt: debugPrompt(agentBody("debugger"), `the ${part.repo} plan branch (${label})`, b.tail.slice(-6000), label === "Master"), schema: FIX_SCHEMA, edits: [part.dir], sessionId: sid, plan: p.id });
        if (d.ok && !p.stopRequested) await ctx.ports.git.commitAll(part.dir, `[${p.id}] build fix (${label})`);
        else await resetDir(ctx, p.id, part.repo, part.dir, part.branch, d.ok ? "stopped" : "debugger failed");
      } catch (e) {
        await resetDir(ctx, p.id, part.repo, part.dir, part.branch, "error").catch(() => {});
        throw e;
      }
      if (p.stopRequested) throw new Halt();
      ctx.ev(p.id, "debugger_end", { text: `debugger finished: ${d.structured?.summary ?? d.error ?? "no summary"}`, ok: d.ok, sessionId: d.sessionId ?? sid, summary: d.structured?.summary });
      if (!d.ok) throw new Transient(`The debugger failed: ${d.error ?? "no result"}`);
    }
  }
  return null;
}

export async function runGate(ctx: Ctx, planId: string, wave: number): Promise<void> {
  const p = ctx.st.plans[planId]!;
  try {
    // buildEachTask off: earlier waves pass without a build; the last wave's gate builds every repo the plan changed, once.
    const lastWave = Math.max(...liveTasks(ctx, p).map((t) => t.wave)), finalOnly = !ctx.cfg.buildEachTask;
    if (finalOnly && wave < lastWave) {
      p.gates[wave] = true;
      ctx.ev(p.id, "gate", { text: `Wave ${wave} gate passed without a build (only the last wave builds each repo)`, wave, ok: true, skipped: true });
      ctx.change(); return;
    }
    const repos = new Set(liveTasks(ctx, p).filter((t) => (finalOnly ? t.wave <= wave : true) && t.status === "done").map((t) => t.repo)), all = ordered(p).filter((x) => repos.has(x.repo));
    // A repo at the same commit as its last passing gate build (and the plan's libraries too) needs no new build.
    const libs = new Set(ctx.ports.libs?.names() ?? []), headOf = (dir: string) => ctx.ports.git.head(dir).catch(() => "none");
    const libHeads = (await Promise.all(p.repos.filter((r) => libs.has(r.repo)).map(async (r) => `${r.repo}@${await headOf(r.dir)}`))).sort().join(",");
    const keys = new Map(await Promise.all(all.map(async (x) => [x.repo, `${await headOf(x.dir)}|${libHeads}`] as const)));
    const list = all.filter((x) => p.gateBuilt?.[x.repo] !== keys.get(x.repo)), same = all.length - list.length;
    ctx.ev(p.id, "gate_start", { text: `Wave ${wave} gate started: full build and all tests of ${list.length} repo${list.length === 1 ? "" : "s"}, with every task's change together${same ? ` (${same} unchanged since their last passing build)` : ""}`, wave, repos: list.map((x) => x.repo), unchanged: all.filter((x) => !list.includes(x)).map((x) => x.repo) });
    for (const [i, part] of list.entries()) {
      p.gating = { wave, repo: part.repo, i: i + 1, n: list.length };
      setNow(ctx, p, finalOnly ? `Tests are running: ${part.repo}, every task's change together (${i + 1} of ${list.length})` : `Wave ${wave} gate: building ${part.repo} with every task's change together (${i + 1} of ${list.length})`); ctx.change();
      const bad = await planLock(ctx, p.id, part.repo, async () => { await ensureDir(ctx, p.id, part.repo, part.dir, part.branch); return buildParts(ctx, p, [part], finalOnly ? Math.max(2, ctx.cfg.maxBuildFixes) : 2, `Wave ${wave} gate`); });
      if (bad) return planError(ctx, p, `Wave ${wave} gate: the build fails: ${bad}`, "tasks");
      p.gateBuilt = { ...p.gateBuilt, [part.repo]: keys.get(part.repo)! };
    }
    const back = liveTasks(ctx, p).filter((t) => t.wave <= wave && t.status !== "done"); // sent back while the gate ran
    if (back.length) { ctx.ev(p.id, "gate_outdated", { text: `Wave ${wave} gate passed, but ${back.map((t) => t.label).join(", ")} went back meanwhile; it runs again when they are done`, wave }); return; }
    p.gates[wave] = true;
    setNow(ctx, p, `Wave ${wave} gate: full build and all tests pass`);
    ctx.ev(p.id, "gate", { text: `Wave ${wave} gate passed`, wave, ok: true });
    ctx.change();
  } catch (e) { if (!(e instanceof Halt)) throw e; ctx.ev(p.id, "stopped", { text: `Wave ${wave} gate stopped` }); }
  finally { if (p.gating) { p.gating = undefined; ctx.change(); } }
}

export async function runStaging(ctx: Ctx, planId: string): Promise<void> {
  const { ports } = ctx;
  const p = ctx.st.plans[planId]!, x = extra(p), g = guarded(ctx, p);
  try {
    // A later fix after the plan passed its end reviews goes straight to staging: the architect looks again
    // only to check its own findings it sent back; a clean architect review stays done.
    if (p.steps.staging === "") { x.stagedRepos = []; if (!p.archReview || p.archReview.findings.length) x.architect = false; }
    if (p.terminal) x.architect = true; // a terminal plan's sign-off is the terminal's own
    p.steps.staging = "run"; p.steps.tasks = "done"; p.landedAt = undefined;
    const target = p.targetBranch, into = target ?? "staging"; // a target plan merges into its branch: no deploy, staging test or master PR
    setNow(ctx, p, p.kind === "big" && !x.architect && needsArchitect(p.kind, p.architecture, liveTasks(ctx, p), ctx.cfg).run ? `architect-reviewer (Opus) is reading the whole plan before anything goes to ${into}` : `Getting ready to merge to ${into}`); ctx.ev(p.id, "staging_start", { text: target ? `Merge into ${target} started` : "Staging started", resumed: x.stagedRepos.length > 0, target }); ctx.change();

    const arch = needsArchitect(p.kind, p.architecture, liveTasks(ctx, p), ctx.cfg);
    if (p.kind === "big" && !x.architect && !arch.run) { x.architect = true; ctx.ev(p.id, "architect_skipped", { text: `Architect skipped on the plan diff: ${arch.why}` }); }
    if (p.kind === "big" && !x.architect) {
      for (const r of ordered(p)) await ensureDir(ctx, p.id, r.repo, r.dir, r.branch);
      const repos = await planRepoHeads(ctx, p);
      let res: Awaited<ReturnType<typeof ctx.ask>> | undefined, sid = "";
      const last = p.archReview;
      if (last) {
        // A later review resumes its own session: its findings, what each writer did, and only the change since it last looked.
        const since = (await Promise.all(ordered(p).map(async (r) => { const d = await ports.git.diff(r.dir, last.heads[r.repo] ?? `origin/${r.base}`).catch(() => ""); return d.trim() ? `## ${r.repo}\n${d}` : ""; }))).filter(Boolean).join("\n\n");
        const items = last.findings.map((f) => { const t = f.task ? ctx.st.tasks[f.task] : undefined; return { text: f.short ?? f.text.slice(0, 600), note: t ? `Sent back to ${t.label}; its writer: ${t.did ?? "no summary"}` : "Sent to the planner" }; });
        if (p.stopRequested) throw new Halt();
        sid = last.sessionId;
        ctx.ev(p.id, "claude_run_start", { text: "architect-reviewer is checking the change since its last review, in its own session", role: "architect-reviewer", sessionId: sid, resume: true });
        res = await g(ctx.ask({ role: "architect-reviewer", prompt: archFollowUpPrompt(p, items, since, repos), schema: REVIEW_SCHEMA, resumeId: sid, plan: p.id, wholePlan: true }));
        if (!res.ok || !res.structured) { ctx.ev(p.id, "architect_resume_failed", { text: `Resuming the architect's session failed (${res.error ?? "no result"}); it reads the whole plan diff again` }); p.archReview = undefined; res = undefined; }
      }
      if (!res) {
        const diffs = (await Promise.all(ordered(p).map(async (r) => `## ${r.repo}\n${await ports.git.diff(r.dir, `origin/${r.base}`)}`))).join("\n\n");
        if (p.stopRequested) throw new Halt();
        sid = randomUUID();
        ctx.ev(p.id, "claude_run_start", { text: "architect-reviewer is reading the whole plan diff", role: "architect-reviewer", sessionId: sid });
        // The whole plan diff in one pass, on the 1M-context model (P-06's was about 1.1 MB; a 120,000-character cut saw 11%).
        res = await g(ctx.ask({ role: "architect-reviewer", prompt: reviewPrompt(agentBody("architect-reviewer"), p, null, diffs, [], [], { repos }, WHOLE_PLAN_DIFF), schema: REVIEW_SCHEMA, sessionId: sid, plan: p.id, wholePlan: true }));
      }
      if (!res.ok || !res.structured) throw new Transient(`The architect-reviewer did not answer: ${res.error ?? "no result"}`);
      const all: Finding[] = ((res.structured?.findings ?? []) as Omit<Finding, "by">[]).map((f) => ({ ...f, by: "architect-reviewer" as const }));
      const blocking = all.filter((f) => f.severity === "blocking" && (BLOCKING_CATEGORIES as readonly string[]).includes(f.category));
      x.architect = true; // only once it really ran, so a restart mid-review runs it again
      ctx.ev(p.id, "architect_plan_review", { text: `Architect reviewed the plan diff: ${blocking.length} blocking, ${all.length - blocking.length} minor`, ok: res.ok, sessionId: res.sessionId ?? sid, findings: all });
      p.archReview = { sessionId: res.sessionId ?? sid, at: ctx.now(), heads: Object.fromEntries(repos.map((r) => [r.repo, r.head])), findings: [] };
      const archMinor = all.filter((f) => !blocking.includes(f));
      if (archMinor.length) p.archFindings = [...(p.archFindings ?? []), { at: ctx.now(), findings: archMinor }]; // they go on the findings list
      if (blocking.length) {
        const byTask = new Map<Task, Finding[]>(), toPlanner: string[] = [];
        // The task whose file it is (a path may come with or without the repo folder); none: the planner decides, never every task.
        const sameFile = (a: string, b: string) => a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
        for (const f of blocking) {
          const owner = f.fix_in === "plan" ? undefined : liveTasks(ctx, p).find((t) => !!f.file && t.files.some((x) => sameFile(x, f.file!)));
          if (owner) byTask.set(owner, [...(byTask.get(owner) ?? []), f]);
          else toPlanner.push(`Architect, whole-plan review: ${f.short ? `${f.short} ` : ""}${f.text}${f.file ? ` (${f.file}${f.line ? `:${f.line}` : ""})` : ""}`);
        }
        const fresh = toPlanner.filter((x) => !(p.planFixesSent ?? []).includes(x));
        if (!byTask.size && toPlanner.length && !fresh.length) return planError(ctx, p, `The architect's finding still has no task after the planner saw it: ${toPlanner[0]!.slice(0, 600)}`, "staging", true);
        if (fresh.length) { p.planFixes = [...(p.planFixes ?? []), ...fresh]; p.planFixesSent = [...(p.planFixesSent ?? []), ...fresh]; ctx.ev(p.id, "plan_fix_needed", { text: `Architect: ${fresh.length} finding${fresh.length === 1 ? "" : "s"} no task owns, sent to the planner` }); }
        if (byTask.size && ++x.sendBacks > ctx.cfg.maxSendBacks) return planError(ctx, p, `Sent back ${ctx.cfg.maxSendBacks} times already; stopping. Last finding: ${blocking[0]!.text}`, "staging");
        for (const [t, fs] of byTask) sendBack(ctx, p, t, fs, "architect", "The architect");
        p.archReview.findings = blocking.map((f) => ({ ...f, task: [...byTask].find(([, fs]) => fs.includes(f))?.[0].id }));
        p.steps.staging = ""; p.steps.tasks = "run";
        setNow(ctx, p, byTask.size ? `Architect sent ${byTask.size} task${byTask.size === 1 ? "" : "s"} back${fresh.length ? " and gave the planner the rest" : ""}` : "Architect gave its findings to the planner");
        return ctx.change();
      }
    }

    // The last review: every minor any round let through, checked against the final code. Harmful ones go back; you decide the rest.
    // Its own findings, plus the ones an earlier plan on the same branch left open (marked fixed there when gone now).
    const carried = carriedMinors(ctx.st, p), minors = [...allMinors(ctx.st, p), ...carried.map((c) => c.m)], key = sweepKey(minors);
    const ownerOf = new Map(carried.map((c) => [c.m.key, c.plan]));
    // The last review runs once per plan: findings from later fix rounds stay on your list unchecked, and the plan goes on to staging.
    if (minors.length && !p.minorSweep) {
      setNow(ctx, p, `code-reviewer (Opus) is checking ${minors.length} minor finding${minors.length === 1 ? "" : "s"} against the final code`); ctx.change();
      for (const r of ordered(p)) await ensureDir(ctx, p.id, r.repo, r.dir, r.branch);
      const diffs = (await Promise.all(ordered(p).map(async (r) => `## ${r.repo}\n${await ports.git.diff(r.dir, `origin/${r.base}`)}`))).join("\n\n");
      if (p.stopRequested) throw new Halt();
      const sid = randomUUID(), items = minors.map((m, i) => ({ n: i + 1, task: m.label, category: m.finding.category, text: m.finding.text }));
      ctx.ev(p.id, "claude_run_start", { text: `code-reviewer is checking ${minors.length} minor findings against the final code`, role: "code-reviewer", sessionId: sid });
      const res = p.terminal ? await terminalSweep(ctx, p, items) : await g(ctx.ask({ role: "code-reviewer", prompt: sweepPrompt(agentBody("code-reviewer"), p, diffs, items, undefined, await planRepoHeads(ctx, p)), schema: SWEEP_SCHEMA, sessionId: sid, plan: p.id, wholePlan: true }));
      if (!res.ok || !res.structured) throw new Transient(`The last review did not answer: ${res.error ?? "no result"}`);
      const verdicts: NonNullable<Plan["minorSweep"]>["verdicts"] = {};
      // Each finding is harmful, minor or trivial. Only harmful ones go back, once per plan; minor and trivial go on your list.
      const runs = (p.minorSweep?.runs ?? (p.minorSweep ? 1 : 0)) + 1, firstRun = runs === 1;
      for (const v of (res.structured.items ?? []) as { n: number; still: boolean; level?: string; harmful?: boolean; why: string }[]) {
        const m = minors[v.n - 1]; if (!m) continue;
        const level = (["harmful", "minor", "trivial"].includes(String(v.level)) ? v.level : v.harmful ? "harmful" : "minor") as "harmful" | "minor" | "trivial", harmful = !!v.still && level === "harmful";
        const owner = ownerOf.get(m.key), verdict = { still: !!v.still, harmful, level, why: String(v.why ?? ""), sent: !owner && firstRun && harmful, ...(owner ? { by: p.id } : {}) };
        if (owner) owner.minorSweep = { key: owner.minorSweep?.key ?? "", at: owner.minorSweep?.at ?? ctx.now(), runs: owner.minorSweep?.runs ?? 1, verdicts: { ...owner.minorSweep?.verdicts, [m.key]: verdict } }; // an earlier plan's finding: its own list shows it fixed or still open
        else verdicts[m.key] = verdict;
      }
      p.minorSweep = { key, at: ctx.now(), runs, verdicts };
      const bad = firstRun ? minors.filter((m) => !ownerOf.has(m.key) && verdicts[m.key]?.harmful) : [], gone = minors.filter((m) => !ownerOf.has(m.key) && verdicts[m.key] && !verdicts[m.key]!.still).length;
      const harmfulKept = firstRun ? 0 : minors.filter((m) => !ownerOf.has(m.key) && verdicts[m.key]?.harmful).length;
      const own = minors.length - carried.length, carriedFixed = carried.filter((c) => c.plan.minorSweep?.verdicts[c.m.key]?.still === false).length;
      const lv = (l: string) => minors.filter((m) => !ownerOf.has(m.key) && verdicts[m.key]?.still && verdicts[m.key]?.level === l).length;
      ctx.ev(p.id, "minor_sweep", { text: `Last review of ${own} minor findings: ${bad.length + harmfulKept} harmful${bad.length ? " (sent back)" : harmfulKept ? " (kept: the last review sends back only once)" : ""}, ${lv("minor")} minor, ${lv("trivial")} trivial, ${gone} gone${carried.length ? `; also re-checked ${carried.length} open from earlier plans, ${carriedFixed} now fixed` : ""}`, harmful: bad.length + harmfulKept, minor: lv("minor"), trivial: lv("trivial"), gone, sessionId: res.sessionId ?? sid });
      if (bad.length) {
        if (++x.sendBacks > ctx.cfg.maxSendBacks) return planError(ctx, p, `Sent back ${ctx.cfg.maxSendBacks} times already; stopping. Harmful minor finding: ${bad[0]!.finding.text}`, "staging");
        const byTask = new Map<Task, Finding[]>();
        for (const m of bad) {
          const t = ctx.st.tasks[m.task], text = `${m.finding.text} (The last review found this still in the code and harmful: ${verdicts[m.key]!.why})`;
          if (t) byTask.set(t, [...(byTask.get(t) ?? []), { ...m.finding, severity: "blocking", text }]);
          else p.planFixes = [...(p.planFixes ?? []), `Architect finding: ${text}`]; // an architect finding: the planner decides
        }
        for (const [t, fs] of byTask) sendBack(ctx, p, t, fs, "sweep", "The last review");
        p.steps.staging = ""; p.steps.tasks = "run";
        setNow(ctx, p, `The last review sent ${bad.length} harmful minor finding${bad.length === 1 ? "" : "s"} back to ${byTask.size} task${byTask.size === 1 ? "" : "s"}`);
        return ctx.change();
      }
    }

    // The plan's database changes go on staging by themselves (add-only, idempotent), before any code that needs them.
    if (p.dbChanges?.length && !p.dbDoneAt && ports.stagingDb && !x.stagedRepos.length && !target) { // a target plan's changes go to staging with its promotion
      setNow(ctx, p, `Running ${p.dbChanges.length} database change${p.dbChanges.length === 1 ? "" : "s"} on staging`); ctx.change();
      const r = await g(ports.stagingDb(p.dbChanges));
      ctx.ev(p.id, "staging_db", { text: `Database changes on staging: ${r.detail}`, ok: r.ok });
      if (!r.ok) return planError(ctx, p, `A database change needs a person on staging: ${r.detail}`, "staging");
    }

    const tasks = liveTasks(ctx, p), parts = ordered(p);
    const via = !target && !!ports.release && ctx.cfg.stagingRunner; // staging PRs merge through the release pipeline (TARGET=staging), like master
    if (via && p.stagingRelease?.state === "starting") return planError(ctx, p, "The backend restarted while the release pipeline (staging) was starting. Check the pipelines page of the release pipeline: if a run started, let it finish, then press Retry. A second run would merge the same PRs.", "staging");
    const watching = via && p.stagingRelease?.state === "running"; // after a restart: follow the same run, prepare nothing again
    const resume = via && p.stagingRelease?.state === "fail"; // Retry after a failed release run: carry on from what is left
    for (const part of watching ? [] : parts) {
      if (x.stagedRepos.includes(part.repo)) continue;
      const last = p.stagingPrs.filter((r) => r.repo === part.repo).pop();
      if (resume && last?.state === "merged") { part.staged = true; x.stagedRepos.push(part.repo); ctx.change(); continue; } // merged by the failed run
      // A promotion's open PR is reused while its branch still has the target branch's head; otherwise it is made again.
      if (resume && last?.state === "open" && part.from && ports.git.contains && (await g(ports.git.contains(part.repo, part.from, part.branch)))) {
        ctx.ev(p.id, "pr_reused", { text: `${part.repo}: staging PR #${last.id} is still current; the next release run takes it as it is`, repo: part.repo, id: last.id });
        continue;
      }
      const tag = `${part.repo} (${parts.indexOf(part) + 1} of ${parts.length})`; // which repo of the plan is going to staging now
      const say = (text: string) => { setNow(ctx, p, `${tag}: ${text}`); ctx.change(); };
      say(target ? `getting ready to merge into ${target}` : `checking that a merge to ${part.base} deploys`);
      const asked = ctx.now();
      const err = await ports.repoLock(part.repo, async (): Promise<string | null> => {
        if (ctx.now() - asked > 1000) ctx.ev(p.id, "lock_wait", { text: `${part.repo}: waited ${Math.round((ctx.now() - asked) / 1000)} s for another plan's staging merge in this repo`, repo: part.repo, ms: ctx.now() - asked });
        const chk = target ? null : await g(ports.deploy.check(part.repo, part.base));
        const why = typeof chk === "string" ? chk : null, manual = chk && typeof chk === "object" ? chk.manual : undefined;
        if (!target) ctx.ev(p.id, "deploy_check", { text: why ? `${part.repo}: a merge to ${part.base} does not deploy (${why})` : manual ? `${part.repo}: merges without a deploy (${manual})` : `${part.repo}: a merge to ${part.base} deploys`, repo: part.repo, reason: why ?? manual ?? null });
        if (why) return `A merge to ${part.base} in ${part.repo} does not deploy: ${why}`;
        if (manual) part.manualDeploy = manual; else delete part.manualDeploy;
        // Everything that touches the plan worktree runs under the plan+repo lock; the deploy wait does not need it.
        const step = await planLock(ctx, p.id, part.repo, async (): Promise<{ err?: string; merge?: string; opened?: boolean }> => {
          await g(ensureTarget(ctx, p, part));
          // A promotion takes the target branch as it is now: its plan branch is cut fresh from it each time.
          if (part.from) { await g(ports.git.worktree(part.repo, part.dir, part.branch, `origin/${part.from}`)); part.stagingCommits = []; }
          else await g(ensureDir(ctx, p.id, part.repo, part.dir, part.branch));
          await g(ports.git.fetch(part.dir));
          // A promotion merges the base in: replaying a long target branch commit by commit hits conflicts its merges already settled.
          const how = part.from ? "merge" : "rebase";
          say(part.from ? `merging ${part.base} into the plan branch` : `rebasing the plan branch onto ${part.base}`);
          const rb = await g(part.from ? ports.git.mergeBranch(part.dir, `origin/${part.base}`, `Merge ${part.base} into ${part.branch}`) : ports.git.rebase(part.dir, `origin/${part.base}`));
          ctx.ev(p.id, "rebase", { text: rb.ok ? `${part.repo}: ${how === "merge" ? `merged origin/${part.base} in` : `rebased onto origin/${part.base}`}` : `${part.repo}: ${how} with origin/${part.base} failed`, repo: part.repo, ok: rb.ok, conflict: rb.conflict });
          if (!rb.ok) return { err: `${how === "merge" ? `Merging ${part.base} into the plan branch` : `Rebase onto ${part.base}`} in ${part.repo} failed: ${rb.conflict ?? "conflict"}` };
          say("building again after the rebase");
          const bad = await buildParts(ctx, p, [part], 2, "After rebase");
          if (bad) return { err: `The ${part.repo} build fails after the rebase: ${bad}` };
          const commits = await g(ports.git.commitsSince(part.dir, `origin/${part.base}`));
          ctx.ev(p.id, "staging_commits", { text: `${part.repo}: ${commits.length} commit(s) go to ${part.base}`, repo: part.repo, commits });
          if (!commits.length) return {};
          const refused = await g(wholeGuard(ctx, p.id, part.dir, `origin/${part.base}`, `${part.repo} ${target ?? "staging"}`));
          if (refused) return { err: `The ${part.repo} change was refused before the push: ${refused}` };
          part.stagingCommits = [...part.stagingCommits, ...commits.filter((c) => !part.stagingCommits.includes(c))];
          await declineOpen(ctx, p.id, p.stagingPrs.filter((r) => r.repo === part.repo), "staging"); // left open by an earlier stopped run
          say(`pushing ${commits.length} commit${commits.length === 1 ? "" : "s"} and opening the ${target ? `PR into ${target}` : "staging PR"}`);
          await g(ports.git.push(part.dir, part.branch));
          ctx.ev(p.id, "push", { text: `${part.repo}: pushed ${part.branch}`, repo: part.repo, branch: part.branch });
          const mine = tasks.filter((t) => t.repo === part.repo);
          const txt = await writePr(ctx, p, part.repo, part.base, mine, await g(ports.git.diff(part.dir, `origin/${part.base}`)), [target ? `Targets ${target}, not staging: no staging deploy, staging test or master PR. Build and tests pass.` : "Staging test: runs after this merge."]);
          const pr = await g(ports.prs.create(part.repo, part.branch, part.base, txt.title, txt.body));
          const ref: PrRef = { repo: part.repo, id: pr.id, url: pr.url, state: "open", order: part.order, why: part.why };
          p.stagingPrs.push(ref); ctx.change();
          const name = target ? "target" : "staging";
          ctx.ev(p.id, "pr_created", { text: `${part.repo}: ${name} PR #${pr.id} opened ${pr.url}`, repo: part.repo, id: pr.id, url: pr.url, dest: part.base });
          if (via) return { opened: true }; // merged below, with the plan's other staging PRs, by one release run
          say(`merging ${name} PR #${pr.id} into ${part.base}`);
          const merge = await ports.prs.merge(part.repo, pr.id);
          ref.state = "merged"; ref.merge = merge;
          ctx.ev(p.id, "pr_merged", { text: `${part.repo}: ${name} PR #${pr.id} merged (${merge})`, repo: part.repo, id: pr.id, merge });
          ctx.change();
          if (p.stopRequested) throw new Halt();
          return { merge };
        });
        if (step.err) return step.err;
        if (step.opened) return null; // waits for the release run
        if (step.merge && !target) {
          if (!part.manualDeploy) {
            say(`PR merged; waiting for the deploy of ${part.base} to UAT`);
            const w = await g(ports.deploy.wait(part.repo, part.base, step.merge, (text) => say(`deploy to UAT: ${text}`), () => !!p.stopRequested));
            ctx.ev(p.id, "deploy_wait", { text: `${part.repo}: staging deploy ${w.manual ? "not run by the pipeline" : w.ok ? "finished" : "failed"}: ${w.detail}`, repo: part.repo, ok: w.ok, detail: w.detail });
            if (!w.ok) return `The staging deploy of ${part.repo} failed: ${w.detail}`;
            if (w.manual) part.manualDeploy = w.detail;
          }
          if (part.manualDeploy) {
            const ref = p.stagingPrs.find((r) => r.repo === part.repo && r.merge === step.merge);
            if (ref) ref.byHand = part.manualDeploy;
            ctx.ev(p.id, "deploy_manual", { text: `${part.repo}: merged to ${part.base}, not deployed (${part.manualDeploy})`, repo: part.repo, detail: part.manualDeploy });
          }
        }
        part.staged = true; x.stagedRepos.push(part.repo); ctx.change();
        return null;
      });
      if (err) return planError(ctx, p, err, "staging");
    }
    if (via) { const e = await stagingRun(ctx, p, parts); if (e) return planError(ctx, p, e, "staging"); }
    if (target) {
      p.steps.staging = "done"; p.steps.uat = "done"; p.landedAt = ctx.now(); // no staging test: nothing of it is on UAT
      await dropTaskDirs(ctx, p);
      setNow(ctx, p, `Merged into ${target} · build and tests pass`, "ok");
      ctx.ev(p.id, "target_done", { text: `Merged into ${target} in ${p.repos.length} repo${p.repos.length === 1 ? "" : "s"}; no staging deploy, staging test or master PR`, target });
      return ctx.change();
    }
    setNow(ctx, p, "Merged to staging. Waiting for the deploy to settle."); ctx.change();
    await g(ctx.sleep(ctx.cfg.settleMs));
    p.steps.staging = "done";
    const byHand = p.repos.filter((r) => r.manualDeploy).map((r) => r.repo);
    setNow(ctx, p, `Staging: ${p.repos.length} repo${p.repos.length === 1 ? "" : "s"} merged${byHand.length ? `; ${byHand.join(", ")} not deployed (no pipeline deploys ${byHand.length === 1 ? "it" : "them"})` : " and deployed"}`);
    ctx.ev(p.id, "staging_done", { text: "Staging finished" });
    ctx.change();
  } catch (e) { if (!(e instanceof Halt)) throw e; ctx.ev(p.id, "stopped", { text: "Staging stopped" }); }
}

// The plan's open staging PRs go to one release pipeline run (TARGET=staging): it merges them in dependency order and waits for
// each staging deploy. Every repo's staging lock is held while it runs. Returns why it failed, or null.
async function stagingRun(ctx: Ctx, p: Plan, parts: RepoPart[]): Promise<string | null> {
  const x = extra(p), slot = stagingSlot(p), open = (part: RepoPart) => p.stagingPrs.filter((r) => r.repo === part.repo && r.state === "open").pop();
  const todo = parts.filter((part) => !x.stagedRepos.includes(part.repo)).map(open).filter((r): r is PrRef => !!r);
  const repos = [...new Set(todo.map((r) => r.repo))].sort();
  const locked = <T>(i: number, job: () => Promise<T>): Promise<T> => (i >= repos.length ? job() : ctx.ports.repoLock(repos[i]!, () => locked(i + 1, job)));
  return locked(0, async () => {
    if (p.stagingRelease?.state !== "running") {
      if (!todo.length) return null;
      const e = await startRun(ctx, p, todo, slot);
      if (e) return e;
    }
    const mine = p.stagingPrs.filter((r) => slot.get().prs.includes(`${r.repo}#${r.id}`));
    const e = await watchRun(ctx, p, mine, slot);
    for (const r of mine.filter((m) => m.state === "merged")) {
      const part = parts.find((q) => q.repo === r.repo);
      if (!part || x.stagedRepos.includes(part.repo)) continue;
      if (r.byHand) part.manualDeploy = r.byHand;
      part.staged = true; x.stagedRepos.push(part.repo);
    }
    ctx.change();
    if (e) return e;
    const left = mine.filter((r) => r.state !== "merged");
    return left.length ? `${left.map((r) => `${r.repo} PR #${r.id}`).join(", ")} not merged by release run #${slot.get().run}. Press Retry: the open PRs go to a new run. ${slot.get().url}` : null;
  });
}

// A terminal plan's last review: the terminal's reviewer levels each minor finding (harmful, minor, trivial); the engine waits.
async function terminalSweep(ctx: Ctx, p: Plan, items: { n: number; task: string; category: string; text: string }[]) {
  p.terminal!.sweep = { askedAt: ctx.now(), items, answer: p.terminal!.sweep?.answer };
  setNow(ctx, p, `Last review: waiting for the terminal to level ${items.length} minor finding${items.length === 1 ? "" : "s"}`); ctx.change();
  while (!p.terminal?.sweep?.answer) { await ctx.sleep(2000); await new Promise((r) => setTimeout(r, 5)); if (p.stopRequested) throw new Halt(); }
  const a = p.terminal.sweep.answer; p.terminal.sweep = undefined;
  return { ok: true, structured: { items: a }, text: "" };
}

// A terminal plan's staging test: the terminal's tester plans the checks, the host runs them, the tester judges; the engine waits.
async function terminalTest(ctx: Ctx, p: Plan): Promise<TerminalTest> {
  p.terminal!.uat = { askedAt: ctx.now(), answer: p.terminal!.uat?.answer };
  setNow(ctx, p, "Staging test: waiting for the terminal's tester"); ctx.change();
  while (!p.terminal?.uat?.answer) { await ctx.sleep(2000); await new Promise((r) => setTimeout(r, 5)); if (p.stopRequested) throw new Halt(); }
  const a = p.terminal.uat.answer; p.terminal.uat = undefined;
  return a;
}

export async function runUat(ctx: Ctx, planId: string): Promise<void> {
  const { ports } = ctx;
  const p = ctx.st.plans[planId]!, x = extra(p), g = guarded(ctx, p);
  try {
    p.steps.uat = "run";
    const repos = [...new Set(p.repos.map((r) => r.repo))].sort();
    const asked = ctx.now();
    const locked = <T>(i: number, job: () => Promise<T>): Promise<T> => (i >= repos.length ? (ctx.now() - asked > 1000 && ctx.ev(p.id, "lock_wait", { text: `Waited ${Math.round((ctx.now() - asked) / 1000)} s for other staging work in ${repos.join(", ")}`, repos, ms: ctx.now() - asked }), job()) : ports.repoLock(repos[i]!, () => locked(i + 1, job)));
    let tries = 0;
    for (;;) {
      if (p.stopRequested) throw new Halt();
      setNow(ctx, p, "Staging test is running"); ctx.change();
      const tasks = liveTasks(ctx, p);
      for (const r of ordered(p)) await ensureDir(ctx, p.id, r.repo, r.dir, r.branch);
      const diffs = await Promise.all(ordered(p).map(async (r) => ({ repo: r.repo, diff: await ports.git.diff(r.dir, r.stagingCommits[0] ? `${r.stagingCommits[0]}^` : `origin/${r.base}`) })));
      ctx.ev(p.id, "uat_start", { text: `Staging test started (try ${tries + 1})`, try: tries + 1 });
      p.activity = []; p.uatStep = 0; p.uatScenarios = undefined;
      const onActivity = (line: string) => { (p.activity ??= []).push({ at: ctx.now(), line: String(line).slice(0, 200) }); if (p.activity.length > 20) p.activity.splice(0, p.activity.length - 20); ctx.changeSoon(); };
      const onStep = (k: number, sc?: { what: string; task: string }[]) => { p.uatStep = k; if (sc) p.uatScenarios = sc; ctx.change(); };
      const res = await g(locked(0, () => p.terminal ? terminalTest(ctx, p) : ports.test({ plan: p, tasks, diffs, onProgress: (text) => { setNow(ctx, p, text); ctx.change(); }, onActivity, onStep, stopped: () => !!p.stopRequested })))
        .finally(() => { p.activity = undefined; p.uatStep = undefined; ctx.change(); });
      tries++;
      p.uat = { checks: res.checks, proof: res.proof, tries, passed: res.exercised ? res.passed : undefined };
      if (res.sessionId) p.uatSession = res.sessionId;
      ctx.ev(p.id, "uat_result", { text: `Staging test ${res.exercised ? (res.passed ? "passed" : "failed") : "did not reach the change"}: ${res.checks.filter((c) => c.ok).length}/${res.checks.length} checks ok`, exercised: res.exercised, passed: res.passed, proof: res.proof, checks: res.checks, tries });
      ctx.change();
      if (!res.exercised) {
        if (tries >= ctx.cfg.maxTestTries) return planError(ctx, p, `The staging test never reached the change after ${tries} tries.`, "uat");
        ctx.ev(p.id, "uat_retry", { text: `Staging test did not reach the change; asking again (try ${tries + 1} of ${ctx.cfg.maxTestTries})`, try: tries + 1, of: ctx.cfg.maxTestTries });
        continue;
      }
      if (res.passed) {
        p.steps.uat = "done";
        setNow(ctx, p, p.stagingOnly ? DONE_ON_STAGING : `Staging test passed: ${res.checks.length} check${res.checks.length === 1 ? "" : "s"}`, "ok");
        return ctx.change();
      }
      const failed = res.checks.filter((c) => c.ok === false), all = liveTasks(ctx, p);
      const shown = failed.length ? failed : [{ what: res.proof || "The staging test failed", ok: false, detail: "", task: "" }];
      if (!all.length) return planError(ctx, p, `The staging test failed and the plan has no task to fix it: ${shown.map((c) => c.what).join("; ")}`, "uat");
      if (++x.sendBacks > ctx.cfg.maxSendBacks) return planError(ctx, p, `The staging test failed again after ${ctx.cfg.maxSendBacks} send-backs: ${shown.map((c) => c.what).join("; ")}`, "uat");
      // A failure no task owns goes to every task, so each checks whether its change is the cause.
      const byTask = new Map<Task, Finding[]>();
      for (const c of shown) {
        const owner = all.find((t) => !!c.task && (t.label === c.task || t.id === c.task));
        const text = `Staging test failed: ${c.what}${c.detail ? ` (${c.detail})` : ""}${owner ? "" : ". No task was named as the cause: check whether your change causes it, and change nothing if it doesn't"}`;
        for (const t of owner ? [owner] : all) byTask.set(t, [...(byTask.get(t) ?? []), { severity: "blocking", category: "correctness", text, by: "tester" }]);
      }
      for (const [t, fs] of byTask) sendBack(ctx, p, t, fs, "uat", "The staging test");
      p.steps.staging = ""; p.steps.uat = ""; p.steps.tasks = "run"; p.cleanedAt = undefined;
      setNow(ctx, p, `Staging test failed: ${[...byTask.keys()].map((t) => t.label).join(", ")} sent back`, "bad");
      return ctx.change();
    }
  } catch (e) { if (!(e instanceof Halt)) throw e; ctx.ev(p.id, "stopped", { text: "Staging test stopped" }); }
}

// A pick that conflicts on master: the executor applies the commit's intent to master's files, code-reviewer checks it.
// sess: one executor session for the whole master step (all repos), continued on each conflict. A port plan skips the per-commit review: its final port review checks all repos once.
async function portCommit(ctx: Ctx, p: Plan, repo: string, master: string, dir: string, c: string, files: string[], sess: { id?: string } = {}): Promise<string | null> {
  const { ports } = ctx, short = c.slice(0, 8);
  setNow(ctx, p, `${repo}: ${master} has drifted; executor (Sonnet) is porting ${short} (${files.join(", ")})`); ctx.change();
  ctx.ev(p.id, "master_port_start", { text: `${repo}: porting ${short} onto ${master}; conflict in ${files.join(", ")}`, repo, commit: c, files });
  const orig = await ports.git.showCommit!(dir, c);
  // A terminal plan: its master session resolves the conflict in this worktree (a subagent, reviewed there); the engine checks and commits it.
  if (p.terminal) {
    p.terminal.port = { askedAt: ctx.now(), repo, master, dir, commit: c, files, commitText: orig.text.slice(0, 6000) };
    setNow(ctx, p, `${repo}: ${master} has drifted; waiting for the terminal to port ${short} (${files.join(", ")})`); ctx.change();
    while (!p.terminal?.port?.answer) { await ctx.sleep(2000); await new Promise((r) => setTimeout(r, 5)); if (p.stopRequested) throw new Halt(); }
    const a = p.terminal.port.answer; p.terminal.port = undefined; ctx.change();
    if (!a.ok) { await ports.git.finishPick!(dir, false); return `the terminal could not port ${short}: ${a.note || "no reason given"}`; }
    const left = files.filter((f) => { try { return /^(<<<<<<<|>>>>>>>)( |$)|^=======$/m.test(readFileSync(join(dir, f), "utf8")); } catch { return false; } });
    if (left.length) return `conflict markers are still in ${left.join(", ")}`;
    const extra = (await ports.git.changedFiles(dir, "HEAD")).filter((f) => !orig.files.includes(f));
    if (extra.length) return `the port changed files the commit does not touch: ${extra.join(", ")}`;
    const done = await ports.git.finishPick!(dir, true);
    if (!done.ok) return `git could not finish the pick: ${done.error}`;
    ctx.ev(p.id, "master_port_done", { text: `${repo}: ${short} ported onto ${master} by the terminal${a.note ? `: ${a.note}` : ""}`, repo, commit: c });
    return null;
  }
  const ask = (resume?: string) => ctx.ask({ role: "executor", prompt: portPrompt(resume ? `Next conflict in the same port, now in ${repo} (your working folder for this one is ${dir}). The rules below are the same as before.` : agentBody("executor"), p, repo, master, orig.text.slice(0, 60_000), files), schema: EXEC_SCHEMA, edits: [dir], plan: p.id, ...(resume ? { resumeId: resume } : { sessionId: (sess.id = randomUUID()) }) });
  let res = await ask(sess.id);
  if (!res.ok && sess.id) res = await ask(); // the session could not be continued (e.g. after a restart): start a new one
  if (!res.ok) return `the executor did not answer: ${res.error ?? "no result"}`;
  if (res.sessionId) sess.id = res.sessionId;
  const left = files.filter((f) => { try { return /^(<<<<<<<|>>>>>>>)( |$)|^=======$/m.test(readFileSync(join(dir, f), "utf8")); } catch { return false; } });
  if (left.length) return `conflict markers are still in ${left.join(", ")}`;
  const touched = await ports.git.changedFiles(dir, "HEAD");
  const extra = touched.filter((f) => !orig.files.includes(f));
  if (extra.length) return `the port changed files the commit does not touch: ${extra.join(", ")}`;
  const base = await ports.git.head(dir); // master before the pick: the port is everything after it
  const done = await ports.git.finishPick!(dir, true);
  if (!done.ok) return `git could not finish the pick: ${done.error}`;
  if (p.kind === "port") { ctx.ev(p.id, "master_port_done", { text: `${repo}: ${short} ported onto ${master}; the final port review checks it with the other repos`, repo, commit: c }); return null; }
  // A blocked port goes back to the executor with the findings, like the task review loop; then it is reviewed again.
  for (let round = 0; ; round++) {
    const port = await ports.git.diff(dir, base.trim());
    const rev = await ctx.ask({ role: "code-reviewer", prompt: portReviewPrompt(agentBody("code-reviewer"), repo, master, orig.text.slice(0, 40_000), port.slice(0, 40_000), p.dbChanges), schema: REVIEW_SCHEMA, sessionId: randomUUID(), plan: p.id });
    if (!rev.ok || !rev.structured) throw new Transient(`The code-reviewer did not answer: ${rev.error ?? "no result"}`);
    const blocking = ((rev.structured.findings ?? []) as Omit<Finding, "by">[]).filter((f) => f.severity === "blocking" && (BLOCKING_CATEGORIES as readonly string[]).includes(f.category));
    ctx.ev(p.id, "master_port_done", { text: `${repo}: ${short} ported onto ${master}; code-reviewer: ${blocking.length} blocking${round ? ` (after fix round ${round})` : ""}`, repo, commit: c, findings: rev.structured.findings });
    if (!blocking.length) { setNow(ctx, p, `${repo}: ${short} ported onto ${master}; building it`); ctx.change(); return null; }
    if (round >= PORT_FIX_ROUNDS) return `code-reviewer blocked the port: ${blocking.map((f) => f.text).join(" | ").slice(0, 500)}`;
    setNow(ctx, p, `${repo}: the reviewer blocked the port of ${short}; executor is fixing it (round ${round + 1} of ${PORT_FIX_ROUNDS})`); ctx.change();
    ctx.ev(p.id, "master_port_fix", { text: `${repo}: the port of ${short} goes back to the executor (round ${round + 1} of ${PORT_FIX_ROUNDS})`, repo, round: round + 1, blocking: blocking.map((f) => f.text) });
    const fix = await ctx.ask({ role: "executor", prompt: `${fixPrompt(blocking.map((f) => ({ ...f, by: "code-reviewer" as const })), "The port reviewer")}\nYou are fixing a port onto ${master} in this worktree: change only files the original commit touches (${orig.files.join(", ")}), and bring nothing else over from staging. Do not commit.`, schema: EXEC_SCHEMA, edits: [dir], sessionId: randomUUID(), plan: p.id });
    if (!fix.ok) return `the executor did not answer: ${fix.error ?? "no result"}`;
    const extra = (await ports.git.changedFiles(dir, "HEAD")).filter((f) => !orig.files.includes(f));
    if (extra.length) return `the port fix changed files the commit does not touch: ${extra.join(", ")}`;
    await ports.git.commitAll(dir, `[${p.id}] port fix ${round + 1} (${short})`);
  }
}
const PORT_FIX_ROUNDS = 2;

const masterDir = (ctx: Ctx, p: Plan, part: RepoPart) => `${ctx.ports.stageRoot}/${p.id}/${part.repo}-master`;
const masterBranchOf = (part: RepoPart) => `${part.branch}-master`;

// One repo's master branch, made fresh from origin/<master>: the plan's staging commits cherry-picked (a conflict is ported), built, guarded, pushed.
// Call it inside planLock. head and base: the pushed commit and the master commit it was built on. skipped: everything is already on master.
async function buildMaster(ctx: Ctx, p: Plan, part: RepoPart, master: string, pins?: LibPin[], sess: { id?: string } = {}, pinBuild = true): Promise<{ err?: string; skipped?: boolean; head?: string; base?: string }> {
  const { ports } = ctx, g = guarded(ctx, p);
  const dir = masterDir(ctx, p, part), branch = masterBranchOf(part);
  await g(ports.git.worktree(part.repo, dir, branch, `origin/${master}`));
  const base = (await g(ports.git.head(dir))).trim(); // the worktree starts at origin/<master>: this is what the PR is built on
  await g(ports.git.fetch(dir));
  ctx.ev(p.id, "worktree", { text: `${part.repo}: master worktree created`, dir, branch, base: `origin/${master}`, at: base });
  let applied = 0, skipped = 0, picks = part.stagingCommits;
  if (ports.git.showCommit && ports.git.diffRange) {
    const net = await g(dropNetZero(picks, async (c) => (await ports.git.showCommit!(dir, c)).files, async (from, to, files) => !(await ports.git.diffRange!(dir, from, to, files)).trim()));
    if (net.dropped.length) ctx.ev(p.id, "cherry_pick_skipped", { text: `${part.repo}: left out ${net.dropped.length} staging commit(s) that undo each other: ${net.dropped.map((c) => c.slice(0, 8)).join(", ")}`, repo: part.repo, commits: net.dropped });
    picks = net.keep;
  }
  for (const c of picks) {
    const cp = await g(ports.git.cherryPick(dir, [c], { keepConflict: !!ports.git.finishPick }));
    if (cp.ok) { applied++; continue; }
    if (!cp.empty && cp.files?.length && ports.git.finishPick) {
      const why = await portCommit(ctx, p, part.repo, master, dir, c, cp.files, sess);
      if (!why) { applied++; continue; }
      await ports.git.finishPick(dir, false);
      ctx.ev(p.id, "cherry_pick", { text: `${part.repo}: porting ${c.slice(0, 8)} onto ${master} failed: ${why}`, repo: part.repo, ok: false, conflict: cp.conflict, commits: [c] });
      return { err: `Master has drifted and the port of ${c.slice(0, 8)} in ${part.repo} failed: ${why}` };
    }
    if (cp.empty || /is now empty/.test(cp.conflict ?? "")) { skipped++; ctx.ev(p.id, "cherry_pick_skipped", { text: `${part.repo}: commit ${c.slice(0, 8)} is already on ${master}; skipped`, repo: part.repo, commit: c }); continue; }
    ctx.ev(p.id, "cherry_pick", { text: `${part.repo}: cherry-pick onto ${master} failed`, repo: part.repo, ok: false, conflict: cp.conflict, commits: [c] });
    return { err: `Master has drifted; port it by hand (${part.repo}): ${cp.conflict ?? "conflict"}` };
  }
  ctx.ev(p.id, "cherry_pick", { text: `${part.repo}: ${applied} commit(s) cherry-picked onto ${master}${skipped ? `, ${skipped} already there` : ""}`, repo: part.repo, ok: true, commits: part.stagingCommits, applied, skipped });
  if (!applied) return { skipped: true };
  const bad = await buildParts(ctx, p, [{ ...part, dir, branch, base: master }], 2, "Master");
  if (bad) return { err: `The ${part.repo} build fails on master: ${bad}` };
  // A port plan carries reviewed, merged staging commits: build or config files those commits changed are allowed.
  const shown = p.kind === "port" && ports.git.showCommit ? await Promise.all(part.stagingCommits.map((c) => g(ports.git.showCommit!(dir, c)))) : undefined;
  const allow = shown && { files: new Set(shown.flatMap((x) => x.files)), lines: new Set(shown.flatMap((x) => x.text.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.trim()))) };
  const refused = await g(wholeGuard(ctx, p.id, dir, `origin/${master}`, `${part.repo} master`, allow));
  if (refused) return { err: `The ${part.repo} master change was refused before the push: ${refused}` };
  if (pins?.length) { const why = await pinLibs(ctx, p, part, master, dir, pins, pinBuild); if (why) return { err: why }; }
  await g(ports.git.push(dir, branch));
  return { head: await g(ports.git.head(dir)), base };
}

// Pins in-house library versions in the master worktree's poms (version lines only), builds, guards and commits. Returns an error text or null.
// build false: a pinned version is released only during this merge, so no local build can fetch it; its master pipeline builds it.
async function pinLibs(ctx: Ctx, p: Plan, part: RepoPart, master: string, dir: string, pins: LibPin[], build = true): Promise<string | null> {
  const { ports } = ctx, g = guarded(ctx, p), label = pins.map((x) => `${x.lib} to released ${x.version}`).join(", ");
  const edited: string[] = [], lines = new Set<string>(); // lines: the exact version lines written, as the diff shows them
  for (const pom of await g(ports.git.poms!(dir))) {
    const text = pinVersions(pom.text, pins);
    if (text === pom.text) continue;
    if (!onlyVersionLines(pom.text, text, pins)) return `Pinning ${label} in ${part.repo} ${pom.path} would change more than the version line, so it was not done.`;
    await g(ports.git.writeFile!(dir, pom.path, text)); edited.push(pom.path);
    const was = pom.text.split("\n");
    text.split("\n").forEach((l, i) => { if (l !== was[i]) lines.add(`+${l}`.trim()); });
  }
  if (!edited.length) return null;
  const bad = build ? await buildParts(ctx, p, [{ ...part, dir, branch: masterBranchOf(part), base: master }], 2, "Master") : null;
  if (bad) return `The ${part.repo} build fails on master after pinning ${label}: ${bad}`;
  await g(ports.git.commitAll(dir, `Pin ${label}`));
  const refused = await g(wholeGuard(ctx, p.id, dir, `origin/${master}`, `${part.repo} master (pinned)`, { files: new Set(edited), lines }));
  if (refused) return `The ${part.repo} master change was refused after pinning ${label}: ${refused}`;
  ctx.ev(p.id, "master_pinned", { text: `${part.repo}: pinned ${label} in ${edited.join(", ")}${build ? "" : " (not built here: the version is released during this merge, and the master pipeline builds it)"}`, repo: part.repo, pins, files: edited, built: build });
  return null;
}

// The in-house library SNAPSHOT dependencies this open master PR still has (all poms on its branch), or [] when none or no libs port.
async function snapshotsOf(ctx: Ctx, p: Plan, pr: PrRef): Promise<(LibPin & { snapshot: boolean })[]> {
  const { ports } = ctx, part = p.repos.find((r) => r.repo === pr.repo);
  if (!ports.libs || !ports.git.poms || !part?.stagingCommits.length) return [];
  const libs = ports.libs.names().filter((l) => l !== pr.repo), dir = masterDir(ctx, p, part);
  return planLock(ctx, p.id, pr.repo, async () => {
    let poms: { text: string }[];
    try { poms = await ports.git.poms!(dir); }
    catch { await ports.git.worktree(pr.repo, dir, masterBranchOf(part), `origin/${masterBranchOf(part)}`); poms = await ports.git.poms!(dir); } // folder gone: made again from the pushed branch
    const out: (LibPin & { snapshot: boolean })[] = [];
    for (const pom of poms) for (const s of findLibVersions(pom.text, libs)) if (!out.some((x) => x.lib === s.lib && x.version === s.version && x.snapshot === s.snapshot)) out.push(s);
    return out;
  });
}

// Before the release run starts: every in-house library version this open PR uses must be released, or be merged by this
// run (the release pipeline waits for its tag). A SNAPSHOT is pinned to its release version. Returns why not (step: the PR must be remade), or null.
async function pinSnapshots(ctx: Ctx, p: Plan, pr: PrRef, open: PrRef[]): Promise<{ err: string; step?: "master" } | null> {
  const libs = ctx.ports.libs;
  const all = await snapshotsOf(ctx, p, pr);
  if (!libs || !all.length) return null;
  const later = new Set<string>(); // released only during this merge
  for (const s of all) {
    if (await libs.released(s.lib, s.version)) continue;
    if (!open.some((x) => x !== pr && x.repo === s.lib)) return { err: `${pr.repo} PR #${pr.id} depends on ${s.lib} ${s.version}${s.snapshot ? "-SNAPSHOT" : ""}, which is not released. Merge and release ${s.lib} ${s.version} first.` };
    later.add(s.lib);
  }
  const need = all.filter((x) => x.snapshot).map(({ lib, version }) => ({ lib, version }));
  if (!need.length) return null;
  const r = await refreshMasterPr(ctx, p, pr, `Pinning ${need.map((x) => `${x.lib} ${x.version}`).join(", ")} in the ${pr.repo} master PR before the release run`, need, !need.some((x) => later.has(x.lib)));
  return r.err ? { err: `Pinning the library versions in the ${pr.repo} master PR failed, so nothing was merged: ${r.err}`, step: "master" } : null;
}

const readyText = (p: Plan) => `${p.masterPrs.length} master PR${p.masterPrs.length === 1 ? "" : "s"} ready. Merge them in order.`;

// Master moved since this open PR was built: rebuild it on the new master, same branch, force-pushed so the same PR updates.
// fresh: master did not move (or the PR has no recorded base). dropped: everything is on master now, so the PR is declined and removed.
export async function refreshMasterPr(ctx: Ctx, p: Plan, pr: PrRef, nowText: string, pins?: LibPin[], pinBuild = true): Promise<{ status: "fresh" | "rebuilt" | "dropped"; err?: string }> {
  const { ports } = ctx, g = guarded(ctx, p);
  const part = p.repos.find((r) => r.repo === pr.repo);
  if (!part?.stagingCommits.length || (!pins && !ports.git.remoteHead)) return { status: "fresh" }; // no recorded base (an older PR): rebuild rather than assume fresh
  return planLock(ctx, p.id, pr.repo, async () => {
    if (pr.state !== "open") return { status: "fresh" as const };
    const master = await g(ports.git.masterBranch(pr.repo));
    if (!pins && pr.base && sameHead(await g(ports.git.remoteHead!(pr.repo, master)), pr.base)) { ctx.ev(p.id, "master_fresh", { text: `${pr.repo}: master did not move; PR #${pr.id} stays as built`, repo: pr.repo, id: pr.id }); return { status: "fresh" as const }; } // pins: rebuild even when master did not move
    setNow(ctx, p, nowText); ctx.change();
    const b = await buildMaster(ctx, p, part, master, pins, {}, pinBuild);
    if (b.err) return { status: "fresh" as const, err: b.err };
    if (b.skipped) {
      try { await ports.prs.decline(pr.repo, pr.id); pr.state = "declined"; } catch (e) { return { status: "fresh" as const, err: `${pr.repo} PR #${pr.id} is now empty (everything is on ${master}) but could not be declined: ${e instanceof Error ? e.message : String(e)}` }; }
      p.masterPrs = p.masterPrs.filter((r) => r !== pr);
      ctx.ev(p.id, "master_skipped", { text: `${pr.repo}: master moved and now holds everything; PR #${pr.id} declined, no PR needed`, repo: pr.repo, id: pr.id });
      ctx.change();
      return { status: "dropped" as const };
    }
    const was = pr.base ?? "";
    pr.head = b.head; pr.base = b.base;
    if (!pins) ctx.ev(p.id, "master_refreshed", { text: `${pr.repo}: ${master} moved since PR #${pr.id} was made, so it was rebuilt on the new ${master} (${was.slice(0, 8)} to ${b.base!.slice(0, 8)}) and the PR updated`, repo: pr.repo, id: pr.id, head: b.head, base: b.base, was });
    ctx.change();
    return { status: "rebuilt" as const };
  });
}

// After another plan merged to master: rebuild this plan's open master PRs in the repos that plan changed. No merge.
export async function runRefresh(ctx: Ctx, planId: string, mergedId: string, repos: string[]): Promise<void> {
  const p = ctx.st.plans[planId]!;
  try {
    for (const pr of [...p.masterPrs].sort((a, b) => a.order - b.order)) {
      if (pr.state !== "open" || !repos.includes(pr.repo)) continue;
      const r = await refreshMasterPr(ctx, p, pr, `Master moved (${mergedId} merged): refreshing the ${pr.repo} master PR`);
      if (r.err) return planError(ctx, p, `Master moved when ${mergedId} merged, and refreshing the ${pr.repo} master PR failed: ${r.err}`, "master");
      // Another plan carried this change to prod (P-05 includes P-03's commits): say so, it is not a failure.
      if (r.status === "dropped") { (p.carriedBy ??= {})[pr.repo] = mergedId; ctx.ev(p.id, "carried_by", { text: `${pr.repo}: this change is already on prod through ${mergedId}; master PR #${pr.id} closed`, repo: pr.repo, by: mergedId, id: pr.id }); }
    }
    if (!p.masterPrs.length) {
      await dropPlanDirs(ctx, p);
      p.steps.master = "done"; p.liveAt = ctx.now(); p.liveVia = mergedId;
      setNow(ctx, p, `Already live through ${mergedId}: ${mergedId}'s merge carried this change to prod. Nothing to merge.`, "ok");
      ctx.ev(p.id, "live", { text: `Already live through ${mergedId}. Nothing to merge.`, via: mergedId });
    } else setNow(ctx, p, readyText(p));
    ctx.change();
  } catch (e) { if (!(e instanceof Halt)) throw e; ctx.ev(p.id, "stopped", { text: "Master refresh stopped" }); }
}

export async function runMaster(ctx: Ctx, planId: string): Promise<void> {
  const { ports } = ctx;
  const p = ctx.st.plans[planId]!, g = guarded(ctx, p);
  try {
    // Keep a master PR made after the last passed staging test whose head is unchanged; any other is out of date.
    const evs = readEvents(ports.dataDir, p.id, Infinity);
    // A port plan has no staging test here (staging tested it before): its open PRs with an unchanged head are kept on a retry.
    const passedAt = p.kind === "port" ? 0 : [...evs].reverse().find((e) => e.event === "uat_result" && e.passed === true)?.at ?? Infinity;
    const keep: PrRef[] = [];
    for (const r of p.masterPrs) {
      const made = evs.find((e) => e.event === "pr_created" && e.repo === r.repo && e.id === r.id)?.at ?? 0;
      if (r.state === "open" && r.head && made > passedAt && sameHead(await ports.prs.head(r.repo, r.id).catch(() => ""), r.head)) keep.push(r);
    }
    await declineOpen(ctx, p.id, p.masterPrs.filter((r) => !keep.includes(r)), "master");
    p.masterPrs = keep;
    if (keep.length) ctx.ev(p.id, "master_kept", { text: `Kept ${keep.length} open master PR(s): ${keep.map((r) => `${r.repo} #${r.id}`).join(", ")}`, prs: keep.map((r) => r.id) });
    const parts = ordered(p).filter((r) => r.stagingCommits.length);
    setNow(ctx, p, "Making the master PRs"); ctx.change();
    const sess: { id?: string } = {}; // one port session for every repo's conflicts
    for (const part of parts) {
      if (keep.some((r) => r.repo === part.repo)) continue;
      const master = await g(ports.git.masterBranch(part.repo));
      const step = await planLock(ctx, p.id, part.repo, async (): Promise<{ err?: string; pr?: PrRef; skipped?: boolean }> => {
        setNow(ctx, p, `${part.repo}: making the master PR (${parts.indexOf(part) + 1} of ${parts.length})`); ctx.change();
        const b = await buildMaster(ctx, p, part, master, undefined, sess);
        if (b.err || b.skipped) return b;
        const dir = masterDir(ctx, p, part), branch = masterBranchOf(part);
        const txt = await writePr(ctx, p, part.repo, master, liveTasks(ctx, p).filter((t) => t.repo === part.repo), await g(ports.git.diff(dir, `origin/${master}`)), [`Merge order: ${part.order} of ${parts.length}.`, `Why: ${part.why ?? "no reason given"}`, `Staging test: ${p.kind === "port" ? "already merged to staging and tested there" : p.uat?.proof ?? "passed"}`]);
        const pr = await g(ports.prs.create(part.repo, branch, master, txt.title, txt.body));
        return { pr: { repo: part.repo, id: pr.id, url: pr.url, state: "open", order: part.order, why: part.why, head: b.head, base: b.base } };
      });
      if (step.err) return planError(ctx, p, step.err, "master");
      if (step.skipped) { ctx.ev(p.id, "master_skipped", { text: `${part.repo}: everything is already on ${master}; no PR needed`, repo: part.repo }); continue; }
      const pr = step.pr!;
      p.masterPrs.push(pr);
      ctx.ev(p.id, "pr_created", { text: `${part.repo}: master PR #${pr.id} opened ${pr.url} (order ${part.order}${part.why ? `: ${part.why}` : ""})`, repo: part.repo, id: pr.id, url: pr.url, dest: master, order: part.order, why: part.why, head: pr.head });
      ctx.change();
    }
    if (!p.masterPrs.length) {
      await dropPlanDirs(ctx, p);
      p.steps.master = "done"; p.liveAt = ctx.now();
      setNow(ctx, p, "Everything is already on master. Nothing to merge.", "ok");
      ctx.ev(p.id, "live", { text: "Every commit is already on master. Nothing to merge." });
      return ctx.change();
    }
    if (p.kind === "port") { const why = await finalPortReview(ctx, p); if (why) return planError(ctx, p, why, "master"); }
    p.steps.master = "you";
    setNow(ctx, p, readyText(p));
    ctx.ev(p.id, "master_ready", { text: "Master PRs are ready for you", prs: p.masterPrs });
    ctx.change();
  } catch (e) { if (!(e instanceof Halt)) throw e; ctx.ev(p.id, "stopped", { text: "Master PRs stopped" }); }
}

// A port plan, once every repo is ported: one reviewer checks all master PRs against staging; a blocked repo gets one fix, not a second review.
async function finalPortReview(ctx: Ctx, p: Plan): Promise<string | null> {
  const { ports } = ctx, g = guarded(ctx, p);
  const prs = p.masterPrs.filter((r) => r.state === "open");
  const keyOf = () => prs.map((r) => `${r.repo}@${r.head}`).sort().join(",");
  if (!ports.git.showCommit || !ports.git.diffRange || !prs.length || p.finalReview?.key === keyOf()) return null; // already reviewed these heads
  setNow(ctx, p, `Final port review: one reviewer checks all ${prs.length} repo(s) against staging`); ctx.change();
  const repos = [];
  for (const pr of prs) {
    const part = p.repos.find((r) => r.repo === pr.repo)!, dir = masterDir(ctx, p, part), branch = masterBranchOf(part);
    repos.push(await planLock(ctx, p.id, pr.repo, async () => {
      if (!existsSync(dir)) await g(ports.git.worktree(pr.repo, dir, branch, `origin/${branch}`)); // kept PR whose worktree is gone
      await g(ports.git.fetch(dir));
      const [master, staging] = await Promise.all([g(ports.git.masterBranch(pr.repo)), g(ports.git.stagingBranch(pr.repo))]);
      const shown = await Promise.all(part.stagingCommits.map((c) => g(ports.git.showCommit!(dir, c))));
      const files = [...new Set(shown.flatMap((x) => x.files))];
      const diff = await g(ports.git.diffRange!(dir, "HEAD", `origin/${staging}`, files));
      return { pr, part, dir, branch, master, staging, files, shown, diff, commits: shown.map((x) => x.text.split("\n").slice(0, 2).join(" ").trim()) };
    }));
  }
  const cap = Math.floor(150_000 / repos.length);
  ctx.ev(p.id, "final_port_review_start", { text: `Final port review: ${repos.map((r) => `${r.pr.repo} (${r.files.length} files)`).join(", ")}`, repos: repos.map((r) => r.pr.repo) });
  const rev = await ctx.ask({ role: "code-reviewer", prompt: finalPortReviewPrompt(agentBody("code-reviewer"), p, repos.map((r) => ({ repo: r.pr.repo, master: r.master, staging: r.staging, commits: r.commits, diff: r.diff.slice(0, cap) })), p.dbChanges), schema: FINAL_PORT_SCHEMA, sessionId: randomUUID(), plan: p.id });
  if (!rev.ok || !rev.structured) throw new Transient(`The final port reviewer did not answer: ${rev.error ?? "no result"}`);
  const findings = (rev.structured.findings ?? []) as (Omit<Finding, "by"> & { repo: string })[];
  const blocking = findings.filter((f) => f.severity === "blocking" && (BLOCKING_CATEGORIES as readonly string[]).includes(f.category) && repos.some((r) => r.pr.repo === f.repo));
  ctx.ev(p.id, "final_port_review", { text: `Final port review of ${repos.length} repo(s): ${blocking.length} blocking`, findings });
  for (const r of repos) {
    const mine = blocking.filter((f) => f.repo === r.pr.repo);
    if (!mine.length) continue;
    setNow(ctx, p, `${r.pr.repo}: the final port review found ${mine.length} problem(s); executor is fixing them`); ctx.change();
    const why = await planLock(ctx, p.id, r.pr.repo, async (): Promise<string | null> => {
      const fix = await ctx.ask({ role: "executor", prompt: `${fixPrompt(mine.map((f) => ({ ...f, by: "code-reviewer" as const })), "The final port reviewer")}\nYou are fixing the port onto ${r.master} in this worktree. Change only these files: ${r.files.join(", ")}. Bring over only this plan's code (see origin/${r.staging}), nothing else from staging. Do not commit or run git.`, schema: EXEC_SCHEMA, edits: [r.dir], sessionId: randomUUID(), plan: p.id });
      if (!fix.ok) return `the executor did not answer: ${fix.error ?? "no result"}`;
      const extra = (await g(ports.git.changedFiles(r.dir, "HEAD"))).filter((f) => !r.files.includes(f));
      if (extra.length) return `the fix changed files the plan's commits do not touch: ${extra.join(", ")}`;
      const bad = await buildParts(ctx, p, [{ ...r.part, dir: r.dir, branch: r.branch, base: r.master }], 2, "Master");
      if (bad) return `the build fails after the fix: ${bad}`;
      if (!(await g(ports.git.commitAll(r.dir, `[${p.id}] final port review fix`)))) return null; // the executor found nothing to change
      const allow = { files: new Set(r.files), lines: new Set(r.shown.flatMap((x) => x.text.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.trim()))) };
      const refused = await g(wholeGuard(ctx, p.id, r.dir, `origin/${r.master}`, `${r.pr.repo} master (final review fix)`, allow));
      if (refused) return `the fix was refused before the push: ${refused}`;
      await g(ports.git.push(r.dir, r.branch));
      r.pr.head = await g(ports.git.head(r.dir));
      return null;
    });
    if (why) return `The final port review blocked ${r.pr.repo} and its fix failed: ${why}`;
    ctx.ev(p.id, "final_port_fix", { text: `${r.pr.repo}: fixed what the final port review found and pushed it to PR #${r.pr.id}`, repo: r.pr.repo, id: r.pr.id, head: r.pr.head, blocking: mine.map((f) => f.text) });
    ctx.change();
  }
  p.finalReview = { key: keyOf(), at: ctx.now(), blocking: blocking.length };
  return null;
}

// the git host gives a short (12 char) hash, git a full one: equal when the shorter (at least 7) is a prefix of the longer.
export function sameHead(a: string | undefined, b: string | undefined): boolean {
  const x = (a ?? "").trim().toLowerCase(), y = (b ?? "").trim().toLowerCase();
  const [s, l] = x.length <= y.length ? [x, y] : [y, x];
  return !!s && (x === y || (s.length >= 7 && l.startsWith(s)));
}

const REL_POLL_MS = 20_000, REL_READ_TRIES = 15, REL_FIND_TRIES = 15;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

// A person's click only. Before steps, then one release pipeline run merges the open master PRs in dependency
// order and waits for each deploy, then the after steps. A failure stops with the reason; a re-click sends only open PRs.
export async function mergeMaster(ctx: Ctx, planId: string): Promise<void> {
  const { ports } = ctx;
  const p = ctx.st.plans[planId]!;
  try {
    if (!ports.release) return planError(ctx, p, "This host has no release runner (release pipeline), so Merge cannot merge the master PRs.");
    if (p.release?.state === "starting") { // cut between asking the git host to start and its answer: a second start could merge twice
      p.release.state = "fail"; p.release.failed = { reason: "The backend stopped while it was starting the run" };
      return planError(ctx, p, "The backend stopped while it was starting the release pipeline. Check the pipelines page of the release pipeline for a run first: if one runs, wait for it to end, then press Retry and Merge.");
    }
    let prs = [...p.masterPrs].sort((a, b) => a.order - b.order);
    const group = (key: string) => { if (p.stopRequested) throw new Halt(); return runGroup(ctx, p, key, prs); };
    if (p.release?.state !== "running") {
      for (const pr of prs.filter((r) => r.state === "open")) { // master may have moved since this PR was built: rebuild it first, never merge a stale one
        if (p.stopRequested) throw new Halt();
        const r = await refreshMasterPr(ctx, p, pr, `Master moved: refreshing the ${pr.repo} master PR before the release run`);
        if (r.err) return planError(ctx, p, `Master moved and refreshing the ${pr.repo} master PR failed, so nothing was merged: ${r.err}`, "master");
        if (r.status === "dropped") prs = prs.filter((x) => x !== pr);
      }
      for (const pr of prs.filter((r) => r.state === "open")) { // in-house library SNAPSHOTs are pinned first: the runner cannot bump versions
        const no = await pinSnapshots(ctx, p, pr, prs.filter((r) => r.state === "open"));
        if (no) return planError(ctx, p, no.err, no.step);
        if (pr.state === "declined") prs = prs.filter((x) => x !== pr); // the pinned rebuild found everything already on master
      }
      for (const pr of prs.filter((r) => r.state === "merged" && !r.deployed)) { const e = confirmDeploy(ctx, p, pr); if (e) return planError(ctx, p, e, undefined, true); }
      for (const pr of prs.filter((r) => r.state === "open")) {
        const head = await ports.prs.head(pr.repo, pr.id);
        if (!sameHead(head, pr.head)) return planError(ctx, p, `${pr.repo} PR #${pr.id} changed after it was tested, so nothing was merged. Edit the plan to make and test new PRs.`);
      }
      // Every before step runs first: the runner merges everything in one go.
      const keys = [...new Set((p.releaseSteps ?? []).map(groupOf))].filter((k) => k === "start" || k.startsWith("before:"));
      const rank = (k: string) => (k === "start" ? -1 : prs.findIndex((r) => k === `before:${r.repo}`) + 1 || prs.length + 1);
      for (const key of keys.sort((a, b) => rank(a) - rank(b))) { const e = await group(key); if (e) return planError(ctx, p, e); }
      const todo = prs.filter((r) => r.state === "open");
      if (todo.length) { const e = await startRun(ctx, p, todo); if (e) return planError(ctx, p, e); }
    }
    if (p.release?.state === "running") { const e = await watchRun(ctx, p, prs); if (e) return planError(ctx, p, e); }
    for (const pr of prs) {
      if (pr.state !== "merged") return planError(ctx, p, `${pr.repo} PR #${pr.id} is ${pr.state}, not merged. Press Retry and Merge again.`);
      if (!pr.deployed) { const e = confirmDeploy(ctx, p, pr); if (e) return planError(ctx, p, e, undefined, true); }
      const ask = byHandStop(ctx, p, pr);
      if (ask) return planError(ctx, p, ask, undefined, true);
      const e = await group(`after:${pr.repo}`);
      if (e) return planError(ctx, p, e);
    }
    // Steps tied to a repo whose PR was dropped (its change was already on master) run last, in order.
    for (const key of [...new Set((p.releaseSteps ?? []).map(groupOf))].filter((k) => k.startsWith("after:") && !prs.some((r) => k === `after:${r.repo}`))) {
      const e = await group(key);
      if (e) return planError(ctx, p, e);
    }
    const left = (p.releaseSteps ?? []).filter((s) => s.state !== "done" && s.state !== "manual");
    if (left.length) return planError(ctx, p, `Release steps not done: ${left.map((s) => s.title).join(", ")}`);
    await dropPlanDirs(ctx, p);
    p.steps.master = "done"; p.liveAt = ctx.now();
    const byHand = prs.filter((r) => r.byHand).map((r) => r.repo);
    if (!prs.length) setNow(ctx, p, "Everything is already on master. Nothing was merged.", "ok");
    else setNow(ctx, p, `${prs.length}/${prs.length} merged by you · live on prod${byHand.length ? ` · deploy ${byHand.join(", ")} by hand` : ""}`, "ok");
    ctx.ev(p.id, "live", { text: "All master PRs merged. Live on prod.", run: p.release?.run, url: p.release?.url });
    ctx.change();
  } catch (e) {
    if (e instanceof Halt) return void ctx.ev(p.id, "stopped", { text: "Merge to master stopped" });
    throw e; // the engine retries a transient failure; a repeat is safe (a running release run is watched again, not started again)
  }
}

// Which release pipeline run: the master merge (Plan.release) or the staging merge (Plan.stagingRelease). Same runner, same log.
interface Slot { target: "staging" | "master"; get(): ReleaseRun; set(r: ReleaseRun): void; again: string }
const masterSlot = (p: Plan): Slot => ({ target: "master", get: () => p.release!, set: (r) => { p.release = r; }, again: "press Merge again" });
const stagingSlot = (p: Plan): Slot => ({ target: "staging", get: () => p.stagingRelease!, set: (r) => { p.stagingRelease = r; }, again: "press Retry" });

// Starts one release pipeline run for these open PRs. Never retried on its own: a second start could merge the same PRs twice.
async function startRun(ctx: Ctx, p: Plan, todo: PrRef[], slot: Slot = masterSlot(p)): Promise<string | null> {
  const prs = todo.map((r) => `${r.repo}#${r.id}`);
  for (const r of todo) { r.run = undefined; r.pipeline = undefined; r.tag = undefined; }
  slot.set({ state: "starting", startedAt: ctx.now(), prs, run: 0, url: "", uuid: "", runs: [] });
  const R = slot.get();
  const tag = slot.target === "staging" ? " (staging)" : ""; // master texts stay as they were
  setNow(ctx, p, `Starting the release pipeline${tag} for ${plural(todo.length, "PR")}`); ctx.change();
  let ref: { run: number; url: string; uuid: string };
  try { ref = await ctx.ports.release!.start(slot.target, todo.map((r) => ({ repo: r.repo, id: r.id }))); }
  catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    R.state = "fail"; R.failed = { reason: `did not start: ${why}` }; R.endedAt = ctx.now();
    ctx.ev(p.id, "release_run_failed", { text: `The release pipeline${tag} did not start: ${why}`, error: why, target: slot.target });
    return `The release pipeline${tag} did not start: ${why}. Check the pipelines page of the release pipeline for a run before you ${slot.again}: a second run would merge the same PRs.`;
  }
  Object.assign(R, ref, { state: "running", runs: [ref] });
  ctx.ev(p.id, "release_run_start", { text: `The release pipeline run #${ref.run}${tag} started for ${prs.join(", ")} ${ref.url}`, run: ref.run, url: ref.url, uuid: ref.uuid, prs, target: slot.target });
  setNow(ctx, p, `Release run #${ref.run}: the release pipeline merges ${plural(todo.length, "PR")}${tag ? " into staging" : ""} in dependency order`); ctx.change();
  return null;
}

// Follows the release run (and its hand-offs) until it ends, updating each PR from the runner's log. Returns why it failed, or null.
async function watchRun(ctx: Ctx, p: Plan, prs: PrRef[], slot: Slot = masterSlot(p)): Promise<string | null> {
  const rel = ctx.ports.release!, R = slot.get();
  const mine = prs.filter((r) => R.prs.includes(`${r.repo}#${r.id}`));
  let fails = 0;
  for (;;) {
    if (p.stopRequested) throw new Halt();
    let st: { done: boolean; result?: string }, log = "";
    try { st = await rel.status(R.uuid); log = await rel.log(R.uuid).catch(() => ""); fails = 0; }
    catch (e) {
      if (++fails >= REL_READ_TRIES) throw new Transient(`Could not read the release pipeline run #${R.run}: ${e instanceof Error ? e.message : String(e)}`);
      await ctx.sleep(REL_POLL_MS); continue;
    }
    const v = parseRunLog(log);
    applyLog(ctx, p, mine, v, slot);
    if (!st.done) { await ctx.sleep(REL_POLL_MS); continue; }
    await settle(ctx, p, mine, slot);
    const open = mine.filter((r) => r.state === "open");
    if (st.result === "SUCCESSFUL" && !v.stop && open.length) { // a hand-off: the rest runs in a new release run
      const next = await findNext(ctx, R.run, v.handoff?.run);
      if (!next) {
        const reason = `run #${R.run} ended with ${open.map((r) => r.repo).join(", ")} not merged, and no follow-up run was found`;
        endRun(ctx, p, "fail", st.result, { reason }, slot);
        return `Release ${reason}. Check the pipelines page of the release pipeline, then ${slot.target === "master" ? "press Retry and Merge" : "press Retry"}: the open PRs go to a new run. ${R.url}`;
      }
      ctx.ev(p.id, "release_run_handoff", { text: `Release run #${R.run} reached its time limit; run #${next.run} carries on with ${open.map((r) => `${r.repo}#${r.id}`).join(", ")} ${next.url}`, from: R.run, run: next.run, url: next.url, uuid: next.uuid });
      Object.assign(R, next); R.runs = [...R.runs, next]; ctx.change();
      continue;
    }
    if (st.result === "SUCCESSFUL" && !v.stop) {
      for (const r of mine) markDeployed(ctx, p, r, v.prs[r.repo]?.noPipeline, slot);
      return endRun(ctx, p, "done", st.result, undefined, slot);
    }
    const f = v.failed ?? { reason: v.stop ?? `the run ended ${st.result ?? "without a result"}` };
    const bad = mine.find((r) => r.repo === f.repo);
    if (bad) { bad.run = "failed"; ctx.ev(p.id, slot.target === "master" ? "master_deploy" : "deploy_wait", { text: `${bad.repo}: release run #${R.run} failed at ${f.step ?? "its step"}: ${f.reason}`, repo: bad.repo, id: bad.id, ok: false, detail: f.reason, step: f.step, url: R.url }); }
    endRun(ctx, p, "fail", st.result, f, slot);
    const where = f.repo ? `stopped at ${f.repo}${f.step ? `, step '${f.step}'` : ""}` : mine.some((r) => r.state === "merged") ? "stopped" : "stopped before merging anything";
    const done = mine.filter((r) => r.state === "merged").map((r) => r.repo);
    return `Release run #${R.run} ${where}: ${f.reason}${done.length ? ` (merged so far: ${done.join(", ")})` : ""}. ${R.url}`;
  }
}

function endRun(ctx: Ctx, p: Plan, state: "done" | "fail", result?: string, failed?: { repo?: string; step?: string; reason: string }, slot: Slot = masterSlot(p)): null {
  const R = slot.get();
  Object.assign(R, { state, result, failed, endedAt: ctx.now(), waitTag: undefined });
  ctx.ev(p.id, state === "done" ? "release_run_done" : "release_run_failed", { text: state === "done" ? `Release run #${R.run} finished: every PR merged and deployed` : `Release run #${R.run} failed${failed?.repo ? ` at ${failed.repo}` : ""}: ${failed?.reason ?? result}`, run: R.run, url: R.url, result, ...failed });
  ctx.change();
  return null;
}

// The hand-off run: the one the log names, else the first release run after this one. Waits a little for it to show.
async function findNext(ctx: Ctx, run: number, named?: number): Promise<{ run: number; url: string; uuid: string } | null> {
  for (let i = 0; i < REL_FIND_TRIES; i++) {
    const n = await ctx.ports.release!.after(run).catch(() => null);
    if (n && (!named || n.run === named)) return n;
    if (n && named && n.run > named) return null;
    await ctx.sleep(REL_POLL_MS);
  }
  return null;
}

// After a run ends: each PR's state from the git host, so a re-click sends only the PRs still open.
async function settle(ctx: Ctx, p: Plan, mine: PrRef[], slot: Slot = masterSlot(p)): Promise<void> {
  for (const r of mine.filter((x) => x.state === "open")) {
    const s = await ctx.ports.prs.state(r.repo, r.id).catch(() => null);
    if (s === "merged") markMerged(ctx, p, r, undefined, slot);
  }
}

function markMerged(ctx: Ctx, p: Plan, r: PrRef, merge?: string, slot: Slot = masterSlot(p)): void {
  if (merge && !r.merge) r.merge = merge;
  if (r.state === "merged") return;
  r.state = "merged";
  const run = slot.get()?.run, m = slot.target === "master";
  ctx.ev(p.id, m ? "master_merged" : "pr_merged", { text: `${r.repo}: ${slot.target} PR #${r.id} merged by release run #${run}${r.merge ? ` (${r.merge.slice(0, 10)})` : ""}`, repo: r.repo, id: r.id, merge: r.merge, run });
}

function markDeployed(ctx: Ctx, p: Plan, r: PrRef, noPipeline?: boolean, slot: Slot = masterSlot(p)): void {
  markMerged(ctx, p, r, undefined, slot);
  r.run = undefined; r.tag = undefined;
  if (r.deployed) return;
  r.deployed = true;
  const run = slot.get()?.run, m = slot.target === "master";
  if (noPipeline) r.byHand = `no ${slot.target} pipeline ran for this merge (the release pipeline went on after 10 minutes)`;
  ctx.ev(p.id, m ? (noPipeline ? "master_deploy_manual" : "master_deploy") : noPipeline ? "deploy_manual" : "deploy_wait", { text: `${r.repo}: ${noPipeline ? `no ${m ? "prod" : "staging"} pipeline ran; deploy it by hand` : m ? "prod pipeline passed" : "staging deploy finished"} (release run #${run})`, repo: r.repo, id: r.id, ok: true, pipeline: r.pipeline, run });
}

// The runner's log, applied to each PR as it happens; `now` says what the run does and, during a tag wait, what to click.
function applyLog(ctx: Ctx, p: Plan, mine: PrRef[], v: RunLog, slot: Slot = masterSlot(p)): void {
  const R = slot.get();
  for (const r of mine) {
    const x = v.prs[r.repo];
    if (!x || x.id !== r.id) continue;
    if (x.pipeline) r.pipeline = x.pipeline;
    if (x.merged) markMerged(ctx, p, r, x.merge, slot);
    if (x.state === "done" || x.result === "SUCCESSFUL") markDeployed(ctx, p, r, x.noPipeline, slot); // SUCCESSFUL: deployed, even if its tag wait then failed
    else if (!r.deployed) { r.run = x.state; r.tag = x.tag; }
  }
  R.waitTag = v.waitTag;
  const n = mine.length, cur = v.cur ? mine.find((r) => r.repo === v.cur) : undefined, k = cur ? mine.filter((r) => r.state === "merged").length : 0;
  const text = v.waitTag ? `Release run #${R.run}: waiting for tag ${v.waitTag.tag}. Click Create Release Version in ${v.waitTag.repo}'s master pipeline.`
    : cur?.run === "merging" ? `Release run #${R.run}: merging ${cur.repo} PR #${cur.id} (${k + 1} of ${n})`
      : cur?.run === "deploying" ? `Release run #${R.run}: ${cur.repo} merged (${k} of ${n}); waiting for its ${slot.target} pipeline`
        : cur ? `Release run #${R.run}: ${k} of ${n} merged` : `Release run #${R.run}: the release pipeline is checking the ${plural(n, "PR")}`;
  if (p.now !== text) setNow(ctx, p, text);
  ctx.changeSoon();
}

// A merged PR whose prod pipeline did not pass in its release run: stop once so the user re-runs it; the next click counts it as deployed.
function confirmDeploy(ctx: Ctx, p: Plan, pr: PrRef): string | null {
  const asked = readEvents(ctx.ports.dataDir, p.id, Infinity).some((e) => e.event === "deploy_confirm_asked" && e.repo === pr.repo && e.id === pr.id);
  if (!asked) {
    ctx.ev(p.id, "deploy_confirm_asked", { text: `${pr.repo} PR #${pr.id} is merged, but its prod pipeline did not pass in the release run`, repo: pr.repo, id: pr.id });
    return `${pr.repo} PR #${pr.id} is merged, but its prod pipeline did not pass${pr.pipeline ? ` (${pr.pipeline})` : ""}. Fix it and re-run that pipeline in the git host. When it passes, press Retry and Merge again: that click counts it as deployed, then the PRs still open go to a new release run.`;
  }
  pr.deployed = true; pr.run = undefined; pr.byHand = "deploy confirmed by your Merge click after its pipeline failed";
  ctx.ev(p.id, "master_deploy_manual", { text: `${pr.repo}: you confirmed the prod deploy of PR #${pr.id} by pressing Merge again`, repo: pr.repo, id: pr.id });
  ctx.change();
  return null;
}

// Before the steps after a PR's deploy: a by-hand deploy stops once, so they run only after the user deployed it.
function byHandStop(ctx: Ctx, p: Plan, pr: PrRef): string | null {
  const mine = (p.releaseSteps ?? []).filter((s) => groupOf(s) === `after:${pr.repo}`);
  const needsDeploy = mine.some((s) => s.kind !== "release" && s.state !== "done");
  if (needsDeploy && pr.byHand && !readEvents(ctx.ports.dataDir, p.id, Infinity).some((e) => e.event === "after_by_hand" && e.repo === pr.repo)) {
    ctx.ev(p.id, "after_by_hand", { text: `${pr.repo} deploys by hand, so the steps after its deploy did not run`, repo: pr.repo });
    return `${pr.repo} deploys by hand, so the steps after its deploy did not run. Deploy it, then press Retry and Merge again: they run then.`;
  }
  return null;
}
