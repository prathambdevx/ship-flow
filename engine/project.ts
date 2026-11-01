// The project a built-in backend serves: set by `ship setup` in ~/.claude/ship/config.json under backends[name].project.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ProjectConfig {
  name: string; port: number; dataDir: string; mergeToStaging: "auto" | "you";
  repos: { name: string; path: string; workBranch: string; stagingBranch: string | null; prodBranch: string | null; build?: string; test?: string }[];
}

const expand = (p: string) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

export function loadProject(name: string): ProjectConfig {
  const file = process.env.SHIP_CONFIG ?? join(homedir(), ".claude/ship/config.json"); // SHIP_CONFIG: another config file, for tests
  let raw: any;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch (e) { throw new Error(`Cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`); }
  const p = raw?.backends?.[name]?.project;
  if (!p || typeof p !== "object") throw new Error(`${file} has no backends.${name}.project. Run \`ship setup\` first.`);
  if (!Array.isArray(p.repos) || !p.repos.length) throw new Error(`backends.${name}.project has no repos.`);
  return {
    name: String(p.name ?? name), port: Number(p.port), dataDir: expand(String(p.dataDir ?? `~/.claude/ship/data/${name}`)),
    mergeToStaging: p.mergeToStaging === "you" ? "you" : "auto",
    repos: p.repos.map((r: any) => ({ ...r, path: expand(String(r.path)) })),
  };
}

// serve() takes the project as read from the config file: expand "~" here too.
export function expandProject(p: ProjectConfig): ProjectConfig {
  return { ...p, dataDir: expand(p.dataDir), repos: p.repos.map((r) => ({ ...r, path: expand(r.path) })) };
}
