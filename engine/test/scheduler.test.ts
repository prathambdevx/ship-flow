import { expect, test } from "bun:test";
import { nextActions } from "../core/scheduler.ts";
import { DEFAULTS } from "../config.ts";
import type { Action } from "../types.ts";
import { mkPlan, mkState, mkTask } from "./fixtures.ts";

const cfg = { ...DEFAULTS, maxTasks: 3, maxPlanning: 2 };
const run = (s: any, inflight: string[] = [], c = cfg) => nextActions(s, c, new Set(inflight));
const keys = (a: Action[]) => a.map((x) => (x.kind === "task" ? `task:${x.task}` : x.kind === "gate" ? `gate:${x.plan}:${x.wave}` : `${x.kind}:${x.plan}`));
const T = (label: string, o = {}) => mkTask({ label, files: [`${label}.ts`], ...o });
const doneAll = { plan: "done", tasks: "done", staging: "", uat: "", master: "" } as const;

test("plan step runs; maxPlanning caps with inflight", () => {
  const mk = (id: string, order: number) => mkPlan({ id, order, started: false, steps: { plan: "run", tasks: "", staging: "", uat: "", master: "" } });
  const s = mkState([mk("P-01", 1), mk("P-02", 2), mk("P-03", 3)], []);
  expect(keys(run(s).actions)).toEqual(["plan:P-01", "plan:P-02"]);
  expect(keys(run(s, ["plan:P-01"]).actions)).toEqual(["plan:P-02"]);
  expect(keys(run(s, ["plan:P-01", "plan:P-02"]).actions)).toEqual([]);
});
test("draft never runs; needsStart blocks drafts", () => {
  const s = mkState([mkPlan({ needsStart: true })], [T("T1", { status: "draft" })]);
  expect(run(s).actions).toEqual([]);
  expect(Object.keys(run(s).waitsOn)).toEqual([]);
});
test("waiting task runs; inflight task is not repeated", () => {
  const s = mkState([mkPlan()], [T("T1")]);
  expect(keys(run(s).actions)).toEqual(["task:P-01/T1"]);
  expect(run(s, ["task:P-01/T1"]).actions).toEqual([]);
});
test("a waiting task still starts while its started plan is re-planned", () => {
  const s = mkState([mkPlan({ steps: { plan: "run", tasks: "run", staging: "", uat: "", master: "" } })], [T("T1", { status: "working" }), T("T2")]);
  expect(keys(run(s).actions)).toEqual(["plan:P-01", "task:P-01/T2"]);
});
test("deps must be done", () => {
  const s = mkState([mkPlan({ waves: 2, gates: { 1: true } })], [T("T1", { status: "working" }), T("T2", { wave: 2, deps: ["P-01/T1"] })]);
  expect(run(s).actions).toEqual([]);
  s.tasks["P-01/T1"].status = "done";
  expect(keys(run(s).actions)).toContain("task:P-01/T2");
});
test("earlier wave gate must pass", () => {
  const t = [T("T1", { status: "done" }), T("T2", { wave: 2, deps: ["P-01/T1"] })];
  const s = mkState([mkPlan({ waves: 2 })], t);
  expect(keys(run(s).actions)).toEqual(["gate:P-01:1"]);
  const s2 = mkState([mkPlan({ waves: 2, gates: { 1: true } })], t.map((x) => ({ ...x })));
  expect(keys(run(s2).actions)).toEqual(["task:P-01/T2"]);
});
test("an empty earlier wave never blocks a task", () => {
  const t = [T("T1", { status: "done" }), T("T2", { wave: 4, deps: ["P-01/T1"] })];
  const s = mkState([mkPlan({ waves: 4, gates: { 1: true, 2: false, 3: false } })], t);
  expect(keys(run(s).actions)).toEqual(["task:P-01/T2"]);
  s.plans["P-01"].gates = { 1: false };
  expect(keys(run(s).actions)).toEqual(["gate:P-01:1"]);
});
test("gate only when whole wave done; not again once passed", () => {
  const s = mkState([mkPlan()], [T("T1", { status: "done" }), T("T2", { status: "working" })]);
  expect(run(s).actions).toEqual([]);
  s.tasks["P-01/T2"].status = "done";
  expect(keys(run(s).actions)).toEqual(["gate:P-01:1"]);
  expect(run(s, ["gate:P-01:1"]).actions).toEqual([]);
  s.plans["P-01"].gates = { 1: true };
  expect(keys(run(s).actions)).toEqual(["staging:P-01"]);
});
test("gate ignores removed tasks", () => {
  const s = mkState([mkPlan()], [T("T1", { status: "done" }), T("T2", { status: "removed" })]);
  expect(keys(run(s).actions)).toEqual(["gate:P-01:1"]);
});
test("maxTasks cap counts working, review and inflight", () => {
  const ws = ["T1", "T2", "T3", "T4", "T5"].map((l) => T(l));
  const s = mkState([mkPlan()], ws);
  expect(keys(run(s).actions)).toEqual(["task:P-01/T1", "task:P-01/T2", "task:P-01/T3"]);
  s.tasks["P-01/T1"].status = "working"; s.tasks["P-01/T2"].status = "review";
  expect(keys(run(s).actions)).toEqual(["task:P-01/T3"]);
  expect(run(s, ["task:P-01/T3"]).actions).toEqual([]);
  expect(keys(run(s, ["task:P-01/T1"]).actions)).toEqual(["task:P-01/T3"]);
});
test("cap spans plans; tasks run by plan order then wave then label", () => {
  const p1 = mkPlan({ id: "P-01", order: 2, gates: { 1: true }, waves: 2 }), p2 = mkPlan({ id: "P-02", order: 1 });
  const t = [T("T1", { planId: "P-01", wave: 2, files: ["a"] }), T("T2", { planId: "P-01", wave: 2, files: ["b"] }), T("T1", { planId: "P-02", files: ["c"] })];
  const s = mkState([p1, p2], t);
  expect(keys(run(s, [], { ...cfg, maxTasks: 2 }).actions)).toEqual(["task:P-02/T1", "task:P-01/T1"]);
  const labels = mkState([mkPlan()], [T("T10"), T("T2")]);
  expect(keys(run(labels).actions)).toEqual(["task:P-01/T2", "task:P-01/T10"]);
});
test("lock blocks later plan task and waitsOn is reported", () => {
  const p1 = mkPlan({ id: "P-01", order: 1 }), p2 = mkPlan({ id: "P-02", order: 2 });
  const s = mkState([p1, p2], [mkTask({ planId: "P-01", label: "T1", files: ["S.java"] }), mkTask({ planId: "P-02", label: "T1", files: ["S.java"] })]);
  const r = run(s);
  expect(keys(r.actions)).toEqual(["task:P-01/T1"]);
  expect(r.waitsOn).toEqual({ "P-01/T1": [], "P-02/T1": ["P-01/T1"] });
});
test("earlier plan wins a shared file even when the later one is working; no deadlock", () => {
  const s = mkState([mkPlan({ id: "P-01", order: 1 }), mkPlan({ id: "P-02", order: 2 })],
    [mkTask({ planId: "P-01", label: "T1", files: ["S.java"] }), mkTask({ planId: "P-02", label: "T1", files: ["S.java"], status: "working" })]);
  expect(keys(run(s).actions)).toEqual(["task:P-01/T1"]);
});
test("lock releases once the earlier plan's repo is staged", () => {
  const staged = { repo: "api", base: "", branch: "", dir: "", order: 1, stagingCommits: [], staged: true };
  const s = mkState([mkPlan({ id: "P-01", order: 1, repos: [staged] }), mkPlan({ id: "P-02", order: 2 })],
    [mkTask({ planId: "P-01", label: "T1", files: ["S.java"], status: "done" }), mkTask({ planId: "P-02", label: "T1", files: ["S.java"] })]);
  expect(keys(run(s).actions)).toContain("task:P-02/T1");
});
test("removed tasks are ignored", () => {
  const s = mkState([mkPlan({ id: "P-01", order: 1 }), mkPlan({ id: "P-02", order: 2 })],
    [mkTask({ planId: "P-01", label: "T1", files: ["S.java"], status: "removed" }), mkTask({ planId: "P-02", label: "T1", files: ["S.java"] })]);
  const r = run(s);
  expect(keys(r.actions)).toEqual(["task:P-02/T1"]);
  expect(r.waitsOn["P-01/T1"]).toBeUndefined();
});
test("error and stopRequested plans get nothing", () => {
  const t = [T("T1")];
  expect(run(mkState([mkPlan({ error: "boom" })], t)).actions).toEqual([]);
  expect(run(mkState([mkPlan({ stopRequested: true })], t.map((x) => ({ ...x })))).actions).toEqual([]);
  const planning = mkPlan({ error: "x", steps: { plan: "run", tasks: "", staging: "", uat: "", master: "" } });
  expect(run(mkState([planning], [])).actions).toEqual([]);
});
test("staging blocked by any open task or missing gate", () => {
  for (const status of ["draft", "waiting", "working", "review", "failed"]) {
    const s = mkState([mkPlan({ gates: { 1: true }, steps: doneAll })], [T("T1", { status: "done" }), T("T2", { status: status as any, wave: 2, deps: ["P-01/T1"] })]);
    s.plans["P-01"].waves = 2;
    expect(keys(run(s).actions)).not.toContain("staging:P-01");
  }
  const noGate = mkState([mkPlan({ steps: doneAll })], [T("T1", { status: "done" })]);
  expect(keys(run(noGate).actions)).toEqual(["gate:P-01:1"]);
});
test("staging runs when clean; resumes in run; not when inflight, done, or not started", () => {
  const t = () => [T("T1", { status: "done" }), T("T2", { status: "removed" })];
  const mk = (staging: any, o = {}) => mkState([mkPlan({ gates: { 1: true }, steps: { ...doneAll, staging }, ...o })], t());
  expect(keys(run(mk("")).actions)).toEqual(["staging:P-01"]);
  expect(keys(run(mk("run")).actions)).toEqual(["staging:P-01"]);
  expect(run(mk("run"), ["staging:P-01"]).actions).toEqual([]);
  expect(run(mk("fail")).actions).toEqual([]);
  expect(run(mk("done", { steps: { ...doneAll, staging: "done", uat: "done", master: "you" } })).actions).toEqual([]);
  expect(run(mk("", { started: false })).actions).toEqual([]);
});
test("uat and master sequencing", () => {
  const mk = (staging: any, uat: any, master: any) => mkState([mkPlan({ gates: { 1: true }, steps: { plan: "done", tasks: "done", staging, uat, master } })], [T("T1", { status: "done" })]);
  expect(keys(run(mk("done", "")).actions)).toEqual(["uat:P-01"]);
  expect(keys(run(mk("done", "run")).actions)).toEqual(["uat:P-01"]);
  expect(run(mk("run", "")).actions.some((a) => a.kind === "uat")).toBe(false);
  expect(run(mk("done", "fail")).actions).toEqual([]);
  expect(keys(run(mk("done", "done", "")).actions)).toEqual(["master:P-01"]);
  expect(run(mk("done", "done", "you")).actions).toEqual([]);
  expect(run(mk("done", "done", "done")).actions).toEqual([]);
  expect(run(mk("done", "run", "")).actions.some((a) => a.kind === "master")).toBe(false);
});
test("waitsOn has a key for every waiting task only", () => {
  const s = mkState([mkPlan()], [T("T1"), T("T2", { status: "working" }), T("T3", { status: "draft" })]);
  expect(Object.keys(run(s).waitsOn)).toEqual(["P-01/T1"]);
});

test("a gate waits for every earlier gate", () => {
  const t = [T("T1", { status: "done" }), T("T2", { wave: 2, status: "done", deps: ["P-01/T1"] })];
  const s = mkState([mkPlan({ waves: 2, gates: { 1: false } })], t);
  expect(keys(run(s).actions)).toEqual(["gate:P-01:1"]);
  s.plans["P-01"].gates = { 1: true };
  expect(keys(run(s).actions)).toEqual(["gate:P-01:2"]);
});
test("two tasks of one plan that share a file never run at the same time", () => {
  const s = mkState([mkPlan()], [T("T1", { status: "working", files: ["a.ts"] }), T("T2", { files: ["b.ts", "a.ts"] }), T("T3", { files: ["c.ts"] })]);
  expect(keys(run(s).actions)).toEqual(["task:P-01/T3"]);
  s.tasks["P-01/T1"]!.status = "done";
  expect(keys(run(s).actions)).toContain("task:P-01/T2");
});
test("buildEachTask off: a later-wave task starts once its own deps are done, though an earlier wave still runs", () => {
  const s = mkState([mkPlan()], [T("T7", { status: "review", wave: 1 }), T("T5", { status: "done", wave: 1 }), T("T15", { wave: 3, deps: ["P-01/T5"] })]);
  expect(keys(run(s, ["task:P-01/T7"], { ...cfg, buildEachTask: false }).actions)).toEqual(["task:P-01/T15"]);
  expect(keys(run(s, ["task:P-01/T7"]).actions)).toEqual([]); // with a build per wave, the wave gate still holds it
});
test("a staging-only plan raises no master PRs after its staging test", () => {
  const steps = { plan: "done", tasks: "done", staging: "done", uat: "done", master: "" } as const;
  const s = mkState([mkPlan({ steps, stagingOnly: true } as any)], [T("T1", { status: "done" })]);
  expect(keys(run(s).actions)).not.toContain("master:P-01");
  const s2 = mkState([mkPlan({ steps } as any)], [T("T1", { status: "done" })]);
  expect(keys(run(s2).actions)).toContain("master:P-01");
});
