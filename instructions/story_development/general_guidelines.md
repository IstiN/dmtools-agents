```mermaid
flowchart TD
    START([Story ticket ready for development]) --> READ_INPUT["⚠️ MANDATORY: Read ALL input files FIRST — see instructions/common/input_context_reading.md"]
    READ_INPUT --> PARENT["Read parent epic context if present:<br/>- input/TICKET/parent_context_ba.md — business rules<br/>- input/TICKET/parent_context_sa.md — technical design<br/>- input/TICKET/parent_context_vd.md — visual design"]
    PARENT --> ANALYZE["Analyze requirements — every acceptance criterion must be addressed"]
    ANALYZE --> ARCH["Understand existing codebase patterns, architecture, and test structure"]
    ARCH --> PRINCIPLES["Apply OOP principles: SRP, OCP, DI, Encapsulation, Composition over inheritance"]
    PRINCIPLES --> TDD["Follow TDD approach — see the TDD approach section included later in this prompt"]
    TDD --> TEST_LOC["Write TDD tests in the repository's existing unit-test tree only<br/>— discover the path from build/test config and nearby tests<br/>— NEVER in testing/ (owned by test-automation agents)"]
    TEST_LOC --> IMPLEMENT["Implement source code and unit tests following existing patterns"]
    IMPLEMENT --> DOCS["Update documentation ONLY if ticket explicitly requires it"]
    DOCS --> RUN["Run all unit tests — MUST pass before finishing"]
    RUN --> PASS{Tests pass?}
    PASS -->|No| FIX["Fix failures and re-run tests"]
    FIX --> RUN
    PASS -->|Yes| POSTCHECK{"Integration readiness check:<br/>does the feature depend on external setup<br/>the repo does not contain?"}
    POSTCHECK -->|Gaps found| CONCERNS["Write outputs/concerns.md:<br/>what is missing + what is needed to make it work"]
    CONCERNS --> GITSTATUS["Run git status and review every new/modified file"]
    POSTCHECK -->|Self-sufficient| GITSTATUS["Run git status and review every new/modified file"]
    GITSTATUS --> SECRETS{Sensitive or untracked non-code files present?}
    SECRETS -->|Yes| IGNORE["Add appropriate patterns to .gitignore"]
    SECRETS -->|No| GUARD["⚠️ COMPLETION GUARD — prove work landed BEFORE writing the summary:<br/>git fetch origin &amp;&amp; git log &quot;origin/$(git rev-parse --abbrev-ref origin/HEAD | cut -d/ -f2)..HEAD&quot; --oneline<br/>EMPTY result = work did NOT land — re-do or resume the work,<br/>NEVER report done from session memory or the base branch's tip"]
    IGNORE --> GUARD
    GUARD -->|Diff shows your commits| SUMMARY["Write concise PR description to outputs/response.md — see output_rules.md"]
    GUARD -->|Empty diff| REDO["Re-do or resume the work — verify the working dir,<br/>git log, git stash list.<br/>If the fix is genuinely already on the base branch,<br/>prove it (git log &quot;origin/$(git rev-parse --abbrev-ref origin/HEAD | cut -d/ -f2)&quot; --grep=...) before any<br/>'no changes needed' conclusion"]
    REDO --> IMPLEMENT
    SUMMARY --> END([End — post-processing handles branch, commit and PR])
```

Before finishing, run the COMPLETION POST-CHECK — see `instructions/common/completion_post_check.md`.
