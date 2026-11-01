// Every minor finding the task rounds let through: kept for the last review and for you, so none is lost.
import { createHash } from "node:crypto";
import type { Finding, Plan, State, Task } from "../types.ts";

export interface OpenMinor { key: string; task: string; label: string; round: number; finding: Finding; decided?: "accepted" | "sent"; checked?: { still: boolean; harmful: boolean; level?: "harmful" | "minor" | "trivial"; why: string; sent?: boolean; by?: string } }
export type MinorStatus = "fixed" | "harmful" | "minor" | "trivial" | "open" | "accepted" | "sent"; // minor/trivial: the last review's level for one still in the code
// Fixed: a later review found it gone. Sent: back to its task (by you or the last review). Accepted: you kept it.
export function statusOf(m: OpenMinor): MinorStatus {
  if (m.checked && !m.checked.still) return "fixed";
  if (m.decided === "accepted") return "accepted";
  if (m.decided === "sent" || (m.checked?.harmful && m.checked.sent !== false)) return "sent";
  if (m.checked?.harmful) return "harmful";
  if (m.checked?.still && (m.checked.level === "minor" || m.checked.level === "trivial")) return m.checked.level;
  return "open";
}

const norm = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 200);

// From every round of each done task; the same text raised again in a later round counts once (the latest).
export function allMinors(s: State, p: Plan): OpenMinor[] {
  const out = new Map<string, OpenMinor>();
  for (const id of p.tasks) {
    const t = s.tasks[id];
    if (!t || t.status !== "done") continue;
    for (const r of t.rounds) r.minor.forEach((f, i) => {
      out.set(`${t.id}|${norm(f.text)}`, { key: `${t.id}#${r.n}#${i}`, task: t.id, label: t.label, round: r.n, finding: f, decided: p.minorCalls?.[`${t.id}#${r.n}#${i}`], checked: p.minorSweep?.verdicts[`${t.id}#${r.n}#${i}`] });
    });
  }
  // The architect's whole-plan findings, under the label "Architect": the same text counts once (the latest review).
  (p.archFindings ?? []).forEach((run, ri) => run.findings.forEach((f, i) => {
    const key = `${p.id}/architect#${ri + 1}#${i}`;
    out.set(`architect|${norm(f.text)}`, { key, task: `${p.id}/architect`, label: "Architect", round: ri + 1, finding: f, decided: p.minorCalls?.[key], checked: p.minorSweep?.verdicts[key] });
  }));
  return [...out.values()];
}

// Every finding of the plan with its status: the list keeps fixed ones, marked "fixed", so nothing is lost.
export const listMinors = (s: State, p: Plan) => allMinors(s, p).map((m) => ({ ...m, status: statusOf(m) }));

// The last review checks only this plan's own findings: another plan's leftovers stay on that plan.
export function carriedMinors(_s: State, _p: Plan): { plan: Plan; m: OpenMinor }[] { return []; }

export const sweepKey = (ms: OpenMinor[]): string => createHash("sha1").update(ms.map((m) => m.key).sort().join(",")).digest("hex").slice(0, 16);

// What you still decide: not gone in the last review, and not sent back by it as harmful.
export const openMinors = (s: State, p: Plan): OpenMinor[] => allMinors(s, p).filter((m) => !m.checked || (m.checked.still && !(m.checked.harmful && m.checked.sent !== false)));
export const undecided = (s: State, p: Plan): number => openMinors(s, p).filter((m) => !m.decided).length;

// What happened to each blocking finding of a task, round by round: the drawer and the findings list both show it.
export type BlockingStatus = "fixed" | "partly fixed" | "not fixed" | "being fixed" | "sent to planner";
export interface BlockingState { status: BlockingStatus; note?: string }
const SENT = "(Sent to the planner, not this writer) ";
export const planFixKey = (f: Finding) => f.short ?? (f.text.startsWith(SENT) ? f.text.slice(SENT.length) : f.text);
export function blockingStates(p: Plan | undefined, t: Task): BlockingState[][] {
  const reviews = t.rounds.filter((r) => r.source === "review");
  const lastBlocking = [...t.rounds].reverse().find((r) => r.blocking.length);
  return t.rounds.map((r) => {
    // A later finding that names this round as an earlier one means this round's fix was not complete.
    const again = reviews.find((x) => x.n > r.n && [...x.blocking, ...x.minor].some((f) => f.repeat_of_rounds?.includes(r.n)));
    const own = r.blocking.filter((f) => f.fix_in !== "plan" && !f.text.startsWith(SENT)).length;
    return r.blocking.map((f, i) => {
      if (f.fix_in === "plan" || f.text.startsWith(SENT)) {
        const v = p?.versions.find((x) => x.fixes?.includes(planFixKey(f)));
        return { status: "sent to planner", note: v?.fixTasks ? (v.fixTasks.length ? `Plan version ${v.n} changed ${v.fixTasks.join(", ")} for it` : `Plan version ${v.n} took it; no task changed`) : "Waiting for the planner" };
      }
      const said = r.fixed?.[i];
      if (said && /^not fixed/i.test(said)) return { status: "not fixed", note: said }; // the writer's own report, in the form the fix prompt asks for
      if (r === lastBlocking && t.status !== "done") return { status: t.status === "failed" ? "not fixed" : "being fixed", note: said };
      if (again && own === 1) return { status: "partly fixed", note: `Raised again in round ${again.n}${said ? `. Writer: ${said}` : ""}` };
      return { status: "fixed", note: said }; // with several findings, a repeat cannot be tied to one of them
    });
  });
}

// The central findings list: every finding of every review session in every plan, each with its status.
// A blocking finding is fixed once a later round or the task's end passed it; a skipped one keeps its list status.
export interface LedgerRow { plan: string; planTitle: string; label: string; round: number; source: string; by: string; severity: string; category: string; short: string; text: string; file?: string; line?: number; status: string; note?: string; at: number }
export function ledger(s: State): LedgerRow[] {
  const rows: LedgerRow[] = [];
  for (const p of Object.values(s.plans).sort((a, b) => a.order - b.order)) {
    const base = { plan: p.id, planTitle: p.title };
    for (const id of p.tasks) {
      const t = s.tasks[id]; if (!t || t.status === "removed") continue;
      const states = blockingStates(p, t);
      t.rounds.forEach((r, ri) => r.blocking.forEach((f, i) => {
        const b = states[ri]![i]!;
        rows.push({ ...base, label: t.label, round: r.n, source: r.source, by: f.by, severity: "blocking", category: f.category, short: f.short ?? f.text.slice(0, 200), text: f.text, file: f.file, line: f.line, status: b.status, note: b.note, at: r.at });
      }));
    }
    for (const m of listMinors(s, p)) {
      const t = s.tasks[m.task], r = t?.rounds.find((x) => x.n === m.round);
      rows.push({ ...base, label: m.label, round: m.round, source: r?.source ?? "architect", by: m.finding.by, severity: "minor", category: m.finding.category, short: m.finding.short ?? m.finding.text.slice(0, 200), text: m.finding.text, file: m.finding.file, line: m.finding.line, status: m.status, note: m.checked?.why, at: r?.at ?? 0 });
    }
  }
  return rows;
}
