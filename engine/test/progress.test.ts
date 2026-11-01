import { expect, test } from "bun:test";
import { allProgress, planProgress } from "../core/progress.ts";
import { mkPlan, mkState, mkTask } from "./fixtures.ts";

const st = (statuses: string[], planO = {}, planId = "P-01") =>
  statuses.map((s, i) => mkTask({ planId, label: `T${i + 1}`, status: s as any }));

test("fresh plan: only plan step counts half", () => {
  const p = mkPlan({ steps: { plan: "run", tasks: "", staging: "", uat: "", master: "" } });
  expect(planProgress(mkState([p], st(["draft", "draft"])), "P-01")).toBe(3);
});
test("plan step done, drafts and waiting count 0", () => {
  const s = mkState([mkPlan()], st(["draft", "waiting"]));
  expect(planProgress(s, "P-01")).toBe(5);
});
test("task weights: working .35, failed .35, review .7, done 1", () => {
  expect(planProgress(mkState([mkPlan()], st(["working"])), "P-01")).toBe(26);
  expect(planProgress(mkState([mkPlan()], st(["failed"])), "P-01")).toBe(26);
  expect(planProgress(mkState([mkPlan()], st(["review"])), "P-01")).toBe(47);
  expect(planProgress(mkState([mkPlan()], st(["done"])), "P-01")).toBe(65);
});
test("mix averages over tasks", () => {
  expect(planProgress(mkState([mkPlan()], st(["done", "draft"])), "P-01")).toBe(35);
  expect(planProgress(mkState([mkPlan()], st(["done", "working", "review", "draft"])), "P-01")).toBe(5 + Math.round(60 * (2.05 / 4)) );
});
test("removed tasks do not count", () => {
  expect(planProgress(mkState([mkPlan()], st(["done", "removed"])), "P-01")).toBe(65);
});
test("steps: done 1, run/fail/you half", () => {
  const steps = (staging: any, uat: any, master: any) => mkPlan({ steps: { plan: "done", tasks: "done", staging, uat, master } });
  const t = st(["done"]);
  expect(planProgress(mkState([steps("done", "done", "you")], t), "P-01")).toBe(65 + 10 + 15 + 5);
  expect(planProgress(mkState([steps("done", "done", "done")], t), "P-01")).toBe(100);
  expect(planProgress(mkState([steps("run", "", "")], t), "P-01")).toBe(70);
  expect(planProgress(mkState([steps("fail", "", "")], t), "P-01")).toBe(70);
});
test("unknown plan and no tasks", () => {
  expect(planProgress(mkState([], []), "x")).toBe(0);
  expect(planProgress(mkState([mkPlan()], []), "P-01")).toBe(5);
});
test("allProgress: weighted by task count, at least 1", () => {
  const p1 = mkPlan({ id: "P-01" }), p2 = mkPlan({ id: "P-02", order: 2 });
  const tasks = [...st(["done", "done", "done"], {}, "P-01"), ...st(["draft"], {}, "P-02")];
  const s = mkState([p1, p2], tasks);
  expect(planProgress(s, "P-01")).toBe(65);
  expect(planProgress(s, "P-02")).toBe(5);
  expect(allProgress(s)).toBe(Math.round((65 * 3 + 5) / 4));
});
test("allProgress: empty plan weighs 1; no plans is 0", () => {
  const s = mkState([mkPlan({ id: "P-01" }), mkPlan({ id: "P-02", order: 2 })], st(["done", "done"], {}, "P-01"));
  expect(allProgress(s)).toBe(Math.round((65 * 2 + 5) / 3));
  expect(allProgress(mkState([], []))).toBe(0);
});
