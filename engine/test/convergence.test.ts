import { describe, expect, test } from "bun:test";
import { createEngine } from "../core/engine.ts";
import { blocking, makeFakes, planned, review, tk, until } from "./fakes.ts";

function setup(cfg = {}) {
  const { ports, f } = makeFakes();
  const engine = createEngine(ports, cfg);
  f.engine = engine;
  const plan = () => engine.state().plans["P-01"]!;
  const task = (l: string) => engine.state().tasks[`P-01/${l}`]!;
  const planned_ = async () => { const id = engine.submit("the original spec, long and detailed"); await until(() => plan().steps.plan === "you", "planned"); return id; };
  return { f, engine, plan, task, planned_ };
}
// A reviewer that never stops finding a new problem.
const endless = (r: any, n: number) => (String(r.prompt).includes("This is the last review") ? { items: [] } : review(blocking(`New edge case ${n}`)));

describe("a task that does not converge stops at the total round cap", () => {
  test("the total round cap counts across retries; the watchdog's retry or yours gives it a fresh count", async () => {
    const { f, engine, plan, task, planned_ } = setup({ maxReviewRounds: 2, maxTotalRounds: 4 });
    f.plan = planned([tk("T1")]);
    for (let i = 0; i < 12; i++) f.queue("code-reviewer", endless);
    engine.start(await planned_());
    await until(() => task("T1").status === "failed", "first stop at 2 rounds");
    expect(task("T1").needsYou).toBeFalsy();
    engine.retry("P-01", "The watchdog retried it: fixed");
    await until(() => task("T1").status === "failed" && !!task("T1").needsYou, "cap at 4 rounds");
    expect(task("T1").error).toContain("Stopped after 4 review rounds in total");
    const before = task("T1").rounds.length;
    engine.retry("P-01", "The watchdog retried it: again"); // the watchdog carries it on too (Pratham, 01/11/2026)
    expect(task("T1").status).not.toBe("failed");
    expect(task("T1").roundBase).toBe(before);
    expect(plan().error).toBeUndefined();
  });
});

describe("a finding in the plan itself goes to the planner, not the writer", () => {
  test("fix_in plan leaves the task's blocking set and is added to the plan text once", async () => {
    const { f, engine, plan, task, planned_ } = setup();
    f.plan = planned([tk("T1")]);
    const dataFinding = { ...blocking("The new store row has no contact phone"), fix_in: "plan" };
    f.queue("code-reviewer", review(dataFinding), review(dataFinding));
    engine.start(await planned_());
    await until(() => engine.events("P-01").some((e) => e.event === "plan_edited"), "plan edited");
    expect(f.count("executor")).toBe(1); // the writer never got the data finding
    expect(task("T1").rounds[0]!.blocking[0]!.text).toContain("Sent to the planner");
    expect(plan().text).toContain("the original spec, long and detailed");
    expect(plan().text).toContain("## Update");
    expect(plan().text).toContain("The new store row has no contact phone");
    expect(plan().planFixesSent).toEqual(["The new store row has no contact phone"]);
  });
});

describe("a plan finding in the task's own file stays with the writer", () => {
  test("fix_in plan with a file the task owns goes to the executor", async () => {
    const { f, engine, task, planned_ } = setup();
    f.plan = planned([tk("T1")]);
    const own = { ...blocking("A double click sends a second cancel"), fix_in: "plan" };
    f.queue("code-reviewer", (r: any) => review({ ...own, file: engine.state().tasks["P-01/T1"]!.files[0] }), review());
    engine.start(await planned_());
    await until(() => task("T1").status === "done", "done");
    expect(f.count("executor")).toBe(2); // wrote it, then fixed the finding
    expect(engine.events("P-01").some((e) => e.event === "plan_fix_needed")).toBe(false);
  });

  test("the same plan finding in its own file after the writer's try goes to the planner", async () => {
    const { f, engine, plan, task, planned_ } = setup({ reviewerResume: false });
    f.plan = planned([tk("T1")]);
    const own = (r: any) => review({ ...blocking("No pop-up reads the chosen order"), fix_in: "plan", file: engine.state().tasks["P-01/T1"]!.files[0] });
    f.queue("code-reviewer", own, own);
    engine.start(await planned_());
    await until(() => engine.events("P-01").some((e) => e.event === "plan_fix_needed"), "sent to the planner");
    await until(() => task("T1").status === "done", "done");
    expect(f.count("executor")).toBe(2); // wrote it, then tried the finding once
    expect(plan().planFixesSent).toEqual(["No pop-up reads the chosen order"]);
  });
});

describe("an added edit keeps the plan text", () => {
  test("add appends an update; a plain edit still replaces the text", async () => {
    const { engine, plan, planned_, f } = setup();
    f.plan = planned([tk("T1")]);
    await planned_();
    engine.edit("P-01", "Note for T1: use the bin's store.", { add: true });
    expect(plan().text).toMatch(/^the original spec, long and detailed\n\n## Update \d{4}-\d\d-\d\d\nNote for T1: use the bin's store\.$/);
    await until(() => plan().steps.plan === "you", "re-planned");
    engine.edit("P-01", "A whole new text");
    expect(plan().text).toBe("A whole new text");
  });
});

describe("a queued plan change waits for a busy plan", () => {
  test("queueEdit during a re-plan is applied as an update once the planner is done", async () => {
    const { engine, plan, planned_, f } = setup();
    f.plan = planned([tk("T1")]);
    await planned_();
    engine.edit("P-01", "first change", { add: true });
    expect(() => engine.edit("P-01", "x", { add: true })).toThrow("busy");
    engine.queueEdit("P-01", "T22 may edit acl-permissions.ts");
    await until(() => plan().text.includes("T22 may edit acl-permissions.ts") && plan().steps.plan === "you", "queued change applied");
    expect(plan().text).toContain("first change");
    expect(plan().planFixes).toEqual([]);
  });
});

describe("later review rounds get the writer's fixes; fix rounds only compile", () => {
  test("round 2 sees round 1's finding with the writer's fix line; the fix compiles, then one full build before done", async () => {
    const { f, engine, task, planned_ } = setup();
    f.plan = planned([tk("T1")]);
    const prompts: string[] = [];
    f.queue("code-reviewer", (r: any) => { prompts.push(r.prompt); return review(blocking("The total is wrong for an empty list")); }, (r: any) => { prompts.push(r.prompt); return review(); });
    f.queue("executor", async (run: any) => { f.touch(run.edits[0], task("T1").files); return { summary: "ok", did: "Did T1.", needs_files: [], tests_added: ["t"] }; },
      async (run: any) => { f.touch(run.edits[0], task("T1").files); return { summary: "ok", did: "fixed", needs_files: [], tests_added: [], fixed: ["Return 0 when the list is empty"] }; });
    engine.start(await planned_());
    await until(() => task("T1").status === "done", "done");
    expect(prompts[1]).toContain("The total is wrong for an empty list");
    expect(prompts[1]).toContain("Writer: Return 0 when the list is empty");
    const builds = f.calls.filter((c) => c.startsWith(`build ${task("T1").dir}`));
    expect(builds.map((c) => c.endsWith(" quick"))).toEqual([false, true, false]); // first write, the fix round, the final full build
    expect(task("T1").rounds[0]!.head).toBeTruthy();
  });

  test("a clean first round needs no extra build", async () => {
    const { f, engine, task, planned_ } = setup();
    f.plan = planned([tk("T1")]);
    f.queue("code-reviewer", review());
    engine.start(await planned_());
    await until(() => task("T1").status === "done", "done");
    expect(f.calls.filter((c) => c.startsWith(`build ${task("T1").dir}`))).toEqual([`build ${task("T1").dir}`]);
  });

  test("a full build that needs a debugger fix after the last review gets one more review", async () => {
    const { f, engine, task, planned_ } = setup({ reviewerResume: false });
    f.plan = planned([tk("T1")]);
    f.queue("code-reviewer", review(blocking("Wrong total")), review(), review());
    f.buildQ.push({ ok: true }, { ok: true }, { ok: false, tail: "FAIL: TotalTest" }, { ok: true });
    engine.start(await planned_());
    await until(() => task("T1").status === "done", "done");
    expect(f.count("debugger")).toBe(1);
    expect(f.count("code-reviewer")).toBe(3);
    expect(engine.events("P-01").some((e) => e.event === "review_again")).toBe(true);
  });
});

describe("a wave gate builds only the repos that changed", () => {
  test("wave 2 touches only api, so its gate does not build web again", async () => {
    const { f, engine, plan, planned_ } = setup();
    f.plan = planned([tk("T1", { repo: "api" }), tk("T2", { repo: "web" }), tk("T3", { repo: "api", wave: 2, deps: ["T1"] })],
      { repo_order: [{ repo: "api", why: "api first" }, { repo: "web", why: "then web" }] });
    engine.start(await planned_());
    await until(() => plan().steps.master === "you" || !!plan().error, "finished");
    const starts = engine.events("P-01").filter((e) => e.event === "gate_start") as any[];
    expect(starts.find((e) => e.wave === 1).repos).toEqual(["api", "web"]);
    expect(starts.find((e) => e.wave === 2).repos).toEqual(["api"]);
    expect(starts.find((e) => e.wave === 2).unchanged).toEqual(["web"]);
  });
});

describe("review rounds converge (27/10, T14 ran 20 rounds)", () => {
  test("a later round's reviewer checks the fixes and blocks in unchanged code only on harm or security", async () => {
    const { f, engine, task, planned_ } = setup({ reviewerResume: false });
    f.plan = planned([tk("T1")]);
    const prompts: string[] = [];
    f.queue("code-reviewer", (r: any) => { prompts.push(r.prompt); return review(blocking("Wrong total")); }, (r: any) => { prompts.push(r.prompt); return review(); });
    engine.start(await planned_());
    await until(() => task("T1").status === "done", "done");
    expect(prompts[1]).toContain("This is a later round, so it checks the fixes");
    expect(prompts[1]).toContain("report as blocking only a harmful problem (the rule above) or a security hole");
    expect(prompts[0]).toContain("two separate failures at the same moment");
  });

  test("a concern raised in two earlier rounds goes to the planner as a decision", async () => {
    const { f, engine, plan, task, planned_ } = setup();
    f.plan = planned([tk("T1")]);
    f.queue("code-reviewer", review(blocking("A hung call blocks the job")), review(blocking("A hung call still blocks the job")),
      review({ ...blocking("A hung call can still block the job"), repeat_of_rounds: [1, 2] }));
    engine.start(await planned_());
    await until(() => (plan().planFixesSent ?? []).some((x) => x.includes("Design decision needed")), "sent to the planner");
    expect(task("T1").rounds.at(-1)!.blocking.every((b) => b.text.includes("Sent to the planner"))).toBe(true);
  });
});

describe("the final-stage reviews read the whole plan on the 1M-context model", () => {
  test("the architect's plan diff and the last review run with wholePlan and no 120,000-character cut", async () => {
    const { ports, f } = makeFakes();
    const models: string[] = [], sizes: number[] = [];
    const orig = ports.claude;
    ports.claude = async (run: any) => { if (run.role === "architect-reviewer" || String(run.prompt).includes("This is the last review")) { models.push(run.model); sizes.push(run.prompt.length); } return orig(run); };
    const engine = createEngine(ports, {});
    f.engine = engine;
    f.plan = planned([tk("T1", { files: Array.from({ length: 20 }, (_, i) => `src/F${i}.ts`) })], { kind: "big", architecture: { changes: true, why: "new table" } });
    const big = "x".repeat(200_000);
    const diff = ports.git.diff; ports.git.diff = async (d: string, b: string) => `${await diff(d, b)}\n${big}`;
    f.queue("code-reviewer", review({ ...blocking("Old note"), severity: "minor", category: "data" }));
    const id = engine.submit("whole plan");
    await until(() => engine.state().plans[id]!.steps.plan === "you", "planned");
    engine.start(id);
    await until(() => engine.state().plans[id]!.steps.master === "you" || !!engine.state().plans[id]!.error, "finished");
    expect(models.filter((m) => m === "opus[1m]").length).toBeGreaterThanOrEqual(2); // the plan diff and the last review
    expect(Math.max(...sizes)).toBeGreaterThan(200_000);
  });
});

describe("a re-plan soon after the last one resumes the planner session", () => {
  const planners = (f: any) => f.runs.filter((r: any) => r.role === "planner");
  test("within plannerResumeMs it resumes; a failed resume starts a new session; past the limit it starts fresh", async () => {
    const { engine, plan, planned_, f } = setup();
    f.plan = planned([tk("T1")]);
    await planned_();
    const first = planners(f)[0]!.sessionId;
    expect(plan().plannerSession?.id).toBe(first);
    engine.edit("P-01", "change one", { add: true });
    await until(() => plan().versions.length === 2 && plan().steps.plan === "you", "re-planned");
    expect(planners(f)[1]!.resumeId).toBe(first);
    f.queue("planner", { __error: "No conversation found" });
    engine.edit("P-01", "change two", { add: true });
    await until(() => plan().versions.length === 3 && plan().steps.plan === "you", "re-planned after a failed resume");
    const [failed, fresh] = planners(f).slice(2);
    expect(failed.resumeId).toBe(first);
    expect(fresh.resumeId).toBeUndefined();
    expect(plan().plannerSession?.id).toBe(fresh.sessionId);
    expect(engine.events("P-01").some((e) => e.event === "planner_resume_failed")).toBe(true);
  });
  test("an old session is not resumed", async () => {
    const { engine, plan, planned_, f } = setup({ plannerResumeMs: 0 });
    f.plan = planned([tk("T1")]);
    await planned_();
    engine.edit("P-01", "change", { add: true });
    await until(() => plan().versions.length === 2 && plan().steps.plan === "you", "re-planned");
    expect(planners(f)[1]!.resumeId).toBeUndefined();
  });
});

describe("a plan change that arrives while a task runs reaches its writer", () => {
  test("a clean review with an unseen update sends it to the same executor session, then reviews again", async () => {
    const { engine, task, planned_, f } = setup({ reviewerResume: false });
    f.plan = planned([tk("T1")]);
    f.queue("code-reviewer", () => { task("T1").notes.push("Use the bin's store, not the order's."); return review(); }, review());
    engine.start(await planned_());
    await until(() => task("T1").status === "done", "done");
    const execs = f.runs.filter((r: any) => r.role === "executor");
    expect(execs.length).toBe(2);
    expect(execs[1]!.resumeId).toBe(execs[0]!.sessionId);
    expect(String(execs[1]!.prompt)).toContain("Use the bin's store, not the order's.");
    expect(f.count("code-reviewer")).toBe(2);
  });
});

describe("code a plan builds in another repo is checked on its plan branch", () => {
  // T11 round 10, P-07 (28/10/2026): read on Bitbucket feat/eshopbox, while T2's code was on the local plan branch.
  const R10 = "(Sent to the planner, not this writer) Design decision needed: T11 raised this in rounds 5, 8, 9 and again now. Decide: accept the risk, cover it in another task, or split the task. Still open and still for the planner. I checked the Bitbucket API today. shopify-order-proxy feat/eshopbox is still at 18197b6eafb8 (27/10). Its FulfillmentOrderController takes only `openOrders` as a @RequestParam. It has no `fcLocationId` parameter and no `availableAtFc` field. So client.list(region, id, fcLocationId) gets replies with no stock key. To check: T2 is merged with 'availableAtFc' and 'fcLocationId', or this client is changed to match T2's names.";
  const twoRepos = () => planned([tk("T1", { repo: "web" }), tk("T2", { repo: "api", wave: 2, deps: ["T1"] })], { kind: "big" });
  const crossRepo = (o: any = {}) => ({ ...blocking("The proxy never sends FC stock"), fix_in: "plan", other_repo: "web", other_symbols: ["fcLocationId", "availableAtFc"], ...o });
  const only = (finding: any) => (r: any) => (String(r.prompt).includes("This is the last review") ? { items: [] } : r.task === "P-01/T2" ? review(finding) : review());

  test("the review prompt lists every plan repo worktree with its head, and says the code is not on staging yet", async () => {
    const { engine, task, planned_, f } = setup();
    f.plan = twoRepos();
    engine.start(await planned_());
    await until(() => task("T2").status === "done", "done");
    const prompt = String(f.runs.find((r: any) => r.role === "code-reviewer" && r.task === "P-01/T2")!.prompt);
    expect(prompt).toContain("Code built by this plan in another repo is on these local plan branches. It is not on staging, master or the git host until the plan lands. Check it here");
    expect(prompt).toMatch(/- web: \/stage\/P-01\/web \(branch \S+, head \S+\)/);
    expect(prompt).toMatch(/- api: \/stage\/P-01\/api \(branch \S+, head \S+\)/);
  });

  test("a finding whose names are on the other repo's plan branch is closed; one whose names are missing still goes to the planner", async () => {
    const a = setup();
    a.f.plan = twoRepos();
    a.f.words.set("/stage/P-01/web", ["fcLocationId", "availableAtFc"]);
    const g = only(crossRepo());
    a.f.queue("code-reviewer", g, g, g, g, g, g);
    a.engine.start(await a.planned_());
    await until(() => a.task("T2").status === "done", "done");
    const closed = a.engine.events("P-01").find((e) => e.event === "finding_closed");
    expect(closed?.text).toMatch(/closed: present on plan branch web@\S+/);
    expect(a.plan().planFixesSent ?? []).toEqual([]);

    const b = setup();
    b.f.plan = twoRepos();
    b.f.words.set("/stage/P-01/web", ["fcLocationId"]); // availableAtFc is not there
    const h = only(crossRepo());
    b.f.queue("code-reviewer", h, h, h, h, h, h);
    b.engine.start(await b.planned_());
    await until(() => b.engine.events("P-01").some((e) => e.event === "plan_fix_needed"), "sent to the planner");
    expect(b.engine.events("P-01").some((e) => e.event === "finding_closed")).toBe(false);
  });

  test("T11 round 10's finding, replayed with the proxy names on its plan branch, never reaches the planner", async () => {
    const { engine, task, plan, planned_, f } = setup();
    f.plan = twoRepos();
    f.words.set("/stage/P-01/web", ["fcLocationId", "availableAtFc"]);
    const g = only(crossRepo({ text: R10, short: "The proxy still sends no FC stock, so no store unit ever moves to the FC.", repeat_of_rounds: [5, 8, 9] }));
    f.queue("code-reviewer", g, g, g, g, g, g);
    engine.start(await planned_());
    await until(() => task("T2").status === "done", "done");
    expect(engine.events("P-01").some((e) => e.event === "plan_fix_needed")).toBe(false);
    expect(plan().planFixesSent ?? []).toEqual([]);
    expect(plan().versions.length).toBe(1); // no re-plan
  });
});

describe("a task waits for a pending plan change meant for it", () => {
  const gate = () => { let go!: () => void; const p = new Promise<void>((r) => (go = r)); return { p, go }; };
  const reviews = (task: (l: string) => any) => task("T1").rounds.filter((r: any) => r.source === "review").length;

  test("an edit naming a running task holds it until the update arrives; no round is counted while it waits", async () => {
    const { engine, task, plan, planned_, f } = setup();
    f.plan = planned([tk("T1"), tk("T2")]);
    const hold = gate();
    const id = await planned_();
    f.queue("planner", async () => { await hold.p; return planned([tk("T1", { action: "update", note: "Use the store's own location" }), tk("T2", { action: "keep" })]); });
    let edited = false;
    const r = (run: any) => {
      if (run.task !== "P-01/T1") return review();
      if (!edited) { edited = true; engine.editOrQueue("P-01", "T1: use the store's own location, not the order's."); return review(blocking("Uses the order's location")); }
      return review();
    };
    f.queue("code-reviewer", r, r, r, r, r);
    engine.start(id);
    await until(() => task("T1").sub?.startsWith("Held"), "T1 held");
    const execs = f.count("executor");
    expect(reviews(task)).toBe(1);
    await new Promise((res) => setTimeout(res, 300));
    expect(reviews(task)).toBe(1); // no round while it waits
    expect(f.count("executor")).toBe(execs);
    hold.go();
    await until(() => task("T1").status === "done", "T1 done after the update");
    expect(plan().versions.length).toBe(2);
    expect(f.runs.filter((x: any) => x.role === "executor" && x.task === "P-01/T1").at(-1)!.prompt).toContain("Use the store's own location");
    expect(task("T1").heldForPlan).toBeFalsy();
  });

  test("an edit sent while the plan is busy is queued, then applied once", async () => {
    const { engine, plan, planned_, f } = setup();
    f.plan = planned([tk("T1")]);
    const id = await planned_();
    engine.start(id);
    const hold = gate();
    f.queue("planner", async () => { await hold.p; return planned([tk("T1", { action: "keep" })]); });
    expect(engine.editOrQueue(id, "first change")).toBe("applied");
    expect(engine.editOrQueue(id, "second change, sent while busy")).toBe("queued");
    hold.go();
    await until(() => plan().versions.length === 3 && plan().steps.plan !== "run", "queued edit applied");
    expect(plan().text.split("second change, sent while busy").length - 1).toBe(1);
    expect(plan().planFixes ?? []).toEqual([]);
  });
});

describe("a finding raised again while it waits at the planner holds the task", () => {
  test("the same plan finding, still queued, holds the task with no new plan fix; the applied re-plan releases it", async () => {
    const { engine, task, plan, planned_, f } = setup();
    f.plan = planned([tk("T1")]);
    const id = await planned_();
    const key = "Two plan rules disagree on the store read";
    const r = (run: any) => (run.task === "P-01/T1" && !plan().versions.some((v) => v.fixes?.includes(key)) ? review({ ...blocking(key), fix_in: "plan", file: "other/File.java" }, blocking("A task bug")) : review());
    f.queue("code-reviewer", r, r, r, r, r);
    engine.state().plans[id]!.planFixesSent = [key]; // sent by an earlier round, not applied yet
    engine.state().plans[id]!.planFixes = [key];
    engine.start(id);
    await until(() => plan().versions.length === 2, "the queued fix was applied");
    await until(() => task("T1").status === "done", "T1 done");
    expect(engine.events(id).some((e) => e.event === "plan_fix_needed")).toBe(false); // never sent twice
  });
});

describe("a re-plan gets the architect's split check only for a major change", () => {
  test("notes only: skipped; a new task or a changed contract: checked", async () => {
    const { engine, plan, planned_, f } = setup();
    f.plan = planned([tk("T1"), tk("T2", { repo: "web" })], { kind: "big", contract: "1) GET /x returns y" });
    const id = await planned_();
    engine.start(id);
    const archs = () => f.count("architect-reviewer");
    const before = archs();
    f.queue("planner", planned([tk("T1", { action: "update", note: "use z" }), tk("T2", { repo: "web", action: "keep" })], { kind: "big", contract: "1) GET /x returns y" }));
    engine.edit(id, "T1: use z", { add: true });
    await until(() => plan().versions.length === 2 && plan().steps.plan !== "run", "notes-only re-plan");
    expect(archs()).toBe(before);
    expect(engine.events(id).some((e) => e.event === "architect_skipped" && String(e.text).includes("no task added or removed"))).toBe(true);
    f.queue("planner", planned([tk("T1", { action: "keep" }), tk("T2", { repo: "web", action: "keep" }), tk("T3", { action: "add" })], { kind: "big", contract: "1) GET /x returns y" }));
    engine.edit(id, "Add T3", { add: true });
    await until(() => plan().versions.length === 3 && plan().steps.plan !== "run", "re-plan with a new task");
    expect(archs()).toBe(before + 1);
    f.queue("planner", planned([tk("T1", { action: "keep" }), tk("T2", { repo: "web", action: "keep" }), tk("T3", { action: "keep" })], { kind: "big", contract: "1) GET /x returns y and z" }));
    engine.edit(id, "Contract: add z", { add: true });
    await until(() => plan().versions.length === 4 && plan().steps.plan !== "run", "re-plan with a changed contract");
    expect(archs()).toBe(before + 2);
  });
});

describe("an identical plan change queued twice is applied once", () => {
  test("a second identical queueEdit is dropped, and duplicates already queued are applied once", async () => {
    const { engine, plan, planned_, f } = setup();
    f.plan = planned([tk("T1")]);
    const id = await planned_();
    const gate = (() => { let go!: () => void; const p = new Promise<void>((r) => (go = r)); return { p, go }; })();
    f.queue("planner", async () => { await gate.p; return planned([tk("T1")]); });
    engine.edit(id, "first", { add: true });
    engine.queueEdit(id, "Update from the guide");
    engine.queueEdit(id, "Update from the guide");
    expect(plan().planFixes).toEqual(["Update from the guide"]);
    engine.state().plans[id]!.planFixes = ["Old twin", "Old twin"]; // queued twice before this check existed
    gate.go();
    await until(() => plan().versions.length === 3 && plan().steps.plan !== "run", "applied");
    expect(plan().text.split("Old twin").length - 1).toBe(1);
  });
});
