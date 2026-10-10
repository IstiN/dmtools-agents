'use strict';
/**
 * Release-kicker guard helpers (gh-844, live incident 2026-10-10).
 *
 * Pure decision logic for the agent-pack release kicker — the belt for a
 * silently-dropped push trigger: #841 merged 14:24Z with release-relevant
 * files, the push event never fired, and no release was cut until an
 * operator dispatch 17:05Z (#826 hung in the gap). The kicker workflow
 * compares main HEAD against the latest agents-rel-* tag each tick and
 * re-dispatches agent-pack-release.yml when main is ahead on non-ignored
 * paths and no release run is pending.
 *
 * Same split as ci/pack_release_guard.cjs: the runner (ci/release_kicker.mjs)
 * is an ESM script dmtools' GraalJS loader cannot import, so every decision
 * lives in this CommonJS twin and is unit-tested via loadModule().
 *
 * Single source of truth (gh-844 AC3): the paths-ignore set is PARSED from
 * agent-pack-release.yml itself — never hardcoded here — so the kicker can
 * never drift from what the push trigger ignores.
 */

/**
 * Parse the push trigger's paths-ignore list out of the release workflow
 * YAML. Entries look like `      - '<dir>/**'` (single-quoted, one level
 * deeper than the `paths-ignore:` key). The block ends at the first line
 * that is neither an entry nor a comment.
 *
 * @param {string} yml  contents of agent-pack-release.yml
 * @returns {string[]}  the paths-ignore patterns, in workflow order
 */
function pathsIgnoreFromWorkflow(yml) {
  var patterns = [];
  if (!yml) return patterns;
  var lines = yml.split(/\r?\n/);
  var inBlock = false;
  for (var i = 0; i < lines.length; i++) {
    var trimmed = lines[i].trim();
    if (!inBlock) {
      if (/^paths-ignore:\s*$/.test(trimmed)) inBlock = true;
      continue;
    }
    var quoted = /^-\s*'([^']+)'\s*$/.exec(trimmed) || /^-\s*"([^"]+)"\s*$/.exec(trimmed);
    if (quoted) {
      patterns.push(quoted[1]);
      continue;
    }
    if (trimmed === '' || trimmed.charAt(0) === '#') continue; // comments inside the block
    break; // next key of the workflow — the block is over
  }
  return patterns;
}

/**
 * True when [file] is release-irrelevant per a paths-ignore pattern. The
 * workflow only uses `<dir>/**` forms; a bare pattern must match exactly.
 */
function isIgnoredPath(file, patterns) {
  for (var i = 0; i < patterns.length; i++) {
    var p = patterns[i];
    if (p.slice(-3) === '/**') {
      if (file.indexOf(p.slice(0, -3) + '/') === 0) return true;
    } else if (file === p) {
      return true;
    }
  }
  return false;
}

/** The subset of [files] that demands a release (paths-ignore removed). */
function filterRelevantFiles(files, patterns) {
  var relevant = [];
  for (var i = 0; i < files.length; i++) {
    if (!isIgnoredPath(files[i], patterns)) relevant.push(files[i]);
  }
  return relevant;
}

/**
 * The kicker decision for one tick.
 *
 * @param {object} opts
 * @param {string} opts.mainHead           current origin/main SHA
 * @param {string} opts.releaseCommit      commit the latest agents-rel-* tag points at ('' when no tag yet)
 * @param {string[]|null} opts.changedFiles  tag...main diff names (null = unknown)
 * @param {number} opts.activeReleaseRuns  queued/in_progress runs of the release workflow
 * @param {string[]} opts.ignored          paths-ignore patterns from the release workflow
 * @returns {{action: 'dispatch'|'noop', reason: string, relevantCount: number}}
 */
function decideKick(opts) {
  var ignored = opts.ignored || [];
  if (opts.releaseCommit && opts.mainHead === opts.releaseCommit) {
    return { action: 'noop', reason: 'main-already-released', relevantCount: 0 };
  }
  if (!opts.releaseCommit) {
    // First release: the builder no-ops (dist/.no-release) when there is
    // genuinely nothing to ship, so a dispatch is safe (AC2).
    return { action: 'dispatch', reason: 'no-release-tag',
      relevantCount: opts.changedFiles ? opts.changedFiles.length : -1 };
  }
  if (opts.changedFiles == null) {
    // Diff cannot be computed — never silently skip: that is the gh-844 bug class.
    return { action: 'dispatch', reason: 'diff-unavailable', relevantCount: -1 };
  }
  var relevant = filterRelevantFiles(opts.changedFiles, ignored);
  if (relevant.length === 0) {
    return { action: 'noop', reason: 'only-ignored-paths', relevantCount: 0 };
  }
  if (opts.activeReleaseRuns > 0) {
    return { action: 'noop', reason: 'release-run-pending', relevantCount: relevant.length };
  }
  return { action: 'dispatch', reason: 'main-ahead', relevantCount: relevant.length };
}

module.exports = {
  pathsIgnoreFromWorkflow: pathsIgnoreFromWorkflow,
  isIgnoredPath: isIgnoredPath,
  filterRelevantFiles: filterRelevantFiles,
  decideKick: decideKick,
};
