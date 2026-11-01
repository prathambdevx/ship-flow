// What a host repo gives prflow. prflow imports nothing outside its folder; everything outside goes through these.
import type { Plan, PrRef, ReleaseRunRef, Role, State, Task, UatCheck } from "./types.ts";

export interface ClaudeRun {
  role: Role; prompt: string; model: string; schema?: object;
  edits?: string[]; // the only folders the run may change; none: read only
  sessionId?: string; resumeId?: string; // start a session with this id, or continue one
  plan: string; task?: string; // for logs and cost
  onActivity?: (line: string) => void;
  onStart?: (stop: () => void) => void; // the host hands back a way to end the run (Stop during planning)
}
// allow: beyond add-only DDL ("do" blocks, "upsert" into tables). queries: a preflight must have at least this many.
export interface SqlOpts { allow?: string[]; tables?: string[]; queries?: number }
export interface ClaudeResult { ok: boolean; structured: any; text: string; sessionId?: string; error?: string }

export interface TestInput {
  plan: Plan; tasks: Task[]; diffs: { repo: string; diff: string }[];
  onProgress: (text: string) => void; stopped: () => boolean;
  onActivity?(line: string): void; // each action of the tester's Claude run
  onStep?(step: number, scenarios?: { what: string; task: string }[]): void; // 0 write the test, 1 run the calls, 2 judge
}
// exercised false: the test never reached the change (wrong test data); the engine asks again, up to 3 times.
export interface TestResult { exercised: boolean; passed: boolean; proof: string; checks: UatCheck[]; sessionId?: string } // sessionId: the tester's session, continued by the next run

export interface Git {
  stagingBranch(repo: string): Promise<string>; // the branch staging deploys from
  masterBranch(repo: string): Promise<string>;
  worktree(repo: string, dir: string, branch: string, from: string): Promise<void>; // from: a ref, e.g. "origin/uat" or a local branch
  drop(repo: string, dir: string): Promise<void>;
  fetch(dir: string): Promise<void>;
  head(dir: string): Promise<string>;
  commitAll(dir: string, message: string): Promise<string | null>; // null: nothing to commit
  changedFiles(dir: string, base: string): Promise<string[]>; // vs base ref
  diff(dir: string, base: string): Promise<string>;
  stat(dir: string, base: string): Promise<string>;
  mergeBranch(dir: string, branch: string, message: string): Promise<{ ok: boolean; conflict?: string }>; // local branch into dir's branch
  rebase(dir: string, onto: string): Promise<{ ok: boolean; conflict?: string }>;
  push(dir: string, branch: string): Promise<void>;
  commitsSince(dir: string, base: string): Promise<string[]>; // oldest first
  cherryPick(dir: string, commits: string[], opts?: { keepConflict?: boolean }): Promise<{ ok: boolean; head?: string; conflict?: string; empty?: boolean; files?: string[] }>; // empty: already on this branch; keepConflict: leave the conflict for a port
  contains?(repo: string, ancestor: string, branch: string): Promise<boolean>; // origin/<branch> already has origin/<ancestor>'s head
  remoteHead?(repo: string, branch: string): Promise<string>; // fetches origin, then the commit origin/<branch> is at now
  verifyCommits?(repo: string, branch: string, commits: string[]): Promise<string | null>; // null: each is a non-merge commit on origin/<branch>; else why not
  existsAt?(dir: string, ref: string, path: string): Promise<boolean>; // the file is in that commit or branch
  finishPick?(dir: string, commit: boolean): Promise<{ ok: boolean; error?: string }>; // after a port: commit the resolved pick, or abort it
  showCommit?(dir: string, commit: string): Promise<{ text: string; files: string[] }>; // the commit's message and diff
  diffRange?(dir: string, from: string, to: string, files: string[]): Promise<string>; // diff between two commits, only these files
  poms?(dir: string): Promise<{ path: string; text: string }[]>; // every committed pom.xml in the worktree (HEAD), root and modules
  writeFile?(dir: string, path: string, text: string): Promise<void>; // path is relative to dir; the edit stays uncommitted
  mergesCleanly?(repo: string, head: string, target: string): Promise<boolean | null>; // would head merge into origin/<target> with no conflict; null: cannot tell
  readAt?(repo: string, ref: string, path: string): Promise<string>; // a file's text at a commit, read in the repo's own clone
  hasWords?(dir: string, words: string[]): Promise<string[]>; // the words found as whole words in the committed HEAD of dir
  ensureBranch?(repo: string, branch: string, from: string): Promise<boolean>; // makes origin/<branch> from origin/<from> if it is missing; true: it made it
}

export interface Ports {
  claude(run: ClaudeRun): Promise<ClaudeResult>;
  repos(): { name: string; about?: string }[]; // repos the planner may use
  git: Git;
  build(dir: string, opts?: { quick?: boolean }): Promise<{ ok: boolean; ran: boolean; tail: string }>; // quick: compile main and test code only, no tests
  prs: {
    create(repo: string, src: string, dest: string, title: string, body: string): Promise<Pick<PrRef, "id" | "url">>;
    merge(repo: string, id: number): Promise<string>; // the merge commit
    state(repo: string, id: number): Promise<PrRef["state"]>;
    head(repo: string, id: number): Promise<string>; // the PR's source commit now; merge only if it is still the one built
    decline(repo: string, id: number): Promise<void>; // an edit made this PR out of date
    retitle?(repo: string, id: number, title: string): Promise<void>;
    describe?(repo: string, id: number, title: string, description: string): Promise<void>; // replace title and description
  };
  deploy: { // staging merges only; master deploys are waited on by the release runner
    check(repo: string, branch: string): Promise<string | null | { manual: string }>; // null: a merge deploys; manual: merge, deploy by hand; string: stop, why
    wait(repo: string, branch: string, commit: string, onProgress: (text: string) => void, stopped: () => boolean): Promise<{ ok: boolean; detail: string; manual?: boolean }>; // manual: the pipeline has no deploy step
  };
  test(input: TestInput): Promise<TestResult>; // the staging test, after every staging PR is merged and deployed
  repoLock<T>(repo: string, job: () => Promise<T>): Promise<T>; // staging merges and staging tests in one repo take turns
  diffGuard(files: string[], diff: string): string | null; // null: fine; else why the change is refused
  libs?: { // in-house libraries: a master PR must not merge a service that still depends on a library SNAPSHOT
    names(): string[]; // repo names that are in-house libraries (a pom's artifactId equals the repo name)
    released(lib: string, version: string): Promise<boolean>; // the release tag <lib>-<version> exists on origin
    install?(dir: string): Promise<{ ok: boolean; detail: string }>; // installs the library worktree at dir into the local Maven cache
  };
  stagingDb?(changes: { database: string; sql: string }[]): Promise<{ ok: boolean; detail: string }>; // runs the plan's add-only database changes on staging; ok false: a person must run them
  // Release steps, run only from the user's Merge click. A host without them refuses release steps.
  prodSql?: {
    problem(kind: "preflight" | "sql", database: string, sql: string, opts?: SqlOpts): string | null; // why it may not run, or null
    check(database: string, sql: string): Promise<{ ok: boolean; results: { sql: string; rows: Record<string, unknown>[] }[]; error?: string }>; // read only, each query in order
    run(database: string, sql: string, opts?: SqlOpts): Promise<{ ok: boolean; statements: { sql: string; rows: number }[]; error?: string }>; // the write login, statement by statement
  };
  configEdit?: {
    read(repo: string, branch: string, file: string): Promise<string>; // the file at origin/<branch> now
    commit(repo: string, branch: string, file: string, text: string, message: string): Promise<{ commit: string; files: string[]; text: string }>; // a local commit on origin/<branch>, not pushed
    push(repo: string, branch: string, commit: string): Promise<void>; // fast-forward only
  };
  // The release runner (the release pipeline): merges the PRs in dependency order and waits for each deploy. Merge refuses without it.
  release?: {
    start(target: "staging" | "master", prs: { repo: string; id: number }[]): Promise<ReleaseRunRef>; // never retried: a second start could merge twice
    status(uuid: string): Promise<{ done: boolean; result?: string }>; // result when done: SUCCESSFUL, FAILED, STOPPED, ERROR
    log(uuid: string): Promise<string>; // the run's step log so far
    after(run: number): Promise<ReleaseRunRef | null>; // the first release run started after run N (a hand-off), or null
  };
  prStyle?(): string | null; // the host's house style for PR descriptions; null: the engine's plain list
  stageRoot: string; // worktrees go here; sandboxed runs can write here
  dataDir: string; // state.json and events.jsonl
  emit?(state: State): void; // tell the UI something changed
  log?(line: string): void;
  now?(): number;
  sleep?(ms: number): Promise<void>; // tests pass a fast one
}
