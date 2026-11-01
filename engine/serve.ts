// The built-in backend: one Bun server on 127.0.0.1:<port> with the engine's API, the terminal routes and the dashboard (../ui).
import { existsSync, mkdirSync } from "node:fs";
import { join, normalize } from "node:path";
import { createEngine } from "./core/engine.ts";
import { createHandler } from "./http.ts";
import { gitPorts } from "./git-ports.ts";
import { expandProject, type ProjectConfig } from "./project.ts";
import { terminalRoute } from "./terminal.ts";

export async function serve(name: string, project: ProjectConfig): Promise<void> {
  const p = expandProject(project);
  mkdirSync(p.dataDir, { recursive: true });
  const engine = createEngine(gitPorts(p), { terminalOnly: true, buildEachTask: false, stagingRunner: false, settleMs: 0, watchMasterPrs: true, cleanFinished: true });
  const api = createHandler(engine, { checkWrite: () => null }); // only 127.0.0.1 can reach this server: no page token
  const noProd = (repo: string) => p.repos.find((r) => r.name === repo)?.prodBranch === null;
  const UI = normalize(join(import.meta.dir, "..", "ui"));
  engine.recover();
  Bun.serve({
    hostname: "127.0.0.1", port: p.port,
    async fetch(req) {
      const url = new URL(req.url);
      const t = await terminalRoute(engine, req, url, { noProd });
      if (t) return t;
      const a = await api(req, url);
      if (a) return a;
      if (url.pathname === "/theme.css") return new Response("", { headers: { "content-type": "text/css" } });
      const f = normalize(join(UI, url.pathname === "/" ? "index.html" : url.pathname));
      if (!f.startsWith(UI + "/") || !existsSync(f)) return new Response("not found", { status: 404 });
      return new Response(Bun.file(f), { headers: { "cache-control": "no-store" } });
    },
  });
  console.log(`[ship-flow] backend "${name}" for ${p.name}: http://127.0.0.1:${p.port}/ (data: ${p.dataDir})`);
  await new Promise(() => {});
}
