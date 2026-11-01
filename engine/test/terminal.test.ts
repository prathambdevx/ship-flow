import { describe, expect, test } from "bun:test";
import { createEngine } from "../core/engine.ts";
import { makeFakes, planned, tk, until } from "./fakes.ts";

function setup() {
  const { ports, f } = makeFakes();
  const engine = createEngine(ports, { buildEachTask: false });
  f.engine = engine;
  const plan = (id = "P-01") => engine.state().plans[id]!;
  const task = (l: string, id = "P-01") => engine.state().tasks[`${id}/${l}`]!;
  // What a terminal executor does: edit a file in the task worktree.
  const write = (l: string, id = "P-01") => { const t = task(l, id); f.dirs.get(t.dir!)!.pending.add(`src/${l}.ts`); };
  return { f, engine, plan, task, write };
}
const ready = (t: { status: string; terminal?: { readyAt?: number; done?: unknown } }) => t.status === "working" && !!t.terminal?.readyAt && !t.terminal.done;

describe("terminal plan (/ship)", () => {
  test("register, hand-offs, last review, staging, the terminal's test, master PRs: no Claude run in the engine", async () => {
    const { f, engine, plan, task, write } = setup();
    const id = await engine.adopt(planned([tk("T1"), tk("T2", { wave: 2, deps: ["T1"] })]), { session: "sess-1", cwd: "/x" });
    expect(id).toBe("P-01");
    expect(plan().started).toBe(true);

    await until(() => ready(task("T1")), "T1 ready");
    expect(task("T2").status).toBe("waiting"); // waits for its dep
    engine.addRound(id, "T1", { blocking: [], minor: [{ severity: "minor", category: "style", text: "Rename x", by: "code-reviewer" }], reviewer: "signoff" } as any);
    write("T1"); engine.taskDone(id, "T1", "Did T1.");
    await until(() => task("T1").status === "done", "T1 merged");
    expect(task("T1").did).toBe("Did T1.");

    await until(() => ready(task("T2")), "T2 ready");
    write("T2"); engine.taskDone(id, "T2", "Did T2.");

    await until(() => !!plan().terminal?.sweep, "last review asked");
    expect(plan().terminal!.sweep!.items[0]!.text).toBe("Rename x");
    engine.sweepAnswer(id, [{ n: 1, still: true, level: "trivial", why: "naming only" }]);

    await until(() => !!plan().terminal?.uat, "staging test asked");
    engine.uatAnswer(id, { exercised: true, passed: true, proof: "it works", checks: [{ what: "works", ok: true, task: "T1" }] });
    await until(() => plan().steps.master === "you" || !!plan().error, "master PRs");

    expect(plan().error).toBeUndefined();
    expect(plan().minorSweep!.runs).toBe(1);
    expect(f.runs.filter((r) => r.role !== "executor" || !String(r.prompt).includes("house style")).length).toBe(0); // no Claude run at all
    expect(plan().masterPrs.length).toBe(1);
  });

  test("a failed staging test sends the named task back to the terminal, which fixes it", async () => {
    const { engine, plan, task, write } = setup();
    const id = await engine.adopt(planned([tk("T1")]), { session: "sess-2" });
    await until(() => ready(task("T1")), "T1 ready");
    write("T1"); engine.taskDone(id, "T1", "Did T1.");
    await until(() => !!plan().terminal?.uat, "staging test asked");
    engine.uatAnswer(id, { exercised: true, passed: false, proof: "wrong total", checks: [{ what: "total", ok: false, detail: "0 not 5", task: "T1" }] });
    await until(() => ready(task("T1")), "T1 sent back to the terminal");
    expect(task("T1").notes.join(" ")).toContain("total");
    write("T1"); engine.taskDone(id, "T1", "Fixed the total.");
    await until(() => !!plan().terminal?.uat, "staging test asked again");
    engine.uatAnswer(id, { exercised: true, passed: true, proof: "ok", checks: [{ what: "total", ok: true, task: "T1" }] });
    await until(() => plan().steps.master === "you", "master PRs");
  });

  test("a patch re-plan changes only the named tasks", async () => {
    const { engine, task } = setup();
    const id = await engine.adopt(planned([tk("T1"), tk("T2")]), { session: "sess-3" });
    await until(() => ready(task("T1")) && ready(task("T2")), "both ready");
    await engine.replanPatch(id, { why: "T2 needs one more check", tasks: [{ label: "T2", action: "update", note: "Also check empty lists" }] });
    expect(task("T2").notes.join(" ")).toContain("empty lists");
    expect(task("T1").notes.length).toBe(0);
    expect(task("T1").status).toBe("working");
  });
});
