// Checks a PlannerResult. Returns plain-English problems; an empty list means the plan is valid.
import type { PlannedTask, PlannerResult, Task } from "../types.ts";

const KEEP_DONE = new Set(["keep", "update", "reopen"]);

export function validatePlan(r: PlannerResult, repos: string[], prev?: { tasks: Task[]; started: boolean }): string[] {
  const p: string[] = [];
  const all = r.tasks || [];
  const seen = new Set<string>();
  for (const t of all) {
    if (!/^T\d+$/.test(t.label)) p.push(`Task label "${t.label}" must look like T1, T2, ...`);
    if (seen.has(t.label)) p.push(`Task label ${t.label} is used more than once.`);
    seen.add(t.label);
  }
  if (!all.length) p.push("The plan has no tasks.");
  if (!r.acceptance || !r.acceptance.some((a) => a.trim())) p.push("The plan has no acceptance checks.");

  const replan = !!prev?.started;
  // A task being removed in a re-plan takes no part in the structure checks.
  const tasks = replan ? all.filter((t) => t.action !== "remove") : all;
  const labels = new Set(tasks.map((t) => t.label));
  const byLabel = new Map(tasks.map((t) => [t.label, t]));

  if (r.kind === "small" && (tasks.length !== 1 || tasks[0].wave !== 1)) p.push("A small plan must have exactly 1 task, in wave 1.");

  const waves = [...new Set(tasks.map((t) => t.wave))].sort((a, b) => a - b);
  if (tasks.some((t) => !Number.isInteger(t.wave) || t.wave < 1)) p.push("Every wave must be a whole number from 1.");
  else if (waves.some((w, i) => w !== i + 1)) p.push(`Waves must run 1, 2, 3 with no gaps. Found: ${waves.join(", ")}.`);

  for (const t of tasks) {
    if (!repos.includes(t.repo)) p.push(`Task ${t.label} uses repo "${t.repo}", which is not in the repo list.`);
    if (!t.files?.length) p.push(`Task ${t.label} has no files.`);
    for (const f of t.files || []) {
      if (!f || f.startsWith("/") || f.split("/").includes("..")) p.push(`Task ${t.label} has file "${f}". Files must be paths inside the repo (no leading "/", no "..").`);
    }
    for (const d of t.deps || []) {
      const dt = byLabel.get(d);
      if (!dt) { p.push(`Task ${t.label} depends on ${d}, which does not exist.`); continue; }
      if (dt.wave >= t.wave) p.push(`Task ${t.label} depends on ${d}, but ${d} is not in an earlier wave.`);
    }
  }

  const cycle = findCycle(tasks);
  if (cycle) p.push(`Dependency cycle: ${cycle.join(" -> ")}.`);

  // A done task kept as it is never runs again, so it can share a file with a task of its wave.
  const settled = new Set((replan ? prev!.tasks : []).filter((o) => o.status === "done" && byLabel.get(o.label)?.action === "keep").map((o) => o.label));
  for (let i = 0; i < tasks.length; i++) for (let j = i + 1; j < tasks.length; j++) {
    const a = tasks[i], b = tasks[j];
    if (a.wave !== b.wave || a.repo !== b.repo || settled.has(a.label) || settled.has(b.label)) continue;
    const f = (a.files || []).find((x) => (b.files || []).includes(x));
    if (f) p.push(`Tasks ${a.label} and ${b.label} both change ${f} in wave ${a.wave}. Put them in different waves or merge them.`);
  }

  if (r.kind === "list") {
    const tri = r.triage || [];
    if (!tri.length) p.push("A bug list needs a triage row for every bug.");
    const rows = new Set(tri.map((x) => x.n));
    for (const n of new Set(tasks.flatMap((t) => t.bugs || []))) if (!rows.has(n)) p.push(`Bug ${n} has a task but no triage row.`);
    for (const row of tri) {
      if (row.task) { if (!labels.has(row.task)) p.push(`Triage row ${row.n} points to task ${row.task}, which does not exist.`); }
      else if (!row.verdict || !row.why?.trim()) p.push(`Triage row ${row.n} needs a task, or a verdict and a reason.`);
    }
  }

  const ordered = (r.repo_order || []).map((x) => x.repo);
  const used = new Set(tasks.map((t) => t.repo));
  for (const repo of used) if (!ordered.includes(repo)) p.push(`repo_order is missing repo "${repo}", which has a task.`);
  for (const repo of new Set(ordered)) if (!used.has(repo)) p.push(`repo_order lists repo "${repo}", which has no task.`);
  if (new Set(ordered).size !== ordered.length) p.push("repo_order lists a repo more than once.");

  if (replan) replanChecks(all, prev!.tasks, p);
  return p;
}

function replanChecks(all: PlannedTask[], prev: Task[], p: string[]) {
  const old = new Map(prev.map((t) => [t.label, t]));
  const byLabel = new Map(all.map((t) => [t.label, t]));
  for (const o of prev) {
    const n = byLabel.get(o.label);
    if (o.status === "removed") { if (n) p.push(`Task ${o.label} was removed earlier. Use a new label instead.`); continue; }
    if (!n) { p.push(`Existing task ${o.label} is missing from the plan. Give it an action.`); continue; }
    if (!n.action) p.push(`Existing task ${o.label} has no action.`);
    else if (n.action === "add") p.push(`Task ${o.label} already exists. "add" cannot reuse its label.`);
    else if (o.status === "done" && !KEEP_DONE.has(n.action)) p.push(`Task ${o.label} is done and merged. It can only be kept, updated or reopened, not "${n.action}".`);
  }
  for (const n of all) if (!old.has(n.label) && n.action !== "add") p.push(`New task ${n.label} must have the action "add".`);
}

function findCycle(tasks: PlannedTask[]): string[] | null {
  const deps = new Map(tasks.map((t) => [t.label, t.deps || []]));
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (l: string): string[] | null => {
    state.set(l, 1); stack.push(l);
    for (const d of deps.get(l) || []) {
      if (!deps.has(d)) continue;
      if (state.get(d) === 1) return [...stack.slice(stack.indexOf(d)), d];
      if (!state.has(d)) { const c = visit(d); if (c) return c; }
    }
    stack.pop(); state.set(l, 2);
    return null;
  };
  for (const l of deps.keys()) if (!state.has(l)) { const c = visit(l); if (c) return c; }
  return null;
}
