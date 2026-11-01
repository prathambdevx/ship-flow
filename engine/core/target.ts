// Target branches: a plan that builds on and merges into a long-lived branch (e.g. feat/eshopbox) instead of staging.
import type { Plan, RepoPart } from "../types.ts";
import { Deliberate } from "./errors.ts";
import type { Ctx } from "./store.ts";

// The plan is finished: every repo merged into its target branch. It never goes to staging, UAT or master by itself.
export const landed = (p: Plan): boolean => !!p.targetBranch && !!p.landedAt;

// Why this name cannot be a target branch, or null. A branch name is an id, so a pattern check is fine here.
export function nameProblem(branch: string): string | null {
  if (branch.length > 100) return "The branch name is too long (100 characters at most).";
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || /\.\.|\/\/|\/$|\.$|\.lock$|@\{/.test(branch)) return `"${branch}" is not a valid branch name.`;
  if (["master", "main", "HEAD"].includes(branch)) return `${branch} cannot be a target branch.`;
  return null;
}
export async function targetProblem(ctx: Ctx, branch: string, repos: string[]): Promise<string | null> {
  const bad = nameProblem(branch);
  if (bad) return bad;
  for (const repo of repos) {
    const [staging, master] = await Promise.all([ctx.ports.git.stagingBranch(repo), ctx.ports.git.masterBranch(repo)]);
    if (branch === master) return `${branch} is the master branch of ${repo}.`;
    if (branch === staging) return `${branch} is the staging branch of ${repo}: leave the target empty to go to staging.`;
  }
  return null;
}

// The branch a repo part of this plan is cut from and merges into.
export const baseFor = async (ctx: Ctx, p: Plan, repo: string): Promise<string> => p.targetBranch ?? (await ctx.ports.git.stagingBranch(repo));

// Before a plan worktree is cut from the target: make origin/<target> from the repo's staging branch if it is missing.
export async function ensureTarget(ctx: Ctx, p: Plan, part: RepoPart): Promise<void> {
  if (!p.targetBranch || part.base !== p.targetBranch) return;
  if (!ctx.ports.git.ensureBranch) throw new Deliberate(`This host cannot make branches: create ${p.targetBranch} in ${part.repo} first, then press Retry.`);
  const staging = await ctx.ports.git.stagingBranch(part.repo);
  if (await ctx.ports.git.ensureBranch(part.repo, p.targetBranch, staging))
    ctx.ev(p.id, "target_created", { text: `${part.repo}: ${p.targetBranch} did not exist, so it was made from ${staging} and pushed`, repo: part.repo, branch: p.targetBranch, from: staging });
}
