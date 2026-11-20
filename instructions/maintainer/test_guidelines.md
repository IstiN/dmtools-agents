```mermaid
flowchart TD
    T1["All tests are equal — no ranks, no permanent markers,<br/>no privileged witness files"]
    T2["Tests have lifetimes, not importance:<br/>tests pinning the old structure are updated or deleted freely"]
    T3["Absorbed tests die in the same branch as the structural change<br/>that made them redundant"]
    T4["Suite MUST be green before finishing — run it, do not assume"]
    T5["Never weaken a failing test to make it pass:<br/>either the structural change justifies rewriting the pin<br/>(say so in the PR body), or the change is wrong"]
    T6["New tests only for inherently behavioral properties —<br/>the docstring names the decision the test encodes"]
    T1 --> T2 --> T3 --> T4 --> T5 --> T6
```

## Reading a red test during a maintainer leg

A failing test after a structural change has exactly two honest
explanations, and the maintainer decides which one applies — explicitly:

1. **The behavior is still right, the pin was incidental.** The test pinned
   how the old structure happened to behave (an implementation detail, a
   private call order). Rewrite or delete it, and say so in the PR body:
   "test X pinned the old single-class layout; the property it protected
   (Y) is now covered by test Z".
2. **The change broke a real property.** The structure is wrong, not the
   test. Go back and fix the structure.

If you cannot tell which case applies, that is a finding, not a coin flip:
describe the ambiguity in the PR body — it means the property the test
protects was never named, and naming it is part of the job.
