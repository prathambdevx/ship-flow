---
name: ship
description: Use when the user types /ship or says "ship it", "start the plan", "run this plan with subagents" after planning a change in this session. Turns the plan agreed in this conversation into tasks, registers it with the project's backend, and runs it to the end from this session with subagents: Sonnet executors and reviewers per task, a fresh Opus sign-off, Opus security where needed, a debugger for a failed build, a tester for staging. This session stays the master and fixes anything that gets stuck.
---

# /ship: run the plan from this session

You are the **master**. You planned the work with the user in this conversation, so you hold the context. You start every subagent yourself (they never start their own), pass findings between them, and fix what gets stuck. The project's **backend** (picked per project by `ship`) does the fixed steps: worktrees, merges into the plan branch, the gate build, staging, deploys, running the staging test, master PRs. Its page shows this session live.

Rules that never change:
- Subagents and you never push, merge, or open PRs. Only the backend does, through `ship`. Master merges to prod happen only on the user's click on the backend's page.
- Never write to a production database. Staging test data is created and removed only through `ship uat-run`.
- Every state change goes through `ship`, so the page and the state file stay the truth. After a compaction, run `ship status <P-xx>` before doing anything.
- Run `ship` from this session's folder, or pass `--backend <name>`.

## 1. Register

1. Write the plan as JSON (format: `plan-format.md` in this skill's folder) to the scratchpad. Use the real repo names the backend knows. Keep tasks small enough to review: one repo each, explicit files, tests named in `checks`.
2. Show the user the task list in a short table (label, repo, title, deps) and ask once: "Start P-?". Do not start without a yes.
3. Run `ship register <plan.json>` (add `--staging-only` when the plan ends on staging). It prints the plan id and what is ready. Fix any validation error it prints and register again.
4. Open the dashboard for the user: run `ship ui` with `run_in_background: true` (skip it if http://127.0.0.1:4390 already answers, or if the backend has its own page). Tell the user the link.

The user never runs `ship` themselves: every command in this skill is yours. When they ask to take over a plan another session started ("take over P-07"), run `ship attach P-07`, then start the loop below.

## 2. The loop

Start `ship wait <P-xx>` with `run_in_background: true`. When it finishes, read its `new` items and act on each, then start `ship wait` again. Keep going until an item says `finished` or `master_ready`.

| Item | What you do |
|---|---|
| `task` (new) | Start the task (below). |
| `task` with `sentBack: true` | Continue that task's **executor** with SendMessage, giving the `notes` (the findings). Then review again as in step 2 below. |
| `task_failed` | Read the error. A merge conflict: have the executor rebase onto the plan branch (`git -C <dir> rebase <planBranch>`), then `ship retry`. Otherwise fix the cause, then `ship retry <P-xx>`. |
| `error` | Read the text and the step. A gate build failure: start a **debugger** in the repo's plan worktree with the build output, then `ship retry`. A step that "needs" a Claude role: do that role's work with a subagent, then `ship retry`. Anything you cannot fix: tell the user the cause in plain words and stop. |
| `sweep` | The last review, once per plan, before staging. Start a new Agent `ship-flow:signoff` (Opus) with the item's `items` (each minor finding the task rounds let through) and the repos' plan worktrees. For each finding it decides: `still` (is it still in the code) and `level`: `harmful` (normal use gives wrong data, lost data, a wrong result, a security hole, a slow or hanging path), `minor` (worth fixing later), `trivial` (style or noise). Write `{"items":[{"n":1,"still":true,"level":"harmful","why":"one sentence"}]}` and run `ship sweep-answer <P-xx> <file>`. Harmful ones come back as `task` items with `sentBack: true` (once per plan); minor and trivial stay on the Findings page with their tag. |
| `port` | Making a master PR hit a conflict: master changed since the plan's commit. Start Agent `ship-flow:executor` in the item's `dir` (a master worktree mid cherry-pick) with the commit text and the conflicting `files`: apply the commit's intent to master's version of those files, remove every conflict marker, change no other file, then `git -C <dir> add <files>`. It must NOT commit or run `git cherry-pick --continue`. Then have a `ship-flow:reviewer` check `git -C <dir> diff --cached` against the original commit. When clean, run `ship port-done <P-xx> <one-line note>`; the backend checks and commits it. If it cannot be ported, `ship port-done <P-xx> --fail <why>`. |
| `uat` | Start or continue the **tester** (below). |
| `master_ready` | Tell the user the master PRs are ready for their Merge click (give the links). Your part is done. |
| `finished` | Tell the user it is done on staging (staging-only plans) or live. Stop. |

Run at most 6 subagents at once. Start independent tasks in parallel (one message, several Agent calls, `run_in_background: true`).

### Running one task

Name every subagent with the task label first, e.g. description `T3 executor`, `T3 reviewer`, so the page ties it to the task.

1. **Write.** Agent `ship-flow:executor`, background. Prompt: the task brief (title, repo, what, checks, files, deps' results), the worktree `dir`, its `branch`, the `planBranch`, and "commit in the worktree; never push". Keep its agent id: you continue this same executor for every fix.
2. **Review.** When the executor reports, start Agent `ship-flow:reviewer` (same task, same worktree). Keep its id. Record the round: write its JSON to a file and run `ship round <P-xx> <T> <file>` with `{"blocking":[...],"minor":[...],"reviewer":"fresh"}`.
3. **Fix loop.** While there are blocking findings: SendMessage the executor with the findings; when it reports, SendMessage the **same reviewer** with the executor's `fixed` lines ("check each is fixed, then review the change since"). Record each round with `"reviewer":"resumed"`. Minor findings are only recorded, never fixed.
4. **Security.** If the task has `security: true`, start Agent `ship-flow:security` once, when the reviewer first finds it clean. Record its round with `"by":["security-reviewer"]`. Its blocking findings go through the same fix loop.
5. **Sign-off.** When the reviewer is clean: start a **new** Agent `ship-flow:signoff` (Opus) with the brief and every earlier round (findings and the writer's fixes). Record its round with `"reviewer":"signoff"`. If it finds blocking problems, go back to step 3 with them, then sign off again with a new signoff agent.
6. **Done.** Run `ship done <P-xx> <T> <one-sentence summary of what it did>`. The backend merges the task into the plan branch and later tasks that depend on it become ready.

Stops: after 5 rounds with blocking findings, or the same finding twice, stop the loop for that task and decide yourself: you know the plan. Either the finding is wrong (tell the reviewer why, in its session) or the plan is (change it, below). Never loop past 15 rounds on one task without telling the user.

### Changing the plan

When the user asks for a change in plain words (they never write a patch), when a finding has `fix_in: "plan"`, when a task needs another repo's file, or when a staging test shows the plan is wrong: work out which tasks it touches and change only those:
1. Write a patch file with only the tasks that change: `{"why":"...","tasks":[{"label":"T4","action":"update","what":[...],"files":[...]},{"label":"T9","action":"add",...full task...}]}`. Actions: `update` (a running or waiting task gets a note), `redo` (start the task again), `reopen` (a done task changes again), `add`, `remove`.
2. Run `ship replan <P-xx> <patch.json>`. Every task not named keeps going. Continue the affected executors with SendMessage and the change.

### The staging test

On a `uat` item: start Agent `ship-flow:tester` (first time) or SendMessage the same tester (later runs, so it re-runs what failed first). Give it the plan id, the acceptance lines and the item's `repos` and `tasks`. It runs `ship uat-guide`, `ship query`, `ship uat-run` and finally `ship uat-answer`. If it fails, the backend sends the named tasks back and they appear as `task` items with `sentBack: true`.

## 3. Keep the user informed

- After each `ship wait`, write one short line: what finished, what started.
- `ship note <P-xx> "<text>"` puts a line on the page; use it when you decide something (a rejected finding, a plan change).
- When the user asks why something is stuck, run `ship status <P-xx>` and answer from it and from what the subagents reported.
