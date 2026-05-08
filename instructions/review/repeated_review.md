# Repeated review

If `pr_discussions.md` exists:

- Read previous comments before adding new findings.
- For each previous issue, state: resolved, still present, partially addressed, or not verifiable.
- Do not re-raise fully fixed issues.
- Add a thread ID to `resolvedThreadIds` only when the fix is verified.
- If the same finding repeats because the test now correctly exposes a genuine product defect or missing production capability, do not keep requesting test rework. Approve the failed test when it is otherwise correct and includes enough bug evidence for downstream bug creation.
