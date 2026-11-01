import { describe, expect, test } from "bun:test";
import { createEngine } from "../core/engine.ts";
import { makeFakes, planned, tk, until } from "./fakes.ts";

function setup() {
  const { ports, f } = makeFakes();
  const engine = createEngine(ports, { stagingRunner: true });
  f.engine = engine;
  const plan = (id = "P-01") => engine.state().plans[id]!;
  return { f, engine, plan, ports };
}

describe("staging through enigma-release", () => {
  test("every staging PR goes to one release run (TARGET=staging); then the staging test and master PRs as before", async () => {
    const { f, engine, plan } = setup();
    f.plan = planned([tk("T1"), tk("T2", { repo: "web" })]);
    const id = engine.submit("two repos");
    await until(() => plan(id).steps.plan === "you", "planned");
    engine.start(id);
    await until(() => plan(id).steps.master === "you" || !!plan(id).error, "master PRs");
    expect(plan(id).error).toBeUndefined();
    expect(f.calls.filter((c) => c.startsWith("release-start"))).toEqual(["release-start staging api#101,web#102"]);
    expect(f.calls.some((c) => c.startsWith("deploy-wait"))).toBe(false); // the runner waits for the deploys
    expect(f.calls).toEqual(expect.arrayContaining(["merge-pr uat #101", "merge-pr uat #102"]));
    expect(plan(id).stagingPrs.map((r) => [r.repo, r.state, r.deployed])).toEqual([["api", "merged", true], ["web", "merged", true]]);
    expect(plan(id).repos.every((r) => r.staged)).toBe(true);
    expect(plan(id).stagingRelease).toMatchObject({ state: "done", result: "SUCCESSFUL" });
    expect(f.testInputs.length).toBe(1);
    expect(plan(id).masterPrs.length).toBe(2);
    expect(engine.events(id).filter((e) => e.event === "deploy_wait" && e.ok).map((e) => e.repo).sort()).toEqual(["api", "web"]);
  });

  test("a run that fails stops the plan; Retry sends only the PRs still open to a new run", async () => {
    const { f, engine, plan } = setup();
    f.plan = planned([tk("T1"), tk("T2", { repo: "web" })]);
    f.runner.fail = { repo: "web", at: "pipeline", step: "Deploy to UAT", reason: "[ERROR] tests failed" };
    const id = engine.submit("two repos");
    await until(() => plan(id).steps.plan === "you", "planned");
    engine.start(id);
    await until(() => !!plan(id).error, "stopped");
    expect(plan(id).error).toContain("Release run #41 stopped at web, step 'Deploy to UAT'");
    expect(plan(id).steps.staging).toBe("fail");
    engine.retry(id);
    await until(() => plan(id).steps.master === "you" || (!!plan(id).error && f.calls.filter((c) => c.startsWith("release-start")).length > 1), "after retry");
    expect(f.calls.filter((c) => c.startsWith("release-start"))[0]).toBe("release-start staging api#101,web#102");
    expect(f.calls.filter((c) => c.startsWith("release-start")).length).toBe(1); // web merged before its pipeline failed: nothing left to send
    expect(plan(id).error).toBeUndefined();
  });

  test("a restart during the run follows the same run; nothing is merged twice", async () => {
    const { f, ports, plan } = setup();
    f.plan = planned([tk("T1")]);
    let hold = true; const status = ports.release!.status; ports.release!.status = async (u) => { while (hold) await Bun.sleep(2); return status(u); };
    const e1 = createEngine(ports, { stagingRunner: true }); f.engine = e1;
    const id = e1.submit("one repo");
    await until(() => e1.state().plans[id]!.steps.plan === "you", "planned");
    e1.start(id);
    await until(() => e1.state().plans[id]!.stagingRelease?.state === "running", "run started");
    e1.stop(id); hold = false;
    await until(() => !e1.inflightKeys().some((k) => k.startsWith("staging:")), "staging step ended");
    const e2 = createEngine(ports, { stagingRunner: true }); f.engine = e2; // a new server on the same data
    e2.recover(); e2.retry(id);
    await until(() => e2.state().plans[id]!.steps.master === "you" || !!e2.state().plans[id]!.error, "master PRs");
    expect(e2.state().plans[id]!.error).toBeUndefined();
    expect(f.calls.filter((c) => c.startsWith("release-start"))).toEqual(["release-start staging api#101"]);
  });

  test("a target-branch plan still merges into its branch directly, not through the runner", async () => {
    const { f, engine, plan } = setup();
    f.plan = planned([tk("T1")]);
    const id = engine.submit("feature part", { targetBranch: "feat/x" });
    await until(() => plan(id).steps.plan === "you", "planned");
    engine.start(id);
    await until(() => !!plan(id).landedAt || !!plan(id).error, "landed");
    expect(f.calls.some((c) => c.startsWith("release-start"))).toBe(false);
    expect(f.calls).toContain("merge-pr feat/x #101");
  });
});

describe("Retry after a failed release run carries on from what is left", () => {
  test("a promotion: merged repos count as done, open PRs are reused, the new run gets only the rest", async () => {
    const { f, engine, plan } = setup();
    f.plan = planned([tk("T1"), tk("T2", { repo: "web" })]);
    const a = engine.submit("part 1", { targetBranch: "feat/x" });
    await until(() => plan(a).steps.plan === "you", "planned");
    engine.start(a);
    await until(() => !!plan(a).landedAt || !!plan(a).error, "landed");
    const pid = await engine.promote({ branch: "feat/x" });
    f.runner.fail = { repo: "web", at: "merge", reason: "IncompleteRead" };
    engine.start(pid);
    await until(() => !!plan(pid).error, "release run stopped");
    const stagingPushes = () => f.calls.filter((c) => c.startsWith("push ") && c.endsWith(" prflow/p-02-promote-feat-x")).length, pushes = stagingPushes();
    const before = plan(pid).stagingPrs.map((r) => [r.repo, r.state]);
    expect(before).toEqual([["api", "merged"], ["web", "open"]]);
    f.runner.fail = undefined;
    engine.retry(pid);
    await until(() => plan(pid).steps.master === "you" || (!!plan(pid).error && f.calls.filter((c) => c.startsWith("release-start")).length > 1), "after retry");
    expect(plan(pid).error).toBeUndefined();
    const starts = f.calls.filter((c) => c.startsWith("release-start"));
    expect(starts.length).toBe(2);
    expect(starts[1]).toBe("release-start staging web#" + plan(pid).stagingPrs.find((r) => r.repo === "web")!.id); // only what was left
    expect(stagingPushes()).toBe(pushes); // no staging PR prepared again
    expect(plan(pid).stagingPrs.filter((r) => r.repo === "web").length).toBe(1); // the same PR, not a new one
    expect(engine.events(pid).some((e) => e.event === "pr_reused")).toBe(true);
  });
});
