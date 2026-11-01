# First-time setup for a project

Use this when `ship backends` shows `"forCwd": null`. The user types only `/ship`; you do the rest and ask only simple confirmations. The user never runs `ship` commands.

## 1. Look

Run `ship detect` (read only). It prints the git repos in this folder (the folder itself, else its direct sub-folders), and for each: origin, whether it is GitHub, the current branch, all branches, and guesses (`workBranch`, `stagingBranch`, `prodBranch`, `build`, `test`). It also says if `gh` is installed and logged in.

No repo found: tell the user plainly that `/ship` must start in a git repo (or a folder of repos), and stop.

## 2. Ask (one short message, numbered, only what you cannot see for sure)

Confirm guesses, do not ask open questions. Skip any question whose answer is certain. Plain English, one line each. Use these forms:

1. Staging found: "I see a branch called `staging`. Is that your staging (UAT) branch?"
2. Several candidates: "Which of `staging` and `uat` is your staging branch?"
3. No staging branch: "I can't see a staging branch. Should plans go straight to production, or do you want to make a staging branch first?"
4. Production found: "Is `main` your production branch?"
5. No production branch: "I can't see a production branch. Is there none yet? Then plans stop at staging and no production PR is opened."
6. Work branch: "You are on `dev`. Is `dev` the branch you work on, where changes should go first?"
7. Merging: "Should I merge into staging myself once the reviews pass, or open the PR and wait for you to merge it?"
8. Commands: "I'll run `npm test` to check the build. Is that right?" If none was found: "I found no build or test command. What should I run to check a change? (or say none)"

With several repos, group the questions by repo name, or ask once "Same for all?" when the guesses match.

## 3. GitHub

If `originIsGithub` is false for a repo, or `gh.installed` is false, or `gh.loggedIn` is false: explain plainly that PRs need the GitHub CLI and a login. For a missing login tell the user to type `! gh auth login` (the `!` runs it in this session) and answer the questions it shows. Wait until `ship detect` says `loggedIn: true`. If origin is not GitHub, say that PRs cannot be opened for that repo yet and ask if the plan should still run (it stops at the local branches).

## 4. Set up

Write the answers to the scratchpad as `answers.json`:

```json
{ "name": "<folder name, letters and digits>", "folder": "<absolute folder>", "mergeToStaging": "auto | you",
  "repos": [ { "name": "api", "path": "/abs/path", "workBranch": "dev", "stagingBranch": "staging", "prodBranch": "main", "build": "npm run build", "test": "npm test" } ] }
```

`stagingBranch` and `prodBranch` are `null` when the user said there is none. `build` and `test` are optional. `mergeToStaging` is `"auto"` (merge myself) or `"you"` (wait for the user).

Then run `ship setup answers.json`, then `ship up`. Give the user the dashboard link it prints, in one line, and say what was set up (repos, staging, production, merge choice). Then go on with registering the plan (step 1 in SKILL.md). If `ship up` fails, read the log it names, fix the cause, and try again.
