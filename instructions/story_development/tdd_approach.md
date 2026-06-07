```mermaid
flowchart TD
    subgraph TDD["TDD — Test-Driven Development Workflow"]
        T0["Start with a clear understanding of the requirement"]
        T1["RED: Write a failing unit test FIRST<br/>— before any production code<br/>— test must describe the expected behavior<br/>— run it to confirm it FAILS"]
        T2["GREEN: Write minimum production code to make the test PASS<br/>— no over-engineering<br/>— simplest possible implementation"]
        T3["REFACTOR: Clean up code while keeping tests GREEN<br/>— improve naming, remove duplication<br/>— apply OOP principles<br/>— run tests after every change"]
        T4{"More requirements to implement?"}
        T5["Repeat RED-GREEN-REFACTOR for next behavior"]
        T0 --> T1 --> T2 --> T3 --> T4
        T4 -->|Yes| T5 --> T1
        T4 -->|No| DONE([All behaviors implemented with tests])
    end

    subgraph RULES["TDD Rules"]
        R1["❌ NEVER write production code without a failing test first"]
        R2["❌ NEVER write more production code than needed to pass the test"]
        R3["✅ Tests must be fast, isolated, and deterministic"]
        R4["✅ Aim for 100% unit test coverage on new and modified code"]
        R5["✅ Run the full test suite before finishing — no regressions allowed"]
    end

    TDD --> RULES
```
