// One task: worktrees, executor, own-files check, build + debugger, review loop, merge into the plan branch.
import { diffRisk } from "./risk.ts";
import { randomUUID } from "node:crypto";
import { BLOCKING_CATEGORIES, type Finding, type Plan, type RepoPart, type Role, type Round, type Task } from "../types.ts";
import { agentBody } from "./agents.ts";
import { Deliberate, Transient } from "./errors.ts";
import { canClaim } from "./locks.ts";
import { EXEC_SCHEMA, FIX_SCHEMA, REVIEW_SCHEMA, SECURITY_ONLY, debugPrompt, execPrompt, fixPrompt, notesPrompt, reviewFollowUpPrompt, reviewPrompt } from "./prompts.ts";
import type { Ctx } from "./store.ts";
import { heldNow } from "./scheduler.ts";
import { dropBuildOutput, ensureDir, installPlanLibs, planLock, planRepoHeads, presentOnPlanBranch } from "./worktrees.ts";
import { ensureTarget } from "./target.ts";

class Fail extends Deliberate {}
class Stopped extends Error {}

const seenNotes = (t: Task): number => (t as any)._seen ?? 0;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const normKey = (fs: Finding[]) => [...new Set(fs.map((f) => f.text.toLowerCase().split("").filter((c) => !/[0-9\s]/.test(c)).join("")))].sort().join("|");
const isBlocking = (f: { severity: string; category: string }) => f.severity === "blocking" && (BLOCKING_CATEGORIES as readonly string[]).includes(f.category);

// An earlier plan changes one of the same files in the same repo: this task must build on its staged code.
function sharesWithEarlier(ctx: Ctx, t: Task, plan: Plan): boolean {
  return Object.values(ctx.st.tasks).some((u) => {
    const a = ctx.st.plans[u.planId];
    return !!a && a.order < plan.order && u.repo === t.repo && u.status !== "removed" && u.files.some((f) => t.files.includes(f));
  });
}

// A send-back (gate, architect, staging test) puts the finding in the task's notes and queues it again.
export function sendBack(ctx: Ctx, plan: Plan, t: Task, findings: Finding[], source: Round["source"], from: string) {
  t.notes.push(`${from} found a problem: ${findings.map((f) => f.text).join(" ")}`);
  t.rounds.push({ n: t.rounds.length + 1, at: ctx.now(), source, by: [...new Set(findings.map((f) => f.by))], blocking: findings, minor: [] });
  t.terminal = undefined; // a terminal task waits for a new "done"
  t.status = "waiting"; t.error = undefined; t.doneAt = undefined; t.sub = `Sent back by ${from}: ${findings.length} finding${findings.length === 1 ? "" : "s"}`;
  plan.gates[t.wave] = false;
  for (const r of plan.repos) r.staged = false; // the plan changes code again: later plans must wait for it
  ctx.ev(plan.id, "send_back", { task: t.id, text: `${t.label} sent back by ${from}: ${findings.map((f) => f.text).join(" | ")}`, source, findings });
}

export async function runTask(ctx: Ctx, taskId: string): Promise<void> {
  const { ports, cfg } = ctx;
  const t = ctx.st.tasks[taskId]!, plan = ctx.st.plans[t.planId]!;
  const part = plan.repos.find((r) => r.repo === t.repo) as RepoPart;
  const stopped = () => !!plan.stopRequested || !!t.stopRequested;
  const check = () => { if (stopped()) throw new Stopped(); };
  const ev = (event: string, text: string, extra: Record<string, unknown> = {}) => ctx.ev(plan.id, event, { task: t.id, text, ...extra });
  const sub = (s: string, status?: Task["status"]) => { t.sub = s; if (status) t.status = status; ctx.change(); };
  const model = (r: Role) => cap(cfg.models[r]);

  t.stopRequested = false; t.status = "working"; t.error = undefined; t.startedAt ??= ctx.now();
  if (plan.terminal) t.terminal = t.terminal?.done ? { done: t.terminal.done } : undefined; // ready again only once its worktree is set
  ctx.change();

  // Before a resumed write step: commit what is pending, then rebase the task branch onto the plan branch. Call inside the plan lock.
  const syncToPlan = async (taskDir: string, why: string): Promise<boolean> => {
    const sha = await ports.git.commitAll(taskDir, `[${plan.id}] ${t.label}: work in progress`);
    if (sha) t.commits.push(sha);
    const rb = await ports.git.rebase(taskDir, part.branch);
    ev("task_rebase", rb.ok ? `${t.label} rebased onto the plan branch (${why})` : `${t.label}: rebase onto the plan branch failed`, { ok: rb.ok, conflict: rb.conflict, onto: part.branch });
    if (!rb.ok) throw new Fail(`Rebase onto the plan branch failed: ${rb.conflict ?? "conflict"}`);
    return !!sha;
  };
  try {
    // 0. Worktrees. A task that already has one is resumed: it is rebased onto the plan branch first.
    const taskDir = `${ports.stageRoot}/${plan.id}/${t.label}`;
    let resumed = false, pending = false;
    await planLock(ctx, plan.id, t.repo, async () => {
      const ready = Object.values(ctx.st.tasks).some((u) => u.planId === plan.id && u.repo === t.repo && u.dir);
      if (!ready) {
        await ensureTarget(ctx, plan, part);
        await ports.git.worktree(t.repo, part.dir, part.branch, `origin/${part.base}`);
        ev("worktree", `Plan worktree for ${t.repo} created`, { dir: part.dir, branch: part.branch, base: `origin/${part.base}` });
      } else await ensureDir(ctx, plan.id, t.repo, part.dir, part.branch);
      if (!ready || sharesWithEarlier(ctx, t, plan)) {
        await ports.git.fetch(part.dir);
        const rb = await ports.git.rebase(part.dir, `origin/${part.base}`);
        ev("rebase", rb.ok ? `Plan branch rebased onto origin/${part.base}` : `Rebase onto origin/${part.base} failed`, { ok: rb.ok, conflict: rb.conflict, onto: `origin/${part.base}` });
        if (!rb.ok) throw new Fail(`Rebase onto origin/${part.base} failed: ${rb.conflict ?? "conflict"}`);
      }
      if (!t.dir) {
        t.branch = `${part.branch}-${t.label.toLowerCase()}`; t.dir = taskDir;
        await ports.git.worktree(t.repo, taskDir, t.branch, part.branch);
        ev("worktree", `Task worktree created`, { dir: taskDir, branch: t.branch, base: part.branch });
      } else { resumed = true; await ensureDir(ctx, plan.id, t.repo, t.dir, t.branch!, t.id); pending = await syncToPlan(t.dir, "the task carries on"); }
    });
    check();
    const dir = t.dir!;
    const finish = (text: string) => {
      t.status = "done"; t.doneAt = ctx.now(); t.sub = text; t.mergeFrom = undefined;
      try { dropBuildOutput(t.dir); } catch { /* space only; never fails the task */ }
      ev("task_done", `${t.label} is done`, { did: t.did, stat: t.stat });
      ctx.change();
    };
    // A crash after the merge but before "done": the task branch is already inside the plan branch.
    if (resumed && t.mergeFrom) {
      const ahead = await ports.git.commitsSince(dir, part.branch);
      check();
      if (!ahead.length) { ev("merge", `${t.label} was already merged into the plan branch before the restart`, { ok: true, recovered: true }); return finish("Done · build and tests pass · in the plan branch, not on staging yet"); }
      t.mergeFrom = undefined;
    }

    const withNotes = (prompt: string) => {
      const fresh = t.notes.slice(seenNotes(t));
      if (!fresh.length) return prompt;
      (t as any)._seen = t.notes.length;
      ev("note_delivered", `${fresh.length} update(s) from the edit given to the executor`, { notes: fresh });
      return `${prompt}\n\n${notesPrompt(fresh)}`;
    };

    const exec = async (prompt: string, resume: boolean, what: string) => {
      sub(`executor (${model("executor")}) is ${what}`);
      const sid = resume && t.sessionId ? t.sessionId : (t.sessionId = randomUUID());
      ctx.change();
      ev("executor_start", `executor (${model("executor")}) started: ${what}`, { sessionId: sid, resume });
      const res = await ctx.ask({ role: "executor", prompt, schema: EXEC_SCHEMA, edits: [dir], plan: plan.id, task: t.id, ...(resume && t.sessionId ? { resumeId: t.sessionId } : { sessionId: sid }) });
      check();
      if (res.sessionId) t.sessionId = res.sessionId;
      const x = res.structured ?? {};
      ev("executor_end", `executor finished: ${x.summary ?? res.error ?? "no summary"}`, { ok: res.ok, sessionId: t.sessionId, summary: x.summary, did: x.did, needs_files: x.needs_files, tests_added: x.tests_added, blocked: x.blocked, error: res.error });
      if (!res.ok || !res.structured) throw new Transient(`The executor failed: ${res.error ?? "no result"}`);
      return x as { summary: string; did: string; needs_files: string[]; tests_added: string[]; blocked?: string };
    };

    const ownFiles = async () => {
      const changed = await ports.git.changedFiles(dir, part.branch);
      check();
      const outside = changed.filter((f) => !t.files.includes(f));
      ev("files_changed", `Executor changed ${changed.length} file(s)${outside.length ? `; ${outside.length} outside its list` : ""}`, { files: changed, outside });
      return outside;
    };

    let fixedLines: string[] | undefined; // the executor's "fixed" lines from its last fix of review findings
    const writeLoop = async (first: string, resume: boolean, what: string) => {
      let prompt = first, again = resume;
      for (let i = 0; i < 6; i++) {
        const x = await exec(prompt, again, what); again = true;
        if (x.did) t.did = x.did;
        if (Array.isArray(x.fixed)) fixedLines = x.fixed.map(String).slice(0, 20);
        const asked = x.needs_files ?? [];
        // A request must be plain paths in this task's repo; anything else (another repo, a sentence) can never be granted.
        const notPath = asked.filter((f) => !/^[\w.\-/]+$/.test(f) || f.includes("..") || f.startsWith("/"));
        if (notPath.length) throw new Fail(`${t.label} needs a change outside ${t.repo}: ${notPath.join("; ")}. A task changes one repo only; edit the plan to add a task there.`);
        const again2 = asked.filter((f) => t.files.includes(f));
        if (asked.length && again2.length === asked.length && i > 0) throw new Fail(`The executor asked again for ${again2.join(", ")}, which it already has, so it could not write them.`);
        const want = asked.filter((f) => !t.files.includes(f));
        if (want.length) {
          const why = canClaim(ctx.st, t, want);
          ev("needs_files", why ? `Executor asked for ${want.join(", ")}: refused (${why})` : `Executor asked for ${want.join(", ")}: granted`, { files: want, granted: !why, reason: why });
          if (why) throw new Fail(`The task needs ${want.join(", ")}, which it cannot use: ${why}`);
          t.files.push(...want);
          prompt = `These files are now yours: ${want.join(", ")}. Finish the work with them.`;
          continue;
        }
        if (x.blocked) throw new Fail(`The executor is blocked: ${x.blocked}`);
        const outside = await ownFiles();
        if (!outside.length) return;
        // Edited without asking: the same rule as a request. A file no other task holds, and the change guard allows, becomes this
        // task's; only a held or banned one is a finding.
        const banned = outside.filter((f) => ports.diffGuard([f], "") !== null), held = banned.length ? null : canClaim(ctx.st, t, outside);
        if (!banned.length && !held) {
          t.files.push(...outside);
          ev("files_claimed", `${t.label} changed ${outside.join(", ")} outside its list; no other task holds them, so they are now its files`, { files: outside });
          return;
        }
        const why = banned.length ? `Tasks may not change ${banned.join(", ")}` : held;
        const finding: Finding = { severity: "blocking", category: "bad_code", text: `Changed files outside its list that it cannot take: ${outside.join(", ")} (${why}). Undo your changes to them and finish the task without them, or say in needs_files why you need them.`, by: "executor" };
        t.rounds.push({ n: t.rounds.length + 1, at: ctx.now(), source: "review", by: ["executor"], blocking: [finding], minor: [] });
        prompt = fixPrompt([finding], "The server");
      }
      throw new Fail("The executor kept changing files outside its list.");
    };

    let debugged = false; // a debugger committed code: the diff check turns the review on
    const commit = async (msg: string) => {
      const sha = await ports.git.commitAll(dir, `[${plan.id}] ${t.label}: ${msg}`);
      check();
      if (sha) t.commits.push(sha);
      if (sha && /^build fix/.test(msg)) debugged = true;
      ev("commit", sha ? `Committed ${sha}` : "Nothing new to commit", { sha });
    };

    // quick: compile only (between review rounds); the full build with tests runs before the task is done.
    const buildLoop = async (quick = false) => {
      for (let fix = 0; ; fix++) {
        sub(quick ? "Compiling the fix" : "Build and tests are running", "working");
        await installPlanLibs(ctx, plan, t.repo, dir);
        const b = await ports.build(dir, quick ? { quick: true } : undefined);
        check();
        ev("build", `${quick ? "Compile" : "Build"} ${b.ok ? "passed" : b.ran ? "failed" : "did not run"}`, { ok: b.ok, ran: b.ran, quick, tail: b.tail.slice(0, 2000) });
        if (b.ok || !b.ran) return;
        if (fix >= cfg.maxBuildFixes) throw new Fail(`The build still fails after ${fix} fix attempt${fix === 1 ? "" : "s"}: ${b.tail.slice(-1500)}`);
        sub(`Build failed; debugger (${model("debugger")}) is fixing it (try ${fix + 1} of ${cfg.maxBuildFixes})`);
        const sid = randomUUID();
        ev("debugger_start", `debugger (${model("debugger")}) started on the failed build (try ${fix + 1})`, { sessionId: sid });
        const d = await ctx.ask({ role: "debugger", prompt: debugPrompt(agentBody("debugger"), `task ${t.label}`, b.tail.slice(-6000)), schema: FIX_SCHEMA, edits: [dir], sessionId: sid, plan: plan.id, task: t.id });
        check();
        ev("debugger_end", `debugger finished: ${d.structured?.summary ?? d.error ?? "no summary"}`, { ok: d.ok, sessionId: d.sessionId ?? sid, summary: d.structured?.summary, cause: d.structured?.cause });
        if (!d.ok) throw new Transient(`The debugger failed: ${d.error ?? "no result"}`);
        await commit(`build fix ${fix + 1}`);
      }
    };

    // A refused change goes back to the executor to be fixed (e.g. undo a build file it may not touch), twice at most.
    const afterWrite = async (quick = false) => {
      for (let tryNo = 0; ; tryNo++) {
        const files = await ports.git.changedFiles(dir, part.branch);
        const diff = await ports.git.diff(dir, part.branch);
        check();
        const refused = ports.diffGuard(files, diff);
        ev("diff_guard", refused ? `Change refused: ${refused}` : "Change passed the diff guard", { refused, try: tryNo + 1 });
        if (!refused) break;
        if (tryNo >= 2) throw new Fail(`The change was refused: ${refused}`);
        const banned = files.filter((f) => ports.diffGuard([f], "") !== null);
        if (banned.length) t.files = t.files.filter((f) => !banned.includes(f));
        const finding: Finding = { severity: "blocking", category: "bad_code", by: "executor",
          text: `The server refused the change: ${refused}${banned.length ? ` Undo every change to ${banned.join(", ")} and finish the task without them. If they were only there to run a new unit test in a repo with no test setup, drop that test: the staging test covers the change.` : " Fix exactly that and nothing else."}` };
        t.rounds.push({ n: t.rounds.length + 1, at: ctx.now(), source: "review", by: ["executor"], blocking: [finding], minor: [] });
        sub(`The change guard refused it; ${model("executor")} is fixing it (try ${tryNo + 1} of 2)`, "working");
        await writeLoop(fixPrompt([finding], "The server"), true, "fixing what the change guard refused");
      }
      await commit(t.title);
      if (cfg.buildEachTask) await buildLoop(quick); // off: the task is only reviewed; the last wave's gate builds each repo once
    };

    // A terminal plan (/ship): that session's subagents write and review the task in this worktree; the engine waits for its
    // "done", then merges. The done is used once, so a send-back waits for a new one.
    if (plan.terminal) {
      t.terminal = { readyAt: ctx.now(), done: t.terminal?.done };
      sub(t.notes.length > seenNotes(t) ? "Sent back: waiting for the terminal to fix it" : "Ready: waiting for the terminal's executor", "working");
      ev("terminal_ready", `${t.label} is ready for the terminal in ${dir} (branch ${t.branch})`, { dir, branch: t.branch });
      while (!t.terminal?.done) { await ctx.sleep(2000); await new Promise((r) => setTimeout(r, 5)); check(); }
      t.did = t.terminal.done.did; t.terminal.done = undefined; (t as any)._seen = t.notes.length;
      const changed = await ports.git.changedFiles(dir, part.branch);
      t.files = [...new Set([...t.files, ...changed])];
    } else {
    // 1-4. Write, check, commit, build. A review a restart cut, with no work pending and no new notes, goes straight back to review.
    const backToReview = resumed && !!t.reviewing && !pending && !!t.commits.length && seenNotes(t) >= t.notes.length && !!(await ports.git.changedFiles(dir, part.branch)).length;
    if (backToReview) ev("review_resumed", `${t.label}: the restart cut review round ${t.reviewing}; it goes straight back to review, the code is unchanged`);
    t.reviewing = undefined;
    const resuming = !!t.sessionId;
    const unseen = t.notes.slice(seenNotes(t));
    let first: string;
    if (backToReview) first = "";
    else if (resuming) first = unseen.length ? withNotes("Carry on with your task.") : "Carry on with your task: check your work is complete against the task, then report again.";
    else { first = execPrompt(agentBody("executor"), plan, t); (t as any)._seen = t.notes.length; }
    if (!backToReview) {
      await writeLoop(first, resuming, "writing the code and its tests");
      // A reopened task whose executor changed nothing: its work is already in the plan branch.
      if (t.commits.length && !(await ports.git.changedFiles(dir, part.branch)).length) {
        check(); ev("no_change", `${t.label}: the executor changed nothing; the work is already in the plan branch`);
        return finish("No change needed · already in the plan branch");
      }
      await afterWrite();
    }

    // 5. Review loop
    // The planner's call, unless the real diff disagrees: the diff can turn a review on, never off.
    const risk = diffRisk(t.files, await ports.git.changedFiles(dir, part.branch), await ports.git.diff(dir, part.branch), debugged, cfg);
    if (t.review === false && (risk.review.length || risk.security.length)) {
      t.review = true; t.reviewWhy = `turned on by the diff: ${[...risk.review, ...risk.security].join("; ")}`;
      ev("review_forced", `${t.label}: code review turned on by the diff: ${[...risk.review, ...risk.security].join("; ")}`, { reasons: risk });
    }
    if (!t.security && risk.security.length) {
      t.security = true; t.securityWhy = `turned on by the diff: ${risk.security.join("; ")}`;
      ev("security_forced", `${t.label}: security review turned on by the diff: ${risk.security.join("; ")}`, { reasons: risk.security });
    }
    if (t.review === false && !t.security) ev("review_skipped", `${t.label}: no code review (the planner: ${t.reviewWhy || "small mechanical change"})`);
    else {
      let prevKey = "", runRounds = 0, quickSince = false, signoffNext = false;
      // Held for a pending plan change: the task waits, and no round is spent (or counted) on instructions about to change.
      const hold = () => { t.status = "waiting"; t.sub = "Held: waits for the plan change it needs"; ev("task_held", `${t.label} is held until the plan change for it is planned; no round is counted meanwhile`); ctx.change(); };
      for (;;) {
        if (heldNow(plan, t)) return hold();
        runRounds++;
        const n = t.rounds.length + 1;
        const last = [...t.rounds].reverse().find((r) => r.source === "review" && r.by.includes("code-reviewer"));
        const earlier = last?.blocking ?? [], earlierMinor = (last?.minor ?? []).filter((f) => (BLOCKING_CATEGORIES as readonly string[]).includes(f.category)); // style points never come back
        const signoff = signoffNext; signoffNext = false;
        // Later rounds resume the task's own reviewer; after a clean resumed verdict a fresh reviewer signs off (cfg.reviewerResume).
        const ownLast = cfg.reviewerResume && t.reviewSessionId ? [...t.rounds].reverse().find((r) => r.source === "review" && r.sid === t.reviewSessionId) : undefined;
        const resume = !signoff && !!ownLast;
        const how = signoff ? "final sign-off, fresh" : resume ? "resumed" : "fresh";
        sub(`Round ${n} (code-reviewer, ${how === "resumed" ? cap(cfg.resumedReviewModel) : model("code-reviewer")}, ${how}) is reviewing the change`, "review");
        t.reviewing = n; ctx.change();
        const diff = await ports.git.diff(dir, part.branch);
        // What a fresh reviewer is told: the writer's fix claims, the change since the last review, and the earlier rounds.
        const since = last?.head && !signoff ? await ports.git.diff(dir, last.head).catch(() => "") : "";
        // Every earlier round's findings and fixes, not only the last few, so a fresh sign-off knows all of them.
        const history = t.rounds.filter((r) => (signoff || r !== last) && r.blocking.length).flatMap((r) => r.blocking.map((f, i) => `Round ${r.n}: ${f.short ?? f.text.slice(0, 200)}${r.fixed?.[i] ? ` · fixed: ${r.fixed[i]}` : ""}`));
        const context = { fixed: signoff ? undefined : last?.fixed, since, history, repos: await planRepoHeads(ctx, plan) };
        let sid = "", reviewer: "fresh" | "resumed" | "signoff" = signoff ? "signoff" : "fresh";
        const run = async (role: "code-reviewer" | "security-reviewer") => {
          const freshAsk = async () => {
            const fsid = randomUUID();
            if (role === "code-reviewer") sid = fsid;
            ev("review_start", `${role} (${model(role)}) started round ${n}${role === "code-reviewer" ? ` (${how === "resumed" ? "fresh, the resume failed" : how})` : ""}`, { role, sessionId: fsid, mode: role === "code-reviewer" && signoff ? "signoff" : "fresh" });
            return ctx.ask({ role, prompt: reviewPrompt(agentBody(role), plan, t, diff, earlier, earlierMinor, context) + (role === "security-reviewer" ? SECURITY_ONLY : ""), schema: REVIEW_SCHEMA, sessionId: fsid, plan: plan.id, task: t.id });
          };
          let res: Awaited<ReturnType<typeof ctx.ask>> | undefined;
          if (role === "code-reviewer" && resume) {
            // Its findings (and a sign-off's) since it last looked, what the writer did for each, and only the change since.
            const from = t.rounds.indexOf(ownLast!);
            // Every send-back since, not only task reviews: the last review, the architect and the UAT test say why the code changed.
            const items = t.rounds.slice(from).filter((r) => r.blocking.length).flatMap((r) => r.blocking.map((f, i) => ({ text: `${r.source === "review" ? "" : `[sent back by ${({ sweep: "the last review", architect: "the architect", uat: "the UAT test", gate: "the build" } as Record<string, string>)[r.source] ?? r.source}] `}${f.short ?? f.text.slice(0, 600)}`, note: r.fixed?.[i] ?? "no claim given; check the code", signoff: r.reviewer === "signoff" })));
            const seen = ownLast!.head ? await ports.git.diff(dir, ownLast!.head).catch(() => "") : "";
            const hist = t.rounds.filter((r) => r.blocking.length && !t.rounds.slice(from).includes(r)).flatMap((r) => r.blocking.map((f, i) => `Round ${r.n}: ${f.short ?? f.text.slice(0, 200)}${r.fixed?.[i] ? ` · fixed: ${r.fixed[i]}` : ""}`));
            sid = t.reviewSessionId!; reviewer = "resumed";
            ev("review_start", `${role} (${cap(cfg.resumedReviewModel)}) started round ${n} (resumed)`, { role, sessionId: sid, mode: "resumed", resume: true, model: cfg.resumedReviewModel });
            res = await ctx.ask({ role, prompt: reviewFollowUpPrompt(plan, items, seen, earlierMinor, { history: hist, repos: context.repos }), schema: REVIEW_SCHEMA, resumeId: sid, plan: plan.id, task: t.id, model: cfg.resumedReviewModel }); // Sonnet: a narrow check
            check();
            if (!res.ok || !res.structured) { ev("review_resume_failed", `${t.label}: resuming the code-reviewer session failed (${res.error ?? "no result"}); a fresh reviewer reads it with the full context`, { sessionId: sid, error: res.error }); res = undefined; reviewer = "fresh"; }
            else sid = res.sessionId ?? sid;
          }
          if (!res) res = await freshAsk();
          check();
          if (!res.ok || !res.structured) throw new Transient(`The ${role} failed: ${res.error ?? "no result"}`);
          if (role === "code-reviewer") { sid = res.sessionId ?? sid; if (!signoff) t.reviewSessionId = sid; }
          return res.structured as { findings: Omit<Finding, "by">[] };
        };
        const cr = await run("code-reviewer");
        const by: Role[] = ["code-reviewer"];
        let all: Finding[] = cr.findings.map((f) => ({ ...f, by: "code-reviewer" as const }));
        // Security review once per task, on the change that may be final: a round the code reviewer found clean
        // that ends the task (round 1, or the fresh sign-off), and again only to check its own blocking findings were fixed.
        const lastSec = [...t.rounds].reverse().find((r) => r.source === "review" && r.by.includes("security-reviewer"));
        const ownOpen = !!lastSec?.blocking.some((f) => f.by === "security-reviewer"), crClean = !cr.findings.some((f) => f.severity === "blocking");
        const sameCode = !!lastSec?.head && lastSec.head === (await ports.git.head(dir).catch(() => "")); // it already passed this exact code
        if (t.security && ((crClean && how !== "resumed" && !sameCode) || ownOpen)) {
          sub(`Round ${n} (security-reviewer, ${model("security-reviewer")}) is reviewing the change`);
          const sr = await run("security-reviewer");
          by.push("security-reviewer");
          // Security only: anything else it notices is the code reviewer's job.
          const sec = sr.findings.filter((f) => f.category === "security"), dropped = sr.findings.length - sec.length;
          if (dropped) ev("security_dropped", `${t.label}: ${dropped} non-security finding${dropped === 1 ? "" : "s"} from the security reviewer left to the code reviewer`, { dropped });
          all = all.concat(sec.map((f) => ({ ...f, by: "security-reviewer" as const })));
        }
        // "Another repo of this plan lacks X": checked on that repo's plan branch first; a name that is there closes it (playbook C4).
        t.reviewing = undefined;
        for (const f of all.filter((x) => isBlocking(x) && x.other_repo && x.other_repo !== t.repo && x.other_symbols?.length)) {
          const at = await presentOnPlanBranch(ctx, plan, f.other_repo!, f.other_symbols!);
          if (!at) continue;
          all = all.filter((x) => x !== f);
          ev("finding_closed", `${t.label}: closed: present on plan branch ${at} (${f.other_symbols!.join(", ")}): ${f.short ?? f.text.slice(0, 200)}`, { finding: f, at });
        }
        // A plan finding in the task's own files gets one try by its writer; if it comes back, it goes to the planner.
        const writerTried = (f: Finding) => earlier.some((e) => e.fix_in === "plan" && e.file === f.file);
        const toPlan = (f: Finding) => f.fix_in === "plan" && (!(f.file && t.files.includes(f.file)) || writerTried(f));
        // The same concern a third time is a design decision, not another round.
        const decide = (f: Finding) => isBlocking(f) && (f.repeat_of_rounds?.length ?? 0) >= 2;
        for (const f of all) if (decide(f)) { f.fix_in = "plan"; f.text = `Design decision needed: ${t.label} raised this in rounds ${f.repeat_of_rounds!.join(", ")} and again now. Decide: accept the risk, cover it in another task, or split the task. ${f.text}`; }
        const forPlan = all.filter((f) => isBlocking(f) && (toPlan(f) || decide(f))), blocking = all.filter((f) => isBlocking(f) && !toPlan(f) && !decide(f)), minor = all.filter((f) => !isBlocking(f));
        const fresh = forPlan.map((f) => f.short ?? f.text).filter((x) => !(plan.planFixesSent ?? []).includes(x));
        // Also held when a finding it raises again is still queued or being planned: a round on it now is wasted.
        const pending = forPlan.map((f) => f.short ?? f.text).filter((k) => plan.planFixes?.includes(k) || (plan.steps.plan === "run" && plan.versions.at(-1)?.fixes?.includes(k)));
        if (pending.length) { t.heldForPlan = true; if (plan.planFixes && pending.some((k) => plan.planFixes!.includes(k))) plan.planFixHolds = [...new Set([...(plan.planFixHolds ?? []), t.id])]; }
        if (fresh.length) { plan.planFixes = [...(plan.planFixes ?? []), ...fresh]; plan.planFixesSent = [...(plan.planFixesSent ?? []), ...fresh]; plan.planFixHolds = [...new Set([...(plan.planFixHolds ?? []), t.id])]; t.heldForPlan = true; ev("plan_fix_needed", `${t.label}: ${fresh.length} problem${fresh.length === 1 ? "" : "s"} in the plan itself, sent to the planner: ${fresh.join(" | ").slice(0, 300)}`); }
        const head = await ports.git.head(dir).catch(() => undefined);
        t.rounds.push({ n, at: ctx.now(), source: "review", by, head, sid, reviewer, blocking: [...blocking, ...forPlan.map((f) => ({ ...f, text: `(Sent to the planner, not this writer) ${f.text}` }))], minor });
        ev("review_round", `Review round ${n} (${by.join(", ")}): ${blocking.length} blocking, ${minor.length} minor`, { round: n, by, blocking, minor });
        if (!blocking.length) {
          // A plan change that arrived while the task ran: the writer applies it, then the change is reviewed again.
          if (t.notes.length > seenNotes(t)) {
            ev("review_again", `${t.label}: the plan changed while it ran, so the executor applies the update and the change is reviewed again`);
            sub("The plan changed: executor is applying the update", "working");
            await planLock(ctx, plan.id, t.repo, () => syncToPlan(dir, "before the plan update"));
            check();
            fixedLines = undefined;
            await writeLoop(withNotes("The plan changed while you worked. Apply the update below to your change, then report again."), true, "applying the plan update");
            await afterWrite(true); quickSince = true;
            continue;
          }
          // A clean verdict from a resumed session is not final: a fresh reviewer reads the whole change once more.
          if (reviewer === "resumed") { signoffNext = true; ev("review_signoff", `${t.label}: round ${n} is clean from the resumed reviewer; a fresh code-reviewer gives the final sign-off`); continue; }
          // Fix rounds only compiled: run the full build and tests once now. A debugger change after it needs one more review.
          if (!quickSince || !cfg.buildEachTask) break;
          quickSince = false;
          const before = await ports.git.head(dir);
          await buildLoop(false);
          if ((await ports.git.head(dir)) === before) break;
          ev("review_again", `${t.label}: the full build needed a fix after the last review, so the change is reviewed once more`);
          continue;
        }
        if (heldNow(plan, t)) return hold(); // the writer's fix waits for the plan change too
        const total = t.rounds.slice(t.roundBase ?? 0).filter((r) => r.source === "review").length;
        if (total >= cfg.maxTotalRounds) { t.needsYou = true; throw new Fail(`Stopped after ${total} review rounds in total and still not done; a Retry (yours or the watchdog's) gives it ${cfg.maxTotalRounds} more. Still blocking: ${blocking.map((f) => f.short ?? f.text).join(" | ")}`); }
        if (runRounds >= cfg.maxReviewRounds) throw new Fail(`Stopped after ${runRounds} review round${runRounds === 1 ? "" : "s"}; still blocking: ${blocking.map((f) => f.text).join(" | ")}`);
        const key = normKey(blocking);
        if (key === prevKey) throw new Fail(`The same problems came back twice, so the task stopped: ${blocking.map((f) => f.text).join(" | ")}`);
        prevKey = key;
        const fixing = `Round ${n} (${by.join(" + ")}, ${model("code-reviewer")}): ${blocking.length} blocking finding${blocking.length === 1 ? "" : "s"}; executor is fixing ${blocking.length === 1 ? "it" : "them"}`;
        sub(fixing, "working");
        await planLock(ctx, plan.id, t.repo, () => syncToPlan(dir, "before the fix"));
        check();
        fixedLines = undefined;
        await writeLoop(withNotes(fixPrompt(blocking, "The reviewers")), true, "fixing the review findings");
        Object.assign(t.rounds[t.rounds.length - 1]!, { fix: t.did, fixedAt: ctx.now(), fixed: fixedLines });
        await afterWrite(true); quickSince = true;
      }

    }
    } // end of the engine's own write and review steps

    // 6. Merge into the plan branch
    sub("Merging into the plan branch", "review");
    await commit(t.title);
    const files = await ports.git.changedFiles(dir, part.branch), whole = await ports.git.diff(dir, part.branch);
    check();
    const refused = ports.diffGuard(files, whole);
    ev("diff_guard", refused ? `Final change refused: ${refused}` : "Final change passed the diff guard", { refused, final: true });
    if (refused) throw new Fail(`The change was refused: ${refused}`);
    t.stat = await ports.git.stat(dir, part.branch);
    t.mergeFrom = await ports.git.head(dir); ctx.change();
    const mg = await planLock(ctx, plan.id, t.repo, () => ports.git.mergeBranch(part.dir, t.branch!, `[${plan.id}] ${t.label}: ${t.title}`));
    ev("merge", mg.ok ? `Merged ${t.label} into the plan branch` : `Merge into the plan branch failed`, { ok: mg.ok, conflict: mg.conflict, into: part.branch, from: t.branch });
    if (!mg.ok) { t.mergeFrom = undefined; throw new Fail(`Merge into the plan branch failed: ${mg.conflict ?? "conflict"}`); }
    check();
    finish(cfg.buildEachTask ? "Done · build and tests pass · in the plan branch, not on staging yet" : "Done · reviewed · in the plan branch; the repo builds once at the last gate");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (e instanceof Stopped || stopped()) {
      if (plan.stopRequested && (["working", "review"] as string[]).includes(t.status)) { t.status = "waiting"; t.sub = "Stopped. It carries on after Retry."; }
      t.stopRequested = false;
      ev("task_stopped", `${t.label} stopped`, { reason: plan.stopRequested ? "plan stopped" : "edit" });
    } else if (e instanceof Deliberate) {
      t.status = "failed"; t.error = msg; t.sub = `Failed: ${msg.slice(0, 300)}`;
      ev("task_failed", `${t.label} failed: ${msg}`, { error: msg });
    } else throw e; // transient: the engine retries it on its own
    ctx.change();
  }
}
