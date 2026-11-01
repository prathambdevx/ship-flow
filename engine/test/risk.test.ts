import { expect, test } from "bun:test";
import { diffRisk } from "../core/risk.ts";
import { DEFAULTS } from "../config.ts";

const add = (...ls: string[]) => ls.map((l) => `+${l}`).join("\n");

test("a planned small change raises nothing", () => {
  expect(diffRisk(["src/A.java"], ["src/A.java"], add("dto.setMasterEmail(email);"), false, DEFAULTS)).toEqual({ review: [], security: [] });
});
test("outside files, a debugger fix and a big diff turn the review on", () => {
  const r = diffRisk(["src/A.java"], ["src/A.java", "src/B.java"], add(...Array(151).fill("x();")), true, DEFAULTS);
  expect(r.review.length).toBe(3);
  expect(r.security).toEqual([]);
});
test("endpoints, concatenated SQL and security files turn the security review on", () => {
  expect(diffRisk(["a"], ["a"], add('@PostMapping("/x")'), false, DEFAULTS).security.length).toBe(1);
  expect(diffRisk(["a"], ["a"], add('String q = "SELECT * FROM t WHERE id = " + id;'), false, DEFAULTS).security.length).toBe(1);
  expect(diffRisk(["src/security/AuthFilter.java"], ["src/security/AuthFilter.java"], add("int x;"), false, DEFAULTS).security.length).toBeGreaterThan(0);
});

test("a risky line in a test file, or a string joined only from constants, does not turn security on", () => {
  const cfg2 = { ...DEFAULTS };
  const diff = (file: string, line: string) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1,2 @@\n+${line}\n`;
  const scan = (file: string, line: string) => diffRisk([file], [file], diff(file, line), false, cfg2).security;
  expect(scan("src/test/java/a/RouterTest.java", "when(em.createNativeQuery(anyString())).thenReturn(q);")).toEqual([]);
  expect(scan("src/main/java/a/Repo.java", `String q = "where e.status = 'IGNORED' and e.lastError like '" + NOT_IN_ENIGMA_LIKE + "'";`)).toEqual([]);
  expect(scan("src/main/java/a/Repo.java", `String q = "select * from t where id = " + userId;`).length).toBe(1);
  expect(scan("src/main/java/a/Repo.java", "em.createNativeQuery(sql);").length).toBe(1);
});
