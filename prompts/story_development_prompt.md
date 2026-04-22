User request is in 'input' folder, read all files there and do what is requested.

**IMPORTANT** Before implementing, read and follow these inputs in order:
1. `instruction.md` (repo root) — **read this first**: project stack, deployment constraints, approved frameworks, and infrastructure access. All implementation decisions must respect the constraints defined here.
2. `request.md` — full ticket details including Acceptance Criteria, Solution field (high-level solution design), and Diagrams field (architecture diagram). Use the Solution and Diagrams fields as the primary guide for implementation architecture and design decisions.
3. `comments.md` *(if present)* — ticket comment history with additional context, prior decisions, or linked information
4. `existing_questions.json` — clarification questions with answers from the PO. Treat answered questions as binding requirements that override or clarify the description.
5. `parent_context_ba.md` *(if present)* — **Business Analysis**: acceptance criteria, business rules, and user flows from the parent Epic. This is the authoritative definition of what must be built — every AC must be addressed.
6. `parent_context_sa.md` *(if present)* — **Solution Architecture**: technical design, API contracts, data model, and architectural decisions from the parent Epic. Follow this design during implementation.
7. `parent_context_vd.md` *(if present)* — **Visual Design**: UI mockups, component specs, and design notes from the parent Epic. Align the implementation with the expected look and feel.

Implement the ticket requirements including code implementation and unit tests. Aim for 100% unit test coverage on all new and modified code.

**OUT OF SCOPE**: E2E automation is not part of this task — focus on unit tests only.

DO NOT create branches or push — focus only on code implementation. You must compile and run tests before finishing.

## BICE Project — Maven Build Commands

This is a Java/Maven project using the Cosmo test framework. **Always use `$JAVA_HOME_COSMO`** when running Maven (Java 17, pre-configured by the dependency setup).

**Verify build compiles cleanly** (run this first after any code change):
```bash
cd dependencies/PostNL-commercial/tests/cosmo && \
  JAVA_HOME=$JAVA_HOME_COSMO mvn install -DskipTests --no-transfer-progress 2>&1 | grep -E 'BUILD|ERROR'
```
Expected: `[INFO] BUILD SUCCESS`. If you see `[ERROR] COMPILATION ERROR`, fix compile errors before proceeding.

**Run unit tests** (replace `<ModuleName>` and `<TestClassName>` with the actual values):
```bash
cd dependencies/PostNL-commercial/tests/cosmo && \
  JAVA_HOME=$JAVA_HOME_COSMO mvn test -pl <ModuleName> -Dtest=<TestClassName> -Denforcer.skip=true \
  --no-transfer-progress 2>&1 | tail -30
```
Example for `cosmo-core`: `-pl cosmo-core`

**Run all unit tests in a module**:
```bash
cd dependencies/PostNL-commercial/tests/cosmo && \
  JAVA_HOME=$JAVA_HOME_COSMO mvn test -pl cosmo-core -Denforcer.skip=true \
  --no-transfer-progress 2>&1 | tail -30
```

Write `outputs/response.md` as the **PR description** (this will be published as the GitHub PR body — write technical detail here):
- Implementation approach and key decisions
- Summary of files changed and why
- How to verify the fix / test results

**Keep the PR description focused and technical** — avoid restating the ticket requirements verbatim. A developer reading the PR should immediately understand what was done and how to verify it.