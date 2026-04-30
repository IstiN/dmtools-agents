# CI failures

If `ci_failures.md` exists:

- Treat failed checks as BLOCKING unless clearly marked informational.
- Summarize the failed check name, relevant log evidence, and required fix.
- Do not invent root causes when logs are insufficient.
- Mention CI failures in the tracker comment and PR general comment.

