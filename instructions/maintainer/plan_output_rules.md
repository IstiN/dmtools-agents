```mermaid
flowchart TD
    subgraph OUTPUTS["Required outputs for the maintainer plan phase"]
        O1["outputs/maintainer-findings.md — write FIRST, update as you learn"]
        O2["outputs/maintainer-plan.md — the structural plan for approval"]
        O3["outputs/blocked.json — only if input is contradictory or insufficient"]
    end

    subgraph FINDINGS["maintainer-findings.md — per finding"]
        F1["**Symptom**: what degraded, observed where"]
        F2["**Structural root cause**: file, symbol, line + short quote"]
        F3["**Why it keeps producing bugs**: the mechanism, not the instance"]
        F4["**Target structure**: what the fixed shape looks like"]
        F5["**Unrepresentability mechanism**: what makes this class impossible afterwards"]
        F6["**Risk**: what the change can break, and what watches for it"]
        F1 --> F2 --> F3 --> F4 --> F5 --> F6
    end

    subgraph PLAN["maintainer-plan.md format"]
        P1["Header: scope window (commits/dates analyzed), signals consumed (gate reports, issue cluster)"]
        P2["Numbered steps in execution order; mark the landable milestone groups:<br/>action, files touched, what dies, what moves"]
        P3["Deletions list: guards, copies, single-caller helpers, dead flags"]
        P4["Test changes: what gets updated, what gets deleted, what new property tests appear"]
        P5["Risks + verification: what watches for breakage"]
        P1 --> P2 --> P3 --> P4 --> P5
    end

    OUTPUTS --> FINDINGS
    OUTPUTS --> PLAN
```

## STOP contract (plan phase)

The plan phase writes **zero source files**. The only writes are:
`outputs/maintainer-findings.md`, `outputs/maintainer-plan.md`,
`outputs/blocked.json` (when applicable), and the ticket comment. No branch,
no commits, no PR — the fixes run in the execute leg
(`maintainer_execute.json`) after the owner approves.

## Ticket comment format

GitHub-Flavored Markdown. Structure:

1. **What degraded** — the change window and the observed symptoms (from the
   case card and your own analysis).
2. **Findings** — condensed table: finding → structural root cause →
   unrepresentability mechanism. Full evidence lives in
   `maintainer-findings.md`.
3. **The plan** — the numbered steps, verbatim from `maintainer-plan.md`.
4. **Risks** — what can break and what watches for it.
5. **The ask** — one closing line: approve to execute (edit the plan freely —
   the owner's edited version wins); the execute leg runs on the
   `ai_maintainer_execute` label.

## Findings discipline

- Every finding carries evidence: file, symbol, line, and a short quote. A
  finding without evidence is an opinion — cut it or go find the evidence.
- Findings name classes, not instances: "single-caller helpers extracted to
  dodge the duplication gate" is a class; one helper is an instance.
- Theoretical problems are in scope when they have a structural root cause
  and a nameable unrepresentability mechanism. Style preferences are not.
