// Reads a release pipeline step log (release.py's lines, each stamped "[dd/mm hh:mm:ss AM IST]") into what each PR is doing.
export interface RunPr {
  repo: string; id: number; state: "merging" | "deploying" | "tag" | "done" | "failed";
  merged: boolean; pipeline?: string; tag?: string; noPipeline?: boolean; merge?: string; result?: string;
}
export interface RunLog {
  order: string[]; prs: Record<string, RunPr>; cur?: string; dry?: boolean;
  handoff?: { run: number; url: string; prs: string[] };
  stop?: string; failed?: { repo: string; step?: string; reason: string };
  waitTag?: { repo: string; tag: string };
}

const STAMP = /^\[\d{2}\/\d{2} \d{1,2}:\d{2}:\d{2} [AP]M IST\] ?/;
const CAUSE = /error|exception|fail|denied|refused|not found|timed? ?out|cannot|could not|unable/i;
// the git host's test-report scan at the end of every step; "0 failures and 0 errors" is never the cause.
const REPORT_NOISE = /^(Searching for test report files|Finished scanning for test reports|Searching for files matching)|with 0 failures and 0 errors\.?$/i;

// The line of a failed step's log tail that says why: the last one that names an error, else the last line.
export function reasonLine(tail: string[]): string {
  const ls = tail.map((l) => l.trim()).filter((l) => l && !/^[+\-=]{3,}|^\+ /.test(l) && !REPORT_NOISE.test(l));
  return (ls.filter((l) => CAUSE.test(l)).at(-1) ?? ls.at(-1) ?? "the log end names no error; open the step log").slice(0, 300);
}

export function parseRunLog(text: string): RunLog {
  const out: RunLog = { order: [], prs: {} };
  const lines = text.replace(/\r/g, "").replace(/\x1b\[[0-9;]*m/g, "").split("\n");
  let tail: string[] | null = null, table = false;
  const done = (repo?: string) => { const x = repo ? out.prs[repo] : undefined; if (x && x.state !== "failed") x.state = "done"; };
  const merged = (repo: string, patch: Partial<RunPr>) => { const x = out.prs[repo]; if (x) Object.assign(x, { merged: true }, patch); };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!, stamped = STAMP.test(raw), l = raw.replace(STAMP, "").trimEnd();
    if (tail && !stamped && !l.startsWith("STOP:")) { tail.push(l); continue; }
    if (tail) { out.failed!.reason = reasonLine(tail); tail = null; }
    let m: RegExpExecArray | null;
    if (/^repo\s+PR\s+merge\s+pipeline\s+min$/.test(l.trim())) { table = true; continue; }
    if (table && (m = /^([\w.-]+)\s+(\d+)\s+(\S+)\s+(.+?)\s+\d+\.\d$/.exec(l.trim())) && out.prs[m[1]!]) {
      const x = out.prs[m[1]!]!; x.merge = m[3]; x.result = m[4]; x.merged = true;
      if ((m[4] === "SUCCESSFUL" || m[4] === "NO PIPELINE") && x.state !== "tag") done(x.repo);
      continue;
    }
    if ((m = /^Target: \S+\. Order: (.+)$/.exec(l))) out.order = m[1]!.split("->").map((s) => s.trim()).filter(Boolean);
    else if (/^DRY_RUN is true/.test(l)) out.dry = true;
    else if ((m = /^Merging ([\w.-]+)#(\d+) into \S+$/.exec(l))) { done(out.cur); out.cur = m[1]!; out.prs[m[1]!] = { repo: m[1]!, id: Number(m[2]), state: "merging", merged: false }; out.waitTag = undefined; }
    else if ((m = /^\s+pipeline (https?:\/\/\S+)$/.exec(l)) && out.cur) merged(out.cur, { state: "deploying", pipeline: m[1] });
    else if ((m = /^WARNING: no pipeline for ([\w.-]+) on /.exec(l))) merged(m[1]!, { state: "deploying", noPipeline: true });
    else if ((m = /^([\w.-]+): pipeline ended (\w+): (.*)$/.exec(l)) && out.prs[m[1]!]) {
      merged(m[1]!, { state: "failed", result: m[2] });
      const step = /^step '([^']*)' failed/.exec(m[3]!)?.[1];
      out.failed = { repo: m[1]!, step: step ?? `pipeline ${m[2]!.toLowerCase()}`, reason: step ? "" : m[3]!.slice(0, 300) };
      if (step) tail = [];
    }
    else if ((m = /^\s+waiting for tag (\S+)$/.exec(l)) && out.cur) { merged(out.cur, { state: "tag", tag: m[1] }); out.waitTag = { repo: out.cur, tag: m[1]! }; }
    else if ((m = /^\s+tag (\S+) found$/.exec(l)) && out.cur) { out.waitTag = undefined; done(out.cur); }
    else if ((m = /^Time limit near\. Started a new run for the rest: (.+)$/.exec(l))) {
      const url = (lines[i + 1] ?? "").trim(), n = /\/results\/(\d+)/.exec(url)?.[1];
      done(out.cur);
      if (n) out.handoff = { run: Number(n), url, prs: m[1]!.split(",").map((s) => s.trim()).filter(Boolean) };
    }
    else if ((m = /^STOP: (.*)$/.exec(l))) {
      out.stop = m[1]!.slice(0, 400);
      const x = out.cur ? out.prs[out.cur] : undefined;
      if (x && !out.failed) {
        const step = x.state === "merging" ? "merge" : x.state === "tag" ? "release tag" : "pipeline";
        x.state = "failed";
        out.failed = { repo: x.repo, step, reason: out.stop };
      }
    }
  }
  if (tail && out.failed) out.failed.reason = reasonLine(tail);
  return out;
}
