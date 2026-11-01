import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createEngine } from "../core/engine.ts";
import { sameHead } from "../core/pipeline.ts";
import type { Config } from "../config.ts";
import { blocking, makeFakes, minor, planned, review, tk, until } from "./fakes.ts";

function setup(cfg: Partial<Config> = {}) {
  const { ports, f } = makeFakes();
  const engine = createEngine(ports, cfg);
  f.engine = engine;
  const plan = (id = "P-01") => engine.state().plans[id]!;
  const task = (l: string, id = "P-01") => engine.state().tasks[`${id}/${l}`]!;
  const names = (id = "P-01") => engine.events(id).map((e) => e.event);
  const submitAndPlan = async (text = "do the work", id = "P-01") => { const pid = engine.submit(text); await until(() => plan(pid).steps.plan === "you", "planned"); return pid; };
  const toMaster = (id = "P-01") => until(() => plan(id).steps.master === "you" || !!plan(id).error, "master PRs");
  return { ports, f, engine, plan, task, names, submitAndPlan, toMaster };
}
const deferred = () => { let go!: () => void; const p = new Promise<void>((r) => { go = r; }); return { p, go }; };
const okExec = (t: { label: string }, extra: object = {}) => ({ summary: "ok", did: `Did ${t.label}.`, needs_files: [], tests_added: ["t"], ...extra });

describe("small plan end to end", () => {
  test("draft, start, build fail, debugger, blocking review, fix, clean, gate, staging, test, master PRs, merge master", async () => {
    const { f, engine, plan, task, names, submitAndPlan, toMaster, ports } = setup({ reviewerResume: false });
    f.plan = planned([tk("T1")]);
    const id = await submitAndPlan("Fix the dispute total");
    expect(plan().needsStart).toBe(true);
    expect(task("T1").status).toBe("draft");
    expect(task("T1").sub).toBe("Planned · not started");
    expect(plan().now).toBe("Planned: 1 task in 1 wave. Nothing runs until you press Start.");
    expect(f.count("executor")).toBe(0);

    f.buildQ.push({ ok: false, tail: "error: cannot find symbol" });
    f.queue("code-reviewer", review(blocking("The total is wrong when the list is empty"), minor("Rename x")), review(minor("Add a doc comment", "docs")));
    engine.start(id);
    expect(["waiting", "working"]).toContain(task("T1").status);
    await toMaster();

    const t = task("T1");
    expect(plan().error).toBeUndefined();
    expect(t.status).toBe("done");
    expect(f.count("debugger")).toBe(1);
    expect(f.runsOf("debugger")[0]!.prompt).toContain("cannot find symbol");
    expect(t.rounds.length).toBe(2);
    expect(t.rounds[0]!.blocking.length).toBe(1);
    expect(t.rounds[0]!.blocking[0]!.by).toBe("code-reviewer");
    expect(t.rounds[1]!.blocking.length).toBe(0);
    expect(t.rounds[1]!.minor.length).toBe(1);
    expect(f.count("executor")).toBe(2);
    expect(f.runsOf("executor")[1]!.resumeId).toBe(f.runsOf("executor")[0]!.sessionId);
    expect(f.runsOf("executor")[1]!.prompt).toContain("The total is wrong");
    expect(f.runsOf("executor")[0]!.edits).toEqual(["/stage/P-01/T1"]);
    expect(t.did).toBe("Did T1.");
    expect(t.sub).toBe("Done · build and tests pass · in the plan branch, not on staging yet");
    expect(plan().gates[1]).toBe(true);
    expect(plan().stagingPrs.length).toBe(1);
    expect(f.prs[0]!.title).toBe("[P-01] My plan");
    expect(f.prs[0]!.body).toContain("T1 Task T1: Did T1.");
    expect(f.prs[0]!.body).toContain("Add a doc comment");
    expect(f.sleeps).toContain(60_000);
    expect(plan().steps).toMatchObject({ plan: "done", tasks: "done", staging: "done", uat: "done", master: "you" });
    expect(plan().uat!.passed).toBe(true);
    expect(plan().masterPrs.length).toBe(1);
    expect(f.prs[1]!.dest).toBe("master");
    expect(f.prs[1]!.src).toBe("prflow/p-01-my-plan-master");
    expect(f.prs[1]!.body).toContain("Merge order: 1 of 1.");
    expect(f.prs[1]!.body).toContain("api goes first");
    expect(f.calls.some((c) => c.startsWith("cherry-pick /stage/P-01/api-master"))).toBe(true);
    expect(f.calls.filter((c) => c === "merge-pr master #102").length).toBe(0);

    await engine.mergeMaster(id);
    await until(() => plan().steps.master === "done", "live");
    expect(plan().masterPrs[0]!.state).toBe("merged");
    expect(plan().liveAt).toBeGreaterThan(0);
    expect(plan().now).toBe("1/1 merged by you · live on prod");
    expect(f.calls).toContain("merge-pr master #102");
    expect(f.calls).toContain("release-start master api#102"); // enigma-release merges it and waits for the deploy
    expect(f.calls.some((c) => c.startsWith("deploy-wait api master"))).toBe(false);
    expect(plan().release).toMatchObject({ state: "done", run: 41, result: "SUCCESSFUL" });
    // live on prod: the plan, master and task worktrees are dropped, and only after the master merge
    const mergedAt = f.calls.indexOf("merge-pr master #102");
    for (const dir of ["/stage/P-01/api", "/stage/P-01/api-master", "/stage/P-01/T1"]) expect(f.calls.lastIndexOf(`drop ${dir}`)).toBeGreaterThan(mergedAt);
    // master is merged only by mergeMaster
    expect(f.calls.indexOf("merge-pr master #102")).toBeGreaterThan(f.calls.indexOf("merge-pr uat #101"));

    // Logging: events and the markdown story.
    const ev = names();
    for (const n of ["plan_submitted", "claude_run_start", "planner_result", "plan_validated", "plan_applied", "started", "worktree", "executor_start", "executor_end", "files_changed", "diff_guard", "commit", "build", "debugger_start", "debugger_end", "review_start", "review_round", "merge", "task_done", "gate", "staging_start", "deploy_check", "rebase", "staging_commits", "push", "pr_created", "pr_merged", "deploy_wait", "staging_done", "uat_start", "uat_result", "cherry_pick", "master_ready", "merge_master_clicked", "release_run_start", "master_merged", "master_deploy", "release_run_done", "live"]) expect(ev).toContain(n);
    const evs = engine.events(id);
    expect(evs.find((e) => e.event === "plan_submitted")!.hash).toHaveLength(64);
    expect(evs.find((e) => e.event === "executor_end")!.sessionId).toBeTruthy();
    expect((evs.find((e) => e.event === "build" && e.ok === false)!.tail as string)).toContain("cannot find symbol");
    expect(evs.filter((e) => e.event === "review_round").map((e) => (e.blocking as unknown[]).length)).toEqual([1, 0]);
    expect(evs.find((e) => e.event === "worktree")!.task).toBe("P-01/T1");
    expect(evs.every((e) => e.plan === "P-01" && typeof e.at === "number")).toBe(true);
    expect(existsSync(join(ports.dataDir, "README.md"))).toBe(true);
    expect(existsSync(join(ports.dataDir, "state.json"))).toBe(true);
    const md = readFileSync(join(ports.dataDir, "plans", "P-01.md"), "utf8");
    for (const s of ["# P-01 · My plan", "Fix the dispute total", "## Tasks", "T1 [done]", "## Timeline (IST)", " IST · T1 · Review round 1 (code-reviewer): 1 blocking, 1 minor", "Review round 2 (code-reviewer): 0 blocking, 1 minor", "Build failed", "debugger finished: fixed the build", "Wave 1 gate passed", "staging PR #101 opened", "master PR #102 opened", "master PR #102 merged", "Live on prod", "#101 merged", "#102 merged"]) expect(md).toContain(s);
    expect(md).toMatch(/\d{1,2}:\d{2} (AM|PM) IST/);
    expect(engine.log(id)).toBe(md);
  });
});

describe("big plan", () => {
  test("waves, gates, parallel cap, architect reviews", async () => {
    const { f, plan, task, engine, submitAndPlan, toMaster } = setup({ maxTasks: 2 });
    f.plan = planned([tk("T1"), tk("T2"), tk("T3"), tk("T4", { wave: 2, deps: ["T1", "T2", "T3"] })], { contract: "Use Dispute.total" });
    const id = await submitAndPlan();
    expect(plan().kind).toBe("big");
    expect(plan().waves).toBe(2);
    expect(plan().now).toContain("4 tasks in 2 waves");
    expect(f.count("architect-reviewer")).toBe(1);
    let peak = 0;
    const exec = async (run: any) => {
      const busy = Object.values(engine.state().tasks).filter((t) => t.status === "working" || t.status === "review").length;
      peak = Math.max(peak, busy);
      await new Promise((r) => setTimeout(r, 8));
      f.touch(run.edits[0], task(run.task.split("/")[1]).files);
      return okExec({ label: run.task });
    };
    f.queue("executor", exec, exec, exec, exec);
    engine.start(id);
    await until(() => task("T1").status !== "waiting" && task("T2").status !== "waiting", "wave 1 start");
    expect(task("T3").status).toBe("waiting");
    expect(task("T4").status).toBe("waiting");
    await toMaster();
    expect(peak).toBeLessThanOrEqual(2);
    expect(plan().gates).toEqual({ 1: true, 2: true });
    expect(f.count("architect-reviewer")).toBe(2);
    const evs = engine.events(id);
    const gate1 = evs.findIndex((e) => e.event === "gate" && e.wave === 1);
    const t4 = evs.findIndex((e) => e.event === "executor_start" && e.task === "P-01/T4");
    expect(gate1).toBeGreaterThan(-1);
    expect(t4).toBeGreaterThan(gate1);
    expect(f.runsOf("executor")[0]!.prompt).toContain("Use Dispute.total");
  });

  test("buildEachTask off: tasks are only reviewed, wave 1 passes without a build, the last gate builds the repo once", async () => {
    const { f, plan, task, engine, submitAndPlan, toMaster } = setup({ buildEachTask: false });
    f.plan = planned([tk("T1"), tk("T2", { wave: 2, deps: ["T1"] })]);
    const id = await submitAndPlan();
    const exec = async (run: any) => { f.touch(run.edits[0], task(run.task.split("/")[1]).files); return okExec({ label: run.task }); };
    f.queue("executor", exec, exec);
    engine.start(id);
    await toMaster();
    expect(plan().gates).toEqual({ 1: true, 2: true });
    const evs = engine.events(id);
    expect(evs.filter((e) => e.event === "build" && e.task).length).toBe(0); // no task build
    expect(evs.find((e) => e.event === "gate" && e.wave === 1)?.skipped).toBe(true);
    expect(evs.filter((e) => e.event === "build" && String(e.text).startsWith("Wave 2 gate")).length).toBe(1);
  });

  test("two repos stage in repo_order, each with its own PR", async () => {
    const { f, plan, engine, submitAndPlan, toMaster } = setup();
    f.plan = planned([tk("T1", { repo: "web" }), tk("T2", { repo: "api" })], { repo_order: [{ repo: "api", why: "api first" }, { repo: "web", why: "web needs the api" }] });
    const id = await submitAndPlan();
    engine.start(id);
    await toMaster();
    expect(plan().stagingPrs.map((p) => p.repo)).toEqual(["api", "web"]);
    expect(plan().masterPrs.map((p) => [p.repo, p.order, p.why])).toEqual([["api", 1, "api first"], ["web", 2, "web needs the api"]]);
    await engine.mergeMaster(id);
    await until(() => plan().steps.master === "done", "live");
    expect(f.prs.filter((p) => p.dest === "master" && p.merged).map((p) => p.repo)).toEqual(["api", "web"]);
  });
});

describe("bug list", () => {
  test("triage, left-out rows, fix anyway", async () => {
    const { f, plan, task, engine, submitAndPlan } = setup();
    f.plan = planned([tk("T1", { bugs: [1, 2] })], {
      kind: "list",
      triage: [{ n: 1, text: "Total wrong", task: "T1" }, { n: 2, text: "Total wrong on refund", task: "T1" }, { n: 3, text: "Button is grey", verdict: "not_a_bug", why: "The grey is the design" }, { n: 4, text: "Typo", verdict: "already_fixed", why: "Fixed in commit abc" }],
    });
    const id = await submitAndPlan("1. Total wrong\n2. refund\n3. grey\n4. typo");
    expect(plan().triage!.map((r) => [r.n, r.task, r.leftOut?.verdict])).toEqual([[1, "T1", undefined], [2, "T1", undefined], [3, undefined, "not_a_bug"], [4, undefined, "already_fixed"]]);
    expect(plan().triage![2]!.leftOut!.why).toBe("The grey is the design");
    expect(Object.keys(engine.state().tasks)).toEqual(["P-01/T1"]);
    expect(() => engine.fixAnyway(id, 1)).toThrow();
    f.plan = planned([tk("T1", { bugs: [1, 2] }), tk("T2", { bugs: [3] })], {
      kind: "list",
      triage: [{ n: 1, text: "Total wrong", task: "T1" }, { n: 2, text: "Total wrong on refund", task: "T1" }, { n: 3, text: "Button is grey", task: "T2" }, { n: 4, text: "Typo", verdict: "already_fixed", why: "Fixed in commit abc" }],
    });
    engine.fixAnyway(id, 3);
    await until(() => plan().versions.length === 2 && plan().steps.plan === "you", "re-planned");
    expect(plan().versions[1]!.text).toContain("Also fix bug 3: Button is grey");
    expect(task("T2").isNew).toBe(true);
    expect(task("T1").isNew).toBeFalsy();
    expect(plan().triage!.find((r) => r.n === 3)!.task).toBe("T2");
    expect(plan().changes!.join(" ")).toContain("T2");
  });
});

describe("edit before Start", () => {
  test("new, changed and removed labels", async () => {
    const { f, plan, task, engine, submitAndPlan, names } = setup();
    f.plan = planned([tk("T1"), tk("T2"), tk("T3", { wave: 2, deps: ["T1"] })]);
    const id = await submitAndPlan("v1");
    expect(task("T1").isNew).toBeFalsy();
    f.plan = planned([tk("T1"), tk("T2", { files: ["src/T2.ts", "src/more.ts"] }), tk("T4", { wave: 2, deps: ["T1"] })]);
    engine.edit(id, "v2 text");
    expect(() => engine.edit(id, "again")).toThrow();
    await until(() => plan().versions.length === 2 && plan().steps.plan === "you", "re-planned");
    expect(plan().versions.map((v) => v.text)).toEqual(["v1", "v2 text"]);
    expect(task("T1").isNew || task("T1").changed).toBeFalsy();
    expect(task("T2").changed).toBe(true);
    expect(task("T3").status).toBe("removed");
    expect(task("T4").isNew).toBe(true);
    expect(task("T4").status).toBe("draft");
    expect(plan().needsStart).toBe(true);
    expect(plan().changes).toEqual(["New: T4 Task T4.", "Changed: T2 Task T2.", "Removed: T3 Task T3."]);
    expect(plan().versions[1]!.changes).toEqual(plan().changes!);
    expect(names()).toContain("plan_edited");
  });
});

describe("edit after Start", () => {
  test("update note reaches a running task; a reopened and an added task start by themselves", async () => {
    const { f, plan, task, engine, submitAndPlan, toMaster } = setup({ reviewerResume: false });
    f.plan = planned([tk("T1"), tk("T2"), tk("T3", { wave: 2, deps: ["T1", "T2"] })]);
    const id = await submitAndPlan();
    const hold = deferred();
    f.queue("executor", async (run: any) => { await hold.p; f.touch(run.edits[0], task("T1").files); return okExec({ label: "T1" }); });
    const onlyT1 = (run: any): any => { if (run.task === "P-01/T1") return review(blocking("Missing null check", "crash")); f.script["code-reviewer"]!.unshift(onlyT1); return review(); };
    f.queue("code-reviewer", onlyT1);
    engine.start(id);
    await until(() => task("T2").status === "done" && task("T1").status === "working", "T2 done, T1 writing");
    f.plan = planned([
      tk("T1", { action: "update", note: "Also handle refunds" }), tk("T2", { action: "reopen", note: "Round the total to 2 places" }),
      tk("T3", { wave: 2, deps: ["T1", "T2"], action: "keep" }), tk("T4", { wave: 2, action: "add" }),
    ]);
    engine.edit(id, "v2");
    await until(() => plan().steps.plan === "done" && plan().versions.length === 2, "re-planned");
    expect(task("T1").notes).toEqual(["Also handle refunds"]);
    expect(task("T1").status).toBe("working");
    expect(task("T2").status).not.toBe("draft"); // only the first Start is yours
    expect(task("T2").notes).toEqual(["Round the total to 2 places"]);
    expect(task("T4").status).not.toBe("draft");
    expect(plan().needsStart).toBe(false);
    expect(plan().gates[1]).toBeFalsy();
    expect(engine.events("P-01").some((e) => e.event === "started" && e.auto)).toBe(true);
    hold.go();
    await until(() => task("T1").status === "done", "T1 done");
    expect(f.runsOf("executor").filter((r) => r.task === "P-01/T1")[1]!.prompt).toContain("Also handle refunds");
    expect(() => engine.start(id)).toThrow("nothing to start");
    await toMaster();
    expect(task("T2").status).toBe("done");
    const t2Runs = f.runsOf("executor").filter((r) => r.task === "P-01/T2");
    expect(t2Runs.length).toBe(2);
    expect(t2Runs[1]!.resumeId).toBe(t2Runs[0]!.sessionId);
    expect(t2Runs[1]!.prompt).toContain("Round the total to 2 places");
    expect(f.calls.filter((c) => c.startsWith("worktree /stage/P-01/T2 ")).length).toBe(1);
    expect(task("T4").status).toBe("done");
    expect(plan().needsStart).toBe(false);
  });

  test("redo stops and resets, remove, keep", async () => {
    const { f, plan, task, engine, submitAndPlan, toMaster } = setup();
    f.plan = planned([tk("T1"), tk("T3", { wave: 2, deps: ["T1"] }), tk("T4", { wave: 2, deps: ["T1"] })]);
    const id = await submitAndPlan();
    const hold = deferred();
    f.queue("executor", async (run: any) => { await hold.p; f.touch(run.edits[0], ["src/T1.ts"]); return okExec({ label: "T1" }); });
    engine.start(id);
    await until(() => task("T1").status === "working" && f.count("executor") === 1, "T1 writing");
    f.plan = planned([tk("T1", { action: "redo", files: ["src/T1.ts", "src/T1b.ts"] }), tk("T3", { wave: 2, deps: ["T1"], action: "remove" }), tk("T4", { wave: 2, deps: ["T1"], action: "keep" })]);
    engine.edit(id, "v2");
    await until(() => plan().steps.plan === "done" && plan().versions.length === 2, "re-planned");
    expect(task("T1").status).toBe("waiting"); // queued again by itself; it starts once the old run has ended
    expect(task("T1").stopRequested).toBe(true);
    expect(task("T1").rounds).toEqual([]);
    expect(task("T1").files).toEqual(["src/T1.ts", "src/T1b.ts"]);
    expect(f.calls).toContain("drop /stage/P-01/T1");
    expect(task("T3").status).toBe("removed");
    expect(task("T4").status).toBe("waiting");
    expect(f.count("executor")).toBe(1); // never two runs of one task at once
    hold.go();
    await toMaster();
    expect(task("T1").status).toBe("done");
    expect(f.count("executor")).toBe(3);
    expect(f.runsOf("executor")[1]!.resumeId).toBeUndefined();
    expect(f.runsOf("executor")[1]!.task).toBe("P-01/T1");
    expect(task("T3").status).toBe("removed");
  });
});

describe("file ownership", () => {
  test("a file outside the list that no other task holds becomes the task's, with no round", async () => {
    const { f, plan, task, engine, submitAndPlan, toMaster } = setup();
    f.plan = planned([tk("T1")]);
    const id = await submitAndPlan();
    f.queue("executor", async (run: any) => { f.touch(run.edits[0], ["src/T1.ts", "src/other.ts"]); return okExec({ label: "T1" }); });
    engine.start(id);
    await toMaster();
    expect(task("T1").status).toBe("done");
    expect(task("T1").files).toContain("src/other.ts");
    expect(task("T1").rounds.some((r) => r.by.includes("executor"))).toBe(false);
    expect(engine.events(id).some((e) => e.event === "files_claimed")).toBe(true);
    expect(f.count("executor")).toBe(1);
    expect(plan().error).toBeUndefined();
  });

  test("a file outside the list that another task holds is undone through a blocking finding", async () => {
    const { f, plan, task, engine, submitAndPlan, toMaster } = setup();
    f.plan = planned([tk("T1"), tk("T2", { wave: 2, files: ["src/T2.ts", "src/other.ts"] })]);
    const id = await submitAndPlan();
    f.queue("executor",
      async (run: any) => { f.touch(run.edits[0], ["src/T1.ts", "src/other.ts"]); return okExec({ label: "T1" }); },
      async (run: any) => { f.untouch(run.edits[0], ["src/other.ts"]); return okExec({ label: "T1" }); });
    engine.start(id);
    await toMaster();
    expect(task("T1").status).toBe("done");
    const r = task("T1").rounds[0]!;
    expect(r.blocking[0]).toMatchObject({ category: "bad_code", by: "executor" });
    expect(r.blocking[0]!.text).toContain("Changed files outside its list that it cannot take: src/other.ts");
    expect(r.blocking[0]!.text).toContain("T2");
    expect(f.runsOf("executor")[1]!.prompt).toContain("src/other.ts");
    expect(f.runsOf("executor")[1]!.resumeId).toBeTruthy();
    expect(plan().error).toBeUndefined();
  });

  test("needs_files is granted when free", async () => {
    const { f, task, engine, submitAndPlan, toMaster } = setup();
    f.plan = planned([tk("T1")]);
    const id = await submitAndPlan();
    f.queue("executor", async () => okExec({ label: "T1" }, { needs_files: ["src/extra.ts"] }),
      async (run: any) => { f.touch(run.edits[0], ["src/T1.ts", "src/extra.ts"]); return okExec({ label: "T1" }); });
    engine.start(id);
    await toMaster();
    expect(task("T1").files).toEqual(["src/T1.ts", "src/extra.ts"]);
    expect(task("T1").status).toBe("done");
    expect(engine.events(id).find((e) => e.event === "needs_files")!.granted).toBe(true);
  });

  test("a request for a change in another repo fails at once with a clear reason", async () => {
    const { f, task, engine, submitAndPlan } = setup();
    f.plan = planned([tk("T1")]);
    const id = await submitAndPlan();
    f.queue("executor", async () => okExec({ label: "T1" }, { needs_files: ["inventory_module worktree (T1): db/manual/x.sql"] }));
    engine.start(id);
    await until(() => task("T1").status === "failed", "T1 failed");
    expect(task("T1").error).toContain("needs a change outside");
    expect(f.runsOf("executor").filter((r) => r.task === "P-01/T1").length).toBe(1);
  });

  test("an edit after Stop re-plans instead of waiting forever", async () => {
    const { f, plan, engine, submitAndPlan } = setup();
    f.plan = planned([tk("T1")]);
    const id = await submitAndPlan();
    engine.stop(id);
    engine.edit(id, "changed text");
    await until(() => plan().steps.plan === "you", "re-planned");
    expect(plan().stopRequested).toBeFalsy();
    expect(f.count("planner")).toBe(2);
  });

  test("Stop during planning ends the planner run, and the text can be replaced at once", async () => {
    const { f, plan, engine } = setup();
    f.plan = planned([tk("T1")]);
    let killed = false;
    f.queue("planner", (run: any) => new Promise((done) => run.onStart?.(() => { killed = true; done({ __error: "killed" }); })));
    const id = engine.submit("first text");
    await until(() => f.count("planner") === 1, "planning");
    engine.stop(id);
    expect(killed).toBe(true);
    expect(() => engine.edit(id, "second text")).not.toThrow();
    await until(() => plan().steps.plan === "you", "re-planned");
    expect(plan().text).toBe("second text");
    expect(f.count("planner")).toBe(2);
  });

  test("any plan can be deleted: a running one stops first, then leaves the state", async () => {
    const { f, engine, task, submitAndPlan } = setup();
    f.plan = planned([tk("T1")]);
    const a = await submitAndPlan("first");
    engine.remove(a);
    expect(engine.state().plans[a]).toBeUndefined();
    const gate = deferred();
    f.queue("executor", async () => { await gate.p; return okExec({ label: "T1" }); });
    const b = await submitAndPlan("second", "P-02");
    engine.start(b);
    await until(() => task("T1", b).status === "working", "T1 working");
    engine.remove(b);
    expect(engine.state().plans[b]?.deleting).toBe(true);
    gate.go();
    await until(() => !engine.state().plans[b], "deleted");
    expect(engine.state().tasks[`${b}/T1`]).toBeUndefined();
    expect(engine.submit("third")).toBe("P-03");
  });

  test("needs_files is refused when another task owns the file", async () => {
    const { f, task, engine, submitAndPlan, plan } = setup();
    f.plan = planned([tk("T1"), tk("T2", { files: ["src/shared.ts"] })]);
    const id = await submitAndPlan();
    f.queue("executor", async () => okExec({ label: "T1" }, { needs_files: ["src/shared.ts"] }));
    engine.start(id);
    await until(() => task("T1").status === "failed", "T1 failed");
    expect(task("T1").error).toContain("shared.ts");
    expect(task("T1").error).toContain("belongs to task T2");
    expect(task("T1").files).toEqual(["src/T1.ts"]);
    expect(engine.events(id).find((e) => e.event === "needs_files")!.granted).toBe(false);
    expect(engine.events(id).some((e) => e.event === "task_failed")).toBe(true);
    expect(plan().steps.staging).toBe("");
  });

  test("a refused diff goes back to the executor twice, then fails the task", async () => {
    const { f, task, engine, submitAndPlan } = setup();
    f.plan = planned([tk("T1")]);
    f.guard = (_files: string[], diff: string) => (diff ? "It touches a secret file" : null); // refuses the content, not the file names
    const id = await submitAndPlan();
    engine.start(id);
    await until(() => task("T1").status === "failed", "failed");
    expect(task("T1").error).toBe("The change was refused: It touches a secret file");
    expect(engine.events(id).filter((e) => e.event === "diff_guard").length).toBe(3);
    expect(task("T1").rounds.filter((r) => r.blocking.some((x) => x.text.startsWith("The server refused the change"))).length).toBe(2);
  });

  test("a build file the guard refuses is undone by the executor and the task goes on", async () => {
    const { f, task, engine, submitAndPlan } = setup();
    f.plan = planned([tk("T1", { files: ["src/T1.ts", "pom.xml"] })]);
    let calls = 0;
    f.guard = (files: string[], diff: string) => (files.includes("pom.xml") && (diff === "" || ++calls <= 2) ? "touches pom.xml" : null); // a per-file check (no diff) always refuses it
    const id = await submitAndPlan();
    engine.start(id);
    await until(() => task("T1").status === "done" || task("T1").status === "failed", "settled");
    expect(task("T1").files).not.toContain("pom.xml");
    expect(task("T1").rounds.some((r) => r.blocking.some((x) => x.text.includes("Undo every change to pom.xml")))).toBe(true);
  });

  test("a build that never passes fails the task with the tail", async () => {
    const { f, task, engine, submitAndPlan } = setup({ maxBuildFixes: 2 });
    f.plan = planned([tk("T1")]);
    const id = await submitAndPlan();
    for (let i = 0; i < 5; i++) f.buildQ.push({ ok: false, tail: "boom at line 9" });
    engine.start(id);
    await until(() => task("T1").status === "failed", "failed");
    expect(f.count("debugger")).toBe(2);
    expect(task("T1").error).toContain("boom at line 9");
  });
});

describe("review loop", () => {
  test("minor findings never loop, even when marked blocking in a style category", async () => {
    const { f, task, engine, submitAndPlan, toMaster } = setup();
    f.plan = planned([tk("T1")]);
    const id = await submitAndPlan();
    f.queue("code-reviewer", review(minor("Rename it"), { severity: "blocking", category: "naming", text: "Bad name" }, minor("Add docs", "docs")));
    engine.start(id);
    await toMaster();
    expect(f.count("executor")).toBe(1);
    expect(f.count("code-reviewer")).toBe(2); // the task's review, then the last review of its minors
    expect(task("T1").rounds.length).toBe(1);
    expect(task("T1").rounds[0]!.minor.length).toBe(3);
    expect(task("T1").rounds[0]!.blocking.length).toBe(0);
  });

  test("the security reviewer joins for a security task", async () => {
    const { f, task, engine, submitAndPlan, toMaster } = setup();
    f.plan = planned([tk("T1", { security: true })]);
    const id = await submitAndPlan();
    f.queue("security-reviewer", review(blocking("SQL is built from input", "security", "src/T1.ts")), review());
    engine.start(id);
    await toMaster();
    expect(f.count("security-reviewer")).toBe(2);
    expect(task("T1").rounds[0]!.by).toEqual(["code-reviewer", "security-reviewer"]);
    expect(task("T1").rounds[0]!.blocking[0]!.by).toBe("security-reviewer");
  });

  test("a task the planner marks review false skips the reviewers", async () => {
    const { f, task, engine, submitAndPlan, toMaster } = setup();
    f.plan = planned([tk("T1", { review: false, review_why: "a column carried through" })]);
    const id = await submitAndPlan();
    engine.start(id);
    await toMaster();
    expect(f.count("code-reviewer")).toBe(0);
    expect(task("T1").rounds.length).toBe(0);
  });

  test("the diff turns a skipped review back on when a debugger changed the code", async () => {
    const { f, task, engine, submitAndPlan, toMaster } = setup();
    f.plan = planned([tk("T1", { review: false, review_why: "a column carried through" })]);
    f.buildQ.push({ ok: false, tail: "error: cannot find symbol" });
    const id = await submitAndPlan();
    engine.start(id);
    await toMaster();
    expect(f.count("code-reviewer")).toBe(1);
    expect(task("T1").reviewWhy).toContain("debugger");
  });

  test("a large plan with no design change gets no architect", async () => {
    const { f, engine, submitAndPlan, toMaster } = setup();
    f.plan = planned([tk("T1", { repo: "api", files: Array.from({ length: 16 }, (_, i) => `src/A${i}.ts`) }), tk("T2", { repo: "web" })], { architecture: { changes: false, why: "a field carried through" } }); // over the old 15-file trigger
    const id = await submitAndPlan();
    engine.start(id);
    await toMaster();
    expect(f.count("architect-reviewer")).toBe(0);
  });

  test("the same blocking set twice stops the task", async () => {
    const { f, task, engine, submitAndPlan } = setup();
    f.plan = planned([tk("T1")]);
    const id = await submitAndPlan();
    f.queue("code-reviewer", review(blocking("Wrong total for 12 lines")), review(blocking("wrong  total for 34 lines")));
    engine.start(id);
    await until(() => task("T1").status === "failed", "failed");
    expect(task("T1").error).toContain("came back twice");
    expect(f.count("executor")).toBe(2);
    expect(task("T1").rounds.length).toBe(2);
    expect(task("T1").sub).toStartWith("Failed:");
  });

  test("max rounds stops the task", async () => {
    const { f, task, engine, submitAndPlan } = setup({ maxReviewRounds: 2 });
    f.plan = planned([tk("T1")]);
    const id = await submitAndPlan();
    f.queue("code-reviewer", review(blocking("alpha problem")), review(blocking("beta problem")), review(blocking("gamma problem")));
    engine.start(id);
    await until(() => task("T1").status === "failed", "failed");
    expect(task("T1").error).toContain("Stopped after 2 review rounds");
    expect(task("T1").error).toContain("beta problem");
    expect(f.count("executor")).toBe(2);
  });
});

describe("staging test", () => {
  test("a failed check goes back to its task, then re-stages and re-tests", async () => {
    const { f, plan, task, engine, submitAndPlan, toMaster } = setup();
    f.plan = planned([tk("T1"), tk("T2")]);
    const id = await submitAndPlan();
    f.testQ.push({ exercised: true, passed: false, proof: "stock was 3, wanted 5", checks: [{ what: "Stock after a refund", ok: false, detail: "stock was 3", task: "T2" }, { what: "Total", ok: true }] });
    engine.start(id);
    await toMaster();
    expect(plan().error).toBeUndefined();
    expect(f.count("executor")).toBe(3);
    const t2 = f.runsOf("executor").filter((r) => r.task === "P-01/T2");
    expect(t2.length).toBe(2);
    expect(t2[1]!.resumeId).toBe(t2[0]!.sessionId);
    expect(t2[1]!.prompt).toContain("Stock after a refund");
    expect(task("T2").rounds.some((r) => r.source === "uat")).toBe(true);
    expect(task("T1").rounds.some((r) => r.source === "uat")).toBe(false);
    expect(plan().stagingPrs.length).toBe(2);
    expect(f.testInputs.length).toBe(2);
    expect(plan().uat!.passed).toBe(true);
    expect(f.calls.filter((c) => c.startsWith("rebase /stage/P-01/api origin/uat")).length).toBeGreaterThanOrEqual(2);
    const evs = engine.events("P-01");
    expect(evs.some((e) => e.event === "send_back" && e.task === "P-01/T2" && e.source === "uat")).toBe(true);
    expect(f.prs.filter((p) => p.dest === "master").length).toBe(1);
  });

  test("a failed check with no task goes back to every task", async () => {
    const { f, plan, engine, task, submitAndPlan, toMaster } = setup();
    f.plan = planned([tk("T1")]);
    const id = await submitAndPlan();
    f.testQ.push({ exercised: true, passed: false, proof: "no", checks: [{ what: "Something odd", ok: false }] });
    engine.start(id);
    await toMaster();
    expect(task("T1").rounds.some((r) => r.source === "uat")).toBe(true);
    expect(plan().error).toBeFalsy();
  });

  test("send-backs are limited", async () => {
    const { f, plan, engine, submitAndPlan, toMaster } = setup({ maxSendBacks: 1 });
    f.plan = planned([tk("T1")]);
    const id = await submitAndPlan();
    const bad = { exercised: true, passed: false, proof: "no", checks: [{ what: "Main", ok: false, task: "T1" }] };
    f.testQ.push(bad, bad);
    engine.start(id);
    await toMaster();
    expect(plan().error).toContain("send-backs");
    expect(f.testInputs.length).toBe(2);
  });

  test("a plan error goes to the recovery run, which sends the task back instead of waiting", async () => {
    const { f, plan, task, engine, submitAndPlan } = setup();
    f.plan = planned([tk("T1")]);
    const id = await submitAndPlan();
    f.script.planner = [{ action: "send_back", task: "T1", finding: "Read the field the test checks", why: "the code missed one path" }];
    const none = { exercised: false, passed: false, proof: "no data", checks: [] };
    f.testQ.push(none, none, none);
    engine.start(id);
    await until(() => task("T1").rounds.some((r) => r.source === "recovery"), "recovery send-back");
    expect(plan().recoveries).toBe(1);
    expect(task("T1").notes.join(" ")).toContain("Read the field the test checks");
    await until(() => plan().steps.master === "you", "master after the send-back");
    expect(plan().error).toBeUndefined();
  });

  test("not exercised asks again, then errors; Retry runs it again", async () => {
    const { f, plan, engine, submitAndPlan, toMaster } = setup();
    f.plan = planned([tk("T1")]);
    const id = await submitAndPlan();
    const none = { exercised: false, passed: false, proof: "no data", checks: [] };
    f.testQ.push(none, none, none);
    engine.start(id);
    await toMaster();
    expect(f.testInputs.length).toBe(3);
    expect(plan().error).toContain("never reached the change after 3 tries");
    expect(plan().steps.uat).toBe("fail");
    engine.retry(id);
    expect(plan().error).toBeUndefined();
    expect(plan().steps.staging).not.toBe("done"); // staging runs again, so a fix on the plan branch deploys first
    await until(() => plan().steps.master === "you", "master after retry");
    expect(f.testInputs.length).toBe(4);
  });

  test("not exercised once, then passes", async () => {
    const { f, plan, engine, submitAndPlan, toMaster } = setup();
    f.plan = planned([tk("T1")]);
    const id = await submitAndPlan();
    f.testQ.push({ exercised: false, passed: false, proof: "no data", checks: [] });
    engine.start(id);
    await toMaster();
    expect(f.testInputs.length).toBe(2);
    expect(plan().uat!.tries).toBe(2);
    expect(plan().steps.master).toBe("you");
  });
});

describe("pipeline errors", () => {
  test("a cherry-pick conflict is a plan error", async () => {
    const { f, plan, engine, submitAndPlan, toMaster } = setup();
    f.plan = planned([tk("T1")]);
    f.conflicts.cherry = true;
    const id = await submitAndPlan();
    engine.start(id);
    await toMaster();
    expect(plan().error).toContain("Master has drifted; port it by hand");
    expect(plan().steps.master).toBe("fail");
    expect(plan().masterPrs.length).toBe(0);
  });

  test("a rebase conflict at staging and a merge conflict are errors", async () => {
    const a = setup();
    a.f.plan = planned([tk("T1")]);
    a.f.conflicts.rebase.add("/stage/P-01/api");
    const id = await a.submitAndPlan();
    a.engine.start(id);
    await until(() => !!a.plan().error, "error");
    expect(a.plan().error).toContain("Rebase");
    expect(a.plan().steps.staging).toBe("fail");

    const b = setup();
    b.f.plan = planned([tk("T1")]);
    b.f.conflicts.merge.add("prflow/p-01-my-plan-t1");
    const id2 = await b.submitAndPlan();
    b.engine.start(id2);
    await until(() => b.task("T1").status === "failed", "failed");
    expect(b.task("T1").error).toContain("Merge into the plan branch failed");
  });

  test("staging that does not deploy, and a failed deploy, stop the plan", async () => {
    const a = setup();
    a.f.plan = planned([tk("T1")]);
    a.f.deployCheck = "No pipeline on uat";
    const id = await a.submitAndPlan();
    a.engine.start(id);
    await until(() => !!a.plan().error, "error");
    expect(a.plan().error).toContain("No pipeline on uat");
    expect(a.f.prs.length).toBe(0);

    const b = setup();
    b.f.plan = planned([tk("T1")]);
    b.f.deployOk = false;
    const id2 = await b.submitAndPlan();
    b.engine.start(id2);
    await until(() => !!b.plan().error, "error");
    expect(b.plan().error).toContain("pipeline failed");
  });

  test("a repo no pipeline deploys merges without a deploy wait, on staging and master", async () => {
    const { f, plan, engine, submitAndPlan, toMaster } = setup();
    f.plan = planned([tk("T1")]);
    f.deployCheck = { manual: "api has no Bitbucket pipeline" };
    f.runner.noPipeline.add("api"); // on master: the runner finds no pipeline and goes on
    const id = await submitAndPlan();
    engine.start(id);
    await toMaster();
    expect(plan().stagingPrs[0]!.state).toBe("merged");
    expect(plan().repos[0]!.manualDeploy).toContain("no Bitbucket pipeline");
    await engine.mergeMaster(id);
    await until(() => plan().steps.master === "done", "live");
    expect(f.calls.some((c) => c.startsWith("deploy-wait"))).toBe(false);
    expect(plan().now).toBe("1/1 merged by you · live on prod · deploy api by hand");
  });

  test("a staging pipeline that only builds counts as merged, deploy by hand; on master the runner's passed pipeline counts as deployed", async () => {
    const { f, plan, engine, submitAndPlan, toMaster } = setup();
    f.plan = planned([tk("T1")]);
    f.deployBuildsOnly = true;
    const id = await submitAndPlan();
    engine.start(id);
    await toMaster();
    expect(plan().stagingPrs[0]!.byHand).toBe("pipeline only builds");
    await engine.mergeMaster(id);
    await until(() => plan().steps.master === "done", "live");
    expect(plan().masterPrs[0]).toMatchObject({ state: "merged", deployed: true });
    expect(plan().masterPrs[0]!.byHand).toBeUndefined();
  });

  test("a ticket number goes at the start of every PR title", async () => {
    const { f, engine, submitAndPlan, toMaster } = setup();
    f.plan = planned([tk("T1")]);
    const id = await submitAndPlan();
    engine.setTicket(id, "BOM-10046");
    engine.start(id);
    await toMaster();
    expect(f.prs.map((r) => r.title)).toEqual(["[BOM-10046 · P-01] My plan", "[BOM-10046 · P-01] My plan"]);
  });

  test("a failed merge to master stops with the reason and can be repeated", async () => {
    const { f, plan, engine, submitAndPlan, toMaster } = setup();
    f.plan = planned([tk("T1")]);
    const id = await submitAndPlan();
    engine.start(id);
    await toMaster();
    f.runner.fail = { repo: "api", reason: "[ERROR] Failed to execute goal deploy: connection refused" };
    await engine.mergeMaster(id);
    await until(() => !!plan().error && !plan().merging, "merge error");
    expect(plan().error).toContain("Release run #41 stopped at api, step 'Deploy to prod': [ERROR] Failed to execute goal deploy: connection refused");
    expect(plan().error).toContain("https://bitbucket.org/bsctech/enigma-release/pipelines/results/41");
    expect(plan().steps.master).toBe("you");
    expect(plan().masterPrs[0]).toMatchObject({ state: "merged", run: "failed" });
    expect(plan().release!.failed).toMatchObject({ repo: "api", step: "Deploy to prod" });
    engine.retry(id);
    await engine.mergeMaster(id); // first re-click: asks for the pipeline to be re-run
    await until(() => !!plan().error && !plan().merging, "confirm");
    expect(plan().error).toContain("re-run that pipeline in the git host");
    engine.retry(id);
    await engine.mergeMaster(id); // second: counts it as deployed
    await until(() => plan().steps.master === "done", "live");
    expect(f.calls.filter((c) => c === "merge-pr master #102").length).toBe(1);
    expect(f.calls.filter((c) => c.startsWith("release-start")).length).toBe(1); // nothing open, so no second run
  });

  test("an unexpected throw fails the task and never crashes the loop", async () => {
    const { f, task, plan, engine, submitAndPlan } = setup();
    f.plan = planned([tk("T1")]);
    const id = await submitAndPlan();
    const down = () => { throw new Error("claude is down"); };
    f.queue("executor", down, down, down, down);
    engine.start(id);
    await until(() => task("T1").status === "failed", "failed");
    expect(task("T1").error).toContain("claude is down");
    engine.retry(id);
    await until(() => plan().steps.master === "you", "master");
  });

  test("a planner that never returns a valid plan gives a plan error", async () => {
    const { f, plan, engine } = setup();
    f.plan = planned([tk("T1", { repo: "nowhere" })]);
    const id = engine.submit("bad");
    await until(() => !!plan(id).error, "error");
    expect(plan(id).error).toContain("still has problems");
    expect(f.count("planner")).toBe(2);
    expect(f.runsOf("planner")[1]!.resumeId).toBe(f.runsOf("planner")[0]!.sessionId);
    expect(f.runsOf("planner")[1]!.prompt).toContain("nowhere");
    expect(plan(id).steps.plan).toBe("fail");
  });

  test("blocking architect findings on the split go back to the planner once", async () => {
    const { f, plan, engine } = setup();
    f.plan = planned([tk("T1"), tk("T2")]);
    f.queue("architect-reviewer", review(blocking("T1 and T2 need a shared contract", "correctness")));
    const id = engine.submit("big");
    await until(() => plan(id).steps.plan === "you", "planned");
    expect(f.count("planner")).toBe(2);
    expect(f.runsOf("planner")[1]!.prompt).toContain("shared contract");
    expect(f.count("architect-reviewer")).toBe(1);
  });

  test("an architect finding no task owns goes to the planner, not to every task (P-06, 27/10)", async () => {
    const { f, plan, task, engine, submitAndPlan, toMaster } = setup();
    f.plan = (_r: any, n: number) => (n === 1 ? planned([tk("T1"), tk("T2")]) : planned([tk("T1", { action: "keep" }), tk("T2", { action: "keep" }), tk("T3", { wave: 2, action: "add" })]));
    const id = await submitAndPlan();
    f.queue("architect-reviewer", review(blocking("The proxy's HTTP client has no timeout", "correctness", "other-repo/src/Proxy.java")));
    engine.start(id);
    await until(() => !!engine.state().tasks["P-01/T3"], "the planner added a task");
    await until(() => plan().steps.plan !== "run", "re-planned");
    if (plan().needsStart) engine.start(id);
    await toMaster();
    expect(plan().error).toBeFalsy();
    expect(plan().text).toContain("The proxy's HTTP client has no timeout");
    expect(task("T1").rounds.some((r) => r.source === "architect")).toBe(false);
    expect(task("T2").rounds.some((r) => r.source === "architect")).toBe(false);
    expect(task("T3").status).toBe("done");
  });

  test("an architect finding on the plan diff is sent to the owning task", async () => {
    const { f, plan, task, engine, submitAndPlan, toMaster } = setup();
    f.plan = planned([tk("T1"), tk("T2")]);
    const id = await submitAndPlan();
    f.queue("architect-reviewer", review(blocking("Wrong column name", "correctness", "src/T2.ts")));
    engine.start(id);
    await toMaster();
    expect(plan().error).toBeUndefined();
    expect(task("T2").rounds.some((r) => r.source === "architect")).toBe(true);
    expect(f.runsOf("executor").filter((r) => r.task === "P-01/T2").length).toBe(2);
    expect(f.count("architect-reviewer")).toBe(3); // the split, the plan diff, and the diff again after the fix
    const [whole, after] = f.runsOf("architect-reviewer").slice(1);
    expect(after!.resumeId).toBe(whole!.sessionId); // its own session, not a new one
    expect(after!.prompt).toContain("earlier in this session");
    expect(after!.prompt).toContain("Wrong column name");
    expect(after!.prompt).toContain("Sent back to T2");
    expect(after!.prompt).not.toContain("Review this change.");
  });

  test("a failed resume of the architect's session reads the whole plan diff again in a new one", async () => {
    const { f, plan, engine, submitAndPlan, toMaster } = setup();
    f.plan = planned([tk("T1"), tk("T2")]);
    const id = await submitAndPlan();
    f.queue("architect-reviewer", review(blocking("Wrong column name", "correctness", "src/T2.ts")), { __error: "No conversation found" });
    engine.start(id);
    await toMaster();
    expect(plan().error).toBeUndefined();
    const runs = f.runsOf("architect-reviewer").slice(1);
    expect(runs.length).toBe(3); // whole diff, failed resume, whole diff again
    expect(runs[1]!.resumeId).toBe(runs[0]!.sessionId);
    expect(runs[2]!.resumeId).toBeUndefined();
    expect(runs[2]!.prompt).toContain("Review this change.");
    expect(engine.events(id).some((e) => e.event === "architect_resume_failed")).toBe(true);
  });
});

describe("two plans on one file", () => {
  test("the second waits, starts after the first reaches staging, and rebases", async () => {
    const { f, plan, task, engine } = setup();
    f.plan = (run) => planned([tk("T1", { files: ["src/Shared.java"] })], { title: run.plan === "P-01" ? "First" : "Second" });
    const hold = deferred();
    f.queue("executor", async (run: any) => { await hold.p; f.touch(run.edits[0], ["src/Shared.java"]); return okExec({ label: "T1" }); });
    const a = engine.submit("first"), b = engine.submit("second");
    await until(() => plan(a).steps.plan === "you" && plan(b).steps.plan === "you", "both planned");
    engine.start(a); engine.start(b);
    await until(() => task("T1", b).waitsOn.length > 0, "P-02 waits");
    expect(task("T1", b).waitsOn).toEqual(["P-01/T1"]);
    expect(task("T1", b).sub).toBe("Waits for P-01 to reach staging (Shared.java)");
    expect(task("T1", b).status).toBe("waiting");
    hold.go();
    await until(() => plan(b).steps.master === "you" && plan(a).steps.master === "you", "both at master");
    const calls = f.calls;
    expect(calls.indexOf("claude executor P-02/T1")).toBeGreaterThan(calls.indexOf("merge-pr uat #101"));
    expect(calls.filter((c) => c.startsWith("rebase /stage/P-02/api origin/uat")).length).toBeGreaterThanOrEqual(2);
    expect(task("T1", b).waitsOn).toEqual([]);
    expect(plan(a).repos[0]!.staged).toBe(true);
    expect(f.prs.find((p) => p.title === "[P-02] Second")!.src).toBe("prflow/p-02-second");
  });
});

describe("stop, retry and recover", () => {
  test("stop leaves the task waiting; retry carries on", async () => {
    const { f, plan, task, engine, submitAndPlan, toMaster } = setup();
    f.plan = planned([tk("T1")]);
    const id = await submitAndPlan();
    const hold = deferred();
    f.queue("executor", async (run: any) => { await hold.p; f.touch(run.edits[0], ["src/T1.ts"]); return okExec({ label: "T1" }); });
    engine.start(id);
    await until(() => f.count("executor") === 1, "executor running");
    engine.stop(id);
    expect(plan().stopRequested).toBe(true);
    hold.go();
    await until(() => task("T1").status === "waiting", "stopped");
    expect(task("T1").error).toBeUndefined();
    expect(f.count("executor")).toBe(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(f.count("executor")).toBe(1);
    engine.retry(id);
    expect(plan().stopRequested).toBeUndefined();
    await toMaster();
    expect(task("T1").status).toBe("done");
    expect(f.runsOf("executor")[1]!.resumeId).toBe(f.runsOf("executor")[0]!.sessionId);
    expect(engine.events(id).map((e) => e.event)).toEqual(expect.arrayContaining(["stopped_by_user", "task_stopped", "retry"]));
  });

  test("recover after a restart resumes a working task", async () => {
    const { f, ports, plan, task, engine, submitAndPlan } = setup();
    f.plan = planned([tk("T1")]);
    const id = await submitAndPlan();
    const hold = deferred();
    f.queue("executor", async () => { await hold.p; return okExec({ label: "T1" }); });
    engine.start(id);
    await until(() => task("T1").status === "working" && f.count("executor") === 1, "working");
    const sid = task("T1").sessionId;
    const engine2 = createEngine(ports);
    f.engine = engine2;
    expect(engine2.state().tasks["P-01/T1"]!.status).toBe("working");
    engine2.recover();
    expect(["waiting", "working"]).toContain(engine2.state().tasks["P-01/T1"]!.status);
    await until(() => engine2.state().plans["P-01"]!.steps.master === "you", "master");
    expect(engine2.state().tasks["P-01/T1"]!.status).toBe("done");
    expect(f.runsOf("executor")[1]!.resumeId).toBe(sid);
    expect(engine2.events(id).map((e) => e.event)).toContain("recovered");
    expect(plan().id).toBe("P-01");
  });
  test("a review a restart cut carries on in its own session, and the writer does not run again", async () => {
    const { f, ports, task, engine, submitAndPlan } = setup();
    f.plan = planned([tk("T1", { review: true })]);
    const id = await submitAndPlan();
    const hold = deferred();
    f.queue("code-reviewer", async () => { await hold.p; return { findings: [] }; });
    engine.start(id);
    await until(() => task("T1").status === "review" && f.count("code-reviewer") === 1, "reviewing");
    const sid = f.runsOf("code-reviewer")[0]!.sessionId, writes = f.count("executor");
    const engine2 = createEngine(ports);
    f.engine = engine2;
    engine2.recover();
    await until(() => engine2.state().tasks["P-01/T1"]!.status === "done", "done");
    expect(f.count("executor")).toBe(writes);
    const again = f.runsOf("code-reviewer")[1]!;
    expect(again.resumeId).toBe(sid);
    expect(again.prompt).toContain("The backend restarted");
    expect(engine2.events(id).map((e) => e.event)).toEqual(expect.arrayContaining(["review_resumed", "run_resumed"]));
    expect(Object.keys(engine2.state().runs ?? {})).toEqual([]);
  });
});

describe("queue", () => {
  test("reorder moves a plan before another", async () => {
    const { f, plan, engine } = setup();
    f.plan = planned([tk("T1")]);
    const a = engine.submit("a"), b = engine.submit("b");
    engine.reorder(b, a);
    expect([plan(a).order, plan(b).order]).toEqual([2, 1]);
    engine.reorder(b, null);
    expect([plan(a).order, plan(b).order]).toEqual([1, 2]);
    expect(() => engine.reorder("P-99", null)).toThrow();
  });
});

describe("review fixes: stale branches and the plan lock", () => {
  test("a send-back rebases the task onto the plan branch before the executor resumes", async () => {
    const { f, task, engine, submitAndPlan, toMaster } = setup({ reviewerResume: false });
    f.plan = planned([tk("T1"), tk("T2")]);
    const id = await submitAndPlan();
    f.testQ.push({ exercised: true, passed: false, proof: "no", checks: [{ what: "Stock", ok: false, task: "T2" }] });
    engine.start(id);
    await toMaster();
    const rb = f.calls.indexOf("rebase /stage/P-01/T2 prflow/p-01-my-plan");
    expect(rb).toBeGreaterThan(f.calls.indexOf("claude executor P-01/T2"));
    expect(f.calls.indexOf("claude executor P-01/T2", rb)).toBeGreaterThan(rb);
    expect(f.branches.get("api/prflow/p-01-my-plan-t2")).toContain(task("T1").commits[0]!);
    expect(engine.events(id).some((e) => e.event === "task_rebase")).toBe(true);
  });

  test("a rebase conflict on a resumed step fails the task with the conflict text", async () => {
    const { f, task, engine, submitAndPlan, plan } = setup();
    f.plan = planned([tk("T1"), tk("T2")]);
    f.conflicts.rebase.add("/stage/P-01/T2");
    const id = await submitAndPlan();
    const onlyT2 = (run: any): any => { if (run.task === "P-01/T2") return review(blocking("Wrong total")); f.script["code-reviewer"]!.unshift(onlyT2); return review(); };
    f.queue("code-reviewer", onlyT2);
    engine.start(id);
    await until(() => task("T2").status === "failed", "T2 failed");
    expect(task("T2").error).toContain("Rebase onto the plan branch failed: CONFLICT rebasing /stage/P-01/T2");
    expect(f.count("executor")).toBe(2);
    expect(plan().error).toBeUndefined();
  });

  test("plan worktree jobs never overlap, and a plan with parallel tasks and gates finishes", async () => {
    const { f, engine, submitAndPlan, toMaster } = setup({ maxTasks: 3 });
    f.plan = planned([tk("T1"), tk("T2"), tk("T3"), tk("T4", { wave: 2, deps: ["T1"] })]);
    const id = await submitAndPlan();
    f.buildQ.push({ ok: true }, { ok: true }, { ok: true }, { ok: false });
    engine.start(id);
    await toMaster();
    expect(f.overlaps).toEqual([]);
  });
});

describe("review fixes: the gate debugger leaves nothing uncommitted", () => {
  test("a fix that works is committed", async () => {
    const { f, engine, submitAndPlan, toMaster } = setup();
    f.plan = planned([tk("T1")]);
    const id = await submitAndPlan();
    f.buildQ.push({ ok: true }, { ok: false, tail: "gate build broke" });
    engine.start(id);
    await toMaster();
    expect(f.count("debugger")).toBe(1);
    expect(f.calls.some((c) => c.startsWith("commit /stage/P-01/api "))).toBe(true);
    expect(f.dirs.get("/stage/P-01/api")!.pending.size).toBe(0);
  });

  test("a debugger that fails halfway has its edits dropped", async () => {
    const { f, plan, engine, submitAndPlan } = setup();
    f.plan = planned([tk("T1")]);
    const id = await submitAndPlan();
    f.buildQ.push({ ok: true }, { ok: false, tail: "gate build broke" });
    for (let i = 0; i < 3; i++) f.buildQ.push({ ok: false, tail: "gate build broke" });
    const crash = (run: any) => { f.touch(run.edits[0], ["half-done.ts"]); return { __error: "the debugger crashed" }; };
    f.queue("debugger", crash, crash, crash, crash);
    engine.start(id);
    await until(() => !!plan().error, "gate error");
    expect(plan().error).toContain("The debugger failed");
    expect(f.dirs.get("/stage/P-01/api")!.pending.size).toBe(0);
    expect(f.calls).toContain("drop /stage/P-01/api");
    expect(engine.events(id).some((e) => e.event === "worktree_reset")).toBe(true);
  });
});

describe("review fixes: the diff guard sees the whole branch", () => {
  test("gate debugger edits are checked before the staging push", async () => {
    const { f, plan, engine, submitAndPlan } = setup();
    f.plan = planned([tk("T1")]);
    f.guard = (files) => (files.includes("debugger-fix.txt") ? "It touches a secret file" : null);
    const id = await submitAndPlan();
    f.buildQ.push({ ok: true }, { ok: false, tail: "gate build broke" });
    engine.start(id);
    await until(() => !!plan().error, "error");
    expect(plan().error).toContain("refused before the push: It touches a secret file");
    expect(f.calls.some((c) => c.startsWith("push "))).toBe(false);
    expect(f.prs.length).toBe(0);
    expect(plan().steps.staging).toBe("fail");
  });

  test("the master branch is checked before its push", async () => {
    const { f, plan, engine, submitAndPlan, toMaster } = setup();
    f.plan = planned([tk("T1")]);
    f.guard = () => (f.calls.some((c) => c.startsWith("cherry-pick")) ? "Master change refused" : null);
    const id = await submitAndPlan();
    engine.start(id);
    await toMaster();
    expect(plan().error).toContain("master change was refused before the push: Master change refused");
    expect(f.calls.some((c) => c.startsWith("push /stage/P-01/api-master"))).toBe(false);
    expect(plan().masterPrs.length).toBe(0);
  });

  test("a task's final state is checked before it merges into the plan branch", async () => {
    const { f, task, engine, submitAndPlan } = setup();
    f.plan = planned([tk("T1")]);
    f.guard = () => (f.calls.some((c) => c === "claude debugger P-01/T1") ? "The debugger touched a secret" : null);
    const id = await submitAndPlan();
    f.buildQ.push({ ok: false, tail: "compile error" });
    engine.start(id);
    await until(() => task("T1").status === "failed", "failed");
    expect(task("T1").error).toBe("The change was refused: The debugger touched a secret");
    expect(f.calls.some((c) => c.startsWith("merge /stage/P-01/api <-"))).toBe(false);
  });
});

describe("review fixes: merge to master", () => {
  const twoRepos = () => {
    const s = setup();
    s.f.plan = planned([tk("T1", { repo: "api" }), tk("T2", { repo: "web" })], { repo_order: [{ repo: "api", why: "api first" }, { repo: "web", why: "web needs the api" }] });
    return s;
  };
  const disk = (dir: string) => JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).plans["P-01"];

  test("a PR pushed to after it was tested is not merged", async () => {
    const { f, plan, engine, submitAndPlan, toMaster } = setup();
    f.plan = planned([tk("T1")]);
    const id = await submitAndPlan();
    engine.start(id);
    await toMaster();
    expect(plan().masterPrs[0]!.head).toBeTruthy();
    f.pushExtra("prflow/p-01-my-plan-master");
    await engine.mergeMaster(id);
    await until(() => !!plan().error, "error");
    expect(plan().error).toContain("PR #102 changed after it was tested");
    expect(f.calls).not.toContain("merge-pr master #102");
    expect(plan().masterPrs[0]!.state).toBe("open");
  });

  test("a PR's short Bitbucket head matches the full git head it was tested at", async () => {
    const { f, plan, engine, submitAndPlan, toMaster } = setup();
    f.longHeads = true;
    f.plan = planned([tk("T1")]);
    const id = await submitAndPlan();
    engine.start(id);
    await toMaster();
    expect(plan().masterPrs[0]!.head).toHaveLength(40);
    await engine.mergeMaster(id);
    await until(() => plan().steps.master === "done", "live");
    expect(f.calls).toContain("merge-pr master #102");
  });

  test("a push after the test is still caught when heads are short", async () => {
    const { f, plan, engine, submitAndPlan, toMaster } = setup();
    f.longHeads = true;
    f.plan = planned([tk("T1")]);
    const id = await submitAndPlan();
    engine.start(id);
    await toMaster();
    f.pushExtra("prflow/p-01-my-plan-master");
    await engine.mergeMaster(id);
    await until(() => !!plan().error, "error");
    expect(plan().error).toContain("changed after it was tested");
  });

  test("a merged PR whose deploy failed stops once more before the rest goes to a new run with only the open PRs", async () => {
    const { f, plan, engine, submitAndPlan, toMaster, ports } = twoRepos();
    const id = await submitAndPlan();
    engine.start(id);
    await toMaster();
    f.runner.fail = { repo: "api" };
    await engine.mergeMaster(id);
    await until(() => !!plan().error && !plan().merging, "deploy error");
    expect(f.prs.filter((p) => p.dest === "master" && p.merged).map((p) => p.repo)).toEqual(["api"]);
    expect(disk(ports.dataDir).masterPrs[0]).toMatchObject({ state: "merged" });
    expect(disk(ports.dataDir).masterPrs[0].deployed).toBeFalsy();
    expect(plan().askYou).toBeUndefined(); // a failed deploy is a failure
    engine.retry(id);
    await engine.mergeMaster(id);
    await until(() => !!plan().error && !plan().merging, "confirm");
    expect(plan().error).toContain("api PR #103 is merged, but its prod pipeline did not pass");
    expect(plan().askYou).toBe(true); // the confirm is a question for Pratham
    expect(f.calls.filter((c) => c.startsWith("release-start")).length).toBe(1); // web waits for the confirm
    engine.retry(id);
    expect(plan().askYou).toBeUndefined();
    await engine.mergeMaster(id);
    await until(() => plan().steps.master === "done", "live");
    expect(f.calls.filter((c) => c.startsWith("release-start"))).toEqual(["release-start master api#103,web#104", "release-start master web#104"]);
    expect(f.calls.filter((c) => c.startsWith("merge-pr master")).length).toBe(2);
    expect(plan().masterPrs.every((p) => p.deployed)).toBe(true);
    expect(plan().release!.run).toBe(42);
  });

  test("state is saved after every merge and every deploy", async () => {
    const { f, plan, engine, submitAndPlan, toMaster, ports } = twoRepos();
    const id = await submitAndPlan();
    engine.start(id);
    await toMaster();
    f.runner.fail = { repo: "web" };
    await engine.mergeMaster(id);
    await until(() => !!plan().error && !plan().merging, "second deploy error");
    const d = disk(ports.dataDir).masterPrs;
    expect(d[0]).toMatchObject({ state: "merged", deployed: true });
    expect(d[1]).toMatchObject({ state: "merged", run: "failed" });
    expect(d[1].deployed).toBeFalsy();
    expect(disk(ports.dataDir).release).toMatchObject({ state: "fail", run: 41 });
    for (let i = 0; i < 2; i++) { engine.retry(id); await engine.mergeMaster(id); await until(() => plan().steps.master === "done" || (!!plan().error && !plan().merging), "merge ends"); }
    expect(plan().steps.master).toBe("done");
    expect(f.calls.filter((c) => c.startsWith("release-start")).length).toBe(1); // both merged: no second run
    expect(f.calls.filter((c) => c.startsWith("merge-pr master")).length).toBe(2);
  });
});

describe("review fixes: crash, no change, edits, missing folders", () => {
  test("a crash between the merge and done: the retry finishes without a new executor run", async () => {
    const { f, task, plan, engine, submitAndPlan, toMaster } = setup();
    f.plan = planned([tk("T1")]);
    f.crashAfterMerge = true;
    const id = await submitAndPlan();
    engine.start(id);
    await toMaster(); // the crash is a transient failure: the task retries on its own
    expect(engine.events(id).some((e) => e.event === "retry_scheduled")).toBe(true);
    expect(task("T1").status).toBe("done");
    expect(task("T1").mergeFrom).toBeUndefined();
    expect(f.count("executor")).toBe(1);
    expect(f.calls.filter((c) => c.startsWith("merge /stage/P-01/api <-")).length).toBe(1);
    expect(plan().error).toBeUndefined();
  });

  test("a reopened task whose executor changes nothing is done, and its master PR is declined and remade", async () => {
    const { f, task, plan, engine, submitAndPlan, toMaster } = setup();
    f.plan = planned([tk("T1")]);
    f.guard = (files) => (files.length ? null : "An empty change is refused");
    const id = await submitAndPlan();
    engine.start(id);
    await toMaster();
    f.plan = planned([tk("T1", { action: "reopen", note: "Check the total again" })]);
    f.queue("executor", async () => okExec({ label: "T1" }));
    engine.edit(id, "v2");
    await until(() => plan().versions.length === 2 && plan().steps.plan === "done", "re-planned");
    expect(f.prs.find((p) => p.dest === "master")!.state).toBe("declined");
    expect(engine.events(id).some((e) => e.event === "pr_declined")).toBe(true);
    await until(() => task("T1").status === "done" || task("T1").status === "failed", "T1 ends");
    expect(task("T1").status).toBe("done");
    expect(task("T1").sub).toContain("No change needed");
    await toMaster();
    expect(plan().error).toBeUndefined();
    expect(plan().masterPrs.length).toBe(1);
  });

  test("an edit declines a staging PR that is still open", async () => {
    const { f, plan, engine, submitAndPlan } = setup();
    f.plan = planned([tk("T1")]);
    f.failMerge = 4;
    const id = await submitAndPlan();
    engine.start(id);
    await until(() => !!plan().error, "staging error");
    expect(plan().stagingPrs.at(-1)!.state).toBe("open");
    expect(plan().stagingPrs.slice(0, -1).every((r) => r.state === "declined")).toBe(true); // each retry declines the PR the last try left open
    f.plan = planned([tk("T1", { action: "reopen", note: "again" })]);
    engine.edit(id, "v2");
    await until(() => plan().versions.length === 2 && plan().steps.plan === "done", "re-planned");
    expect(f.prs.every((p) => p.state === "declined")).toBe(true);
    expect(plan().stagingPrs.every((r) => r.state === "declined")).toBe(true);
  });

  test("a worktree folder that was cleared is made again from its branch", async () => {
    const { f, task, plan, engine, submitAndPlan, toMaster } = setup();
    f.plan = planned([tk("T1")]);
    const id = await submitAndPlan();
    engine.start(id);
    await toMaster();
    f.dirs.clear();
    f.plan = planned([tk("T1", { action: "reopen", note: "again" })]);
    engine.edit(id, "v2");
    await until(() => plan().versions.length === 2 && plan().steps.plan === "done", "re-planned");
    await until(() => task("T1").status === "done" || task("T1").status === "failed", "T1 ends");
    expect(task("T1").error).toBeUndefined();
    expect(task("T1").status).toBe("done");
    expect(f.calls).toContain("worktree /stage/P-01/api prflow/p-01-my-plan prflow/p-01-my-plan");
    expect(f.calls).toContain("worktree /stage/P-01/T1 prflow/p-01-my-plan-t1 prflow/p-01-my-plan-t1");
    expect(engine.events(id).filter((e) => e.event === "worktree_recreated").length).toBe(2);
  });
});

describe("review fixes: minors", () => {
  test("a send-back puts staged back to false", async () => {
    const { f, plan, task, engine, submitAndPlan, toMaster } = setup({ reviewerResume: false });
    f.plan = planned([tk("T1"), tk("T2")]);
    const id = await submitAndPlan();
    f.testQ.push({ exercised: true, passed: false, proof: "no", checks: [{ what: "Stock", ok: false, task: "T2" }] });
    let seen: unknown = "unset";
    const norm = async (run: any) => { f.touch(run.edits[0], task(run.task.split("/")[1]).files); return okExec({ label: run.task }); };
    f.queue("executor", norm, norm, async (run: any) => { seen = plan().repos[0]!.staged; return norm(run); });
    engine.start(id);
    await toMaster();
    expect(seen).toBe(false);
    expect(plan().repos[0]!.staged).toBe(true);
  });

  test("a started plan with every task removed gets an error", async () => {
    const { f, plan, engine, submitAndPlan } = setup();
    f.plan = planned([tk("T1"), tk("T2")]);
    const id = await submitAndPlan();
    const hold = deferred();
    const held = async (run: any) => { await hold.p; f.touch(run.edits[0], ["src/x.ts"]); return okExec({ label: "x" }); };
    f.queue("executor", held, held);
    engine.start(id);
    await until(() => f.count("executor") === 2, "both writing");
    f.plan = planned([tk("T1", { action: "remove" }), tk("T2", { action: "remove" })]);
    engine.edit(id, "v2");
    await until(() => !!plan().error, "error");
    expect(plan().error).toBe("Every task was removed. Edit the plan or remove it.");
    hold.go();
  });

  test("Retry does not clear stop on a task whose old run is still ending", async () => {
    const { f, plan, task, engine, submitAndPlan } = setup();
    f.plan = planned([tk("T1")]);
    const id = await submitAndPlan();
    const hold = deferred();
    f.queue("executor", async (run: any) => { await hold.p; f.touch(run.edits[0], ["src/T1.ts"]); return okExec({ label: "T1" }); });
    engine.start(id);
    await until(() => task("T1").status === "working" && f.count("executor") === 1, "T1 writing");
    f.plan = planned([tk("T1", { action: "redo" })]);
    engine.edit(id, "v2");
    await until(() => plan().steps.plan === "done" && plan().versions.length === 2, "re-planned");
    expect(task("T1").stopRequested).toBe(true);
    engine.retry(id);
    expect(task("T1").stopRequested).toBe(true);
    hold.go();
    await until(() => task("T1").status === "done", "the redo ran after the old run ended");
    expect(f.count("executor")).toBe(2);
  });

  test("an empty cherry-pick (already on master) is skipped, not drifted", async () => {
    const a = setup();
    a.f.plan = planned([tk("T1")]);
    a.f.cherryEmpty = () => true;
    const id = await a.submitAndPlan();
    a.engine.start(id);
    await until(() => a.plan().steps.master === "done" || !!a.plan().error, "master step");
    expect(a.plan().error).toBeUndefined();
    expect(a.plan().masterPrs).toEqual([]);
    expect(a.names()).toContain("cherry_pick_skipped");

    const b = setup();
    b.f.plan = planned([tk("T1"), tk("T2")]);
    b.f.cherryEmpty = (n) => n === 1;
    const id2 = await b.submitAndPlan();
    b.engine.start(id2);
    await b.toMaster();
    expect(b.plan().error).toBeUndefined();
    expect(b.plan().steps.master).toBe("you");
    expect(b.plan().masterPrs.length).toBe(1);
    expect(b.names()).toContain("cherry_pick_skipped");
  });
});

describe("transient failures and waking up", () => {
  const netDown = (what = "network down") => ({ __error: what });
  // Holds the retry delays (60 s) until released; the staging settle wait is 1 ms in these tests.
  const holdRetries = (ports: any) => {
    const gate = deferred();
    ports.sleep = (ms: number) => (ms === 60_000 ? gate.p : Promise.resolve());
    return gate;
  };

  test("a transient Claude failure retries on its own, keeps its session, and succeeds", async () => {
    const { f, ports, task, engine, plan, submitAndPlan, toMaster } = setup({ settleMs: 1 });
    f.plan = planned([tk("T1")]);
    const id = await submitAndPlan();
    const gate = holdRetries(ports);
    f.queue("executor", netDown());
    engine.start(id);
    await until(() => !!task("T1").retryAt, "waiting for its retry");
    expect(task("T1").status).toBe("waiting");
    expect(task("T1").error).toBeUndefined();
    expect(task("T1").sub).toMatch(/^Retrying on its own at \d{1,2}:\d{2} (AM|PM) IST \(try 1 of 3\): The executor failed: network down$/);
    await new Promise((r) => setTimeout(r, 20));
    expect(f.count("executor")).toBe(1);
    gate.go();
    await toMaster();
    expect(task("T1").status).toBe("done");
    expect(task("T1").retryAt).toBeUndefined();
    expect(plan().error).toBeUndefined();
    expect(f.count("executor")).toBe(2);
    expect(f.runsOf("executor")[1]!.resumeId).toBe(f.runsOf("executor")[0]!.sessionId);
    expect(engine.events(id).find((e) => e.event === "retry_scheduled")!.text).toBe("Retrying on its own (try 1 of 3) after: The executor failed: network down");
  });

  test("the delays are 1, 5 and 15 minutes; after the last try the task fails and waits for Retry", async () => {
    const { f, task, engine, submitAndPlan, toMaster } = setup({ settleMs: 1 });
    f.plan = planned([tk("T1")]);
    const id = await submitAndPlan();
    f.queue("executor", netDown(), netDown(), netDown(), netDown());
    engine.start(id);
    await until(() => task("T1").status === "failed", "failed after the last try");
    expect(f.sleeps).toEqual([60_000, 300_000, 900_000]);
    expect(f.count("executor")).toBe(4);
    expect(task("T1").error).toContain("The executor failed: network down");
    expect(task("T1").retryAt).toBeUndefined();
    engine.retry(id);
    await toMaster();
    expect(task("T1").status).toBe("done");
  });

  test("a deliberate stop never retries", async () => {
    const a = setup({ settleMs: 1 });
    a.f.plan = planned([tk("T1")]);
    a.f.guard = () => "It touches a secret file";
    const id = await a.submitAndPlan();
    a.engine.start(id);
    await until(() => a.task("T1").status === "failed", "refused");
    await new Promise((r) => setTimeout(r, 20));
    expect(a.f.sleeps).toEqual([]); // fixed by the executor twice, then a deliberate stop: no timed retry
    expect(a.engine.events(id).some((e) => e.event === "retry_scheduled")).toBe(false);

    const b = setup({ settleMs: 1 });
    b.f.plan = planned([tk("T1")]);
    b.f.conflicts.cherry = true;
    const id2 = await b.submitAndPlan();
    b.engine.start(id2);
    await b.toMaster();
    expect(b.plan().error).toContain("Master has drifted");
    expect(b.f.sleeps).not.toContain(60_000);
    expect(b.engine.events(id2).some((e) => e.event === "retry_scheduled")).toBe(false);
  });

  test("a transient failure of a plan step waits, shows a normal state, and runs again", async () => {
    const { f, ports, plan, engine, submitAndPlan, toMaster } = setup({ settleMs: 1 });
    f.plan = planned([tk("T1")]);
    const id = await submitAndPlan();
    const gate = holdRetries(ports);
    const real = ports.test;
    let n = 0;
    ports.test = async (i) => { if (n++ === 0) throw new Error("ECONNRESET talking to the test runner"); return real(i); };
    engine.start(id);
    await until(() => !!plan().retryAt, "waiting for its retry");
    expect(plan().error).toBeUndefined();
    expect(plan().steps.uat).toBe("run");
    expect(plan().now).toMatch(/^Retrying on its own at \d{1,2}:\d{2} (AM|PM) IST \(try 1 of 3\): ECONNRESET/);
    gate.go();
    await toMaster();
    expect(plan().error).toBeUndefined();
    expect(plan().retryAt).toBeUndefined();
    expect(n).toBe(2);
  });

  test("a clock jump logs a woke event and retries at once", async () => {
    const { f, ports, task, engine, submitAndPlan, toMaster } = setup({ settleMs: 1 });
    let clock = Date.now();
    ports.now = () => clock;
    f.plan = planned([tk("T1")]);
    const id = await submitAndPlan();
    holdRetries(ports); // the 1-minute retry would wait; only the wake releases it
    f.queue("executor", netDown());
    engine.start(id);
    await until(() => !!task("T1").retryAt, "waiting for its retry");
    clock += 10_000;
    engine.heartbeat();
    expect(engine.events(id).some((e) => e.event === "woke")).toBe(false);
    clock += 3 * 3600_000;
    engine.heartbeat();
    const woke = engine.events(id).find((e) => e.event === "woke")!;
    expect(woke.text).toMatch(/^The computer was asleep from \d{1,2}:\d{2} (AM|PM) IST to \d{1,2}:\d{2} (AM|PM) IST; resuming$/);
    await toMaster();
    expect(task("T1").status).toBe("done");
    expect(f.count("executor")).toBe(2);
  });

  test("a failure that arrives after the sleep retries at once and resets the count", async () => {
    const { f, ports, task, engine, submitAndPlan, toMaster } = setup({ settleMs: 1 });
    let clock = Date.now();
    ports.now = () => clock;
    f.plan = planned([tk("T1")]);
    const id = await submitAndPlan();
    holdRetries(ports);
    const slept = deferred();
    f.queue("executor", async () => { await slept.p; return netDown("socket hang up"); });
    engine.start(id);
    await until(() => f.count("executor") === 1, "executor running");
    clock += 3 * 3600_000; // the Mac sleeps; the connection dies when it wakes
    slept.go();
    await toMaster();
    expect(task("T1").status).toBe("done");
    expect(f.count("executor")).toBe(2);
    expect(f.sleeps).not.toContain(60_000);
    const ev = engine.events(id);
    expect(ev.some((e) => e.event === "woke")).toBe(true);
    expect(ev.find((e) => e.event === "retry_scheduled")!.text).toBe("Retrying on its own now (the computer was asleep) after: The executor failed: socket hang up");
  });
  test("a planner run that ends with no answer (stream cut by sleep) retries on its own, not a stop", async () => {
    const { f, ports, engine, plan } = setup();
    f.plan = planned([tk("T1")]);
    const gate = holdRetries(ports);
    f.queue("planner", null);
    const id = engine.submit("do it");
    await until(() => !!plan(id).retryAt, "waiting for its retry");
    expect(plan(id).error).toBeUndefined();
    gate.go();
    await until(() => plan(id).steps.plan === "you", "planned");
    expect(f.count("planner")).toBe(2);
    expect(engine.events(id).some((e) => e.event === "plan_error")).toBe(false);
  });
});

describe("live activity", () => {
  test("planner activity fills plan.activity and planStep, then clears and logs one event", async () => {
    const { f, engine, plan } = setup();
    const seen: { step?: number; n: number }[] = [];
    f.plan = planned([tk("T1")]);
    f.queue("planner", async (run: any) => {
      for (const l of ["Read: a/b/C.java", "Grep: foo", "Bash: ls", "Read: d.ts", "Read: e.ts", "Read: f.ts", "Read: g.ts"]) { run.onActivity(l); seen.push({ step: plan("P-01").planStep, n: plan("P-01").activity!.length }); }
      return f.plan;
    });
    const id = engine.submit("do it");
    await until(() => plan(id).steps.plan === "you", "planned");
    expect(seen[0]).toEqual({ step: 1, n: 1 });
    expect(seen[6]!.n).toBe(7);
    expect(plan(id).activity).toBeUndefined();
    expect(plan(id).planStep).toBeUndefined();
    const evs = engine.events(id).filter((e) => e.event === "planner_activity");
    expect(evs.length).toBe(1);
    expect((evs[0]!.lines as any[]).map((l) => l.line)).toEqual(["Bash: ls", "Read: d.ts", "Read: e.ts", "Read: f.ts", "Read: g.ts"]);
  });

  test("plan.activity keeps the last 20 lines", async () => {
    const { f, engine, plan } = setup();
    f.plan = planned([tk("T1")]);
    let n = 0;
    f.queue("planner", async (run: any) => { for (let i = 0; i < 30; i++) run.onActivity(`Read: f${i}`); n = plan("P-01").activity!.length; return f.plan; });
    const id = engine.submit("x"); await until(() => plan(id).steps.plan === "you", "planned");
    expect(n).toBe(20);
  });

  test("a task run fills task.activity (last 10) and clears it afterwards", async () => {
    const { f, engine, plan, task, submitAndPlan, toMaster } = setup();
    f.plan = planned([tk("T1")]);
    const id = await submitAndPlan();
    let mid: string[] = [];
    f.queue("executor", async (run: any) => {
      for (let i = 0; i < 12; i++) run.onActivity(`Read: f${i}`);
      mid = task("T1").activity!.map((a) => a.line); f.touch(run.edits[0], task("T1").files);
      return { summary: "ok", did: "Did T1.", needs_files: [], tests_added: ["t"] };
    });
    engine.start(id);
    await toMaster();
    expect(mid.length).toBe(10);
    expect(mid[9]).toBe("Read: f11");
    expect(task("T1").activity).toBeUndefined();
  });
});

describe("refresh master PRs", () => {
  const toLive = async (s: ReturnType<typeof setup>, text = "work") => { const id = await s.submitAndPlan(text); s.engine.start(id); await s.toMaster(id); return id; };

  test("master moved before the merge: the PR is rebuilt on the new master, force-pushed, then merged", async () => {
    const s = setup(); const { f, engine, plan } = s;
    f.plan = planned([tk("T1")]);
    const id = await toLive(s);
    const pr = plan().masterPrs[0]!;
    expect(pr.base).toBe("base-api-master");
    f.remote.get("api/master")!.push("other-merge"); // somebody else merged to master
    const oldHead = pr.head;
    await engine.mergeMaster(id);
    await until(() => plan().steps.master === "done" || !!plan().error, "live");
    expect(plan().error).toBeUndefined();
    expect(pr.base).toBe("other-merge");
    expect(pr.head).not.toBe(oldHead);
    expect(f.prs.filter((p) => p.dest === "master").length).toBe(1); // the same PR, not a new one
    expect(f.calls.filter((c) => c === "worktree /stage/P-01/api-master prflow/p-01-my-plan-master origin/master").length).toBe(2);
    expect(f.calls.filter((c) => c === "push /stage/P-01/api-master prflow/p-01-my-plan-master").length).toBe(2);
    const refreshed = engine.events(id).find((e) => e.event === "master_refreshed")!;
    expect(refreshed.text as string).toContain("rebuilt on the new master");
    expect(f.calls.indexOf("merge-pr master #102")).toBeGreaterThan(f.calls.lastIndexOf("push /stage/P-01/api-master prflow/p-01-my-plan-master"));
    expect(plan().masterPrs[0]!.state).toBe("merged");
  });

  test("master did not move: no rebuild", async () => {
    const s = setup(); const { f, engine, plan, names } = s;
    f.plan = planned([tk("T1")]);
    const id = await toLive(s);
    await engine.mergeMaster(id);
    await until(() => plan().steps.master === "done", "live");
    expect(f.remoteHeadCalls).toBeGreaterThan(0);
    expect(names()).not.toContain("master_refreshed");
    expect(f.calls.filter((c) => c.startsWith("worktree /stage/P-01/api-master")).length).toBe(1);
  });

  test("a refresh that cannot port stops with an error and merges nothing", async () => {
    const s = setup(); const { f, engine, plan } = s;
    f.plan = planned([tk("T1")]);
    const id = await toLive(s);
    f.remote.get("api/master")!.push("other-merge");
    f.conflicts.cherry = true;
    await engine.mergeMaster(id);
    await until(() => !!plan().error, "error");
    expect(plan().error).toContain("refreshing the api master PR failed, so nothing was merged");
    expect(f.calls.some((c) => c === "merge-pr master #102")).toBe(false);
    expect(plan().masterPrs[0]!.state).toBe("open");
  });

  test("another plan merging refreshes the waiting plan's master PR (no merge)", async () => {
    const s = setup(); const { f, engine, plan, toMaster } = s;
    f.plan = (run) => planned([tk("T1", { files: [run.plan === "P-01" ? "src/A.ts" : "src/B.ts"] })], { title: run.plan === "P-01" ? "First" : "Second" });
    const a = engine.submit("first"), b = engine.submit("second");
    await until(() => plan(a).steps.plan === "you" && plan(b).steps.plan === "you", "both planned");
    engine.start(a); engine.start(b);
    await toMaster(a); await toMaster(b);
    const prB = plan(b).masterPrs[0]!, oldHead = prB.head;
    await engine.mergeMaster(a);
    await until(() => plan(a).steps.master === "done", "A live");
    await until(() => prB.base !== "base-api-master" && !engine.state().plans[b]!.now.startsWith("Master moved"), "B refreshed");
    expect(prB.base).toBe(f.remote.get("api/master")!.at(-1)!);
    expect(prB.head).not.toBe(oldHead);
    expect(prB.state).toBe("open");
    expect(plan(b).steps.master).toBe("you");
    expect(plan(b).error).toBeUndefined();
    expect(plan(b).now).toBe("1 master PR ready. Merge them in order.");
    expect(engine.events(b).map((e) => e.event)).toContain("master_refreshed");
    expect(f.calls.filter((c) => c.startsWith("merge-pr master")).length).toBe(1);
    // the merge now finds a fresh PR: no second rebuild
    await engine.mergeMaster(b);
    await until(() => plan(b).steps.master === "done", "B live");
    expect(engine.events(b).filter((e) => e.event === "master_refreshed").length).toBe(1);
  });

  test("a failed refresh after another plan's merge sets only that plan's error", async () => {
    const s = setup(); const { f, engine, plan, toMaster } = s;
    f.plan = (run) => planned([tk("T1", { files: [run.plan === "P-01" ? "src/A.ts" : "src/B.ts"] })]);
    const a = engine.submit("first"), b = engine.submit("second");
    await until(() => plan(a).steps.plan === "you" && plan(b).steps.plan === "you", "both planned");
    engine.start(a); engine.start(b);
    await toMaster(a); await toMaster(b);
    f.conflicts.cherry = true;
    await engine.mergeMaster(a);
    await until(() => !!plan(b).error, "B error");
    expect(plan(b).error).toContain("refreshing the api master PR failed");
    expect(plan(a).error).toBeUndefined();
    expect(plan(a).steps.master).toBe("done");
  });
});

describe("overlap warning", () => {
  test("a plan sharing a file with an earlier plan that is not live gets a warning; a plan that does not gets none", async () => {
    const { f, engine, plan, submitAndPlan } = setup();
    f.plan = (run) => planned([tk("T1", { files: run.plan === "P-03" ? ["src/Own.ts"] : ["src/Shared.java", `src/${run.plan}.ts`] })]);
    const a = await submitAndPlan("first", "P-01");
    expect(plan(a).overlaps).toBeUndefined();
    const b = engine.submit("second");
    await until(() => plan(b).steps.plan === "you", "P-02 planned");
    expect(plan(b).overlaps).toEqual([{ plan: "P-01", repo: "api", files: ["src/Shared.java"] }]);
    expect(plan(b).now).toContain("Shares 1 file with P-01 (api/src/Shared.java): run it after P-01, or expect its master PR to be refreshed after P-01 merges.");
    expect(engine.events(b).map((e) => e.event)).toContain("plan_overlap");
    const c = engine.submit("third");
    await until(() => plan(c).steps.plan === "you", "P-03 planned");
    expect(plan(c).overlaps).toBeUndefined();
    expect(f.count("planner")).toBe(3);
  });
});

describe("port plans", () => {
  const seed = (f: ReturnType<typeof makeFakes>["f"]) => { f.remote.set("api/uat", ["base-api-uat", "aaaa111", "bbbb222"]); f.commitFiles.set("aaaa111", ["src/X.ts"]); f.commitFiles.set("bbbb222", ["src/Y.ts"]); };
  const input = (o: object = {}) => ({ title: "Port the dispute fix", text: "Dispute fix, already tested on UAT", repos: [{ repo: "api", order: 1, why: "api first", commits: ["aaaa111", "bbbb222"] }], ...o });

  test("refuses bad input with a clear error and makes no plan", async () => {
    const { f, engine } = setup();
    seed(f);
    f.mergeCommits.add("bbbb222");
    const bad = async (o: object) => { try { await engine.port(input(o) as any); return "no error"; } catch (e: any) { return e.message as string; } };
    expect(await bad({ title: " " })).toContain("title");
    expect(await bad({ repos: [] })).toContain("at least one repo");
    expect(await bad({ repos: [{ repo: "nope", order: 1, commits: ["aaaa111"] }] })).toContain("not a repo");
    expect(await bad({ repos: [{ repo: "api", order: 1, commits: [] }] })).toContain("commit hashes");
    expect(await bad({ repos: [{ repo: "api", order: 1, commits: ["xyz"] }] })).toContain("commit hashes");
    expect(await bad({ repos: [{ repo: "api", order: 1, commits: ["cccc333"] }] })).toContain("not on origin/uat");
    expect(await bad({ repos: [{ repo: "api", order: 1, commits: ["aaaa111", "bbbb222"] }] })).toContain("merge commit");
    expect(await bad({ db_changes: [{ database: "", sql: "x" }] })).toContain("database and sql");
    expect(Object.keys(engine.state().plans)).toEqual([]);
    expect(engine.state().seq).toBe(0);
  });

  test("a port plan skips tasks, staging and the test, and waits at master: you", async () => {
    const { f, engine, plan, toMaster } = setup();
    seed(f);
    const id = await engine.port(input({ ticket: "BOM-1", db_changes: [{ database: "main", sql: "ALTER TABLE t ADD c int", why: "new column" }] }) as any);
    expect(plan(id).kind).toBe("port");
    expect(plan(id).tasks).toEqual([]);
    expect(plan(id).repos[0]!.stagingCommits).toEqual(["aaaa111", "bbbb222"]);
    await toMaster(id);
    expect(plan(id).error).toBeUndefined();
    expect(plan(id).steps).toEqual({ plan: "done", tasks: "done", staging: "done", uat: "done", master: "you" });
    expect(plan(id).dbChanges![0]!.database).toBe("main");
    expect(f.count("planner") + f.count("executor") + f.count("tester" as any)).toBe(0);
    expect(f.testInputs.length).toBe(0);
    expect(f.prs.length).toBe(1);
    expect(f.prs[0]!.dest).toBe("master");
    expect(f.prs[0]!.title).toBe("[BOM-1 · P-01] Port the dispute fix");
    expect(f.prs[0]!.body).toContain("Dispute fix, already tested on UAT");
    expect(f.calls.some((c) => c.startsWith("cherry-pick /stage/P-01/api-master aaaa111"))).toBe(true);
    expect(() => engine.start(id)).toThrow();
    expect(() => engine.edit(id, "other")).toThrow("port plan");
  });

  test("one final review covers every repo once; a blocked repo gets one fix and Retry does not review again", async () => {
    const s = setup(); const { f, engine, plan, toMaster } = s;
    seed(f); f.remote.set("web/uat", ["base-web-uat", "cccc333"]); f.commitFiles.set("cccc333", ["web/A.ts"]);
    (s.ports as any).repos = () => ["api", "web"].map((name) => ({ name }));
    s.ports.git.showCommit = async (_d, c) => ({ text: `${c}\nport ${c}\n+line ${c}`, files: f.commitFiles.get(c) ?? [] });
    s.ports.git.diffRange = async (_d, from, to, files) => `diff ${from}..${to} ${files.join(",")}`;
    f.queue("code-reviewer", { findings: [{ repo: "web", severity: "blocking", category: "correctness", text: "A.ts misses the dispute call", file: "web/A.ts" }] });
    f.queue("executor", (run: any) => { f.touch(run.edits[0], ["web/A.ts"]); return { summary: "added it", did: "added it", needs_files: [], tests_added: [] }; });
    const id = await engine.port(input({ repos: [{ repo: "api", order: 1, commits: ["aaaa111", "bbbb222"] }, { repo: "web", order: 2, commits: ["cccc333"] }] }) as any);
    await toMaster(id);
    expect(plan(id).error).toBeUndefined();
    const reviews = f.runs.filter((r) => r.role === "code-reviewer");
    expect(reviews.length).toBe(1);
    expect(reviews[0]!.prompt).toContain("diff_api"); expect(reviews[0]!.prompt).toContain("diff_web");
    const web = plan(id).masterPrs.find((r) => r.repo === "web")!;
    expect(f.calls.some((c) => c.startsWith("commit /stage/P-01/web-master"))).toBe(true);
    expect(sameHead(await s.ports.prs.head("web", web.id), web.head)).toBe(true);
    expect(engine.events(id).map((e) => e.event)).toEqual(expect.arrayContaining(["final_port_review", "final_port_fix"]));
    expect(plan(id).finalReview?.blocking).toBe(1);
    engine.retry(id);
    await until(() => plan(id).steps.master === "you", "master again");
    expect(f.runs.filter((r) => r.role === "code-reviewer").length).toBe(1);
  });

  test("merging a port plan refreshes first when master moved, then goes live", async () => {
    const { f, engine, plan, toMaster } = setup();
    seed(f);
    const id = await engine.port(input() as any);
    await toMaster(id);
    f.remote.get("api/master")!.push("other-merge");
    await engine.mergeMaster(id);
    await until(() => plan(id).steps.master === "done" || !!plan(id).error, "live");
    expect(plan(id).error).toBeUndefined();
    expect(plan(id).masterPrs[0]!.base).toBe("other-merge");
    expect(engine.events(id).map((e) => e.event)).toContain("master_refreshed");
  });
});

describe("pin in-house library SNAPSHOTs before merging master", () => {
  const dep = (id: string, v: string) => `    <dependency>\n      <groupId>com.bsc</groupId>\n      <artifactId>${id}</artifactId>\n      <version>${v}</version>\n    </dependency>`;
  const pom = (...deps: string[]) => `<project>\n  <version>3.0.0</version>\n  <dependencies>\n${deps.join("\n")}\n  </dependencies>\n</project>\n`;
  const withLib = (poms: Record<string, Record<string, string>>, libPlan = false) => {
    const s = setup(); const { f } = s;
    f.libNames = ["common-contracts"]; f.poms = poms;
    f.plan = libPlan
      ? planned([tk("T1", { repo: "common-contracts" }), tk("T2", { repo: "api" })], { repo_order: [{ repo: "common-contracts", why: "library first" }, { repo: "api", why: "uses it" }] })
      : planned([tk("T1", { repo: "api" })]);
    (s.ports as any).repos = () => ["api", "common-contracts"].map((name) => ({ name }));
    return s;
  };
  const toLive = async (s: ReturnType<typeof setup>) => { const id = await s.submitAndPlan(); s.engine.start(id); await s.toMaster(id); return id; };
  const finish = (s: ReturnType<typeof setup>, id: string) => until(() => s.plan(id).steps.master === "done" || !!s.plan(id).error, "merge done");

  test("released: the version line is pinned, rebuilt, force-pushed, then merged", async () => {
    const s = withLib({ api: { "pom.xml": pom(dep("common-contracts", "1.0.0.280-SNAPSHOT"), dep("other", "2.0-SNAPSHOT")) } });
    const { f, engine, plan, names } = s;
    f.released = (lib, v) => lib === "common-contracts" && v === "1.0.0.280";
    const id = await toLive(s);
    const pr = plan().masterPrs[0]!, oldHead = pr.head;
    const pushes = f.calls.filter((c) => c.startsWith("push /stage/P-01/api-master")).length, builds = f.calls.filter((c) => c.startsWith("build /stage/P-01/api-master")).length;
    await engine.mergeMaster(id);
    await finish(s, id);
    expect(plan().error).toBeUndefined();
    const edited = f.written.get("/stage/P-01/api-master")?.["pom.xml"] ?? f.poms.api!["pom.xml"]!;
    expect(f.calls).toContain("write /stage/P-01/api-master pom.xml");
    expect(names()).toContain("master_pinned");
    expect(pr.head).not.toBe(oldHead);
    expect(f.calls.filter((c) => c.startsWith("push /stage/P-01/api-master")).length).toBe(pushes + 1);
    expect(f.calls.filter((c) => c.startsWith("build /stage/P-01/api-master")).length).toBe(builds + 2); // rebuild, then build after the pin
    expect(f.calls.indexOf("merge-pr master #102")).toBeGreaterThan(f.calls.lastIndexOf("write /stage/P-01/api-master pom.xml")); // staging PR is #101
    expect(edited).toBeDefined();
    expect(f.prs.filter((x) => x.dest === "master").length).toBe(1);
  });

  test("pin edits only that dependency's version line", async () => {
    const { pinVersions, onlyVersionLines, findSnapshots } = await import("../core/libs.ts");
    const xml = pom(dep("common-contracts", "1.0.0.280-SNAPSHOT"), dep("other-lib", "1.0.0.280-SNAPSHOT"), dep("common-contracts-x", "1.0.0.280-SNAPSHOT")) + "<!-- " + dep("common-contracts", "1.0.0.280-SNAPSHOT") + " -->";
    const pins = [{ lib: "common-contracts", version: "1.0.0.280" }];
    const out = pinVersions(xml, pins);
    expect(out.split("\n").filter((l, i) => l !== xml.split("\n")[i]).length).toBe(1);
    expect(out).toContain("<artifactId>common-contracts</artifactId>\n      <version>1.0.0.280</version>");
    expect(out).toContain("<artifactId>other-lib</artifactId>\n      <version>1.0.0.280-SNAPSHOT</version>");
    expect(onlyVersionLines(xml, out, pins)).toBe(true);
    expect(onlyVersionLines(xml, out.replace("<version>3.0.0", "<version>3.0.1"), pins)).toBe(false);
    expect(findSnapshots(xml, ["common-contracts"])).toEqual(pins);
  });

  test("a library PR in the same merge: the SNAPSHOT is pinned before the run without a local build, then one run merges both", async () => {
    const s = withLib({ api: { "pom.xml": pom(dep("common-contracts", "1.0.0.280-SNAPSHOT")), "svc/pom.xml": pom(dep("common-contracts", "1.0.0.280-SNAPSHOT")) } }, true);
    const { f, engine, plan } = s;
    const id = await toLive(s);
    const builds = f.calls.filter((c) => c.startsWith("build /stage/P-01/api-master")).length;
    await engine.mergeMaster(id);
    await finish(s, id);
    expect(plan().error).toBeUndefined();
    const pin = engine.events(id).find((e) => e.event === "master_pinned")!;
    expect(pin.built).toBe(false);
    expect(f.calls.filter((c) => c.startsWith("build /stage/P-01/api-master")).length).toBe(builds + 1); // the rebuild only, not after the pin
    expect(f.calls.filter((c) => c.startsWith("write /stage/P-01/api-master")).length).toBe(2); // root and module pom
    const start = f.calls.indexOf("release-start master common-contracts#103,api#104");
    expect(start).toBeGreaterThan(f.calls.lastIndexOf("write /stage/P-01/api-master pom.xml"));
    expect(f.calls.indexOf("merge-pr master #104")).toBeGreaterThan(f.calls.indexOf("merge-pr master #103"));
    expect(f.sleeps).not.toContain(30_000); // no engine wait for the release: the runner waits for the tag
    expect(plan().masterPrs.every((p) => p.state === "merged" && p.deployed)).toBe(true);
  });

  test("a plain release version that is not released yet also stops the merge; a released one merges", async () => {
    const s = withLib({ api: { "pom.xml": pom(dep("common-contracts", "1.0.0.280")) } });
    const { f, engine, plan } = s;
    const id = await toLive(s);
    await engine.mergeMaster(id);
    await until(() => !!plan().error, "error");
    expect(plan().error).toContain("api PR #102 depends on common-contracts 1.0.0.280, which is not released. Merge and release common-contracts 1.0.0.280 first.");
    expect(f.calls.some((c) => c.startsWith("merge-pr master"))).toBe(false);
    f.released = (lib, v) => lib === "common-contracts" && v === "1.0.0.280";
    engine.retry(id);
    await until(() => plan().steps.master === "you" && !plan().error, "ready again");
    await engine.mergeMaster(id);
    await finish(s, id);
    expect(plan().error).toBeUndefined();
    expect(f.calls).not.toContain("write /stage/P-01/api-master pom.xml"); // nothing to pin
  });

  test("not released and not in this merge: stops before merging with the reason", async () => {
    const s = withLib({ api: { "pom.xml": pom(dep("common-contracts", "1.0.0.280-SNAPSHOT")) } });
    const { f, engine, plan } = s;
    const id = await toLive(s);
    await engine.mergeMaster(id);
    await until(() => !!plan().error, "error");
    expect(plan().error).toContain("api PR #102 depends on common-contracts 1.0.0.280-SNAPSHOT, which is not released. Merge and release common-contracts 1.0.0.280 first.");
    expect(f.calls.some((c) => c.startsWith("merge-pr master"))).toBe(false);
    expect(plan().masterPrs[0]!.state).toBe("open");
    expect(f.sleeps).not.toContain(30_000);
  });

  test("no SNAPSHOT of an in-house library: nothing is pinned or rebuilt", async () => {
    const s = withLib({ api: { "pom.xml": pom(dep("common-contracts", "1.0.0.279"), dep("third-party", "1.0-SNAPSHOT")) } });
    const { f, engine, plan, names } = s;
    f.released = () => true;
    const id = await toLive(s);
    const before = f.calls.length;
    await engine.mergeMaster(id);
    await finish(s, id);
    expect(plan().error).toBeUndefined();
    expect(names()).not.toContain("master_pinned");
    expect(f.calls.slice(before).filter((c) => c.startsWith("write") || c.startsWith("push") || c.startsWith("build"))).toEqual([]);
    expect(f.releasedCalls).toEqual(["common-contracts 1.0.0.279"]); // a plain version is checked, never pinned
  });
});
