```mermaid
flowchart TD
    subgraph MANDATE["⚠️ MANDATORY: actively investigate before writing ANY discovery output"]
        M1["A ticket with 1-2 lines of description is a STARTING POINT for research, not the whole input — restating it back is NOT discovery"]
        M2["Topic/technology/competitor mentioned (e.g. a tool, framework, product, 'analogs of X')? → fetch/browse real external sources about it before writing anything"]
        M3["Feature/integration/system mentioned that plausibly exists in this codebase? → codegraph context '<topic>' + codegraph query, read the actual files returned"]
        M4["Confluence/URL mentioned or linked from the ticket? → fetch and read it, don't just note that it exists"]
        M5["Only AFTER investigating: separate verified findings (with source/citation) from genuine open questions (things no source answered)"]
    end

    MANDATE --> QUALITY["A discovery pass that only echoes the ticket's own words back is a FAILED discovery pass — treat it as incomplete and keep investigating"]
```

## What "investigate" means per mode

- **Opportunity assessment / domain brief / source distill**: if the ticket references a named technology, product, tool, competitor, or external concept (e.g. "analogs of X", "integrate with Y", "similar to Z"), you MUST look it up — use available web-fetch/browsing tool access to find real, current information about it (what it is, alternatives, how others use it, pricing/licensing if relevant, technical constraints). Summarize what you found with a citation (URL), not "TBD — could not research."
- **Discovery plan / AS IS-TO BE / mapping / PRD**: if the ticket references an existing system, integration, or codebase area, use CodeGraph (`codegraph context "<topic>"`, `codegraph query`, `codegraph callers`, `codegraph impact`) to find and read the actual relevant source before describing current behavior — do not guess or leave it TBD if the codebase already has the answer.
- **Any mode**: if the ticket or its comments link to a Confluence page, external doc, or spec, fetch it and read it — do not just cite its existence.

## No invention vs. no investigation — these are different rules

"No invention" (see general_guidelines.md) means: **do not fabricate business decisions, user personas, metrics, or requirements that no source actually states.** It does **not** mean "do the least possible research." A thin 1-2 line ticket is exactly the case where investigation matters most — the job is to go find out what's actually knowable (from the web, the codebase, linked docs) and only mark something TBD once you've genuinely looked and it's still unknown.

## Self-check before writing outputs/discovery/*.md

Before writing any file, ask: *"If I only read the ticket's own words back, would a reviewer say I actually did discovery?"* If the honest answer is no, go investigate more (web search/fetch, codegraph, linked docs) before writing.
