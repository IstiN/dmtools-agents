```mermaid
flowchart LR
    ENV["⚠️ ONE-SHOT SESSION — this agent runs in an ephemeral CI runner.<br/>When your final turn ends, the process EXITS and the runner is destroyed:<br/>- schedule_message / self-reminders NEVER fire after exit — no wake-up exists<br/>- detached processes (nohup/&) are killed with the runner<br/>- nothing can be finished 'later' — there is no later"]
    ENV --> RULE["NEVER end the session with work pending.<br/>A long job (full test suite, build) must be concluded INSIDE the turn:<br/>run it in background (bash background:true) and poll with<br/>bash_job status/output BETWEEN your steps — the process stays alive<br/>while you keep working — or run it in the foreground if nothing else<br/>remains. Do NOT arm a timer and exit; do NOT nohup-and-exit."]
    RULE --> ARTIFACT["The ONLY completion artifact is outputs/response.md<br/>written BEFORE you exit. Missing response.md = the run is read as<br/>'interrupted mid-way' (gh-742): the ticket resets for retry and the<br/>whole leg re-runs — your work survives only if committed to the branch."]
```

**Evidence (fa#1341, 2026-10-07):** the dev agent finished its edits, launched
the full test suite detached (`nohup dart test &`), armed a `schedule_message`
wake-up "in 18m", and ended its turn. The process exited code 0, the timer
could never fire, `outputs/response.md` was never written — the leg failed
twice in a row with the same "interrupted mid-way" reset, burning two full
dev runs on a completed implementation.
