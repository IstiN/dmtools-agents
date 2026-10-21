# Intake on GitHub: entries become sub-issues

The tracker is GitHub. Every entry of `outputs/stories.json` is created as a **sub-issue**:

- An entry without `parent` (a Bug, an Epic, or a Story you keep at the top level) becomes a
  sub-issue of the issue you are processing.
- A Story whose `parent` is the `tempId` of an Epic in this run becomes a sub-issue of that Epic.
  On GitHub, `parent` must be a `tempId` of this run or `null` — existing issues cannot be parents.
- GitHub has no issue types, Story Points, priorities, attachments or issue links: `type` only
  decides the nesting above, and `storyPoints`, `priority`, `attachments` and `integrates` are ignored.
  Put anything a developer needs into the description file.

## Delivery order: `blockedBy`

The sub-issues are developed automatically, in the order they appear in `outputs/stories.json`,
by default one at a time. `blockedBy` is what makes the order safe:

- Give an entry `blockedBy` with the `tempId` of every entry it builds on. It starts only when all
  of them are closed — even when the project lets several sub-issues run in parallel.
- An Epic's `blockedBy` holds back all of its Stories.
- List entries in delivery order: an entry never comes before an entry it is blocked by.
- Every entry needs a `tempId` so that it can be referenced, and so that a re-run of this agent
  recognises the sub-issues it already created.

## Size

- A request that fits one focused, reviewable pull request is ONE Story — do not split it.
- Split only into entries that each merge on their own with the build and tests green, each
  delivering something testable. Follow a structure the request already gives (milestones, phases).
- Prefer fewer, meaningful entries over many tiny ones.

## Existing work

`existing_stories.json` lists the sub-issues this issue already has (a previous run may have
created them); `existing_epics.json` is empty. Do not plan an existing sub-issue again — a new
entry with the same summary is matched to it instead of being created.

## Markup

Description files and `outputs/comment.md` are GitHub-flavored Markdown: `##`/`###` headings,
`- ` bullets, `**bold**`, fenced code blocks. Never Jira wiki markup (`h3.`, `{code}`, `[text|url]`).
In a description, refer to another entry of this run by its summary ("builds on the order model
story"), never by an issue number — the numbers do not exist yet.
