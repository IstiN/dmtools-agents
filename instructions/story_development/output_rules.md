```mermaid
flowchart TD
    O0["⚠️ COMPLETION GUARD — run BEFORE writing the PR description:<br/>git fetch origin main &amp;&amp; git log origin/main..HEAD --oneline<br/>— EMPTY result = your work did NOT land: re-do or resume it,<br/>do NOT write response.md and do NOT declare completion<br/>— Same guard before any 'no changes needed' conclusion:<br/>claimed changes MUST exist in the branch diff vs main,<br/>otherwise the claim is a session-memory hallucination"]
    O0 --> O1
    O1["Write outputs/response.md — concise PR description"]
    O2["Target length: under 20 lines. A reviewer should understand the change in under 30 seconds"]
    O3["Required sections:<br/>### What changed<br/>1-2 sentences describing the implementation"]
    O4["### Key decisions<br/>Bullet list of architectural or design choices"]
    O5["### How to verify<br/>Test command or verification steps"]
    O6["Optional: add a mermaid diagram inside &lt;details&gt; block summarizing the change"]
    O7["❌ NO verbose restatement of ticket requirements<br/>❌ NO water words or filler text"]
    O1 --> O2 --> O3 --> O4 --> O5 --> O6 --> O7
```
