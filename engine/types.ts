// prflow's shared data model. Frozen: every part codes against it; change it only together with DESIGN.md.

// port: staging commits already merged and tested, taken to master without tasks. promote: a target branch taken to staging, no tasks.
export type Kind = "small" | "big" | "list" | "port" | "promote";
// draft: planned, waits for Start. waiting: started, waits for deps, a wave gate or a file another plan holds.
export type TaskStatus = "draft" | "waiting" | "working" | "review" | "done" | "failed" | "removed";
export type StepState = "" | "run" | "done" | "fail" | "you";
export type StepKey = "plan" | "tasks" | "staging" | "uat" | "master";
export type Severity = "blocking" | "minor";
export type Category = "security" | "correctness" | "data" | "crash" | "build" | "bad_code" | "style" | "naming" | "docs" | "tests" | "cleanup" | "other" | "performance" | "concurrency";
// Only these loop back to the writer; everything else is listed on the PR and never starts a round.
export const BLOCKING_CATEGORIES: readonly Category[] = ["security", "correctness", "data", "crash", "build", "bad_code", "performance", "concurrency"];
export type Role = "planner" | "architect-reviewer" | "executor" | "debugger" | "code-reviewer" | "security-reviewer" | "tester";

export interface Finding { severity: Severity; category: Category; text: string; short?: string; file?: string; line?: number; by: Role; fix_in?: "task" | "plan"; repeat_of_rounds?: number[]; other_repo?: string; other_symbols?: string[] } // other_*: names the finding says another repo of the plan lacks // short: the problem in one plain sentence, for the UI
export interface Round {
  n: number; at: number; source: "review" | "uat" | "gate" | "architect" | "edit" | "recovery" | "sweep";
  by: Role[]; blocking: Finding[]; minor: Finding[]; fix?: string; fixedAt?: number; fixed?: string[]; // fixed: one plain line per blocking finding, in order
  head?: string; // the commit this round reviewed: the next round also gets the diff since it
  sid?: string; reviewer?: "fresh" | "resumed" | "signoff"; // the code-reviewer session that answered, and how it was started
}

export interface Task {
  id: string; // `${planId}/${label}`
  planId: string; label: string; title: string; repo: string; wave: number;
  deps: string[]; // task ids in the same plan
  files: string[]; // repo-relative paths only this task may change, tests included
  size: "S" | "M" | "L"; part: string; what: string[]; checks: string[]; bugs?: number[];
  review?: boolean; reviewWhy?: string; // the planner's call: false skips the code review (build, tests and UAT still run)
  security: boolean; securityWhy?: string; // the planner's call: true only for a real attack surface, then security-reviewer reviews it too
  status: TaskStatus; sub: string; // sub: one plain-English line on what it is doing now
  isNew?: boolean; changed?: boolean; // set by the last re-plan, shown on the card
  notes: string[]; // updates from an edit, given to the executor at its next step
  waitsOn: string[]; // tasks of earlier plans that change one of the same files
  rounds: Round[]; did?: string;
  dir?: string; branch?: string; commits: string[]; stat?: string; sessionId?: string;
  reviewSessionId?: string; // the task's code-reviewer session: later rounds resume it; a fresh reviewer gives the final sign-off
  reviewing?: number; // the review round going now; after a restart the task goes straight back to it
  heldForPlan?: boolean; // a plan change for this task is pending: no writer or review round until the re-plan reaches it
  startedAt?: number; doneAt?: number; error?: string; stopRequested?: boolean;
  retryAt?: number; // a transient failure: it waits and runs again on its own at this time
  needsYou?: boolean; roundBase?: number; // stopped at maxTotalRounds: only a person's Retry carries on, and counts rounds again from roundBase
  activity?: Activity[]; // while a Claude run works on it: its last 10 actions; cleared when the run ends
  mergeFrom?: string; // task head being merged into the plan branch; set only until the merge is recorded as done
  terminal?: { readyAt?: number; done?: { did: string; at: number } }; // terminal plan: ready for its subagents; done: the terminal says merge it
}

export interface LeftOut { verdict: "not_a_bug" | "already_fixed" | "needs_info" | "duplicate"; why: string; fixAnyway?: boolean }
export interface TriageRow { n: number; text: string; task?: string; leftOut?: LeftOut }
export interface PrRef {
  repo: string; id: number; url: string; state: "open" | "merged" | "declined"; merge?: string; order: number; why?: string; head?: string; base?: string; deployed?: boolean; byHand?: string; // base: the master commit this PR was built on
  run?: "merging" | "deploying" | "tag" | "failed"; pipeline?: string; tag?: string; // master PRs in a release run: its step now (from the runner's log), its pipeline, the tag it waits for
}
export interface UatCheck { what: string; ok: boolean | null; detail?: string; task?: string }
export interface PlanVersion { n: number; at: number; text: string; changes: string[]; fixes?: string[]; fixTasks?: string[] } // fixes: plan fixes this version carries; fixTasks: the tasks the planner changed for them
// One repo a plan changes: its own worktree on the plan branch, made from `base` (staging, or the plan's target branch).
// from: a promotion plan cuts the plan branch from this branch (its target) and still merges into `base` (staging).
export interface RepoPart { repo: string; base: string; from?: string; branch: string; dir: string; order: number; why?: string; stagingCommits: string[]; staged?: boolean; manualDeploy?: string }

export interface Activity { at: number; line: string }

// A prod step the plan's Merge runs around its master PRs. Set through the API while master is "you".
// Where: neither or before: before the release pipeline starts; after: once the release run succeeded (a release: checks the tag).
export type ReleaseKind = "preflight" | "sql" | "config" | "release";
// A preflight query (1-based, in script order) that must show this; every other query is only shown.
export interface PreflightCheck { query: number; expect: "no_rows" | "all_true"; column?: string; why: string }
export interface ReleaseStep {
  id: string; kind: ReleaseKind; title: string; before?: string; after?: string;
  database?: string; file?: { repo: string; path: string }; sql?: string; // preflight, sql: a file at that repo's master PR commit, or inline SQL
  allow?: ("do" | "upsert")[]; tables?: string[]; // sql: beyond add-only DDL, a DO block, or an upsert into these tables
  checks?: PreflightCheck[]; // preflight: what "OK" means, judged by code
  config?: { repo: string; branch: string; file: string; under: string; add: string[]; message: string }; // under: the line the new lines go below
  lib?: string; version?: string; // release
  rerun: boolean; rerunWhy?: string; // safe to run again after a partial run
  text?: string; sha?: string; ref?: string; // set by the engine: the SQL you confirmed and the commit it was read at
  state?: "" | "run" | "done" | "fail" | "manual"; at?: number; result?: string; rows?: number; error?: string; startedAt?: number;
}

// One release pipeline run that merges a plan's master PRs. runs: this run and its hand-offs, oldest first.
export interface ReleaseRunRef { run: number; url: string; uuid: string }
export interface ReleaseRun extends ReleaseRunRef {
  state: "starting" | "running" | "done" | "fail"; startedAt: number; endedAt?: number; prs: string[]; // prs: "repo#id" sent to the runner
  runs: ReleaseRunRef[]; result?: string; failed?: { repo?: string; step?: string; reason: string }; waitTag?: { repo: string; tag: string };
}

export interface Plan {
  id: string; // "P-01"
  title: string; text: string; versions: PlanVersion[]; pastedAt: number;
  ticketSetByYou?: boolean;
  architecture?: { changes: boolean; why: string }; // the planner's call: does the plan change the design
  uncovered?: { part: string; why: string }[]; dbChanges?: { database: string; sql: string; why: string }[]; dbDoneAt?: number; // dbDoneAt: a person ran them on staging // what the tasks do not cover
  prodGaps?: { task: string; repo: string; what: string }[]; // UAT-branch code a task relies on that prod master lacks
  overlaps?: { plan: string; repo: string; files: string[] }[]; // files this plan shares with another plan not yet live
  ticket?: string; // the ticket number(s) the work is for, e.g. "BOM-10046"; goes in every PR title
  order: number; // queue position: an earlier plan goes first on a shared file
  kind?: Kind; sizeWhy?: string; contract?: string; acceptance: string[]; changes?: string[];
  tasks: string[]; triage?: TriageRow[]; waves: number; gates: Record<number, boolean>;
  steps: Record<StepKey, StepState>; now: string; tone: "" | "ok" | "bad"; nowAt: number;
  started: boolean; startedAt?: number; needsStart: boolean; // needsStart: drafts from an edit wait for Start
  slug: string; repos: RepoPart[]; stagingPrs: PrRef[]; masterPrs: PrRef[];
  uat?: { checks: UatCheck[]; proof?: string; tries: number; passed?: boolean };
  uatSession?: string; // the plan's one tester session: a later staging test continues it and re-runs what failed
  error?: string; stopRequested?: boolean; liveAt?: number;
  deleting?: boolean; // you deleted it; it leaves the state once nothing of it runs
  askYou?: boolean; // the error is a question for the user (Merge's confirm stops), not a failure: no watchdog or recovery run
  retryAt?: number; // a plan step failed for a transient reason: its next try waits until this time
  liveVia?: string; carriedBy?: Record<string, string>; // another plan whose merge carried this change to prod (by repo)
  finalReview?: { key: string; at: number; blocking: number }; // port plans: the one review of all repos; key: the PR heads it saw
  merging?: number; // when the user pressed Merge; set until the merge ends, so the button stays disabled
  recoveries?: number; // plan errors the recovery run has handled on its own (at most 3; reset by an edit)
  activity?: Activity[]; // while planning or the staging test runs: that run's last 20 actions; cleared when it ends
  uatStep?: number; uatScenarios?: { what: string; task: string }[]; // the staging test now: its step and planned scenarios
  gating?: { wave: number; repo: string; i: number; n: number }; // while a wave gate runs: the repo it builds now (i of n)
  plannerSession?: { id: string; at: number }; // the last planner session: a re-plan within cfg.plannerResumeMs resumes it
  // The architect's last whole-plan review: the next one resumes this session with its findings and only the change since.
  archReview?: { sessionId: string; at: number; heads: Record<string, string>; findings: (Finding & { task?: string })[] };
  planStep?: number; // while planning: index into the step list for its kind (UI list); cleared when planning ends
  watchdog?: Watchdog; // the host's watchdog on this plan (optional; a host without one leaves it unset)
  releaseSteps?: ReleaseStep[]; // prod steps Merge runs around the master PRs
  release?: ReleaseRun; // the last release pipeline run this plan's Merge started
  stagingRelease?: ReleaseRun; // the last release pipeline run that merged this plan's staging PRs
  // A long-lived branch (e.g. feat/eshopbox) the plan builds on and merges into instead of staging: no staging deploy, staging test or master PRs.
  targetBranch?: string; targetSetByYou?: boolean; cleanedAt?: number; landedAt?: number; // cleanedAt: its worktree folders were removed (config cleanFinished); landedAt: every repo merged into the target branch
  stagingOnly?: boolean; // ends after the staging deploy and test: no master PRs (its go-live is done later)
  // The last review: every minor of every round checked against the final code (core/minors.ts). key: the set of minors it saw.
  minorSweep?: { key: string; at: number; runs?: number; verdicts: Record<string, { still: boolean; harmful: boolean; level?: "harmful" | "minor" | "trivial"; why: string; sent?: boolean; by?: string }> }; // by: the later plan whose last review checked it
  minorCalls?: Record<string, "accepted" | "sent">;
  archFindings?: { at: number; findings: Finding[] }[]; // the architect's whole-plan minor findings, for the findings list
  gateBuilt?: Record<string, string>; // repo -> the commits (its own and the plan's libraries') its last passing gate build saw
  planFixes?: string[]; planFixHolds?: string[]; planFixesSent?: string[]; // planFixHolds: ids of the tasks the queued fixes change (held until their update lands); // blocking findings a reviewer put in the plan (fix_in "plan"): sent to the planner once each // your call on each open minor finding (core/minors.ts), by its key
  promotes?: string; // kind "promote": the target branch this plan takes to staging, then through the normal staging test and master PRs
  hidden?: boolean; // Delete on the page: off the board only; the plan, its worktrees and its session stay
  terminal?: Terminal; // run from a Claude Code terminal (/ship): its session and subagents plan, write, review and test
}

// A terminal plan: the engine runs only the fixed steps (worktrees, merges, gate build, staging, master PRs) and starts no Claude run.
export interface TerminalAgent { id: string; type: string; desc?: string; task?: string; model?: string; startedAt: number; endedAt?: number; doing?: string; doingAt?: number; tools: number; result?: string }
export interface TerminalTest { exercised: boolean; passed: boolean; proof: string; checks: UatCheck[]; sessionId?: string }
export interface Terminal {
  session: string; cwd?: string; at: number; lastSeenAt?: number; // lastSeenAt: the last hook event from that session
  master?: { line: string; at: number }; // what the master session itself did last
  agents: TerminalAgent[]; pending?: { desc: string; type: string; model?: string; at: number }[]; // pending: Agent calls not started yet
  uat?: { askedAt: number; answer?: TerminalTest }; // the staging test waits for the terminal's tester
  port?: { askedAt: number; repo: string; master: string; dir: string; commit: string; files: string[]; commitText: string; answer?: { ok: boolean; note?: string } }; // a master pick conflict waits for the terminal
  sweep?: { askedAt: number; items: { n: number; task: string; category: string; text: string }[]; answer?: { n: number; still: boolean; level: string; why: string }[] }; // the last review waits for the terminal
}

// A host's watchdog: one outside run that fixes a plan that errored or hung. Runs are counted per IST day.
// state: working (a run is on it), fixed (waiting to restart or continue), done (the plan carries on), needs (handed to a person).
export interface WatchdogStep { text: string; at?: number; state: "done" | "now" | "wait" | "bad" }
export interface Watchdog {
  state: "working" | "fixed" | "done" | "needs";
  sessionId?: string; // the plan's (or fix's) one watchdog session: every later run continues it
  day: string; runs: number; maxRuns: number; // runs on `day` (YYYY-MM-DD, IST)
  startedAt?: number; endedAt?: number; why?: string; // what started the last run: the error text, or the hang
  doing?: string; cause?: string; summary?: string; tests?: string; needs?: string; bug?: string; fix?: string; // bug/fix: one line each, for the box
  steps: WatchdogStep[]; files: { path: string; change: string }[]; // files the run changed in the host repo (M, A, D)
  fixes: number; lastFixAt?: number; // stops fixed on `day`
  kept?: { at: number; after: string; repos: string[] }; keptCount?: number; // master PRs rebuilt to stay mergeable (count on `day`)
  history: { at: number; fixed: boolean; summary: string }[]; // every run on `day`
  retryAfterBoot?: boolean; // retry this plan when the host starts again (its fix needed a restart)
  idleMark?: string; // the plan's now and nowAt when a hang run ended: the same hang starts no second run
  dismissedAt?: number; // the user hid the "fixed it" box; the next run shows a new one
}

export interface State {
  seq: number; plans: Record<string, Plan>; tasks: Record<string, Task>;
  runs?: Record<string, { sid: string; at: number; cut?: boolean }>; // Claude runs going now, by "plan|task|role"; cut: a restart ended it, so the next such call resumes it
}
export interface PlanEvent { at: number; plan: string; task?: string; event: string; [k: string]: unknown }

// What the planner returns (core/prompts.ts PLAN_SCHEMA). deps are labels.
export interface PlannedTask {
  label: string; title: string; repo: string; wave: number; deps: string[]; files: string[];
  size: "S" | "M" | "L"; part: string; what: string[]; checks: string[]; bugs?: number[]; review?: boolean; review_why?: string; security: boolean; security_why?: string;
  // Only on a re-plan of a started plan: what happens to the task with this label.
  action?: "keep" | "update" | "redo" | "reopen" | "remove" | "add"; note?: string;
}
export interface PlannerResult {
  title: string; ticket?: string; architecture?: { changes: boolean; why: string }; uncovered?: { part: string; why: string }[]; db_changes?: { database: string; sql: string; why: string }[]; prod_gaps?: { task: string; repo: string; what: string }[]; kind: Kind; size_why: string; contract?: string; acceptance: string[];
  tasks: PlannedTask[];
  triage?: { n: number; text: string; task?: string; verdict?: LeftOut["verdict"]; why?: string }[];
  repo_order: { repo: string; why: string }[];
  target_branch?: string; // the branch the text says the work must merge into instead of staging; "" for staging
  changes?: string[]; // re-plan only: plain-English lines on what changed
}

// What the scheduler asks the engine to do next.
export type Action =
  | { kind: "plan"; plan: string }
  | { kind: "task"; task: string }
  | { kind: "gate"; plan: string; wave: number }
  | { kind: "staging"; plan: string }
  | { kind: "uat"; plan: string }
  | { kind: "master"; plan: string };
export const actionKey = (a: Action) => a.kind === "task" ? `task:${a.task}` : a.kind === "gate" ? `gate:${a.plan}:${a.wave}` : `${a.kind}:${a.plan}`;
