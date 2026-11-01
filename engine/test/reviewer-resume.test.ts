import { describe, expect, test } from "bun:test";
import { createEngine } from "../core/engine.ts";
import { blocking, makeFakes, planned, review, tk, until } from "./fakes.ts";

function setup(cfg = {}) {
  const { ports, f } = makeFakes();
  const engine = createEngine(ports, cfg);
  f.engine = engine;
  const plan = () => engine.state().plans["P-01"]!;
  const task = (l: string) => engine.state().tasks[`P-01/${l}`]!;
  const go = async () => {
    f.plan = planned([tk("T1")]);
    const id = engine.submit("the original spec");
    await until(() => plan().steps.plan === "you", "planned");
    engine.start(id);
    await until(() => task("T1").status === "done" || !!plan().error, "done");
  };
  const reviewers = () => f.runsOf("code-reviewer").map((r) => ({ fresh: !!r.sessionId, resume: !!r.resumeId, id: (r.sessionId ?? r.resumeId) as string, prompt: String(r.prompt) }));
  return { f, engine, plan, task, go, reviewers };
}

describe("one code-reviewer session per task, a fresh sign-off at the end", () => {
  test("round 2 resumes round 1's session with the follow-up prompt; the clean resumed round gets exactly one fresh sign-off", async () => {
    const { f, go, task, reviewers, engine } = setup();
    f.queue("code-reviewer", review(blocking("Wrong total")), review(), review());
    await go();
    const r = reviewers();
    expect(r.length).toBe(3);
    expect(r[0]!.fresh).toBe(true);
    expect(r[1]!.resume).toBe(true);
    expect(r[1]!.id).toBe(r[0]!.id);
    expect(r[1]!.prompt).toContain("You reviewed this task earlier in this session");
    expect(f.runsOf("code-reviewer").map((x: any) => x.model)).toEqual(["opus", "sonnet", "opus"]); // resumed round on Sonnet; round 1 and the sign-off on Opus
    expect(r[1]!.prompt).toContain("Wrong total");
    expect(r[2]!.fresh).toBe(true);
    expect(r[2]!.id).not.toBe(r[0]!.id);
    expect(r[2]!.prompt).toContain("Wrong total"); // the whole change and the earlier rounds, as a fresh review always gets
    expect(task("T1").reviewSessionId).toBe(r[0]!.id);
    expect(task("T1").rounds.map((x) => x.reviewer)).toEqual(["fresh", "resumed", "signoff"]);
    const starts = engine.events("P-01").filter((e) => e.event === "review_start").map((e: any) => e.text);
    expect(starts[1]).toContain("(resumed)");
    expect(starts[2]).toContain("final sign-off");
  });

  test("a sign-off blocker goes to the executor; the next round resumes the ORIGINAL reviewer, then a second fresh sign-off", async () => {
    const { f, go, task, reviewers } = setup();
    f.queue("code-reviewer", review(blocking("Wrong total")), review(), review(blocking("Null crash on empty list")), review(), review());
    await go();
    const r = reviewers();
    expect(r.map((x) => (x.fresh ? "fresh" : "resume"))).toEqual(["fresh", "resume", "fresh", "resume", "fresh"]);
    expect(r[3]!.id).toBe(r[0]!.id); // the original session, not the sign-off's
    expect(r[3]!.prompt).toContain("Null crash on empty list");
    expect(r[3]!.prompt).toContain("found by the final sign-off");
    expect(r[4]!.id).not.toBe(r[2]!.id);
    expect(f.count("executor")).toBeGreaterThanOrEqual(3);
    expect(task("T1").reviewSessionId).toBe(r[0]!.id);
    expect(task("T1").rounds.map((x) => x.reviewer)).toEqual(["fresh", "resumed", "signoff", "resumed", "signoff"]);
  });

  test("a failed resume falls back to a fresh review with the full context and stores the new session", async () => {
    const { f, go, task, reviewers, engine } = setup();
    f.queue("code-reviewer", review(blocking("Wrong total")), { __error: "no such session" }, review());
    await go();
    const r = reviewers();
    expect(r.map((x) => (x.fresh ? "fresh" : "resume"))).toEqual(["fresh", "resume", "fresh"]);
    expect(r[2]!.id).not.toBe(r[0]!.id);
    expect(r[2]!.prompt).toContain("Wrong total");
    expect(engine.events("P-01").some((e) => e.event === "review_resume_failed")).toBe(true);
    expect(task("T1").reviewSessionId).toBe(r[2]!.id);
    expect(task("T1").rounds.at(-1)!.reviewer).toBe("fresh"); // a fresh clean verdict ends the review, no extra sign-off
    expect(r.length).toBe(3);
  });

  test("the flag off: a fresh reviewer every round and no sign-off", async () => {
    const { f, go, reviewers } = setup({ reviewerResume: false });
    f.queue("code-reviewer", review(blocking("Wrong total")), review());
    await go();
    const r = reviewers();
    expect(r.length).toBe(2);
    expect(r.every((x) => x.fresh && !x.resume)).toBe(true);
    expect(r[1]!.id).not.toBe(r[0]!.id);
    expect(r[1]!.prompt).toContain("This is a later round, so it checks the fixes");
  });

  test("a task clean in round 1 runs no extra final review", async () => {
    const { f, go, reviewers, task } = setup();
    f.queue("code-reviewer", review());
    await go();
    expect(reviewers().length).toBe(1);
    expect(task("T1").rounds.length).toBe(1);
  });
});
