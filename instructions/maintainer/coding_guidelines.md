```mermaid
flowchart TD
    O1["⚠️ OVERRIDE — this file overrides instructions/common/coding_guidelines.md<br/>on maintainer legs"]
    O2["Structure is yours: restructure, extract, merge, rename freely<br/>WITHIN the approved plan scope — improving the structure is the mandate"]
    O3["Behavior is not: public behavior stays stable unless the plan says so explicitly"]
    O4["Style still binds: target repo AGENTS.md, formatter, naming conventions"]
    O5["Prefer deletion: the best structural fix deletes code —<br/>guards, copies, single-caller helpers, dead flags"]
    O6["A rule like 'interact with this only through that' is a confession:<br/>the fix is visibility or shape, so there is no other way left"]
    O1 --> O2 --> O3 --> O4 --> O5 --> O6
```

## Why this file exists

The common coding guidelines tell every dev leg to follow the existing
codebase patterns and never invent new ones. That rule is correct for
task-execution legs (surgical, minimal footprint) and wrong for maintainer
legs, whose mandate is structural improvement. On maintainer legs this file
takes precedence where the two disagree:

| Common rule | Maintainer leg |
|---|---|
| "Never invent new patterns when the codebase has an established way" | Applies to behavior and style only. Structure may change if the approved plan says so — that is the job. |
| "Follow existing codebase patterns" | Follow them for untouched code. Restructured code follows the target shape the approved plan defines, then the repo conventions. |

Everything the common file says about conventions, formatting, and
respecting `AGENTS.md` still binds — this override widens the structural
freedom, not the behavioral one.
