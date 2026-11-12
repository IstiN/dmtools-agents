<!-- Pack-reachability hub for the deprecated v1 instruction shims.
     This file exists so `dmtools compile` ships the frozen v1 shims below
     while configs still pin their old paths (the #600/#605 crash class).
     Remove together with the shims in the next major release. -->

# Deprecated v1 instruction paths (frozen shims)

The 2026-11-12 instruction split moved the pr_review contract files under
`instructions/pr_review/base|generalist|security/`. The old paths live on as
FROZEN v1 shims (deprecation banner + verbatim old content) so configs that
still pin them keep working. Update your `.dmtools/config.js`
(cliPrompts / cliPromptOverrides / globalCliPrompts) or `.dmtools/runners/*.json`
to the new paths — the shims are removed in the next major release.

| deprecated v1 path (frozen) | live v2 path |
|---|---|
| `instructions/pr_review/general_guidelines.md` | `instructions/pr_review/generalist/lens.md` (+ `instructions/pr_review/base/input_context.md`, `instructions/pr_review/base/registry_protocol.md`) |
| `instructions/pr_review/output_rules.md` | `instructions/pr_review/base/output_rules.md` (+ `instructions/pr_review/base/input_context.md`) |
| `instructions/pr_review/formatting_rules.md` | `instructions/pr_review/base/formatting_rules.md` |
| `instructions/pr_review/review_verdict_rules.md` | `instructions/pr_review/base/review_verdict_rules.md` |
| `instructions/pr_review/few_shots.md` | `instructions/pr_review/generalist/few_shots.md` |
| `instructions/pr_test_automation_review/output_rules.md` | `instructions/pr_review/base/output_rules.md` |
| `instructions/pr_test_automation_review/formatting_rules.md` | `instructions/pr_review/base/formatting_rules.md` |

`scripts/validate-review-skills.js` warns when a config still pins a v1 path.
