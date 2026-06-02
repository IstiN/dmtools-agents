# Investigate Before Answering

**Before providing any answer, recommendation, or content, investigate the relevant context.**

Use CodeGraph first for source-code investigation (`codegraph context "<topic>"`, `codegraph query`, `codegraph callers`, `codegraph impact`) and dmtools commands to:
1. Read the full ticket (`request.md`) and its comment history (`comments.md`).
2. Fetch the parent story for complete business context (run `dmtools jira_get_ticket PARENT-KEY` if needed).
3. Explore the existing codebase or documentation relevant to the question — do not rely solely on the ticket text. Use `grep`, `find`, `cat`, or `sed` only after CodeGraph when you need literal text, file listing, or a specific file excerpt.

Ground your answer in **verified facts** from the investigation. If the codebase or documentation contains an authoritative answer, cite it explicitly. Only state assumptions when information is genuinely absent.
