import { expect, test } from "bun:test";
import { validatePlan } from "../core/validate.ts";
import { mkTask } from "./fixtures.ts";
import type { PlannedTask, PlannerResult } from "../types.ts";

const pt = (o: Partial<PlannedTask> = {}): PlannedTask => ({
  label: "T1", title: "t", repo: "api", wave: 1, deps: [], files: ["src/a.ts"], size: "S", part: "", what: [], checks: [], security: false, ...o,
});
const plan = (tasks: PlannedTask[], o: Partial<PlannerResult> = {}): PlannerResult => ({
  title: "x", kind: "big", size_why: "", acceptance: ["works"], tasks,
  repo_order: [...new Set(tasks.map((t) => t.repo))].map((repo) => ({ repo, why: "" })), ...o,
});
const REPOS = ["api", "web"];
const has = (probs: string[], s: string) => probs.some((p) => p.includes(s));

test("valid big plan passes", () => {
  const r = plan([pt(), pt({ label: "T2", wave: 2, deps: ["T1"], files: ["src/b.ts"] })]);
  expect(validatePlan(r, REPOS)).toEqual([]);
});
test("small: one task in wave 1", () => {
  expect(validatePlan(plan([pt()], { kind: "small" }), REPOS)).toEqual([]);
  expect(has(validatePlan(plan([pt(), pt({ label: "T2", files: ["b"] })], { kind: "small" }), REPOS), "small")).toBe(true);
  expect(has(validatePlan(plan([pt({ wave: 2 })], { kind: "small" }), REPOS), "small")).toBe(true);
});
test("labels unique and T-numbered", () => {
  expect(has(validatePlan(plan([pt(), pt({ files: ["b"], wave: 2 })]), REPOS), "more than once")).toBe(true);
  expect(has(validatePlan(plan([pt({ label: "X" })]), REPOS), "T1, T2")).toBe(true);
});
test("repo must be known", () => {
  expect(has(validatePlan(plan([pt({ repo: "nope" })]), REPOS), "not in the repo list")).toBe(true);
});
test("deps must exist", () => {
  expect(has(validatePlan(plan([pt({ deps: ["T9"] })]), REPOS), "does not exist")).toBe(true);
});
test("dep in same wave refused", () => {
  const r = plan([pt(), pt({ label: "T2", deps: ["T1"], files: ["b"] })]);
  expect(has(validatePlan(r, REPOS), "not in an earlier wave")).toBe(true);
});
test("dep in later wave refused", () => {
  const r = plan([pt({ deps: ["T2"] }), pt({ label: "T2", wave: 2, files: ["b"] })]);
  expect(has(validatePlan(r, REPOS), "not in an earlier wave")).toBe(true);
});
test("cycle refused", () => {
  const r = plan([pt({ deps: ["T2"] }), pt({ label: "T2", wave: 2, deps: ["T1"], files: ["b"] })]);
  expect(has(validatePlan(r, REPOS), "cycle")).toBe(true);
});
test("self dependency refused", () => {
  expect(validatePlan(plan([pt({ deps: ["T1"] })]), REPOS).length).toBeGreaterThan(0);
});
test("waves contiguous from 1", () => {
  expect(has(validatePlan(plan([pt({ wave: 2 })]), REPOS), "no gaps")).toBe(true);
  const r = plan([pt(), pt({ label: "T2", wave: 3, files: ["b"] })]);
  expect(has(validatePlan(r, REPOS), "no gaps")).toBe(true);
});
test("same wave same repo shared file refused", () => {
  const r = plan([pt(), pt({ label: "T2" })]);
  expect(has(validatePlan(r, REPOS), "both change src/a.ts")).toBe(true);
});
test("shared file ok across repos or waves", () => {
  expect(validatePlan(plan([pt(), pt({ label: "T2", repo: "web" })]), REPOS)).toEqual([]);
  expect(validatePlan(plan([pt(), pt({ label: "T2", wave: 2, deps: ["T1"] })]), REPOS)).toEqual([]);
});
test("files non-empty and repo-relative", () => {
  expect(has(validatePlan(plan([pt({ files: [] })]), REPOS), "no files")).toBe(true);
  expect(has(validatePlan(plan([pt({ files: ["/etc/x"] })]), REPOS), "leading")).toBe(true);
  expect(has(validatePlan(plan([pt({ files: ["../x"] })]), REPOS), "..")).toBe(true);
  expect(has(validatePlan(plan([pt({ files: ["a/../../x"] })]), REPOS), "..")).toBe(true);
});
test("list: triage required, covers bugs, rows complete", () => {
  const t = pt({ bugs: [1, 2] });
  expect(has(validatePlan(plan([t], { kind: "list" }), REPOS), "triage row for every bug")).toBe(true);
  const rows = [{ n: 1, text: "a", task: "T1" }];
  expect(has(validatePlan(plan([t], { kind: "list", triage: rows }), REPOS), "Bug 2")).toBe(true);
  const ok = [...rows, { n: 2, text: "b", task: "T1" }, { n: 3, text: "c", verdict: "not_a_bug" as const, why: "works" }];
  expect(validatePlan(plan([t], { kind: "list", triage: ok }), REPOS)).toEqual([]);
});
test("list: row needs task or verdict+why; task must exist", () => {
  const t = pt({ bugs: [1] });
  const bad = [{ n: 1, text: "a", task: "T1" }, { n: 2, text: "b" }, { n: 3, text: "c", verdict: "duplicate" as const }, { n: 4, text: "d", task: "T7" }];
  const probs = validatePlan(plan([t], { kind: "list", triage: bad }), REPOS);
  expect(has(probs, "row 2")).toBe(true);
  expect(has(probs, "row 3")).toBe(true);
  expect(has(probs, "T7")).toBe(true);
});
test("repo_order covers repos with tasks, no extras", () => {
  expect(has(validatePlan(plan([pt()], { repo_order: [] }), REPOS), "missing repo")).toBe(true);
  expect(has(validatePlan(plan([pt()], { repo_order: [{ repo: "api", why: "" }, { repo: "web", why: "" }] }), REPOS), "no task")).toBe(true);
});
test("acceptance non-empty", () => {
  expect(has(validatePlan(plan([pt()], { acceptance: [] }), REPOS), "acceptance")).toBe(true);
  expect(has(validatePlan(plan([pt()], { acceptance: ["  "] }), REPOS), "acceptance")).toBe(true);
});

const prev = (status: "done" | "working" | "removed" = "working") => [
  mkTask({ label: "T1", status: "done" }), mkTask({ label: "T2", status }),
];
const rp = (a: Partial<PlannedTask>, b: Partial<PlannedTask>, extra: PlannedTask[] = []) =>
  plan([pt({ action: "keep", ...a }), pt({ label: "T2", wave: 2, files: ["b"], action: "keep", ...b }), ...extra]);
test("started re-plan: valid", () => {
  const r = rp({}, { action: "update", note: "n" }, [pt({ label: "T3", wave: 2, files: ["c"], action: "add" })]);
  expect(validatePlan(r, REPOS, { tasks: prev(), started: true })).toEqual([]);
});
test("started re-plan: missing label and missing action", () => {
  const r = plan([pt({ action: "keep" })]);
  expect(has(validatePlan(r, REPOS, { tasks: prev(), started: true }), "T2 is missing")).toBe(true);
  const r2 = rp({}, { action: undefined });
  expect(has(validatePlan(r2, REPOS, { tasks: prev(), started: true }), "T2 has no action")).toBe(true);
});
test("started re-plan: done task never remove or redo", () => {
  for (const action of ["remove", "redo"] as const) {
    const r = rp({ action }, {});
    expect(has(validatePlan(r, REPOS, { tasks: prev(), started: true }), "T1 is done")).toBe(true);
  }
  const ok = rp({ action: "reopen" }, {});
  expect(validatePlan(ok, REPOS, { tasks: prev(), started: true })).toEqual([]);
});
test("started re-plan: new labels need add; add cannot reuse", () => {
  const r = rp({}, {}, [pt({ label: "T3", wave: 2, files: ["c"], action: "keep" })]);
  expect(has(validatePlan(r, REPOS, { tasks: prev(), started: true }), "must have the action")).toBe(true);
  const r2 = rp({}, { action: "add" });
  expect(has(validatePlan(r2, REPOS, { tasks: prev(), started: true }), "cannot reuse")).toBe(true);
});
test("started re-plan: removed task is ignored by structure checks; removed label cannot return", () => {
  const r = plan([pt({ action: "keep" }), pt({ label: "T2", wave: 1, files: ["src/a.ts"], action: "remove" })]);
  expect(validatePlan(r, REPOS, { tasks: prev(), started: true })).toEqual([]);
  const r2 = rp({}, { action: "add" });
  expect(has(validatePlan(r2, REPOS, { tasks: prev("removed"), started: true }), "removed earlier")).toBe(true);
});
test("not started: actions are not required", () => {
  expect(validatePlan(plan([pt()]), REPOS, { tasks: [mkTask({ label: "T1", status: "draft" })], started: false })).toEqual([]);
});
test("started re-plan: a kept done task may share a file with its wave; a reopened one may not", () => {
  const keep = rp({}, { wave: 1, files: ["src/a.ts"] });
  expect(validatePlan(keep, REPOS, { tasks: prev(), started: true })).toEqual([]);
  const reopen = rp({ action: "reopen" }, { wave: 1, files: ["src/a.ts"] });
  expect(has(validatePlan(reopen, REPOS, { tasks: prev(), started: true }), "both change src/a.ts")).toBe(true);
});
