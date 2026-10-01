'use strict';
/**
 * Pack launch-surface contract (Wave 2, owner decision 2026-10-01).
 *
 * Teammate packs must be SELF-SUFFICIENT in their release zips: the launch
 * config (`launch.json` — "how to launch me") and the loop verdict logic
 * (`loop/verdict.sh`) travel INSIDE the zip and version with the pack, so a
 * factory that has the unpacked pack needs no parallel dmtools-agents tree
 * checkout for them. `install.sh` / `cache.sh` deliberately STAY in the
 * tree (owner decision): they install toolchain dependencies, they do not
 * describe the agent.
 *
 * Surface per pack (added by ci/release_packs.mjs after `dmtools compile`):
 *   launch.json      verbatim copy of the root entry config <agent>.json
 *   loop/verdict.sh  verbatim copy of setup/review-verdict.sh (review packs)
 *
 * Config-path audit (Wave 2 step 2): every tree reference in the four
 * launch configs (`metadata.descriptionPath` = agents/docs/agents/<a>.md,
 * `cliCommands` = ./agents/scripts/run-agent.sh, JS actions, cliPrompts)
 * already lands INSIDE the zip — the compiler embeds the referenced files
 * (agents/ prefix stripped) and the runtime resolver rewrites the config
 * paths to the pack root. No config edits needed; this module only ADDS
 * the two contract files.
 */

/** Repo-relative source of the review-loop verdict logic. */
var VERDICT_SOURCE = 'setup/review-verdict.sh';

/**
 * The teammate packs that carry a launch surface, and which files they add.
 * `verdict: true` → loop/verdict.sh rides along (review-loop packs only;
 * the dev packs currently have no in-pack loop logic).
 */
var TEAMMATE_LAUNCH_PACKS = {
  pr_review: { launch: true, verdict: true },
  pr_rework: { launch: true, verdict: true },
  story_development: { launch: true },
  bug_development: { launch: true },
};

/** True when [agent] is a teammate pack carrying a launch surface. */
function isTeammatePack(agent) {
  return Object.prototype.hasOwnProperty.call(TEAMMATE_LAUNCH_PACKS, agent);
}

/**
 * Zip additions for [agent]: `[{ entry, source }]` (entry = path inside the
 * zip, source = repo-relative file to copy verbatim). Non-teammate packs
 * get an empty list (their zips stay exactly as `dmtools compile` built
 * them).
 */
function launchExtras(agent) {
  if (!isTeammatePack(agent)) return [];
  var extras = [{ entry: 'launch.json', source: agent + '.json' }];
  if (TEAMMATE_LAUNCH_PACKS[agent].verdict) {
    extras.push({ entry: 'loop/verdict.sh', source: VERDICT_SOURCE });
  }
  return extras;
}

/**
 * Pure manifest merge: folds `added` (`[{path, sha256, mode}]`) into a
 * compile manifest, replacing same-path entries and keeping `files` sorted
 * by path (the manifest inventory order the compiler emits). The rest of
 * the manifest (agent/version/sourceCommit/defaultEntry/...) passes through
 * untouched — the catalog.json format is NOT affected by this contract.
 */
function mergeManifest(manifest, added) {
  var byPath = {};
  var files = manifest.files || [];
  for (var i = 0; i < files.length; i++) {
    byPath[files[i].path] = files[i];
  }
  for (var j = 0; j < added.length; j++) {
    var a = added[j];
    byPath[a.path] = { path: a.path, sha256: a.sha256, mode: a.mode };
  }
  var merged = Object.keys(byPath).map(function (p) { return byPath[p]; });
  merged.sort(function (x, y) { return x.path < y.path ? -1 : x.path > y.path ? 1 : 0; });
  var out = {};
  Object.keys(manifest).forEach(function (k) { out[k] = manifest[k]; });
  out.files = merged;
  return out;
}

module.exports = {
  VERDICT_SOURCE: VERDICT_SOURCE,
  TEAMMATE_LAUNCH_PACKS: TEAMMATE_LAUNCH_PACKS,
  isTeammatePack: isTeammatePack,
  launchExtras: launchExtras,
  mergeManifest: mergeManifest,
};
