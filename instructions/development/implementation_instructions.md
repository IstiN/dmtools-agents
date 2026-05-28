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

**IMPORTANT** Use the project-approved language, framework, architecture, and tooling. If project or platform instruction files are provided, treat them as binding.

Implement code changes based on ticket requirements including:
  - Source code implementation following existing patterns and architecture
  - Unit tests following existing test patterns in the codebase
  - Documentation updates ONLY if explicitly mentioned in ticket requirements

**IMPORTANT**: Before finishing, you MUST run all unit tests and confirm they pass. If tests fail, fix the issues before completing. Do not finish with failing tests.

**IMPORTANT**: If CI/CD or repository-level configuration changes are required, follow the project-specific SCM/CI instructions. Do not assume a specific provider.

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
  - Whether CI/CD or repository configuration was changed

**IMPORTANT**: The outputs/response.md content will be automatically appended to the Pull Request description

**IMPORTANT**: You are only responsible for code implementation - git operations and PR creation are automated
