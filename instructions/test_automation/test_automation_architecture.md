# Test Automation Architecture

## High-Level Structure

```
testing/
│
├── core/                           # Shared across ALL test types
│   ├── models/                     # Domain models (User, Product, Order...)
│   ├── config/                     # Environment configs, credentials
│   ├── interfaces/                 # Abstract contracts (protocols)
│   ├── utils/                      # Helpers, data generators, logging
│
├── frameworks/                     # Framework-specific implementations
│   │
│   ├── web/                        # Web UI Testing
│   │   ├── playwright/
│   │   ├── selenium/
│   │   └── cypress/
│   │
│   ├── mobile/                     # Mobile Testing
│   │   ├── appium/
│   │   ├── xcuitest/               # iOS native
│   │   └── espresso/               # Android native
│   │
│   └── api/                        # API Testing
│       ├── rest/                   # REST clients (requests, httpx)
│       ├── graphql/
│       ├── grpc/
│       └── karate/
│
├── components/                     # Reusable test components
│   │
│   ├── pages/                      # Page Objects (Web)
│   │   ├── login_page
│   │   ├── checkout_page
│   │   └── ...
│   │
│   ├── screens/                    # Screen Objects (Mobile)
│   │   ├── login_screen
│   │   ├── home_screen
│   │   └── ...
│   │
│   └── services/                   # API Service Objects
│       ├── auth_service
│       ├── order_service
│       └── ...
│
├── tests/                          # Actual test cases by ticket/story
│   ├── TEST-1/
│   ├── TEST-2/
│   └── TEST-3/
│
└── fixtures/                       # Shared test fixtures & data
    ├── users/
    ├── products/
    └── ...
```

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                  TESTS                                       │
│                                                                              │
│    ┌──────────────┐      ┌──────────────┐      ┌──────────────┐            │
│    │   STORY-123  │      │   STORY-456  │      │   STORY-789  │            │
│    │   ─────────  │      │   ─────────  │      │   ─────────  │            │
│    │  TEST-1 (web)│      │ TEST-4 (api) │      │TEST-7 (mobile)│           │
│    │  TEST-2 (api)│      │ TEST-5 (web) │      │ TEST-8 (web) │            │
│    │TEST-3(mobile)│      │TEST-6(mobile)│      │ TEST-9 (api) │            │
│    └──────┬───────┘      └──────┬───────┘      └──────┬───────┘            │
│           │                     │                     │                     │
└───────────┼─────────────────────┼─────────────────────┼─────────────────────┘
            │                     │                     │
            ▼                     ▼                     ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              COMPONENTS                                      │
│                        (Reusable Test Objects)                              │
│                                                                              │
│   ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐            │
│   │     PAGES       │  │    SCREENS      │  │    SERVICES     │            │
│   │   (Web UI)      │  │   (Mobile)      │  │     (API)       │            │
│   │                 │  │                 │  │                 │            │
│   │  • LoginPage    │  │ • LoginScreen   │  │ • AuthService   │            │
│   │  • CartPage     │  │ • HomeScreen    │  │ • OrderService  │            │
│   │  • CheckoutPage │  │ • CartScreen    │  │ • UserService   │            │
│   └────────┬────────┘  └────────┬────────┘  └────────┬────────┘            │
│            │                    │                    │                      │
└────────────┼────────────────────┼────────────────────┼──────────────────────┘
             │                    │                    │
             ▼                    ▼                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                             FRAMEWORKS                                       │
│                    (Technology Implementations)                              │
│                                                                              │
│  ┌───────────────────┐ ┌───────────────────┐ ┌───────────────────┐         │
│  │        WEB        │ │      MOBILE       │ │        API        │         │
│  │                   │ │                   │ │                   │         │
│  │  ┌─────────────┐  │ │  ┌─────────────┐  │ │  ┌─────────────┐  │         │
│  │  │ Playwright  │  │ │  │   Appium    │  │ │  │    REST     │  │         │
│  │  └─────────────┘  │ │  └─────────────┘  │ │  └─────────────┘  │         │
│  │  ┌─────────────┐  │ │  ┌─────────────┐  │ │  ┌─────────────┐  │         │
│  │  │  Selenium   │  │ │  │  XCUITest   │  │ │  │   GraphQL   │  │         │
│  │  └─────────────┘  │ │  └─────────────┘  │ │  └─────────────┘  │         │
│  │  ┌─────────────┐  │ │  ┌─────────────┐  │ │  ┌─────────────┐  │         │
│  │  │   Cypress   │  │ │  │  Espresso   │  │ │  │   Karate    │  │         │
│  │  └─────────────┘  │ │  └─────────────┘  │ │  └─────────────┘  │         │
│  └───────────────────┘ └───────────────────┘ └───────────────────┘         │
│                                                                              │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                               CORE                                           │
│                    (Framework-Agnostic Foundation)                          │
│                                                                              │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐            │
│  │   MODELS   │  │  CONFIGS   │  │ INTERFACES │  │   UTILS    │            │
│  │            │  │            │  │            │  │            │            │
│  │ • User     │  │ • Env URLs │  │ • IBrowser │  │ • Logger   │            │
│  │ • Product  │  │ • Creds    │  │ • IDriver  │  │ • DataGen  │            │
│  │ • Order    │  │ • Timeouts │  │ • IClient  │  │ • Waiters  │            │
│  └────────────┘  └────────────┘  └────────────┘  └────────────┘            │
└────────────────────────────────────────────────────────────────────────────┘
```

## Layer Responsibilities

```
┌─────────────────────────────────────────────────────────────────┐
│  LAYER           │  RESPONSIBILITY                              │
├─────────────────────────────────────────────────────────────────┤
│                  │                                              │
│  TESTS           │  • Test logic per ticket/story              │
│                  │  • Uses components, not frameworks directly │
│                  │  • Contains test config (which framework)   │
│                  │                                              │
├─────────────────────────────────────────────────────────────────┤
│                  │                                              │
│  COMPONENTS      │  • Reusable Page/Screen/Service objects     │
│                  │  • Business-level abstractions              │
│                  │  • Framework-agnostic interfaces            │
│                  │                                              │
├─────────────────────────────────────────────────────────────────┤
│                  │                                              │
│  FRAMEWORKS      │  • Concrete implementations                 │
│                  │  • Playwright, Appium, REST clients         │
│                  │  • Wraps vendor libraries                   │
│                  │                                              │
├─────────────────────────────────────────────────────────────────┤
│                  │                                              │
│  CORE            │  • Shared models & configs                  │
│                  │  • Abstract interfaces/protocols            │
│                  │  • Utilities & reporting                    │
│                  │                                              │
└─────────────────────────────────────────────────────────────────┘
```

## Test Configuration Per Ticket

```
tests/TEST-1/
├── config.yaml          # Defines: framework, platform, dependencies
└── test_*.py            # Actual test file

Example config.yaml:
─────────────────────
test_id: TEST-1
type: web | mobile | api
framework: playwright | appium | rest
platform: chrome | ios | android
dependencies: [TEST-0]
```

## Cross-Platform Component Sharing

```
                        ┌─────────────────┐
                        │   Login Flow    │
                        │   (Business)    │
                        └────────┬────────┘
                                 │
           ┌─────────────────────┼─────────────────────┐
           │                     │                     │
           ▼                     ▼                     ▼
   ┌───────────────┐    ┌───────────────┐    ┌───────────────┐
   │   LoginPage   │    │  LoginScreen  │    │  AuthService  │
   │     (Web)     │    │   (Mobile)    │    │     (API)     │
   └───────┬───────┘    └───────┬───────┘    └───────┬───────┘
           │                    │                    │
           ▼                    ▼                    ▼
   ┌───────────────┐    ┌───────────────┐    ┌───────────────┐
   │  Playwright/  │    │    Appium/    │    │  REST/GraphQL │
   │   Selenium    │    │   XCUITest    │    │               │
   └───────────────┘    └───────────────┘    └───────────────┘
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