/**
 * Shared staging hygiene for machine-local fa/dmtools runtime artifacts (gh-628, gh-683).
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
 * gh-683 (live fa run 37153405587, fa gh-1206, 2026-10-03): `git add` runs
 * its ignored-pathspec guard on EVERY pathspec element — including `:!`
 * EXCLUSION pathspecs. Naming a path that is gitignored AND exists untracked
 * in the working tree fails the whole add with exit 1 ("The following paths
 * are ignored by one of your .gitignore files ... Use -f if you really want
 * to add them"), killing the dev leg after a fully green run. The guard does
 * NOT fire when the ignored path is tracked (poisoned branch), nonexistent,
 * or when the pathspec is a glob — only for a literal pathspec naming an
 * existing ignored-untracked file. So the staging pathspecs are now built
 * through a `git check-ignore` probe (buildStagingPathspecs): a path git
 * already ignores is left to git's own exclude machinery (gitignore alone
 * keeps `git add .` away from it — no pathspec, no guard to trip), while a
 * path git does NOT ignore keeps its `:!` exclusion (and a not-ignored path
 * can never trip the ignored-files guard). This holds for ANY future runtime
 * file added to the list: ignored repo → no pathspec; unignored repo →
 * exclusion, guard-safe either way.
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
 *
 * gh-683 hardening: the command names ONLY paths git actually tracks —
 * `git ls-files` feeds the rm through a while-read, so an empty result
 * (nothing tracked, the normal case) is a true no-op that exits 0, and no
 * untracked path is ever handed to `git rm` in any form. The old shape
 * (`git rm -r --cached --ignore-unmatch <all paths>` naming every artifact
 * explicitly) is empirically a safe no-op for ignored-untracked paths too,
 * but it names them — this form cannot be broken by any future guard on the
 * rm side either. Still one shell command, so call counts stay identical
 * for tests. Runtime paths never contain spaces (controlled names), so the
 * unquoted ls-files/while-read pairing is safe; [ -n "$p" ] guards a
 * trailing-newline artifact.
 */
function buildUntrackCommand() {
    return 'git ls-files -- ' + RUNTIME_ARTIFACT_PATHS.join(' ') +
        ' | while IFS= read -r p; do [ -n "$p" ] && ' +
        'git rm -r --cached --ignore-unmatch -- "$p"; done';
}

/**
 * `:!` pathspec exclusions (each path and its contents) for `git add` staging
 * commands, e.g. `git add . -- <specs> ":!factory-kit" ":!factory-kit/**"`.
 * Quoted, so a shell (or cli_execute_command) never splits paths.
 *
 * gh-683: pass `runCommand` (a function taking { command } — e.g. the site's
 * cli_execute_command wrapper, executing in the SAME working directory as
 * the add) to probe each artifact with `git check-ignore -q -- <path>`:
 *   - probe succeeds (exit 0 = git already ignores the path): the exclusion
 *     is DROPPED — gitignore alone keeps the artifact out of `git add .`,
 *     and naming it in a pathspec is exactly what trips git add's
 *     ignored-pathspec guard (live fa run 37153405587);
 *   - probe throws (exit 1 = not ignored; cli_execute_command throws on any
 *     non-zero exit): the exclusion is KEPT — the pathspec is the only thing
 *     keeping the artifact out of the commit, and a not-ignored path can
 *     never trip the ignored-files guard.
 * Every staging site runs the untrack command BEFORE the add, so the probe
 * observes the post-untrack state: a poisoned branch's tracked runtime files
 * are already index-less by then, and the tracked+ignored case never trips
 * the guard anyway. Without `runCommand` the full static list is returned
 * (pre-gh-683 behavior) — kept for signature compatibility.
 */
function buildStagingPathspecs(runCommand) {
    var paths = RUNTIME_ARTIFACT_PATHS;
    if (typeof runCommand === 'function') {
        paths = RUNTIME_ARTIFACT_PATHS.filter(function (path) {
            try {
                runCommand({ command: 'git check-ignore -q -- ' + path });
                return false; // ignored — git's own exclude machinery owns it
            } catch (e) {
                return true; // not ignored (or probe unavailable) — pathspec exclusion required
            }
        });
    }
    var specs = [];
    for (var i = 0; i < paths.length; i++) {
        specs.push('":!' + paths[i] + '"');
        specs.push('":!' + paths[i] + '/**"');
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
