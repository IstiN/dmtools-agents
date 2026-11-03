/**
 * tcDifferentialDispatcher.js — the gh-1345 scripted CI dispatcher for parked
 * differential rerun requests (gh-1329 follow-up).
 *
 * gh-1329 ships the mechanical triage: when a validated guard fails and the
 * fingerprints prove nothing, the automation leg PARKS a differential rerun
 * request in the maintenance ledger (fail-safe: no unattributed bounces).
 * This job is the missing dispatcher: a local-execution SM job (JSRunner —
 * no AI CLI, the run is the verdict) that
 *
 *   1. reads the bug's parked differential requests (tcMaintenanceLedger);
 *   2. for each: checkout the recorded last-green build (lastGreenSha), run
 *      the single TC script (customParams.tcRunCommand, {testPath}
 *      placeholder), restore the branch — a scripted CI run that varies ONLY
 *      the build;
 *   3. routes the outcome mechanically (tcTriage.triageDifferentialOutcome):
 *        green-on-old → earned bounce (bug → Ready For Development, the
 *                        attribution comment names the evidence);
 *        red-on-old   → maintenance (the failure predates the change — the
 *                        request finding reopens as sweep debt);
 *        cap reached  → owner escalation, the loop stops itself;
 *        sibling      → owner-notified maintenance (never THIS bug's bounce);
 *        unavailable  → stays parked, one explanation comment, the stall
 *                        stays visible in every ledger digest.
 *   4. posts the updated ledger marker (the parked section disappears as the
 *      dispatcher consumes the requests) and clears the park label when
 *      nothing remains parked.
 *
 * customParams:
 *   workingDir        — the target-repo checkout the TC scripts run in
 *                       (default: config.workingDir, else the current dir);
 *   tcRunCommand      — the single-TC command template with a {testPath}
 *                       placeholder (e.g. "pytest {testPath}"). Required:
 *                       without it the requests stay parked (fail-safe) and
 *                       the ticket carries one explanation comment;
 *   maxReworkRounds   — the bounce cap (default: tcTriage default);
 *   parkLabel         — the SM-matching label (default tc_differential_pending).
 *
 * GraalJS-clean (var + plain functions, JSON-safe data); every require is
 * hoisted (gh-823). Tests: js/unit-tests/test_tcDifferentialDispatcher.js.
 */
'use strict';

var configLoader = require('./configLoader.js');
const { resolveStatuses } = require('./config.js');
var tcTriage = require('./common/tcTriage.js');
var tcMaintenanceLedger = require('./common/tcMaintenanceLedger.js');
var tcRunRegistry = require('./common/tcRunRegistry.js');
var bugBookeeping = require('./common/bugBookkeeping.js');

// Tracker-agnostic ticket operations (jira / ado / github) — created lazily per action() run.
var trackersModule = require('./common/trackers.js');
var trackerHolder = trackersModule.createTrackerHolder();
var initTracker = trackerHolder.initTracker;
var getTracker = trackerHolder.getTracker;

var PARK_LABEL_DEFAULT = 'tc_differential_pending';
var MAX_DISPATCHES_PER_TICK = 10;
var COMMAND_OUTPUT_TAIL = 200;
var RESOLVE_VIA_GREEN = 'differential-rerun-dispatcher:green-on-last-green';

// ── inputs (the quotaParkProbe resolveInputs shape) ──────────────────────────

function resolveInputs(params) {
    var actualParams = params.ticket ? params : (params.jobParams || params);
    var jobParams = params.jobParams || {};
    return {
        ticketKey: actualParams.ticket && actualParams.ticket.key,
        jobParams: jobParams,
        customParams: jobParams.customParams || actualParams.customParams || {}
    };
}

function parkLabelOf(customParams) {
    return String(customParams.parkLabel || PARK_LABEL_DEFAULT);
}

function workingDirOf(customParams, config) {
    return customParams.workingDir || (config && config.workingDir) || null;
}

function maxReworkRoundsOf(customParams) {
    var n = parseInt(customParams.maxReworkRounds, 10);
    return n > 0 ? n : tcTriage.DEFAULT_MAX_REWORK_ROUNDS;
}

// ── the scripted run (the verdict) ────────────────────────────────────────────

/**
 * The single-TC command for one request: the template with the {testPath}
 * placeholder substituted. Null when the deployment configured no template
 * or the request carries no script path (fail-safe: nothing is guessed).
 */
function buildRunCommand(template, testPath) {
    var t = String(template || '').trim();
    var p = String(testPath || '').trim();
    if (!t || !p) return null;
    return t.replace('{testPath}', p);
}

function runShell(command, workingDir) {
    var args = { command: command };
    if (workingDir) args.workingDirectory = workingDir;
    return cli_execute_command(args);
}

function commandTail(error) {
    return String((error && error.message) || error)
        .replace(/\s+/g, ' ').trim().substring(0, COMMAND_OUTPUT_TAIL);
}

function gitCommand(command, workingDir) {
    var prefix = workingDir ? ('git -C ' + workingDir) : 'git';
    return prefix + ' ' + command;
}

function bestEffort(command, workingDir) {
    try {
        return runShell(command, workingDir);
    } catch (e) {
        console.warn('Dispatcher step failed (non-fatal):', command, '—', commandTail(e));
        return null;
    }
}

/**
 * Runs one parked request on its last-green build.
 * Returns { outcome: 'green'|'red', command } or
 *         { outcome: 'unavailable', detail } (nothing was decided).
 */
function runDifferential(request, workingDir, runTemplate) {
    var sha = request.lastGreenSha;
    if (!sha) {
        return { outcome: 'unavailable', detail: 'the request carries no lastGreenSha — nothing to checkout' };
    }
    var command = buildRunCommand(runTemplate, request.testPath);
    if (!command) {
        return { outcome: 'unavailable',
            detail: 'no tcRunCommand configured — set customParams.tcRunCommand (a template with a {testPath} placeholder)' };
    }

    var checkout = gitCommand('checkout ' + sha, workingDir);
    var restore = null;
    try {
        var branchOut = runShell(gitCommand('branch --show-current', workingDir), workingDir);
        var branch = String(branchOut || '').trim().split('\n')[0].trim();
        if (branch) restore = gitCommand('checkout ' + branch, workingDir);
    } catch (e) {
        console.warn('Could not read the current branch (no restore step):', commandTail(e));
    }

    // best effort: a shallow/sparse clone may not know the old SHA yet.
    bestEffort(gitCommand('fetch origin ' + sha, workingDir), workingDir);

    try {
        runShell(checkout, workingDir);
    } catch (e) {
        return { outcome: 'unavailable', detail: 'checkout of ' + sha + ' failed: ' + commandTail(e) };
    }

    var outcome;
    try {
        runShell(command, workingDir);
        outcome = 'green';
    } catch (e) {
        // the run is the verdict — a red run on the old build is evidence,
        // the failure summary travels with the route.
        outcome = 'red';
        console.warn('TC red on the last-green build:', commandTail(e));
    }
    if (restore) bestEffort(restore, workingDir);
    return { outcome: outcome, command: command };
}

// ── mechanical routing (tcTriage continuation) ───────────────────────────────

/**
 * The triage verdict for one dispatcher outcome: the parked request's
 * recorded evidence + the scripted run's verdict. Guards and siblings keep
 * their role (a sibling green-on-old never bounces THIS bug); a roleless
 * request defaults to guard (only validated guards ever park a request).
 */
function dispatcherVerdict(request, outcome, redRounds, maxReworkRounds) {
    return tcTriage.triageDifferentialOutcome({
        tcKey: request.tcKey,
        role: request.role === 'sibling-guard' ? tcTriage.ROLE_SIBLING : tcTriage.ROLE_GUARD,
        validated: true,
        current: { sha: request.sha || null, envFingerprint: request.envFingerprint || null },
        lastGreen: { sha: request.lastGreenSha || null, envFingerprint: request.lastGreenEnvFingerprint || null },
        differential: outcome,
        redRounds: redRounds,
        maxReworkRounds: maxReworkRounds,
        errorClass: request.errorClass || 'unknown',
        testPath: request.testPath || '',
        failureSummary: request.failureSummary || null
    });
}

/**
 * The ledger bump for an unavailable attempt: the SAME finding identity
 * refreshes (occurrences advance — the stall stays visible in every digest
 * without duplicating).
 */
function unavailableBump(request, detail) {
    return {
        tcKey: request.tcKey,
        role: request.role || null,
        verdict: tcMaintenanceLedger.VERDICT_DIFFERENTIAL,
        reason: request.reason || 'rerun-requested-on-last-green-build',
        errorClass: request.errorClass || 'unknown',
        testPath: request.testPath || '',
        note: 'dispatcher could not run: ' + detail,
        sha: request.sha || null,
        envFingerprint: request.envFingerprint || null,
        lastGreenSha: request.lastGreenSha || null,
        lastGreenEnvFingerprint: request.lastGreenEnvFingerprint || null
    };
}

/**
 * The ledger entry for a red-on-old outcome: the same identity refreshes and
 * REOPENS as maintenance debt (the failure predates the change — a sweep PR
 * owns it now).
 */
function maintenanceEntry(request, verdict) {
    var entry = verdict.ledgerEntry || {};
    return {
        tcKey: request.tcKey,
        role: request.role || null,
        verdict: entry.verdict || 'maintenance',
        reason: entry.reason || 'failure-predates-change',
        errorClass: request.errorClass || 'unknown',
        testPath: request.testPath || '',
        sha: request.sha || null,
        envFingerprint: request.envFingerprint || null,
        lastGreenSha: request.lastGreenSha || null,
        lastGreenEnvFingerprint: request.lastGreenEnvFingerprint || null,
        evidence: 'differential rerun on ' + (request.lastGreenSha || 'the last-green build') + ': red'
    };
}

// ── tracker side effects (quiet — never fail the tick on a write) ────────────

function postCommentQuietly(tracker, ticketKey, comment) {
    if (!comment) return;
    try {
        tracker.postComment(ticketKey, comment);
    } catch (e) {
        console.warn('Failed to post the dispatcher comment (non-fatal):', e);
    }
}

function removeLabelQuietly(tracker, ticketKey, label) {
    try {
        tracker.removeLabel(ticketKey, label);
        console.log('✅ Removed', label, 'from', ticketKey);
    } catch (e) {
        console.warn('Failed to remove ' + label + ' (non-fatal):', e);
    }
}

function postMarkerQuietly(tracker, ticketKey, changed, marker, label) {
    if (!changed || !marker) return;
    try {
        tracker.postComment(ticketKey, marker);
        console.log('✅ Posted', label, 'marker to', ticketKey);
    } catch (e) {
        console.warn('Failed to post', label, 'marker (non-fatal):', e);
    }
}

function moveBugToDevelopmentQuietly(tracker, ticketKey, statuses) {
    try {
        tracker.moveToStatus(ticketKey, statuses.READY_FOR_DEVELOPMENT);
        console.log('✅ Moved', ticketKey, 'to', statuses.READY_FOR_DEVELOPMENT, '(earned bounce)');
    } catch (e) {
        console.warn('Failed to move the bug to development (non-fatal):', e);
    }
}

// ── the report ────────────────────────────────────────────────────────────────

/**
 * One dispatcher report per bug: the mechanical routes rendered by the same
 * surfaces the automation leg uses (bounce / escalation) plus the ledger
 * digest (the parked section — remaining stalls stay visible).
 */
function buildReportComment(bounced, escalated, maintained, stalled, ledger) {
    var sections = [];
    if (bounced.length) sections.push(tcTriage.buildBounceComment(bounced));
    if (escalated.length) sections.push(tcTriage.buildEscalationComment(escalated));
    if (maintained.length) sections.push('The scripted differential rerun (gh-1345) ran the failing TC on its last-green build and it fails there too — ' +
        'the failure predates the change; the finding stays in the TC maintenance ledger.');
    stalled.forEach(function(s) {
        sections.push('The differential rerun for ' + s.tcKey + ' could not run' +
            (s.detail ? ' — ' + s.detail : '') + '. The request stays parked and visible in the maintenance-ledger digest.');
    });
    sections.push(tcMaintenanceLedger.buildDigestComment(ledger));
    return sections.join('\n\n');
}

function routeNameOf(bounced, escalated, maintained, stalled) {
    var routes = (bounced.length ? 1 : 0) + (escalated.length ? 1 : 0) +
        (maintained.length ? 1 : 0) + (stalled.length ? 1 : 0);
    if (routes > 1) return 'mixed';
    if (bounced.length) return 'bounced';
    if (escalated.length) return 'escalated';
    if (maintained.length) return 'maintained';
    return 'stalled';
}

// ── the action ────────────────────────────────────────────────────────────────

function dispatchRequests(requests, vars) {
    var bounced = [], escalated = [], maintained = [], stalled = [];
    var bounded = requests.slice(0, MAX_DISPATCHES_PER_TICK);
    bounded.forEach(function(request) {
        var run = runDifferential(request, vars.workingDir, vars.runTemplate);
        if (run.outcome === 'unavailable') {
            // one explanation per stall; the occurrences bump keeps later
            // quiet attempts from spamming the ticket.
            if ((request.occurrences || 1) > 1) {
                vars.ledger = tcMaintenanceLedger.appendFinding(vars.ledger, unavailableBump(request, run.detail));
                console.log('⏳ Differential request for', request.tcKey, 'still unavailable — stays parked (quiet)');
                return;
            }
            vars.ledger = tcMaintenanceLedger.appendFinding(vars.ledger, unavailableBump(request, run.detail));
            stalled.push({ tcKey: request.tcKey, detail: run.detail });
            return;
        }
        var verdict = dispatcherVerdict(request, run.outcome,
            tcRunRegistry.redRoundsOf(vars.registry, request.tcKey), vars.maxRework);
        console.log('Differential outcome for', request.tcKey, 'on the last-green build:', run.outcome, '→', verdict.action);
        if (verdict.action === tcTriage.ACTION_BOUNCE || verdict.action === tcTriage.ACTION_ESCALATE) {
            // the request is consumed — the bounce/escalation is the record
            vars.ledger = tcMaintenanceLedger.resolveFindings(vars.ledger, [request.id], RESOLVE_VIA_GREEN);
            if (verdict.action === tcTriage.ACTION_BOUNCE) bounced.push(verdict);
            else escalated.push(verdict);
        } else {
            vars.ledger = tcMaintenanceLedger.appendFinding(vars.ledger, maintenanceEntry(request, verdict));
            maintained.push(verdict);
        }
    });
    return { bounced: bounced, escalated: escalated, maintained: maintained, stalled: stalled };
}

function action(params) {
    var inputs = resolveInputs(params);
    var ticketKey = inputs.ticketKey;
    if (!ticketKey) {
        console.error('No ticket key found');
        return { success: false, error: 'missing ticket key' };
    }
    var config = configLoader.loadProjectConfig(inputs.jobParams || params);
    initTracker(config, inputs.customParams);
    var tracker = getTracker();

    var parkLabel = parkLabelOf(inputs.customParams);
    var vars = {
        workingDir: workingDirOf(inputs.customParams, config),
        runTemplate: inputs.customParams.tcRunCommand || null,
        maxRework: maxReworkRoundsOf(inputs.customParams),
        registry: null,
        ledger: null
    };

    console.log('=== TC differential dispatcher for', ticketKey, '===');

    var bookkeeping = bugBookeeping.loadBugBookeeping(tracker, ticketKey, params, config);
    vars.registry = bookkeeping.registry;
    vars.ledger = bookkeeping.ledger;

    console.log('DBG ledger type:', typeof tcMaintenanceLedger, 'fn:', typeof tcMaintenanceLedger.differentialRequests, 'marker fn:', typeof tcMaintenanceLedger.buildLedgerMarker);
    var requests = tcMaintenanceLedger.differentialRequests(vars.ledger);
    if (!requests.length) {
        removeLabelQuietly(tracker, ticketKey, parkLabel);
        return { success: true, action: 'nothing_parked', ticketKey: ticketKey };
    }

    console.log('Dispatching', requests.length, 'parked differential request(s) — the scripted run is the verdict');
    var routes = dispatchRequests(requests, vars);

    var ledgerChanged = JSON.stringify(vars.ledger) !== JSON.stringify(bookkeeping.ledger);
    postMarkerQuietly(tracker, ticketKey, ledgerChanged,
        tcMaintenanceLedger.buildLedgerMarker(vars.ledger), 'TC maintenance ledger');

    var statuses = resolveStatuses(inputs.customParams, config.jira && config.jira.statuses);
    if (routes.bounced.length) {
        moveBugToDevelopmentQuietly(tracker, ticketKey, statuses);
    }

    var remaining = tcMaintenanceLedger.differentialRequests(vars.ledger);
    if (routes.stalled.length || remaining.length || routes.bounced.length || routes.maintained.length || routes.escalated.length) {
        postCommentQuietly(tracker, ticketKey,
            buildReportComment(routes.bounced, routes.escalated, routes.maintained, routes.stalled, vars.ledger));
    }
    if (!remaining.length) {
        removeLabelQuietly(tracker, ticketKey, parkLabel);
    }

    return {
        success: true,
        action: routeNameOf(routes.bounced, routes.escalated, routes.maintained, routes.stalled),
        ticketKey: ticketKey,
        dispatched: requests.length,
        bouncedTestCases: routes.bounced.map(function(v) { return v.tcKey; }),
        maintainedTestCases: routes.maintained.map(function(v) { return v.tcKey; }),
        escalatedTestCases: routes.escalated.map(function(v) { return v.tcKey; }),
        stalledTestCases: routes.stalled.map(function(s) { return s.tcKey; })
    };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        buildRunCommand: buildRunCommand,
        dispatcherVerdict: dispatcherVerdict,
        runDifferential: runDifferential,
        PARK_LABEL_DEFAULT: PARK_LABEL_DEFAULT
    };
}
