# Bash tools reference

- When navigating external services such as tracker/Jira, Figma, Confluence, Teams, or similar systems, use the `dmtools` skill available in this AI repository.
- Required service credentials and integration keys are preconfigured through environment variables.

## DMTools CLI command safety

When using DMTools `cli_execute_command`, pass only one simple executable
command at a time. DMTools intentionally rejects shell metacharacters to prevent
command injection.

Do not use:
- pipes: `|`
- redirection: `>`, `<`, `2>/dev/null`
- command chaining: `;`, `&&`, `||`
- command substitution: backticks, `$()`, `${...}`

Examples:
- Instead of `find testing -type f 2>/dev/null | head -20`, run
  `find testing -type f` and inspect the returned output.
- Instead of `cmd1 && cmd2`, run `cmd1`, then run `cmd2` only if needed.
- If complex shell logic is unavoidable, write a small script file first and run
  that script as the single command.
