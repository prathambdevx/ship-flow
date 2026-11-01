// wholeGuard on a port plan: lines from the plan's own staging commits skip the guard; lines a port run wrote do not.
import { expect, test } from "bun:test";
import { wholeGuard } from "../core/worktrees.ts";
import type { Ctx } from "../core/store.ts";

const ctxWith = (diff: string, files: string[]) => {
  const evs: string[] = [];
  const ctx = { ports: { git: { changedFiles: async () => files, diff: async () => diff }, diffGuard: (_f: string[], d: string) => (/^\+.*System\.getenv/m.test(d) ? "reads the environment" : null) }, ev: (_p: string, _e: string, x?: { text?: string }) => evs.push(x?.text ?? "") } as unknown as Ctx;
  return { ctx, evs };
};
const file = "src/test/java/StoIT.java";
const diff = (line: string) => `--- a/${file}\n+++ b/${file}\n@@ -0,0 +1 @@\n+    ${line}\n`;
const allow = { files: new Set([file]), lines: new Set(['+    String url = System.getenv("STO_IT_JDBC_URL");'.trim()]) };

test("a staging line passes on a port plan, and is refused without the allow-list", async () => {
  const { ctx, evs } = ctxWith(diff('String url = System.getenv("STO_IT_JDBC_URL");'), [file]);
  expect(await wholeGuard(ctx, "P-01", "/d", "origin/master", "repo master", allow)).toBeNull();
  expect(evs[0]).toContain("allowed because the port's staging commits changed them");
  expect(await wholeGuard(ctx, "P-01", "/d", "origin/master", "repo master")).toBe("reads the environment");
});

test("a risky line the port run wrote is still refused", async () => {
  const { ctx } = ctxWith(diff('String pw = System.getenv("PROD_PASSWORD");'), [file]);
  expect(await wholeGuard(ctx, "P-01", "/d", "origin/master", "repo master", allow)).toBe("reads the environment");
});
