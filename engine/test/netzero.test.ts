import { expect, test } from "bun:test";
import { dropNetZero } from "../core/netzero.ts";

const files: Record<string, string[]> = { feat: ["A.java"], fake: ["D.java", "P.java"], undo: ["D.java", "P.java"], more: ["A.java"] };
const filesOf = async (c: string) => files[c]!;

test("a change and its undo drop out together; the real change stays", async () => {
  const r = await dropNetZero(["feat", "fake", "undo"], filesOf, async (from, to) => from === "fake^" && to === "undo");
  expect(r).toEqual({ keep: ["feat"], dropped: ["fake", "undo"] });
});
test("nothing drops when the run is not empty or shares files with the rest", async () => {
  expect((await dropNetZero(["feat", "fake", "undo"], filesOf, async () => false)).keep).toEqual(["feat", "fake", "undo"]);
  expect((await dropNetZero(["feat", "more"], filesOf, async () => true)).dropped).toEqual(["feat", "more"]);
});
