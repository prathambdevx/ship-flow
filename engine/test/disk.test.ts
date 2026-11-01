import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEngine } from "../core/engine.ts";
import { dropBuildOutput } from "../core/worktrees.ts";
import { makeFakes, planned, tk, until } from "./fakes.ts";

const mk = (root: string, ...parts: string[]) => { const d = join(root, ...parts); mkdirSync(d, { recursive: true }); return d; };

describe("disk clean-up", () => {
  test("dropBuildOutput removes Maven target folders at the root and one module level, nothing else", () => {
    const root = mkdtempSync(join(tmpdir(), "prflow-disk-"));
    writeFileSync(join(root, "pom.xml"), "<project/>"); mk(root, "target", "classes"); mk(root, "src", "main");
    const mod = mk(root, "api"); writeFileSync(join(mod, "pom.xml"), "<project/>"); mk(mod, "target");
    const web = mk(root, "web"); mk(web, "target"); // no pom.xml: not Maven output, kept
    dropBuildOutput(root);
    expect(existsSync(join(root, "target"))).toBe(false);
    expect(existsSync(join(mod, "target"))).toBe(false);
    expect(existsSync(join(web, "target"))).toBe(true);
    expect(existsSync(join(root, "src", "main"))).toBe(true);
    dropBuildOutput(join(root, "missing")); // a missing folder is fine
  });

  test("a target plan that lands drops its task folders", async () => {
    const { ports, f } = makeFakes();
    const engine = createEngine(ports, {});
    f.engine = engine;
    f.plan = planned([tk("T1"), tk("T2")], { target_branch: "feat/x" });
    const id = engine.submit("work on feat/x");
    await until(() => engine.state().plans[id]!.steps.plan === "you", "planned");
    engine.start(id);
    await until(() => !!engine.state().plans[id]!.landedAt, "landed");
    const dirs = ["T1", "T2"].map((l) => engine.state().tasks[`${id}/${l}`]!.dir!);
    for (const d of dirs) expect(f.calls.some((c) => c.startsWith("drop") && c.includes(d))).toBe(true);
    expect(engine.events(id).some((e) => e.event === "worktrees_dropped" && /removed 2 task folders/.test(e.text))).toBe(true);
  });
});
