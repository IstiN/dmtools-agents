# story development

Implements a story end to end: checks out the repository, writes the code and tests, and opens a pull request linked to the story.

## Parameters

Configured via `customParams` in the agent JSON or the project `.dmtools/config.js`.

- `autoStartReview` — auto start review.
- `autoStartReviewConfigFile` — auto start review config file.
- `branchCreateFnPath` — branch create fn path.
- `cacheToReleases` — cache to releases.
- `cacheToReleases.releaseNameTemplate` — release name template.
- `cacheToReleases.releaseTagTemplate` — release tag template.
- `checkOpenPR` — check open pr.
- `customStatuses` — custom statuses.
- `removeLabel` — remove label.
- `removeLabels` — remove labels.
- `removeLabels.forEach` — for each.
- `scmProvider` — scm provider.
- `targetRepository` — target repository.
- `targetRepository.workingDir` — working dir.
