// The engine's side of a host watchdog: the error hook in place of the recovery run, quiet(), and the mergeable sweep.
import { describe, expect, test } from "bun:test";
import { createEngine } from "../core/engine.ts";
import { makeFakes, planned, tk, until } from "./fakes.ts";

function setup() {
  const { ports, f } = makeFakes();
  const engine = createEngine(ports);
  f.engine = engine;
  const plan = (id = "P-01") => engine.state().plans[id]!;
  const toMaster = (id: string) => until(() => plan(id).steps.master === "you" || !!plan(id).error, "master PRs");
  return { ports, f, engine, plan, toMaster };
}
const none = { exercised: false, passed: false, proof: "no data", checks: [] };

async function twoAtMaster(s: ReturnType<typeof setup>) {
  s.f.plan = (run) => planned([tk("T1", { files: [run.plan === "P-01" ? "src/A.ts" : "src/B.ts"] })]);
  const a = s.engine.submit("first"), b = s.engine.submit("second");
  await until(() => s.plan(a).steps.plan === "you" && s.plan(b).steps.plan === "you", "both planned");
  s.engine.start(a); s.engine.start(b);
  await s.toMaster(a); await s.toMaster(b);
  return { a, b };
}

describe("host watchdog hooks", () => {
  test("an error goes to the host's error hook, not the recovery run", async () => {
    const s = setup(), seen: string[] = [];
    s.engine.setHooks({ error: (p, msg) => seen.push(`${p.id}: ${msg}`) });
    s.f.plan = planned([tk("T1")]);
    const id = s.engine.submit("work");
    await until(() => s.plan(id).steps.plan === "you", "planned");
    const planners = s.f.count("planner");
    s.f.testQ.push(none, none, none);
    s.engine.start(id);
    await until(() => !!s.plan(id).error, "error");
    await Bun.sleep(5);
    expect(seen.length).toBe(1);
    expect(seen[0]).toContain("P-01: ");
    expect(s.f.count("planner")).toBe(planners); // no recovery run
    expect(s.plan(id).recoveries).toBeUndefined();
  });

  test("quiet: false while a task runs, true when the plan waits at its master PRs", async () => {
    const s = setup();
    s.f.plan = planned([tk("T1")]);
    const id = s.engine.submit("work");
    await until(() => s.plan(id).steps.plan === "you", "planned");
    s.engine.start(id);
    expect(s.engine.quiet(id)).toBe(false);
    await s.toMaster(id);
    expect(s.engine.quiet(id)).toBe(true);
  });

  test("a person's Retry gives the watchdog its runs back", async () => {
    const s = setup();
    s.f.plan = planned([tk("T1")]);
    const id = s.engine.submit("work");
    await until(() => s.plan(id).steps.plan === "you", "planned");
    s.engine.setWatchdog(id, { state: "needs", day: "2026-10-23", runs: 3, maxRuns: 3, steps: [], files: [], fixes: 0, history: [], needs: "x" });
    s.engine.retry(id, "The watchdog retried it");
    expect(s.plan(id).watchdog!.runs).toBe(3);
    s.engine.retry(id);
    expect(s.plan(id).watchdog!.runs).toBe(0);
    expect(s.plan(id).watchdog!.state).toBe("done");
  });
});

describe("mergeable sweep", () => {
  test("merging one plan refreshes the other plan's PR and tells the host", async () => {
    const s = setup(), kept: string[] = [];
    s.engine.setHooks({ refreshed: (id, after, repos, ok) => kept.push(`${id} after ${after} ${repos.join(",")} ${ok}`) });
    const { a, b } = await twoAtMaster(s);
    await s.engine.mergeMaster(a);
    await until(() => kept.length > 0, "refresh hook");
    expect(kept).toEqual([`${b} after ${a} api true`]);
    expect(s.plan(b).masterPrs[0]!.state).toBe("open");
    expect(s.f.calls.filter((c) => c.startsWith("merge-pr master")).length).toBe(1); // only Pratham's merge
  });

  test("a PR that no longer merges cleanly is rebuilt; clean PRs are untouched; nothing merges", async () => {
    const s = setup(), kept: string[] = [];
    s.engine.setHooks({ refreshed: (id, _a, repos, ok) => kept.push(`${id} ${repos.join(",")} ${ok}`) });
    const { a, b } = await twoAtMaster(s);
    const headB = s.plan(b).masterPrs[0]!.head, checked: string[] = [];
    s.ports.git.mergesCleanly = async (repo, head, target) => { checked.push(`${repo} ${target}`); return head !== headB; };
    s.f.remote.get("api/master")!.push("other-merge");
    const res = await s.engine.sweep();
    expect(checked).toEqual(["api master", "api master"]);
    expect(res.refreshed).toEqual([{ plan: b, repos: ["api"], after: "another change", ok: true }]);
    expect(kept).toEqual([`${b} api true`]);
    expect(s.engine.events(b).map((e) => e.event)).toContain("sweep_conflict");
    expect(s.engine.events(a).map((e) => e.event)).not.toContain("master_refreshed");
    expect(s.plan(b).masterPrs[0]!.base).toBe("other-merge");
    expect(s.f.calls.some((c) => c.startsWith("merge-pr master"))).toBe(false);
  });

  test("a failed rebuild is a plan error, which reaches the host's error hook", async () => {
    const s = setup(), errors: string[] = [];
    s.engine.setHooks({ error: (p, msg) => errors.push(`${p.id}: ${msg}`) });
    const { b } = await twoAtMaster(s);
    const headB = s.plan(b).masterPrs[0]!.head;
    s.ports.git.mergesCleanly = async (_r, head) => head !== headB;
    s.f.remote.get("api/master")!.push("other-merge");
    s.f.conflicts.cherry = true;
    const res = await s.engine.sweep();
    expect(res.refreshed[0]!.ok).toBe(false);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain(`${b}: Master moved when another change merged, and refreshing the api master PR failed`);
  });

  test("no port: the sweep does nothing", async () => {
    const s = setup();
    await twoAtMaster(s);
    expect(await s.engine.sweep()).toEqual({ refreshed: [], stale: [] });
  });
});

describe("every step is logged", () => {
  test("a full fake plan run logs each scheduler action's start and end and each step transition", async () => {
    const s = setup();
    s.f.plan = planned([tk("T1")]);
    const id = s.engine.submit("work");
    await until(() => s.plan(id).steps.plan === "you", "planned");
    s.engine.start(id);
    await s.toMaster(id);
    await s.engine.mergeMaster(id);
    await until(() => s.plan(id).steps.master === "done", "live");
    const evs = s.engine.events(id), names = evs.map((e) => e.event);
    for (const a of ["plan:P-01", "task:P-01/T1", "gate:P-01:1", "staging:P-01", "uat:P-01", "master:P-01"]) {
      const st = evs.findIndex((e) => e.event === "action_start" && e.action === a), en = evs.findIndex((e) => e.event === "action_end" && e.action === a);
      expect(st, a).toBeGreaterThanOrEqual(0);
      expect(en, a).toBeGreaterThan(st);
      expect(evs[en]!.ok, a).toBe(true);
      expect(typeof evs[en]!.ms, a).toBe("number");
    }
    const order = ["plan_submitted", "planner_result", "started", "merge", "task_done", "gate", "staging_start", "staging_done", "uat_start", "uat_result", "master_ready", "merge_master_clicked", "master_merged", "live"];
    let at = -1;
    for (const n of order) { const i = names.indexOf(n, at + 1); expect(i, n).toBeGreaterThan(at); at = i; }
    expect(evs.every((e) => typeof e.at === "number" && typeof e.text === "string")).toBe(true);
  });
});
