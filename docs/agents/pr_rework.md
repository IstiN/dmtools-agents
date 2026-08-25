# pr rework

Reworks a pull request after review: reads review comments, implements the requested fixes, and pushes updates to the PR branch.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js`.

- `autoStartReview` — auto start review.
- `autoStartReviewConfigFile` — auto start review config file.
- `branchCreateFnPath` — branch create fn path.
- `branchSyncFnPath` — branch sync fn path.
- `cacheToReleases` — cache to releases.
- `cacheToReleases.releaseNameTemplate` — release name template.
- `cacheToReleases.releaseTagTemplate` — release tag template.
- `checkOpenPR` — check open pr.
- `removeLabel` — remove label.
- `removeLabels` — remove labels.
- `scmProvider` — scm provider.
- `targetRepository` — target repository.
