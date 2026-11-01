// Shared helpers: the plan+repo lock, missing or dirty worktrees, the whole-branch diff guard, declining stale PRs.
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Plan, PrRef } from "../types.ts";
import type { Ctx } from "./store.ts";

// One lock per plan and repo: everything that touches the plan worktree takes it. Order: repoLock first, then this.
export const planLock = <T>(ctx: Ctx, planId: string, repo: string, job: () => Promise<T>): Promise<T> => ctx.mutex(`plan:${planId}:${repo}`, job);

// Each repo's plan worktree and head: code the plan builds in another repo is only there until the plan lands.
export async function planRepoHeads(ctx: Ctx, p: Plan): Promise<{ repo: string; dir: string; branch: string; head: string }[]> {
  const out = [];
  for (const r of p.repos) { try { out.push({ repo: r.repo, dir: r.dir, branch: r.branch, head: (await ctx.ports.git.head(r.dir)).trim() }); } catch { /* not made yet */ } }
  return out;
}

// "repo@head" when every name is a whole word in that repo's plan branch, else null (also when a name cannot be checked).
const NAME = /^[A-Za-z_$/{][\w$./{}-]{0,120}$/;
export async function presentOnPlanBranch(ctx: Ctx, p: Plan, repo: string, names: string[]): Promise<string | null> {
  const r = p.repos.find((x) => x.repo === repo);
  if (!r || !ctx.ports.git.hasWords || !names.length || !names.every((n) => NAME.test(n))) return null;
  try {
    const found = await ctx.ports.git.hasWords(r.dir, names);
    return names.every((n) => found.includes(n)) ? `${repo}@${(await ctx.ports.git.head(r.dir)).trim().slice(0, 12)}` : null;
  } catch { return null; }
}

// A worktree folder that is gone (temp folder cleared) is made again from its branch.
export async function ensureDir(ctx: Ctx, planId: string, repo: string, dir: string, branch: string, task?: string): Promise<void> {
  try { await ctx.ports.git.head(dir); return; } catch { /* missing: made again below */ }
  await ctx.ports.git.worktree(repo, dir, branch, branch);
  ctx.ev(planId, "worktree_recreated", { task, text: `${repo}: the worktree ${dir} was missing; made it again from ${branch}`, dir, branch });
}

// A repo builds against the plan's own change to an in-house library it uses (common-contracts): that library's plan worktree
// is installed into the local Maven cache first, once per new head. Without it the build uses the staging copy and fails.
const installedLibs = new Map<string, string>(); // plan/library -> head installed
export async function installPlanLibs(ctx: Ctx, p: Plan, repo: string, dir: string): Promise<void> {
  const libs = ctx.ports.libs;
  if (!libs?.install) return;
  const names = libs.names(), poms = ctx.ports.git.poms ? await ctx.ports.git.poms(dir).catch(() => []) : [];
  const uses = (lib: string) => !poms.length || poms.some((x) => x.text.includes(`<artifactId>${lib}</artifactId>`)); // version may be a property
  for (const part of p.repos) {
    if (part.repo === repo || !names.includes(part.repo) || !uses(part.repo)) continue;
    const bad = await planLock(ctx, p.id, part.repo, async (): Promise<string | null> => {
      let head: string;
      try { head = await ctx.ports.git.head(part.dir); } catch { return null; } // no worktree yet: the plan has not changed it
      const key = `${p.id}/${part.repo}`;
      if (installedLibs.get(key) === head) return null;
      if (!(await ctx.ports.git.commitsSince(part.dir, `origin/${part.base}`)).length) { installedLibs.set(key, head); return null; }
      const r = await libs.install!(part.dir);
      ctx.ev(p.id, "plan_lib_installed", { text: r.ok ? `${part.repo}: installed this plan's version into the local Maven cache, so ${repo} builds against it` : `${part.repo}: could not install this plan's version: ${r.detail}`, repo: part.repo, for: repo, ok: r.ok, head });
      if (r.ok) installedLibs.set(key, head);
      return r.ok ? null : r.detail;
    });
    if (bad) throw new Error(`Could not install ${part.repo} from this plan before building ${repo}: ${bad}`);
  }
}

// Drops uncommitted edits by making the worktree again from its own branch.
export async function resetDir(ctx: Ctx, planId: string, repo: string, dir: string, branch: string, why: string): Promise<void> {
  await ctx.ports.git.drop(repo, dir);
  await ctx.ports.git.worktree(repo, dir, branch, branch);
  ctx.ev(planId, "worktree_reset", { text: `${repo}: dropped uncommitted edits in ${dir} (${why})`, dir, branch });
}

// Maven output (target/, about 180 MB) is most of a worktree; the next build makes it again. Root and one module level.
export function dropBuildOutput(dir: string | undefined): void {
  if (!dir || !existsSync(dir)) return;
  const dirs = [dir, ...readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "target").map((e) => join(dir, e.name))];
  for (const d of dirs) if (existsSync(join(d, "pom.xml")) && existsSync(join(d, "target"))) rmSync(join(d, "target"), { recursive: true, force: true });
}

// A target plan merged into its branch: its task folders go (a send-back makes one again from its branch), and the build output too.
export async function dropTaskDirs(ctx: Ctx, p: Plan): Promise<void> {
  let n = 0;
  for (const id of p.tasks) {
    const t = ctx.st.tasks[id];
    if (!t?.dir) continue;
    try { await planLock(ctx, p.id, t.repo, () => ctx.ports.git.drop(t.repo, t.dir!)); n++; }
    catch (e) { ctx.ev(p.id, "worktree_drop_failed", { text: `${t.repo}: could not remove ${t.dir}: ${e instanceof Error ? e.message : String(e)}`, repo: t.repo, dir: t.dir }); }
  }
  for (const r of p.repos) dropBuildOutput(r.dir);
  ctx.ev(p.id, "worktrees_dropped", { text: `Merged into ${p.targetBranch}: removed ${n} task folder${n === 1 ? "" : "s"} and the build output (branches kept)` });
}

// A plan live on prod no longer needs its plan, task and master worktrees; the branches stay. A failed drop is logged, not fatal.
export async function dropPlanDirs(ctx: Ctx, p: Plan, why = "Live on prod"): Promise<void> {
  const dirs = new Map<string, string>(); // dir -> repo
  for (const r of p.repos) { dirs.set(r.dir, r.repo); dirs.set(`${ctx.ports.stageRoot}/${p.id}/${r.repo}-master`, r.repo); }
  for (const id of p.tasks) { const t = ctx.st.tasks[id]; if (t?.dir) dirs.set(t.dir, t.repo); }
  let failed = 0;
  for (const [dir, repo] of dirs) {
    try { await planLock(ctx, p.id, repo, () => ctx.ports.git.drop(repo, dir)); }
    catch (e) { failed++; ctx.ev(p.id, "worktree_drop_failed", { text: `${repo}: could not remove ${dir}: ${e instanceof Error ? e.message : String(e)}`, repo, dir }); }
  }
  ctx.ev(p.id, "worktrees_dropped", { text: `${why}: removed ${dirs.size - failed} of ${dirs.size} worktree folders (branches kept)`, dirs: [...dirs.keys()], failed });
}

// Runs the diff guard on everything the branch holds against `base`, not only the last step. Returns the reason, or null.
// allow (port plans): files and added lines that come from the plan's own reviewed staging commits skip the checks;
// anything else, including every line a port run wrote, is still checked.
export async function wholeGuard(ctx: Ctx, planId: string, dir: string, base: string, what: string, allow?: { files: Set<string>; lines: Set<string> }): Promise<string | null> {
  const files = await ctx.ports.git.changedFiles(dir, base), raw = await ctx.ports.git.diff(dir, base);
  const allowed = files.filter((f) => allow?.files.has(f)), rest = files.filter((f) => !allow?.files.has(f));
  const diff = allow ? raw.split("\n").filter((l) => !(l.startsWith("+") && !l.startsWith("+++") && allow.lines.has(l.trim()))).join("\n") : raw;
  const refused = ctx.ports.diffGuard(rest.length ? rest : ["(port plan: only its own staging files)"], diff);
  ctx.ev(planId, "diff_guard", { text: refused ? `${what}: whole branch refused before the push: ${refused}` : `${what}: whole branch passed the diff guard (${files.length} file${files.length === 1 ? "" : "s"}${allowed.length ? `; allowed because the port's staging commits changed them: ${allowed.join(", ")}` : ""})`, refused, files });
  return refused;
}

// Declines every open PR in the list (an edit or a new run made it out of date). A failed decline is logged, not fatal.
export async function declineOpen(ctx: Ctx, planId: string, prs: PrRef[], name: string): Promise<void> {
  for (const pr of prs) {
    if (pr.state !== "open") continue;
    try {
      await ctx.ports.prs.decline(pr.repo, pr.id);
      pr.state = "declined";
      ctx.ev(planId, "pr_declined", { text: `${pr.repo}: ${name} PR #${pr.id} declined because the plan changed`, repo: pr.repo, id: pr.id });
    } catch (e) {
      ctx.ev(planId, "pr_decline_failed", { text: `${pr.repo}: could not decline ${name} PR #${pr.id}: ${e instanceof Error ? e.message : String(e)}`, repo: pr.repo, id: pr.id });
    }
  }
}
