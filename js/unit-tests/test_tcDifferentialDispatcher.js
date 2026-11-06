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
var LEDGERCORE = loadModule('js/common/ledgerCore.js', makeRequire({}));
var tcLedger = loadModule('js/common/tcMaintenanceLedger.js', makeRequire({ './ledgerCore.js': LEDGERCORE,
    './reviewVerdicts.js': reviewVerdicts
}));
var tcTriage = loadModule('js/common/tcTriage.js', makeRequire({}));
var tcAlternation = loadModule('js/common/tcAlternation.js', makeRequire({
    './tcRunRegistry.js': tcRunRegistry,
    './tcMaintenanceLedger.js': tcLedger
}));
var bugBookkeeping = loadModule('js/common/bugBookkeeping.js', makeRequire({
    './tcRunRegistry.js': tcRunRegistry,
    './tcMaintenanceLedger.js': tcLedger,
    './machineAuthor.js': machineAuthor
}));
var jobTicketInputs = loadModule('js/common/jobTicketInputs.js');

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

// Option readers keep the fixture builders branch-free (CRAP ratchet): optOr
// mirrors the `|| fallback` semantics, optGiven only substitutes undefined.
function optOr(opts, key, fallback) {
    return (opts && opts[key]) || fallback;
}

function optGiven(opts, key, fallback) {
    var v = opts && opts[key];
    return v === undefined ? fallback : v;
}

function parkedFinding(tcKey, opts) {
    opts = opts || {};
    return {
        tcKey: tcKey,
        role: optOr(opts, 'role', 'regression-guard'),
        verdict: 'differential-rerun',
        reason: 'rerun-requested-on-last-green-build',
        errorClass: optOr(opts, 'errorClass', 'assertion'),
        testPath: optOr(opts, 'testPath', 'testing/tests/' + tcKey + '/test.py'),
        sha: optOr(opts, 'sha', 'cafed00dbee'),
        envFingerprint: optOr(opts, 'envFingerprint', null),
        lastGreenSha: optGiven(opts, 'lastGreenSha', 'facade12345'),
        lastGreenEnvFingerprint: optOr(opts, 'lastGreenEnvFingerprint', null),
        occurrences: optOr(opts, 'occurrences', 1)
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
function throwIfTriggered(opts, cmd) {
    var throwers = opts.throwsOn || [];
    for (var i = 0; i < throwers.length; i++) {
        if (cmd.indexOf(throwers[i]) !== -1) {
            throw new Error(opts.throwMessage || ('command failed: ' + cmd));
        }
    }
    return false;
}

function failingRun(opts, cmd) {
    var failing = opts.tcFailsOn || (opts.tcFails ? 'pytest' : null);
    if (failing && cmd.indexOf(failing) !== -1) {
        throw new Error('exit code 1: 1 assertion failed');
    }
    if (cmd.indexOf('branch --show-current') !== -1) return 'bug-test-branch';
    return 'ok';
}

function fakeShell(opts) {
    opts = opts || {};
    var calls = [];
    var shell = function(args) {
        var cmd = String((args && args.command) || '');
        calls.push(args);
        throwIfTriggered(opts, cmd);
        return failingRun(opts, cmd);
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
        './common/tcAlternation.js': tcAlternation,
        './common/bugBookkeeping.js': bugBookkeeping,
        './common/jobTicketInputs.js': jobTicketInputs
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

suite('tcDifferentialDispatcher: missing ticket key (the shared jobTicketInputs guard)', function() {

    test('fails structured before any config, tracker or shell work', function() {
        var shellCalls = 0;
        var shell = function() { shellCalls++; return 'ok'; };
        var jira = {
            jira_get_ticket: function() { throw new Error('must not read the ticket'); },
            jira_get_comments: function() { throw new Error('must not read comments'); },
            jira_move_to_status: function() { throw new Error('must not move'); },
            jira_post_comment: function() { throw new Error('must not comment'); },
            jira_add_label: function() { throw new Error('must not label'); },
            jira_remove_label: function() { throw new Error('must not unlabel'); }
        };
        var mod = loadDispatcher(shell, jira, {});
        var params = dispatcherParams();
        delete params.ticket;
        var result = mod.action(params);
        assert.deepEqual(result, { success: false, error: 'missing ticket key' });
        assert.equal(shellCalls, 0, 'the guard fires before any shell work');
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
        assert.contains(cmds.join('\n'), 'git -C /repo fetch origin facade12345');
        assert.contains(cmds.join('\n'), 'git -C /repo checkout facade12345');
        assert.contains(cmds.join('\n'), 'pytest testing/tests/TS-7/test.py');
        assert.contains(cmds.join('\n'), 'git -C /repo checkout bug-test-branch');
        var checkoutIdx = cmds.map(function(c) { return c.indexOf('checkout facade12345') !== -1; }).indexOf(true);
        var runIdx = cmds.map(function(c) { return c.indexOf('pytest') !== -1; }).indexOf(true);
        var restoreIdx = cmds.map(function(c) { return c.indexOf('checkout bug-test-branch') !== -1 && c.indexOf('facade12345') === -1; }).indexOf(true);
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
        assert.deepEqual(labelNames(run.jira), ['sm_tc_differential_triggered', 'tc_differential_pending']);
        // gh-1331: the dispatcher stamps the bounce anchor into the registry
        // (the cross-lap suppression input the next lap reads)
        var registryBodies = run.jira.comments.map(function(c) { return c.comment; })
            .filter(function(b) { return String(b).indexOf('<!-- dmtools:tc-run-registry ') !== -1; });
        assert.equal(registryBodies.length, 1, 'the registry marker lands with the bounce anchor');
        var registry = tcRunRegistry.latestRegistry(
            [{ body: registryBodies[0], user: { login: 'ai-teammate' } }],
            { authorLogins: ['ai-teammate'] }).registry;
        assert.equal(registry.tcs['TS-7'].lastBounceRange, 'facade12345');
        assert.equal(registry.tcs['TS-7'].lastBounceKind, 'earned');
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
        assert.deepEqual(labelNames(run.jira), ['sm_tc_differential_triggered', 'tc_differential_pending']);
    });
});

suite('tcDifferentialDispatcher: the bounce cap escalates', function() {

    test('differential green at the cap posts the escalation and does NOT move the bug', function() {
        var run = runAction(fakeShell({}), [parkedFinding('TS-7')], { redRounds: 2 });

        assert.equal(run.result.action, 'escalated');
        assert.deepEqual(run.jira.moves, [], 'the cap stops the loop — no move');
        var body = run.jira.comments.map(function(c) { return c.comment; }).join('\n');
        assert.contains(body, 'Bounce cap reached');
        assert.deepEqual(labelNames(run.jira), ['sm_tc_differential_triggered', 'tc_differential_pending']);
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
        var shell = fakeShell({ throwsOn: ['checkout facade12345'] });
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
        var run = runAction(fakeShell({ tcFails: false, throwsOn: ['checkout facade12345'] }),
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
        assert.deepEqual(labelNames(run.jira), ['sm_tc_differential_triggered', 'tc_differential_pending']);
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
        assert.deepEqual(labelNames(run.jira), ['sm_tc_differential_triggered', 'tc_differential_pending']);
    });
});

// ── gh-1346 rework: the dispatcher manages its own trigger label ─────────────

var TRIGGER_LABEL = 'sm_tc_differential_triggered';

/** One shared-jira dispatch: returns { result, jira, shell } for follow-ups. */
function dispatchOnce(shell, findings, opts) {
    opts = opts || {};
    var jira = {
        // the ticket's comment view — mutable so follow-up rounds can park
        // fresh requests the way the automation leg would
        ticketComments: ticketComments({ findings: findings, redRounds: opts.redRounds }),
        jira_get_ticket: function(args) {
            return { fields: {
                summary: 'Checkout total wrong',
                issuetype: { name: 'Bug' },
                comment: { comments: jira.ticketComments }
            } };
        },
        jira_move_to_status: function(args) { jira.moves.push(args); },
        jira_post_comment: function(args) { jira.comments.push(args); },
        jira_add_label: function(args) { jira.labels.push(args); },
        jira_remove_label: function(args) { jira.unlabels.push(args); }
    };
    jira.moves = []; jira.comments = []; jira.labels = []; jira.unlabels = [];
    var mod = loadDispatcher(shell, jira, opts.config);
    return { result: mod.action(dispatcherParams()), jira: jira, shell: shell, mod: mod };
}

function labelNames(jira) {
    return jira.unlabels.map(function(u) { return u.label; }).sort();
}

suite('tcDifferentialDispatcher: trigger label lifecycle (the job lifts its own lock)', function() {

    test('a fully consumed dispatch removes the park label AND the trigger label', function() {
        var run = dispatchOnce(fakeShell({}), [parkedFinding('TS-7')]);
        assert.equal(run.result.action, 'bounced');
        assert.deepEqual(labelNames(run.jira), ['sm_tc_differential_triggered', 'tc_differential_pending'],
            'the job manages the trigger label full lifecycle (quotaParkProbe.liftPark pattern)');
    });

    test('nothing_parked also clears the trigger label', function() {
        var run = dispatchOnce(fakeShell({}), [parkedFinding('TS-3', { role: null })].map(function(f) {
            return Object.assign({}, f, { verdict: 'rework', reason: 'fresh-tc-first-run-validation' });
        }));
        assert.equal(run.result.action, 'nothing_parked');
        assert.deepEqual(labelNames(run.jira), ['sm_tc_differential_triggered', 'tc_differential_pending']);
    });

    test('a second park on the same bug dispatches again (the lock does not persist)', function() {
        // Round 1: TS-7 parked and consumed — the job lifts both labels.
        var shell1 = fakeShell({});
        var round1 = dispatchOnce(shell1, [parkedFinding('TS-7')]);
        assert.equal(round1.result.action, 'bounced');
        assert.contains(shell1.calls.map(function(c) { return c.command; }).join('\n'),
            'testing/tests/TS-7/test.py');

        // Round 2: the automation leg parks a NEW request on the same bug and
        // the SM rule re-adds its trigger label — the dispatcher must run
        // again (a stale trigger label would skip this tick forever).
        var jira = round1.jira;
        jira.ticketComments.push(Object.assign({}, ALLOWED_AUTHOR, { body: ledgerMarkerWith([parkedFinding('TS-9')]) }));
        var shell2 = fakeShell({});
        var mod = loadDispatcher(shell2, jira, {});
        var result = mod.action(dispatcherParams());
        assert.equal(result.action, 'bounced');
        assert.contains(shell2.calls.map(function(c) { return c.command; }).join('\n'),
            'testing/tests/TS-9/test.py', 'the second round really dispatched');
        assert.contains(labelNames(jira).join(','), 'tc_differential_pending');
    });

    test('requests still parked after the tick keep BOTH labels (in-flight guard for the retry)', function() {
        var findings = [];
        for (var i = 1; i <= 12; i++) findings.push(parkedFinding('TS-' + i));
        var run = dispatchOnce(fakeShell({}), findings);
        assert.equal(run.result.action, 'bounced');
        assert.equal(run.result.deferred, 2);
        // the park label stays (existing contract) and the trigger label stays —
        // the next tick must be able to run again for the deferred requests
        assert.deepEqual(run.jira.unlabels, []);
    });
});

// ── gh-1346 rework: unconfigured machineAuthor — fail-safe bail ──────────────

suite('tcDifferentialDispatcher: unconfigured machineAuthor allowlist', function() {

    function unconfiguredParams() {
        var params = dispatcherParams();
        delete params.jobParams.machineAuthor;
        return params;
    }

    test('an empty allowlist bails unconfigured_parked and touches NOTHING on the ticket', function() {
        var shell = fakeShell({});
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
        var mod = loadDispatcher(shell, jira, {});
        var result = mod.action(unconfiguredParams());

        assert.equal(result.success, true);
        assert.equal(result.action, 'unconfigured_parked');
        // the fail-closed parse cannot see the parked request — stripping the
        // park label would orphan it and re-open the generator leg. Only the
        // job's own trigger lock drops, so the next tick retries once the
        // allowlist is configured (no permanent lock on an unconfigured fleet).
        assert.deepEqual(jira.unlabels, [{ key: 'BUG-1', label: 'sm_tc_differential_triggered' }],
            'the park label STAYS — only the trigger lock drops for the retry');
        assert.deepEqual(jira.moves, []);
        assert.deepEqual(jira.comments, [], 'no ledger marker / report is posted');
        assert.equal(shell.calls.length, 0, 'nothing was executed');
    });

    test('a config-level machineAuthor satisfies the guard and dispatches normally', function() {
        var params = unconfiguredParams();
        var shell = fakeShell({});
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
        var mod = loadDispatcher(shell, jira, { machineAuthor: 'ai-teammate' });
        var result = mod.action(params);
        assert.equal(result.action, 'bounced', 'config.machineAuthor is the second resolution channel');
    });

    test('a jobParams machineAuthor satisfies the guard (the factory setup channel)', function() {
        var run = dispatchOnce(fakeShell({}), [parkedFinding('TS-7')]);
        assert.equal(run.result.action, 'bounced');
    });
});

// ── gh-1346 rework: ledger-controlled strings never reach the shell ──────────

suite('tcDifferentialDispatcher: sha/testPath validation before any shell command', function() {

    var validationMod = loadDispatcher(fakeShell(), {});

    test('a non-SHA lastGreenSha is unavailable — nothing is executed', function() {
        var shell = fakeShell({});
        var run = runAction(shell, [parkedFinding('TS-7', { lastGreenSha: 'main; rm -rf /' })]);
        assert.equal(run.result.action, 'stalled');
        assert.deepEqual(run.jira.moves, []);
        var cmds = shell.calls.map(function(c) { return c.command; }).join('\n');
        assert.equal(cmds.indexOf('rm -rf'), -1, 'the injected string never reached the shell');
        var body = run.jira.comments.map(function(c) { return c.comment; }).join('\n');
        assert.contains(body, 'could not run');
    });

    test('a leading-dash lastGreenSha is unavailable (git argument injection)', function() {
        var shell = fakeShell({});
        var run = runAction(shell, [parkedFinding('TS-7', { lastGreenSha: '-rf' })]);
        assert.equal(run.result.action, 'stalled');
        assert.equal(shell.calls.map(function(c) { return c.command; }).join('\n').indexOf('checkout'), -1,
            'no checkout was attempted');
    });

    test('a testPath with shell metacharacters is unavailable', function() {
        var shell = fakeShell({});
        var run = runAction(shell, [parkedFinding('TS-7', { testPath: 'tests/x.py; curl evil.sh' })]);
        assert.equal(run.result.action, 'stalled');
        var cmds = shell.calls.map(function(c) { return c.command; }).join('\n');
        assert.equal(cmds.indexOf('curl'), -1, 'the injected command never reached the shell');
        assert.equal(cmds.indexOf('pytest'), -1, 'no TC run was attempted');
    });

    test('a relative-escape or option-like testPath is unavailable', function() {
        var shell = fakeShell({});
        var run = runAction(shell, [
            parkedFinding('TS-7', { testPath: '../secrets/test.py' }),
            parkedFinding('TS-8', { testPath: '-v' })
        ]);
        assert.equal(run.result.action, 'stalled');
        var cmds = shell.calls.map(function(c) { return c.command; }).join('\n');
        assert.equal(cmds.indexOf('pytest'), -1);
        // both requests stay parked with a bumped occurrence count
        assert.equal(tcLedger.differentialRequests(run.latestLedger).length, 2);
    });

    test('safeSha / safeTestPath accept exactly the legitimate shapes', function() {
        assert.equal(validationMod.safeSha('facade12345'), 'facade12345');
        assert.equal(validationMod.safeSha('ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789A'), null, '65 hex chars');
        assert.equal(validationMod.safeSha('facade1'), 'facade1');
        assert.equal(validationMod.safeSha('facad'), null, 'shorter than 7');
        assert.equal(validationMod.safeSha('main'), null);
        assert.equal(validationMod.safeSha(null), null);
        assert.equal(validationMod.safeTestPath('testing/tests/TS-7/test.py'), 'testing/tests/TS-7/test.py');
        assert.equal(validationMod.safeTestPath('-v'), null);
        assert.equal(validationMod.safeTestPath('a b/test.py'), null);
        assert.equal(validationMod.safeTestPath('a;id/test.py'), null);
        assert.equal(validationMod.safeTestPath('../x.py'), null);
        assert.equal(validationMod.safeTestPath(null), null);
    });
});

// ── gh-1346 rework: the per-tick cap is visible in the report ────────────────

suite('tcDifferentialDispatcher: per-tick cap observability', function() {

    test('a report states how many parked requests the cap defers', function() {
        var findings = [];
        for (var i = 1; i <= 12; i++) findings.push(parkedFinding('TS-' + i));
        var run = runAction(fakeShell({}), findings);

        assert.equal(run.result.deferred, 2);
        var body = run.jira.comments.map(function(c) { return c.comment; }).join('\n');
        assert.contains(body, '10-request-per-tick cap: 2 parked request(s) deferred to the next tick.');
        // only the bounded subset was dispatched
        var runCmds = run.shell.calls.map(function(c) { return c.command; }).filter(function(c) {
            return c.indexOf('pytest') !== -1;
        });
        assert.equal(runCmds.length, 10);
        // the deferred two stay parked in the ledger digest
        assert.equal(tcLedger.differentialRequests(run.latestLedger).length, 2);
    });
});

// ── gh-1331: the dispatcher honors the cross-lap alternation suppression ──────

/** A runAction variant whose bug ticket carries EXPLICIT pre-built comments. */
function runActionWithComments(shell, comments) {
    var jira = {
        jira_get_ticket: function() {
            return { fields: {
                summary: 'Checkout total wrong',
                issuetype: { name: 'Bug' },
                comment: { comments: comments }
            } };
        },
        jira_move_to_status: function(args) { jira.moves.push(args); },
        jira_post_comment: function(args) { jira.comments.push(args); },
        jira_add_label: function(args) { jira.labels.push(args); },
        jira_remove_label: function(args) { jira.unlabels.push(args); }
    };
    jira.moves = []; jira.comments = []; jira.labels = []; jira.unlabels = [];
    var mod = loadDispatcher(shell, jira, {});
    var result = mod.action(dispatcherParams());
    var registryBodies = jira.comments.map(function(c) { return c.comment; })
        .filter(function(b) { return String(b).indexOf('<!-- dmtools:tc-run-registry ') !== -1; });
    var latestRegistry = null;
    if (registryBodies.length) {
        latestRegistry = tcRunRegistry.latestRegistry(
            [{ body: registryBodies[registryBodies.length - 1], user: { login: 'ai-teammate' } }],
            { authorLogins: ['ai-teammate'] }).registry;
    }
    return { mod: mod, result: result, jira: jira, shell: shell, latestRegistry: latestRegistry };
}

/**
 * The lap-2 dispatcher fixture: two validated guards trading reds. TS-7
 * bounced on lap 1 (red on cafed00dbee, green on facade12345); TS-8 went red
 * on a LATER build (befcafe01) and parked a differential request — the flip
 * signature is already in the registry when the dispatcher runs TS-8.
 */
function tradingPairRegistryMarker() {
    var r = tcRunRegistry.emptyRegistry();
    r = tcRunRegistry.recordGreen(r, 'TS-7', { sha: 'facade12345', envFingerprint: 'env-1', role: 'regression-guard', at: '2026-01-01T00:00:00.000Z' });
    r = tcRunRegistry.recordGreen(r, 'TS-8', { sha: 'facade12345', envFingerprint: 'env-1', role: 'regression-guard', at: '2026-01-01T00:00:00.000Z' });
    r = tcRunRegistry.recordFailure(r, 'TS-7', { sha: 'cafed00dbee', at: '2026-01-02T00:00:00.000Z', verdict: 'bounce', role: 'regression-guard' });
    r = tcRunRegistry.recordBounce(r, 'TS-7', { at: '2026-01-02T00:00:00.000Z', lastGreenSha: 'facade12345', kind: 'earned' });
    r = tcRunRegistry.recordGreen(r, 'TS-8', { sha: 'cafed00dbee', envFingerprint: 'env-1', role: 'regression-guard', at: '2026-01-03T00:00:00.000Z' });
    r = tcRunRegistry.recordFailure(r, 'TS-8', { sha: 'befcafe01', at: '2026-01-04T00:00:00.000Z', verdict: 'differential-rerun', role: 'regression-guard' });
    return tcRunRegistry.buildRegistryMarker(r);
}

suite('tcDifferentialDispatcher: gh-1331 alternation suppression', function() {

    test('AC: at most ONE bounce per contradictory pair — the dispatcher suppresses the second trade', function() {
        var comments = [{ body: tradingPairRegistryMarker(), user: { login: 'ai-teammate' } }];
        comments.push(Object.assign({}, ALLOWED_AUTHOR, {
            body: ledgerMarkerWith([parkedFinding('TS-8', { sha: 'befcafe01' })])
        }));
        var run = runActionWithComments(fakeShell({}), comments);

        // the scripted run still happened (green on facade12345)…
        var cmds = run.shell.calls.map(function(c) { return c.command; });
        assert.contains(cmds.join('\n'), 'pytest testing/tests/TS-8/test.py');
        // …but the earned bounce is suppressed: the bug is NOT moved
        assert.equal(run.result.action, 'suppressed');
        assert.deepEqual(run.jira.moves, [], 'no unbounded ping-pong — the second trade never re-bounces');
        // the suppression has its OWN route bucket — it is NOT a maintained
        // (red-on-old) finding, the report must not claim the rerun failed
        assert.deepEqual(run.result.suppressedTestCases, ['TS-8']);
        assert.deepEqual(run.result.maintainedTestCases, []);
        // the fresh pair conflict is visible in the payload (gh-1331 review)
        assert.deepEqual(run.result.conflicts, ['TS-7|TS-8']);
        var body = run.jira.comments.map(function(c) { return c.comment; }).join('\n');
        assert.contains(body, 'suppressed-contradictory-pair');
        assert.contains(body, 'loop-stop anchor owns it');
        // a suppressed bounce is the GREEN-on-old case — the maintained
        // section's "it fails there too" claim must NOT render (gh-1331 review)
        assert.notContains(body, 'fails there too');
        // ONE async escalation for the pair, with both pinned behaviors
        var escalations = run.jira.comments.map(function(c) { return c.comment; })
            .filter(function(b) { return b.indexOf('gh-1331') !== -1 && b.indexOf('contradictory-or-flaky') !== -1; });
        assert.equal(escalations.length, 1, 'a single escalation per pair');
        assert.contains(escalations[0], 'TS-7');
        assert.contains(escalations[0], 'TS-8');
        // the pair record persists for the next lap
        assert.equal(run.latestRegistry.pairs['TS-7|TS-8'].state, 'contradictory-or-flaky');
    });

    test('AC: a bounce-cap escalation stays an escalation under an open pair conflict (mirrors the automation leg)', function() {
        // the trading pair history PLUS a TS-7 registry already at the cap:
        // the dispatcher verdict for TS-7 is ESCALATE, not bounce.
        var r = tcRunRegistry.emptyRegistry();
        r = tcRunRegistry.recordGreen(r, 'TS-7', { sha: 'facade12345', envFingerprint: 'env-1', role: 'regression-guard', at: '2026-01-01T00:00:00.000Z' });
        r = tcRunRegistry.recordGreen(r, 'TS-8', { sha: 'facade12345', envFingerprint: 'env-1', role: 'regression-guard', at: '2026-01-01T00:00:00.000Z' });
        r = tcRunRegistry.recordFailure(r, 'TS-7', { sha: 'cafed00dbee', at: '2026-01-02T00:00:00.000Z', verdict: 'bounce', role: 'regression-guard' });
        r = tcRunRegistry.recordFailure(r, 'TS-7', { sha: 'cafed00dbee', at: '2026-01-02T00:00:01.000Z', verdict: 'bounce', role: 'regression-guard' });
        r = tcRunRegistry.recordGreen(r, 'TS-8', { sha: 'cafed00dbee', envFingerprint: 'env-1', role: 'regression-guard', at: '2026-01-03T00:00:00.000Z' });
        r = tcRunRegistry.recordFailure(r, 'TS-8', { sha: 'befcafe01', at: '2026-01-04T00:00:00.000Z', verdict: 'bounce', role: 'regression-guard' });
        var comments = [{ body: tcRunRegistry.buildRegistryMarker(r), user: { login: 'ai-teammate' } }];
        comments.push(Object.assign({}, ALLOWED_AUTHOR, {
            body: ledgerMarkerWith([parkedFinding('TS-7', { sha: 'cafed00dbee' })])
        }));
        var run = runActionWithComments(fakeShell({}), comments);

        assert.equal(run.result.action, 'escalated', 'the cap escalation is not converted into a suppression');
        assert.deepEqual(run.result.escalatedTestCases, ['TS-7']);
        assert.deepEqual(run.result.suppressedTestCases, [], 'no suppression — the escalation passes through ungated');
        assert.deepEqual(run.result.conflicts, [], 'the escalation lap mirrors the automation leg — no pair marking there');
        assert.deepEqual(run.jira.moves, [], 'an escalation never moves the bug');
        var body = run.jira.comments.map(function(c) { return c.comment; }).join('\n');
        assert.contains(body, 'Bounce cap reached');
        assert.notContains(body, 'suppressed-contradictory-pair');
    });

    test('without a trade history the dispatcher bounce is untouched', function() {
        var comments = [{ body: registryMarkerWith(1), user: { login: 'ai-teammate' } }];
        comments.push(Object.assign({}, ALLOWED_AUTHOR, {
            body: ledgerMarkerWith([parkedFinding('TS-7')])
        }));
        var run = runActionWithComments(fakeShell({}), comments);
        assert.equal(run.result.action, 'bounced', 'a single failure with no trade signature still earns its bounce');
        assert.deepEqual(run.jira.moves, [{ key: 'BUG-1', statusName: 'Ready For Development' }]);
    });
});

// ── gh-1354: own-oracle parked requests — the AC-gated continuation ──────────
//
// gh-1354 routes validated own-oracle reds through the mechanical table, so
// own-oracle TCs park differential requests too. The dispatcher continuation
// must carry the OWN role through: a green outcome is product-side
// attribution that hands to the AC re-check (rework) — NOT a guard's
// un-gated earned bounce.

suite('gh-1354: dispatcher own-oracle requests — the AC handoff', function() {

    var mod = loadDispatcher(fakeShell(), {});

    test('dispatcherVerdict keeps an own-oracle request OFF the guard bounce path', function() {
        var green = mod.dispatcherVerdict(parkedFinding('TS-7', { role: 'own-oracle' }), 'green', 0, 2);
        assert.equal(green.action, tcTriage.ACTION_REWORK);
        assert.equal(green.reason, 'own-oracle-ac-recheck');
        var red = mod.dispatcherVerdict(parkedFinding('TS-7', { role: 'own-oracle' }), 'red', 0, 2);
        assert.equal(red.action, tcTriage.ACTION_MAINTENANCE);
        assert.equal(red.reason, 'failure-predates-change');
    });

    test('dispatcherVerdict: own-oracle green at the cap escalates (F2 bound)', function() {
        var v = mod.dispatcherVerdict(parkedFinding('TS-7', { role: 'own-oracle' }), 'green', 2, 2);
        assert.equal(v.action, tcTriage.ACTION_ESCALATE);
        assert.equal(v.reason, 'null-ac-verdict-cap-reached');
    });

    test('AC: own-oracle green hands to the rework lane — no bounce, no bug move, request resolved', function() {
        var run = runAction(fakeShell({}), [parkedFinding('TS-7', { role: 'own-oracle' })]);

        assert.equal(run.result.success, true);
        assert.equal(run.result.action, 'rework');
        assert.deepEqual(run.result.reworkTestCases, ['TS-7']);
        assert.deepEqual(run.jira.moves, [], 'the AC re-check owns the bounce decision — the bug is untouched');

        // the parked request is consumed: the attribution completed (green on old)
        assert.equal(tcLedger.differentialRequests(run.latestLedger).length, 0);
        assert.equal(run.latestLedger.findings.length, 1);
        assert.equal(run.latestLedger.findings[0].verdict, 'rework');
        assert.equal(run.latestLedger.findings[0].reason, 'own-oracle-ac-recheck');
        assert.equal(run.latestLedger.findings[0].evidence.differential, 'green');

        var body = run.jira.comments.map(function(c) { return c.comment; }).join('\n');
        assert.contains(body, 'AC re-check');
        assert.notContains(body, 'failed with a product regression');
        assert.notContains(body, 'fails there too');
    });

    test('AC: own-oracle green at the cap escalates instead of another rework lap', function() {
        var run = runAction(fakeShell({}), [parkedFinding('TS-7', { role: 'own-oracle' })], { redRounds: 2 });

        assert.equal(run.result.action, 'escalated');
        assert.deepEqual(run.jira.moves, [], 'the cap stops the loop — no move');
        var body = run.jira.comments.map(function(c) { return c.comment; }).join('\n');
        assert.contains(body, 'Bounce cap reached');
    });

    test('AC: own-oracle red routes to maintenance like any red differential', function() {
        var run = runAction(fakeShell({ tcFails: true }), [parkedFinding('TS-7', { role: 'own-oracle' })]);

        assert.equal(run.result.action, 'maintained');
        assert.deepEqual(run.jira.moves, []);
        assert.equal(run.latestLedger.findings[0].reason, 'failure-predates-change');
    });
});

// ── gh-1354 rework: routeOne honors the hardened ACTION_DIFFERENTIAL verdict ──
//
// triageDifferentialOutcome is hardened to return ACTION_DIFFERENTIAL for any
// outcome that is not green|red ("never decide on incomplete evidence") — but
// routeOne is the verdict's only production consumer. The fail-safe must be
// symmetric: a verdict that refuses to decide RE-PARKS the request — it must
// never land in the red-on-old maintenance lane (no fabricated
// differential:'red' evidence, no "fails there too" report, no
// maintained + parked double record).

suite('gh-1354 rework: the ACTION_DIFFERENTIAL verdict re-parks, never a red-on-old claim', function() {

    // A triage stub wrapping the real module: the chosen TC's continuation
    // returns the hardened ACTION_DIFFERENTIAL verdict — the shape an
    // incomplete outcome (unavailable leaking past the early return, a null,
    // a typo) produces. Today unreachable through runDifferential (it only
    // returns green|red); the branch pins the fail-safe contract anyway.
    function triageWithDifferentialVerdict(tcKey) {
        var stub = Object.assign({}, tcTriage);
        stub.triageDifferentialOutcome = function(input) {
            var v = tcTriage.triageDifferentialOutcome(input);
            if (String(input.tcKey) === String(tcKey)) {
                return Object.assign({}, v, {
                    action: tcTriage.ACTION_DIFFERENTIAL,
                    reason: 'rerun-requested-on-last-green-build'
                });
            }
            return v;
        };
        return stub;
    }

    function runActionWithTriage(shell, triageStub, findings) {
        var jira = {
            jira_get_ticket: function() {
                return { fields: {
                    summary: 'Checkout total wrong',
                    issuetype: { name: 'Bug' },
                    comment: { comments: ticketComments({ findings: findings }) }
                } };
            },
            jira_move_to_status: function(args) { jira.moves.push(args); },
            jira_post_comment: function(args) { jira.comments.push(args); },
            jira_add_label: function(args) { jira.labels.push(args); },
            jira_remove_label: function(args) { jira.unlabels.push(args); }
        };
        jira.moves = []; jira.comments = []; jira.labels = []; jira.unlabels = [];
        var trackerModule = trackersWith(jira);
        var mod = loadModule('js/tcDifferentialDispatcher.js', makeRequire(Object.assign({}, {
            './configLoader.js': makeDefaultConfigLoaderMock({}),
            './config.js': configModule,
            './common/trackers.js': trackerModule,
            './common/tcTriage.js': triageStub,
            './common/tcMaintenanceLedger.js': tcLedger,
            './common/tcRunRegistry.js': tcRunRegistry,
            './common/tcAlternation.js': tcAlternation,
            './common/bugBookkeeping.js': bugBookkeeping,
            './common/jobTicketInputs.js': jobTicketInputs
        })), Object.assign({}, { cli_execute_command: shell }, jira));
        var result = mod.action(dispatcherParams());
        var ledgerBodies = jira.comments.map(function(c) { return c.comment; })
            .filter(function(b) { return String(b).indexOf('<!-- dmtools:tc-maintenance-ledger ') !== -1; });
        var latestLedger = null;
        if (ledgerBodies.length) {
            latestLedger = tcLedger.latestLedger([{ body: ledgerBodies[ledgerBodies.length - 1], user: { login: 'ai-teammate' } }],
                { authorLogins: ['ai-teammate'] }).ledger;
        }
        return { result: result, jira: jira, latestLedger: latestLedger };
    }

    test('an ACTION_DIFFERENTIAL verdict stalls the request — no maintenance route fires', function() {
        var run = runActionWithTriage(fakeShell({}), triageWithDifferentialVerdict('TS-7'), [parkedFinding('TS-7')]);

        assert.equal(run.result.success, true);
        assert.equal(run.result.action, 'stalled', 'the undecided verdict re-parks, it never maintains');
        assert.deepEqual(run.result.stalledTestCases, ['TS-7']);
        assert.deepEqual(run.result.maintainedTestCases, [], 'no red-on-old record for an outcome that never ran');
        assert.deepEqual(run.jira.moves, [], 'the bug state is unchanged');

        var body = run.jira.comments.map(function(c) { return c.comment; }).join('\n');
        assert.notContains(body, 'fails there too', 'the false "failure predates the change" claim must not render');
        assert.notContains(body, 'failed with a product regression');
        assert.contains(body, 'incomplete outcome', 'the stall stays visible in the report');
    });

    test('the re-parked request keeps its differential verdict and stays parked for the next tick', function() {
        var run = runActionWithTriage(fakeShell({}), triageWithDifferentialVerdict('TS-7'), [parkedFinding('TS-7')]);

        assert.ok(run.latestLedger, 'the updated ledger marker was posted');
        assert.equal(tcLedger.differentialRequests(run.latestLedger).length, 1,
            'the request is re-parked as a differential-rerun finding — the dispatcher retries next tick');
        assert.equal(run.latestLedger.findings[0].verdict, 'differential-rerun');
        assert.notEqual(run.latestLedger.findings[0].verdict, 'maintenance');
        assert.deepEqual(labelNames(run.jira), ['sm_tc_differential_triggered', 'tc_differential_pending'],
            'the park label survives — nothing was consumed');
    });
});
