```mermaid
flowchart LR
    ENV["⚠️ ONE-SHOT SESSION — this agent runs in an ephemeral CI runner.<br/>When your final turn ends, the process EXITS and the runner is destroyed:<br/>- schedule_message / self-reminders NEVER fire after exit — no wake-up exists<br/>- detached processes (nohup/&) are killed with the runner<br/>- nothing can be finished 'later' — there is no later"]
    ENV --> RULE["NEVER end the session with work pending.<br/>A long job (full test suite, build) must be concluded INSIDE the turn:<br/>run it in background (bash background:true) and poll with<br/>bash_job status/output BETWEEN your steps — the process stays alive<br/>while you keep working — or run it in the foreground if nothing else<br/>remains. Do NOT arm a timer and exit; do NOT nohup-and-exit."]
    RULE --> ARTIFACT["The ONLY completion artifact is outputs/response.md<br/>written BEFORE you exit. Missing response.md = the run is read as<br/>'interrupted mid-way': the ticket resets for retry and the<br/>whole leg re-runs — your work survives only if committed to the branch."]
```

**Why this matters:** if the agent finishes its edits, launches the full test
suite detached (`nohup <test-command> &`), arms a `schedule_message` wake-up
for later, and ends its turn, the process exits code 0, the timer never fires,
and `outputs/response.md` is never written — the leg fails with an
"interrupted mid-way" reset and burns full runs on an already-completed
implementation.
