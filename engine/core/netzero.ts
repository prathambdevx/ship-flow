// Commits that undo each other (a debugger's change and its revert) are left out of the master PR as a whole run.
// A run is dropped only when its combined diff is empty and no other commit in the list touches its files.
export async function dropNetZero(cs: string[], filesOf: (c: string) => Promise<string[]>, emptyBetween: (from: string, to: string, files: string[]) => Promise<boolean>): Promise<{ keep: string[]; dropped: string[] }> {
  const files = await Promise.all(cs.map(filesOf));
  let keep = cs.map((c, i) => ({ c, f: files[i]! })); const dropped: string[] = [];
  for (let i = 0; i < keep.length; i++) {
    for (let j = keep.length - 1; j > i; j--) {
      const span = [...new Set(keep.slice(i, j + 1).flatMap((x) => x.f))], others = keep.filter((_, k) => k < i || k > j).flatMap((x) => x.f);
      if (!span.length || span.some((f) => others.includes(f))) continue;
      if (await emptyBetween(`${keep[i]!.c}^`, keep[j]!.c, span)) { dropped.push(...keep.slice(i, j + 1).map((x) => x.c)); keep = [...keep.slice(0, i), ...keep.slice(j + 1)]; i--; break; }
    }
  }
  return { keep: keep.map((x) => x.c), dropped };
}
