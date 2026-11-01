// Pure scheduler: decides what the engine starts next. Rules are in DESIGN.md "Scheduler".
import { actionKey, type Action, type Plan, type State, type Task } from "../types.ts";
import type { Config } from "../config.ts";
import { waitsOnFor } from "./locks.ts";

const byWaveLabel = (a: Task, b: Task) => a.wave - b.wave || a.label.localeCompare(b.label, undefined, { numeric: true });
const OPEN = new Set(["draft", "waiting", "working", "review", "failed"]);
// A task held for a plan change waits while that change is still queued or being planned.
export const heldNow = (p: Plan, t: Task): boolean => !!t.heldForPlan && (p.steps.plan === "run" || !!p.planFixes?.length);

export function nextActions(state: State, cfg: Config, inflight: Set<string>): { actions: Action[]; waitsOn: Record<string, string[]> } {
  const actions: Action[] = [];
  const waitsOn: Record<string, string[]> = {};
  for (const t of Object.values(state.tasks)) if (t.status === "waiting") waitsOn[t.id] = waitsOnFor(state, t.id);

  const busy = new Set<string>();
  for (const t of Object.values(state.tasks)) if (t.status === "working" || t.status === "review") busy.add(t.id);
  for (const k of inflight) if (k.startsWith("task:")) busy.add(k.slice(5));
  let planning = [...inflight].filter((k) => k.startsWith("plan:")).length;
  const push = (a: Action) => { if (!inflight.has(actionKey(a))) actions.push(a); };

  const plans = Object.values(state.plans).sort((a, b) => a.order - b.order);
  for (const p of plans) {
    if (p.error || p.stopRequested) continue;
    const held = !!p.retryAt; // a transient failure waits for its next try
    if (!held && p.steps.plan === "run" && !inflight.has(`plan:${p.id}`) && planning < cfg.maxPlanning) { planning++; push({ kind: "plan", plan: p.id }); }
    const tasks = p.tasks.map((id) => state.tasks[id]).filter((t): t is Task => !!t && t.status !== "removed").sort(byWaveLabel);
    // Tasks keep starting during a re-plan: the new version adds a note to a running task or redoes it (planner.ts).
    for (const t of tasks) {
      if (t.status !== "waiting" || t.retryAt || inflight.has(`task:${t.id}`) || busy.size >= cfg.maxTasks || heldNow(p, t)) continue;
      if (!t.deps.every((d) => state.tasks[d]?.status === "done")) continue;
      // A task starts once its own deps are done; waves gate starts only when every wave builds (buildEachTask).
      // Only waves that hold tasks get a gate: an empty wave (a re-plan moved its tasks) never blocks.
      const gated = !cfg.buildEachTask || tasks.every((u) => u.wave >= t.wave || p.gates[u.wave]);
      if (!gated || waitsOn[t.id]?.length) continue;
      // Two tasks of one plan may share a file once one was done (locks.canClaim); they never run at the same time.
      if (tasks.some((u) => u.id !== t.id && u.repo === t.repo && busy.has(u.id) && u.files.some((f) => t.files.includes(f)))) continue;
      busy.add(t.id);
      push({ kind: "task", task: t.id });
    }
    if (!held) pipeline(p, tasks, push);
  }
  return { actions, waitsOn };
}

function pipeline(p: Plan, tasks: Task[], push: (a: Action) => void) {
  if (!p.started) return;
  const waves = [...new Set(tasks.map((t) => t.wave))].sort((a, b) => a - b);
  // A gate waits for every earlier gate: a reopened wave 1 must pass again before wave 2 is gated.
  for (const w of waves) if (!p.gates[w] && waves.filter((v) => v < w).every((v) => p.gates[v]) && tasks.filter((t) => t.wave === w).every((t) => t.status === "done")) push({ kind: "gate", plan: p.id, wave: w });
  const quiet = (tasks.length > 0 || p.kind === "promote") && !tasks.some((t) => OPEN.has(t.status)) && waves.every((w) => p.gates[w]); // a promotion has no tasks
  // Nothing merges while a re-plan is pending: a plan fix (e.g. an architect finding no task owns) may add a task first.
  if (p.steps.plan === "run" || p.planFixes?.length) return;
  if (quiet && (p.steps.staging === "" || p.steps.staging === "run")) push({ kind: "staging", plan: p.id });
  if (p.targetBranch) return; // a target plan ends when it is merged into its branch: no staging test, no master PRs
  if (p.steps.staging === "done" && (p.steps.uat === "" || p.steps.uat === "run")) push({ kind: "uat", plan: p.id });
  if (p.steps.uat === "done" && p.steps.master === "" && !p.stagingOnly) push({ kind: "master", plan: p.id }); // staging only: it ends here
}
