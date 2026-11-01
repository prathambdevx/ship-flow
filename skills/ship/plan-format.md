# Plan JSON for `ship register`

One object. Every field shown is required (use `""` or `[]` when empty).

```json
{
  "title": "Payments: retry failed webhook deliveries",
  "ticket": "PROJ-123",
  "target_branch": "",
  "kind": "big",
  "size_why": "3 tasks in 2 repos",
  "contract": "optional: the API or data shape tasks must agree on",
  "acceptance": ["A failed push is retried 3 times", "Ops sees an issue after the last failure"],
  "architecture": { "changes": false, "why": "uses the existing outbox" },
  "uncovered": [],
  "db_changes": [{ "database": "billing-service", "sql": "ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...", "why": "..." }],
  "prod_gaps": [],
  "repo_order": [{ "repo": "billing-service", "why": "the API first" }, { "repo": "orders-service", "why": "calls it" }],
  "tasks": [
    {
      "label": "T1", "title": "Retry the push in the outbox worker", "repo": "billing-service", "wave": 1, "deps": [],
      "files": ["src/main/java/.../WebhookWorker.java", "src/test/java/.../WebhookWorkerTest.java"],
      "size": "M", "part": "Retry", "what": ["Retry 3 times with backoff", "Mark the row failed after the last try"],
      "checks": ["A push that fails twice then succeeds is sent once", "A push that always fails ends failed"],
      "review": true, "review_why": "", "security": false, "security_why": ""
    }
  ]
}
```

Rules the backend checks:
- `kind`: `small` (1 task), `big` (several), `list` (a list of bugs, one task each).
- Labels `T1`, `T2`, ... unique. Waves run 1, 2, 3 with no gaps; a dep must be in an earlier wave; no cycles.
- Each task: one repo from the backend's repo list, at least one file, repo-relative paths only.
- Two tasks in the same wave never share a file.
- `repo_order` lists every repo with a task, and only those, in merge order.
- `db_changes`: add-only, idempotent SQL; the backend runs it on staging before the code.
- `security: true` only for a real attack surface (auth, webhooks, input parsing, secrets).
