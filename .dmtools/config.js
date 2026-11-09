// Machine loop wiring for THIS repository (see dmtools-agents
// docs/machine-factory-integration.md §5a). The factory resolves leg →
// runner here; runner paths are repo-relative. bug/story may share a
// single 'dev' entry instead of two.
//
// gh-1403: this repository ships reviewPolicy.verification but MERGES WITH
// 'none' — the opt-in to 'filter' (the trial: this repo's own PRs are the
// baseline and the trial data in one place) flips in a follow-up issue once
// the agent pack release carrying this support is published. If the trial
// bar fails (laps/PR ↓ AND precision ↑ AND wrongly-dropped ≈ 0), revert to
// 'none' (or delete the block).
module.exports = {
  // #687: whose login is "the machine" — auto rework (prMachineAuthor)
  // and pr_approved arming fire only on PRs authored by this login.
  machineAuthor: 'ai-teammate,github-actions[bot],dmtools-factory-bot',
  reviewPolicy: {
    verification: 'none'
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
