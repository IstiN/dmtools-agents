// Machine loop wiring for THIS repository (see dmtools-agents
// docs/machine-factory-integration.md §5a). The factory resolves leg →
// runner here; runner paths are repo-relative. bug/story may share a
// single 'dev' entry instead of two.
//
// gh-1408: the reviewPolicy block below IS the gh-1403 trial start. The
// opt-in could not land earlier: released packs cut from pre-gh-1403
// mains reject the unknown `verification` key at leg setup
// (preCliReworkSetup / preparePRForReview → ReviewPolicyValidationError),
// which kills every machine leg before the agent boots. Release
// agents-rel-20261109-142157 is cut from a main that ships
// js/common/reviewFilter.js (gh-1403, PR #1407), so the key now
// validates and every post-merge PR reviews under 'filter'.
//
// TRIAL REVERT: flip verification back to 'none' if the gh-1403 trial
// bar fails — rework laps/PR ↓ AND precision ↑ AND wrongly-dropped ≈ 0
// (gh-1403 §Trial).
module.exports = {
  // #687: whose login is "the machine" — auto rework (prMachineAuthor)
  // and pr_approved arming fire only on PRs authored by this login.
  machineAuthor: 'ai-teammate,github-actions[bot],dmtools-factory-bot',
  // gh-1403 finding verification: 'filter' re-verifies every
  // rework/polish-tier finding with a fresh-context ReviewFilter pass
  // (keep | demote | drop) before it costs a lap; 'none' posts findings
  // exactly as the review leg raised them (the trial-revert value).
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
