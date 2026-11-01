// Builders for State, Plan and Task with sane defaults.
import type { Plan, State, Task } from "../types.ts";

export function mkPlan(p: Partial<Plan> = {}): Plan {
  return {
    id: "P-01", title: "Plan", text: "", versions: [], pastedAt: 0, order: 1, acceptance: [], tasks: [], waves: 1, gates: {},
    steps: { plan: "done", tasks: "run", staging: "", uat: "", master: "" }, now: "", tone: "", nowAt: 0,
    started: true, needsStart: false, slug: "plan", repos: [], stagingPrs: [], masterPrs: [], ...p,
  };
}

export function mkTask(t: Partial<Task> = {}): Task {
  const planId = t.planId ?? "P-01", label = t.label ?? "T1";
  return {
    id: `${planId}/${label}`, planId, label, title: label, repo: "api", wave: 1, deps: [], files: [`src/${label}.ts`],
    size: "S", part: "", what: [], checks: [], security: false, status: "waiting", sub: "", notes: [], waitsOn: [], rounds: [], commits: [], ...t,
  };
}

// Plans without a task list get the ids of the tasks that name them.
export function mkState(plans: Plan[], tasks: Task[]): State {
  const s: State = { seq: plans.length, plans: {}, tasks: {} };
  for (const t of tasks) s.tasks[t.id] = t;
  for (const p of plans) s.plans[p.id] = { ...p, tasks: p.tasks.length ? p.tasks : tasks.filter((t) => t.planId === p.id).map((t) => t.id) };
  return s;
}
