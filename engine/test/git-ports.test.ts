import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEngine } from "../core/engine.ts";
import { diffGuard, gitPorts, run, type Runner } from "../git-ports.ts";
import type { ProjectConfig } from "../project.ts";
import { terminalRoute } from "../terminal.ts";
import { planned, tk, until } from "./fakes.ts";

const root = mkdtempSync(join(tmpdir(), "ship-gp-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const sh = async (cwd: string, ...args: string[]) => { const r = await run(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], cwd); if (!r.ok) throw new Error(`${args.join(" ")}: ${r.err}`); return r.out; };

// A bare "origin" with one commit on main, a clone of it, and a gh stub that merges PRs on the origin.
async function world(name: string, over: Partial<ProjectConfig["repos"][0]> = {}, mergeToStaging: "auto" | "you" = "auto") {
  const dir = join(root, name), origin = join(dir, "origin.git"), repo = join(dir, "app"), scratch = join(dir, "scratch");
  mkdirSync(dir, { recursive: true });
  await sh(dir, "init", "-q", "--bare", "-b", "main", origin);
  await sh(dir, "clone", "-q", origin, repo);
  writeFileSync(join(repo, "README.md"), "hello\n");
  await sh(repo, "add", "-A"); await sh(repo, "commit", "-q", "-m", "init"); await sh(repo, "push", "-q", "origin", "main");
  await sh(dir, "clone", "-q", origin, scratch);
  const prs = new Map<number, { src: string; dest: string; state: string; merge?: string; closed?: boolean }>();
  const calls: string[] = [];
  const gh: Runner = async (cmd) => {
    const a = cmd.slice(1); calls.push(a.slice(0, 2).join(" "));
    const ok = (out: string) => ({ ok: true, out, err: "" });
    if (a[0] !== "pr") return { ok: false, out: "", err: "unknown" };
    if (a[1] === "create") { const id = prs.size + 1; prs.set(id, { src: a[a.indexOf("--head") + 1]!, dest: a[a.indexOf("--base") + 1]!, state: "OPEN" }); return ok(`https://example.test/o/r/pull/${id}`); }
    const pr = prs.get(Number(a[2]))!;
    if (a[1] === "merge") {
      await sh(scratch, "fetch", "-q", "origin"); await sh(scratch, "checkout", "-q", "-B", pr.dest, `origin/${pr.dest}`);
      await sh(scratch, "merge", "-q", "--no-ff", "-m", `Merge PR`, `origin/${pr.src}`); await sh(scratch, "push", "-q", "origin", pr.dest);
      pr.state = "MERGED"; pr.merge = await sh(scratch, "rev-parse", "HEAD"); return ok("");
    }
    if (a[1] === "close") { pr.state = "CLOSED"; return ok(""); }
    if (a[1] === "view") return ok(JSON.stringify({ state: pr.state, mergeCommit: pr.merge ? { oid: pr.merge } : null, headRefOid: "abc" }));
    return { ok: false, out: "", err: "unknown pr call" };
  };
  const project: ProjectConfig = { name: name, port: 0, dataDir: join(dir, "data"), mergeToStaging, repos: [{ name: "app", path: repo, workBranch: "main", stagingBranch: null, prodBranch: null, build: "echo built", test: "test -f README.md", ...over }] };
  return { dir, origin, repo, project, prs, calls, gh, ports: gitPorts(project, { gh, sleep: async () => {} }) };
}

describe("git ports", () => {
  test("worktree, commit, merge into the plan branch, build", async () => {
    const w = await world("basic");
    const { git } = w.ports, plan = join(w.dir, "stage/P-01/app"), task = join(w.dir, "stage/P-01/T1");
    await git.worktree("app", plan, "plan/p-01", "origin/main");
    await git.worktree("app", task, "task/p-01-t1", "plan/p-01");
    expect(await git.stagingBranch("app")).toBe("main");
    writeFileSync(join(task, "a.txt"), "one\n");
    expect(await git.changedFiles(task, "origin/main")).toEqual(["a.txt"]);
    expect(await git.commitAll(task, "add a")).toMatch(/^[0-9a-f]{40}$/);
    expect(await git.commitAll(task, "nothing")).toBeNull();
    expect(await git.commitsSince(task, "origin/main")).toHaveLength(1);
    expect((await git.mergeBranch(plan, "task/p-01-t1", "merge T1")).ok).toBe(true);
    expect(readFileSync(join(plan, "a.txt"), "utf8")).toBe("one\n");
    expect(await w.ports.build(plan)).toMatchObject({ ok: true, ran: true });
    await git.push(plan, "plan/p-01");
    expect(await git.remoteHead("app", "plan/p-01")).toBe(await git.head(plan));
    await git.drop("app", task);
    expect(existsSync(task)).toBe(false);
  });

  test("a conflicting merge is reported and aborted; a failing build says so; no command means no build", async () => {
    const w = await world("conflict", { build: "echo boom; exit 3", test: undefined });
    const { git } = w.ports, a = join(w.dir, "wa"), b = join(w.dir, "wb");
    await git.worktree("app", a, "ba", "origin/main"); await git.worktree("app", b, "bb", "origin/main");
    writeFileSync(join(a, "README.md"), "A\n"); await git.commitAll(a, "a");
    writeFileSync(join(b, "README.md"), "B\n"); await git.commitAll(b, "b");
    const m = await git.mergeBranch(a, "bb", "merge");
    expect(m.ok).toBe(false); expect(m.conflict).toContain("README.md");
    expect((await sh(a, "status", "--porcelain"))).toBe(""); // aborted: clean again
    const bad = await w.ports.build(a);
    expect(bad.ok).toBe(false); expect(bad.tail).toContain("boom");
    const none = await gitPorts({ ...w.project, repos: [{ ...w.project.repos[0]!, build: undefined }] }).build(a);
    expect(none).toEqual({ ok: true, ran: false, tail: "no build command" });
  });

  test("ensureBranch makes a missing branch from origin/<from> and pushes it", async () => {
    const w = await world("ensure");
    expect(await w.ports.git.ensureBranch!("app", "feat/x", "main")).toBe(true);
    expect(await sh(w.origin, "rev-parse", "feat/x")).toBe(await sh(w.origin, "rev-parse", "main"));
    expect(await w.ports.git.ensureBranch!("app", "feat/x", "main")).toBe(false);
  });

  test("PRs go through gh: create, state, head, close; merge auto merges, merge you waits for the host", async () => {
    const w = await world("prs");
    const { prs } = w.ports;
    const r = await prs.create("app", "x", "main", "t", "b");
    expect(r).toEqual({ id: 1, url: "https://example.test/o/r/pull/1" });
    expect(await prs.state("app", 1)).toBe("open");
    expect(await prs.head("app", 1)).toBe("abc");
    await prs.decline("app", 1);
    expect(await prs.state("app", 1)).toBe("declined");

    const y = await world("prs-you", {}, "you");
    await y.ports.prs.create("app", "x", "main", "t", "b");
    let polls = 0;
    const slow = gitPorts(y.project, { gh: async (c) => { if (c[2] === "view" && ++polls === 3) Object.assign(y.prs.get(1)!, { state: "MERGED", merge: "deadbeef" }); return y.gh(c, ""); }, sleep: async () => {} });
    expect(await slow.prs.merge("app", 1)).toBe("deadbeef");
    y.prs.set(2, { src: "q", dest: "main", state: "CLOSED" });
    await expect(slow.prs.merge("app", 2)).rejects.toThrow("the PR was closed");
  });

  test("the deploy step is manual; test and claude are never called; the diff guard refuses only secrets and lockfile-only changes", async () => {
    const w = await world("misc");
    expect(await w.ports.deploy.check("app", "main")).toEqual({ manual: "no deploy step" });
    expect(await w.ports.deploy.wait("app", "main", "c", () => {}, () => false)).toEqual({ ok: true, manual: true, detail: "no deploy step" });
    await expect(w.ports.test({} as any)).rejects.toThrow();
    await expect(w.ports.claude({} as any)).rejects.toThrow();
    expect(diffGuard(["src/a.ts"], "+x")).toBeNull();
    expect(diffGuard([".env"], "")).toContain(".env");
    expect(diffGuard([".env.example"], "")).toBeNull();
    expect(diffGuard(["k.pem"], "")).toContain("private key");
    expect(diffGuard(["a.ts"], "+-----BEGIN RSA PRIVATE KEY-----")).toContain("private key");
    expect(diffGuard(["package-lock.json", "yarn.lock"], "")).toContain("lockfiles");
    expect(diffGuard(["package-lock.json", "src/a.ts"], "")).toBeNull();
  });
});

const ready = (t: { status: string; terminal?: { readyAt?: number; done?: unknown } }) => t.status === "working" && !!t.terminal?.readyAt && !t.terminal.done;
const post = (e: ReturnType<typeof createEngine>, noProd: boolean, path: string, body: unknown) =>
  terminalRoute(e, new Request(`http://x/api/prflow/terminal/${path}`, { method: "POST", body: JSON.stringify(body) }), new URL(`http://x/api/prflow/terminal/${path}`), { noProd: () => noProd });

describe("whole plans on the built-in backend", () => {
  test("a target plan: the branch is made, the task merges into it, the plan lands; no staging test, no prod PR", async () => {
    const w = await world("target");
    const engine = createEngine(w.ports, { terminalOnly: true, buildEachTask: false, settleMs: 0, cleanFinished: true });
    const res = await post(engine, true, "adopt", { plan: planned([tk("T1", { repo: "app" })], { target_branch: "feat/x" }), session: "s1" });
    const { id } = await res!.json() as any;
    const plan = () => engine.state().plans[id]!, task = () => engine.state().tasks[`${id}/T1`]!;
    expect(plan().targetBranch).toBe("feat/x");
    await until(() => ready(task()), "T1 ready", 15000);
    writeFileSync(join(task().dir!, "src-T1.txt"), "t1\n");
    engine.taskDone(id, "T1", "Did T1.");
    await until(() => !!plan().landedAt || !!plan().error || !!plan().terminal?.sweep, "landed", 30000);
    if (plan().terminal?.sweep) { engine.sweepAnswer(id, []); await until(() => !!plan().landedAt || !!plan().error, "landed after sweep", 30000); }
    expect(plan().error).toBeUndefined();
    expect(plan().landedAt).toBeGreaterThan(0);
    expect(plan().terminal?.uat).toBeUndefined();
    expect(plan().masterPrs).toHaveLength(0);
    expect(await sh(w.origin, "show", "feat/x:src-T1.txt")).toBe("t1");
    expect(await sh(w.origin, "rev-parse", "main")).not.toBe(await sh(w.origin, "rev-parse", "feat/x")); // main untouched
    expect(engine.events(id).some((e) => e.event === "target_created")).toBe(true);
    await until(() => !!plan().cleanedAt && !existsSync(join(w.project.dataDir, "stage", id)), "worktrees dropped", 10000).catch(() => {});
    expect((await sh(w.repo, "branch", "--list")).split("\n").length).toBeGreaterThan(1); // branches stay
  }, 60000);

  test("a staging-only project: adopt sets stagingOnly, staging merges by gh, the terminal answers the test, the plan ends", async () => {
    const w = await world("staging");
    const engine = createEngine(w.ports, { terminalOnly: true, buildEachTask: false, settleMs: 0, cleanFinished: true });
    const id = (await (await post(engine, true, "adopt", { plan: planned([tk("T1", { repo: "app" })]), session: "s2" }))!.json() as any).id as string;
    const plan = () => engine.state().plans[id]!, task = () => engine.state().tasks[`${id}/T1`]!;
    expect(plan().stagingOnly).toBe(true);
    await until(() => ready(task()), "T1 ready", 15000);
    writeFileSync(join(task().dir!, "f.txt"), "f\n");
    engine.taskDone(id, "T1", "Did T1.");
    await until(() => !!plan().terminal?.sweep || !!plan().terminal?.uat || !!plan().error, "staging test asked", 30000);
    if (plan().terminal?.sweep) { engine.sweepAnswer(id, []); await until(() => !!plan().terminal?.uat || !!plan().error, "staging test asked", 30000); }
    expect(plan().error).toBeUndefined();
    expect(w.calls).toContain("pr create"); expect(w.calls).toContain("pr merge");
    expect(await sh(w.origin, "show", "main:f.txt")).toBe("f");
    engine.uatAnswer(id, { exercised: true, passed: true, proof: "checked by hand", checks: [{ what: "w", ok: true, task: "T1" }] });
    await until(() => plan().steps.uat === "done", "uat done", 10000);
    expect(plan().masterPrs).toHaveLength(0);
    await until(() => !!plan().cleanedAt, "clean-up", 10000);
  }, 60000);

  test("uat-run, uat-recheck and query answer 400 with a plain sentence; uat-guide gives the generic guidance", async () => {
    const w = await world("noqa");
    const engine = createEngine(w.ports, { terminalOnly: true, buildEachTask: false });
    const call = (m: string, p: string, body?: unknown) => terminalRoute(engine, new Request(`http://x/api/prflow/terminal/${p}`, { method: m, body: body ? JSON.stringify(body) : undefined }), new URL(`http://x/api/prflow/terminal/${p}`), {});
    const q = await call("POST", "query", { database: "d", sql: "select 1" });
    expect(q!.status).toBe(400); expect(((await q!.json()) as any).error).toContain("no test runner");
    const g = await call("GET", "uat-guide");
    expect(((await g!.json()) as any).prompt).toContain("This backend has no test runner");
  });
});
