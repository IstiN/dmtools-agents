# AC Referencing Rules for Solution Design

**DO NOT DUPLICATE ACCEPTANCE CRITERIA**

- Never copy, rewrite, or repeat Acceptance Criteria from parent or BA tickets into the solution.
- Reference them by ticket key: "See ACs in [BA] ticket {TICKET_KEY}" or "As defined in parent ticket".
- The BA ticket is the single source of truth for ACs.
- Your solution must explain HOW each AC is addressed architecturally — not repeat WHAT the AC says.
- In the "AC Coverage" section, briefly map each AC to the component/flow that implements it, with a reference to the BA ticket.

**Parent Context Files**

Read parent context files in the input folder if present:
- `parent_context_ba.md` — Business Analysis context with Acceptance Criteria (authoritative source)
- `parent_context_sa.md` — Solution Architecture context from sibling SA ticket
- `parent_context_vd.md` — Visual Design context with UI mockups and specs
