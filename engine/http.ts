// HTTP handler for /api/prflow/*. The host mounts it and supplies the write check.
import { allProgress, planProgress } from "./core/progress.ts";
import { blockingStates, ledger, listMinors } from "./core/minors.ts";
import type { Engine } from "./core/engine.ts";

const MAX_BODY = 200 * 1024;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fail = (error: string, status = 400) => json({ ok: false, error }, status);

export function createHandler(engine: Engine, opts: { base?: string; checkWrite: (req: Request) => string | null }) {
  const base = (opts.base ?? "/api/prflow").replace(/\/$/, "");
  return async (req: Request, url: URL): Promise<Response | null> => {
    if (url.pathname !== base && !url.pathname.startsWith(`${base}/`)) return null;
    const parts = url.pathname.slice(base.length).split("/").filter(Boolean);

    if (req.method === "GET") {
      if (parts.length === 1 && parts[0] === "state") {
        const s = engine.state();
        const plans = Object.values(s.plans).filter((p) => !p.hidden).sort((a, b) => a.order - b.order);
        return json({ plans, tasks: s.tasks, progress: { all: allProgress(s), plans: Object.fromEntries(plans.map((p) => [p.id, planProgress(s, p.id)])) }, minors: Object.fromEntries(plans.map((p) => [p.id, listMinors(s, p)])), blocking: Object.fromEntries(Object.values(s.tasks).filter((t) => t.rounds.some((r) => r.blocking.length)).map((t) => [t.id, blockingStates(s.plans[t.planId], t)])), config: { maxTasks: engine.config.maxTasks, buildEachTask: engine.config.buildEachTask } });
      }
      if (parts.length === 1 && parts[0] === "findings") return json(ledger(engine.state()));
      if (parts.length === 3 && parts[0] === "plans" && parts[2] === "events") return json(engine.events(parts[1]!));
      if (parts.length === 3 && parts[0] === "plans" && parts[2] === "log") {
        const md = engine.log(parts[1]!);
        return md === null ? fail("There is no log for this plan.", 404) : new Response(md, { headers: { "content-type": "text/markdown; charset=utf-8" } });
      }
      return fail("Not found.", 404);
    }
    if (req.method !== "POST" || parts[0] !== "plans") return fail("Not found.", 404);

    const denied = opts.checkWrite(req);
    if (denied) return fail(denied, 403);
    const raw = await req.text();
    if (new TextEncoder().encode(raw).length > MAX_BODY) return fail("The text is too long (200 KB at most).", 413);
    let body: any = {};
    if (raw.trim()) { try { body = JSON.parse(raw); } catch { return fail("The request is not valid JSON."); } }
    if (body === null || typeof body !== "object") return fail("The request must be a JSON object.");

    try {
      if (parts.length === 2 && parts[1] === "port") return json({ id: await engine.port(body) });
      if (parts.length === 2 && parts[1] === "promote") return json({ id: await engine.promote(body) });
      if (parts.length === 1) {
        if (typeof body.text !== "string" || !body.text.trim()) return fail("Send the text in the \"text\" field.");
        if (body.targetBranch !== undefined && typeof body.targetBranch !== "string") return fail("Send \"targetBranch\" as a branch name.");
        return json({ id: engine.submit(body.text, { targetBranch: body.targetBranch }) });
      }
      const id = parts[1]!, act = parts[2];
      if (parts.length !== 3) return fail("Not found.", 404);
      if (act === "edit") { if (typeof body.text !== "string") return fail("Send the text in the \"text\" field."); if (body.replace === true) engine.edit(id, body.text); else engine.editOrQueue(id, body.text, Array.isArray(body.tasks) ? body.tasks.filter((x: unknown): x is string => typeof x === "string") : undefined); } // API edits append (queued while the plan is busy); the edit dialog sends the whole text with replace
      else if (act === "start") engine.start(id);
      else if (act === "stop") engine.stop(id);
      else if (act === "delete") engine.hide(id); // the page only hides a plan
      else if (act === "retry") engine.retry(id);
      else if (act === "db-done") engine.dbDone(id);
      else if (act === "uat-session") { if (typeof body.sessionId !== "string") return fail("Send \"sessionId\"."); engine.setUatSession(id, body.sessionId); }
      else if (act === "staging-only") { if (typeof body.on !== "boolean") return fail("Send \"on\" as true or false."); engine.setStagingOnly(id, body.on); }
      else if (act === "ticket") { if (typeof body.ticket !== "string") return fail("Send the ticket number in the \"ticket\" field."); engine.setTicket(id, body.ticket); }
      else if (act === "target") { if (typeof body.branch !== "string") return fail("Send the branch in the \"branch\" field (empty for staging)."); await engine.setTarget(id, body.branch); }
      else if (act === "send-back") { if (typeof body.task !== "string" || typeof body.text !== "string") return fail("Send \"task\" (a label such as T14) and \"text\" (what is wrong)."); engine.sendBackTask(id, body.task, body.text); }
      else if (act === "minor") { if (typeof body.key !== "string" || (body.choice !== "accept" && body.choice !== "send")) return fail("Send \"key\" (the finding) and \"choice\" (\"accept\" or \"send\")."); engine.decideMinor(id, body.key, body.choice); }
      else if (act === "keep") { if (typeof body.task !== "string") return fail("Send the task id in the \"task\" field."); engine.keepCode(id, body.task); }
      else if (act === "merge-master") await engine.mergeMaster(id, { prodWrites: body.prodWrites === true });
      else if (act === "release-steps") await engine.setReleaseSteps(id, body.steps);
      else if (act === "fix-anyway") { if (!Number.isInteger(body.n)) return fail("Send the bug number in the \"n\" field."); engine.fixAnyway(id, body.n); }
      else if (act === "order") {
        if (body.before !== null && typeof body.before !== "string") return fail("Send \"before\" as a plan id or null.");
        engine.reorder(id, body.before);
      } else return fail("Not found.", 404);
      return json({ ok: true });
    } catch (e) { return fail(e instanceof Error ? e.message : String(e)); }
  };
}
