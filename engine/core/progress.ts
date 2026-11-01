// Percent done per plan and for all work. Weights are in DESIGN.md "Progress".
import type { Plan, State, StepState, Task } from "../types.ts";

const stepFactor = (s: StepState) => (s === "done" ? 1 : s === "" ? 0 : 0.5);
const taskFactor = (t: Task) => (t.status === "done" ? 1 : t.status === "review" ? 0.7 : t.status === "working" || t.status === "failed" ? 0.35 : 0);
const live = (state: State, p: Plan) => p.tasks.map((id) => state.tasks[id]).filter((t): t is Task => !!t && t.status !== "removed");

export function planProgress(state: State, planId: string): number {
  const p = state.plans[planId];
  if (!p) return 0;
  const ts = live(state, p);
  const tasks = ts.length ? ts.reduce((a, t) => a + taskFactor(t), 0) / ts.length : p.kind === "port" || (p.kind === "promote" && p.started) ? 1 : 0; // port and promotion plans have no tasks
  const v = p.targetBranch ? 5 * stepFactor(p.steps.plan) + 60 * tasks + 35 * stepFactor(p.steps.staging) // a target plan ends at its merge
    : p.stagingOnly ? 5 * stepFactor(p.steps.plan) + 60 * tasks + 15 * stepFactor(p.steps.staging) + 20 * stepFactor(p.steps.uat) // ends at the staging test
    : 5 * stepFactor(p.steps.plan) + 60 * tasks + 10 * stepFactor(p.steps.staging) + 15 * stepFactor(p.steps.uat) + 10 * stepFactor(p.steps.master);
  return Math.max(0, Math.min(100, Math.round(v)));
}

export function allProgress(state: State): number {
  let sum = 0, weight = 0;
  for (const p of Object.values(state.plans)) {
    const w = Math.max(1, live(state, p).length);
    sum += planProgress(state, p.id) * w;
    weight += w;
  }
  return weight ? Math.round(sum / weight) : 0;
}
