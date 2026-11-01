import { describe, expect, test } from "bun:test";
import { createEngine } from "../core/engine.ts";
import { allMinors, blockingStates, openMinors } from "../core/minors.ts";
import { mkPlan, mkTask } from "./fixtures.ts";
import { blocking, makeFakes, minor, planned, review, tk, until } from "./fakes.ts";

const isSweep = (r: any) => String(r.prompt).includes("This is the last review");
const verdicts = (...items: { n: number; still: boolean; harmful?: boolean; level?: string }[]) => ({ items: items.map((i) => ({ ...i, why: "checked" })) });

function setup(cfg: Record<string, unknown> = {}) {
  const { ports, f } = makeFakes();
  const engine = createEngine(ports, cfg);
  f.engine = engine;
  const plan = () => engine.state().plans["P-01"]!;
  const task = (l: string) => engine.state().tasks[`P-01/${l}`]!;
  const run = async () => {
    const id = engine.submit("do the work");
    await until(() => plan().steps.plan === "you", "planned");
    engine.start(id);
    await until(() => plan().steps.master === "you" || !!plan().landedAt || !!plan().error, "finished");
  };
  return { f, engine, plan, task, run };
}

describe("minor findings are never lost", () => {
  test("every round's minors are kept, all categories, the same text once", async () => {
    const { f, engine, plan, run } = setup();
    f.plan = planned([tk("T1")]);
    f.queue("code-reviewer", review(blocking("Wrong total"), minor("Rename x"), minor("A hung call blocks the job", "correctness")), review(minor("rename  X")), (r: any) => (isSweep(r) ? verdicts() : review()));
    await run();
    expect(allMinors(engine.state(), plan()).map((m) => [m.finding.text, m.round])).toEqual([["rename  X", 2], ["A hung call blocks the job", 1]]);
  });

  test("the last review sends only harmful ones back, hides gone ones, and leaves minor and trivial ones to you", async () => {
    const { f, engine, plan, task, run } = setup({ reviewerResume: false });
    f.plan = planned([tk("T1"), tk("T2")]);
    const rv = (r: any) => isSweep(r) ? verdicts({ n: 1, still: true, level: "harmful" }, { n: 2, still: false, level: "trivial" }, { n: 3, still: true, level: "minor" })
      : review(...(r.task === "P-01/T1" ? [minor("Each run reads every row", "other"), minor("Unused import", "cleanup")] : [minor("Odd name", "naming")]));
    f.queue("code-reviewer", rv, rv, rv, (r: any) => (isSweep(r) ? verdicts() : review()), (r: any) => (isSweep(r) ? verdicts() : review()));
    await run();
    const back = task("T1").rounds.find((r) => r.source === "sweep")!;
    expect(back.blocking[0]!.text).toContain("Each run reads every row");
    expect(engine.events("P-01").some((e) => e.event === "minor_sweep" && /1 harmful \(sent back\), 1 minor, 0 trivial, 1 gone/.test(e.text))).toBe(true);
    expect(plan().steps.master).toBe("you");
    expect(openMinors(engine.state(), plan()).map((m) => m.finding.text)).toEqual(["Odd name"]);
  });

  test("accept records your call; at the master PRs send back is refused", async () => {
    const { f, engine, plan, run } = setup();
    f.plan = planned([tk("T1")]);
    f.queue("code-reviewer", review(minor("Wrong total", "correctness")), (r: any) => (isSweep(r) ? verdicts({ n: 1, still: true, harmful: false }) : review()));
    await run();
    const [m] = openMinors(engine.state(), plan());
    expect(() => engine.decideMinor("P-01", m!.key, "send")).toThrow("past its tasks");
    engine.decideMinor("P-01", m!.key, "accept");
    expect(openMinors(engine.state(), plan())[0]!.decided).toBe("accepted");
    expect(() => engine.decideMinor("P-01", "P-01/T1#9#0", "accept")).toThrow("no longer open");
  });

  test("send back on a target plan reruns the task with the finding as blocking", async () => {
    const { f, engine, plan, task, run } = setup();
    f.plan = planned([tk("T1")], { target_branch: "feat/x" });
    f.queue("code-reviewer", review(minor("Loses an event", "data")), (r: any) => (isSweep(r) ? verdicts({ n: 1, still: true, harmful: false }) : review()));
    await run();
    const [m] = openMinors(engine.state(), plan());
    engine.decideMinor("P-01", m!.key, "send");
    expect(plan().minorCalls?.[m!.key]).toBe("sent");
    await until(() => task("T1").rounds.some((r) => r.source === "edit"), "sent back");
    expect(task("T1").rounds.find((r) => r.source === "edit")!.blocking[0]!.text).toContain("Loses an event");
  });
});

describe("the central findings list", () => {
  test("every finding of every review is listed; blocking ones show fixed once passed, gone minors stay as fixed", async () => {
    const { f, engine, plan, run } = setup({ reviewerResume: false });
    f.plan = planned([tk("T1")]);
    f.queue("code-reviewer", review(blocking("Wrong total"), minor("Each run reads every row", "other"), minor("Old name", "naming")), review(),
      (r: any) => (isSweep(r) ? verdicts({ n: 1, still: false, harmful: false }, { n: 2, still: true, harmful: false }) : review()));
    await run();
    const { ledger } = await import("../core/minors.ts");
    const rows = ledger(engine.state()).filter((r) => r.plan === "P-01");
    expect(rows.find((r) => r.short.includes("Wrong total"))!.status).toBe("fixed");
    expect(rows.find((r) => r.text.includes("Each run reads every row"))!.status).toBe("fixed");
    expect(rows.find((r) => r.text.includes("Old name"))!.status).toBe("minor"); // still there, not harmful: the last review's level
    expect(plan().minorSweep!.verdicts).toBeTruthy();
  });
});

describe("the last review checks only the plan's own minor findings", () => {
  test("earlier plans' open minors are never swept again by a later plan", async () => {
    const { carriedMinors } = await import("../core/minors.ts");
    const { mkState } = await import("./fixtures.ts");
    const t = mkTask({ planId: "P-01", label: "T1", status: "done", rounds: [{ n: 1, at: 0, source: "review", by: ["code-reviewer"], blocking: [], minor: [{ severity: "minor", category: "naming", text: "Old name" }] } as any] });
    const repos = [{ repo: "api", base: "stage", branch: "prflow/x", dir: "/tmp/x", order: 1, why: "", stagingCommits: [] }] as any;
    const s = mkState([mkPlan({ id: "P-01", order: 1, repos }), mkPlan({ id: "P-02", order: 2, repos }), mkPlan({ id: "P-03", order: 3, repos, kind: "promote", promotes: "feat/x" } as any)], [t]);
    expect(carriedMinors(s, s.plans["P-02"]!)).toEqual([]);
    expect(carriedMinors(s, s.plans["P-03"]!)).toEqual([]);
  });
});

describe("each blocking finding says what happened to it", () => {
  const F = (text: string, o: any = {}) => ({ severity: "blocking", category: "bug", text, ...o });
  const R = (n: number, b: any[], o: any = {}) => ({ n, at: n, source: "review", by: ["code-reviewer"], blocking: b, minor: [], ...o });
  test("fixed, partly fixed, not fixed, being fixed and sent to the planner with the tasks it changed", () => {
    const p = mkPlan({ versions: [{ n: 1, at: 0, text: "a", changes: [] }, { n: 2, at: 1, text: "b", changes: [], fixes: ["Retry ships twice"], fixTasks: ["T23", "T24"] }] });
    const t = mkTask({ status: "done", rounds: [
      R(1, [F("Timeout is a failure")], { fixed: ["Timeout now re-reads"] }),
      R(2, [F("Same for two units", { repeat_of_rounds: [1] }), F("Needs a real DB", {})], { fixed: ["done", "Not fixed, needs a design decision: no DB here"] }),
      R(3, [F("(Sent to the planner, not this writer) Design decision needed: x", { fix_in: "plan", short: "Retry ships twice" })]),
    ] as any });
    const s = blockingStates(p, t);
    expect(s[0]![0]!.status).toBe("partly fixed");
    expect(s[0]![0]!.note).toContain("round 2");
    expect(s[1]![0]!.status).toBe("fixed");
    expect(s[1]![1]!.status).toBe("not fixed");
    expect(s[2]![0]).toEqual({ status: "sent to planner", note: "Plan version 2 changed T23, T24 for it" });
    const running = blockingStates(p, mkTask({ status: "review", rounds: [R(1, [F("A")])] as any }));
    expect(running[0]![0]!.status).toBe("being fixed");
  });
});
