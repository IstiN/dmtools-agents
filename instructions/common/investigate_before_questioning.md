# Investigate Before Asking Questions

**Before raising any question, verify whether it can be answered by reading the codebase.**

Use CodeGraph first for source-code investigation (`codegraph context "<topic>"`, `codegraph query`, `codegraph callers`, `codegraph impact`). Use `grep`, `find`, `cat`, or `sed` only after CodeGraph when you need literal text, file listing, or a specific file excerpt. If the answer is discoverable from the code, note your finding and **skip the question entirely**.

Only raise a question when the information is genuinely absent from the codebase and requires a human decision or confirmation.
