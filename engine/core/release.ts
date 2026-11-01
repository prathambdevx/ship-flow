// Release steps: the prod SQL, config edit and library tag check that Merge runs around the release pipeline run.
import { createHash } from "node:crypto";
import type { Plan, PreflightCheck, PrRef, ReleaseStep } from "../types.ts";
import { setNow } from "./planner.ts";
import type { Ctx } from "./store.ts";

const KINDS = ["preflight", "sql", "config", "release"] as const;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const str = (v: unknown, max = 500) => (typeof v === "string" ? v.trim().slice(0, max) : "");
export const groupOf = (s: Pick<ReleaseStep, "before" | "after">) => (s.before ? `before:${s.before}` : s.after ? `after:${s.after}` : "start");
const isWrite = (s: ReleaseStep) => s.kind !== "preflight";

// The new text with `add` below the one line equal to `under`; lines already there are skipped. err: why nothing may change.
export function configPlan(before: string, under: string, add: string[]): { missing: string[]; text?: string; err?: string } {
  const lines = before.split("\n"), at = lines.flatMap((l, i) => (l.trimEnd() === under.trimEnd() ? [i] : []));
  if (at.length !== 1) return { missing: [], err: `the line "${under.trim()}" is there ${at.length} times, not once` };
  const key = (l: string) => /^(\s*)([^\s:#][^:#]*?)\s*:/.exec(l), missing: string[] = [];
  for (const a of add) {
    if (lines.includes(a)) continue;
    const k = key(a), clash = k && lines.find((l) => { const m = key(l); return !!m && m[1] === k[1] && m[2] === k[2]; });
    if (clash) return { missing: [], err: `the file already sets ${k![2]} differently ("${clash.trim()}")` };
    missing.push(a);
  }
  return missing.length ? { missing, text: [...lines.slice(0, at[0]! + 1), ...missing, ...lines.slice(at[0]! + 1)].join("\n") } : { missing };
}

// The config guard: `after` must be `before` with exactly the missing lines added below `under`, nothing else.
export function onlyAddedLines(before: string, after: string, under: string, add: string[]): boolean {
  const p = configPlan(before, under, add);
  return !p.err && !!p.text && p.text === after;
}

// A preflight's verdict from its results: null when every check holds, else what is wrong.
export function judge(checks: PreflightCheck[], results: { rows: Record<string, unknown>[] }[]): string | null {
  for (const c of checks) {
    const r = results[c.query - 1];
    if (!r) return `query ${c.query} gave no result (the script ran ${results.length} queries)`;
    if (c.expect === "no_rows" && r.rows.length) return `query ${c.query} returned ${r.rows.length} row(s) and must return none (${c.why}): ${JSON.stringify(r.rows.slice(0, 3)).slice(0, 300)}`;
    if (c.expect === "all_true" && (!r.rows.length || r.rows.some((x) => x[c.column!] !== true && x[c.column!] !== "t"))) return `query ${c.query} must show ${c.column} = true (${c.why}): ${JSON.stringify(r.rows.slice(0, 3)).slice(0, 300)}`;
  }
  return null;
}

// Checks and stores a plan's release steps. SQL files are read at the repo's master PR commit; what is read is what runs.
export async function setReleaseSteps(ctx: Ctx, p: Plan, raw: unknown): Promise<void> {
  const { ports } = ctx;
  if (!Array.isArray(raw) || raw.length > 40) throw new Error("Send \"steps\" as a list (40 at most).");
  const prs = p.masterPrs, repos = new Set(prs.map((r) => r.repo)), ids = new Set<string>(), out: ReleaseStep[] = [];
  for (const [i, x] of (raw as any[]).entries()) {
    const n = `Step ${i + 1}`;
    if (!x || typeof x !== "object") throw new Error(`${n} is not an object.`);
    const s: ReleaseStep = { id: str(x.id, 60), kind: x.kind, title: str(x.title, 200), rerun: x.rerun === true, rerunWhy: str(x.rerunWhy) || undefined, state: "" };
    if (!/^[\w.-]{1,60}$/.test(s.id) || ids.has(s.id)) throw new Error(`${n}: send a unique "id" (letters, digits, . _ -).`);
    ids.add(s.id);
    if (!(KINDS as readonly string[]).includes(s.kind)) throw new Error(`${n}: "kind" must be one of ${KINDS.join(", ")}.`);
    if (!s.title) throw new Error(`${n}: send a "title".`);
    if (x.before && x.after) throw new Error(`${n}: send "before" or "after", not both.`);
    for (const k of ["before", "after"] as const) if (x[k] !== undefined) { if (!repos.has(x[k])) throw new Error(`${n}: "${k}" must be a repo with a master PR in ${p.id}.`); s[k] = x[k]; }
    if (s.kind === "preflight" || s.kind === "sql") {
      if (!ports.prodSql) throw new Error("This host cannot run prod SQL, so it takes no SQL steps.");
      s.database = str(x.database, 80);
      if (!s.database) throw new Error(`${n}: send the "database".`);
      if ((x.file === undefined) === (x.sql === undefined)) throw new Error(`${n}: send a "file" ({repo, path}) or inline "sql", one of them.`);
      if (x.file !== undefined) {
        const repo = str(x.file?.repo, 80), path = str(x.file?.path, 300), pr = prs.find((r) => r.repo === repo);
        if (!pr?.head || pr.state !== "open") throw new Error(`${n}: ${repo || "the repo"} has no open master PR in ${p.id} to read the file from.`);
        if (!/^[\w.\-/]+\.sql$/.test(path) || path.split("/").includes("..") || path.startsWith("/")) throw new Error(`${n}: "path" must be a .sql file inside the repo.`);
        if (!ports.git.readAt) throw new Error("This host cannot read files at a commit.");
        s.file = { repo, path }; s.ref = pr.head;
        try { s.text = await ports.git.readAt(repo, pr.head, path); } catch (e) { throw new Error(`${n}: could not read ${repo}/${path} at ${pr.head.slice(0, 8)}: ${e instanceof Error ? e.message : e}`); }
      } else {
        if (typeof x.sql !== "string" || x.sql.length > 20_000) throw new Error(`${n}: inline "sql" must be text of 20,000 characters at most.`);
        s.text = x.sql.trim();
      }
      if (!s.text) throw new Error(`${n}: the SQL is empty.`);
      s.sql = x.sql !== undefined ? s.text : undefined; s.sha = sha(s.text);
      if (s.kind === "preflight") {
        if (!Array.isArray(x.checks)) throw new Error(`${n}: a preflight needs "checks" (what output means OK), even an empty list.`);
        s.checks = x.checks.map((c: any): PreflightCheck => {
          if (!Number.isInteger(c?.query) || c.query < 1 || !["no_rows", "all_true"].includes(c?.expect) || (c.expect === "all_true" && !str(c.column, 80)) || !str(c.why)) throw new Error(`${n}: each check needs "query" (1-based), "expect" (no_rows or all_true), "column" for all_true, and "why".`);
          return { query: c.query, expect: c.expect, ...(c.expect === "all_true" ? { column: str(c.column, 80) } : {}), why: str(c.why) };
        });
      } else {
        s.allow = Array.isArray(x.allow) ? x.allow.filter((a: unknown) => a === "do" || a === "upsert") : undefined;
        s.tables = Array.isArray(x.tables) ? x.tables.map((t: unknown) => str(t, 80)).filter(Boolean) : undefined;
      }
      const why = ports.prodSql.problem(s.kind, s.database, s.text, { allow: s.allow, tables: s.tables, queries: Math.max(0, ...(s.checks ?? []).map((c) => c.query)) });
      if (why) throw new Error(`${n} (${s.title}) may not run: ${why}`);
    } else if (s.kind === "config") {
      if (!ports.configEdit) throw new Error("This host cannot edit config files.");
      if (!s.before) throw new Error(`${n}: a config edit needs "before" (the repo whose PR needs it).`);
      const c = x.config ?? {}, add = Array.isArray(c.add) ? c.add.map((l: unknown) => (typeof l === "string" ? l.replace(/\s+$/, "") : "")) : [];
      s.config = { repo: str(c.repo, 80), branch: str(c.branch, 80), file: str(c.file, 200), under: typeof c.under === "string" ? c.under.replace(/\s+$/, "") : "", add, message: str(c.message, 200) };
      if (!s.config.repo || !s.config.branch || !s.config.file || !s.config.under.trim() || !s.config.message) throw new Error(`${n}: config needs repo, branch, file, under (the line the new lines go below) and message.`);
      if (!add.length || add.some((l: string) => !l.trim() || l.includes("\n"))) throw new Error(`${n}: config "add" must be a list of non-empty single lines.`);
      let before: string;
      try { before = await ports.configEdit.read(s.config.repo, s.config.branch, s.config.file); } catch (e) { throw new Error(`${n}: could not read ${s.config.repo} ${s.config.branch}:${s.config.file}: ${e instanceof Error ? e.message : e}`); }
      const plan = configPlan(before, s.config.under, add);
      if (plan.err) throw new Error(`${n}: ${s.config.file}: ${plan.err}.`);
    } else {
      s.lib = str(x.lib, 80); s.version = str(x.version, 40);
      if (!ports.libs?.names().includes(s.lib)) throw new Error(`${n}: "${s.lib}" is not an in-house library.`);
      if (!/^[\w.-]+$/.test(s.version)) throw new Error(`${n}: send the "version" to release, e.g. 1.0.0.280.`);
      if (s.after !== s.lib) throw new Error(`${n}: a release runs "after" its own library's PR (${s.lib}).`);
    }
    // A step already done with the same content keeps its state, so taking a failed step out does not run the done ones again.
    const was = p.releaseSteps?.find((o) => o.id === s.id && o.state === "done" && o.sha === s.sha && JSON.stringify(o.config) === JSON.stringify(s.config) && o.version === s.version);
    if (was) Object.assign(s, { state: was.state, at: was.at, result: was.result, rows: was.rows, startedAt: was.startedAt });
    out.push(s);
  }
  p.releaseSteps = out.length ? out : undefined;
  const count = (k: string) => out.filter((s) => s.kind === k).length;
  ctx.ev(p.id, "release_steps_set", { text: out.length ? `Release steps set: ${count("preflight")} preflight, ${count("sql")} SQL, ${count("config")} config, ${count("release")} release` : "Release steps removed", steps: out.map((s) => ({ id: s.id, kind: s.kind, before: s.before, after: s.after, database: s.database, file: s.file, ref: s.ref, sha: s.sha })) });
  ctx.change();
}

// Runs one group of steps in order. Skipped when every step in it is done; otherwise its preflights run again and only
// the writes not done yet run. Returns why it stopped (a plan error), or null.
export async function runGroup(ctx: Ctx, p: Plan, key: string, prs: PrRef[]): Promise<string | null> {
  const steps = (p.releaseSteps ?? []).filter((s) => groupOf(s) === key);
  if (!steps.length) return null;
  if (steps.every((s) => s.state === "done")) { ctx.ev(p.id, "release_step_skipped", { text: `${steps.map((s) => s.title).join(", ")}: already done; skipped`, ids: steps.map((s) => s.id) }); return null; }
  for (const s of steps) {
    if (isWrite(s) && s.state === "done") { ctx.ev(p.id, "release_step_skipped", { text: `${s.title}: already done (${s.result ?? "done"}); skipped`, id: s.id }); continue; }
    if (isWrite(s) && !s.rerun && (s.state === "fail" || s.state === "run")) return `${s.title} stopped part way earlier and is not safe to run again (${s.rerunWhy ?? "no reason given"}). Check prod by hand, then set the release steps again without it.`;
    const all = p.releaseSteps!, i = all.indexOf(s);
    setNow(ctx, p, `Prod step ${i + 1} of ${all.length}: ${s.title}`);
    s.state = "run"; s.at = ctx.now(); s.error = undefined; s.result = undefined; s.rows = undefined; ctx.change();
    ctx.ev(p.id, "release_step_start", { text: `${s.title}: started`, id: s.id, kind: s.kind, database: s.database });
    let r: { ok: boolean; result?: string; rows?: number; error?: string; manual?: boolean; extra?: Record<string, unknown> };
    try { r = await runStep(ctx, p, s, prs); } catch (e) { r = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    s.state = r.manual ? "manual" : r.ok ? "done" : "fail"; s.result = r.result; s.rows = r.rows; s.error = r.error;
    ctx.ev(p.id, "release_step", { text: `${s.title}: ${r.ok ? r.result ?? "done" : r.manual ? r.error : `failed: ${r.error}`}`, id: s.id, kind: s.kind, ok: r.ok, rows: r.rows, error: r.error, ...r.extra });
    ctx.change();
    if (!r.ok && !r.manual) return `${s.title} ${s.kind === "preflight" ? "found a problem" : "failed"}${key.startsWith("after:") ? ", so nothing more ran" : ", so nothing was written or merged after it"}: ${r.error}`;
  }
  return null;
}

const cell = (v: unknown) => { const t = v === null || v === undefined ? "null" : typeof v === "object" ? JSON.stringify(v) : String(v); return t.length > 120 ? `${t.slice(0, 120)}…` : t; };

async function sqlText(ctx: Ctx, s: ReleaseStep, prs: PrRef[]): Promise<string> {
  if (s.sql !== undefined) return s.sql;
  const { repo, path } = s.file!, pr = prs.find((r) => r.repo === repo);
  const ref = pr?.state === "merged" && pr.merge ? pr.merge : pr?.head ?? `origin/${await ctx.ports.git.masterBranch(repo)}`; // a dropped PR: its change is on master
  const text = await ctx.ports.git.readAt!(repo, ref, path);
  if (sha(text) !== s.sha) throw new Error(`${repo}/${path} at ${ref.slice(0, 8)} is not the text you confirmed (it was read at ${s.ref?.slice(0, 8)}); set the release steps again`);
  return text;
}

async function runStep(ctx: Ctx, p: Plan, s: ReleaseStep, prs: PrRef[]): Promise<{ ok: boolean; result?: string; rows?: number; error?: string; manual?: boolean; extra?: Record<string, unknown> }> {
  const { ports } = ctx;
  if (s.kind === "preflight") {
    const text = await sqlText(ctx, s, prs);
    const r = await ports.prodSql!.check(s.database!, text);
    const shown = r.results.map((x, i) => ({ query: i + 1, sql: x.sql.slice(0, 200), count: x.rows.length, rows: x.rows.slice(0, 10).map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, cell(v)]))) }));
    const rows = r.results.reduce((a, x) => a + x.rows.length, 0), extra = { results: shown };
    if (!r.ok) return { ok: false, error: r.error ?? "the preflight did not run", rows, extra };
    const bad = judge(s.checks ?? [], r.results);
    if (bad) return { ok: false, error: bad, rows, extra };
    return { ok: true, rows, result: `OK on ${s.database}: ${shown.map((x) => `query ${x.query} ${x.count} row(s)`).join(", ")}`, extra };
  }
  if (s.kind === "sql") {
    const text = await sqlText(ctx, s, prs), opts = { allow: s.allow, tables: s.tables };
    const why = ports.prodSql!.problem("sql", s.database!, text, opts);
    if (why) return { ok: false, error: `not run: ${why}` };
    const r = await ports.prodSql!.run(s.database!, text, opts);
    const rows = r.statements.reduce((a, x) => a + (x.rows || 0), 0), extra = { statements: r.statements.map((x) => ({ sql: x.sql.slice(0, 200), rows: x.rows })) };
    if (!r.ok) return { ok: false, rows, error: `${r.error ?? "failed"} (after ${r.statements.length} statement(s) ran)`, extra };
    return { ok: true, rows, result: `${r.statements.length} statement(s) ran on ${s.database}, ${rows} row(s)`, extra };
  }
  if (s.kind === "config") {
    const ce = ports.configEdit!, c = s.config!;
    const before = await ce.read(c.repo, c.branch, c.file), plan = configPlan(before, c.under, c.add);
    if (plan.err) return { ok: false, error: `${c.file}: ${plan.err}` };
    if (!plan.missing.length) return { ok: true, result: `${c.repo} ${c.branch}:${c.file} already has every line; nothing pushed` };
    const made = await ce.commit(c.repo, c.branch, c.file, plan.text!, c.message);
    if (made.files.length !== 1 || made.files[0] !== c.file || !onlyAddedLines(before, made.text, c.under, c.add))
      return { ok: false, error: `refused before the push: the commit changes ${made.files.join(", ") || "nothing"}, not only the ${plan.missing.length} listed line(s) in ${c.file}` };
    await ce.push(c.repo, c.branch, made.commit);
    return { ok: true, result: `pushed ${made.commit.slice(0, 8)} to ${c.repo} ${c.branch}: ${plan.missing.length} line(s) added to ${c.file}`, extra: { commit: made.commit, added: plan.missing } };
  }
  // A release: the release pipeline waited for the tag when a later PR needed it; here the tag is only checked.
  const lib = s.lib!, version = s.version!;
  if (await ports.libs!.released(lib, version)) return { ok: true, result: `${lib} ${version} is released` };
  return { ok: false, manual: true, error: `${lib} ${version} is not released yet. No PR in this merge needed it, so the release pipeline did not wait for it. Click "Create Release Version" in ${lib}'s master pipeline when you want it.` };
}
