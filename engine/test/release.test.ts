import { describe, expect, test } from "bun:test";
import { createEngine } from "../core/engine.ts";
import { createHandler } from "../http.ts";
import { configPlan, judge, onlyAddedLines } from "../core/release.ts";
import { parseRunLog, reasonLine } from "../core/runlog.ts";
import { makeFakes, until } from "./fakes.ts";

const pom = `<project>\n  <dependencies>\n    <dependency>\n      <artifactId>common-contracts</artifactId>\n      <version>1.0.0.280</version>\n    </dependency>\n  </dependencies>\n</project>\n`;
const PRE = "select x from bad", ADD = "alter table t add column if not exists c int", AFTER_PRE = "select * from queue", SWITCH = "insert into s values (1) on conflict do nothing";
const steps = () => [
  { id: "pre", kind: "preflight", title: "Preflight", database: "inv", file: { repo: "api", path: "db/pre.sql" }, checks: [{ query: 1, expect: "no_rows", why: "no bad rows" }], rerun: true },
  { id: "add", kind: "sql", title: "Additive", database: "inv", file: { repo: "api", path: "db/add.sql" }, rerun: true },
  { id: "col", kind: "sql", title: "Inline column", database: "po", sql: "alter table u add column if not exists d int", rerun: true },
  { id: "cfg", kind: "config", title: "Lambda names", before: "api", config: { repo: "cfg-repo", branch: "master", file: "po-prod.yml", under: "    A: A-Prod", add: ["    B: B-Prod", "    C: C-Prod"], message: "Add B and C" }, rerun: true },
  { id: "rel", kind: "release", title: "Release common-contracts", after: "common-contracts", lib: "common-contracts", version: "1.0.0.280", rerun: true },
  { id: "apre", kind: "preflight", title: "Switch preflight", after: "api", database: "po", sql: AFTER_PRE, checks: [], rerun: true },
  { id: "switch", kind: "sql", title: "Switch mode", after: "api", database: "po", sql: SWITCH, allow: ["upsert"], tables: ["s"], rerun: true },
];

async function setup() {
  const { ports, f } = makeFakes({ repos: ["common-contracts", "api"] });
  const engine = createEngine(ports); f.engine = engine;
  f.remote.set("common-contracts/uat", ["base-cc-uat", "aaaa111"]); f.remote.set("api/uat", ["base-api-uat", "bbbb222"]);
  f.commitFiles.set("aaaa111", ["src/C.java"]); f.commitFiles.set("bbbb222", ["src/A.java"]);
  f.libNames = ["common-contracts"]; f.poms = { api: { "pom.xml": pom } };
  f.files = { "api:db/pre.sql": PRE, "api:db/add.sql": ADD };
  f.released = () => !!f.prs.find((x) => x.repo === "common-contracts" && x.dest === "master")?.merged; // the tag comes with the library's master merge
  const id = await engine.port({ title: "STO v2", text: "to prod", repos: [{ repo: "common-contracts", order: 1, commits: ["aaaa111"] }, { repo: "api", order: 2, commits: ["bbbb222"] }] });
  const plan = () => engine.state().plans[id]!;
  await until(() => plan().steps.master === "you" || !!plan().error, "master PRs");
  expect(plan().error).toBeUndefined();
  const at = (c: string) => f.calls.findIndex((x) => x.startsWith(c));
  const finish = () => until(() => plan().steps.master === "done" || (!!plan().error && !plan().merging), "merge ends");
  const names = () => engine.events(id).map((e) => e.event);
  return { f, ports, engine, id, plan, at, finish, names };
}

describe("release steps around the enigma-release run", () => {
  test("every before step runs before the run starts; after steps run only once it succeeded", async () => {
    const { f, engine, id, plan, at, finish, names } = await setup();
    await engine.setReleaseSteps(id, steps());
    expect(plan().releaseSteps!.map((s) => s.state)).toEqual(["", "", "", "", "", "", ""]);
    expect(plan().releaseSteps![0]!.text).toBe(PRE);
    await expect(engine.mergeMaster(id)).rejects.toThrow("Confirm both prompts");
    await engine.mergeMaster(id, { prodWrites: true });
    await finish();
    expect(plan().error).toBeUndefined();
    const order = [`sql-check inv ${PRE}`, `sql-run inv ${ADD}`, "sql-run po alter table u", "config-commit po-prod.yml", "config-push cfg-repo master", "release-start master common-contracts#101,api#102", "merge-pr master #101", "merge-pr master #102", `sql-check po ${AFTER_PRE}`, `sql-run po ${SWITCH}`];
    const idx = order.map(at);
    expect(idx.every((x) => x >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(plan().releaseSteps!.every((s) => s.state === "done")).toBe(true);
    expect(plan().releaseSteps!.find((s) => s.id === "rel")!.result).toBe("common-contracts 1.0.0.280 is released");
    expect(plan().steps.master).toBe("done");
    expect(plan().masterPrs.every((r) => r.state === "merged" && r.deployed && !r.run)).toBe(true);
    expect(plan().masterPrs.map((r) => r.pipeline)).toEqual(["https://bitbucket.org/bsctech/common-contracts/pipelines/results/7", "https://bitbucket.org/bsctech/api/pipelines/results/7"]);
    expect(names()).toEqual(expect.arrayContaining(["release_steps_set", "release_step_start", "release_step", "release_run_start", "release_run_done"]));
    expect(f.configPushed.length).toBe(1);
    expect(f.calls.some((c) => c.startsWith("deploy-wait"))).toBe(false);
  });

  test("a failed preflight stops before any write or the run", async () => {
    const { f, engine, id, plan, finish } = await setup();
    f.preflight[PRE] = [{ sql: PRE, rows: [{ x: 1 }] }];
    await engine.setReleaseSteps(id, steps());
    await engine.mergeMaster(id, { prodWrites: true });
    await finish();
    expect(plan().error).toContain("Preflight found a problem, so nothing was written or merged after it");
    expect(plan().error).toContain("no bad rows");
    expect(f.calls.some((c) => c.startsWith("sql-run") || c.startsWith("release-start") || c.startsWith("config-"))).toBe(false);
    expect(plan().steps.master).toBe("you"); // Retry, then Merge again
  });

  test("the config guard refuses a commit that changes more than the listed lines; nothing is pushed and no run starts", async () => {
    const { f, engine, id, plan, finish } = await setup();
    f.configCommit = (text) => ({ files: ["po-prod.yml"], text: text.replace("A: A-Prod", "A: Other") });
    await engine.setReleaseSteps(id, steps());
    await engine.mergeMaster(id, { prodWrites: true });
    await finish();
    expect(plan().error).toContain("refused before the push");
    expect(plan().error).toContain("nothing was written or merged after it");
    expect(f.configPushed).toEqual([]);
    expect(f.calls.some((c) => c.startsWith("release-start"))).toBe(false);
  });

  test("while the runner waits for a library tag, the plan says to click Create Release Version", async () => {
    const { f, ports, engine, id, plan, finish } = await setup();
    f.runner.tagWait = { repo: "common-contracts", tag: "common-contracts-1.0.0.280" };
    const seen: string[] = [], real = ports.release!.status;
    ports.release!.status = async (uuid) => { seen.push(plan().now); if (plan().release?.waitTag) seen.push(`wait ${plan().release!.waitTag!.tag} ${plan().masterPrs[0]!.run}`); return real(uuid); };
    await engine.setReleaseSteps(id, steps());
    await engine.mergeMaster(id, { prodWrites: true });
    await finish();
    expect(plan().error).toBeUndefined();
    expect(seen).toContain("Release run #41: waiting for tag common-contracts-1.0.0.280. Click Create Release Version in common-contracts's master pipeline.");
    expect(seen).toContain("wait common-contracts-1.0.0.280 tag");
    expect(plan().release!.waitTag).toBeUndefined();
  });

  test("a tag that never comes stops the run; the library is merged, and the re-click waits until it is released", async () => {
    const { f, engine, id, plan, finish } = await setup();
    f.runner.tagWait = { repo: "common-contracts", tag: "common-contracts-1.0.0.280" };
    f.runner.fail = { repo: "common-contracts", at: "tag" };
    f.released = () => false;
    await engine.setReleaseSteps(id, steps().filter((s) => s.kind !== "release"));
    await engine.mergeMaster(id, { prodWrites: true });
    await finish();
    expect(plan().error).toContain("Release run #41 stopped at common-contracts, step 'release tag': release common-contracts 1.0.0.280 first (Create Release Version)");
    expect(plan().masterPrs.map((r) => [r.state, !!r.deployed])).toEqual([["merged", true], ["open", false]]);
    engine.retry(id);
    await engine.mergeMaster(id, { prodWrites: true });
    await finish();
    expect(plan().error).toContain("api PR #102 depends on common-contracts 1.0.0.280, which is not released");
    f.released = () => true;
    engine.retry(id);
    await engine.mergeMaster(id, { prodWrites: true });
    await finish();
    expect(plan().error).toBeUndefined();
    expect(f.calls.filter((c) => c.startsWith("release-start"))).toEqual(["release-start master common-contracts#101,api#102", "release-start master api#102"]);
  });

  test("a library merged earlier and not released stops before the run", async () => {
    const { f, engine, id, plan, finish } = await setup();
    await engine.setReleaseSteps(id, steps());
    const cc = plan().masterPrs.find((r) => r.repo === "common-contracts")!;
    Object.assign(cc, { state: "merged", deployed: true, merge: undefined }); // merged earlier, outside this merge
    await engine.mergeMaster(id, { prodWrites: true });
    await finish();
    expect(plan().error).toContain("api PR #102 depends on common-contracts 1.0.0.280, which is not released. Merge and release common-contracts 1.0.0.280 first.");
    expect(f.calls.some((c) => c.startsWith("release-start"))).toBe(false);
  });

  test("a re-click after a failed after step skips the steps and PRs already done", async () => {
    const { f, engine, id, plan, finish, names } = await setup();
    f.sqlFail[SWITCH] = "lock timeout";
    await engine.setReleaseSteps(id, steps());
    await engine.mergeMaster(id, { prodWrites: true });
    await finish();
    expect(plan().error).toContain("Switch mode failed");
    expect(plan().masterPrs.every((r) => r.deployed)).toBe(true);
    delete f.sqlFail[SWITCH];
    const before = f.calls.length;
    engine.retry(id);
    await engine.mergeMaster(id, { prodWrites: true });
    await finish();
    expect(plan().error).toBeUndefined();
    const again = f.calls.slice(before);
    expect(again.filter((c) => c.startsWith("merge-pr") || c.startsWith("config-") || c.startsWith("release-start") || c.includes(ADD) || c.includes(PRE))).toEqual([]);
    expect(again).toContain(`sql-check po ${AFTER_PRE}`); // the group's preflight runs again before its write
    expect(again).toContain(`sql-run po ${SWITCH}`);
    expect(names()).toContain("release_step_skipped");
  });

  test("a by-hand deploy stops once before its after steps, as a question; Retry and Merge runs them", async () => {
    const { f, engine, id, plan, at, finish } = await setup();
    f.runner.noPipeline.add("api");
    await engine.setReleaseSteps(id, steps());
    await engine.mergeMaster(id, { prodWrites: true });
    await finish();
    expect(plan().error).toContain("api deploys by hand, so the steps after its deploy did not run");
    expect(plan().askYou).toBe(true);
    expect(at(`sql-run po ${SWITCH}`)).toBe(-1);
    engine.retry(id);
    expect(plan().askYou).toBeUndefined();
    await engine.mergeMaster(id, { prodWrites: true });
    await finish();
    expect(plan().error).toBeUndefined();
    expect(at(`sql-run po ${SWITCH}`)).toBeGreaterThan(-1);
  });

  test("a failed deploy: the reason, the failed repo and step, the run link; no after step runs", async () => {
    const { f, engine, id, plan, finish } = await setup();
    await engine.setReleaseSteps(id, steps());
    f.runner.fail = { repo: "api", step: "Deploy to ECS", reason: "[ERROR] Service bsc-api did not stabilize" };
    await engine.mergeMaster(id, { prodWrites: true });
    await finish();
    expect(plan().error).toBe("Release run #41 stopped at api, step 'Deploy to ECS': [ERROR] Service bsc-api did not stabilize (merged so far: common-contracts, api). https://bitbucket.org/bsctech/enigma-release/pipelines/results/41");
    expect(plan().release).toMatchObject({ state: "fail", result: "FAILED", failed: { repo: "api", step: "Deploy to ECS", reason: "[ERROR] Service bsc-api did not stabilize" } });
    expect(plan().masterPrs.map((r) => r.run)).toEqual([undefined, "failed"]);
    expect(f.calls).toContain("merge-pr master #102");
    expect(f.calls.some((c) => c.includes(AFTER_PRE) || c.includes(SWITCH))).toBe(false);
    expect(engine.events(id).some((e) => e.event === "master_deploy" && e.ok === false && e.repo === "api")).toBe(true);
  });

  test("a re-click after a failed merge sends only the PRs still open", async () => {
    const { f, engine, id, plan, finish } = await setup();
    await engine.setReleaseSteps(id, steps());
    f.runner.fail = { repo: "api", at: "merge" };
    await engine.mergeMaster(id, { prodWrites: true });
    await finish();

    expect(plan().error).toContain("stopped at api, step 'merge'");
    expect(plan().masterPrs.map((r) => r.state)).toEqual(["merged", "open"]);
    engine.retry(id);
    await engine.mergeMaster(id, { prodWrites: true });
    await finish();
    expect(plan().error).toBeUndefined();
    expect(f.calls.filter((c) => c.startsWith("release-start"))).toEqual(["release-start master common-contracts#101,api#102", "release-start master api#102"]);
    expect(f.calls.filter((c) => c.startsWith("config-push")).length).toBe(1); // done steps stay done
  });

  test("a hand-off to a new run is followed to the end", async () => {
    const { f, engine, id, plan, finish, names } = await setup();
    f.runner.handoffAfter = 1;
    await engine.mergeMaster(id, { prodWrites: true });
    await finish();
    expect(plan().error).toBeUndefined();
    expect(f.calls).toContain("release-handoff api#102");
    expect(plan().release!.runs.map((r) => r.run)).toEqual([41, 42]);
    expect(plan().release).toMatchObject({ run: 42, state: "done" });
    expect(names()).toContain("release_run_handoff");
    expect(plan().masterPrs.every((r) => r.state === "merged" && r.deployed)).toBe(true);
    expect(f.calls.filter((c) => c.startsWith("release-start")).length).toBe(1);
  });

  test("a run that does not start is an error and never retried on its own; a stop mid-run is watched again, not started again", async () => {
    const { f, ports, engine, id, plan, finish } = await setup();
    f.runner.startFails = "Bitbucket said 500";
    await engine.mergeMaster(id, { prodWrites: true });
    await finish();
    expect(plan().error).toContain("The release pipeline did not start: Bitbucket said 500. Check the pipelines page of the release pipeline");
    expect(f.calls.filter((c) => c.startsWith("release-start")).length).toBe(1);
    f.runner.startFails = null;
    const real = ports.release!.status;
    let polls = 0;
    ports.release!.status = async (uuid) => { if (++polls === 2) engine.stop(id); return real(uuid); };
    engine.retry(id);
    await engine.mergeMaster(id, { prodWrites: true });
    await until(() => engine.events(id).some((e) => e.event === "stopped"), "stopped");
    expect(plan().release!.state).toBe("running");
    engine.retry(id);
    await engine.mergeMaster(id, { prodWrites: true });
    await finish();
    expect(plan().error).toBeUndefined();
    expect(f.calls.filter((c) => c.startsWith("release-start")).length).toBe(2); // the failed start, then one run
  });

  test("a hand-off run that never shows is an error, not live", async () => {
    const { f, ports, engine, id, plan, finish } = await setup();
    f.runner.handoffAfter = 1;
    ports.release!.after = async () => null;
    await engine.mergeMaster(id, { prodWrites: true });
    await finish();
    expect(plan().error).toContain("Release run #41 ended with api not merged, and no follow-up run was found");
    expect(plan().steps.master).toBe("you");
    expect(plan().release!.state).toBe("fail");
  });

  test("Merge is refused on a host with no release runner", async () => {
    const { ports, engine, id } = await setup();
    delete ports.release;
    await expect(engine.mergeMaster(id, { prodWrites: true })).rejects.toThrow("no release runner");
  });

  test("setting the steps is checked", async () => {
    const { engine, id, plan } = await setup();
    const bad = async (o: object, i = 1) => { const s = steps(); Object.assign(s[i]!, o); try { await engine.setReleaseSteps(id, s); return "no error"; } catch (e: any) { return e.message as string; } };
    expect(await bad({ file: { repo: "api", path: "../x.sql" } })).toContain("must be a .sql file");
    expect(await bad({ file: { repo: "web", path: "db/x.sql" } })).toContain("no open master PR");
    expect(await bad({ file: undefined, sql: "drop table t" })).toContain("it drops something");
    expect(await bad({ database: "nope" })).toContain("unknown database");
    expect(await bad({ checks: undefined }, 0)).toContain("needs \"checks\"");
    expect(await bad({ config: { repo: "cfg-repo", branch: "master", file: "po-prod.yml", under: "    Z: none", add: ["    B: B"], message: "m" } }, 3)).toContain("there 0 times");
    expect(await bad({ after: "api" }, 4)).toContain("runs \"after\" its own library's PR");
    expect(await bad({ before: "nowhere" }, 3)).toContain("must be a repo with a master PR");
    expect(plan().releaseSteps).toBeUndefined();
    await engine.setReleaseSteps(id, steps());
    expect(plan().releaseSteps!.length).toBe(7);
    await engine.setReleaseSteps(id, []);
    expect(plan().releaseSteps).toBeUndefined();
  });
});

describe("release step checks", () => {
  test("configPlan adds below the line, skips lines already there, refuses a key set differently", () => {
    const f = "lambda:\n  functions:\n    A: A-Prod";
    expect(configPlan(f, "    A: A-Prod", ["    B: B-Prod"]).text).toBe("lambda:\n  functions:\n    A: A-Prod\n    B: B-Prod");
    expect(configPlan(f, "    A: A-Prod", ["    A: A-Prod"])).toEqual({ missing: [] });
    expect(configPlan(f, "    A: A-Prod", ["    A: Other"]).err).toContain("already sets A differently");
    expect(configPlan(f + "\n    A: A-Prod", "    A: A-Prod", ["    B: x"]).err).toContain("2 times");
    expect(onlyAddedLines(f, "lambda:\n  functions:\n    A: A-Prod\n    B: B-Prod", "    A: A-Prod", ["    B: B-Prod"])).toBe(true);
    expect(onlyAddedLines(f, "lambda:\n  functions:\n    A: A-Prod\n    B: B-Prod\n", "    A: A-Prod", ["    B: B-Prod"])).toBe(false); // a new trailing newline is a change too
    expect(onlyAddedLines(f, "lambda:\n functions:\n    A: A-Prod\n    B: B-Prod", "    A: A-Prod", ["    B: B-Prod"])).toBe(false);
  });

  test("judge: no_rows and all_true", () => {
    expect(judge([{ query: 1, expect: "no_rows", why: "w" }], [{ rows: [] }])).toBeNull();
    expect(judge([{ query: 1, expect: "no_rows", why: "w" }], [{ rows: [{ a: 1 }] }])).toContain("returned 1 row(s)");
    expect(judge([{ query: 2, expect: "all_true", column: "ok", why: "w" }], [{ rows: [] }, { rows: [{ ok: true }] }])).toBeNull();
    expect(judge([{ query: 2, expect: "all_true", column: "ok", why: "w" }], [{ rows: [] }, { rows: [{ ok: false }] }])).toContain("ok = true");
    expect(judge([{ query: 3, expect: "no_rows", why: "w" }], [{ rows: [] }])).toContain("gave no result");
  });
});

describe("release steps over HTTP", () => {
  test("POST release-steps needs the page token; merge-master needs prodWrites", async () => {
    const { engine, id, plan } = await setup();
    const handle = createHandler(engine, { checkWrite: (req) => (req.headers.get("x-td-token") === "ok" ? null : "Missing page token") });
    const call = async (path: string, body: unknown, token = "ok") => { const url = new URL(`http://x/api/prflow/plans/${id}/${path}`); return (await handle(new Request(url, { method: "POST", body: JSON.stringify(body), headers: { "x-td-token": token } }), url))!; };
    expect((await call("release-steps", { steps: steps() }, "bad")).status).toBe(403);
    expect(plan().releaseSteps).toBeUndefined();
    expect((await call("release-steps", { steps: "x" })).status).toBe(400);
    expect((await call("release-steps", { steps: steps() })).status).toBe(200);
    expect(plan().releaseSteps!.length).toBe(7);
    const r = await call("merge-master", {});
    expect(r.status).toBe(400);
    expect((await r.json()).error).toContain("Confirm both prompts");
    expect((await call("merge-master", { prodWrites: true })).status).toBe(200);
  });
});

describe("a P-05 shaped release", () => {
  test("5 repos: every before step, one run with all 5 PRs, the common-contracts tag wait, then the switch after purchase-order-module", async () => {
    const repos = ["common-contracts", "inventory_module", "purchase-order-module", "bsc-admin", "bsc-api-gateway"];
    const { ports, f } = makeFakes({ repos });
    const engine = createEngine(ports); f.engine = engine;
    repos.forEach((r, i) => { f.remote.set(`${r}/uat`, [`base-${r}-uat`, `cccc00${i}`]); f.commitFiles.set(`cccc00${i}`, [`src/${i}.java`]); });
    f.libNames = ["common-contracts"]; f.poms = { inventory_module: { "pom.xml": pom }, "purchase-order-module": { "pom.xml": pom } };
    f.files = { "inventory_module:db/pre.sql": PRE, "inventory_module:db/add.sql": ADD };
    f.released = () => !f.runner.runs[0]?.tag && !!f.prs.find((x) => x.repo === "common-contracts" && x.dest === "master")?.merged;
    const id = await engine.port({ title: "STO v2", text: "to prod", repos: repos.map((repo, i) => ({ repo, order: i + 1, commits: [`cccc00${i}`] })) });
    const plan = () => engine.state().plans[id]!;
    await until(() => plan().steps.master === "you" || !!plan().error, "master PRs");
    const st = steps().map((x: any) => ({ ...x, ...(x.file ? { file: { ...x.file, repo: "inventory_module" } } : {}), ...(x.before ? { before: "purchase-order-module" } : {}), ...(x.after === "api" ? { after: "purchase-order-module" } : {}) }));
    await engine.setReleaseSteps(id, st);
    f.runner.tagWait = { repo: "common-contracts", tag: "common-contracts-1.0.0.280" };
    const seen: string[] = [], real = ports.release!.status;
    ports.release!.status = async (uuid) => { seen.push(plan().now); return real(uuid); };
    await engine.mergeMaster(id, { prodWrites: true });
    await until(() => plan().steps.master === "done" || (!!plan().error && !plan().merging), "merge ends");
    expect(plan().error).toBeUndefined();
    const at = (c: string) => f.calls.findIndex((x) => x.startsWith(c));
    const order = [`sql-check inv ${PRE}`, "config-push cfg-repo master", "release-start master common-contracts#101,inventory_module#102,purchase-order-module#103,bsc-admin#104,bsc-api-gateway#105", "merge-pr master #101", "merge-pr master #105", `sql-run po ${SWITCH}`].map(at);
    expect(order.every((x) => x >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(seen.some((x) => x.includes("Click Create Release Version in common-contracts's master pipeline"))).toBe(true);
    expect(plan().releaseSteps!.every((x) => x.state === "done")).toBe(true);
    expect(plan().masterPrs.every((r) => r.state === "merged" && r.deployed)).toBe(true);
  });
});

describe("enigma-release log", () => {
  const T = (t: string) => `[24/10 01:05:09 AM IST] ${t}`;
  test("each PR's step, the pipeline links, the tag wait, the merge hashes and a failure with its reason line", () => {
    const log = ["+ python3 -m unittest -q && python3 release.py", "Ran 21 tests in 0.010s", "OK",
      T("Target: master. Order: common-contracts#962 -> inventory_module#368 -> bsc-admin#3711"),
      T("Merging common-contracts#962 into master"), T("  pipeline https://bitbucket.org/bsctech/common-contracts/pipelines/results/880"),
      T("  waiting for tag common-contracts-1.0.0.280"), T("  tag common-contracts-1.0.0.280 found"),
      T("Merging inventory_module#368 into master"), T("  pipeline https://bitbucket.org/bsctech/inventory_module/pipelines/results/512"),
      T("inventory_module: pipeline ended FAILED: step 'Deploy to prod' failed (full log: release-logs/inventory_module-512.log). Last lines:"),
      "+ aws ecs update-service --cluster prod", "[INFO] waiting", "An error occurred (AccessDeniedException) when calling UpdateService", "+ exit 1",
      T(""), "repo                         PR     merge        pipeline       min",
      T("common-contracts             962    a1b2c3d4e5   SUCCESSFUL     6.2"), T("inventory_module             368    0f9e8d7c6b   FAILED         9.0"),
      "STOP: inventory_module pipeline ended FAILED. See https://bitbucket.org/bsctech/inventory_module/pipelines/results/512"].join("\n");
    const v = parseRunLog(log);
    expect(v.order).toEqual(["common-contracts#962", "inventory_module#368", "bsc-admin#3711"]);
    expect(v.prs["common-contracts"]).toMatchObject({ id: 962, state: "done", merged: true, merge: "a1b2c3d4e5", tag: "common-contracts-1.0.0.280" });
    expect(v.prs["inventory_module"]).toMatchObject({ state: "failed", merged: true, merge: "0f9e8d7c6b", pipeline: "https://bitbucket.org/bsctech/inventory_module/pipelines/results/512" });
    expect(v.prs["bsc-admin"]).toBeUndefined();
    expect(v.failed).toEqual({ repo: "inventory_module", step: "Deploy to prod", reason: "An error occurred (AccessDeniedException) when calling UpdateService" });
    expect(v.stop).toContain("inventory_module pipeline ended FAILED");
    expect(v.waitTag).toBeUndefined();
  });

  test("a tag wait in progress, a hand-off, no pipeline, and a stop before any merge", () => {
    const wait = parseRunLog([T("Merging common-contracts#962 into master"), T("  pipeline https://x/1"), T("  waiting for tag common-contracts-1.0.0.280")].join("\n"));
    expect(wait.waitTag).toEqual({ repo: "common-contracts", tag: "common-contracts-1.0.0.280" });
    expect(wait.prs["common-contracts"]!.state).toBe("tag");
    const hand = parseRunLog([T("Merging a#1 into master"), T("WARNING: no pipeline for a on master after 10 minutes. Continuing"), T("Time limit near. Started a new run for the rest: b#2,c#3\n  https://bitbucket.org/bsctech/enigma-release/pipelines/results/57")].join("\n"));
    expect(hand.prs.a).toMatchObject({ state: "done", noPipeline: true, merged: true });
    expect(hand.handoff).toEqual({ run: 57, url: "https://bitbucket.org/bsctech/enigma-release/pipelines/results/57", prs: ["b#2", "c#3"] });
    const early = parseRunLog("STOP: bsc-admin#3711 is MERGED, not OPEN. Nothing was merged");
    expect(early.failed).toBeUndefined();
    expect(early.stop).toBe("bsc-admin#3711 is MERGED, not OPEN. Nothing was merged");
    expect(reasonLine(["", "[INFO] ok", "+ exit 1"])).toBe("[INFO] ok");
  });

  test("Bitbucket's test-report lines at the end of a step are not the reason", () => {
    const noise = ["Searching for test report files in directories named [surefire-reports] down to a depth of 4", "Finished scanning for test reports. Found 2 test report files.",
      "Located test suite containing 2 tests, with 0 failures and 0 errors.", "Located test suite containing 9 tests, with 0 failures and 0 errors."];
    expect(reasonLine(["[ERROR] Failed to execute goal maven-deploy-plugin: 401 Unauthorized", ...noise])).toBe("[ERROR] Failed to execute goal maven-deploy-plugin: 401 Unauthorized");
    expect(reasonLine(noise)).toBe("the log end names no error; open the step log");
    expect(reasonLine(["Located test suite containing 3 tests, with 1 failures and 0 errors."])).toBe("Located test suite containing 3 tests, with 1 failures and 0 errors.");
  });
});
