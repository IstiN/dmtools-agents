```mermaid
flowchart TD
    START([Bug ticket ready for fix]) --> READ["⚠️ MANDATORY: Read ALL input files FIRST — see instructions/common/input_context_reading.md"]
    READ --> RETURNED{Ticket returned to development?}
    RETURNED -->|Yes| PREV["Review previous PR diff and QA feedback in comments.md"]
    PREV --> RCA_RET["Write/Update RCA explaining why previous fix failed — see output_rules.md for rca.md format"]
    RETURNED -->|No| RCA_FRESH["Write fresh RCA from ticket description and linked_tests.md"]
    RCA_RET --> REPRO
    RCA_FRESH --> REPRO["Write a unit test that reproduces the bug. Run it — it MUST FAIL"]
    REPRO --> EXISTS{Test fails?}
    EXISTS -->|No| ALREADY["Check git history, current code, and linked tests.<br/>⚠️ If linked test exists: verify it passes AND the test was created/updated BEFORE the fix commit — not after.<br/>If bug is genuinely fixed — write outputs/already_fixed.json and stop"]
    ALREADY --> END_FIXED([End — bug already fixed])
    EXISTS -->|Yes| BLOCKED{Fix requires external decision, secrets, or infra changes?}
    BLOCKED -->|Yes| BLOCK["Write outputs/blocked.json and stop — see output_rules.md"]
    BLOCK --> END_BLOCKED([End — blocked awaiting human input])
    BLOCKED -->|No| FIX["Make minimum targeted fix for the root cause ONLY"]
    FIX --> VERIFY["Run reproduction test (must PASS) and full test suite (no regressions)"]
    VERIFY --> PASS{All tests pass?}
    PASS -->|No| ADJUST["Adjust fix and re-run tests"]
    ADJUST --> VERIFY
    PASS -->|Yes| GITSTATUS["Run git status and review every new/modified file"]
    GITSTATUS --> SECRETS{Sensitive or untracked non-code files present?}
    SECRETS -->|Yes| IGNORE["Add appropriate patterns to .gitignore"]
    SECRETS -->|No| SUMMARY["Write concise bug fix summary to outputs/response.md — see output_rules.md"]
    IGNORE --> SUMMARY
    SUMMARY --> END([End — post-processing handles git/PR])
```

## Returning from test-automation failure

When this Bug has been sent back to development because a linked Test Case failed:

1. Read the `Failed Reason` field of every linked Test Case.
2. If the failure is caused by a missing token, missing permission, missing secret, or any other access/credential/infra issue that you cannot fix in product code, write `outputs/blocked.json` and stop. Do **not** try to code a fix for an access problem.
3. Only attempt a product-code fix when the failure is a genuine product regression.
