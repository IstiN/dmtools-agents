/**
 * Unit tests for js/common/legStartSignal.js — the leg-start phase signal
 * builder (gh-1364).
 *
 * A dev leg answers, machine-readably, the question "can agent legs currently
 * start work on this main SHA?": ONE summary line at the setup boundary plus
 * a best-effort commit status on the head SHA the leg ran against
 * (`leg-start/ok` | `leg-start/failed`, description = branch name / reason
 * class). This module owns every fixed format and the pure classifier; the
 * IO (git probes, the GitHub status call) is wired in js/preCliDevelopmentSetup.js.
 *
 * AC coverage:
 *   AC2/AC5  reason classes are a CLOSED set (git-state | checkout | config |
 *            other): one representative error per class → correct class; an
 *            unknown error → other; precedence is deterministic (git-state
 *            beats checkout when a message mentions both).
 *   AC1      the summary line formats are exactly the ticket's:
 *            `leg-start: ok (branch <name>)` /
 *            `leg-start: failed (<reason-class>: <first error line>)`.
 *   AC2/AC3  the commit-status payload shapes: leg-start/ok (state success,
 *            description = branch name) and leg-start/failed (state failure,
 *            description = reason class), target_url only when a run URL
 *            exists, description capped at the GitHub 140-char API limit.
 *
 * Pure module — no dmtools globals, no requires.
 */

/* global loadModule, assert, test, suite */

var legStartSignal = loadModule('js/common/legStartSignal.js');

suite('legStartSignal.classifySetupError — closed reason-class set (gh-1364 AC5)', function () {

    test('git-state: dirty workspace blocking checkout', function () {
        assert.equal(legStartSignal.classifySetupError(
            'error: Your local changes to the following files would be overwritten by checkout:\n\tjs/a.js\n' +
            'Please commit your changes or stash them before you switch branches.\nAborting'),
            'git-state');
    });

    test('git-state: untracked working tree files would be overwritten', function () {
        assert.equal(legStartSignal.classifySetupError(
            'error: The following untracked working tree files would be overwritten by checkout:\n\tinput/gh-1/request.md'),
            'git-state');
    });

    test('checkout: pathspec did not match (ref/fetch problems)', function () {
        assert.equal(legStartSignal.classifySetupError(
            "fatal: pathspec 'master' did not match any file(s) known to git"), 'checkout');
    });

    test('checkout: remote ref missing on origin', function () {
        assert.equal(legStartSignal.classifySetupError(
            "fatal: couldn't find remote refs/heads/ai/gh-1364"), 'checkout');
    });

    test('checkout: fetch transport failure', function () {
        assert.equal(legStartSignal.classifySetupError(
            "fatal: unable to access 'https://example.com/acme/widgets.git/': Could not resolve host: example.com"),
            'checkout');
    });

    test('checkout: not a git repository', function () {
        assert.equal(legStartSignal.classifySetupError(
            'fatal: not a git repository (or any of the parent directories): .git'), 'checkout');
    });

    test('checkout: ambiguous argument on a missing tracking ref', function () {
        assert.equal(legStartSignal.classifySetupError(
            "fatal: ambiguous argument 'origin/develop/3.0': unknown revision or path not in the working tree."),
            'checkout');
    });

    test('config: broken branchCreateFnPath hook module', function () {
        assert.equal(legStartSignal.classifySetupError(
            "Error: Failed to require module './.dmtools/hooks/create-branch.js'"), 'config');
    });

    test('config: invalid customParams branch name template', function () {
        assert.equal(legStartSignal.classifySetupError(
            'Error: customParams.branchName template "{{invalid" failed to parse'), 'config');
    });

    test('config: config file syntax error', function () {
        assert.equal(legStartSignal.classifySetupError(
            "SyntaxError: Unexpected token '}' while parsing .dmtools/config.js"), 'config');
    });

    test('checkout: ref-race — the remote ref vanished between probe and checkout (gh-1364 review)', function () {
        assert.equal(legStartSignal.classifySetupError(
            "fatal: 'origin/dev/PROJ-1' is not a commit and a branch 'dev/PROJ-1' cannot be created from it"),
            'checkout');
    });

    test('checkout: a bare is-not-a-commit message still names the ref problem', function () {
        assert.equal(legStartSignal.classifySetupError(
            "fatal: bad revision 'origin/dev/PROJ-1' is not a commit"), 'checkout');
    });

    test('checkout: cannot-be-created-from reset failure without the is-not-a-commit phrase', function () {
        assert.equal(legStartSignal.classifySetupError(
            "fatal: a branch 'dev/PROJ-1' cannot be created from 'origin/dev/PROJ-1'"), 'checkout');
    });

    test('other: environment/setup-command failure outside the closed classes', function () {
        assert.equal(legStartSignal.classifySetupError(
            'Required setup command failed: npm ci — exit code 1'), 'other');
    });

    test('other: empty, null and undefined errors', function () {
        assert.equal(legStartSignal.classifySetupError(''), 'other');
        assert.equal(legStartSignal.classifySetupError(null), 'other');
        assert.equal(legStartSignal.classifySetupError(undefined), 'other');
    });

    test('precedence: a message naming checkout AND a path named config.js is a checkout problem', function () {
        assert.equal(legStartSignal.classifySetupError(
            "fatal: pathspec 'config.json' did not match any file(s) known to git"), 'checkout');
    });

    test('precedence: git-state wins when the message also mentions checkout', function () {
        assert.equal(legStartSignal.classifySetupError(
            'error: Your local changes ... would be overwritten by checkout'), 'git-state');
    });

    test('the reason classes exported are exactly the closed set', function () {
        assert.deepEqual(legStartSignal.REASON_CLASSES, ['git-state', 'checkout', 'config', 'other']);
    });

});

suite('legStartSignal.firstErrorLine — bounded first line', function () {

    test('multi-line git error → the first non-empty line, trimmed', function () {
        assert.equal(legStartSignal.firstErrorLine(
            '\n\nerror: Your local changes to the following files would be overwritten by checkout:\n\tjs/a.js'),
            'error: Your local changes to the following files would be overwritten by checkout:');
    });

    test('CRLF is normalized before line splitting', function () {
        assert.equal(legStartSignal.firstErrorLine('fatal: boom\r\nstack continues'), 'fatal: boom');
    });

    test('a single over-long line is capped (log/status noise guard)', function () {
        var long = new Array(500).join('x');
        var line = legStartSignal.firstErrorLine(long);
        assert.ok(line.length <= 200, 'capped at 200, got ' + line.length);
        assert.equal(line, long.substring(0, 200));
    });

    test('blank-only and null errors → empty string', function () {
        assert.equal(legStartSignal.firstErrorLine('  \n\t '), '');
        assert.equal(legStartSignal.firstErrorLine(null), '');
    });

});

suite('legStartSignal summary lines — exact ticket formats (gh-1364 AC1)', function () {

    test('ok line names the branch', function () {
        assert.equal(legStartSignal.okSummaryLine('ai/gh-1364'), 'leg-start: ok (branch ai/gh-1364)');
    });

    test('failed line carries the reason class and the first error line', function () {
        assert.equal(legStartSignal.failedSummaryLine('checkout', "fatal: pathspec 'x' did not match any file(s) known to git"),
            "leg-start: failed (checkout: fatal: pathspec 'x' did not match any file(s) known to git)");
    });

    test('failed line falls back to a placeholder when the error has no usable line', function () {
        assert.equal(legStartSignal.failedSummaryLine('other', '\n\n'), 'leg-start: failed (other: error unavailable)');
    });

});

suite('legStartSignal.buildCommitStatusArgs — commit-status payload (gh-1364 AC2/AC3)', function () {

    test('ok: leg-start/ok, state success, description is the branch name', function () {
        var args = legStartSignal.buildCommitStatusArgs({
            workspace: 'acme', repository: 'widgets',
            sha: 'f3183be0925cf2b3fe399b50323fbc533ccf223a',
            ok: true, branchName: 'ai/gh-1364'
        });
        assert.equal(args.context, 'leg-start/ok');
        assert.equal(args.state, 'success');
        assert.equal(args.description, 'ai/gh-1364');
        assert.equal(args.workspace, 'acme');
        assert.equal(args.repository, 'widgets');
        assert.equal(args.sha, 'f3183be0925cf2b3fe399b50323fbc533ccf223a');
        assert.equal(args.targetUrl, undefined, 'no run URL → no target_url key');
    });

    test('failed: leg-start/failed, state failure, description is the reason class', function () {
        var args = legStartSignal.buildCommitStatusArgs({
            workspace: 'acme', repository: 'widgets',
            sha: 'f3183be0925cf2b3fe399b50323fbc533ccf223a',
            ok: false, reasonClass: 'git-state'
        });
        assert.equal(args.context, 'leg-start/failed');
        assert.equal(args.state, 'failure');
        assert.equal(args.description, 'git-state');
    });

    test('a run URL becomes target_url', function () {
        var args = legStartSignal.buildCommitStatusArgs({
            workspace: 'a', repository: 'b', sha: 'abc', ok: true,
            branchName: 'ai/x', runUrl: 'https://example.com/a/b/actions/runs/1'
        });
        assert.equal(args.targetUrl, 'https://example.com/a/b/actions/runs/1');
    });

    test('description is capped at the GitHub 140-char API limit', function () {
        var longBranch = new Array(200).join('b');
        var args = legStartSignal.buildCommitStatusArgs({
            workspace: 'a', repository: 'b', sha: 'abc', ok: true, branchName: longBranch
        });
        assert.ok(args.description.length <= legStartSignal.STATUS_DESCRIPTION_MAX,
            'capped, got ' + args.description.length);
        assert.equal(legStartSignal.STATUS_DESCRIPTION_MAX, 140);
    });

});

suite('legStartSignal.isValidHeadSha — head-SHA validation (gh-1364 rework)', function () {

    test('a 40-char lowercase hex SHA is valid', function () {
        assert.equal(legStartSignal.isValidHeadSha('f3183be0925cf2b3fe399b50323fbc533ccf223a'), true);
    });

    test('a 7-char short SHA is valid (the abbreviated form)', function () {
        assert.equal(legStartSignal.isValidHeadSha('f3183be'), true);
    });

    test('an uppercase hex SHA is valid', function () {
        assert.equal(legStartSignal.isValidHeadSha('F3183BE0925CF2B3FE399B50323FBC533CCF223A'), true);
    });

    test('a 39-char hex token is inside the 7..40 band', function () {
        assert.equal(legStartSignal.isValidHeadSha('f3183be0925cf2b3fe399b50323fbc533ccf22'), true);
    });

    test('a 6-char token is too short', function () {
        assert.equal(legStartSignal.isValidHeadSha('f3183b'), false);
    });

    test('a 41-char token is too long', function () {
        assert.equal(legStartSignal.isValidHeadSha('f3183be0925cf2b3fe399b50323fbc533ccf223aa'), false);
    });

    test('non-hex garbage is invalid', function () {
        assert.equal(legStartSignal.isValidHeadSha('detached-head-ref'), false);
        assert.equal(legStartSignal.isValidHeadSha('HEAD detached at f3183be'), false);
    });

    test('null, undefined and empty are invalid', function () {
        assert.equal(legStartSignal.isValidHeadSha(null), false);
        assert.equal(legStartSignal.isValidHeadSha(undefined), false);
        assert.equal(legStartSignal.isValidHeadSha(''), false);
    });

});

suite('legStartSignal.resolveLegStartStatusTarget — pure posting guard chain (gh-1364 rework)', function () {

    test('no config → skip with the log-only warning', function () {
        var target = legStartSignal.resolveLegStartStatusTarget(null, 'github');
        assert.equal(target.skip, true);
        assert.equal(target.warn, 'leg-start commit status skipped: no config (line stays log-only)');
    });

    test('non-github provider → silent skip (expected on a jira/ado leg, not noise)', function () {
        var target = legStartSignal.resolveLegStartStatusTarget({ repository: { owner: 'acme', repo: 'widgets' } }, 'jira');
        assert.equal(target.skip, true);
        assert.equal(target.warn, undefined, 'no warning — a non-github tracker is the normal case');
    });

    test('github provider with no repository scope → skip with a warning', function () {
        var target = legStartSignal.resolveLegStartStatusTarget({ tracker: { provider: 'github' } }, 'github');
        assert.equal(target.skip, true);
        assert.equal(target.warn, 'leg-start commit status skipped: no repository scope in config');
    });

    test('repository without owner → skip with a warning', function () {
        var target = legStartSignal.resolveLegStartStatusTarget({ repository: { repo: 'widgets' } }, 'github');
        assert.equal(target.skip, true);
        assert.ok(target.warn, 'a warning is carried');
    });

    test('owner without repo → skip with a warning', function () {
        var target = legStartSignal.resolveLegStartStatusTarget({ repository: { owner: 'acme' } }, 'github');
        assert.equal(target.skip, true);
        assert.ok(target.warn, 'a warning is carried');
    });

    test('github provider with a full repository scope → the posting target coordinates', function () {
        var target = legStartSignal.resolveLegStartStatusTarget(
            { repository: { owner: 'acme', repo: 'widgets' } }, 'github');
        assert.equal(target.skip, undefined);
        assert.equal(target.warn, undefined);
        assert.equal(target.workspace, 'acme');
        assert.equal(target.repository, 'widgets');
    });

});
