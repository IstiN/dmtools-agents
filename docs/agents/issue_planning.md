# issue planning

Plans a large issue before development: the agent reads the issue and the codebase and either keeps the issue whole or splits it into ordered steps, each small enough for one pull request. The steps are created as children of the issue (sub-issues on GitHub) and delivered one at a time.

The CLI agent only writes files: `outputs/plan.json` (the decision and the ordered steps) and one `outputs/plan/step-N.md` per step. The post-action `createPlannedSubIssues.js` then acts on the plan:

- **Kept whole** (`split: false`): the issue gets the dev label, so development starts as usual, and a comment gives the reason.
- **Split** (`split: true`): every step is created, in order, as a child of the issue; its description starts with a link to the parent and its place in the plan. The parent gets the planned label and a comment listing the steps.

Nothing is created from a plan that cannot be read, and a parent that already carries the planned label is never planned twice. When a step cannot be created, the run stops with a comment and the parent is not marked as planned.

## Sequential delivery (GitHub machine loop)

The SM rule `plan-advance` in `sm_github.json` (local action `advance_plan`) watches every open issue with the planned label. On each tick it reads the parent's sub-issues in order and:

- adds the dev label to the first open step once every earlier step is closed (a comment on the parent records it);
- waits while that step is in progress (it already carries the dev label);
- closes the parent when every step is closed.

A step's own pull request then runs the normal loop (CI, review, rework). The `blocked` label on the parent freezes the plan like any other machine item.

## Parameters

Set in the project `.dmtools/config.js` as `issuePlanning`, or per agent as `customParams.issuePlanning` (the agent value wins). The SM reads the same block from the project config.

- `issuePlanning.devLabel` — label that starts development of an issue. Added to a kept-whole issue and to each step when its turn comes. Default: `agent:dev`.
- `issuePlanning.plannedLabel` — label on a parent whose steps were created; the SM sequences only these. Default: `ai_planned`.
- `issuePlanning.maxChildren` — most steps a plan may have; a larger plan is rejected. Default: `8`.
- `issuePlanning.planFile` — where the agent writes the plan. Default: `outputs/plan.json`.
- `checkOpenPR` — read by the pre-action `checkWipLabel.js`: when `true`, skip an issue that already has an open pull request. Default: `false`.

```js
// .dmtools/config.js
module.exports = {
    issuePlanning: { devLabel: 'agent:dev', maxChildren: 6 }
};
```

## Tracker support

Creating the steps uses `createTicketWithParent`, which works on every tracker (on GitHub the step is attached to the parent through the sub-issues REST API via `gh api`). Sequencing reads the steps with `listChildTickets`, which is GitHub-only, so the `plan-advance` rule runs in the GitHub machine loop. On Jira or ADO the steps are created and then started by hand or by your own rules.
