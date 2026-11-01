// Terminal plans (/ship, the ship-flow plugin): routes the `ship` CLI and the plugin's hooks call under /api/prflow/terminal/*.
// The terminal session and its subagents do every Claude step; the engine runs the fixed ones. This backend has no test runner.
import type { Engine } from "./core/engine.ts";
import type { Plan, Task, TerminalAgent } from "./types.ts";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const fail = (error: string, status = 400) => json({ ok: false, error }, status);
const BASE = "/api/prflow/terminal";
const NO_RUNNER_SHORT = "This backend has no test runner, so it cannot run queries or test calls. Check the change yourself, then answer with ship uat-answer.";
export const TERMINAL_HOOK = `${BASE}/hook`; // no token: it only updates what the page shows

const finished = (p: Plan) => p.steps.master === "done" || !!p.landedAt || (!!p.stagingOnly && p.steps.uat === "done");
const live = (e: Engine, p: Plan) => p.tasks.map((id) => e.state().tasks[id]).filter((t): t is Task => !!t && t.status !== "removed");
const seen = (t: Task): number => (t as any)._seen ?? 0;

// What the terminal must act on now. key: changes when the item is new, so `ship wait` prints only what is new.
export function todo(e: Engine, p: Plan) {
  const items: Record<string, unknown>[] = [];
  if (p.error) items.push({ key: `error:${p.nowAt}`, kind: "error", text: p.error, step: (Object.keys(p.steps) as (keyof Plan["steps"])[]).find((k) => p.steps[k] === "fail") });
  for (const t of live(e, p)) {
    const part = p.repos.find((r) => r.repo === t.repo);
    if (t.status === "working" && t.terminal?.readyAt && !t.terminal.done)
      items.push({ key: `task:${t.label}:${t.terminal.readyAt}`, kind: "task", task: t.label, title: t.title, repo: t.repo, dir: t.dir, branch: t.branch, planBranch: part?.branch,
        sentBack: t.notes.length > seen(t), notes: t.notes.slice(seen(t)), what: t.what, checks: t.checks, files: t.files, security: t.security, rounds: t.rounds.length });
    if (t.status === "failed") items.push({ key: `failed:${t.label}:${t.error}`, kind: "task_failed", task: t.label, error: t.error });
  }
  const u = p.terminal?.uat;
  if (u && !u.answer) items.push({ key: `uat:${u.askedAt}`, kind: "uat", acceptance: p.acceptance, last: p.uat?.checks ?? [], stagingPrs: p.stagingPrs.map((r) => `${r.repo} #${r.id} ${r.state}`),
    repos: p.repos.map((r) => ({ repo: r.repo, dir: r.dir, branch: r.branch, base: r.base, commits: r.stagingCommits })), tasks: live(e, p).map((t) => ({ label: t.label, repo: t.repo, title: t.title, did: t.did })) });
  const po = p.terminal?.port;
  if (po && !po.answer) items.push({ key: `port:${po.askedAt}`, kind: "port", repo: po.repo, master: po.master, dir: po.dir, commit: po.commit, files: po.files, commitText: po.commitText });
  const sw = p.terminal?.sweep;
  if (sw && !sw.answer) items.push({ key: `sweep:${sw.askedAt}`, kind: "sweep", items: sw.items, repos: p.repos.map((r) => ({ repo: r.repo, dir: r.dir, branch: r.branch, base: r.base })) });
  if (p.steps.master === "you") items.push({ key: `master:${p.masterPrs.map((r) => r.id).join(",")}`, kind: "master_ready", prs: p.masterPrs.map((r) => `${r.repo} #${r.id} ${r.url}`) });
  if (finished(p)) items.push({ key: "finished", kind: "finished", text: p.now });
  return { plan: p.id, title: p.title, now: p.now, steps: p.steps, items,
    tasks: live(e, p).map((t) => ({ label: t.label, repo: t.repo, status: t.status, sub: t.sub, deps: t.deps.map((d) => d.split("/").pop()), dir: t.dir })) };
}

const base = (s: string) => s.split("/").pop() ?? s;
function line(tool: string, input: any): string {
  const i = input ?? {};
  const s = tool === "Bash" ? `Bash: ${i.description || i.command || ""}` : ["Read", "Edit", "Write", "NotebookEdit"].includes(tool) ? `${tool} ${base(String(i.file_path ?? ""))}`
    : tool === "Grep" ? `Grep ${i.pattern ?? ""}` : tool === "Glob" ? `Glob ${i.pattern ?? ""}` : tool === "Agent" ? `Agent ${i.subagent_type ?? ""}: ${i.description ?? ""}`
      : tool === "SendMessage" ? `SendMessage to ${i.to ?? ""}` : tool;
  return s.replace(/\s+/g, " ").slice(0, 180);
}
const labelIn = (s?: string) => /\b(T\d+)\b/.exec(s ?? "")?.[1];

// One Claude Code hook event from a terminal that owns a plan: the master's and each subagent's latest action.
export function onHook(e: Engine, h: any): boolean {
  const sid = String(h?.session_id ?? ""), name = String(h?.hook_event_name ?? "");
  const p = Object.values(e.state().plans).filter((x) => x.terminal?.session === sid && !finished(x)).sort((a, b) => b.order - a.order)[0];
  if (!p) return false;
  const now = Date.now(), aid = h.agent_id ? String(h.agent_id) : undefined;
  e.terminalUpdate(p.id, (term) => {
    term.lastSeenAt = now;
    const find = (id?: string) => (id ? term.agents.find((a) => a.id === id) : undefined);
    const toTask = (a: TerminalAgent | undefined, text: string) => {
      const t = a?.task ? e.state().tasks[`${p.id}/${a.task}`] : undefined;
      if (!t) return;
      (t.activity ??= []).push({ at: now, line: `${a!.type}: ${text}`.slice(0, 200) });
      if (t.activity.length > 10) t.activity.splice(0, t.activity.length - 10);
    };
    if (name === "PreToolUse" && !aid && h.tool_name === "Agent") {
      const i = h.tool_input ?? {};
      (term.pending ??= []).push({ desc: String(i.description ?? ""), type: String(i.subagent_type ?? "general-purpose"), model: i.model ? String(i.model) : undefined, at: now });
      term.pending = term.pending.slice(-20);
    }
    if (name === "SubagentStart" && aid) {
      const q = term.pending ?? [], k = Math.max(0, q.findIndex((x) => x.type === h.agent_type)), pend = q.splice(k, 1)[0];
      const a: TerminalAgent = { id: aid, type: String(h.agent_type ?? pend?.type ?? "agent"), desc: pend?.desc, task: labelIn(pend?.desc), model: pend?.model, startedAt: now, tools: 0 };
      term.agents = [a, ...term.agents.filter((x) => x.id !== aid)].slice(0, 60);
      toTask(a, `started: ${a.desc ?? ""}`);
    }
    if (name === "PreToolUse" && aid) {
      let a = find(aid);
      if (!a) { a = { id: aid, type: String(h.agent_type ?? "agent"), startedAt: now, tools: 0 }; term.agents.unshift(a); }
      a.doing = line(h.tool_name, h.tool_input); a.doingAt = now; a.tools++; a.endedAt = undefined;
      toTask(a, a.doing);
    }
    if (name === "SubagentStop" && aid) {
      const a = find(aid);
      if (a) { a.endedAt = now; a.doing = undefined; a.result = String(h.last_assistant_message ?? "").replace(/\s+/g, " ").slice(0, 400) || undefined; toTask(a, "finished"); }
    }
    if (name === "PreToolUse" && !aid) {
      term.master = { line: line(h.tool_name, h.tool_input), at: now };
      if (h.tool_name === "SendMessage") { const to = String(h.tool_input?.to ?? ""), a = term.agents.find((x) => x.id === to || x.desc === to); if (a) { a.endedAt = undefined; a.doing = "continued by the master"; a.doingAt = now; } }
    }
  }, name === "SubagentStart" || name === "SubagentStop");
  return true;
}

const NO_RUNNER = "This backend has no test runner. Check the change on your staging or work environment yourself (curl, the browser, the project's own scripts), then answer with ship uat-answer.";
export const UAT_GUIDE = NO_RUNNER;

// /api/prflow/terminal/*: null when the path is not ours. noProd(repo): the repo has no production branch.
export async function terminalRoute(e: Engine, req: Request, url: URL, opts: { noProd?: (repo: string) => boolean } = {}): Promise<Response | null> {
  if (!url.pathname.startsWith(`${BASE}/`)) return null;
  const parts = url.pathname.slice(BASE.length).split("/").filter(Boolean);
  const planOf = (id: string) => { const p = e.state().plans[id]; if (!p?.terminal) throw new Error(`${id} is not a terminal plan.`); return p; };
  try {
    if (req.method === "GET") {
      if (parts[0] === "uat-guide") return json({ prompt: UAT_GUIDE, schema: {} });
      if (parts[0] === "todo" && parts[1]) return json(todo(e, planOf(parts[1])));
      return fail("Not found.", 404);
    }
    if (req.method !== "POST") return fail("Not found.", 404);
    let body: any = {};
    const raw = await req.text();
    if (raw.length > 400_000) return fail("Too long.", 413);
    if (raw.trim()) { try { body = JSON.parse(raw); } catch { return fail("The request is not valid JSON."); } }
    if (parts[0] === "hook") return json({ ok: true, used: onHook(e, body) });
    if (parts[0] === "adopt") {
      if (!body.plan || typeof body.session !== "string" || !body.session) return fail("Send \"plan\" (the planner JSON) and \"session\" (CLAUDE_CODE_SESSION_ID).");
      const repos = [...new Set<string>((Array.isArray(body.plan.tasks) ? body.plan.tasks : []).filter((t: any) => t?.action !== "remove").map((t: any) => String(t?.repo)))];
      const stagingOnly = body.stagingOnly === true || (!!repos.length && !!opts.noProd && repos.every(opts.noProd)); // no prod branch anywhere: nothing to go live
      return json({ ok: true, id: await e.adopt(body.plan, { session: body.session, cwd: body.cwd }, { text: body.text, stagingOnly }) });
    }
    if (parts[0] === "query") return fail(NO_RUNNER_SHORT);
    if (parts[1] === "attach") {
      if (typeof body.session !== "string" || !body.session) return fail("Send \"session\" (CLAUDE_CODE_SESSION_ID).");
      e.attach(parts[0]!, { session: body.session, cwd: body.cwd }); return json({ ok: true });
    }
    const p = planOf(parts[0] ?? ""), act = parts[1];
    if (act === "done") { e.taskDone(p.id, String(body.task), String(body.did ?? "")); return json({ ok: true }); }
    if (act === "round") return json({ ok: true, round: e.addRound(p.id, String(body.task), body) });
    if (act === "replan") return json({ ok: true, changes: await e.replanPatch(p.id, body) });
    if (act === "note") { e.terminalUpdate(p.id, (t) => { t.master = { line: String(body.text ?? "").slice(0, 300), at: Date.now() }; }, true); e.note(p.id, "terminal_note", { text: `Terminal: ${String(body.text ?? "").slice(0, 300)}` }); return json({ ok: true }); }
    if (act === "uat-run" || act === "uat-recheck") return fail(NO_RUNNER_SHORT);
    if (act === "uat-answer") { e.uatAnswer(p.id, body); return json({ ok: true }); }
    if (act === "port-answer") { e.portAnswer(p.id, body.ok !== false, body.note); return json({ ok: true }); }
    if (act === "sweep-answer") { e.sweepAnswer(p.id, body.items); return json({ ok: true }); }
    return fail("Not found.", 404);
  } catch (err) { return fail(err instanceof Error ? err.message : String(err)); }
}
