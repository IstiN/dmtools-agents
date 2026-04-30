# Review priorities

Check in this order:

1. The PR solves the ticket and all acceptance criteria.
2. No security issue is introduced.
3. The implementation is correct for edge cases and error states.
4. Tests cover new or changed behavior.
5. Avoid tests that do not assert meaningful behavior or are difficult to maintain.
6. Code follows existing architecture and project patterns.
7. No unnecessary or out-of-scope changes are included.

When a defect pattern appears multiple times in the diff, report all instances in one pass.
