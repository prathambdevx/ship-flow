import { describe, expect, test } from "bun:test";
import { createEngine } from "../core/engine.ts";
import { makeFakes, planned, tk, until } from "./fakes.ts";

const ready = (t: { status: string; terminal?: { readyAt?: number; done?: unknown } }) => t.status === "working" && !!t.terminal?.readyAt && !t.terminal.done;

// Runs one terminal plan to the master step (or to the end of staging for stagingOnly).
async function drive(cfg: Record<string, unknown>, opts: { stagingOnly?: boolean; noRelease?: boolean } = {}) {
  const { ports, f } = makeFakes();
  if (opts.noRelease) delete (ports as any).release;
  const engine = createEngine(ports, { buildEachTask: false, terminalOnly: true, ...cfg });
  f.engine = engine;
  const plan = () => engine.state().plans["P-01"]!;
  const id = await engine.adopt(planned([tk("T1")]), { session: "s" }, { stagingOnly: opts.stagingOnly });
  await until(() => ready(engine.state().tasks["P-01/T1"]!), "T1 ready");
  f.dirs.get(engine.state().tasks["P-01/T1"]!.dir!)!.pending.add("src/T1.ts");
  engine.taskDone(id, "T1", "Did T1.");
  await until(() => !!plan().terminal?.sweep || !!plan().terminal?.uat, "review or staging test");
  if (plan().terminal?.sweep) { engine.sweepAnswer(id, []); await until(() => !!plan().terminal?.uat, "staging test"); }
  engine.uatAnswer(id, { exercised: true, passed: true, proof: "ok", checks: [{ what: "w", ok: true, task: "T1" }] });
  return { f, engine, plan, id };
}

describe("built-in backend flags", () => {
  test("watchMasterPrs: the plan goes live once its master PRs are merged on the git host", async () => {
    const { f, engine, plan } = await drive({ watchMasterPrs: true }, { noRelease: true });
    await until(() => plan().steps.master === "you", "master PRs");
    await engine.watchMasterPrs();
    expect(plan().steps.master).toBe("you"); // still open
    for (const pr of f.prs.filter((x) => x.dest === "master")) pr.state = "merged";
    await engine.watchMasterPrs();
    expect(plan().steps.master).toBe("done");
    expect(plan().liveAt).toBeGreaterThan(0);
    expect(plan().masterPrs.every((r) => r.state === "merged")).toBe(true);
  });

  test("without a release runner, Merge says to merge on the git host", async () => {
    const { engine, plan, id } = await drive({}, { noRelease: true });
    await until(() => plan().steps.master === "you", "master PRs");
    await expect(engine.mergeMaster(id)).rejects.toThrow("git host");
  });

  test("cleanFinished: a staging-only plan loses its worktree folders once; branches stay", async () => {
    const { f, engine, plan } = await drive({ cleanFinished: true }, { stagingOnly: true });
    await until(() => !!plan().cleanedAt, "clean-up");
    expect(f.dirs.size).toBe(0);
    const n = () => engine.events("P-01").filter((e) => e.event === "worktrees_dropped").length;
    expect(n()).toBe(1);
    engine.tick(); await new Promise((r) => setTimeout(r, 20));
    expect(n()).toBe(1);
  });

  test("cleanFinished off (the default): the folders stay", async () => {
    const { f, plan } = await drive({}, { stagingOnly: true });
    await until(() => plan().steps.uat === "done", "uat done");
    await new Promise((r) => setTimeout(r, 30));
    expect(plan().cleanedAt).toBeUndefined();
    expect(f.dirs.size).toBeGreaterThan(0);
  });

  test("cleanFinished also runs on recover() for a plan that finished before", async () => {
    const { f, engine, plan } = await drive({}, { stagingOnly: true });
    await until(() => plan().steps.uat === "done", "uat done");
    (engine.config as any).cleanFinished = true;
    engine.recover();
    await until(() => !!plan().cleanedAt && f.dirs.size === 0, "clean-up after recover");
  });
});
