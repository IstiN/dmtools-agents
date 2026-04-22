# Investigate Before Proposing a Solution

**Before writing any solution design, investigate the existing codebase.**

Use CLI tools (`find`, `ls`, `cat`, `grep`) to:
1. Locate components (classes, services, modules, UI) related to the story domain.
2. Understand the current data model and integration patterns.
3. Identify existing automation and test coverage that may be affected.

Only propose new components or patterns when the existing codebase genuinely does not satisfy the requirement. Where existing code can be extended or reused, prefer that approach and justify the decision explicitly in the solution.
