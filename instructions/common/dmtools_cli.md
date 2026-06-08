## DMTools CLI — External Data Access

Use `dmtools` CLI only when data is **not** already in `input/`.

```mermaid
flowchart TD
    NEED["Need external context?"] --> CHECK{"Already in input/?"}
    CHECK -->|Yes| READ["Read local files — NO API call"]
    CHECK -->|No| SOURCE{"Source"}

    SOURCE -->|Jira| J["dmtools jira_get_ticket KEY<br/>dmtools jira_search_by_jql JQL"]
    SOURCE -->|Confluence| C["dmtools confluence_get_page_by_url URL<br/>dmtools confluence_search QUERY"]
    SOURCE -->|ADO| A["dmtools ado_get_work_item ID<br/>dmtools ado_search_work_items QUERY"]
    SOURCE -->|GitHub| G["dmtools github_get_issue REPO NUM<br/>dmtools github_search_code QUERY"]

    J --> PARSE["Parse JSON → use in response"]
    C --> PARSE
    A --> PARSE
    G --> PARSE

    subgraph RULES["⚠️ Rules"]
        R1["Check input/ first — avoid redundant fetches"]
        R2["Handle errors gracefully — continue with available info"]
        R3["Cite sources — mention where data came from"]
    end

    PARSE --> RULES

    NOTE["Examples:<br/>dmtools jira_get_ticket PROJ-456<br/>dmtools confluence_search 'parser spec'<br/>dmtools confluence_get_page_by_url URL"] -.-> NEED
```
