// A Ports implementation for any git project: the git CLI for code, the GitHub CLI (gh) for PRs, `sh -c` for builds.
// Terminal plans only: claude() and test() are never called. No deploy step, no release runner.
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Deliberate } from "./core/errors.ts";
import type { Ports } from "./ports.ts";
import type { ProjectConfig } from "./project.ts";

export type Out = { ok: boolean; out: string; err: string };
export type Runner = (cmd: string[], cwd: string, timeoutMs?: number) => Promise<Out>;
export interface GitPortsOpts { gh?: Runner; sleep?: (ms: number) => Promise<void>; github?: boolean } // tests stub gh and the poll wait; github: force the GitHub path

export const run: Runner = async (cmd, cwd, timeoutMs = 5 * 60_000) => {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" } });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  clearTimeout(timer);
  return { ok: code === 0, out: out.trim(), err: err.trim() };
};

// A machine with no git identity cannot commit or cherry-pick: give git a local one.
const NO_IDENTITY = !Bun.spawnSync(["git", "config", "--global", "--get", "user.email"]).stdout.toString().trim();
const FLAGS = ["-c", "commit.gpgsign=false", "-c", "core.pager=cat", "-c", "diff.external=", ...(NO_IDENTITY ? ["-c", "user.name=ship-flow", "-c", "user.email=ship-flow@localhost"] : [])];
const g = (args: string[], dir: string, t?: number) => run(["git", ...FLAGS, ...args], dir, t);
async function must(args: string[], dir: string, t?: number): Promise<string> {
  const r = await g(args, dir, t);
  if (!r.ok) throw new Error(`git ${args[0]}: ${(r.err || r.out).split("\n").slice(-3).join(" ")}`);
  return r.out;
}
const lines = (s: string) => s.split("\n").filter(Boolean);
const conflictText = async (dir: string, out: string) => {
  const files = lines((await g(["diff", "--no-ext-diff", "--name-only", "--diff-filter=U"], dir)).out);
  return `Conflict in ${files.join(", ") || "unknown files"}. ${out.split("\n").slice(-3).join(" ")}`.trim();
};
const SAFE_REF = /^[\w.\-/]+$/;
const tail = (s: string, n: number) => (s.length > n ? s.slice(-n) : s);

// Refuses obvious secrets and a change that only touches lockfiles; anything else passes.
const LOCKFILES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|Pipfile\.lock|Gemfile\.lock|composer\.lock|go\.sum|uv\.lock)$/;
export function diffGuard(files: string[], diff: string): string | null {
  const env = files.find((f) => /(^|\/)\.env(\.[\w.-]+)?$/.test(f) && !/\.(example|sample|template|dist)$/.test(f));
  if (env) return `${env} is an environment file and may hold secrets. Remove it from the change.`;
  const key = files.find((f) => /(^|\/)(id_rsa|id_ed25519|id_ecdsa|id_dsa)$|\.(pem|p12|pfx|key)$/.test(f));
  if (key) return `${key} looks like a private key. Remove it from the change.`;
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(diff)) return "The change adds a private key. Remove it.";
  if (files.length && files.every((f) => LOCKFILES.test(f))) return "The change only touches lockfiles. Make the real change, or leave it out.";
  return null;
}

const chains = new Map<string, Promise<unknown>>();
function repoLock<T>(repo: string, job: () => Promise<T>): Promise<T> {
  const next = (chains.get(repo) ?? Promise.resolve()).catch(() => {}).then(job);
  chains.set(repo, next.catch(() => {}));
  return next;
}

export function gitPorts(project: ProjectConfig, opts: GitPortsOpts = {}): Ports {
  const gh = opts.gh ?? run, sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const cfg = (repo: string) => { const r = project.repos.find((x) => x.name === repo); if (!r) throw new Error(`There is no repo ${repo} in project ${project.name}.`); return r; };
  const path = (repo: string) => cfg(repo).path;
  const ghMust = async (repo: string, args: string[]): Promise<string> => {
    const r = await gh(["gh", ...args], path(repo), 2 * 60_000);
    if (!r.ok) throw new Error(`gh ${args.slice(0, 2).join(" ")}: ${(r.err || r.out).split("\n").slice(-3).join(" ")}`);
    return r.out;
  };
  const view = async (repo: string, id: number, fields: string) => JSON.parse(await ghMust(repo, ["pr", "view", String(id), "--json", fields]));

  // The writer never commits, so changes are read from the working tree (new files included) against where the branch left base.
  async function sinceBase(dir: string, base: string) {
    await must(["add", "-A", "-N"], dir);
    return (await must(["merge-base", base, "HEAD"], dir)).trim();
  }
  async function dropDir(repo: string, dir: string) {
    if (existsSync(dir)) await g(["worktree", "remove", "--force", dir], path(repo));
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    await g(["worktree", "prune"], path(repo));
  }
  const fetched = new Map<string, number>();

  const git: Ports["git"] = {
    stagingBranch: async (repo) => cfg(repo).stagingBranch ?? cfg(repo).workBranch,
    masterBranch: async (repo) => cfg(repo).prodBranch ?? "", // none: the plan is staging-only and never reaches a master step
    async worktree(repo, dir, branch, from) {
      await dropDir(repo, dir);
      mkdirSync(dirname(dir), { recursive: true });
      if (from.startsWith("origin/")) await must(["fetch", "-q", "origin", from.slice(7)], path(repo), 3 * 60_000);
      await must(["worktree", "add", "-q", "-B", branch, dir, from], path(repo));
    },
    drop: (repo, dir) => dropDir(repo, dir),
    fetch: async (dir) => { await must(["fetch", "-q", "--prune", "origin"], dir, 3 * 60_000); },
    head: async (dir) => (await must(["rev-parse", "HEAD"], dir)).trim(),
    async hasWords(dir, words) { const out: string[] = []; for (const w of words) if ((await g(["grep", "-q", "-w", "-F", "-e", w, "HEAD", "--"], dir)).ok) out.push(w); return out; },
    async commitAll(dir, message) {
      await must(["add", "-A"], dir);
      if ((await g(["diff", "--no-ext-diff", "--cached", "--quiet"], dir)).ok) return null;
      await must(["commit", "-q", "--no-verify", "-m", message.slice(0, 300)], dir);
      return (await must(["rev-parse", "HEAD"], dir)).trim();
    },
    changedFiles: async (dir, base) => lines(await must(["diff", "--no-ext-diff", "--name-only", "--no-renames", await sinceBase(dir, base)], dir)),
    diff: async (dir, base) => must(["diff", "--no-ext-diff", "--no-renames", await sinceBase(dir, base)], dir),
    stat: async (dir, base) => must(["diff", "--no-ext-diff", "--shortstat", await sinceBase(dir, base)], dir),
    async mergeBranch(dir, branch, message) {
      const r = await g(["merge", "--no-ff", "--no-verify", "-m", message, branch], dir);
      if (r.ok) return { ok: true };
      const conflict = await conflictText(dir, r.err || r.out);
      await g(["merge", "--abort"], dir);
      return { ok: false, conflict };
    },
    async rebase(dir, onto) {
      const r = await g(["rebase", onto], dir);
      if (r.ok) return { ok: true };
      const conflict = await conflictText(dir, r.err || r.out);
      await g(["rebase", "--abort"], dir);
      return { ok: false, conflict };
    },
    push: async (dir, branch) => { await must(["push", "-q", "--no-verify", "--force-with-lease", "-u", "origin", `HEAD:refs/heads/${branch}`], dir, 3 * 60_000); },
    commitsSince: async (dir, base) => lines(await must(["rev-list", "--reverse", `${base}..HEAD`], dir)),
    async cherryPick(dir, commits, o) {
      for (const c of commits) {
        const r = await g(["cherry-pick", "-x", c], dir);
        if (!r.ok) {
          const unmerged = lines((await g(["diff", "--name-only", "--diff-filter=U"], dir)).out);
          if (!unmerged.length && /empty/i.test(`${r.err}\n${r.out}`)) { await g(["cherry-pick", "--skip"], dir); return { ok: false, empty: true }; } // already on this branch
          const conflict = await conflictText(dir, r.err || r.out);
          if (o?.keepConflict && unmerged.length) return { ok: false, conflict, files: unmerged };
          await g(["cherry-pick", "--abort"], dir);
          return { ok: false, conflict };
        }
      }
      return { ok: true, head: (await must(["rev-parse", "HEAD"], dir)).trim() };
    },
    async contains(repo, ancestor, branch) {
      const dir = path(repo);
      if (!(await g(["fetch", "-q", "origin", ancestor, branch], dir)).ok) return false;
      return (await g(["merge-base", "--is-ancestor", `refs/remotes/origin/${ancestor}`, `refs/remotes/origin/${branch}`], dir)).ok;
    },
    async remoteHead(repo, branch) {
      await must(["fetch", "-q", "origin", branch], path(repo), 3 * 60_000);
      return (await must(["rev-parse", `refs/remotes/origin/${branch}`], path(repo))).trim();
    },
    // A target branch missing on origin is made from origin/<from> in the repo's own clone and pushed (never forced).
    async ensureBranch(repo, branch, from) {
      const r = cfg(repo), dir = r.path;
      if (!SAFE_REF.test(branch) || !SAFE_REF.test(from) || branch === r.prodBranch) throw new Error(`${branch} cannot be made by ship-flow`);
      if ((await must(["ls-remote", "--heads", "origin", `refs/heads/${branch}`], dir)).trim()) return false;
      await must(["fetch", "-q", "origin", from], dir, 3 * 60_000);
      await must(["push", "-q", "--no-verify", "origin", `refs/remotes/origin/${from}:refs/heads/${branch}`], dir, 3 * 60_000);
      return true;
    },
    async verifyCommits(repo, branch, commits) {
      const dir = path(repo);
      if (!(await g(["fetch", "-q", "origin", branch], dir)).ok) return `could not fetch origin/${branch}`;
      for (const c of commits) {
        const k = await g(["rev-parse", "--verify", "--quiet", `${c}^{commit}`], dir);
        if (!k.ok) return `commit ${c} does not exist in the repo`;
        const parents = (await g(["rev-list", "--parents", "-n", "1", k.out.trim()], dir)).out.trim().split(/\s+/).length - 1;
        if (parents !== 1) return `commit ${c.slice(0, 8)} is ${parents > 1 ? "a merge commit" : "a root commit"}; send non-merge commits only`;
        if (!(await g(["merge-base", "--is-ancestor", k.out.trim(), `refs/remotes/origin/${branch}`], dir)).ok) return `commit ${c.slice(0, 8)} is not on origin/${branch}`;
      }
      return null;
    },
    async existsAt(dir, ref, p) { return (await g(["cat-file", "-e", `${ref}:${p}`], dir)).ok; },
    async finishPick(dir, commit) {
      if (!commit) { await g(["cherry-pick", "--abort"], dir); return { ok: true }; }
      const add = await g(["add", "-A"], dir);
      const r = add.ok ? await g(["-c", "core.editor=true", "cherry-pick", "--continue"], dir) : add;
      return r.ok ? { ok: true } : { ok: false, error: (r.err || r.out).slice(0, 300) };
    },
    diffRange: async (dir, from, to, files) => must(["diff", "--no-ext-diff", "--no-renames", from, to, "--", ...files], dir),
    async writeFile(dir, p, text) {
      if (!/^[\w.\-/]+$/.test(p) || p.split("/").includes("..") || p.startsWith("/")) throw new Error(`refused to write ${p}`);
      writeFileSync(join(dir, p), text);
    },
    async mergesCleanly(repo, head, target) {
      if (!/^[0-9a-f]{7,40}$/i.test(head) || !SAFE_REF.test(target)) return null;
      const dir = path(repo), key = `${repo}/${target}`;
      if (Date.now() - (fetched.get(key) ?? 0) > 60_000) {
        if (!(await g(["fetch", "-q", "origin", target], dir)).ok) return null;
        fetched.set(key, Date.now());
      }
      if (!(await g(["cat-file", "-e", `${head}^{commit}`], dir)).ok) return null;
      const r = await g(["merge-tree", "--write-tree", "--no-messages", `refs/remotes/origin/${target}`, head], dir);
      return r.ok ? true : /^[0-9a-f]{40}/.test(r.out.trim()) ? false : null; // exit 1 with a tree id: conflicts
    },
    async readAt(repo, ref, p) {
      if (!SAFE_REF.test(ref) || !/^[\w.\-/]+$/.test(p) || p.split("/").includes("..")) throw new Error(`refused to read ${repo} ${ref}:${p}`);
      return must(["show", `${ref}:${p}`], path(repo));
    },
    async showCommit(dir, commit) {
      const text = (await g(["show", "--no-ext-diff", "--format=%H%n%B", commit], dir)).out;
      return { text, files: lines((await g(["show", "--no-ext-diff", "--name-only", "--format=", commit], dir)).out) };
    },
  };

  // A worktree maps back to its repo through the repo's own .git folder.
  const repoOfDir = async (dir: string): Promise<string | undefined> => {
    const r = await g(["rev-parse", "--path-format=absolute", "--git-common-dir"], dir);
    const real = (x: string) => { try { return realpathSync(x); } catch { return x; } };
    return project.repos.find((x) => r.ok && real(r.out) === real(join(x.path, ".git")))?.name;
  };

  // A remote that is not GitHub: "PRs" are local records; the merge is a plain git merge pushed to the branch.
  type LocalPr = { id: number; repo: string; src: string; dest: string; state: "open" | "merged" | "declined" };
  const LOCAL = `${project.dataDir}/local-prs.json`;
  const local = (): LocalPr[] => { try { return JSON.parse(readFileSync(LOCAL, "utf8")); } catch { return []; } };
  const saveLocal = (xs: LocalPr[]) => { mkdirSync(project.dataDir, { recursive: true }); writeFileSync(LOCAL, JSON.stringify(xs, null, 1)); };
  const nextLocalId = () => Math.max(0, ...local().map((x) => x.id)) + 1;
  const localPr = (repo: string, id: number) => local().find((x) => x.repo === repo && x.id === id);
  const githubOf = new Map<string, boolean>();
  async function onGithub(repo: string): Promise<boolean> {
    if (opts.github !== undefined) return opts.github;
    if (!githubOf.has(repo)) githubOf.set(repo, /github\.com[:/]/.test((await g(["remote", "get-url", "origin"], path(repo))).out));
    return githubOf.get(repo)!;
  }
  async function isMerged(lp: LocalPr): Promise<boolean> {
    const dir = path(lp.repo);
    await g(["fetch", "-q", "origin"], dir);
    return (await g(["merge-base", "--is-ancestor", `origin/${lp.src}`, `origin/${lp.dest}`], dir)).ok;
  }
  async function mergeLocal(lp: LocalPr): Promise<string> {
    const dir = path(lp.repo);
    if (project.mergeToStaging !== "auto") { // "you": wait until the user merged the branch on their git host
      while (!(await isMerged(lp))) { if (localPr(lp.repo, lp.id)?.state === "declined") throw new Deliberate("the merge was cancelled"); await sleep(30_000); }
    } else if (!(await isMerged(lp))) {
      const tmp = `${project.dataDir}/merge-tmp/${lp.repo}-${lp.id}`;
      rmSync(tmp, { recursive: true, force: true }); await g(["worktree", "prune"], dir);
      await must(["worktree", "add", "-q", "--detach", tmp, `origin/${lp.dest}`], dir);
      try {
        const m = await g(["merge", "--no-ff", "-m", `Merge ${lp.src} into ${lp.dest}`, `origin/${lp.src}`], tmp);
        if (!m.ok) { await g(["merge", "--abort"], tmp); throw new Deliberate(`Merging ${lp.src} into ${lp.dest} conflicts: ${(m.err || m.out).split("\n").slice(-2).join(" ")}`); }
        await must(["push", "-q", "origin", `HEAD:${lp.dest}`], tmp);
      } finally { await g(["worktree", "remove", "--force", tmp], dir); }
    }
    saveLocal(local().map((x) => (x.repo === lp.repo && x.id === lp.id ? { ...x, state: "merged" as const } : x)));
    await g(["fetch", "-q", "origin"], dir);
    return (await g(["rev-parse", `origin/${lp.dest}`], dir)).out;
  }

  return {
    claude: async () => { throw new Error("This backend runs no Claude steps: the terminal does them."); },
    repos: () => project.repos.map((r) => ({ name: r.name })),
    git,
    async build(dir) {
      const repo = await repoOfDir(dir), c = repo ? cfg(repo) : undefined;
      const cmds = [c?.build, c?.test].filter((x): x is string => !!x);
      if (!cmds.length) return { ok: true, ran: false, tail: "no build command" };
      let all = "";
      for (const cmd of cmds) {
        const r = await run(["sh", "-c", cmd], dir, 20 * 60_000);
        all += `$ ${cmd}\n${r.out}\n${r.err}\n`;
        if (!r.ok) return { ok: false, ran: true, tail: tail(all, 6000) };
      }
      return { ok: true, ran: true, tail: tail(all, 6000) };
    },
    prs: {
      async create(repo, src, dest, title, body) {
        if (!(await onGithub(repo))) { const pr = { id: nextLocalId(), repo, src, dest, state: "open" as const }; saveLocal([...local(), pr]); return { id: pr.id, url: "" }; } // no GitHub: a local record, merged with git
        const r = await gh(["gh", "pr", "create", "--base", dest, "--head", src, "--title", title, "--body", body], path(repo), 2 * 60_000);
        const url = r.ok ? r.out.split("\n").filter((l) => /\/pull\/\d+/.test(l)).pop()?.trim() : undefined;
        if (url) return { id: Number(/\/pull\/(\d+)/.exec(url)![1]), url };
        if (/already exists/i.test(r.err)) { // a PR for this branch is open already: use it
          const open = JSON.parse(await ghMust(repo, ["pr", "list", "--head", src, "--base", dest, "--state", "open", "--json", "number,url", "--limit", "1"]));
          if (open[0]) return { id: open[0].number, url: open[0].url };
        }
        throw new Error(`gh pr create: ${(r.err || r.out).split("\n").slice(-3).join(" ")}`);
      },
      async merge(repo, id) {
        const lp = localPr(repo, id);
        if (lp) return mergeLocal(lp);
        if (project.mergeToStaging === "auto") await ghMust(repo, ["pr", "merge", String(id), "--merge"]);
        else for (;;) { // "you": merge it on the git host; poll until it is merged or closed
          const v = await view(repo, id, "state");
          if (v.state === "MERGED") break;
          if (v.state === "CLOSED") throw new Deliberate("the PR was closed");
          await sleep(30_000);
        }
        const v = await view(repo, id, "mergeCommit");
        return String(v.mergeCommit?.oid ?? "");
      },
      async state(repo, id) {
        const lp = localPr(repo, id);
        if (lp) return lp.state === "declined" ? "declined" : (await isMerged(lp)) ? "merged" : "open";
        const s = String((await view(repo, id, "state")).state).toUpperCase();
        return s === "MERGED" ? "merged" : s === "OPEN" ? "open" : "declined";
      },
      head: async (repo, id) => { const lp = localPr(repo, id); if (lp) { await g(["fetch", "-q", "origin"], path(repo)); return (await g(["rev-parse", `origin/${lp.src}`], path(repo))).out; } return String((await view(repo, id, "headRefOid")).headRefOid ?? ""); },
      decline: async (repo, id) => { const lp = localPr(repo, id); if (lp) { saveLocal(local().map((x) => (x === lp || (x.repo === repo && x.id === id) ? { ...x, state: "declined" as const } : x))); return; } await ghMust(repo, ["pr", "close", String(id)]); },
      retitle: async (repo, id, title) => { if (localPr(repo, id)) return; await ghMust(repo, ["pr", "edit", String(id), "--title", title]); },
      describe: async (repo, id, title, description) => { if (localPr(repo, id)) return; await ghMust(repo, ["pr", "edit", String(id), "--title", title, "--body", description]); },
    },
    deploy: {
      check: async () => ({ manual: "no deploy step" }),
      wait: async () => ({ ok: true, manual: true, detail: "no deploy step" }),
    },
    test: async () => { throw new Error("This backend has no test runner."); },
    repoLock,
    diffGuard,
    stageRoot: `${project.dataDir}/stage`,
    dataDir: project.dataDir,
    log: (line) => console.log(`[ship-flow] ${line}`),
  };
}
