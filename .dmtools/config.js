// Machine loop wiring for THIS repository (see dmtools-agents
// docs/machine-factory-integration.md §5a). The factory resolves leg →
// runner here; runner paths are repo-relative. bug/story may share a
// single 'dev' entry instead of two.
//
// NOTE: no reviewPolicy block here on purpose — released packs (pre
// gh-1403) reject the unknown `verification` key at leg setup
// (preCliReworkSetup / preparePRForReview), which kills every machine
// leg on this checkout before the agent boots. The opt-in lands via
// #1408 once a pack release cut from a post-gh-1403 main is out.
module.exports = {
  // #687: whose login is "the machine" — auto rework (prMachineAuthor)
  // and pr_approved arming fire only on PRs authored by this login.
  machineAuthor: 'ai-teammate,github-actions[bot],dmtools-factory-bot',
  sm: {
    runners: {
      bug: '.dmtools/runners/fa-bug-dev.json',
      story: '.dmtools/runners/fa-story-dev.json',
      review: '.dmtools/runners/fa-review.json',
      rework: '.dmtools/runners/fa-rework.json'
    }
  }
};
