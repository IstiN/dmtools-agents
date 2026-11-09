// Machine loop wiring for THIS repository (see dmtools-agents
// docs/machine-factory-integration.md §5a). The factory resolves leg →
// runner here; runner paths are repo-relative. bug/story may share a
// single 'dev' entry instead of two.
//
// gh-1403: this repository opts in to reviewPolicy.verification = filter as
// the TRIAL SUBJECT — its own PRs (incl. factory-bot PRs) are reviewed by
// the same machinery, so the rework laps it produces are the baseline and
// the trial data in one place. Revert to 'none' (or delete the block) if
// the trial bar (laps/PR ↓ AND precision ↑ AND wrongly-dropped ≈ 0) fails.
module.exports = {
  // #687: whose login is "the machine" — auto rework (prMachineAuthor)
  // and pr_approved arming fire only on PRs authored by this login.
  machineAuthor: 'ai-teammate,github-actions[bot],dmtools-factory-bot',
  reviewPolicy: {
    verification: 'filter'
  },
  sm: {
    runners: {
      bug: '.dmtools/runners/fa-bug-dev.json',
      story: '.dmtools/runners/fa-story-dev.json',
      review: '.dmtools/runners/fa-review.json',
      rework: '.dmtools/runners/fa-rework.json'
    }
  }
};
