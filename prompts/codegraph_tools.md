**HARD GATE — read before any tool call:**

1. **Never put ticket keys or process words (`PR rework`, `bug fix`, `test automation`) into CodeGraph queries.** Use 2–5 concrete code identifiers (class, method, table, endpoint, flag, or package) extracted from the ticket, PR diff, or review comments.
2. **Start cheap:** begin code investigation with `codegraph query "<SymbolName>"` (sub-second symbol search). Follow with **at most one** `codegraph context "<2-5 code identifiers>"` (and at most one `codegraph explore` per session); on large indexes pass `-n <max-nodes>` or `--no-code` when only structure is needed, then narrow with `codegraph node`, `codegraph callers`, and `codegraph callees`.
3. **PR rework and PR review agents:** start from the PR's changed files (`pr_diff.txt`) and review comments (`pr_discussions.md`), then run `codegraph query` / `node` / `callers` / `callees` on the touched symbols — never open with a blind `codegraph context` on the ticket key.
4. Keep a running mental list of files you have already read and queries you have already run. **Never re-read a file or re-run reworded synonym queries** — quote your earlier finding instead, or fall back to targeted `grep` / `glob` searches with a specific goal.
```mermaid
flowchart TD
    subgraph PURPOSE["Why investigate code"]
        P1["BA / questions agent — find what is ALREADY implemented to avoid asking obvious questions"]
        P2["Dev / review agent — understand call paths and symbols before modifying code"]
    end

    subgraph TOOLS["Two complementary code-navigation tools"]
        subgraph CG["codegraph — semantic index"]
            CG2["codegraph query 'SymbolName'\n→ fast symbol lookup (start here)"]
            CG1["codegraph context 'ClassA methodB' -n 10 --no-code\n→ entry-point symbols + call paths (at most 1 per session, NO ticket keys)"]
            CG3["codegraph callees 'Class.method' → what it calls"]
            CG4["codegraph callers 'Class.method' → who calls it"]
            CG5["codegraph node 'ClassName' → read symbol source"]
            CG6["codegraph sync → rebuild index after editing files"]
        end
        subgraph SR["Search — pattern finding"]
            SR1["Search glob '**/*PayloadManifest*'\n→ find files by name"]
            SR2["Search grep 'keyword' in **/*.java\n→ find business logic by text"]
            SR3["Read files returned by grep / glob"]
        end
    end

    subgraph FLOW["Investigation flow — use both tools together"]
        F0["PR rework / review? Start from pr_diff.txt + pr_discussions.md symbols"]
        F1["1️⃣ codegraph query 'SymbolName'\n   (+ at most one codegraph context '2-5 code identifiers', no ticket key)"]
        F2{"codegraph returned\nuseful symbols?"}
        F3["✅ Follow symbols: codegraph node / callers / callees"]
        F4["↩️ Fallback: Search grep for domain keywords\n   e.g. 'PayloadManifest|RunId|Batch'"]
        F5["2️⃣ Read source files returned by codegraph or grep"]
        F6["3️⃣ Confirm what is implemented vs what is missing / ambiguous"]
        F0 --> F1 --> F2
        F2 -->|yes| F3 --> F5
        F2 -->|few results| F4 --> F5
        F5 --> F6
    end

    subgraph RULES["Rules"]
        R1["✅ Start with codegraph query '<symbol>'; use 2–5 code identifiers, never ticket keys"]
        R2["✅ Limit codegraph context and explore to at most 1 call each (-n <max-nodes> / --no-code)"]
        R3["❌ Never re-run reworded synonym queries or re-read files already read in this session"]
        R4["❌ Never use codegraph sync unless you edited source files in this session"]
        R5["❌ Never skip code investigation and invent questions about already-implemented things"]
    end

    PURPOSE --> TOOLS --> FLOW --> RULES
```
