# Investigate Before Proposing a Solution

**Before writing any solution design, investigate the existing codebase.**

Use CodeGraph first for source-code investigation (`codegraph context "<solution area>"`, `codegraph query`, `codegraph callers`, `codegraph impact`) to:
1. Locate components (classes, services, modules, UI) related to the story domain.
2. Understand the current data model and integration patterns.
3. Identify existing automation and test coverage that may be affected.

Use `grep`, `find`, `cat`, or `sed` only after CodeGraph when you need literal text, file listing, or a specific file excerpt.

Only propose new components or patterns when the existing codebase genuinely does not satisfy the requirement. Where existing code can be extended or reused, prefer that approach and justify the decision explicitly in the solution.
