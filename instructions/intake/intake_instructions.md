```mermaid
flowchart TD
    subgraph INPUTS["Inputs"]
        I1["input/request.md — raw ticket description"]
        I2["input/existing_epics.json — {epics: [{key, summary, description, priority, diagrams, parent}]}"]
        I3["input/existing_stories.json — {stories: [{key, summary, status, priority, diagrams, parent}]}"]
    end

    subgraph TASK["Task"]
        T1["Read existing_epics.json & existing_stories.json fully"]
        T2["Analyze raw request — intent, themes, deliverables"]
        T3["Write description files"]
        T3a["Epics → outputs/stories/epic-N.md"]
        T3b["Stories → outputs/stories/story-N.md"]
        T3c["Structure: Goal → Scope → Out of scope → Notes<br/>⚠️ Use generic placeholder tags (see formatting_rules.md), NEVER raw Markdown — transform via tracker markup table before writing"]
        T4["Write outputs/stories.json — valid JSON array"]
        T5["Write outputs/comment.md — tracker-formatted summary"]
        T6["Bug request → type Bug, bug-N.md, no Epics/Stories"]
        T7["Too vague → explain in comment.md, write [] to stories.json"]
    end

    subgraph E2E["E2E User Journey Check"]
        E1["Entry point — clear homepage?"]
        E2["Navigation — reachable without direct URL?"]
        E3["App Shell — shared layout?"]
        E4["Auth gates — login vs public clear?"]
        E5["Happy path — core workflow complete end-to-end?"]
    end

    subgraph RULES["Rules"]
        R1["Validate JSON before finishing"]
        R2["Do not invent tracker keys"]
        R3["Check existing_stories.json to avoid duplicates"]
        R4["Summaries: concise, actionable, imperative"]
        R5["Stories: 1-2 sprints worth, split if needed"]
        R6["NO code, only analysis & structured content"]
        R7["Stories MUST be Testable: if autotest/integration coverage isn't realistic, don't create a separate story OR explicitly state 'no integration testing required — must be skipped, no test cases required, prerequisite story' (unit tests still required)"]
        R8["For existing/already-implemented features: verify they work correctly end-to-end AND are fully test-covered — code presence alone is not completion; gaps become their own Bug/Story"]
        R9["If the project defines an authoritative reference/target specification for scope (reference platform codebase, design spec, or PRD), that reference — not what the current codebase already appears to have — is the sole source of truth for decomposition. Existing code that merely looks similar to a reference feature is NEVER evidence that feature is done — always create/keep the story for that feature so a downstream dev/verification agent independently confirms real completeness. If the project has its own planning/tracking artifacts recording per-story/per-epic status and deferred/stubbed work (e.g. a sprint-status file, a deferred-work log, per-story files), treat their recorded status as ground truth and cross-check every 'already implemented' claim against them before asserting a feature works"]
        R10["NEVER create an Epic with zero child Stories in the same run. Every new Epic MUST be created together with at least its first actionable Stories in this same run — an Epic without Stories is not a valid output. If an Epic's full scope is too large to fully decompose in one pass, still create as many Stories as are known/actionable now, and explicitly list the remaining not-yet-decomposed slices in the Epic's own description Notes section — never leave the Epic itself as an empty placeholder"]
        R11["Before writing any description .md file: replace every generic placeholder tag with the tracker-specific markup from the transform table for this run's tracker (e.g. `agents/instructions/tracker/jira_markup_transform.md` for Jira). Never write literal placeholder tags or raw Markdown headings/bullets straight into a tracker description — same rule as `story_questions`"]
    end

    INPUTS --> TASK
    TASK --> E2E
    E2E --> RULES
```
