// The safety net under the planner's review calls: the task's real diff can switch a review back on, never off.
import type { Config } from "../config.ts";

export interface DiffRisk { review: string[]; security: string[] } // reasons; empty when the diff looks as planned

const TEST_FILE = /(^|\/)(src\/test|test|tests|__tests__)\/|\.(test|spec)\.[jt]sx?$|Tests?\.java$/;
// A string joined only with UPPER_CASE constants (e.g. "... like '" + NOT_IN_LIST + "'") takes no outside input.
export function constantsOnly(line: string): boolean {
  const names = [...line.matchAll(/"\s*\+\s*([A-Za-z_][\w.]*)|([A-Za-z_][\w.]*)\s*\+\s*"/g)].map((m) => (m[1] ?? m[2])!.split(".").pop()!);
  return names.length > 0 && names.every((n) => /^[A-Z][A-Z0-9_]*$/.test(n));
}

export function diffRisk(planned: string[], changed: string[], diff: string, debugged: boolean, cfg: Pick<Config, "reviewLines" | "riskyCode" | "riskyPaths">): DiffRisk {
  const review: string[] = [], security: string[] = [];
  const outside = changed.filter((f) => !planned.includes(f));
  if (outside.length) review.push(`changed files outside its list (${outside.join(", ")})`);
  if (debugged) review.push("a debugger changed the code to make the build pass");
  const lines = diff.split("\n").filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l));
  if (lines.length > cfg.reviewLines) review.push(`${lines.length} changed lines (more than ${cfg.reviewLines})`);
  // Added lines of non-test files: a mock in a test is not risky code.
  const added: string[] = []; let file = "";
  for (const l of diff.split("\n")) {
    if (l.startsWith("+++ ")) { file = l.slice(4).replace(/^b\//, ""); continue; }
    if (l.startsWith("+") && !TEST_FILE.test(file)) added.push(l.slice(1));
  }
  for (const re of cfg.riskyCode) {
    const hit = added.find((l) => new RegExp(re, "i").test(l) && !constantsOnly(l));
    if (hit) security.push(`adds risky code: ${hit.trim().slice(0, 100)}`);
  }
  for (const re of cfg.riskyPaths) {
    const hit = changed.find((f) => new RegExp(re).test(f));
    if (hit) security.push(`changes a security file: ${hit}`);
  }
  return { review, security };
}
