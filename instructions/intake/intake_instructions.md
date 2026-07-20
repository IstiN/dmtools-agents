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
        T3c["Structure: Goal → Scope → Out of scope → Notes"]
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
        R9["iOS reference codebase is the sole source of truth for scope. Decompose from iOS features, not from what Android already has. Similar-looking Android code is NEVER evidence an iOS feature is done — always create/keep the story for that iOS feature so a downstream dev/verification agent independently confirms real completeness. If the project has BMAD tracking artifacts (sprint-status.yaml, deferred-work.md, per-story files), treat their recorded status as ground truth and cross-check every 'already implemented' claim against them before asserting a feature works"]
    end

    INPUTS --> TASK
    TASK --> E2E
    E2E --> RULES
```
