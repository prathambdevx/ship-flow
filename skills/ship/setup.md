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

## 2b. Test database (ask after the branch questions)

First look, never reading real secrets: in each repo, read `.env.example`, `.env.sample`, `docker-compose*.yml` and config files for names like `DATABASE_URL`, `DB_URL`, `POSTGRES_*`, `STAGING_DB_URL`. Read names only. Do not open `.env`. Check which names are set in this terminal with `printenv NAME >/dev/null` (print nothing).

Ask, numbered, in plain English:
1. "Where should I check test data: your staging database, your dev database, or a local database on this machine? Or say none for no database checks."
2. "How can this terminal connect to it?" Offer what you found: "`DATABASE_URL` is already set here. Use it?" or "a command, for example `psql "$STAGING_DB_URL"` or a tunnel script", or, for local, "the command that starts it (for example `docker compose up -d db`) and the env var that holds its URL".

Then test the connection from this terminal with a harmless `select 1` (for example `psql "$NAME" -c 'select 1'`, or the database's equivalent). If it fails, say plainly what is missing, for example: "`STAGING_DB_URL` is not set in this terminal. Set it, or tell me how you usually connect." Ask again, or save `where: "none"` if the user prefers.

Never ask for, print or store a password or a full connection string. Store only the env var name (`"$DATABASE_URL"`) or the command.

## 3. GitHub

If `originIsGithub` is false for a repo, or `gh.installed` is false, or `gh.loggedIn` is false: explain plainly that PRs need the GitHub CLI and a login. For a missing login tell the user to type `! gh auth login` (the `!` runs it in this session) and answer the questions it shows. Wait until `ship detect` says `loggedIn: true`. If origin is not GitHub, say that PRs cannot be opened for that repo yet and ask if the plan should still run (it stops at the local branches).

## 4. Set up

Write the answers to the scratchpad as `answers.json`:

```json
{ "name": "<folder name, letters and digits>", "folder": "<absolute folder>", "mergeToStaging": "auto | you",
  "repos": [ { "name": "api", "path": "/abs/path", "workBranch": "dev", "stagingBranch": "staging", "prodBranch": "main", "build": "npm run build", "test": "npm test" } ],
  "testDb": { "where": "staging | dev | local | none", "connect": "$DATABASE_URL  (an env var name, or a command)", "start": "docker compose up -d db  (local only)", "note": "optional" } }
```

`stagingBranch` and `prodBranch` are `null` when the user said there is none. `build` and `test` are optional. `testDb` is optional (leave it out for none); `connect` and `start` are optional. `mergeToStaging` is `"auto"` (merge myself) or `"you"` (wait for the user).

Then run `ship setup answers.json`, then `ship up`. Give the user the dashboard link it prints, in one line, and say what was set up (repos, staging, production, merge choice). Then go on with registering the plan (step 1 in SKILL.md). If `ship up` fails, read the log it names, fix the cause, and try again.
