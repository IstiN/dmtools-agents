/*
 * Factory Board v2 — ALL deployment knobs live here.
 * Copy the folder, edit this file, host it. Nothing else to touch.
 *
 * Data: each factory's SM tick publishes a schema-2 state snapshot to its
 * repo's `factory-data` branch (jobParams.statePublish in machine-sm.yml):
 *   https://raw.githubusercontent.com/<O/R>/factory-data/data/<asset>.json
 * The board also renders schema 1 snapshots (the lane set before
 * 2026-10-01) — old history files never break it.
 */
window.FACTORY_BOARD_CONFIG = {
  // Refresh cadence (ms). The data itself is a tick snapshot (10 min cadence);
  // 60s polling just picks the new snapshot up promptly.
  refreshMs: 60000,

  // Branding (the logo is an inline SVG in index.html — no emoji anywhere)
  title: 'Factory Board',

  // One entry per factory. stateUrl = the factory-data branch CDN link the
  // SM tick publishes (public, token-free, no rate limits).
  //   asset name = cfg.statePublish.asset of that factory
  //   accent     = CSS color for the tab + lane highlights (style knob)
  //   repo is NOT needed here — the snapshot itself carries st.repo and the
  //   board links cards against it (schema 1 bug: links went to
  //   github.com/undefined/pull/N when repo was read from this config).
  factories: [
    {
      id: 'fa',
      name: 'flutter_agent_harness',
      stateUrl: 'https://raw.githubusercontent.com/IstiN/flutter_agent_harness/factory-data/data/fa-state.json',
      accent: '#22d3ee'
    },
    {
      id: 'dart',
      name: 'dmtools-dart',
      stateUrl: 'https://raw.githubusercontent.com/epam/dmtools-dart/factory-data/data/dart-state.json',
      accent: '#34d399'
    },
    {
      id: 'agents',
      name: 'dmtools-agents',
      stateUrl: 'https://raw.githubusercontent.com/IstiN/dmtools-agents/factory-data/data/agents-state.json',
      accent: '#a78bfa'
    }
  ],

  // Lane rendering order + titles — the PIPELINE order (schema 2). A card
  // moves left→right exactly once per stage. Schema 1 snapshots map onto it:
  // `fresh` renders as `pr_created`; development/merged_recent stay empty.
  // pr_validation (gh-716) holds PRs whose head validation run is still
  // in flight — the window between "PR created" and "reviewed".
  lanes: [
    { id: 'development',    title: 'Development',          icon: 'dev' },
    { id: 'pr_created',     title: 'PR created',           icon: 'pr' },
    { id: 'pr_validation',  title: 'PR validation',        icon: 'validate' },
    { id: 'review',         title: 'Review',               icon: 'review' },
    { id: 'approved_queue', title: 'Approved queue · FIFO', icon: 'queue' },
    { id: 'validating',     title: 'Validating · mutex',   icon: 'validate' },
    { id: 'merged_recent',  title: 'Merged · 24h',         icon: 'merged' }
  ],

  // v3: backlog columns — open issues from the same snapshot's `backlog`
  // section (bucket ids come from factoryState.js backlogBucket). Order is
  // the flow: assigned → queued → owner-held → unsorted inbox.
  backlogColumns: [
    { id: 'in_dev',  title: 'In dev · assigned',     icon: 'dev' },
    { id: 'queued',  title: 'agent:dev queued',      icon: 'queue' },
    { id: 'blocked', title: 'Blocked · owner hold',  icon: 'blocked' },
    { id: 'inbox',   title: 'Inbox',                 icon: 'inbox' }
  ],

  // Labels highlighted as badges on cards (the rest stay subtle)
  badgeLabels: ['pr_approved', 'ai_validated', 'ai_pr_reviewed', 'ai_validating',
                'dependencies', 'agent:dev', 'agent:review', 'agent:rework',
                'github_actions'],

  // Repo link base for PR/issue links (n = number; kind = 'pull'|'issues')
  prUrl: function (repo, n, kind) {
    return 'https://github.com/' + repo + '/' + (kind || 'pull') + '/' + n;
  }
};
