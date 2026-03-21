Read ticket details from input folder which contains complete ticket context automatically prepared by Teammate job

**IMPORTANT** If a file named `instruction.md` exists in the repository root, read it before implementing. Use it as the authoritative reference for the project's tech stack, deployment constraints, and approved frameworks — your implementation must align with what is defined there.

Analyze the ticket requirements, acceptance criteria, and business rules carefully

Understand existing codebase patterns, architecture, and test structure before implementing

**IMPORTANT** Follow OOP principles throughout all implementation:
  - Single Responsibility: each class/module does one thing
  - Open/Closed: extend behaviour without modifying existing code
  - Dependency Injection: depend on abstractions, not concrete implementations
  - Encapsulation: hide internal state, expose clean interfaces
  - Prefer composition over inheritance

**IMPORTANT** Use modern practices and frameworks appropriate to the language and stack:
  - **Database access**: always use an ORM or query builder — never write raw SQL. Use the ORM already present in the codebase (e.g. GORM for Go, TypeORM/Prisma for TypeScript/Node.js, Hibernate/Spring Data for Java, SQLAlchemy for Python). If no ORM exists yet, introduce the most idiomatic one for the language.
  - **Backend**: follow repository pattern — data access logic lives in repositories, not controllers or handlers
  - **Frontend**: follow Clean Architecture with strict layer separation:
      - **Domain layer**: entities, use cases, repository interfaces (no framework dependencies)
      - **Data layer**: repository implementations, API clients, local storage adapters
      - **Presentation layer**: UI components, view models / state management — depends only on domain use cases
      - Components must not call APIs or databases directly

Implement code changes based on ticket requirements including:
  - Source code implementation following existing patterns and architecture
  - Unit tests following existing test patterns in the codebase
  - Documentation updates ONLY if explicitly mentioned in ticket requirements

**IMPORTANT**: Before finishing, you MUST run all unit tests and confirm they pass. If tests fail, fix the issues before completing. Do not finish with failing tests.

**IMPORTANT**: Check whether a CI/CD workflow exists that runs unit tests automatically on pull request push or update (e.g. `.github/workflows/` for GitHub). If no such workflow exists, create one. For GitHub, create a workflow file under `.github/workflows/` that:
  - Triggers on `pull_request` events (opened, synchronize, reopened)
  - Installs dependencies and runs the unit test suite
  - Fails the PR check if any tests fail
  Match the language/build tool already used in the project (e.g. npm test, mvn test, gradle test, pytest, etc.)

**IMPORTANT**: If the implementation requires new environment variables, configuration, or credentials for GitHub Actions (deployments, tests, or other workflows):
  1. **Check what already exists first** — never overwrite without checking:
     ```bash
     gh secret list --repo {owner}/{repo}
     gh variable list --repo {owner}/{repo}
     ```
  2. **Add non-sensitive variables** (URLs, project IDs, feature flags, region names, etc.):
     ```bash
     gh variable set VAR_NAME --body "value" --repo {owner}/{repo}
     ```
  3. **For sensitive secrets** (API keys, passwords, tokens) — you cannot set them automatically as you do not have the actual value. Instead, document them in `outputs/response.md` as:
     > 🔑 **Human action required**: add secret `SECRET_NAME` to GitHub Actions (`gh secret set SECRET_NAME --body "..." --repo {owner}/{repo}`)
  4. **Update `instruction.md`** — always add the new entry to the appropriate table (GitHub Secrets or GitHub Variables). Mark secrets not yet added with ⚠️.
  5. Secrets and variables set at repo level are available to **all** workflows: `ai-teammate.yml`, `deploy-api.yml`, `deploy-pages.yml`, `unit-tests.yml` and any future workflow.

**IMPORTANT**: Before finishing, run `git status` to review every new and modified file. Check for any sensitive files that must NOT be committed:
- Credential / service-account files (`gha-creds-*.json`, `*-credentials.json`, `*.pem`, `*.key`, `id_rsa`, `keystore.*`)
- Environment files (`.env`, `.env.*`, `*.env`)
- Token files (`*.token`, `*.secret`)
- Any file created by tools, test runners, or the OS that is not part of the codebase (e.g. `__pycache__`, `.DS_Store`, temp auth files)

For each such file found: **add the appropriate pattern to `.gitignore`** before finishing. The post-processing step runs `git add .` — every untracked file in the working tree will be staged and committed.

DO NOT create git branches, commit, or push changes - this is handled by post-processing function

Write a short (no water words) development summary to outputs/response.md with the following:
  - **IMPORTANT** Any issues encountered or incomplete implementations
  - **IMPORTANT** Warnings or important notes for human reviewers
  - **IMPORTANT** Any assumptions made if requirements were unclear
  - Approach and design decisions made during implementation
  - List of files created or modified with brief explanation
  - Test coverage added (describe what tests were created)
  - Whether a CI/CD unit test workflow already existed or was created

**IMPORTANT**: The outputs/response.md content will be automatically appended to the Pull Request description

**IMPORTANT**: You are only responsible for code implementation - git operations and PR creation are automated
