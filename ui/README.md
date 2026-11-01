# The plans page

Plain HTML, CSS and JS: no build step, no framework, nothing imported from outside this folder. It shows every plan of one backend: waves, tasks, the master session and its subagents live, staging and master PRs, findings.

## Open it

- `ship ui` serves this folder at http://127.0.0.1:4390/ and forwards `/api/prflow/*` to the backend picked for the current folder (see `../BACKEND.md`).
- A backend may serve this folder itself at a path ending in `/` (for example `/tasks/`), with its API at `/api/prflow`.

## What the page reads from the backend

`GET /state` (plans, tasks, progress, findings per plan), `GET /plans/:id/events`, `GET /findings`, and the write calls under `/plans/:id/*` (stop, delete, staging-only, send-back, minor, merge-master, release-steps).

## Host hooks (all optional)

- `<meta name="prflow-base">`: the API base, default `/api/prflow`. `<meta name="prflow-home">`: the sidebar home link.
- `<meta name="td-token">`: a write token, sent as `X-TD-Token` on every write (`ship ui` adds it for you).
- `theme.css` next to `index.html` overrides the colours in `tokens.css`; a 404 is fine.
- `window.prflowHost.names`: `{ release, git, testUser }`, the words the page uses for the release pipeline, the git host and the staging test user.
- `window.prflowHost.claudePause()` and `resume()`: a banner when Claude is paused, and its Resume button.
