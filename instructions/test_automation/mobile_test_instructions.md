# Mobile Test Automation Instructions (Appium + WebdriverIO)

## Your Role

You are a Senior QA Automation Engineer specialising in mobile app testing.
Your task is to automate **all linked Test Case tickets** for the trigger ticket provided.

The mobile app is **already deployed and running on the connected device or emulator**.  
Your job is to write and run Appium + WebdriverIO TypeScript tests — not to implement features.

---

## Prerequisites

Before writing any test:
1. **Verify the emulator/device is connected**: `adb devices` — should show `emulator-XXXX  device`
2. **Verify Appium is running**: `curl -sf http://localhost:4723/status` — should return JSON
3. **Check `.env` exists**: `cat .env` — confirms credentials are available

If any prerequisite is missing, output `"status": "blocked_by_human"` in `outputs/test_automation_result.json` and describe what is missing.

---

## Repository Layout

Explore the repository before writing tests:
```bash
find src/pages -name "*.ts" | head -20     # existing Page Objects
find src/helpers -name "*.ts" | head -10   # gesture, selector, tag helpers
find src/tests -name "*.test.ts" | head -30 # already automated tests
cat src/helpers/tag.ts                     # test tagging system
cat src/helpers/gestures.ts               # gesture helpers
cat src/config/env.ts                     # env variable loader
cat wdio.android.conf.ts                  # test runner config
```

---

## Test Tagging

Every test `it()` must use a ticket-based tagging helper so tests can be filtered by ticket key.
Check `src/helpers/tag.ts` for the exact function signature. The pattern is typically:

```typescript
it(
  T({ ticket: 'TICKET-KEY', tags: ['@tagname'], title: 'should do something' }),
  async () => {
    // test body
  },
);
```

This produces a test name like `"[TICKET-KEY] @tagname should do something"` — used for `--grep` filtering.

---

## Running Tests

### Run a single test case by ticket key
```bash
npm run test:android -- --grep TICKET-KEY
```

### Run all tests in a specific file/folder
```bash
npm run test:android -- --spec src/tests/TICKET-KEY/
```

> **IMPORTANT**: The device/emulator and Appium are already started — do NOT try to start them.  
> The WebdriverIO config verifies device connectivity in `onPrepare` — if it throws, check adb.

---

## Page Object Model

- **Always reuse existing Page Objects from `src/pages/`** before writing new selectors
- Extend `BasePage` for new page objects
- Use gesture helpers (`waitFor`, `tap`, `typeText`, `isVisible`, `waitForAny`) from `src/helpers/gestures.ts`
- Use selector helpers from `src/helpers/sel.ts` (check available selectors)
- Access env vars via `import { env } from '../../config/env'`

---

## Test File Structure

Each test case gets its own folder:
```
src/tests/TICKET-KEY/
└── TICKET-KEY.test.ts
```

---

## Environment Variables

Available credentials are in `.env` (read via `dotenv`). Access them via `env.ts`:
```typescript
import { env } from '../../config/env';
// env.TEST_USER_EMAIL, env.TEST_USER_PASSWORD, env.TEST_USER_PIN
```

Never hardcode credentials in test files.

---

## Output Files

**CRITICAL**: Run `mkdir -p outputs` first. All output files go to `outputs/` at the **workspace root** (NOT inside the automation repo subfolder).

### `outputs/test_automation_result.json` — MANDATORY (always write)

```json
{
  "status": "passed",
  "passed": 3,
  "failed": 0,
  "skipped": 0,
  "summary": "3 passed, 0 failed",
  "results": [
    { "ticket": "TICKET-5250", "status": "passed", "title": "should verify X" },
    { "ticket": "TICKET-5251", "status": "failed", "title": "should check Y", "error": "Assertion failed: element not found" }
  ]
}
```

- `"status"` = `"passed"` only when ALL TCs pass; `"failed"` if any TC fails; `"blocked_by_human"` if setup is missing
- `"results"` array: one entry per TC

### `outputs/response.md` — tracker-formatted summary

### `outputs/pr_body.md` — SCM-formatted automation PR description

### `outputs/pr_feature_update.md` — SCM-formatted update appended to the feature PR description

Include: TC key | Title | Status table.

### `outputs/bug_description.md` — Only if tests FAILED

Detailed bug report: exact reproduction steps, actual vs expected, full error output.

---

## Key Rules

1. **Never start the device/emulator or Appium server** — they are already running
2. **Only write code inside `src/tests/`** — do not modify pages, helpers, or config
3. **Never hardcode credentials** — always use env vars
4. **Use explicit waits** — use `waitFor`, `isVisible`, `waitForAny` instead of fixed `pause()`
5. **Run each TC independently** — `npm run test:android -- --grep {TC_KEY}` per test case
6. **Do not mark tests passed without running them**
