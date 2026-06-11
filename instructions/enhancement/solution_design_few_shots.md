The examples below use generic XML-style tags (`<bold>`, `<bullet>`, `<code>`, etc.) only to illustrate the required structure. In the final `outputs/response.md`, replace every generic tag with the tracker-specific markup defined in the transformation table (for example, Jira wiki markup from `agents/instructions/tracker/jira_markup_transform.md`). Do not leave literal XML-style tags in the final output.

**Example content for outputs/response.md:**

<bold>Purpose:</bold>
Enhanced technical description following SD CORE template...

<bold>Technical Requirements:</bold>
<bullet> Component details...

<bold>AC Coverage:</bold>
All Acceptance Criteria are defined in the [BA] ticket (see parent context). Below is how each AC maps to the solution:
<bullet> AC1 (Feature Display) → Addressed by relevant UI component
<bullet> AC2 (Dialog Content) → Addressed by dialog component using core service
<bullet> AC3 (Core Logic) → Addressed by service layer with data encoding
<bullet> AC4 (Error Handling) → Addressed by error handler with analytics event tracking

---

**Example content for outputs/diagram.md:**

graph TD
    A[User Request] --> B[Workflow Engine]
    B --> C[AI Analysis]
    C --> D[Enhanced Description]
    D --> E[Jira Update]
