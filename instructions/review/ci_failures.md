# CI failures

If `ci_failures.md` exists:

- Treat failed checks as BLOCKING unless clearly marked informational.
- Read the **"Violations you must fix (N owned)"** table at the top first (gh-1119): each owned row (check, rule, `path:line`, measured vs limit) is in a file changed by the PR diff. The "Foreign / infra reds (do not chase)" list that follows marks reds in untouched files — report them, do not fix them in this PR.
- Summarize the failed check name, relevant log evidence, and required fix.
- Do not invent root causes when logs are insufficient.
- Mention CI failures in the tracker comment and PR general comment.

Full (untruncated) logs are available in `ci_failures_full.log` when present; the uncapped violation list in `ci_violations.json`.

