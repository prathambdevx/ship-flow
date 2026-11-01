# ship-flow

Run a planned change from the Claude Code session that planned it. That session becomes the **master**: it starts subagents for each task (a Sonnet executor, a Sonnet reviewer it keeps for every round, a fresh Opus sign-off, an Opus security reviewer when needed), a debugger for a failed build and a tester for staging, and fixes anything that gets stuck. A project **backend** does the fixed steps: worktrees, merges, builds, staging, deploys, the staging test's calls and master PRs. The backend's page shows the master and every subagent live.

## Use

1. Plan the change with Claude in a terminal, as usual.
2. Type `/ship`. Claude writes the task list, shows it, and asks "Start P-?".
3. Say yes. Watch the subagents at the bottom of the terminal, and the backend's page.
4. When it says the master PRs are ready, merge from the page.

Keep the Mac awake with the lid closed for long plans. To take over a plan from another session: `ship attach P-07`.

## Parts

| Path | What |
|---|---|
| `skills/ship/SKILL.md` | The master's loop: register, start tasks, review rounds, sign-off, re-plan patches, last review, staging test |
| `skills/ship/plan-format.md` | The plan JSON `ship register` takes |
| `agents/*.md` | executor, reviewer, signoff, security, debugger, tester |
| `bin/ship` | The CLI the master and subagents call; talks only to the backend |
| `hooks/` | Sends each tool call and subagent start or stop to the backend, only for a session that owns a plan |
| `BACKEND.md` | The HTTP contract a project's backend implements, and the per-project config |

## Install

```bash
ln -sf ~/Desktop/Repos/ship-flow/bin/ship ~/.local/bin/ship
claude plugin marketplace add ~/Desktop/Repos/ship-flow
claude plugin install ship-flow@ship-flow
```

Then add your project's backend to `~/.claude/ship/config.json` (see `BACKEND.md`). After editing the plugin here, run `claude plugin marketplace update ship-flow && claude plugin update ship-flow@ship-flow`.

## Where the data is

- The plan, its tasks, rounds and findings: in the backend (wherever the backend stores its state).
- On this Mac, `~/.claude/ship/`: `config.json` (backends), `sessions/<id>` (which session owns which plan, read by the hook), `plans/<P-xx>.json` (each plan's backend), `seen/` (what `ship wait` already printed).
