// State on disk (atomic write), the event log, and the shared context every core part gets.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.ts";
import type { ClaudeResult, ClaudeRun, Ports } from "../ports.ts";
import type { Plan, PlanEvent, State } from "../types.ts";
import { RESUME_PROMPT } from "./prompts.ts";
import { Deliberate } from "./errors.ts";

export function loadState(dataDir: string): State {
  try {
    const s = JSON.parse(readFileSync(join(dataDir, "state.json"), "utf8")) as State;
    const st: State = { seq: s.seq ?? 0, plans: s.plans ?? {}, tasks: s.tasks ?? {}, ...(s.runs ? { runs: s.runs } : {}) };
    for (const x of [...Object.values(st.plans), ...Object.values(st.tasks)] as any[]) { delete x.activity; delete x.planStep; delete x.uatStep; } // no run survives a restart
    return st;
  } catch { return { seq: 0, plans: {}, tasks: {} }; }
}

export function saveState(dataDir: string, st: State): void {
  mkdirSync(dataDir, { recursive: true });
  const tmp = join(dataDir, "state.json.tmp"), file = join(dataDir, "state.json");
  writeFileSync(tmp, JSON.stringify(st));
  renameSync(tmp, file);
}

export function appendEvent(dataDir: string, e: PlanEvent): void {
  mkdirSync(dataDir, { recursive: true });
  appendFileSync(join(dataDir, "events.jsonl"), JSON.stringify(e) + "\n");
}

export function readEvents(dataDir: string, plan: string, n = 200): PlanEvent[] {
  const file = join(dataDir, "events.jsonl");
  if (!existsSync(file)) return [];
  const out: PlanEvent[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    try { const e = JSON.parse(line) as PlanEvent; if (e.plan === plan) out.push(e); } catch { /* skip a torn line */ }
  }
  return out.slice(-n);
}

const IST = { timeZone: "Asia/Kolkata" } as const;
const RESUME_MS = 6 * 3_600_000; // a run cut longer ago than this starts again instead
export const clock = (at: number) => new Intl.DateTimeFormat("en-US", { ...IST, hour: "numeric", minute: "2-digit", hour12: true }).format(at) + " IST";
const day = (at: number) => new Intl.DateTimeFormat("en-GB", { ...IST, day: "numeric", month: "short", year: "numeric" }).format(at);

const README = `# prflow data folder

- \`state.json\`: the whole current state (plans and tasks). One file, replaced atomically on every change.
- \`events.jsonl\`: one JSON line per step or decision, oldest first. Fields: \`at\` (ms), \`plan\`, \`task\` (when the event belongs to one), \`event\` (name), \`text\` (plain English) and the details.
- \`plans/<planId>.md\`: the readable story of one plan, rewritten on every event: status, versions, tasks, pull requests and a dated timeline in IST.

To understand a plan from start to end, read \`plans/<planId>.md\` first. Use \`events.jsonl\` (filter on \`"plan":"P-01"\`) for the full detail of a step.
`;

function planMarkdown(st: State, p: Plan, events: PlanEvent[]): string {
  const L: string[] = [`# ${p.id} · ${p.title}`, ""];
  L.push(`Status: ${p.error ? `ERROR: ${p.error}` : p.now || "(none)"}`);
  L.push(`Steps: ${(Object.entries(p.steps) as [string, string][]).map(([k, v]) => `${k}=${v || "-"}`).join(", ")}`);
  L.push(`Kind: ${p.kind ?? "not planned yet"}${p.sizeWhy ? ` · ${p.sizeWhy}` : ""} · started: ${p.started ? "yes" : "no"}${p.stopRequested ? " · stop requested" : ""}`, "");
  L.push("## Versions", "");
  for (const v of p.versions) L.push(`### Version ${v.n} · ${day(v.at)}, ${clock(v.at)}`, ...(v.changes.length ? ["Changes:", ...v.changes.map((c) => `- ${c}`)] : []), "", "```text", v.text, "```", "");
  L.push("## Tasks", "");
  for (const id of p.tasks) {
    const t = st.tasks[id];
    if (!t) continue;
    L.push(`- ${t.label} [${t.status}] ${t.title} (repo ${t.repo}, wave ${t.wave}, deps ${t.deps.map((d) => d.split("/")[1]).join(", ") || "none"})`);
    L.push(`  - files: ${t.files.join(", ") || "none"}`, `  - now: ${t.sub}`);
    if (t.did) L.push(`  - did: ${t.did}`);
    if (t.error) L.push(`  - error: ${t.error}`);
    if (t.rounds.length) L.push(`  - rounds: ${t.rounds.map((r) => `${r.n} ${r.source} (${r.blocking.length} blocking, ${r.minor.length} minor)`).join("; ")}`);
  }
  if (p.triage?.length) { L.push("", "## Triage", ""); for (const r of p.triage) L.push(`- Bug ${r.n}: ${r.text} → ${r.task ? `task ${r.task}` : `${r.leftOut?.verdict}: ${r.leftOut?.why}`}`); }
  L.push("", "## Pull requests", "");
  for (const [name, prs] of [["Staging", p.stagingPrs], ["Master", p.masterPrs]] as const) for (const r of prs) L.push(`- ${name} · ${r.repo} #${r.id} ${r.state}${r.merge ? ` (${r.merge})` : ""} ${r.url}${r.why ? ` · order ${r.order}: ${r.why}` : ""}`);
  L.push("", "## Timeline (IST)", "");
  let last = "";
  for (const e of events) {
    const d = day(e.at);
    if (d !== last) { L.push("", `### ${d}`, ""); last = d; }
    L.push(`- ${clock(e.at)} · ${e.task ? String(e.task).split("/").pop() : "plan"} · ${typeof e.text === "string" ? e.text : e.event}`);
  }
  return L.join("\n") + "\n";
}

export function readPlanLog(dataDir: string, planId: string): string | null {
  try { return readFileSync(join(dataDir, "plans", `${planId}.md`), "utf8"); } catch { return null; }
}

export interface Ctx {
  ports: Ports; cfg: Config; st: State; inflight: Set<string>;
  now(): number; sleep(ms: number): Promise<void>;
  change(): void; // save, then tell the UI
  ev(plan: string, event: string, extra?: Record<string, unknown>): void;
  ask(run: Omit<ClaudeRun, "model"> & { wholePlan?: boolean; model?: string }): Promise<ClaudeResult>; // wholePlan: the 1M-context model; model: overrides the role's
  changeSoon(): void; // like change(), at most one save and emit per second
  mutex<T>(key: string, job: () => Promise<T>): Promise<T>;
  tick(): void; // the engine replaces this
  onPlanError?(p: Plan, msg: string, step?: keyof Plan["steps"]): void; // the engine's recovery run
}

export function createCtx(ports: Ports, cfg: Config): Ctx {
  const st = loadState(ports.dataDir);
  const chains = new Map<string, Promise<unknown>>();
  const cache = new Map<string, PlanEvent[]>();
  try { mkdirSync(join(ports.dataDir, "plans"), { recursive: true }); writeFileSync(join(ports.dataDir, "README.md"), README); } catch { /* read-only data dir: the engine still runs */ }
  let lastSave = 0, timer: ReturnType<typeof setTimeout> | null = null;
  const now = () => (ports.now ? ports.now() : Date.now());
  const ctx: Ctx = {
    ports, cfg, st, inflight: new Set(), now,
    sleep: (ms) => (ports.sleep ? ports.sleep(ms) : new Promise((r) => setTimeout(r, ms))),
    change() { saveState(ports.dataDir, st); try { ports.emit?.(st); } catch { /* the UI must not break the engine */ } },
    ev(plan, event, extra = {}) {
      const e: PlanEvent = { ...extra, at: now(), plan, event };
      appendEvent(ports.dataDir, e);
      let list = cache.get(plan);
      if (!list) { list = readEvents(ports.dataDir, plan, Infinity); if (!list.length || list[list.length - 1].at !== e.at || list[list.length - 1].event !== event) list.push(e); cache.set(plan, list); } else list.push(e);
      ports.log?.(`${plan} ${event}`);
      const p = st.plans[plan];
      if (p) try { writeFileSync(join(ports.dataDir, "plans", `${plan}.md`), planMarkdown(st, p, list)); } catch { /* the log must not break the engine */ }
    },
    changeSoon() {
      const wait = 1000 - (Date.now() - lastSave);
      if (wait <= 0) { lastSave = Date.now(); ctx.change(); } else if (!timer) { timer = setTimeout(() => { timer = null; lastSave = Date.now(); ctx.change(); }, wait); timer.unref?.(); }
    },
    async ask(run) {
      if (cfg.terminalOnly && !st.plans[run.plan]?.terminal) throw new Deliberate(`${run.role} is needed, and this engine starts no Claude run: take the plan over from a terminal with ship attach ${run.plan}`);
      if (st.plans[run.plan]?.terminal) throw new Deliberate(`${run.role} is needed, and a terminal plan starts no Claude run here: the terminal does this step`);
      // A task run feeds task.activity; the planner and its architect review feed plan.activity (planner.ts clears it).
      const t = run.task ? st.tasks[run.task] : undefined, p = !run.task && st.plans[run.plan]?.steps.plan === "run" ? st.plans[run.plan] : undefined;
      const target = t ?? p, keep = t ? 10 : 20;
      const onActivity = (line: string) => {
        run.onActivity?.(line);
        if (!target) return;
        (target.activity ??= []).push({ at: now(), line: String(line).slice(0, 200) });
        if (target.activity.length > keep) target.activity.splice(0, target.activity.length - keep);
        ctx.changeSoon();
      };
      const { wholePlan, model: own, ...rest } = run as typeof run & { model?: string }, model = own ?? (wholePlan ? cfg.wholePlanModel : cfg.models[run.role]);
      const runs = (st.runs ??= {}), key = `${run.plan}|${run.task ?? ""}|${run.role}`, cut = runs[key];
      // A writer or debugger changes the code: a cut review of the old code is not resumed.
      if (run.task && (run.role === "executor" || run.role === "debugger")) for (const k of Object.keys(runs)) if (k.startsWith(`${run.plan}|${run.task}|`) && k !== key) delete runs[k];
      try {
        // A run a restart cut carries on in its own session (the caller's own resume, with its own prompt, wins).
        if (cut?.cut && !run.resumeId && now() - cut.at < RESUME_MS) {
          delete runs[key];
          runs[key] = { sid: cut.sid, at: now() }; ctx.change();
          const r = await ports.claude({ ...rest, sessionId: undefined, resumeId: cut.sid, prompt: RESUME_PROMPT, model, onActivity });
          ctx.ev(run.plan, "run_resumed", { task: run.task, text: `${run.role} carried on in its own session after the restart${r.ok && (!run.schema || r.structured) ? "" : ": that failed, so it runs again from the start"}`, role: run.role, sessionId: cut.sid, ok: r.ok });
          if (r.ok && (!run.schema || r.structured)) return r;
        }
        const sid = run.sessionId ?? run.resumeId;
        if (sid) { runs[key] = { sid, at: now() }; ctx.change(); }
        return await ports.claude({ ...rest, model, onActivity });
      } finally { delete runs[key]; if (t?.activity) t.activity = undefined; ctx.change(); }
    },
    mutex(key, job) {
      const prev = chains.get(key) ?? Promise.resolve();
      const next = prev.then(job, job);
      chains.set(key, next.catch(() => {}));
      return next;
    },
    tick() {},
  };
  return ctx;
}
