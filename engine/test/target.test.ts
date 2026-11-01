import { describe, expect, test } from "bun:test";
import { createEngine } from "../core/engine.ts";
import { lockLine, waitsOnFor } from "../core/locks.ts";
import { makeFakes, planned, tk, until } from "./fakes.ts";

function setup() {
  const { ports, f } = makeFakes();
  const engine = createEngine(ports, {});
  f.engine = engine;
  const plan = (id = "P-01") => engine.state().plans[id]!;
  const planned_ = async (text = "do the work") => { const id = engine.submit(text); await until(() => plan(id).steps.plan === "you" || !!plan(id).error, "planned"); return id; };
  const settled = (id = "P-01") => until(() => !!plan(id).landedAt || plan(id).steps.master === "you" || !!plan(id).error, `${id} finished`);
  return { f, engine, plan, planned_, settled };
}

describe("target branch", () => {
  test("no target: same branch names, PR targets and steps as before", async () => {
    const { f, engine, plan, planned_, settled } = setup();
    f.plan = planned([tk("T1")]);
    const id = await planned_();
    expect(plan().targetBranch).toBeUndefined();
    expect(plan().repos[0]).toMatchObject({ base: "uat", branch: "prflow/p-01-my-plan" });
    engine.start(id);
    await settled();
    expect(f.calls).toContain("worktree /stage/P-01/api prflow/p-01-my-plan origin/uat");
    expect(f.prs.map((p) => p.dest)).toEqual(["uat", "master"]);
    expect(f.calls.some((c) => c.startsWith("deploy-wait api uat"))).toBe(true);
    expect(f.testInputs.length).toBe(1);
    expect(plan().steps).toMatchObject({ staging: "done", uat: "done", master: "you" });
    expect(f.calls.some((c) => c.startsWith("ensure-branch"))).toBe(false);
    expect(engine.events(id).find((e) => e.event === "gate_start")?.text).toBe("Wave 1 gate started: full build and all tests of 1 repo, with every task's change together");
    expect(plan().gating).toBeUndefined(); // shown only while the gate runs
  });

  test("the planner reads a target from the text: cut from it, PR into it, no staging deploy, UAT or master", async () => {
    const { f, engine, plan, planned_, settled } = setup();
    f.plan = planned([tk("T1")], { target_branch: "feat/eshopbox" });
    const id = await planned_("Eshopbox part 1. Do not merge to staging; build on feat/eshopbox.");
    expect(plan().targetBranch).toBe("feat/eshopbox");
    expect(plan().repos[0]!.base).toBe("feat/eshopbox");
    engine.start(id);
    await settled();
    expect(plan().error).toBeUndefined();
    expect(f.calls).toContain("ensure-branch api feat/eshopbox from uat");
    expect(f.calls).toContain("worktree /stage/P-01/api prflow/p-01-my-plan origin/feat/eshopbox");
    expect(f.prs.map((p) => [p.src, p.dest])).toEqual([["prflow/p-01-my-plan", "feat/eshopbox"]]);
    expect(f.prs[0]!.body).toContain("Targets feat/eshopbox, not staging");
    expect(f.calls.some((c) => c.startsWith("deploy-wait"))).toBe(false);
    expect(f.testInputs.length).toBe(0);
    expect(plan().masterPrs.length).toBe(0);
    expect(plan().steps).toMatchObject({ staging: "done", master: "" });
    expect(plan().now).toBe("Merged into feat/eshopbox · build and tests pass");
    expect(plan().landedAt).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(f.prs.length).toBe(1); // nothing more runs after the merge
    await expect(engine.mergeMaster(id)).rejects.toThrow("no master PRs");
  });

  test("a target missing on one repo is made from staging on that repo only", async () => {
    const { f, engine, plan, planned_, settled } = setup();
    f.remote.set("web/feat/x", ["base-web-uat", "w1"]);
    f.plan = planned([tk("T1"), tk("T2", { repo: "web" })]);
    const id = engine.submit("two repos", { targetBranch: "feat/x" });
    await until(() => plan(id).steps.plan === "you", "planned");
    engine.start(id);
    await settled();
    expect(plan().error).toBeUndefined();
    expect(f.calls.filter((c) => c.startsWith("ensure-branch"))).toEqual(["ensure-branch api feat/x from uat"]);
    expect(engine.events(id).filter((e) => e.event === "target_created").map((e) => e.repo)).toEqual(["api"]);
    expect(f.calls).toContain("worktree /stage/P-01/web prflow/p-01-my-plan origin/feat/x");
    expect(f.remote.get("web/feat/x")).toContain("w1");
    expect(f.prs.every((p) => p.dest === "feat/x")).toBe(true);
  });

  test("two plans with the same target run in order; the second rebases onto the first", async () => {
    const { f, engine, plan, settled } = setup();
    f.plan = planned([tk("T1", { files: ["src/Shared.ts"] })]);
    const a = engine.submit("part 1", { targetBranch: "feat/x" }), b = engine.submit("part 2", { targetBranch: "feat/x" });
    await until(() => plan(a).steps.plan === "you" && plan(b).steps.plan === "you", "both planned");
    engine.start(b); engine.start(a);
    expect(waitsOnFor(engine.state(), `${b}/T1`)).toEqual([`${a}/T1`]);
    expect(lockLine(engine.state(), `${b}/T1`)).toBe("Waits for P-01 to reach feat/x (Shared.ts)");
    await settled(a); await settled(b);
    expect(plan(a).error ?? plan(b).error).toBeUndefined();
    const i = (s: string) => f.calls.findIndex((c) => c.startsWith(s));
    expect(i("merge-pr feat/x #101")).toBeGreaterThan(-1);
    expect(i("worktree /stage/P-02/api")).toBeGreaterThan(i("merge-pr feat/x #101"));
    expect(f.remote.get("api/feat/x")).toContain("m101");
    expect(f.prs[1]).toMatchObject({ src: "prflow/p-02-my-plan", dest: "feat/x" });
    expect(engine.events(b).some((e) => e.event === "rebase" && e.onto === "origin/feat/x")).toBe(true);
  });

  test("a plan going to staging never waits for a target plan on the same file", async () => {
    const { f, engine, plan, settled } = setup();
    f.plan = planned([tk("T1", { files: ["src/Shared.ts"] })]);
    const a = engine.submit("feature part", { targetBranch: "feat/x" }), b = engine.submit("staging fix");
    await until(() => plan(a).steps.plan === "you" && plan(b).steps.plan === "you", "both planned");
    engine.start(a); engine.start(b);
    expect(waitsOnFor(engine.state(), `${b}/T1`)).toEqual([]);
    await settled(a); await settled(b);
    expect(plan(b).steps.master).toBe("you");
  });

  test("you can set or clear the target before Start, never after; staging and master are refused", async () => {
    const { f, engine, plan, planned_ } = setup();
    f.plan = planned([tk("T1")]);
    const id = await planned_();
    await expect(engine.setTarget(id, "uat")).rejects.toThrow("staging branch");
    await expect(engine.setTarget(id, "master")).rejects.toThrow("cannot be a target");
    await engine.setTarget(id, "feat/y");
    expect(plan().repos[0]!.base).toBe("feat/y");
    await engine.setTarget(id, "");
    expect(plan().repos[0]!.base).toBe("uat");
    await engine.setTarget(id, "feat/y");
    engine.start(id);
    await expect(engine.setTarget(id, "")).rejects.toThrow("has started");
  });

  test("promotion: waits for Start, then PRs the target into staging and runs the normal UAT flow", async () => {
    const { f, engine, plan, settled } = setup();
    f.plan = planned([tk("T1")], { db_changes: [{ database: "BSC", sql: "ALTER TABLE x ADD COLUMN y int", why: "needed" }] });
    const a = engine.submit("part 1", { targetBranch: "feat/x" });
    await until(() => plan(a).steps.plan === "you", "planned");
    await expect(engine.promote({ branch: "feat/x" })).rejects.toThrow("No plan has merged");
    engine.start(a);
    await settled(a);
    const pid = await engine.promote({ branch: "feat/x" });
    expect(plan(pid)).toMatchObject({ kind: "promote", promotes: "feat/x", needsStart: true, started: false, title: "Promote feat/x to staging" });
    expect(plan(pid).dbChanges?.length).toBe(1);
    await expect(engine.promote({ branch: "feat/x" })).rejects.toThrow("already takes");
    engine.tick();
    await new Promise((r) => setTimeout(r, 20));
    expect(f.calls.some((c) => c.includes("/stage/P-02/"))).toBe(false); // nothing runs before Start
    engine.start(pid);
    await settled(pid);
    expect(plan(pid).error).toBeUndefined();
    expect(f.calls).toContain("worktree /stage/P-02/api prflow/p-02-promote-feat-x origin/feat/x");
    expect(f.calls).toContain("merge /stage/P-02/api <- origin/uat"); // a promotion merges the base in, never rebases
    expect(f.calls.some((c) => c.startsWith("rebase /stage/P-02/"))).toBe(false);
    const pr = f.prs.find((p) => p.src === "prflow/p-02-promote-feat-x")!;
    expect(pr.dest).toBe("uat");
    expect(f.calls.some((c) => c.startsWith("deploy-wait api uat"))).toBe(true);
    expect(f.testInputs.length).toBe(1);
    expect(plan(pid).steps).toMatchObject({ staging: "done", uat: "done", master: "you" });
    expect(plan(pid).masterPrs.length).toBe(1);
    expect(f.remote.get("api/feat/x")).toBeDefined(); // the target branch itself is never rewritten
  });

  test("a service builds against the plan's own library change: the library worktree is installed first, once per head", async () => {
    const { ports, f } = makeFakes({ repos: ["api", "lib"] });
    const engine = createEngine(ports, {}); f.engine = engine; f.libNames = ["lib"];
    const plan = (id = "P-01") => engine.state().plans[id]!;
    f.plan = planned([tk("T1", { repo: "lib" }), tk("T2", { repo: "api", wave: 2, deps: ["T1"] }), tk("T3", { repo: "api", wave: 2, files: ["src/T3b.ts"] })], { repo_order: [{ repo: "lib", why: "first" }, { repo: "api", why: "uses lib" }] });
    const id = engine.submit("two repos", { targetBranch: "feat/x" });
    await until(() => plan(id).steps.plan === "you", "planned");
    engine.start(id);
    await until(() => !!plan(id).landedAt || !!plan(id).error, "landed");
    expect(plan(id).error).toBeUndefined();
    const installs = f.calls.filter((c) => c === "install /stage/P-01/lib");
    expect(installs.length).toBeGreaterThan(0);
    const firstApiBuild = f.calls.findIndex((c) => c.startsWith("build /stage/P-01/T2") || c.startsWith("build /stage/P-01/T3"));
    expect(f.calls.indexOf("install /stage/P-01/lib")).toBeLessThan(firstApiBuild);
    expect(f.calls.some((c) => c.startsWith("install /stage/P-01/api"))).toBe(false); // only libraries are installed
    expect(engine.events(id).filter((e) => e.event === "plan_lib_installed").length).toBe(installs.length); // once per new library head
  });

  test("send-back: a done task goes back to its writer with your finding, then merges into the target again", async () => {
    const { f, engine, plan, planned_, settled } = setup();
    f.plan = planned([tk("T1")]);
    const id = engine.submit("part 1", { targetBranch: "feat/x" });
    await until(() => plan(id).steps.plan === "you", "planned");
    engine.start(id);
    await settled();
    expect(() => engine.sendBackTask(id, "T9", "x")).toThrow("There is no task T9");
    engine.sendBackTask(id, "T1", "A failed event is retried every 10 s with no backoff");
    expect(plan(id).landedAt).toBeUndefined();
    await until(() => !!plan(id).landedAt || !!plan(id).error, "landed again");
    const ex = f.runsOf("executor");
    expect(ex.length).toBe(2);
    expect(ex[1]!.resumeId).toBe(ex[0]!.sessionId); // the same writer session carries on
    expect(ex[1]!.prompt).toContain("A failed event is retried every 10 s with no backoff");
    expect(engine.state().tasks[`${id}/T1`]!.rounds.some((r) => r.source === "edit")).toBe(true);
  });

  test("a real-problem minor finding comes back to the next round's reviewer, to report as blocking if still there", async () => {
    const { f, engine, plan, planned_ } = setup();
    f.plan = planned([tk("T1", { review: true })]);
    f.queue("code-reviewer", { findings: [{ severity: "blocking", category: "crash", text: "NPE on empty list" }, { severity: "minor", category: "correctness", short: "A return records the wrong drop store", text: "long text" }, { severity: "minor", category: "style", text: "rename x" }] }, { findings: [] });
    const id = await planned_();
    engine.start(id);
    await until(() => f.runsOf("code-reviewer").length >= 2 || !!plan(id).error, "second review");
    const second = f.runsOf("code-reviewer")[1]!.prompt;
    expect(second).toContain("Minor findings from the last round");
    expect(second).toContain("- A return records the wrong drop store");
    expect(second).not.toContain("rename x"); // style points never come back
  });
});

describe("database changes run by a person", () => {
  test("a refused staging DB change stops the plan until db-done; then Retry goes on to staging", async () => {
    const { ports, f } = makeFakes();
    let runs = 0;
    ports.stagingDb = async () => { runs++; return { ok: false, detail: "\"INSERT ...\" was not run: one statement only" }; };
    const engine = createEngine(ports, {}); f.engine = engine;
    const plan = (id = "P-01") => engine.state().plans[id]!;
    f.plan = planned([tk("T1")], { db_changes: [{ database: "BSC", sql: "INSERT INTO x VALUES (1); INSERT INTO x VALUES (2)", why: "seed" }] });
    const id = engine.submit("do the work");
    await until(() => plan(id).steps.plan === "you", "planned");
    expect(() => engine.dbDone("P-01")).not.toThrow();
    delete plan(id).dbDoneAt;
    engine.start(id);
    await until(() => !!plan(id).error, "stopped at the DB step");
    expect(plan(id).error).toContain("needs a person");
    engine.dbDone(id);
    engine.retry(id);
    await until(() => plan(id).steps.master === "you" || (!!plan(id).error && !plan(id).error!.includes("needs a person")), "went on");
    expect(runs).toBe(1);
    expect(plan(id).steps.staging).toBe("done");
  });
});
