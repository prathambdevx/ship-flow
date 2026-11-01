# Writing a backend for ship-flow

The plugin is generic. Everything project-specific (how a repo gets a worktree, how code reaches staging, how it deploys, how it is tested, how a master PR is opened) lives in a **backend**: a local HTTP service the `ship` CLI calls. One reference backend exists (a private PR-workflow engine); this file is the contract any other backend implements.

## Pick a backend per project

`~/.claude/ship/config.json`:

```json
{
  "backends": { "myproject": { "url": "http://127.0.0.1:4323", "api": "/api/prflow", "tokenPage": "/tasks/", "tokenHeader": "x-td-token" } },
  "projects": { "/Users/me/code/myproject": "myproject" }
}
```

`ship` uses `--backend <name>`, else `SHIP_BACKEND`, else the plan's own backend (remembered at register), else the longest matching folder in `projects`. `tokenPage` is optional: a page whose `<meta name="td-token">` holds a write token, sent in `tokenHeader` on every POST.

## The contract (all JSON; errors as `{"ok":false,"error":"..."}` with a 4xx)

| Call | Body | Answer |
|---|---|---|
| `POST {api}/terminal/adopt` | `{plan, session, cwd, text?, stagingOnly?}` (plan: `skills/ship/plan-format.md`) | `{ok, id}`; the plan starts at once |
| `GET {api}/terminal/todo/:id` | | `{plan, title, now, steps, items[], tasks[]}`; each item has a `key` that changes when it is new and a `kind`: `task`, `task_failed`, `error`, `uat`, `master_ready`, `finished` |
| `POST {api}/terminal/:id/done` | `{task, did}` | merges the task; its status in `todo` becomes `done` or `failed` |
| `POST {api}/terminal/:id/round` | `{task, blocking[], minor[], reviewer?, by?}` | records a review round |
| `POST {api}/terminal/:id/replan` | `{why, tasks:[{label, action, ...}]}` | applies only those tasks |
| `POST {api}/terminal/:id/note` | `{text}` | a line on the page |
| `GET {api}/terminal/uat-guide` | | `{prompt, schema}`: the rules for a staging test plan |
| `POST {api}/terminal/query` | `{database, sql}` | one read-only query on staging |
| `POST {api}/terminal/:id/uat-run` | `{plan}` | `{results[]}` |
| `POST {api}/terminal/:id/uat-recheck` | `{checks, waitMs}` | `{results[]}` |
| `POST {api}/terminal/:id/uat-answer` | `{exercised, passed, proof, checks[]}` | the backend goes on (or sends tasks back) |
| `POST {api}/plans/:id/retry`, `/stop` | `{}` | |
| `POST {api}/terminal/hook` | a Claude Code hook event (no token) | shows the master and each subagent live |

A `task` item carries `dir` (the task worktree), `branch`, `planBranch`, `notes` (findings sent back) and the brief. A backend may skip steps it has no use for (no staging: `uat` never appears).
