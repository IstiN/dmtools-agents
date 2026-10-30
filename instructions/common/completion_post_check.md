# ⚠️ COMPLETION POST-CHECK — integration readiness (before finishing)

After implementation is done and all tests pass, run a quick integration-readiness scan of YOUR OWN change. Question it answers: **will this feature actually work in the target environment, or does it depend on external setup this repo does not contain?**

Flag (as concerns) anything feature-blocking that is NOT code:
- External services the code now depends on but that are not provisioned (Firebase, Apple/Google developer config, API backends, databases).
- Missing configuration artifacts: `google-services.json`, `GoogleService-Info.plist`, client IDs / API keys / secrets, environment variables, `.entitlements`, URL scheme registrations, Gradle/Info.plist/manifest changes.
- Referenced-but-absent external contracts: an endpoint that the provided API spec (e.g. swagger) does not define, a webhook URL that was never registered.

**Do NOT flag code-quality, style, architecture, or test-coverage issues — the review agent owns those. Do not duplicate its work.**

If there ARE concerns: write `outputs/concerns.md` — for each concern: (a) what the PR does, (b) what is missing, (c) concretely what is needed to make it work (exact file names, IDs, console/account steps). Short and factual; the pipeline appends it to the completion comment and the PR body and labels the ticket `ai_concerns`.

If there are NO concerns: write nothing — no file, no label.
