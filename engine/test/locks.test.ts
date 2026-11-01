import { expect, test } from "bun:test";
import { canClaim, lockLine, waitsOnFor } from "../core/locks.ts";
import { mkPlan, mkState, mkTask } from "./fixtures.ts";

const A = (o = {}) => mkPlan({ id: "P-10", order: 1, ...o });
const B = (o = {}) => mkPlan({ id: "P-11", order: 2, ...o });
const a1 = (o = {}) => mkTask({ planId: "P-10", label: "T1", files: ["src/main/StoService.java", "x.ts"], ...o });
const b1 = (o = {}) => mkTask({ planId: "P-11", label: "T1", files: ["src/main/StoService.java"], ...o });

test("later plan waits for earlier plan sharing a file", () => {
  const s = mkState([A(), B()], [a1(), b1()]);
  expect(waitsOnFor(s, "P-11/T1")).toEqual(["P-10/T1"]);
  expect(lockLine(s, "P-11/T1")).toBe("Waits for P-10 to reach staging (StoService.java)");
});
test("earlier plan never waits for a later one", () => {
  const s = mkState([A(), B()], [a1(), b1()]);
  expect(waitsOnFor(s, "P-10/T1")).toEqual([]);
  expect(lockLine(s, "P-10/T1")).toBeNull();
});
test("no wait: different repo, no shared file, removed holder, staged holder", () => {
  expect(waitsOnFor(mkState([A(), B()], [a1({ repo: "web" }), b1()]), "P-11/T1")).toEqual([]);
  expect(waitsOnFor(mkState([A(), B()], [a1({ files: ["other"] }), b1()]), "P-11/T1")).toEqual([]);
  expect(waitsOnFor(mkState([A(), B()], [a1({ status: "removed" }), b1()]), "P-11/T1")).toEqual([]);
  const staged = A({ repos: [{ repo: "api", base: "", branch: "", dir: "", order: 1, stagingCommits: [], staged: true }] });
  expect(waitsOnFor(mkState([staged, B()], [a1(), b1()]), "P-11/T1")).toEqual([]);
});
test("staged in another repo does not release", () => {
  const p = A({ repos: [{ repo: "web", base: "", branch: "", dir: "", order: 1, stagingCommits: [], staged: true }] });
  expect(waitsOnFor(mkState([p, B()], [a1(), b1()]), "P-11/T1")).toEqual(["P-10/T1"]);
});
test("same plan tasks never lock each other; unknown task is empty", () => {
  const s = mkState([A()], [a1(), mkTask({ planId: "P-10", label: "T2", files: ["x.ts"] })]);
  expect(waitsOnFor(s, "P-10/T2")).toEqual([]);
  expect(waitsOnFor(s, "nope")).toEqual([]);
  expect(lockLine(s, "nope")).toBeNull();
});
test("canClaim: free files", () => {
  const s = mkState([A(), B()], [a1(), b1()]);
  expect(canClaim(s, s.tasks["P-11/T1"], ["fresh.ts"])).toBeNull();
});
test("canClaim: refused when same plan+repo task owns the file", () => {
  const s = mkState([A()], [a1(), mkTask({ planId: "P-10", label: "T2", files: ["y.ts"] })]);
  expect(canClaim(s, s.tasks["P-10/T2"], ["x.ts"])).toContain("T1");
  expect(canClaim(s, s.tasks["P-10/T2"], ["z.ts"])).toBeNull();
});
test("canClaim: ignores removed task and other repo in the same plan", () => {
  const s = mkState([A()], [a1({ status: "removed" }), mkTask({ planId: "P-10", label: "T2", files: ["y.ts"] })]);
  expect(canClaim(s, s.tasks["P-10/T2"], ["x.ts"])).toBeNull();
  const s2 = mkState([A()], [a1({ repo: "web" }), mkTask({ planId: "P-10", label: "T2", files: ["y.ts"] })]);
  expect(canClaim(s2, s2.tasks["P-10/T2"], ["x.ts"])).toBeNull();
});
test("canClaim: refused when an earlier plan holds the file", () => {
  const s = mkState([A(), B()], [a1(), b1()]);
  expect(canClaim(s, s.tasks["P-11/T1"], ["unrelated.ts"])).toBeNull();
  expect(canClaim(s, s.tasks["P-11/T1"], ["src/main/StoService.java"])).toContain("P-10");
});
test("canClaim: later plan does not block the earlier one", () => {
  const s = mkState([A(), B()], [a1(), b1()]);
  expect(canClaim(s, s.tasks["P-10/T1"], ["src/main/StoService.java"])).toBeNull();
});
test("canClaim: a done task of the same plan gives up its files; a waiting one does not", () => {
  const s = mkState([A()], [a1({ status: "done" }), mkTask({ planId: "P-10", label: "T2", files: ["y.ts"] })]);
  expect(canClaim(s, s.tasks["P-10/T2"], ["x.ts"])).toBeNull();
  const s2 = mkState([A()], [a1({ status: "waiting" }), mkTask({ planId: "P-10", label: "T2", files: ["y.ts"] })]);
  expect(canClaim(s2, s2.tasks["P-10/T2"], ["x.ts"])).toContain("T1");
});
test("canClaim: a waiting task that depends on the claimer gives up its files; one that does not, or has started, keeps them", () => {
  const t2 = (o = {}) => mkTask({ planId: "P-10", label: "T2", files: ["y.ts"], ...o });
  const t3 = (o = {}) => mkTask({ planId: "P-10", label: "T3", files: ["x.ts"], status: "waiting", deps: ["P-10/T2"], ...o });
  const s = mkState([A()], [t2(), t3()]);
  expect(canClaim(s, s.tasks["P-10/T2"], ["x.ts"])).toBeNull();
  const via = mkState([A()], [t2(), mkTask({ planId: "P-10", label: "T4", files: [], deps: ["P-10/T2"] }), t3({ deps: ["P-10/T4"] })]);
  expect(canClaim(via, via.tasks["P-10/T2"], ["x.ts"])).toBeNull();
  const free = mkState([A()], [t2(), t3({ deps: [] })]);
  expect(canClaim(free, free.tasks["P-10/T2"], ["x.ts"])).toContain("T3");
  const started = mkState([A()], [t2(), t3({ commits: ["abc"] })]);
  expect(canClaim(started, started.tasks["P-10/T2"], ["x.ts"])).toContain("T3");
  const working = mkState([A()], [t2(), t3({ status: "working" })]);
  expect(canClaim(working, working.tasks["P-10/T2"], ["x.ts"])).toContain("T3");
});
