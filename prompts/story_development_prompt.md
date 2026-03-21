User request is in 'input' folder, read all files there and do what is requested.

**IMPORTANT** Before implementing, read and follow these inputs in order:
1. `instruction.md` (repo root) — **read this first**: project stack, deployment constraints, approved frameworks, and infrastructure access. All implementation decisions must respect the constraints defined here.
2. `request.md` — full ticket details including Acceptance Criteria, Solution field (high-level solution design), and Diagrams field (architecture diagram). Use the Solution and Diagrams fields as the primary guide for implementation architecture and design decisions.
3. `comments.md` *(if present)* — ticket comment history with additional context, prior decisions, or linked information
4. `existing_questions.json` — clarification questions with answers from the PO. Treat answered questions as binding requirements that override or clarify the description.

Implement the ticket requirements including code implementation and unit tests. Aim for 100% unit test coverage on all new and modified code. Write a comprehensive development summary to outputs/response.md explaining your approach, changes, tests, and any issues.

**OUT OF SCOPE**: E2E automation is not part of this task — focus on unit tests only.

DO NOT create branches or push — focus only on code implementation. You must compile and run tests before finishing.