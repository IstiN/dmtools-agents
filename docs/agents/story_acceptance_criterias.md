# story acceptance criterias

Legacy plural-named alias config (`story_acceptance_criterias.json`) for `story_acceptance_criteria.json`, retained for backward compatibility with existing SM labels (`sm_story_acceptance_criterias_triggered`) and encoded-config callers. Shares `./agents/instructions/story_acceptance_criteria/workflow.md`.

## Parameters

- `contentOutput` — output routing block writing to the `Acceptance Criteria` field (`operationType: replace`) and invoking `assignForSolutionArchitecture.js`.
- `autoStartSolution` / `autoStartSolutionConfigFile` — optional follow-up solution workflow trigger.
