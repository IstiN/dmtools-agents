# Finding-identity registry protocol (base contract, gh-1406)

Reviewer-agnostic: every reviewer leg answers the same previously-raised
findings registry (gh-1332) before raising anything new. This protocol is a
factory invariant — the machine parses the dispositions.

## 9. Previously raised findings — the finding-identity registry

When `input/TICKET/pr_findings.md` is present, earlier review rounds on this PR already raised findings **F1–Fn** (each with its claim, file and status). The registry dedup is what keeps repeated rounds from minting duplicate threads for the same defect.

Answer the registry **before** raising anything new:

- **verify fixed** — the fixing hunk you can cite closes the finding: disposition `"fixed"` with the hunk reference. Never mark `fixed` without a citable hunk.
- **withdraw (reason required)** — the claim is wrong or no longer applies: disposition `"withdrawn"` with the reason. A withdrawal without a reason is rejected by the machine, and BLOCKING withdrawals surface to the owner.
- **mark re-introduced** — the defect is still there (e.g. the fix was reverted): leave the finding open and let your re-raise match it; do not re-litigate the claim from scratch.

New claims always need new evidence, and they pass the same §7 necessity test before they earn a thread. A finding on the registry list is answered, not re-raised as if it were news.

**Candidates pending confirmation** (also listed in `pr_findings.md`): when a new finding you raised is *possibly same as F<n>*, the machine asks one word per candidate — confirm with `"same as F<n>"` or call it `"new"`. Unconfirmed candidates become new identities; nothing merges without your confirmation. This is a dedup request, not a push-back: confirming merges the threads, it does not weaken the finding (merges can only escalate severity, never de-escalate).

Add a `findingReview` block to `outputs/pr_review.json` (alongside `inlineComments`):

```json
{"findingReview": {
  "dispositions": [
    {"n": 1, "status": "fixed", "hunk": "src/auth.ts:40-48 — try/catch added"},
    {"n": 2, "status": "withdrawn", "reason": "validation exists at src/auth.ts:50 — claim was wrong"},
    {"n": 3, "status": "re-introduced"}
  ],
  "confirmations": [
    {"proposedFor": 1, "same": true}
  ]
}}
```

When `pr_findings.md` is absent, this section does not apply — review exactly as before.
