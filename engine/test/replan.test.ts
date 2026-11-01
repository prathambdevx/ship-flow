import { describe, expect, test } from "bun:test";
import { createEngine } from "../core/engine.ts";
import { makeFakes, planned, tk, until } from "./fakes.ts";

function setup() {
  const { ports, f } = makeFakes();
  const engine = createEngine(ports, {});
  f.engine = engine;
  const plan = () => engine.state().plans["P-01"]!;
  const task = (l: string) => engine.state().tasks[`P-01/${l}`]!;
  const planOnly = async () => { const id = engine.submit("do the work"); await until(() => plan().steps.plan === "you", "planned"); return id; };
  // A started plan whose tasks are still writing (held executors), so it can be re-planned.
  const started = async (tasks = [tk("T1"), tk("T2")]) => {
    f.plan = planned(tasks, { contract: "C" });
    const id = await planOnly();
    const hold = deferred();
    const held = async (run: any) => { await hold.p; f.touch(run.edits[0], ["src/x.ts"]); return { summary: "ok", did: "Did.", needs_files: [], tests_added: ["t"] }; };
    f.queue("executor", ...tasks.map(() => held));
    engine.start(id);
    await until(() => f.count("executor") === tasks.length, "writing");
    return { id, hold };
  };
  const names = () => engine.events("P-01").map((e) => e.event);
  return { f, engine, plan, task, planOnly, started, names };
}
const deferred = () => { let go!: () => void; const p = new Promise<void>((r) => { go = r; }); return { p, go }; };
const keep = (l: string, o: object = {}) => tk(l, { action: "keep", ...o });
const three = (o: Record<string, object> = {}) => [tk("T1", o.T1), tk("T2", o.T2), tk("T3", o.T3)];

describe("A: the architect split review on a re-plan", () => {
  test("a small re-plan skips it and logs why; a first plan keeps it", async () => {
    const { f, engine, plan, planOnly, names } = setup();
    f.plan = planned(three(), { contract: "C" });
    const id = await planOnly();
    expect(f.count("architect-reviewer")).toBe(1);
    f.plan = planned(three({ T1: { files: ["src/other.ts"] } }), { contract: "C" });
    engine.edit(id, "v2");
    await until(() => plan().versions.length === 2 && plan().steps.plan === "you", "re-planned");
    expect(f.count("architect-reviewer")).toBe(1);
    const ev = engine.events("P-01").filter((e) => e.event === "architect_skipped").at(-1)!;
    expect(String(ev.text)).toContain("no task added or removed, contract unchanged, 1 existing task(s) changed");
    expect(names()).toContain("architect_skipped");
  });

  test("an added task, a removed task, a new contract or more than 2 changed tasks runs it", async () => {
    const { f, engine, plan, planOnly } = setup();
    f.plan = planned(three(), { contract: "C" });
    const id = await planOnly();
    const replan = async (p: ReturnType<typeof planned>, n: number) => { f.plan = p; engine.edit(id, `v${n}`); await until(() => plan().versions.length === n && plan().steps.plan === "you", `v${n}`); };
    await replan(planned([...three(), tk("T4")], { contract: "C" }), 2);
    expect(f.count("architect-reviewer")).toBe(2); // added
    await replan(planned(three(), { contract: "C" }), 3);
    expect(f.count("architect-reviewer")).toBe(3); // removed
    await replan(planned(three(), { contract: "C2" }), 4);
    expect(f.count("architect-reviewer")).toBe(4); // contract
    await replan(planned(three({ T1: { files: ["a.ts"] }, T2: { files: ["b.ts"] }, T3: { files: ["c.ts"] } }), { contract: "C2" }), 5);
    expect(f.count("architect-reviewer")).toBe(5); // 3 changed
    await replan(planned(three({ T1: { files: ["a.ts"] }, T2: { files: ["b.ts"] }, T3: { files: ["d.ts"] } }), { contract: "C2" }), 6);
    expect(f.count("architect-reviewer")).toBe(5); // 1 changed: skipped
  });
});

describe("B: hold only the tasks a fix changes", () => {
  test("an explicit list holds only those tasks; the others run on", async () => {
    const { f, engine, plan, task, started } = setup();
    const { id, hold } = await started();
    const gate = deferred();
    f.queue("planner", async () => { await gate.p; return planned([keep("T1", { action: "update", note: "use X" }), keep("T2")], { contract: "C" }); });
    engine.queueEdit(id, "T1 must use X (T2 is only mentioned)", ["T1"]);
    await until(() => plan().steps.plan === "run", "re-planning");
    expect(task("T1").heldForPlan).toBe(true);
    expect(task("T2").heldForPlan).toBeUndefined();
    expect(engine.events(id).filter((e) => e.event === "task_held").map((e) => e.task)).toEqual(["P-01/T1"]);
    gate.go();
    await until(() => plan().versions.length === 2 && plan().steps.plan === "done", "applied");
    expect(task("T1").heldForPlan).toBeUndefined();
    hold.go();
  });

  test("with no list, the tasks the text names are held as before", async () => {
    const { f, engine, plan, task, started } = setup();
    const { id, hold } = await started();
    const gate = deferred();
    f.queue("planner", async () => { await gate.p; return planned([keep("T1"), keep("T2")], { contract: "C" }); });
    engine.queueEdit(id, "T1 and T2 need a change");
    await until(() => plan().steps.plan === "run", "re-planning");
    expect(task("T1").heldForPlan && task("T2").heldForPlan).toBe(true);
    gate.go(); hold.go();
    await until(() => plan().steps.plan === "done", "applied");
  });

  test("a task is released when its own update lands, while a later note for another task is still queued", async () => {
    const { f, engine, plan, task, started } = setup();
    const { id, hold } = await started();
    const g1 = deferred(), g2 = deferred();
    f.queue("planner", async () => { await g1.p; return planned([keep("T1", { action: "update", note: "n" }), keep("T2")], { contract: "C" }); }, async () => { await g2.p; return planned([keep("T1"), keep("T2", { action: "update", note: "m" })], { contract: "C" }); });
    engine.queueEdit(id, "fix for T1", ["T1"]);
    await until(() => plan().steps.plan === "run", "re-plan 1");
    engine.queueEdit(id, "later fix for T2, T1 is only mentioned", ["T2"]);
    expect(task("T2").heldForPlan).toBe(true);
    g1.go();
    await until(() => plan().versions.length === 3 && f.count("planner") === 3, "re-plan 2 started");
    expect(task("T1").heldForPlan).toBeUndefined();
    expect(task("T2").heldForPlan).toBe(true);
    g2.go(); hold.go();
    await until(() => plan().versions.length === 3 && plan().steps.plan === "done", "re-plan 2 applied");
    expect(task("T2").heldForPlan).toBeUndefined();
  });
});

describe("C: one re-plan takes every queued fix", () => {
  test("fixes queued during a re-plan go into one planner run", async () => {
    const { f, engine, plan, started } = setup();
    const { id, hold } = await started();
    const gate = deferred();
    f.plan = planned([keep("T1"), keep("T2")], { contract: "C" });
    f.queue("planner", async () => { await gate.p; return planned([keep("T1"), keep("T2")], { contract: "C" }); });
    engine.queueEdit(id, "fix A", ["T1"]);
    await until(() => plan().steps.plan === "run", "re-planning");
    engine.queueEdit(id, "fix B", ["T1"]);
    engine.queueEdit(id, "fix C", ["T2"]);
    expect(plan().planFixes).toEqual(["fix B", "fix C"]);
    gate.go();
    await until(() => plan().versions.length === 3 && plan().steps.plan === "done", "both applied");
    expect(f.count("planner")).toBe(3); // first plan, fix A, then B and C together
    const last = f.runsOf("planner").at(-1)!.prompt;
    expect(last).toContain("- fix B");
    expect(last).toContain("- fix C");
    expect(plan().versions.at(-1)!.fixes).toEqual(["fix B", "fix C"]);
    hold.go();
  });

  test("a free plan takes an API edit together with the fixes already queued", async () => {
    const { f, engine, plan, started } = setup();
    const { id, hold } = await started();
    plan().planFixes = ["queued fix"]; // queued, not yet ticked
    f.plan = planned([keep("T1"), keep("T2")], { contract: "C" });
    expect(engine.editOrQueue(id, "api note", ["T2"])).toBe("applied");
    await until(() => plan().versions.length === 2 && plan().steps.plan === "done", "applied");
    expect(plan().versions.at(-1)!.fixes).toEqual(["queued fix", "api note"]);
    expect(f.count("planner")).toBe(2);
    hold.go();
  });
});
