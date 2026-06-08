# Test Automation Architecture

## High-Level Structure

```mermaid
flowchart TD
    subgraph CORE["core/ — Framework-Agnostic Foundation"]
        C1[models/ User, Product, Order]
        C2[config/ Env, Creds, Timeouts]
        C3[interfaces/ IBrowser, IDriver, IClient]
        C4[utils/ Logger, DataGen, Waiters]
    end

    subgraph FW["frameworks/ — Concrete Implementations"]
        direction LR
        WEB[web/<br/>Playwright<br/>Selenium<br/>Cypress]
        MOB[mobile/<br/>Appium<br/>XCUITest<br/>Espresso]
        API[api/<br/>REST<br/>GraphQL<br/>gRPC]
    end

    subgraph COMP["components/ — Reusable Test Objects"]
        direction LR
        PAGES[pages/<br/>LoginPage<br/>CartPage]
        SCR[screens/<br/>LoginScreen<br/>HomeScreen]
        SVC[services/<br/>AuthService<br/>OrderService]
    end

    subgraph TESTS["tests/ — Per Ticket/Story"]
        T1[TEST-1/ config.yaml + test_*.py]
        T2[TEST-2/ config.yaml + test_*.py]
        T3[TEST-3/ config.yaml + test_*.py]
    end

    FX[fixtures/<br/>users/<br/>products/]

    CORE --> FW
    FW --> COMP
    COMP --> TESTS
    FX --> TESTS
```

## Architecture Diagram

```mermaid
flowchart BT
    subgraph TESTS_LAYER["TESTS"]
        T1["STORY-123<br/>TEST-1 (web)<br/>TEST-2 (api)"]
    end

    subgraph COMP_LAYER["COMPONENTS — Reusable Objects"]
        direction LR
        P[pages/ Web UI] --> S[screens/ Mobile] --> SV[services/ API]
    end

    subgraph FW_LAYER["FRAMEWORKS — Implementations"]
        direction LR
        W[web/] --> M[mobile/] --> A[api/]
    end

    subgraph CORE_LAYER["CORE — Framework-Agnostic"]
        direction LR
        MOD[models/] --> CFG[config/] --> IF[interfaces/] --> UT[utils/]
    end

    TESTS_LAYER --> COMP_LAYER
    COMP_LAYER --> FW_LAYER
    FW_LAYER --> CORE_LAYER
```

## Layer Responsibilities

```mermaid
flowchart LR
    TESTS["TESTS"] -->|"uses"| COMPONENTS["COMPONENTS"]
    COMPONENTS -->|"implements via"| FRAMEWORKS["FRAMEWORKS"]
    FRAMEWORKS -->|"built on"| CORE["CORE"]

    TESTS -. "• Test logic per ticket<br/>• Uses components only<br/>• Ticket-level config" .- TESTS
    COMPONENTS -. "• Page/Screen/Service objects<br/>• Business abstractions<br/>• Framework-agnostic" .- COMPONENTS
    FRAMEWORKS -. "• Playwright, Appium, REST<br/>• Wraps vendor libs" .- FRAMEWORKS
    CORE -. "• Models, Config, Utils<br/>• Abstract protocols" .- CORE
```

## Test Configuration Per Ticket

```yaml
# tests/TEST-1/config.yaml
test_id: TEST-1
type: web | mobile | api
framework: playwright | appium | rest
platform: chrome | ios | android
dependencies: [TEST-0]
```

## Cross-Platform Component Sharing

```mermaid
flowchart TD
    B[Login Flow<br/>Business Logic] --> W[LoginPage<br/>Web]
    B --> M[LoginScreen<br/>Mobile]
    B --> A[AuthService<br/>API]
    W --> PW[Playwright / Selenium]
    M --> AP[Appium / XCUITest]
    A --> REST[REST / GraphQL]
```

## Key Principles

| Principle | Description |
|-----------|-------------|
| **Separation** | Tests don't know about frameworks, only components |
| **Abstraction** | Components use interfaces, not concrete implementations |
| **Flexibility** | Easy to swap frameworks without changing tests |
| **Reusability** | Same business logic, different platforms |
| **Isolation** | Each test ticket has its own config and dependencies |

## OOP & Modern Practices

**Apply OOP throughout all test code:**
- **Single Responsibility** — each Page/Screen/Service object handles one domain area only
- **Dependency Injection** — pass drivers, clients, and config via constructor; never instantiate them inside components
- **Interfaces first** — all components implement contracts defined in `core/interfaces/`; tests depend on interfaces, not concrete classes
- **Encapsulation** — expose only high-level actions (e.g. `loginPage.loginAs(user)`), never raw selectors or HTTP internals

**Use modern, idiomatic frameworks:**
- **Web**: prefer Playwright over Selenium for new tests (async, reliable, built-in waits)
- **API**: use typed API clients with models — no raw `requests.get(url)` calls inline in tests
- **Mobile**: use Appium with Page Object Model; no hardcoded locators outside Screen classes
- **Assertions**: use framework-native matchers (e.g. `expect(locator).toBeVisible()`) — not manual boolean checks

**Test code quality:**
- No hardcoded URLs, credentials, or environment values — use `core/config/`
- No logic duplication — extract shared flows into components
- Tests must be deterministic: no `time.sleep()`, use explicit waits instead
