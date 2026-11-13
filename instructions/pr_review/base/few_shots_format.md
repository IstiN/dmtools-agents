# pr_review.json shape — format contract (base, gh-1406)

Reviewer-agnostic: the structured answer of every reviewer leg carries the
same shape. The worked examples live in each reviewer's few-shots file; this
file is the shape + severity-boundary contract.

### outputs/pr_review.json
```json
{
  "recommendation": "BLOCK",
  "summary": "SQL injection in UserService.js must be fixed before merge.",
  "generalComment": "outputs/pr_review_general.md",
  "inlineComments": [
    {"path":"src/auth/UserService.js","line":45,"comment":"outputs/pr_review_comments/comment1.md","severity":"BLOCKING"},
    {"path":"src/auth/LoginController.js","line":78,"comment":"outputs/pr_review_comments/comment2.md","severity":"IMPORTANT"},
    {"path":"src/utils/validation.js","line":23,"comment":"outputs/pr_review_comments/comment3.md","severity":"SUGGESTION"},
    {"path":"src/auth/LoginController.js","line":20,"comment":"outputs/pr_review_comments/comment4.md","severity":"NIT"}
  ],
  "issueCounts": {"blocking":1,"important":1,"suggestions":1,"nits":1}
}
```

**Severity boundary (4 tiers)**: a 🪶 NIT changes nothing behavioral and
nothing documented (style, naming, formatting, micro-symmetry); a 💡 SUGGESTION
changes clarity of the documented/behavioral surface (missing docs, unclear
contract, better API shape). Anything that changes behavior or breaks a
documented contract is ⚠️ IMPORTANT or 🚨 BLOCKING.

The 4-tier census (`issueCounts`) counts posted threads + digest lines and
drives the machine verdict — keep it consistent with the inlineComments
severities.

### outputs/pr_review_candidates.json — specialist legs only

A SPECIALIST leg (reviewer_leg.md present) answers with candidates, never a
verdict — the posting leg mints the verdict; the machine merges, filters
and posts. The shape is the reviewPoolMerge candidate contract:

```json
{
  "reviewer": "security",
  "candidates": [
    {"id": 1, "path": "src/auth/UserService.js", "line": 45,
     "severity": "BLOCKING",
     "claim": "User query at line 45 concatenates req.body.user straight into the SQL string; parameterize the statement."},
    {"id": 2, "path": "docs/migration.md", "line": null,
     "severity": "SUGGESTION",
     "claim": "The rollback path for the new columns is undocumented — a bad deploy cannot revert cleanly."}
  ]
}
```

Rules: `id` = position in the file; `path` repo-relative; `line` = the
diff line or `null` for a digest candidate; `claim` = the substance (no
severity header, no verdict language). Severity boundary identical to the
verdict tiers above. Nothing else gets written (no pr_review.json, no
comment files) and nothing gets posted — worked examples of the claim
voice live in each reviewer's few-shots file.
