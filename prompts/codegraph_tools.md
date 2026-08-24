**HARD GATE — read before any tool call:**

1. Your FIRST code-investigation action MUST be `codegraph context "<ticket key> <feature summary>"` — before any grep / glob / file read of source code.
2. Keep a running mental list of files you have already read and facts you have already established. **Never re-read a file or re-run a search you already did in this session** — quote your earlier finding instead. Re-reading the same file twice means your investigation is looping; stop investigating and start writing the output.
3. If codegraph returns nothing useful, fall back to a few targeted grep/glob searches — but cap the fallback: after ~10 search calls you have enough to write the deliverable. Do not turn the fallback into a search loop.

```mermaid
flowchart TD
    subgraph PURPOSE["Why investigate code"]
        P1["BA / questions agent — find what is ALREADY implemented to avoid asking obvious questions"]
        P2["Dev / review agent — understand call paths and symbols before modifying code"]
    end

    subgraph TOOLS["Two complementary code-navigation tools"]
        subgraph CG["codegraph — semantic index"]
            CG1["codegraph context 'TICKET feature summary'\n→ entry-point symbols + related call paths"]
            CG2["codegraph query 'SymbolName'\n→ where class / method is defined"]
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
        F1["1️⃣ codegraph context 'ticket key + feature'\n   → semantic overview of the feature"]
        F2{"codegraph returned\nuseful symbols?"}
        F3["✅ Follow symbols: codegraph callees / callers / node"]
        F4["↩️ Fallback: Search grep for domain keywords\n   e.g. 'PayloadManifest|RunId|Batch'"]
        F5["2️⃣ Read source files returned by codegraph or grep"]
        F6["3️⃣ Confirm what is implemented vs what is missing / ambiguous"]
        F1 --> F2
        F2 -->|yes| F3 --> F5
        F2 -->|few results| F4 --> F5
        F5 --> F6
    end

    subgraph RULES["Rules"]
        R1["✅ Dev / review / test agents — run codegraph context FIRST, always"]
        R2["✅ BA / question agents — use grep + codegraph together; grep is equally valid"]
        R3["❌ Never skip code investigation and invent questions about already-implemented things"]
        R4["❌ Never use codegraph sync unless you edited source files in this session"]
        R5["❌ Never re-read a file already read in this session — track findings, write the output"]
    end

    PURPOSE --> TOOLS --> FLOW --> RULES
```
