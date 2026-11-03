/**
 * Unit tests for js/tcDifferentialDispatcher.js — the gh-1345 scripted CI
 * dispatcher for parked differential rerun requests.
 *
 * The dispatcher is a local-execution SM job (JSRunner, no AI CLI): every
 * tick it picks the bugs carrying the park label, runs each parked TC on its
 * recorded last-green build (checkout the SHA, run the single TC — the run
 * is the verdict), and mechanically routes the outcome:
 *   green-on-old → earned bounce (bug → Ready For Development);
 *   red-on-old   → maintenance (failure predates the change);
 *   escalation   → the bounce cap stops the loop, a human looks;
 *   unavailable  → stays parked, the digest keeps the stall visible.
 */

var machineAuthor = loadModule('js/common/machineAuthor.js', makeRequire({}));
var reviewVerdicts = loadModule('js/common/reviewVerdicts.js', makeRequire({
    './machineAuthor.js': machineAuthor
}));
var tcRunRegistry = loadModule('js/common/tcRunRegistry.js', makeRequire({
    './reviewVerdicts.js': reviewVerdicts
}));
var tcLedger = loadModule('js/common/tcMaintenanceLedger.js', makeRequire({
    './reviewVerdicts.js': reviewVerdicts
}));
var tcTriage = loadModule('js/common/tcTriage.js', makeRequire({}));
var bugBookkeeping = loadModule('js/common/bugBookkeeping.js', makeRequire({
    './tcRunRegistry.js': tcRunRegistry,
    './tcMaintenanceLedger.js': tcLedger,
    './machineAuthor.js': machineAuthor
}));

function trackersWith(mocks) {
    return loadModule(
        'js/common/trackers.js',
        makeRequire({
            '../config.js': configModule,
            './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
        }),
        mocks || {}
    );
}

var ALLOWED_AUTHOR = { user: { login: 'ai-teammate' } };

// ── fixtures: a bug ticket carrying a parked differential request ────────────

function parkedFinding(tcKey, opts) {
    opts = opts || {};
    return {
        tcKey: tcKey,
        role: opts.role || 'regression-guard',
        verdict: 'differential-rerun',
        reason: 'rerun-requested-on-last-green-build',
        errorClass: opts.errorClass || 'assertion',
        testPath: opts.testPath || ('testing/tests/' + tcKey + '/test.py'),
        sha: opts.sha || 'sha-new',
        envFingerprint: opts.envFingerprint || null,
        lastGreenSha: opts.lastGreenSha !== undefined ? opts.lastGreenSha : 'sha-green',
        lastGreenEnvFingerprint: opts.lastGreenEnvFingerprint || null,
        occurrences: opts.occurrences || 1
    };
}

function ledgerMarkerWith(findings) {
    var l = tcLedger.emptyLedger();
    findings.forEach(function(f) {
        l = tcLedger.appendFinding(l, f);
        // refreshFinding bumps occurrences on each re-append — repeat to build
        // a finding that already went through unavailable attempts.
        var extra = (f.occurrences || 1) - 1;
        for (var i = 0; i < extra; i++) l = tcLedger.appendFinding(l, f);
    });
    return tcLedger.buildLedgerMarker(l);
}

function registryMarkerWith(redRounds) {
    var r = tcRunRegistry.emptyRegistry();
    r = tcRunRegistry.recordFailure(r, 'TS-7', { role: 'regression-guard', verdict: 'differential-rerun' });
    for (var i = 1; i < redRounds; i++) {
        r = tcRunRegistry.recordFailure(r, 'TS-7', { role: 'regression-guard', verdict: 'differential-rerun' });
    }
    return tcRunRegistry.buildRegistryMarker(r);
}

function ticketComments(opts) {
    opts = opts || {};
    var comments = [];
    if (opts.redRounds) comments.push(Object.assign({}, ALLOWED_AUTHOR, { body: registryMarkerWith(opts.redRounds) }));
    if (opts.findings && opts.findings.length) {
        comments.push(Object.assign({}, ALLOWED_AUTHOR, { body: ledgerMarkerWith(opts.findings) }));
    }
    return comments;
}

// ── the scripted CI (cli_execute_command mock) ────────────────────────────────

/**
 * The fake shell: every command is recorded; the TC run command fails when
 * the command contains `tcFailsOn` (default: any pytest run); any command
 * whose text contains a `throwsOn` substring throws (the git-level failure —
 * a checkout of an unknown SHA, say).
 */
function fakeShell(opts) {
    opts = opts || {};
    var calls = [];
    var shell = function(args) {
        var cmd = String((args && args.command) || '');
        calls.push(args);
        var throwers = opts.throwsOn || [];
        for (var i = 0; i < throwers.length; i++) {
            if (cmd.indexOf(throwers[i]) !== -1) {
                throw new Error(opts.throwMessage || ('command failed: ' + cmd));
            }
        }
        var failing = opts.tcFailsOn || (opts.tcFails ? 'pytest' : null);
        if (failing && cmd.indexOf(failing) !== -1) {
            throw new Error('exit code 1: 1 assertion failed');
        }
        if (cmd.indexOf('branch --show-current') !== -1) return 'bug-test-branch';
        return 'ok';
    };
    shell.calls = calls;
    return shell;
}

function loadDispatcher(shell, jiraMocks, configExtra) {
    var trackerModule = trackersWith(jiraMocks || {});
    return loadModule('js/tcDifferentialDispatcher.js', makeRequire(Object.assign({}, {
        './configLoader.js': makeDefaultConfigLoaderMock(configExtra || {}),
        './config.js': configModule,
        './common/trackers.js': trackerModule,
        './common/tcTriage.js': tcTriage,
        './common/tcMaintenanceLedger.js': tcLedger,
        './common/tcRunRegistry.js': tcRunRegistry,
        './common/bugBookkeeping.js': bugBookkeeping
    })), Object.assign({}, { cli_execute_command: shell }, jiraMocks || {}));
}

function dispatcherParams(overrides) {
    return Object.assign({
        ticket: { key: 'BUG-1', fields: { summary: 'Checkout total wrong', issuetype: { name: 'Bug' } } },
        jobParams: {
            machineAuthor: 'ai-teammate',
            customParams: {
                workingDir: '/repo',
                tcRunCommand: 'pytest {testPath}'
            }
        }
    }, overrides || {});
}

suite('tcDifferentialDispatcher: pure helpers', function() {

    var mod = loadDispatcher(fakeShell(), {});

    test('buildRunCommand substitutes the {testPath} placeholder', function() {
        assert.equal(mod.buildRunCommand('pytest {testPath} -v', 'testing/tests/TS-7/test.py'),
            'pytest testing/tests/TS-7/test.py -v');
    });

    test('buildRunCommand is null without a template or without a script path', function() {
        assert.equal(mod.buildRunCommand(null, 'x.py'), null);
        assert.equal(mod.buildRunCommand('', 'x.py'), null);
        assert.equal(mod.buildRunCommand('pytest {testPath}', null), null);
    });

    test('dispatcherVerdict maps green/red through the triage table', function() {
        var green = mod.dispatcherVerdict(parkedFinding('TS-7'), 'green', 0, 2);
        assert.equal(green.action, tcTriage.ACTION_BOUNCE);
        var red = mod.dispatcherVerdict(parkedFinding('TS-7'), 'red', 0, 2);
        assert.equal(red.action, tcTriage.ACTION_MAINTENANCE);
        assert.equal(red.reason, 'failure-predates-change');
    });

    test('dispatcherVerdict keeps a sibling request off this bug bounce path', function() {
        var v = mod.dispatcherVerdict(parkedFinding('TS-7', { role: 'sibling-guard' }), 'green', 0, 2);
        assert.equal(v.action, tcTriage.ACTION_MAINTENANCE);
        assert.equal(v.reason, 'sibling-regression-owner-notified');
    });
});

// ── the scripted flow ─────────────────────────────────────────────────────────

function runAction(shell, findings, opts) {
    opts = opts || {};
    var jira = {
        jira_get_ticket: function(args) {
            return { fields: {
                summary: 'Checkout total wrong',
                issuetype: { name: 'Bug' },
                comment: { comments: ticketComments({ findings: findings, redRounds: opts.redRounds }) }
            } };
        },
        jira_move_to_status: function(args) { jira.moves.push(args); },
        jira_post_comment: function(args) { jira.comments.push(args); },
        jira_add_label: function(args) { jira.labels.push(args); },
        jira_remove_label: function(args) { jira.unlabels.push(args); }
    };
    jira.moves = []; jira.comments = []; jira.labels = []; jira.unlabels = [];
    var mod = loadDispatcher(shell, jira, opts.config);
    var result = mod.action(dispatcherParams());
    // expose the newest posted ledger marker for follow-up assertions
    var ledgerBodies = jira.comments.map(function(c) { return c.comment; })
        .filter(function(b) { return String(b).indexOf('<!-- dmtools:tc-maintenance-ledger ') !== -1; });
    var latestLedger = null;
    if (ledgerBodies.length) {
        latestLedger = tcLedger.latestLedger([{ body: ledgerBodies[ledgerBodies.length - 1], user: { login: 'ai-teammate' } }],
            { authorLogins: ['ai-teammate'] }).ledger;
    }
    return { mod: mod, result: result, jira: jira, shell: shell, latestLedger: latestLedger };
}

suite('tcDifferentialDispatcher: green-on-old — the earned bounce', function() {

    test('AC1: the TC runs on lastGreenSha, the bug bounces without manual steps', function() {
        var shell = fakeShell({});
        var run = runAction(shell, [parkedFinding('TS-7')]);

        assert.equal(run.result.success, true);
        assert.equal(run.result.action, 'bounced');

        // the scripted run: fetch → checkout the SHA → run the single TC → restore
        var cmds = shell.calls.map(function(c) { return c.command; });
        assert.contains(cmds.join('\n'), 'git -C /repo fetch origin sha-green');
        assert.contains(cmds.join('\n'), 'git -C /repo checkout sha-green');
        assert.contains(cmds.join('\n'), 'pytest testing/tests/TS-7/test.py');
        assert.contains(cmds.join('\n'), 'git -C /repo checkout bug-test-branch');
        var checkoutIdx = cmds.map(function(c) { return c.indexOf('checkout sha-green') !== -1; }).indexOf(true);
        var runIdx = cmds.map(function(c) { return c.indexOf('pytest') !== -1; }).indexOf(true);
        var restoreIdx = cmds.map(function(c) { return c.indexOf('checkout bug-test-branch') !== -1 && c.indexOf('sha-green') === -1; }).indexOf(true);
        assert.ok(checkoutIdx !== -1 && runIdx !== -1 && restoreIdx !== -1, 'checkout → run → restore in order');
        assert.ok(checkoutIdx < runIdx && runIdx < restoreIdx);

        // the run runs inside the configured working directory
        assert.equal(shell.calls[runIdx].workingDirectory, '/repo');

        // the earned bounce: bug back to development with the attribution comment
        assert.deepEqual(run.jira.moves, [{ key: 'BUG-1', statusName: 'Ready For Development' }]);
        var body = run.jira.comments.map(function(c) { return c.comment; }).join('\n');
        assert.contains(body, 'failed with a product regression');
        assert.contains(body, 'TS-7');
        assert.contains(body, 'differential rerun on the last-green build: green');
    });

    test('AC: the request is resolved in the ledger and the park label is cleared', function() {
        var run = runAction(fakeShell({}), [parkedFinding('TS-7')]);

        assert.ok(run.latestLedger, 'the updated ledger marker was posted');
        assert.equal(tcLedger.differentialRequests(run.latestLedger).length, 0);
        assert.deepEqual(run.jira.unlabels, [{ key: 'BUG-1', label: 'tc_differential_pending' }]);
        // the run registry is NOT rewritten by the dispatcher (the red streak
        // that created the request stays the bounce-cap input)
        var registryBodies = run.jira.comments.map(function(c) { return c.comment; })
            .filter(function(b) { return String(b).indexOf('<!-- dmtools:tc-run-registry ') !== -1; });
        assert.equal(registryBodies.length, 0);
    });
});

suite('tcDifferentialDispatcher: red-on-old — failure predates the change', function() {

    test('AC1: the ledger route fires without manual steps, the bug is untouched', function() {
        var run = runAction(fakeShell({ tcFails: true }), [parkedFinding('TS-7')]);

        assert.equal(run.result.success, true);
        assert.equal(run.result.action, 'maintained');
        assert.deepEqual(run.jira.moves, [], 'no bounce — the bug state is unchanged');

        var body = run.jira.comments.map(function(c) { return c.comment; }).join('\n');
        assert.contains(body, 'failure predates the change');

        // the request became an open maintenance finding with the red differential evidence
        assert.equal(tcLedger.differentialRequests(run.latestLedger).length, 0);
        assert.equal(run.latestLedger.findings.length, 1);
        assert.equal(run.latestLedger.findings[0].verdict, 'maintenance');
        assert.equal(run.latestLedger.findings[0].reason, 'failure-predates-change');
        assert.equal(run.latestLedger.findings[0].evidence.differential, 'red');
        assert.deepEqual(run.jira.unlabels, [{ key: 'BUG-1', label: 'tc_differential_pending' }]);
    });
});

suite('tcDifferentialDispatcher: the bounce cap escalates', function() {

    test('differential green at the cap posts the escalation and does NOT move the bug', function() {
        var run = runAction(fakeShell({}), [parkedFinding('TS-7')], { redRounds: 2 });

        assert.equal(run.result.action, 'escalated');
        assert.deepEqual(run.jira.moves, [], 'the cap stops the loop — no move');
        var body = run.jira.comments.map(function(c) { return c.comment; }).join('\n');
        assert.contains(body, 'Bounce cap reached');
        assert.deepEqual(run.jira.unlabels, [{ key: 'BUG-1', label: 'tc_differential_pending' }]);
    });
});

suite('tcDifferentialDispatcher: sibling requests never bounce this bug', function() {

    test('a sibling green-on-old routes to owner-notified maintenance', function() {
        var run = runAction(fakeShell({}), [parkedFinding('TS-7', { role: 'sibling-guard' })]);

        assert.equal(run.result.action, 'maintained');
        assert.deepEqual(run.jira.moves, []);
        assert.equal(run.latestLedger.findings[0].reason, 'sibling-regression-owner-notified');
    });
});

suite('tcDifferentialDispatcher: unavailable — the stall stays visible', function() {

    test('a missing tcRunCommand keeps the request parked and explains itself once', function() {
        var params = dispatcherParams();
        delete params.jobParams.customParams.tcRunCommand;
        var jira = {
            jira_get_ticket: function() {
                return { fields: { issuetype: { name: 'Bug' },
                    comment: { comments: ticketComments({ findings: [parkedFinding('TS-7')] }) } } };
            },
            jira_move_to_status: function(args) { jira.moves.push(args); },
            jira_post_comment: function(args) { jira.comments.push(args); },
            jira_remove_label: function(args) { jira.unlabels.push(args); }
        };
        jira.moves = []; jira.comments = []; jira.unlabels = [];
        var mod = loadDispatcher(fakeShell({}), jira);
        var result = mod.action(params);

        assert.equal(result.success, true);
        assert.equal(result.action, 'stalled');
        assert.deepEqual(jira.moves, []);
        var body = jira.comments.map(function(c) { return c.comment; }).join('\n');
        assert.contains(body, 'tcRunCommand');
        // still parked — the label stays so the next tick retries
        assert.deepEqual(jira.unlabels, []);
        // the ledger bump keeps the stall in the digest (occurrences advanced)
        var markers = jira.comments.map(function(c) { return c.comment; })
            .filter(function(b) { return String(b).indexOf('<!-- dmtools:tc-maintenance-ledger ') !== -1; });
        assert.equal(markers.length, 1, 'the ledger bump was posted');
        var parsed = tcLedger.latestLedger([{ body: markers[0], user: { login: 'ai-teammate' } }],
            { authorLogins: ['ai-teammate'] }).ledger;
        assert.equal(parsed.findings[0].occurrences, 2);
        assert.equal(tcLedger.differentialRequests(parsed).length, 1);
    });

    test('a checkout failure is unavailable, not a red verdict', function() {
        var shell = fakeShell({ throwsOn: ['checkout sha-green'] });
        var run = runAction(shell, [parkedFinding('TS-7')]);
        assert.equal(run.result.action, 'stalled');
        assert.deepEqual(run.jira.moves, []);
        var body = run.jira.comments.map(function(c) { return c.comment; }).join('\n');
        assert.contains(body, 'could not run');
    });

    test('a request without a recorded lastGreenSha is unavailable', function() {
        var run = runAction(fakeShell({}), [parkedFinding('TS-7', { lastGreenSha: null })]);
        assert.equal(run.result.action, 'stalled');
        assert.deepEqual(run.jira.moves, []);
    });

    test('a REPEAT unavailable attempt posts no new comment (spam bound)', function() {
        var run = runAction(fakeShell({ tcFails: false, throwsOn: ['checkout sha-green'] }),
            [parkedFinding('TS-7', { occurrences: 2 })]);
        var bodyComments = run.jira.comments.map(function(c) { return c.comment; })
            .filter(function(b) { return String(b).indexOf('dmtools:tc-maintenance-ledger') === -1; });
        assert.equal(bodyComments.length, 0, 'no stall comment on a repeat attempt');
    });
});

suite('tcDifferentialDispatcher: several parked requests in one run', function() {

    test('mixed green + red: one bounce AND one maintenance route, one move', function() {
        var shell = fakeShell({ tcFailsOn: 'TS-8' });
        var run = runAction(shell, [
            parkedFinding('TS-7'),
            parkedFinding('TS-8', { testPath: 'testing/tests/TS-8/test.py' })
        ]);

        // the TC run for the SECOND request fails (per-path scripting)
        assert.equal(run.result.action, 'mixed');

        var body = run.jira.comments.map(function(c) { return c.comment; }).join('\n');
        assert.contains(body, 'TS-7');
        assert.contains(body, 'TS-8');
        // exactly ONE bounce move even though two requests were dispatched
        assert.equal(run.jira.moves.length, 1);
        assert.deepEqual(run.jira.moves, [{ key: 'BUG-1', statusName: 'Ready For Development' }]);
        // both consumed — nothing stays parked, the label clears
        assert.equal(tcLedger.differentialRequests(run.latestLedger).length, 0);
        assert.deepEqual(run.jira.unlabels, [{ key: 'BUG-1', label: 'tc_differential_pending' }]);
        // the red sibling request landed as an open maintenance finding
        assert.equal(run.latestLedger.findings.filter(function(f) {
            return f.tcKey === 'TS-8' && f.verdict === 'maintenance';
        }).length, 1);
    });

    test('the scripted command targets each request own script path', function() {
        var shell = fakeShell({});
        runAction(shell, [
            parkedFinding('TS-7'),
            parkedFinding('TS-8', { testPath: 'testing/tests/TS-8/test.py' })
        ]);
        var runCmds = shell.calls.map(function(c) { return c.command; }).filter(function(c) {
            return c.indexOf('pytest') !== -1;
        });
        assert.equal(runCmds.length, 2);
        assert.contains(runCmds[0], 'testing/tests/TS-7/test.py');
        assert.contains(runCmds[1], 'testing/tests/TS-8/test.py');
    });
});

suite('tcDifferentialDispatcher: nothing parked', function() {

    test('a bug without parked requests just clears the label', function() {
        var run = runAction(fakeShell({}), [parkedFinding('TS-3', { role: null })].map(function(f) {
            // a NON-differential finding: rework verdict stays open
            return Object.assign({}, f, { verdict: 'rework', reason: 'fresh-tc-first-run-validation' });
        }));
        assert.equal(run.result.action, 'nothing_parked');
        assert.deepEqual(run.jira.moves, []);
        assert.deepEqual(run.jira.unlabels, [{ key: 'BUG-1', label: 'tc_differential_pending' }]);
    });
});
