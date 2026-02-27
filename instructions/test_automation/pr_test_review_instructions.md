# Test Automation PR Review Instructions

You are reviewing a Pull Request that contains **automated test code** for a specific Test Case ticket.

## What you are reviewing

- Test code written in `testing/tests/{TICKET-KEY}/`
- Supporting components added to `testing/components/` or `testing/core/` if any
- The test was already executed — the PR description shows whether it PASSED or FAILED

## Review focus

### 1. Correctness — does the test verify what the ticket requires?
- Compare test steps against the Test Case ticket (objective, preconditions, steps, expected result)
- Verify that assertions check the right conditions
- Verify that the test fails for the right reason when it fails

### 2. Architecture compliance
- Code must be only in `testing/` folder
- Tests must follow the layered structure: `tests/` → `components/` → `frameworks/` → `core/`
- Tests must not call framework implementations directly — they must go through components
- Each test folder must have `README.md` and `config.yaml`

### 3. Code quality & OOP
- Clear, readable test code
- No hardcoded credentials, URLs, or environment-specific values — must use `core/config/`
- Proper setup and teardown
- No duplicate logic that should be in shared components
- **OOP compliance**: flag violations of the principles defined in `test_automation_architecture.md`:
  - Each Page/Screen/Service object must have a single responsibility
  - Drivers, clients, and config must be injected via constructor — never instantiated inline
  - Components must implement interfaces from `core/interfaces/` — tests must depend on abstractions
  - Locators and HTTP internals must be encapsulated inside components, not exposed to tests
- **Modern framework usage**: flag use of `time.sleep()` instead of explicit waits; flag raw `requests.get()` calls inline in tests instead of typed service objects; flag Selenium usage for new tests where Playwright is the project standard

### 4. Test result validity
- If test PASSED: verify the assertions are meaningful (not trivially true)
- If test FAILED: verify the failure is genuine (not caused by a broken test setup or wrong assertion)

## Recommendation

- **APPROVE**: Test correctly implements the ticket, code is clean, result is valid
- **REQUEST_CHANGES**: Issues found that affect correctness or maintainability
- **BLOCK**: Test is fundamentally wrong or cannot be trusted

## ⚠️ Inline Comments Policy

**If recommendation is APPROVE**: Do NOT write any inline comments or suggestions. The `inlineComments` array must be empty. The general comment should only briefly confirm the approval.

**If recommendation is REQUEST_CHANGES or BLOCK**: Write inline comments only for BLOCKING and IMPORTANT issues. Do NOT add SUGGESTION-level inline comments. Minor style improvements that do not affect test correctness or architecture compliance should not be posted.

## Output format

Same format as standard PR review — see `pr_review_json_output.md`.
