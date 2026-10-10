/**
 * Unit tests for js/common/gitStaging.js — the single source of truth for
 * machine-local runtime-artifact staging hygiene (gh-628).
 *
 * gh-628 live case: the machine's runtime logs live INSIDE the committed
 * .dmtools/ directory (config.js, runners/), so the directory itself cannot
 * be ignored; the timer's broad `git add` swept .dmtools/credential-helper.log
 * (the credential helper's serving trace) into three ticket-branch commits.
 * Every commit-producing staging site must derive its `git rm -r --cached`
 * untrack list and its `git add` exclusion pathspecs from the SAME canonical
 * list so the two can never drift apart again (the first review round found
 * .dmtools/fa-sessions present in staging exclusions but missing from all
 * four untrack lists).
 */

var gitStaging = loadModule('js/common/gitStaging.js');

var ALL_ARTIFACTS = [
    '.dmtools/copilot-sessions',
    '.dmtools/credential-helper.log',
    '.dmtools/fa-trace.log',
    '.dmtools/run-output.txt',
    '.dmtools/stall-capture.log',
    '.dmtools/fa-sessions',
    '.dmtools-session-output.log'
];

suite('gitStaging', function() {

    test('canonical artifact list covers every machine-local runtime path (gh-628)', function() {
        assert.deepEqual(gitStaging.RUNTIME_ARTIFACT_PATHS, ALL_ARTIFACTS,
            'shared list must contain every runtime artifact (incl. .dmtools/fa-sessions)');
    });

    test('untrack commands contain no shell metacharacters the Java validator rejects (epam/dm.ai#679)', function() {
        var list = gitStaging.buildTrackedArtifactsCommand();
        var rm = gitStaging.buildUntrackPathsCommand(['.dmtools/fa-trace.log']);
        [list, rm].forEach(function(cmd) {
            ['|', ';', '&&', '||', '`', '$(', '${', '>', '<', '\n'].forEach(function(bad) {
                assert.equal(cmd.indexOf(bad), -1, JSON.stringify(cmd) + ' contains ' + JSON.stringify(bad));
            });
        });
        assert.ok(list.indexOf('git ls-files -- ') === 0, 'candidates are enumerated through git ls-files (gh-683)');
        for (var i = 0; i < ALL_ARTIFACTS.length; i++) {
            assert.contains(list, ' ' + ALL_ARTIFACTS[i], 'untrack candidate list must cover ' + ALL_ARTIFACTS[i]);
        }
        assert.contains(rm, 'git rm -r --cached --ignore-unmatch -- "\.dmtools/fa-trace.log"'.replace('\\.', '.'),
            'the rm stays --cached and --ignore-unmatch, paths quoted');
    });

    test('untrackRuntimeArtifacts: nothing tracked = ONE command, no git rm (gh-683 no-op)', function() {
        var seen = [];
        var removed = gitStaging.untrackRuntimeArtifacts(function(c) { seen.push(c); return ''; });
        assert.deepEqual(removed, []);
        assert.equal(seen.length, 1);
        assert.ok(seen[0].indexOf('git ls-files -- ') === 0);
    });

    test('untrackRuntimeArtifacts: only TRACKED artifacts are handed to git rm; foreign paths are ignored', function() {
        var seen = [];
        var removed = gitStaging.untrackRuntimeArtifacts(function(c) {
            seen.push(c);
            return c.indexOf('git ls-files') === 0
                ? '.dmtools/credential-helper.log\n.dmtools/fa-sessions/a/b.json\nsrc/not-an-artifact.txt\n'
                : '';
        });
        assert.deepEqual(removed, ['.dmtools/credential-helper.log', '.dmtools/fa-sessions/a/b.json']);
        assert.equal(seen.length, 2);
        assert.contains(seen[1], '"' + '.dmtools/credential-helper.log' + '"');
        assert.equal(seen[1].indexOf('not-an-artifact'), -1, 'a path outside the artifact list is never removed');
    });

    test('untrackRuntimeArtifacts: a failing listing propagates (callers keep their try/catch)', function() {
        assert.throws(function() {
            gitStaging.untrackRuntimeArtifacts(function() { throw new Error('git failed'); });
        }, /git failed/);
    });

    test('buildStagingPathspecs excludes every artifact, file and directory-content', function() {
        var specs = gitStaging.buildStagingPathspecs();
        for (var i = 0; i < ALL_ARTIFACTS.length; i++) {
            assert.contains(specs, '":!' + ALL_ARTIFACTS[i] + '"',
                'staging pathspec must exclude ' + ALL_ARTIFACTS[i]);
            assert.contains(specs, '":!' + ALL_ARTIFACTS[i] + '/**"',
                'staging pathspec must exclude ' + ALL_ARTIFACTS[i] + '/**');
        }
    });

    test('buildStagingPathspecs(runner): paths git ALREADY ignores are never named — gh-683 ignored-pathspec guard', function() {
        // Live fa run 37153405587 (fa gh-1206, 2026-10-03): `git add` runs its
        // ignored-pathspec guard on `:!` EXCLUSION pathspecs too — naming a
        // path that is gitignored and exists untracked kills the whole add
        // with exit 1 ("The following paths are ignored ... Use -f if you
        // really want to add them"). A repo whose .gitignore covers the
        // runtime artifacts must therefore produce staging specs WITHOUT
        // them: gitignore alone keeps `git add .` away.
        var probeCalls = [];
        var allIgnored = gitStaging.buildStagingPathspecs(function (args) {
            probeCalls.push(args.command);
            return ''; // check-ignore exit 0 = ignored — no throw
        });
        assert.equal(allIgnored, '',
            'a repo that ignores every artifact needs no runtime pathspec at all');
        assert.equal(probeCalls.length, ALL_ARTIFACTS.length,
            'one check-ignore probe per artifact');

        var someIgnored = gitStaging.buildStagingPathspecs(function (args) {
            // credential-helper.log + fa-sessions ignored, the rest not
            if (args.command.indexOf('.dmtools/credential-helper.log') !== -1 ||
                args.command.indexOf('.dmtools/fa-sessions') !== -1) {
                return '';
            }
            throw new Error('Command execution failed (exit code 1)');
        });
        assert.notContains(someIgnored, ':!.dmtools/credential-helper.log',
            'ignored path must not be named (guard)');
        assert.notContains(someIgnored, ':!.dmtools/fa-sessions',
            'ignored path must not be named (guard)');
        assert.contains(someIgnored, ':!.dmtools/fa-trace.log',
            'not-ignored path keeps its exclusion (only defense in a repo without gitignore entries)');
        assert.contains(someIgnored, ':!.dmtools-session-output.log',
            'not-ignored path keeps its exclusion');
    });

    test('buildStagingPathspecs(runner): probe failure keeps the exclusion (fail conservative)', function() {
        // A probe that itself errors (exit 128 — broken git, wrong dir)
        // must degrade to the full static list, never to "no exclusions".
        var specs = gitStaging.buildStagingPathspecs(function () {
            throw new Error('Command execution failed (exit code 128)');
        });
        for (var i = 0; i < ALL_ARTIFACTS.length; i++) {
            assert.contains(specs, '":!' + ALL_ARTIFACTS[i] + '"',
                'probe failure keeps the exclusion for ' + ALL_ARTIFACTS[i]);
        }
    });

    test('buildStagingPathspecs(runner, extraPaths): extra paths go through the SAME check-ignore probe — gh-1164 factory-kit repro', function() {
        // gh-1164 scratch-repo repro (git 2.50.1): the runner workspace has
        // factory-kit materialized AND gitignored, and git add's
        // ignored-pathspec guard fires on ANY literal pathspec naming an
        // existing ignored-untracked path — `:!` exclusions included. Every
        // staging site used to append `":!factory-kit" ":!factory-kit/**"`
        // STATICALLY after the probe-filtered runtime specs, so the timer
        // autosave died every 5 minutes (live fa runs 37153882406 +
        // 37220167230) and the dev agent's work was never committed.
        // extraPaths must be probe-filtered exactly like the runtime list:
        // ignored → dropped (gitignore keeps it out), not ignored → kept.
        var probeCalls = [];
        var allIgnored = gitStaging.buildStagingPathspecs(function (args) {
            probeCalls.push(args.command);
            return ''; // check-ignore exit 0 = ignored
        }, ['factory-kit']);
        assert.equal(allIgnored, '',
            'a repo that ignores factory-kit too needs NO pathspec at all — nothing left to trip the guard');
        assert.ok(probeCalls.some(function (c) { return c === 'git check-ignore -q -- factory-kit'; }),
            'factory-kit is probed like every runtime artifact');

        var kitNotIgnored = gitStaging.buildStagingPathspecs(function (args) {
            if (args.command.indexOf('factory-kit') !== -1) {
                throw new Error('Command execution failed (exit code 1)'); // nested repo, not ignored
            }
            return ''; // runtime artifacts ignored
        }, ['factory-kit']);
        assert.equal(kitNotIgnored, '":!factory-kit" ":!factory-kit/**"',
            'the nested-gitlink case keeps BOTH factory-kit exclusions (and only those)');
        assert.notContains(kitNotIgnored, ':!.dmtools/',
            'ignored runtime artifacts stay unnamed');

        // No runner: static legacy behavior now covers extra paths too.
        var staticSpecs = gitStaging.buildStagingPathspecs(undefined, ['factory-kit']);
        assert.contains(staticSpecs, '":!factory-kit"');
        assert.contains(staticSpecs, '":!factory-kit/**"');
        assert.contains(staticSpecs, '":!.dmtools/fa-sessions"');
    });

    test('buildExclusionPathspecs probes an arbitrary path list (gitOps/commitAndPushToBaseBranch sites)', function() {
        var kept = gitStaging.buildExclusionPathspecs(['factory-kit'], function () {
            throw new Error('Command execution failed (exit code 1)');
        });
        assert.equal(kept, '":!factory-kit" ":!factory-kit/**"',
            'not-ignored path keeps file + content exclusions');
        var dropped = gitStaging.buildExclusionPathspecs(['factory-kit'], function () { return ''; });
        assert.equal(dropped, '',
            'ignored path yields no pathspec — the guard can never fire on it');
        var legacy = gitStaging.buildExclusionPathspecs(['factory-kit']);
        assert.equal(legacy, '":!factory-kit" ":!factory-kit/**"',
            'without a runner the full static list is returned');
    });

    test('isRuntimeArtifactStatusLine flags runtime-artifact status lines only', function() {
        assert.ok(gitStaging.isRuntimeArtifactStatusLine('?? .dmtools/copilot-sessions/'),
            'untracked copilot-sessions leftover');
        assert.ok(gitStaging.isRuntimeArtifactStatusLine('?? .dmtools/credential-helper.log'),
            'untracked credential-helper.log leftover');
        assert.ok(gitStaging.isRuntimeArtifactStatusLine('D  .dmtools/fa-trace.log'),
            'staged untrack deletion');
        assert.ok(gitStaging.isRuntimeArtifactStatusLine(' M .dmtools/run-output.txt'),
            'modified run output');
        assert.ok(gitStaging.isRuntimeArtifactStatusLine('?? .dmtools/stall-capture.log'),
            'untracked stall capture');
        assert.ok(gitStaging.isRuntimeArtifactStatusLine('?? .dmtools/fa-sessions/'),
            'untracked session store');
        assert.ok(gitStaging.isRuntimeArtifactStatusLine('?? .dmtools-session-output.log'),
            'untracked timer CLI-stdout snapshot');
        assert.notOk(gitStaging.isRuntimeArtifactStatusLine('A  outputs/rca.md'),
            'real work must never be filtered');
        assert.notOk(gitStaging.isRuntimeArtifactStatusLine('?? factory-kit/'),
            'factory-kit has its own filter');
        assert.notOk(gitStaging.isRuntimeArtifactStatusLine('M  js/smAgent.js'),
            'real work must never be filtered');
        assert.notOk(gitStaging.isRuntimeArtifactStatusLine(''));
        assert.notOk(gitStaging.isRuntimeArtifactStatusLine(null));
    });
});
