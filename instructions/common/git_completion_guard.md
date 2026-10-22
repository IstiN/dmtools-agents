# Git Completion & Closing-Keyword Guard

- **Completion guard**: Before writing `outputs/response.md`, run `git fetch origin main && git log origin/main..HEAD --oneline`. An empty result means your commits did not land — re-do or resume the work before declaring completion.
- **No closing keywords in commits or PR bodies**: Do NOT include `Fixes #...`, `Closes #...`, or `Resolves #...` against tracker tickets unless explicitly instructed; ticket lifecycle transitions are managed by the post-action workflow.
