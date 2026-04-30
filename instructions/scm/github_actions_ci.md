# GitHub Actions CI rules

Use this only for projects that use GitHub Actions.

- Check whether `.github/workflows/` already contains a pull-request test workflow before adding one.
- If no suitable workflow exists and the ticket requires CI coverage, create a workflow that runs the existing test command on `pull_request` events.
- Match the existing language and build tool; do not introduce unrelated tooling.
- For repository variables, inspect existing values first with `gh variable list --repo {owner}/{repo}`.
- For secrets, inspect existing names first with `gh secret list --repo {owner}/{repo}`.
- Never invent secret values. Document missing secret names as human action required.

