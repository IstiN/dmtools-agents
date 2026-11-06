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
 *        own-oracle   → green-on-old hands to the AC re-check (rework, the
 *                        AC verdict decides the bounce — gh-1354); red is
 *                        maintenance like any red differential;
 *        unavailable  → stays parked, one explanation comment, the stall
 *                        stays visible in every ledger digest.
 *   4. posts the updated ledger marker (the parked section disappears as the
 *      dispatcher consumes the requests) and clears the park label when
 *      nothing remains parked — together with the SM rule's trigger label:
 *      the job manages its own lock's full lifecycle (the quotaParkProbe
 *      liftPark pattern), so a later park on the same bug dispatches again.
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
 * Ledger-controlled strings (testPath / lastGreenSha travel from a machine
 * comment in the target repo into this shell) are validated BEFORE any
 * command is built — a failed check routes to the fail-safe `unavailable`.
 * An unconfigured machineAuthor allowlist bails BEFORE reading the ledger:
 * the fail-closed parse cannot see parked requests, so stripping the park
 * label here would orphan them (and re-open the generator leg).
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
// gh-1331: the dispatcher honors the cross-lap alternation suppression.
var tcAlternation = require('./common/tcAlternation.js');
var bugBookkeeping = require('./common/bugBookkeeping.js');
var jobTicketInputs = require('./common/jobTicketInputs.js');

// Tracker-agnostic ticket operations (jira / ado / github) — created lazily per action() run.
var trackersModule = require('./common/trackers.js');
var trackerHolder = trackersModule.createTrackerHolder();
var initTracker = trackerHolder.initTracker;
var getTracker = trackerHolder.getTracker;

var PARK_LABEL_DEFAULT = 'tc_differential_pending';
// The SM rule's in-flight crash-guard label (sm.json) — removed by this job
// when nothing remains parked, exactly like quotaParkProbe.liftPark removes
// its dispatch trigger labels. The SM-side add stays the crash guard.
var TRIGGER_LABEL_DEFAULT = 'sm_tc_differential_triggered';
var MAX_DISPATCHES_PER_TICK = 10;
var COMMAND_OUTPUT_TAIL = 200;
var RESOLVE_VIA_GREEN = 'differential-rerun-dispatcher:green-on-last-green';

// A git SHA and a script path are the only ledger-controlled strings that
// ever reach the shell — anything else routes to the `unavailable` fail-safe.
var SHA_RE = /^[0-9a-f]{7,64}$/i;
var UNSAFE_PATH_RE = /[\s;&|<>$`\\'"\n]/;
var UNAVAILABLE_SHA_DETAIL =
    'the request carries no usable lastGreenSha — a 7-64 hex git SHA is required, ' +
    'the recorded value is rejected before any command is built';
var UNAVAILABLE_PATH_DETAIL =
    'the request carries an unsafe or missing testPath — no shell metacharacters, ' +
    'no leading dash, no relative escape';

// ── inputs (shared with quotaParkProbe: js/common/jobTicketInputs.js) ────────

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

// ── ledger-controlled input validation (defense-in-depth) ────────────────────

/**
 * A lastGreenSha is executable only as a git object name: 7-64 hex chars.
 * Anything else (a branch name, an option, shell metacharacters) is rejected.
 */
function safeSha(value) {
    var s = String(value || '').trim();
    return SHA_RE.test(s) ? s : null;
}

/**
 * A testPath is substituted into the configured run command: shell
 * metacharacters, option-like leading dashes and relative escapes are
 * rejected — a plain repo-relative path is all the run needs.
 */
function safeTestPath(value) {
    var s = String(value || '').trim();
    if (!s) return null;
    if (s.charAt(0) === '-' || s.indexOf('..') !== -1) return null;
    return UNSAFE_PATH_RE.test(s) ? null : s;
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

/**
 * The validated run inputs for one request, or the `unavailable` fail-safe
 * (nothing was decided, nothing was executed) when a value is unusable.
 */
function validateRunInputs(request) {
    var sha = safeSha(request.lastGreenSha);
    if (!sha) return { outcome: 'unavailable', detail: UNAVAILABLE_SHA_DETAIL };
    var testPath = safeTestPath(request.testPath);
    if (!testPath) return { outcome: 'unavailable', detail: UNAVAILABLE_PATH_DETAIL };
    return { sha: sha, testPath: testPath };
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

/** The current branch of the checkout — the restore target ('' when unknown). */
function currentBranchOf(workingDir) {
    try {
        var branchOut = runShell(gitCommand('branch --show-current', workingDir), workingDir);
        return String(branchOut || '').trim().split('\n')[0].trim();
    } catch (e) {
        console.warn('Could not read the current branch (no restore step):', commandTail(e));
        return '';
    }
}

function restoreCommandOf(workingDir) {
    var branch = currentBranchOf(workingDir);
    return branch ? gitCommand('checkout ' + branch, workingDir) : null;
}

/**
 * The scripted core: fetch (best effort for shallow clones), checkout the
 * validated SHA, run the single TC — a red run is evidence, not an error.
 */
function checkoutAndRun(sha, command, workingDir) {
    // best effort: a shallow/sparse clone may not know the old SHA yet.
    bestEffort(gitCommand('fetch origin ' + sha, workingDir), workingDir);
    try {
        runShell(gitCommand('checkout ' + sha, workingDir), workingDir);
    } catch (e) {
        return { outcome: 'unavailable', detail: 'checkout of ' + sha + ' failed: ' + commandTail(e) };
    }
    try {
        runShell(command, workingDir);
        return { outcome: 'green' };
    } catch (e) {
        // the run is the verdict — a red run on the old build is evidence,
        // the failure summary travels with the route.
        console.warn('TC red on the last-green build:', commandTail(e));
        return { outcome: 'red' };
    }
}

/**
 * Runs one parked request on its last-green build.
 * Returns { outcome: 'green'|'red', command } or
 *         { outcome: 'unavailable', detail } (nothing was decided).
 */
function runDifferential(request, workingDir, runTemplate) {
    var inputs = validateRunInputs(request);
    if (inputs.outcome === 'unavailable') return inputs;
    var command = buildRunCommand(runTemplate, inputs.testPath);
    if (!command) {
        return { outcome: 'unavailable',
            detail: 'no tcRunCommand configured — set customParams.tcRunCommand (a template with a {testPath} placeholder)' };
    }
    var restore = restoreCommandOf(workingDir);
    var run = checkoutAndRun(inputs.sha, command, workingDir);
    if (run.outcome !== 'unavailable' && restore) bestEffort(restore, workingDir);
    if (run.outcome === 'unavailable') return run;
    return { outcome: run.outcome, command: command };
}

// ── mechanical routing (tcTriage continuation) ───────────────────────────────

/** The recorded build evidence of a parked request, for the triage input. */
function requestEvidence(request) {
    return {
        current: { sha: request.sha || null, envFingerprint: request.envFingerprint || null },
        lastGreen: { sha: request.lastGreenSha || null, envFingerprint: request.lastGreenEnvFingerprint || null }
    };
}

/** The triage input for a dispatcher outcome. */
function dispatcherInput(request, outcome, redRounds, maxReworkRounds) {
    var evidence = requestEvidence(request);
    return {
        tcKey: request.tcKey,
        role: dispatcherRoleOf(request),
        validated: true,
        current: evidence.current,
        lastGreen: evidence.lastGreen,
        differential: outcome,
        redRounds: redRounds,
        maxReworkRounds: maxReworkRounds,
        errorClass: request.errorClass || 'unknown',
        testPath: request.testPath || '',
        failureSummary: request.failureSummary || null
    };
}

/**
 * The parked request's role for the triage continuation. Guards, siblings
 * and own-oracles park differential requests (gh-1354 routes validated
 * own-oracle reds through the mechanical table too); the OWN role must
 * survive the round-trip — a green outcome is product-side attribution that
 * hands to the AC re-check, never a guard's un-gated earned bounce. A
 * roleless legacy request defaults to guard.
 */
function dispatcherRoleOf(request) {
    if (request.role === tcTriage.ROLE_SIBLING) return tcTriage.ROLE_SIBLING;
    if (request.role === tcTriage.ROLE_OWN) return tcTriage.ROLE_OWN;
    return tcTriage.ROLE_GUARD;
}

/**
 * The triage verdict for one dispatcher outcome: the parked request's
 * recorded evidence + the scripted run's verdict. Guards and siblings keep
 * their role (a sibling green-on-old never bounces THIS bug; an own-oracle
 * green-on-old hands to the AC re-check — gh-1354); a roleless request
 * defaults to guard (legacy shape).
 */
function dispatcherVerdict(request, outcome, redRounds, maxReworkRounds) {
    return tcTriage.triageDifferentialOutcome(
        dispatcherInput(request, outcome, redRounds, maxReworkRounds));
}

/**
 * The request identity + evidence fields shared by every dispatcher ledger
 * entry (the SAME finding identity refreshes — occurrences advance, the
 * stall stays visible in every digest without duplicating).
 */
function evidenceFieldsOf(request) {
    return {
        role: request.role || null,
        errorClass: request.errorClass || 'unknown',
        testPath: request.testPath || '',
        sha: request.sha || null,
        envFingerprint: request.envFingerprint || null,
        lastGreenSha: request.lastGreenSha || null,
        lastGreenEnvFingerprint: request.lastGreenEnvFingerprint || null
    };
}

function baseLedgerEntry(request, verdict, reason) {
    var f = evidenceFieldsOf(request);
    return {
        tcKey: request.tcKey,
        role: f.role,
        verdict: verdict,
        reason: reason,
        errorClass: f.errorClass,
        testPath: f.testPath,
        sha: f.sha,
        envFingerprint: f.envFingerprint,
        lastGreenSha: f.lastGreenSha,
        lastGreenEnvFingerprint: f.lastGreenEnvFingerprint
    };
}

/**
 * The ledger bump for an unavailable attempt: the SAME finding identity
 * refreshes (occurrences advance — the stall stays visible in every digest
 * without duplicating).
 */
function unavailableBump(request, detail) {
    var entry = baseLedgerEntry(request, tcMaintenanceLedger.VERDICT_DIFFERENTIAL,
        request.reason || 'rerun-requested-on-last-green-build');
    entry.note = 'dispatcher could not run: ' + detail;
    return entry;
}

/**
 * The ledger entry for a red-on-old outcome: the same identity refreshes and
 * REOPENS as maintenance debt (the failure predates the change — a sweep PR
 * owns it now).
 */
function maintenanceEntry(request, verdict) {
    var planned = verdict.ledgerEntry || {};
    var entry = baseLedgerEntry(request, planned.verdict || 'maintenance',
        planned.reason || 'failure-predates-change');
    entry.evidence = { differential: 'red' };
    return entry;
}

/**
 * gh-1331: the ledger entry for a SUPPRESSED bounce — the scripted rerun
 * completed the attribution (green on the last-green build), but a
 * suppression anchor owns the loop-stop. The same identity reopens as
 * maintenance debt (the guard is still red and nobody is fixing it — sweep
 * work), reason naming the anchor.
 */
function suppressedEntry(request, suppressedVerdict) {
    var planned = suppressedVerdict.ledgerEntry || {};
    var entry = baseLedgerEntry(request, planned.verdict || 'maintenance',
        planned.reason || 'suppressed-contradictory-pair');
    entry.evidence = { differential: 'green', suppression: suppressedVerdict.reason };
    return entry;
}

/**
 * The member-evidence snapshot for a pair-conflict record: the dispatched
 * request carries its own script + last-green build; a partner TC falls back
 * to its registry record. (The free-text cap is applied by recordConflicts.)
 */
function dispatcherMetaOf(request, vars) {
    return function(tcKey) {
        if (String(tcKey) === String(request.tcKey)) {
            return {
                verifies: null,
                testPath: request.testPath || null,
                failureSummary: request.failureSummary || null,
                lastGreenSha: request.lastGreenSha || null
            };
        }
        var state = tcRunRegistry.stateOf(vars.registry, tcKey);
        return {
            verifies: null,
            testPath: null,
            failureSummary: null,
            lastGreenSha: state ? state.lastGreenSha : null
        };
    };
}

/** Marks the pair when the request's TC shows the trade signature. */
function markConflictsFor(request, vars, routes) {
    var detections = tcAlternation.scanAlternations(vars.registry, request.tcKey);
    if (!detections.length) return;
    var marked = tcAlternation.recordConflicts(
        vars.registry, detections, new Date().toISOString(), dispatcherMetaOf(request, vars));
    vars.registry = marked.registry;
    routes.conflicts = routes.conflicts.concat(marked.added);
}

/** The unsuppressed bounce: the earned route, the range anchor stamped for the laps ahead. */
function routeEarnedBounce(request, vars, routes, verdict) {
    vars.registry = tcRunRegistry.recordBounce(vars.registry, request.tcKey, {
        at: new Date().toISOString(),
        lastGreenSha: request.lastGreenSha,
        kind: 'earned'
    });
    routes.bounced.push(verdict);
}

/**
 * gh-1331: the earned-bounce gate. Detection runs FIRST (a fresh trade flip
 * marks the pair — the escalation must not wait for the other anchors to
 * expire), then the suppression anchors decide (pair conflict → prior bounce
 * on the same range → open ledger item). A suppressed bounce resolves the
 * request (the attribution completed) and routes as its own kind — NEVER as
 * a maintained (red-on-old) finding; an unsuppressed one stamps the
 * registry's bounce anchor for the laps ahead.
 */
function gateBounceRoute(request, vars, routes, verdict) {
    markConflictsFor(request, vars, routes);
    var suppression = tcAlternation.bounceSuppression(
        vars.registry, vars.ledger, request.tcKey, request.lastGreenSha, request.sha);
    if (!suppression) {
        routeEarnedBounce(request, vars, routes, verdict);
        return;
    }
    vars.registry = tcRunRegistry.recordBounce(vars.registry, request.tcKey, {
        at: new Date().toISOString(),
        lastGreenSha: request.lastGreenSha,
        kind: 'suppressed'
    });
    var suppressed = tcAlternation.suppressedVerdict(verdict, suppression);
    vars.ledger = tcMaintenanceLedger.appendFinding(vars.ledger, suppressedEntry(request, suppressed));
    // the suppressed route has its own bucket: it is the GREEN-on-old case,
    // so the maintained section's "fails there too" claim must never render
    // for it (gh-1331 review).
    routes.suppressedBounces.push({ verdict: suppressed, tcKey: request.tcKey, kind: suppression.kind, reason: suppressed.reason });
    console.log('gh-1331: bounce for ' + request.tcKey + ' suppressed (' + suppression.kind + ')');
}

/**
 * gh-1331: the bounce/escalation gate. gh-1331 review: the suppression gate
 * covers ACTION_BOUNCE only — a bounce-cap escalation passes through UNGATED,
 * mirroring the automation leg (gateBounceForAlternation); its loop-stop fact
 * ("bounce cap reached") reaches the owner instead of being folded away.
 */
function gateRouteForAlternation(request, vars, routes, verdict) {
    // the request is consumed — the bounce/escalation (or its gh-1331
    // suppression) is the record
    vars.ledger = tcMaintenanceLedger.resolveFindings(vars.ledger, [request.id], RESOLVE_VIA_GREEN);
    if (verdict.action !== tcTriage.ACTION_BOUNCE) {
        // the cap escalation is a loop-stop too — anchor its range so later
        // laps cannot re-bounce the same unresolved range behind the owner's back
        vars.registry = tcRunRegistry.recordBounce(vars.registry, request.tcKey, {
            at: new Date().toISOString(),
            lastGreenSha: request.lastGreenSha,
            kind: 'escalated'
        });
        routes.escalated.push(verdict);
        return;
    }
    gateBounceRoute(request, vars, routes, verdict);
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

/** Nothing remains parked: lift the park label and the job's trigger lock. */
function clearDispatchLabels(tracker, ticketKey, parkLabel) {
    removeLabelQuietly(tracker, ticketKey, parkLabel);
    removeLabelQuietly(tracker, ticketKey, TRIGGER_LABEL_DEFAULT);
}

// ── the report ────────────────────────────────────────────────────────────────

/**
 * One dispatcher report per bug: the gh-1331 pair escalations + suppressed
 * bounces lead, then the mechanical routes rendered by the same surfaces the
 * automation leg uses (bounce / escalation) plus the ledger digest (the
 * parked section — remaining stalls stay visible).
 */
function conflictSections(routes) {
    return (routes.conflicts || []).map(function(record) {
        return tcAlternation.buildConflictComment(record);
    });
}

/** The suppressed (GREEN-on-old) section — never the maintained template. */
function suppressedBounceSection(routes) {
    if (!(routes.suppressedBounces || []).length) return null;
    var lines = ['The scripted differential rerun confirmed the regression, but the bounce is *suppressed* (gh-1331) — a loop-stop anchor owns it:'];
    routes.suppressedBounces.forEach(function(s) {
        lines.push('* ' + s.tcKey + ' — ' + s.reason);
    });
    return lines.join('\n');
}

/**
 * The gh-1354 own-oracle AC handoff section: a green-on-old outcome on the
 * bug's own oracle is product-side attribution — the TC hands to the AC
 * re-check (rework) and the AC verdict decides the bounce on the next lap.
 */
function reworkHandoffSection(routes) {
    if (!(routes.rework || []).length) return null;
    var lines = ['The scripted differential rerun passed on the last-green build — the failure is attributed to the change range; these TCs hand to the AC re-check (rework) before any bounce:'];
    routes.rework.forEach(function(v) {
        lines.push('* ' + v.tcKey + ' — ' + v.reason.replace(/-/g, ' '));
    });
    return lines.join('\n');
}

/** One stall line per unavailable attempt (the request stays parked). */
function stalledSections(routes) {
    return routes.stalled.map(function(s) {
        return 'The differential rerun for ' + s.tcKey + ' could not run' +
            (s.detail ? ' — ' + s.detail : '') + '. The request stays parked and visible in the maintenance-ledger digest.';
    });
}

function buildReportComment(routes, ledger) {
    var sections = conflictSections(routes);
    var suppressed = suppressedBounceSection(routes);
    if (suppressed) sections.push(suppressed);
    var rework = reworkHandoffSection(routes);
    if (rework) sections.push(rework);
    if (routes.bounced.length) sections.push(tcTriage.buildBounceComment(routes.bounced));
    if (routes.escalated.length) sections.push(tcTriage.buildEscalationComment(routes.escalated));
    // the maintained template is ONLY for genuine red-on-old findings — a
    // suppressed bounce is the green-on-old case and renders its own section
    if (routes.maintained.length) sections.push('The scripted differential rerun (gh-1345) ran the failing TC on its last-green build and it fails there too — ' +
        'the failure predates the change; the finding stays in the TC maintenance ledger.');
    stalledSections(routes).forEach(function(section) {
        sections.push(section);
    });
    if (routes.deferred > 0) {
        sections.push(MAX_DISPATCHES_PER_TICK + '-request-per-tick cap: ' + routes.deferred +
            ' parked request(s) deferred to the next tick.');
    }
    sections.push(tcMaintenanceLedger.buildDigestComment(ledger));
    return sections.join('\n\n');
}

/** The route names present in a dispatch (gh-1331 review: suppressed laps surface).
 *  A pair conflict is an escalation SURFACE, not a request route — it is
 *  reported in the comment + payload, never folded into the action name. */
function routeNamesOf(routes) {
    return [
        [routes.bounced.length, 'bounced'],
        [routes.escalated.length, 'escalated'],
        [routes.maintained.length, 'maintained'],
        [routes.stalled.length, 'stalled'],
        [routes.rework.length, 'rework'],
        [(routes.suppressedBounces || []).length, 'suppressed']
    ].filter(function(present) { return present[0]; }).map(function(present) { return present[1]; });
}

function routeNameOf(routes) {
    var names = routeNamesOf(routes);
    return names.length > 1 ? 'mixed' : (names[0] || 'stalled');
}

// ── the action ────────────────────────────────────────────────────────────────

/** The per-request route: unavailable → parked bump; else the triage verdict. */
function routeOne(request, vars, routes) {
    var run = runDifferential(request, vars.workingDir, vars.runTemplate);
    if (run.outcome === 'unavailable') {
        vars.ledger = tcMaintenanceLedger.appendFinding(vars.ledger, unavailableBump(request, run.detail));
        // one explanation per stall; the occurrences bump keeps later
        // quiet attempts from spamming the ticket.
        if ((request.occurrences || 1) > 1) {
            console.log('⏳ Differential request for', request.tcKey, 'still unavailable — stays parked (quiet)');
            return;
        }
        routes.stalled.push({ tcKey: request.tcKey, detail: run.detail });
        return;
    }
    var verdict = dispatcherVerdict(request, run.outcome,
        tcRunRegistry.redRoundsOf(vars.registry, request.tcKey), vars.maxRework);
    console.log('Differential outcome for', request.tcKey, 'on the last-green build:', run.outcome, '→', verdict.action);
    if (verdict.action === tcTriage.ACTION_BOUNCE || verdict.action === tcTriage.ACTION_ESCALATE) {
        // the request is consumed — the bounce/escalation (or its gh-1331
        // suppression) is the record
        gateRouteForAlternation(request, vars, routes, verdict);
        return;
    }
    if (verdict.action === tcTriage.ACTION_REWORK) {
        // gh-1354: the own-oracle AC handoff — the green outcome completed
        // the product-side attribution, so the request is consumed and the
        // TC belongs to the rework lane (the AC re-check decides the bounce
        // on the next lap). Never a guard's un-gated earned bounce.
        vars.ledger = tcMaintenanceLedger.resolveFindings(vars.ledger, [request.id], RESOLVE_VIA_GREEN);
        var handoff = baseLedgerEntry(request, verdict.action, verdict.reason);
        handoff.evidence = { differential: 'green' };
        vars.ledger = tcMaintenanceLedger.appendFinding(vars.ledger, handoff);
        routes.rework.push(verdict);
        return;
    }
    if (verdict.action === tcTriage.ACTION_DIFFERENTIAL) {
        // gh-1354 rework: the hardened continuation refused to decide (the
        // outcome was not green|red) — re-park, never a red-on-old claim.
        // Falling through would stamp fabricated `differential: 'red'`
        // evidence, render the "fails there too" report and park the SAME
        // finding as maintained — the exact false claim the hardening makes
        // impossible.
        vars.ledger = tcMaintenanceLedger.appendFinding(vars.ledger, unavailableBump(request, 'incomplete outcome — re-requesting the rerun'));
        routes.stalled.push({ tcKey: request.tcKey, detail: 'incomplete outcome — re-requesting the rerun' });
        return;
    }
    vars.ledger = tcMaintenanceLedger.appendFinding(vars.ledger, maintenanceEntry(request, verdict));
    routes.maintained.push(verdict);
}

function dispatchRequests(requests, vars) {
    var routes = { bounced: [], escalated: [], maintained: [], stalled: [], rework: [], deferred: 0, conflicts: [], suppressedBounces: [] };
    var bounded = requests.slice(0, MAX_DISPATCHES_PER_TICK);
    routes.deferred = requests.length - bounded.length;
    bounded.forEach(function(request) {
        routeOne(request, vars, routes);
    });
    return routes;
}

function dispatchVarsOf(inputs, config) {
    return {
        workingDir: workingDirOf(inputs.customParams, config),
        runTemplate: inputs.customParams.tcRunCommand || null,
        maxRework: maxReworkRoundsOf(inputs.customParams),
        registry: null,
        ledger: null
    };
}

/**
 * The gh-1345 deployment guard: with an empty machineAuthor allowlist the
 * bookkeeping parse fails closed (reads nothing) — a parked request the
 * parse cannot see would lose its park label here and be orphaned (the
 * generator rule would re-dispatch it). Bail BEFORE any read or write: the
 * trigger label drops so the next tick retries once the allowlist is fixed;
 * the park label stays and the stall stays digest-visible.
 */
function unconfiguredGuardResult(params, config, tracker, ticketKey) {
    var warning = bugBookkeeping.triageAllowlistWarning(params, config);
    if (!warning) return null;
    console.warn(warning);
    removeLabelQuietly(tracker, ticketKey, TRIGGER_LABEL_DEFAULT);
    return { success: true, action: 'unconfigured_parked', ticketKey: ticketKey };
}

/** The ledger + registry markers and the route report tail of a dispatching run. */
function reportRoutes(tracker, ticketKey, vars, originalLedger, originalRegistry, routes) {
    var ledgerChanged = JSON.stringify(vars.ledger) !== JSON.stringify(originalLedger);
    postMarkerQuietly(tracker, ticketKey, ledgerChanged,
        tcMaintenanceLedger.buildLedgerMarker(vars.ledger), 'TC maintenance ledger');
    // gh-1331: the gate mutates the registry too (pair records, bounce
    // anchors) — the marker must land or the next lap reads stale history.
    var registryChanged = JSON.stringify(vars.registry) !== JSON.stringify(originalRegistry);
    postMarkerQuietly(tracker, ticketKey, registryChanged,
        tcRunRegistry.buildRegistryMarker(vars.registry), 'TC run registry');
    var hasRoutes = routes.bounced.length || routes.escalated.length ||
        routes.maintained.length || routes.stalled.length || routes.conflicts.length ||
        routes.suppressedBounces.length || routes.rework.length;
    if (hasRoutes) {
        postCommentQuietly(tracker, ticketKey, buildReportComment(routes, vars.ledger));
    }
}

function dispatchResult(routes, ticketKey, dispatched) {
    return {
        success: true,
        action: routeNameOf(routes),
        ticketKey: ticketKey,
        dispatched: dispatched,
        deferred: routes.deferred,
        bouncedTestCases: routes.bounced.map(function(v) { return v.tcKey; }),
        maintainedTestCases: routes.maintained.map(function(v) { return v.tcKey; }),
        escalatedTestCases: routes.escalated.map(function(v) { return v.tcKey; }),
        stalledTestCases: routes.stalled.map(function(s) { return s.tcKey; }),
        // gh-1354: the own-oracle AC handoff is first-class — a green-on-old
        // on the bug's own oracle is a rework route, never a bounce
        reworkTestCases: routes.rework.map(function(v) { return v.tcKey; }),
        // gh-1331 review: the new routes are first-class in the payload —
        // downstream consumers tell a suppressed bounce from a genuine
        // red-on-old maintenance route, and fresh pair conflicts are visible.
        suppressedTestCases: (routes.suppressedBounces || []).map(function(s) { return s.tcKey; }),
        conflicts: (routes.conflicts || []).map(function(record) { return record.pairKey; })
    };
}

function action(params) {
    var inputs = jobTicketInputs.resolveInputs(params);
    var missing = jobTicketInputs.missingTicketKeyResult(inputs);
    if (missing) return missing;
    var ticketKey = inputs.ticketKey;
    var config = configLoader.loadProjectConfig(inputs.jobParams || params);
    initTracker(config, inputs.customParams);
    var tracker = getTracker();

    console.log('=== TC differential dispatcher for', ticketKey, '===');

    var guard = unconfiguredGuardResult(params, config, tracker, ticketKey);
    if (guard) return guard;

    var parkLabel = parkLabelOf(inputs.customParams);
    var vars = dispatchVarsOf(inputs, config);
    var bookkeeping = bugBookkeeping.loadBugBookkeeping(tracker, ticketKey, params, config);
    vars.registry = bookkeeping.registry;
    vars.ledger = bookkeeping.ledger;

    var requests = tcMaintenanceLedger.differentialRequests(vars.ledger);
    if (!requests.length) {
        clearDispatchLabels(tracker, ticketKey, parkLabel);
        return { success: true, action: 'nothing_parked', ticketKey: ticketKey };
    }

    console.log('Dispatching', requests.length, 'parked differential request(s) — the scripted run is the verdict');
    var routes = dispatchRequests(requests, vars);

    var statuses = resolveStatuses(inputs.customParams, config.jira && config.jira.statuses);
    if (routes.bounced.length) {
        moveBugToDevelopmentQuietly(tracker, ticketKey, statuses);
    }
    reportRoutes(tracker, ticketKey, vars, bookkeeping.ledger, bookkeeping.registry, routes);
    if (!tcMaintenanceLedger.differentialRequests(vars.ledger).length) {
        clearDispatchLabels(tracker, ticketKey, parkLabel);
    }

    return dispatchResult(routes, ticketKey, requests.length);
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        buildRunCommand: buildRunCommand,
        dispatcherVerdict: dispatcherVerdict,
        runDifferential: runDifferential,
        safeSha: safeSha,
        safeTestPath: safeTestPath,
        PARK_LABEL_DEFAULT: PARK_LABEL_DEFAULT,
        TRIGGER_LABEL_DEFAULT: TRIGGER_LABEL_DEFAULT
    };
}
