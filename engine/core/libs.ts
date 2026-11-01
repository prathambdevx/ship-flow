// In-house library SNAPSHOT dependencies in a pom.xml: find them, and pin one to its released version (that version line only).
export interface LibPin { lib: string; version: string } // version without -SNAPSHOT

const mask = (xml: string) => xml.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " ")); // same offsets, comments blanked
const VERSION = /<version>\s*([^<\s]+)\s*<\/version>/;

export function findSnapshots(xml: string, libs: string[]): LibPin[] {
  return findLibVersions(xml, libs).filter((x) => x.snapshot).map(({ lib, version }) => ({ lib, version }));
}
// Every in-house library dependency: its version without -SNAPSHOT, and whether it was a SNAPSHOT.
export function findLibVersions(xml: string, libs: string[]): (LibPin & { snapshot: boolean })[] {
  const out: (LibPin & { snapshot: boolean })[] = [];
  for (const m of mask(xml).matchAll(/<dependency>[\s\S]*?<\/dependency>/g)) {
    const id = /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/.exec(m[0])?.[1], v = VERSION.exec(m[0])?.[1];
    if (!id || !v || !libs.includes(id) || v.includes("${")) continue;
    const snapshot = v.endsWith("-SNAPSHOT"), version = snapshot ? v.slice(0, -9) : v;
    if (!out.some((x) => x.lib === id && x.version === version && x.snapshot === snapshot)) out.push({ lib: id, version, snapshot });
  }
  return out;
}

// Replaces <version>V-SNAPSHOT</version> with <version>V</version> inside the pinned library's dependency blocks only.
export function pinVersions(xml: string, pins: LibPin[]): string {
  const m = mask(xml);
  let out = "", at = 0;
  for (const d of m.matchAll(/<dependency>[\s\S]*?<\/dependency>/g)) {
    const id = /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/.exec(d[0])?.[1], v = VERSION.exec(d[0]);
    const pin = pins.find((x) => x.lib === id && v?.[1] === `${x.version}-SNAPSHOT`);
    if (!pin || !v) continue;
    const start = d.index! + v.index!;
    out += xml.slice(at, start) + v[0].replace(`${pin.version}-SNAPSHOT`, pin.version);
    at = start + v[0].length;
  }
  return out + xml.slice(at);
}

// true when the two texts differ only in lines that hold the pinned versions: same line count, and every changed line is a version line.
export function onlyVersionLines(before: string, after: string, pins: LibPin[]): boolean {
  const a = before.split("\n"), b = after.split("\n");
  if (a.length !== b.length) return false;
  return a.every((l, i) => l === b[i] || pins.some((p) => l.includes(`<version>${p.version}-SNAPSHOT</version>`) && b[i] === l.replace(`${p.version}-SNAPSHOT`, p.version)));
}
