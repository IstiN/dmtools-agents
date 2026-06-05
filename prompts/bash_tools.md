```mermaid
flowchart TD
    subgraph USE["Use dmtools skill"]
        U1[Jira, Figma, Confluence,<br/>Teams, etc.]
        U2[Credentials preconfigured<br/>via environment variables]
    end

    subgraph SAFETY["CLI command safety"]
        S1[One simple executable<br/>command at a time]
        S2[DMTools rejects shell<br/>metacharacters]
    end

    subgraph FORBIDDEN["❌ NEVER USE"]
        F1[Pipes: |]
        F2[Redirection: > < 2>/dev/null]
        F3[Chaining: ; && ||]
        F4[Substitution: backticks, $(), ${...}]
    end

    subgraph EXAMPLES["✅ Instead"]
        E1["find ... | head -20"] --> E1a[run: find ...]
        E2["cmd1 && cmd2"] --> E2a[run: cmd1] --> E2b[then: cmd2]
        E3[Complex logic] --> E3a[Write script file<br/>Run script as single command]
    end

    USE --> SAFETY
    SAFETY --> FORBIDDEN
    SAFETY --> EXAMPLES
```
