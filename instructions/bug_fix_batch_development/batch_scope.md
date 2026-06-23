# Bug-fix batch development scope

You are developing fixes for multiple bugs grouped under a single Epic.
The Epic groups related bugs so they can be fixed together in one pull request.

## Inputs

All context for the batch is provided in `input/{epicKey}/batch_bugs.md`.
The file contains:

- The Epic key and summary.
- The list of linked bug keys with their summaries and current statuses.
- For each bug, the path to its dedicated input folder where the original bug
  context was pre-fetched (requirements, reproduction steps, attachments, etc.).
- Paths to the standard bug-development instructions that apply to **each**
  individual bug in the batch.

Read `batch_bugs.md` first. Then process each bug in the list.

## Reusing the single bug-fix rules

For every bug in the batch follow the workflow defined in
`agents/instructions/bug_fix_development/scope.md` and the per-stage
instructions in the same folder:

- `agents/instructions/bug_fix_development/setup.md`
- `agents/instructions/bug_fix_development/analysis.md`
- `agents/instructions/bug_fix_development/implementation.md`
- `agents/instructions/bug_fix_development/verification.md`
- `agents/instructions/bug_fix_development/finalization.md`

Apply the rules as if you were fixing the bug individually, **but**:

1. Work in the **same branch** for the whole batch.
2. Reuse common fixes across bugs when it makes sense (e.g. a single utility
   fix that resolves several issues), but make sure each bug is still
   addressed.
3. Keep changes minimal and focused on the listed bugs only.
4. If a bug is already fixed, cannot be reproduced, or needs clarification,
   follow the `blocked.json` / `already_fixed.json` handling described in
   `scope.md` and record the decision in the PR description.

## Pull request

When all bugs in the batch are addressed:

1. Use the Epic title and description for the PR title/body.
2. List every bug key in the PR description and explain what was changed for
   each one.
3. Create a single PR from the batch branch.
4. Link the PR to the Epic.
5. Do **not** merge the PR yourself.

## Status transitions

After the PR is created and pushed:

- Move the Epic to **In Review**.
- Move every linked bug listed in `batch_bugs.md` to **In Review**.
- Add the `ai_developed` label to the Epic and to each linked bug.

If any bug cannot be fixed in the batch, document it explicitly in the PR
and leave that bug in its original status unless the instructions above say
otherwise.
