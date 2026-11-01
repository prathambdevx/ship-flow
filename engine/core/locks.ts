// Cross-plan file locks: an earlier plan holds a file until its repo part reaches staging (or the target branch both plans share).
import type { State, Task } from "../types.ts";

const base = (f: string) => f.split("/").pop() || f;

interface Hold { task: Task; shared: string[] }

function holders(state: State, planId: string, taskId: string, repo: string, files: string[]): Hold[] {
  const mine = state.plans[planId];
  if (!mine) return [];
  const out: { hold: Hold; order: number }[] = [];
  for (const u of Object.values(state.tasks)) {
    if (u.id === taskId || u.planId === planId || u.status === "removed" || u.repo !== repo) continue;
    const a = state.plans[u.planId];
    if (!a || a.order >= mine.order) continue;
    if ((a.targetBranch ?? "") !== (mine.targetBranch ?? "")) continue; // only plans that merge into the same branch wait for each other
    if (a.repos.find((r) => r.repo === repo)?.staged) continue;
    const shared = files.filter((f) => u.files.includes(f));
    if (shared.length) out.push({ hold: { task: u, shared }, order: a.order });
  }
  out.sort((x, y) => x.order - y.order || x.hold.task.id.localeCompare(y.hold.task.id, undefined, { numeric: true }));
  return out.map((o) => o.hold);
}

export function waitsOnFor(state: State, taskId: string): string[] {
  const t = state.tasks[taskId];
  return t ? holders(state, t.planId, t.id, t.repo, t.files).map((h) => h.task.id) : [];
}

export function lockLine(state: State, taskId: string): string | null {
  const t = state.tasks[taskId];
  const h = t && holders(state, t.planId, t.id, t.repo, t.files)[0];
  return h ? `Waits for ${h.task.planId} to reach ${state.plans[h.task.planId]?.targetBranch ?? "staging"} (${base(h.shared[0])})` : null;
}

// True when `u` depends on `on`, directly or through other tasks.
function after(state: State, u: Task, on: string, seen = new Set<string>()): boolean {
  for (const d of u.deps) {
    if (d === on) return true;
    const n = state.tasks[d];
    if (n && !seen.has(d) && (seen.add(d), after(state, n, on, seen))) return true;
  }
  return false;
}

export function canClaim(state: State, task: Task, files: string[]): string | null {
  for (const u of Object.values(state.tasks)) {
    // A done task is merged into the plan branch, and the claimer rebases onto it, so its files are free.
    if (u.id === task.id || u.planId !== task.planId || u.repo !== task.repo || u.status === "removed" || u.status === "done") continue;
    // A task that waits on the claimer starts only after it is merged, and rebases onto it, so its files are free too.
    if (u.status === "waiting" && !u.commits.length && after(state, u, task.id)) continue;
    const f = files.find((x) => u.files.includes(x));
    if (f) return `${base(f)} already belongs to task ${u.label} of this plan`;
  }
  const h = holders(state, task.planId, task.id, task.repo, files)[0];
  return h ? `${base(h.shared[0])} is held by ${h.task.planId}, which has not reached ${state.plans[h.task.planId]?.targetBranch ?? "staging"} yet` : null;
}
