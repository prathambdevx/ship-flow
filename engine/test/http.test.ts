import { describe, expect, test } from "bun:test";
import { createEngine } from "../core/engine.ts";
import { createHandler } from "../http.ts";
import { makeFakes, planned, tk, until } from "./fakes.ts";

function setup() {
  const { ports, f } = makeFakes();
  const engine = createEngine(ports);
  f.engine = engine;
  f.plan = planned([tk("T1")]);
  const handle = createHandler(engine, { checkWrite: (req) => (req.headers.get("x-td-token") === "ok" ? null : "Missing page token") });
  const call = async (method: string, path: string, body?: unknown, token = "ok") => {
    const url = new URL(`http://x${path}`);
    const raw = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
    const res = await handle(new Request(url, { method, body: raw, headers: { "x-td-token": token } }), url);
    return res!;
  };
  return { f, engine, call, handle };
}

describe("http", () => {
  test("a path outside the base is not ours", async () => {
    const { handle } = setup();
    const url = new URL("http://x/api/other/state");
    expect(await handle(new Request(url), url)).toBeNull();
    const url2 = new URL("http://x/api/prflowx/state");
    expect(await handle(new Request(url2), url2)).toBeNull();
  });

  test("state shape, events, log and every POST", async () => {
    const { f, engine, call } = setup();
    let res = await call("POST", "/api/prflow/plans", { text: "Fix the total" });
    expect(res.status).toBe(200);
    const { id } = await res.json();
    expect(id).toBe("P-01");
    await until(() => engine.state().plans[id]!.steps.plan === "you", "planned");

    res = await call("GET", "/api/prflow/state");
    const s = await res.json();
    expect(res.headers.get("content-type")).toContain("json");
    expect(Object.keys(s).sort()).toEqual(["blocking", "config", "minors", "plans", "progress", "tasks"]);
    expect(s.plans.map((p: any) => p.id)).toEqual(["P-01"]);
    expect(s.tasks["P-01/T1"].status).toBe("draft");
    expect(typeof s.progress.all).toBe("number");
    expect(typeof s.progress.plans["P-01"]).toBe("number");
    expect(s.config).toEqual({ maxTasks: 6, buildEachTask: true });

    res = await call("GET", `/api/prflow/plans/${id}/events`);
    const ev = await res.json();
    expect(ev.map((e: any) => e.event)).toContain("planner_result");
    res = await call("GET", `/api/prflow/plans/${id}/log`);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(await res.text()).toContain("# P-01 · My plan");
    expect((await call("GET", "/api/prflow/plans/P-77/log")).status).toBe(404);
    expect((await call("GET", "/api/prflow/nope")).status).toBe(404);

    f.plan = planned([tk("T1"), tk("T2")]);
    res = await call("POST", `/api/prflow/plans/${id}/edit`, { text: "Fix the total and the tax" });
    expect(await res.json()).toEqual({ ok: true });
    await until(() => engine.state().plans[id]!.versions.length === 2 && engine.state().plans[id]!.steps.plan === "you", "re-planned");

    res = await call("POST", `/api/prflow/plans/${id}/start`, {});
    expect(await res.json()).toEqual({ ok: true });
    res = await call("POST", `/api/prflow/plans/${id}/stop`, {});
    expect(await res.json()).toEqual({ ok: true });
    expect(engine.state().plans[id]!.stopRequested).toBe(true);
    res = await call("POST", `/api/prflow/plans/${id}/retry`, {});
    expect(await res.json()).toEqual({ ok: true });
    await until(() => engine.state().plans[id]!.steps.master === "you", "master");

    res = await call("POST", "/api/prflow/plans", { text: "second" });
    const b = (await res.json()).id;
    res = await call("POST", `/api/prflow/plans/${b}/order`, { before: id });
    expect(await res.json()).toEqual({ ok: true });
    expect(engine.state().plans[b]!.order).toBe(1);
    res = await call("POST", `/api/prflow/plans/${b}/order`, { before: null });
    expect(engine.state().plans[b]!.order).toBe(2);

    res = await call("POST", `/api/prflow/plans/${id}/merge-master`, {});
    expect(await res.json()).toEqual({ ok: true });
    await until(() => engine.state().plans[id]!.steps.master === "done", "live");
  });

  test("fix-anyway works on a left-out bug and is a 400 otherwise", async () => {
    const { f, engine, call } = setup();
    f.plan = planned([tk("T1", { bugs: [1] })], { kind: "list", triage: [{ n: 1, text: "A", task: "T1" }, { n: 2, text: "B is fine", verdict: "not_a_bug", why: "By design" }] });
    const { id } = await (await call("POST", "/api/prflow/plans", { text: "bugs" })).json();
    await until(() => engine.state().plans[id]!.steps.plan === "you", "planned");
    let res = await call("POST", `/api/prflow/plans/${id}/fix-anyway`, { n: 1 });
    expect(res.status).toBe(400);
    expect((await res.json()).ok).toBe(false);
    res = await call("POST", `/api/prflow/plans/${id}/fix-anyway`, {});
    expect(res.status).toBe(400);
    f.plan = planned([tk("T1", { bugs: [1] }), tk("T2", { bugs: [2] })], { kind: "list", triage: [{ n: 1, text: "A", task: "T1" }, { n: 2, text: "B is fine", task: "T2" }] });
    res = await call("POST", `/api/prflow/plans/${id}/fix-anyway`, { n: 2 });
    expect(await res.json()).toEqual({ ok: true });
    await until(() => engine.state().plans[id]!.versions.length === 2, "edited");
  });

  test("checkWrite refuses with 403 and its text", async () => {
    const { call, engine } = setup();
    const res = await call("POST", "/api/prflow/plans", { text: "x" }, "bad");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "Missing page token" });
    expect(Object.keys(engine.state().plans).length).toBe(0);
    expect((await call("POST", "/api/prflow/plans/P-01/start", {}, "bad")).status).toBe(403);
    expect((await call("GET", "/api/prflow/state", undefined, "bad")).status).toBe(200);
  });

  test("a body over 200 KB is a 413", async () => {
    const { call, engine } = setup();
    const res = await call("POST", "/api/prflow/plans", { text: "a".repeat(200 * 1024 + 10) });
    expect(res.status).toBe(413);
    expect((await res.json()).ok).toBe(false);
    expect(Object.keys(engine.state().plans).length).toBe(0);
  });

  test("bad input and engine errors are 400 with the reason", async () => {
    const { call } = setup();
    let res = await call("POST", "/api/prflow/plans", "{not json");
    expect(res.status).toBe(400);
    res = await call("POST", "/api/prflow/plans", {});
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("text");
    res = await call("POST", "/api/prflow/plans", { text: "   " });
    expect(res.status).toBe(400);
    res = await call("POST", "/api/prflow/plans/P-42/start", {});
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("P-42");
    res = await call("POST", "/api/prflow/plans/P-42/edit", { text: "x" });
    expect(res.status).toBe(400);
    res = await call("POST", "/api/prflow/plans/P-42/merge-master", {});
    expect(res.status).toBe(400);
    res = await call("POST", "/api/prflow/plans/P-42/order", { before: 5 });
    expect(res.status).toBe(400);
    res = await call("POST", "/api/prflow/plans/P-42/unknown", {});
    expect(res.status).toBe(404);
    res = await call("POST", "/api/prflow/plans", "[1]");
    expect(res.status).toBe(400);
  });
});

describe("http port route", () => {
  test("POST /plans/port needs the token, validates, and makes a port plan", async () => {
    const { f, engine, call } = setup();
    f.remote.set("api/uat", ["base-api-uat", "aaaa111"]);
    const body = { title: "Port it", text: "Already tested", repos: [{ repo: "api", order: 1, commits: ["aaaa111"] }] };
    expect((await call("POST", "/api/prflow/plans/port", body, "bad")).status).toBe(403);
    const bad = await call("POST", "/api/prflow/plans/port", { ...body, repos: [{ repo: "api", order: 1, commits: ["bbbb222"] }] });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toContain("not on origin/uat");
    const ok = await call("POST", "/api/prflow/plans/port", body);
    const { id } = await ok.json();
    expect(engine.state().plans[id]!.kind).toBe("port");
    await until(() => engine.state().plans[id]!.steps.master === "you", "master");
  });
});
