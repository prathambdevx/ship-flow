// Reads the pinned agent body (agents/<role>.md) without its YAML front matter.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Role } from "../types.ts";

const cache = new Map<string, string>();

export function agentBody(role: Role): string {
  if (role === "planner" || role === "tester") return "";
  const hit = cache.get(role);
  if (hit !== undefined) return hit;
  const file = join(import.meta.dir, "..", "agents", `${role}.md`);
  let text = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (text.startsWith("---")) {
    const end = text.indexOf("\n---", 3);
    if (end >= 0) text = text.slice(text.indexOf("\n", end + 1) + 1);
  }
  const body = text.trim();
  cache.set(role, body);
  return body;
}
