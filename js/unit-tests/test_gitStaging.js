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

    test('buildUntrackCommand untracks every artifact via --cached --ignore-unmatch', function() {
        var cmd = gitStaging.buildUntrackCommand();
        assert.ok(cmd.indexOf('git rm -r --cached --ignore-unmatch ') === 0,
            'must be a --cached untrack (plain git rm refuses locally-appended logs)');
        for (var i = 0; i < ALL_ARTIFACTS.length; i++) {
            assert.contains(cmd, ' ' + ALL_ARTIFACTS[i],
                'untrack list must cover ' + ALL_ARTIFACTS[i]);
        }
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
