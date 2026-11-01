// Fake Ports for tests: in-memory git, scripted Claude answers by role, instant sleep. No network, no Claude.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine } from "../core/engine.ts";
import type { ClaudeResult, ClaudeRun, Ports, TestInput, TestResult } from "../ports.ts";
import type { PlannedTask, PlannerResult, Role } from "../types.ts";

// A worktree: its branch's commits live in f.branches; edits not yet committed live in `pending`.
export interface WT { repo: string; branch: string; pending: Set<string> }
export interface FakeRun { run: number; uuid: string; url: string; prs: { repo: string; id: number }[]; i: number; lines: string[]; rows: { repo: string; pr: number; merge: string; result: string }[]; done: boolean; result?: string; tag?: { repo: string; tag: string } }
export interface FakePr { id: number; repo: string; src: string; dest: string; title: string; body: string; merged: boolean; state: "open" | "merged" | "declined"; head?: string }
type Item = any | ((run: ClaudeRun, n: number) => any);

export const tk = (label: string, o: Partial<PlannedTask> = {}): PlannedTask => ({
  label, title: `Task ${label}`, repo: "api", wave: 1, deps: [], files: [`src/${label}.ts`], size: "S", part: `part of ${label}`,
  what: [`do ${label}`], checks: [`test ${label}`], security: false, ...o,
});
export const planned = (tasks: PlannedTask[], o: Partial<PlannerResult> = {}): PlannerResult => ({
  title: "My plan", architecture: { changes: true, why: "test" }, kind: tasks.length > 1 ? "big" : "small", size_why: "because", acceptance: ["it works"], tasks,
  repo_order: [...new Set(tasks.filter((t) => t.action !== "remove").map((t) => t.repo))].map((repo) => ({ repo, why: `${repo} goes first` })), ...o,
});
export const blocking = (text: string, category = "correctness", file?: string) => ({ severity: "blocking", category, text, file });
export const minor = (text: string, category = "style") => ({ severity: "minor", category, text });
export const review = (...findings: any[]) => ({ findings, needs_security_review: false });

export function makeFakes(opts: { repos?: string[] } = {}) {
  let seq = 0;
  const f = {
    calls: [] as string[], runs: [] as ClaudeRun[], dirs: new Map<string, WT>(), words: new Map<string, string[]>(), // words: names a plan worktree holds (git.hasWords)
    branches: new Map<string, string[]>(), // "repo/branch" -> commits, oldest first
    remote: new Map<string, string[]>(), // "repo/branch" on origin -> commits; uat and master start with one base commit
    commitFiles: new Map<string, string[]>(),
    engine: null as Engine | null,
    script: {} as Partial<Record<Role, Item[]>>,
    plan: null as PlannerResult | ((run: ClaudeRun, n: number) => PlannerResult) | null,
    buildQ: [] as { ok: boolean; tail?: string }[],
    testQ: [] as TestResult[], testInputs: [] as TestInput[],
    conflicts: { merge: new Set<string>(), rebase: new Set<string>(), cherry: false },
    cherryEmpty: null as null | ((n: number) => boolean), cherryCalls: 0,
    failMerge: 0, crashAfterMerge: false, // failMerge: how many merge calls fail
    guard: null as null | ((files: string[], diff: string) => string | null),
    deployCheck: null as string | null | { manual: string }, deployOk: true, deployBuildsOnly: false, sleeps: [] as number[],
    longHeads: false, // git gives 40-char heads, Bitbucket 12-char ones
    prs: [] as FakePr[],
    mergeCommits: new Set<string>(), // hashes verifyCommits treats as merge commits
    remoteHeadCalls: 0,
    poms: {} as Record<string, Record<string, string>>, // repo -> pom path -> text on the PR branch
    written: new Map<string, Record<string, string>>(), // dir -> pom edits made in that worktree
    libNames: [] as string[], released: (() => false) as (lib: string, version: string) => boolean, releasedCalls: [] as string[],
    overlaps: [] as string[], // two git jobs on one worktree at the same time
    // Release steps: files at any ref ("repo:path"), preflight results by SQL text, SQL failures, the config file and the release.
    files: {} as Record<string, string>,
    preflight: {} as Record<string, { rows: Record<string, unknown>[] }[]>,
    sqlFail: {} as Record<string, string>,
    configText: "lambda:\n  functions:\n    A: A-Prod", configCommit: null as null | ((text: string) => { files: string[]; text: string }), configPushed: [] as string[],
    // The release runner: each status poll moves one step; fail fires once (at merge, pipeline or tag), then clears.
    runner: {
      fail: null as null | { repo: string; at?: "merge" | "pipeline" | "tag"; step?: string; reason?: string },
      noPipeline: new Set<string>(), tagWait: null as null | { repo: string; tag: string }, handoffAfter: 0, startFails: null as string | null,
      runs: [] as FakeRun[],
    },
    // The executor's writes: uncommitted until commitAll.
    touch(dir: string, files: string[]) { const w = wt(dir); for (const x of files) w.pending.add(x); },
    untouch(dir: string, files: string[]) { const w = wt(dir); for (const x of files) w.pending.delete(x); },
    pushExtra(branch: string, repo = "api") { f.remote.get(`${repo}/${branch}`)!.push(`x${++seq}`); }, // somebody pushes to a PR's branch
    count: (role: Role) => f.runs.filter((r) => r.role === role).length,
    runsOf: (role: Role) => f.runs.filter((r) => r.role === role),
    queue(role: Role, ...items: Item[]) { (f.script[role] ??= []).push(...items); },
  };
  const hex40 = (h: string) => Buffer.from(h).toString("hex").padEnd(40, "0").slice(0, 40);
  const st = () => f.engine!.state();
  const wt = (dir: string) => { const w = f.dirs.get(dir); if (!w) throw new Error(`fake git: no worktree ${dir}`); return w; };
  const bk = (repo: string, branch: string) => `${repo}/${branch}`;
  const origin = (repo: string, branch: string) => { const k = bk(repo, branch); if (!f.remote.has(k) && (branch === "uat" || branch === "master")) f.remote.set(k, [`base-${repo}-${branch}`]); return f.remote.get(k); };
  const list = (dir: string) => f.branches.get(bk(wt(dir).repo, wt(dir).branch))!;
  const refList = (repo: string, ref: string) => (ref.startsWith("origin/") ? origin(repo, ref.slice(7)) : f.branches.get(bk(repo, ref))) ?? [];
  const own = (dir: string, base: string) => {
    const l = list(dir), at = l.indexOf(base); if (at >= 0) return l.slice(at + 1); // a commit id, as git diff <sha> uses
    const b = new Set(refList(wt(dir).repo, base)); return l.filter((c) => !b.has(c)); };
  const changed = (dir: string, base: string) => {
    const out = new Set<string>();
    for (const c of own(dir, base)) for (const x of f.commitFiles.get(c) ?? []) out.add(x);
    for (const x of wt(dir).pending) out.add(x);
    return [...out];
  };
  const busyDirs = new Map<string, string>();
  async function exclusive<T>(dir: string, op: string, job: () => Promise<T> | T): Promise<T> {
    if (busyDirs.has(dir)) f.overlaps.push(`${op} on ${dir} while ${busyDirs.get(dir)}`);
    busyDirs.set(dir, op);
    try { await new Promise((r) => setTimeout(r, 1)); return await job(); } finally { busyDirs.delete(dir); }
  }

  async function claude(run: ClaudeRun): Promise<ClaudeResult> {
    f.runs.push(run); f.calls.push(`claude ${run.role} ${run.task ?? run.plan}`);
    const n = f.count(run.role);
    const item = f.script[run.role]?.shift();
    let out: any;
    if (item !== undefined) out = typeof item === "function" ? await item(run, n) : item;
    else if (run.role === "planner") { const p = f.plan; if (!p) throw new Error("fake: no plan scripted"); out = typeof p === "function" ? p(run, n) : p; }
    else if (run.role === "executor") {
      const t = st().tasks[run.task!]!;
      f.touch(run.edits![0]!, t.files);
      out = { summary: "wrote it", did: `Did ${t.label}.`, needs_files: [], tests_added: ["a test"] };
    } else if (run.role === "debugger") { f.touch(run.edits![0]!, run.task ? st().tasks[run.task]!.files.slice(0, 1) : ["debugger-fix.txt"]); out = { summary: "fixed the build" }; }
    else out = { findings: [], needs_security_review: false };
    const sessionId = run.sessionId ?? run.resumeId ?? `s${++seq}`;
    if (out && out.__error) return { ok: false, structured: null, text: "", error: out.__error, sessionId };
    return { ok: true, structured: out, text: "", sessionId };
  }

  const chains = new Map<string, Promise<unknown>>();
  const git: Ports["git"] = {
    stagingBranch: async () => "uat", masterBranch: async () => "master",
    async worktree(repo, dir, branch, from) {
      f.calls.push(`worktree ${dir} ${branch} ${from}`);
      if (from !== branch || !f.branches.has(bk(repo, branch))) f.branches.set(bk(repo, branch), [...refList(repo, from)]); // -B: the branch restarts at `from`
      f.dirs.set(dir, { repo, branch, pending: new Set() }); f.written.delete(dir);
    },
    async drop(_r, dir) { f.calls.push(`drop ${dir}`); f.dirs.delete(dir); },
    async fetch(dir) { f.calls.push(`fetch ${dir}`); },
    async head(dir) { const h = list(dir).at(-1)!; return f.longHeads ? hex40(h) : h; },
    async hasWords(dir, words) { return words.filter((w) => (f.words.get(dir) ?? []).includes(w)); },
    async commitAll(dir) {
      const w = wt(dir);
      if (!w.pending.size) return null;
      const sha = `c${++seq}`; f.commitFiles.set(sha, [...w.pending]); list(dir).push(sha); w.pending.clear();
      f.calls.push(`commit ${dir} ${sha}`); return sha;
    },
    async changedFiles(dir, base) { return changed(dir, base); },
    async diff(dir, base) { return `diff of ${changed(dir, base).join(",")}`; },
    async stat(dir, base) { return `${changed(dir, base).length} files changed`; },
    async mergeBranch(dir, branch) {
      f.calls.push(`merge ${dir} <- ${branch}`);
      return exclusive(dir, "merge", () => {
        if (f.conflicts.merge.has(branch)) return { ok: false, conflict: `CONFLICT merging ${branch}` };
        const target = list(dir);
        for (const c of refList(wt(dir).repo, branch)) if (!target.includes(c)) target.push(c);
        if (f.crashAfterMerge) { f.crashAfterMerge = false; throw new Error("the process died after the merge"); }
        return { ok: true };
      });
    },
    async rebase(dir, onto) {
      f.calls.push(`rebase ${dir} ${onto}`);
      return exclusive(dir, "rebase", () => {
        const w = wt(dir);
        if (w.pending.size) return { ok: false, conflict: "cannot rebase: You have unstaged changes." };
        if (f.conflicts.rebase.has(dir) && list(dir).length > 0 && own(dir, onto).length > 0) return { ok: false, conflict: `CONFLICT rebasing ${dir}` };
        const mine = own(dir, onto);
        f.branches.set(bk(w.repo, w.branch), [...refList(w.repo, onto), ...mine]);
        return { ok: true };
      });
    },
    async contains(repo, ancestor, branch) { const a = origin(repo, ancestor) ?? [], b = origin(repo, branch) ?? []; return a.every((c) => b.includes(c)); },
    async remoteHead(repo, branch) { f.remoteHeadCalls++; const h = origin(repo, branch)?.at(-1); if (!h) throw new Error(`fake: no origin/${branch}`); return f.longHeads ? hex40(h) : h; },
    async verifyCommits(repo, branch, commits) {
      const on = origin(repo, branch) ?? [];
      for (const c of commits) { if (f.mergeCommits.has(c)) return `commit ${c} is a merge commit; send non-merge commits only`; if (!on.includes(c)) return `commit ${c} is not on origin/${branch}`; }
      return null;
    },
    async push(dir, branch) { f.calls.push(`push ${dir} ${branch}`); await exclusive(dir, "push", () => { f.remote.set(bk(wt(dir).repo, branch), [...list(dir)]); }); },
    async commitsSince(dir, base) { return own(dir, base); },
    async ensureBranch(repo, branch, from) { if (f.remote.has(bk(repo, branch))) return false; f.calls.push(`ensure-branch ${repo} ${branch} from ${from}`); f.remote.set(bk(repo, branch), [...(origin(repo, from) ?? [])]); return true; },
    async poms(dir) { const w = wt(dir); return Object.entries({ ...(f.poms[w.repo] ?? {}), ...(f.written.get(dir) ?? {}) }).map(([path, text]) => ({ path, text })); },
    async writeFile(dir, path, text) { wt(dir); f.written.set(dir, { ...(f.written.get(dir) ?? {}), [path]: text }); f.touch(dir, [path]); f.calls.push(`write ${dir} ${path}`); },
    async readAt(repo, ref, path) { f.calls.push(`read ${repo} ${ref} ${path}`); const t = f.files[`${repo}:${path}`]; if (t === undefined) throw new Error("fake: no such file"); return t; },
    async cherryPick(dir, commits) {
      f.calls.push(`cherry-pick ${dir} ${commits.join(",")}`);
      const n = ++f.cherryCalls;
      if (f.conflicts.cherry) return { ok: false, conflict: "CONFLICT in master" };
      if (f.cherryEmpty?.(n)) return { ok: false, empty: true, conflict: "The previous cherry-pick is now empty" };
      for (const c of commits) { const sha = `p${++seq}`; f.commitFiles.set(sha, f.commitFiles.get(c) ?? []); list(dir).push(sha); }
      return { ok: true, head: "m-head" };
    },
  };

  // release.py's log: stamped lines, a multi-line message stamped once, STOP unstamped, the summary table at the end.
  const stamp = (r: FakeRun, text: string) => r.lines.push(`[23/10 09:15:02 PM IST] ${text}`);
  const table = (r: FakeRun) => { stamp(r, "\nrepo                         PR     merge        pipeline       min"); for (const x of r.rows) stamp(r, `${x.repo.padEnd(28)} ${String(x.pr).padEnd(6)} ${x.merge.slice(0, 10).padEnd(12)} ${x.result.padEnd(14)} 1.0`); };
  const end = (r: FakeRun, result: string, stop?: string) => { table(r); if (stop) r.lines.push(`STOP: ${stop}`); r.done = true; r.result = result; };
  const newRun = (prs: { repo: string; id: number }[]): { run: number; url: string; uuid: string } => {
    const run = 41 + f.runner.runs.length, r: FakeRun = { run, uuid: `{run-${run}}`, url: `https://bitbucket.org/bsctech/enigma-release/pipelines/results/${run}`, prs, i: -1, lines: [], rows: [], done: false };
    f.runner.runs.push(r);
    return { run: r.run, url: r.url, uuid: r.uuid };
  };
  const runOf = (uuid: string) => { const r = f.runner.runs.find((x) => x.uuid === uuid); if (!r) throw new Error(`fake: no release run ${uuid}`); return r; };
  async function stepRun(r: FakeRun): Promise<void> {
    const fail = f.runner.fail;
    const failAt = (repo: string, at: string) => { if (fail?.repo !== repo || (fail.at ?? "pipeline") !== at) return false; f.runner.fail = null; return true; };
    if (r.i < 0) { r.i = 0; stamp(r, `Target: master. Order: ${r.prs.map((x) => `${x.repo}#${x.id}`).join(" -> ")}`); return; }
    if (r.tag) { // the poll after "waiting for tag"
      const { repo, tag } = r.tag; r.tag = undefined;
      if (failAt(repo, "tag")) return end(r, "FAILED", `release ${repo} ${tag.slice(repo.length + 1)} first (Create Release Version)`);
      stamp(r, `  tag ${tag} found`);
    }
    if (r.i >= r.prs.length) return end(r, "SUCCESSFUL");
    if (f.runner.handoffAfter && r.rows.length >= f.runner.handoffAfter) {
      const rest = r.prs.slice(r.i), next = newRun(rest);
      f.calls.push(`release-handoff ${rest.map((x) => `${x.repo}#${x.id}`).join(",")}`);
      stamp(r, `Time limit near. Started a new run for the rest: ${rest.map((x) => `${x.repo}#${x.id}`).join(",")}\n  ${next.url}`);
      f.runner.handoffAfter = 0;
      return end(r, "SUCCESSFUL");
    }
    const pr = r.prs[r.i++]!;
    stamp(r, `Merging ${pr.repo}#${pr.id} into master`);
    if (failAt(pr.repo, "merge")) return end(r, "FAILED", `POST /2.0/repositories/bsctech/${pr.repo}/pullrequests/${pr.id}/merge failed (409): conflict`);
    const merge = await ports.prs.merge(pr.repo, pr.id), row = { repo: pr.repo, pr: pr.id, merge, result: "SUCCESSFUL" };
    r.rows.push(row);
    if (f.runner.noPipeline.has(pr.repo)) { stamp(r, `WARNING: no pipeline for ${pr.repo} on master after 10 minutes. Continuing`); row.result = "NO PIPELINE"; }
    else stamp(r, `  pipeline https://bitbucket.org/bsctech/${pr.repo}/pipelines/results/7`);
    if (failAt(pr.repo, "pipeline")) {
      row.result = "FAILED";
      stamp(r, `${pr.repo}: pipeline ended FAILED: step '${fail!.step ?? "Deploy to prod"}' failed (full log: release-logs/${pr.repo}-7.log). Last lines:\n+ mvn -q deploy\n[INFO] Building ${pr.repo}\n${fail!.reason ?? "[ERROR] Failed to execute goal: tests failed"}`);
      return end(r, "FAILED", `${pr.repo} pipeline ended FAILED. See https://bitbucket.org/bsctech/${pr.repo}/pipelines/results/7`);
    }
    if (f.runner.tagWait?.repo === pr.repo) { r.tag = f.runner.tagWait; stamp(r, `  waiting for tag ${r.tag.tag}`); }
  }

  const ports: Ports = {
    claude, repos: () => (opts.repos ?? ["api", "web"]).map((name) => ({ name })), git,
    async build(dir, opts) { f.calls.push(`build ${dir}${opts?.quick ? " quick" : ""}`); const r = f.buildQ.shift() ?? { ok: true }; return exclusive(dir, "build", () => ({ ok: r.ok, ran: true, tail: r.tail ?? (r.ok ? "all good" : "FAIL: compile error") })); },
    prs: {
      async create(repo, src, dest, title, body) {
        if (!f.remote.has(bk(repo, src))) throw new Error(`fake: branch ${src} was never pushed`);
        const id = 100 + f.prs.length + 1; f.prs.push({ id, repo, src, dest, title, body, merged: false, state: "open" }); return { id, url: `https://pr.test/${id}` };
      },
      // A merge closes the source branch, as Bitbucket does.
      async merge(repo, id) {
        const p = f.prs.find((x) => x.id === id)!;
        if (f.failMerge > 0) { f.failMerge--; throw new Error("the merge call failed"); }
        const src = f.remote.get(bk(repo, p.src));
        if (!src) throw new Error(`fake: source branch ${p.src} is gone`);
        p.head = src.at(-1);
        const dest = origin(repo, p.dest) ?? [];
        for (const c of src) if (!dest.includes(c)) dest.push(c);
        dest.push(`m${id}`); f.remote.set(bk(repo, p.dest), dest); f.remote.delete(bk(repo, p.src));
        p.merged = true; p.state = "merged"; f.calls.push(`merge-pr ${p.dest} #${id}`);
        return `m${id}`;
      },
      async state(_repo, id) { return f.prs.find((x) => x.id === id)!.state; },
      async head(repo, id) { const p = f.prs.find((x) => x.id === id)!; const h = p.merged ? p.head : f.remote.get(bk(repo, p.src))?.at(-1); if (!h) throw new Error("fake: PR has no head"); return f.longHeads ? hex40(h).slice(0, 12) : h; },
      async decline(_repo, id) { const p = f.prs.find((x) => x.id === id)!; if (p.merged) throw new Error("fake: PR is already merged"); p.state = "declined"; f.calls.push(`decline-pr #${id}`); },
    },
    deploy: {
      async check() { return f.deployCheck; },
      async wait(repo, branch, commit) { f.calls.push(`deploy-wait ${repo} ${branch} ${commit}`); return f.deployBuildsOnly ? { ok: true, manual: true, detail: "pipeline only builds" } : { ok: f.deployOk, detail: f.deployOk ? "deployed" : "pipeline failed" }; },
    },
    async test(input) {
      f.testInputs.push(input);
      return f.testQ.shift() ?? { exercised: true, passed: true, proof: "all scenarios passed", checks: [{ what: "main path", ok: true }] };
    },
    async repoLock(repo, job) {
      const prev = chains.get(repo) ?? Promise.resolve();
      const next = prev.then(() => { f.calls.push(`lock ${repo}`); return job(); });
      chains.set(repo, next.catch(() => {}));
      return next;
    },
    libs: { names: () => f.libNames, async released(lib, version) { f.releasedCalls.push(`${lib} ${version}`); return f.released(lib, version); }, async install(dir) { f.calls.push(`install ${dir}`); return { ok: true, detail: "installed" }; } },
    diffGuard: (files, diff) => f.guard?.(files, diff) ?? null,
    prodSql: {
      problem: (_kind, db, sql) => (db === "nope" ? "unknown database" : /drop/i.test(sql) ? "it drops something" : null),
      async check(db, sql) { f.calls.push(`sql-check ${db} ${sql}`); return { ok: true, results: f.preflight[sql] ?? [{ sql, rows: [] }] }; },
      async run(db, sql) { f.calls.push(`sql-run ${db} ${sql}`); const e = f.sqlFail[sql]; return e ? { ok: false, statements: [], error: e } : { ok: true, statements: [{ sql, rows: 0 }] }; },
    },
    configEdit: {
      async read() { return f.configText; },
      async commit(_repo, _branch, file, text) { f.calls.push(`config-commit ${file}`); const c = f.configCommit?.(text) ?? { files: [file], text }; return { commit: `cfg${++seq}`, ...c }; },
      async push(repo, branch, commit) { f.calls.push(`config-push ${repo} ${branch} ${commit}`); f.configPushed.push(commit); },
    },
    release: {
      async start(target, prs) {
        f.calls.push(`release-start ${target} ${prs.map((x) => `${x.repo}#${x.id}`).join(",")}`);
        if (f.runner.startFails) throw new Error(f.runner.startFails);
        return newRun(prs);
      },
      async status(uuid) { const r = runOf(uuid); if (!r.done) await stepRun(r); return { done: r.done, result: r.result }; },
      async log(uuid) { return runOf(uuid).lines.join("\n"); },
      async after(run) { const r = f.runner.runs.find((x) => x.run > run); return r ? { run: r.run, url: r.url, uuid: r.uuid } : null; },
    },
    stageRoot: "/stage", dataDir: mkdtempSync(join(tmpdir(), "prflow-")),
    async sleep(ms) { f.sleeps.push(ms); },
  };
  return { ports, f };
}

export async function until(cond: () => boolean, what = "condition", ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1));
  }
}
