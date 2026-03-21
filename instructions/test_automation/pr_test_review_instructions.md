# Test Automation PR Review Instructions

You are reviewing a Pull Request that contains **automated test code** for a specific Test Case ticket.

## What you are reviewing

- Test code written in `testing/tests/{TICKET-KEY}/`
- Supporting components added to `testing/components/` or `testing/core/` if any
- The test was already executed — the PR description shows whether it PASSED or FAILED

## Review focus

### 1. Correctness — does the test verify what the ticket requires?
- Compare test steps against the Test Case ticket (objective, preconditions, steps, expected result)
- Verify that assertions check the right conditions
- Verify that the test fails for the right reason when it fails

### 2. Architecture compliance
- Code must be only in `testing/` folder
- Tests must follow the layered structure: `tests/` → `components/` → `frameworks/` → `core/`
- Tests must not call framework implementations directly — they must go through components
- Each test folder must have `README.md` and `config.yaml`

### 3. Code quality & OOP
- Clear, readable test code
- No hardcoded credentials, URLs, or environment-specific values — must use `core/config/`
- Proper setup and teardown
- No duplicate logic that should be in shared components
- **OOP compliance**: flag violations of the principles defined in `test_automation_architecture.md`:
  - Each Page/Screen/Service object must have a single responsibility
  - Drivers, clients, and config must be injected via constructor — never instantiated inline
  - Components must implement interfaces from `core/interfaces/` — tests must depend on abstractions
  - Locators and HTTP internals must be encapsulated inside components, not exposed to tests
- **Modern framework usage**: flag use of `time.sleep()` instead of explicit waits; flag raw `requests.get()` calls inline in tests instead of typed service objects; flag Selenium usage for new tests where Playwright is the project standard

### 4. Test result validity
- If test PASSED: verify the assertions are meaningful (not trivially true)
- If test FAILED: verify the failure is genuine (not caused by a broken test setup or wrong assertion)

### 5. Test data — self-sufficiency check

When the test is `blocked_by_human` due to missing media files (video, audio, image) **or** when the test hardcodes a path to a file that must be provided externally, check whether the test data could be obtained without human involvement.

**Apply this check in order:**

#### Can it be generated programmatically?
Look for tests that need a minimal valid media file. If the test only needs _any_ valid file (not a specific real-world asset), the test should generate it itself using tools available in the CI environment:

```bash
# Minimal MP4 (1 sec, 1x1 px, ~5 KB)
ffmpeg -f lavfi -i color=c=black:s=1x1:d=1 -c:v libx264 -t 1 -movflags +faststart /tmp/test_video.mp4

# Minimal MP3 (1 sec, silent)
ffmpeg -f lavfi -i anullsrc=r=44100:cl=mono -t 1 -q:a 9 -acodec libmp3lame /tmp/test_audio.mp3

# Minimal JPEG (1x1 px, Python one-liner)
python3 -c "import base64,pathlib; pathlib.Path('/tmp/test_image.jpg').write_bytes(base64.b64decode('...'))"
```

If the test can be made self-sufficient this way → **REQUEST_CHANGES**: include the exact generation snippet in the inline comment and ask the author to add it to the test setup.

#### Can it be downloaded from a public source?
If a slightly larger or more realistic file is needed:

| File type | Suggested URL |
|-----------|--------------|
| MP4 | `https://www.w3schools.com/html/mov_bbb.mp4` |
| MP4 (larger) | `https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4` |
| MP3 | `https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3` |
| JPEG | `https://www.gstatic.com/webp/gallery/1.jpg` |

If a `curl` download in test setup would suffice → **REQUEST_CHANGES**: include the download snippet and GCS upload command if the test needs the file in `{GCS_BUCKET}/`.

#### Does it genuinely require a human-supplied asset?
Only if the test specifically requires a real-world file that cannot be synthesised or downloaded freely (e.g. a licensed video, a file with specific codec characteristics that ffmpeg cannot produce). In this case:

- **APPROVE** the `blocked_by_human` status
- In the general comment, clearly state:
  1. What file is needed (format, minimum specs)
  2. Where it must be placed (local path or GCS path)
  3. Which env var or config must point to it
  4. Any generation command that could work if the human has the right tools

**Never approve a `blocked_by_human` for test data without first verifying that self-generation or download is not feasible.**

---

## Recommendation

- **APPROVE**: Test correctly implements the ticket, code is clean, result is valid
- **REQUEST_CHANGES**: Issues found that affect correctness or maintainability
- **BLOCK**: Test is fundamentally wrong or cannot be trusted

## ⚠️ Inline Comments Policy

**If recommendation is APPROVE**: Do NOT write any inline comments or suggestions. The `inlineComments` array must be empty. The general comment should only briefly confirm the approval.

**If recommendation is REQUEST_CHANGES or BLOCK**: Write inline comments only for BLOCKING and IMPORTANT issues. Do NOT add SUGGESTION-level inline comments. Minor style improvements that do not affect test correctness or architecture compliance should not be posted.

**CRITICAL — Diff-only rule**: Inline comments can ONLY be placed on lines that appear in `pr_diff.txt` (lines inside a diff hunk). If a finding concerns a file or line **not changed in this PR**, include it in the general comment as text — do NOT create an inline comment for it. The GitHub API rejects inline comments on lines outside the diff with a 422 error.

**Thread resolution rule**: When `pr_discussions.md` is present (repeated review after rework), for each prior thread you confirmed is **fully fixed** in this diff, add its `threadId` (from `pr_discussions_raw.json` → `threads[i].threadId`) to `resolvedThreadIds` in `pr_review.json`. Resolved threads will be automatically marked as resolved on GitHub. Only add threads whose fix you verified in the diff — do NOT resolve threads that are still open or only partially addressed.

## Output format

Same format as standard PR review — see `pr_review_json_output.md`.
