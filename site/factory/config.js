/*
 * Factory board — ALL deployment knobs live here.
 * Copy the folder, edit this file, host it. Nothing else to touch.
 */
window.FACTORY_BOARD_CONFIG = {
  // Refresh cadence (ms). The data itself is a tick snapshot (10 min cadence);
  // 60s polling just picks the new snapshot up promptly.
  refreshMs: 60000,

  // Branding
  title: 'Factory Board',
  logo: '🏭',

  // One entry per factory. stateUrl = the release-asset CDN link the SM
  // tick publishes (public, token-free, no rate limits).
  //   asset name = cfg.statePublish.asset of that factory
  //   accent     = CSS color for the tab + lane highlights (style knob)
  factories: [
    {
      id: 'fa',
      name: 'flutter_agent_harness',
      stateUrl: 'https://github.com/IstiN/flutter_agent_harness/releases/latest/download/fa-state.json',
      accent: '#4f8cff'
    },
    {
      id: 'dart',
      name: 'dmtools-dart',
      stateUrl: 'https://github.com/epam/dmtools-dart/releases/latest/download/dart-state.json',
      accent: '#33b077'
    }
  ],

  // Lane rendering order + titles (add/remove/rename freely)
  lanes: [
    { id: 'validating',     title: 'Validating (mutex)' },
    { id: 'approved_queue', title: 'Approved queue (FIFO)' },
    { id: 'review',         title: 'Review' },
    { id: 'fresh',          title: 'Fresh' }
  ],

  // Labels highlighted as badges on cards (the rest stay subtle)
  badgeLabels: ['pr_approved', 'ai_validated', 'ai_pr_reviewed', 'ai_validating',
                'dependencies', 'agent:review', 'github_actions'],

  // Repo link base for PR links
  prUrl: function (repo, n) { return 'https://github.com/' + repo + '/pull/' + n; }
};
