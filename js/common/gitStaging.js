/**
 * Shared staging hygiene for machine-local fa/dmtools runtime artifacts (gh-628).
 *
 * The machine's runtime files live INSIDE the committed .dmtools/ directory
 * (config.js, runners/), so the directory itself cannot be ignored — each
 * artifact is excluded by pathspec instead. Every commit-producing staging
 * site (developTicketAndCreatePR, developBugAndCreatePR, pushReworkChanges,
 * timerAutoCommitAndSave) builds its commands from this single canonical
 * list, so the `git rm -r --cached` untrack list and the `git add` exclusion
 * pathspecs can never drift apart again (round 1 review found .dmtools/
 * fa-sessions in every staging pathspec but in none of the untrack lists).
 *
 * GraalJS-compatible: var/plain functions only, no Node APIs.
 */

var RUNTIME_ARTIFACT_PATHS = [
    '.dmtools/copilot-sessions',
    '.dmtools/credential-helper.log',
    '.dmtools/fa-trace.log',
    '.dmtools/run-output.txt',
    '.dmtools/stall-capture.log',
    '.dmtools/fa-sessions',
    '.dmtools-session-output.log'
];

/**
 * Untrack command for already-poisoned branches: removes the artifacts from
 * the index if tracked, tolerating every name being absent. `--cached` is
 * required — plain `git rm` refuses locally-modified files, and these logs
 * are always being appended.
 */
function buildUntrackCommand() {
    return 'git rm -r --cached --ignore-unmatch ' + RUNTIME_ARTIFACT_PATHS.join(' ');
}

/**
 * `:!` pathspec exclusions (each path and its contents) for `git add` staging
 * commands, e.g. `git add . -- <specs> ":!factory-kit" ":!factory-kit/**"`.
 * Quoted, so a shell (or cli_execute_command) never splits paths.
 */
function buildStagingPathspecs() {
    var specs = [];
    for (var i = 0; i < RUNTIME_ARTIFACT_PATHS.length; i++) {
        specs.push('":!' + RUNTIME_ARTIFACT_PATHS[i] + '"');
        specs.push('":!' + RUNTIME_ARTIFACT_PATHS[i] + '/**"');
    }
    return specs.join(' ');
}

/**
 * True when a `git status --porcelain` line only reports a machine-local
 * runtime artifact (untracked leftover of the `--cached` untrack, or a dirty
 * log). Such lines are never the CLI agent's work and must not flip
 * change-detection checks (gh-628 round 1: developBugAndCreatePR's
 * interrupted-agent recovery fired on every leg and posted a false
 * "Partial analysis work was saved" comment).
 */
function isRuntimeArtifactStatusLine(line) {
    if (!line) return false;
    for (var i = 0; i < RUNTIME_ARTIFACT_PATHS.length; i++) {
        if (line.indexOf(RUNTIME_ARTIFACT_PATHS[i]) !== -1) return true;
    }
    return false;
}

module.exports = {
    RUNTIME_ARTIFACT_PATHS: RUNTIME_ARTIFACT_PATHS,
    buildUntrackCommand: buildUntrackCommand,
    buildStagingPathspecs: buildStagingPathspecs,
    isRuntimeArtifactStatusLine: isRuntimeArtifactStatusLine
};
