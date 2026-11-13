# PR Review Input Context — reading order (base contract)

Reviewer-agnostic: EVERY reviewer leg reads the same PR context. Read files
that exist in `input/` locally — do NOT re-fetch via dmtools.

```mermaid
flowchart TD
    subgraph PR_CONTEXT["⚠️ PR-specific files (read first)"]
        P1["1️⃣ instruction.md (repo root) — project stack, conventions"]
        P2["2️⃣ input/TICKET/pr_info.md — PR title, author, branch, description"]
        P3["3️⃣ input/TICKET/pr_diff.txt — the diff to review"]
        P4["4️⃣ input/TICKET/pr_files.txt — list of changed files"]
        P5["5️⃣ input/TICKET/ci_failures.md — CI failures = BLOCKING (last 500 lines)"]
        P5_FULL["5️⃣ input/TICKET/ci_failures_full.log — full CI logs"]
        P6["6️⃣ input/TICKET/pr_discussions.md + pr_discussions_raw.json — existing comments"]
        P7["7️⃣ input/TICKET/pr_findings.md — previously raised findings (when present)"]
        P8["8️⃣ input/TICKET/review_policy.md — the resolved reviewPolicy: severity table, density cap, downgrade protocol"]
        P9["9️⃣ input/TICKET/pr_new_hunks.txt — the hunks added since the last reviewed head (re-review rounds; when present)"]
        P10["🔟 input/TICKET/pool_specialist-<reviewer>.md — THIS session's pool-specialist prompt (specialist sessions only; when present)"]
        P1 --> P2 --> P3 --> P4 --> P5 --> P5_FULL --> P6 --> P7 --> P8 --> P9 --> P10
    end

    subgraph TICKET_CONTEXT["Ticket context (for understanding PR purpose)"]
        T1["7️⃣ input/TICKET/ticket.md — linked ticket description, ACs"]
        T2["8️⃣ input/TICKET/comments.md — ticket discussion if present"]
        T3["9️⃣ input/TICKET/parent-*.md — parent story context"]
        T4["🔟 input/TICKET/confluence/*.md — linked specifications"]
        T1 --> T2 --> T3 --> T4
    end

    subgraph RULE["⚠️ Rule"]
        R1["If file exists in input/ → read locally, do NOT re-fetch via dmtools"]
    end

    PR_CONTEXT --> TICKET_CONTEXT --> RULE
```

Read PR files to understand WHAT changed. Read ticket files to understand WHY
it changed and verify against requirements.

## Pool specialist sessions — the pool prompt file

When the run's prompt file is `input/TICKET/pool_specialist-<reviewer>.md`,
this session is ONE reviewer's focused pass of the reviewer pool — not the
posting review. The prompt names the reviewer, its lens, the output
contract and the round head. A specialist session:

- hunts ONLY its lens's dimension (the lens file it is pointed at names it)
  — the generalist posting pass owns everything else;
- writes `outputs/pr_review_candidates-<reviewer>.json` per the base
  candidates-only contract (output_rules.md) — NEVER
  `outputs/pr_review.json`, never `pr_review_general.md`, never
  `pr_review_comments/*`;
- posts nothing, labels nothing, changes no status — the aggregation step
  reads the candidates file and the posting session stamps the markers.

A session WITHOUT a pool-specialist prompt is the posting review: the full
verdict contract below applies unchanged.

<!-- Pack-reachability anchor: the deprecated v1 instruction shims are listed in instructions/pr_review/deprecated-v1.md (frozen; removed in the next major release). -->
