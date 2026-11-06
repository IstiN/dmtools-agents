# SM GitLab

The GitLab state engine for the machine loop. It evaluates configured GitLab merge-request and issue rules on each tick to reconcile review and validation state, rerun cancelled checks, update branches, and merge eligible changes.

## Parameters

Configured in `jobParams` in `sm_gitlab.json`.

- `maxTriggeredWorkflows` — maximum workflows dispatched during one tick.
- `validationConcurrency` — maximum number of concurrent validation runs when the approved queue reaches its configured watermark.
- `validationConcurrencyQueueWatermark` — approved queue depth that enables concurrent validation.
- `rules` — GitLab-backed issue and merge-request rules processed by `js/smAgent.js`.