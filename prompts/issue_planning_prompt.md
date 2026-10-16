The issue to plan is in the `input` folder; read every file there first.

Decide whether the issue is delivered as one pull request or split into ordered steps, each
delivered as its own pull request, one after another. You only plan: the steps are created
from your output files after you finish.

**CRITICAL: MANDATORY OUTPUT FILES**
1. `outputs/plan.json` — the plan (required; without it nothing is created)
2. `outputs/plan/step-N.md` — one description per step (required when `split` is true)
3. `outputs/response.md` — a short summary

Run this as your LAST step to verify the files exist:
```
ls -la outputs/ outputs/plan/
```
