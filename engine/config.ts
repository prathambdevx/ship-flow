// Defaults a host may override (createEngine(ports, config)).
import type { Role } from "./types.ts";

export interface Config {
  models: Record<Role, string>;
  terminalOnly?: boolean; // the host runs every Claude step in a terminal (/ship,: the engine starts no Claude run
  maxTasks: number; // tasks writing or reviewing code at the same time, across all plans
  maxPlanning: number;
  maxReviewRounds: number; // then the task stops and says why
  maxTotalRounds: number; // review rounds across every retry; then the task stops and waits for a person, not the watchdog
  maxBuildFixes: number; // debugger tries on one failed build
  maxTestTries: number; // staging tests that did not reach the change
  maxSendBacks: number; // UAT send-backs per plan before it stops
  architectFiles: number; architectRepos: number; // a big plan gets the architect above these, or when it changes the design
  reviewLines: number; // a task diff bigger than this is reviewed even when the planner said no
  riskyCode: string[]; riskyPaths: string[]; // regexes on added lines / changed paths that switch the security review on
  settleMs: number; // wait after the last deploy before the staging test
  transientRetries: number; // a failure that is not a deliberate stop retries on its own this many times (after 1, 5, 15 minutes)
  base: string; // URL prefix of the API, e.g. "/api/prflow"
  plannerResumeMs: number; // a new planning round resumes the last planner session if it is younger than this
  wholePlanModel: string; // the final-stage reviews (architect's plan diff, the last review) read the whole diff in one pass
  resumedReviewModel: string; // a resumed code-review round checks its own findings and the change since: Sonnet; round 1 and the sign-off stay on models["code-reviewer"]
  reviewerResume: boolean; // true: one code-reviewer session per task across fix rounds, and a fresh reviewer signs off; false: a fresh reviewer every round
  stagingRunner: boolean; // true: staging PRs merge through ports.release (TARGET=staging) in one run; false: one by one
  watchMasterPrs?: boolean; // no release runner: poll the open master PRs; when the user has merged them all on the git host, the plan is live
  cleanFinished?: boolean; // drop a finished plan's worktree folders and build output once (branches stay)
  buildEachTask: boolean; // true: every task compiles and builds, and every wave gate builds; false: only the last wave's gate builds each repo once (and master)
}

export const DEFAULTS: Config = {
  models: { planner: "opus", "architect-reviewer": "opus", executor: "sonnet", debugger: "sonnet", "code-reviewer": "opus", "security-reviewer": "opus", tester: "opus" },
  maxTasks: 6, maxPlanning: 2, maxReviewRounds: 5, maxTotalRounds: 15, maxBuildFixes: 3, maxTestTries: 3, maxSendBacks: 3, architectFiles: 15, architectRepos: 2,
  reviewLines: 150,
  riskyCode: ["@(Post|Put|Patch|Delete|Request)Mapping", "@PreAuthorize|@Secured|hasRole|hasAuthority", "createNativeQuery|nativeQuery\\s*=\\s*true|\\.unsafe\\(", "\"\\s*\\+\\s*\\w+.*\\b(SELECT|UPDATE|DELETE|INSERT|WHERE)\\b|\\b(SELECT|UPDATE|DELETE|INSERT|WHERE)\\b.*\"\\s*\\+", "Runtime\\.getRuntime|ProcessBuilder|child_process", "password|secret|api[_-]?key|access[_-]?token", "innerHTML|bypassSecurityTrust"],
  riskyPaths: ["(^|/)(security|auth|permission|permissions|acl|filter)/", "(Security|Auth|Permission|AccessControl)[A-Za-z]*\\.(java|ts)$"],
  settleMs: 60_000, transientRetries: 3, base: "/api/prflow", stagingRunner: false, buildEachTask: true, reviewerResume: true, resumedReviewModel: "sonnet", wholePlanModel: "opus[1m]", plannerResumeMs: 60 * 60_000,
};
