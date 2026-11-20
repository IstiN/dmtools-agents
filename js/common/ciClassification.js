/**
 * ciClassification.js — conservative CI check failure classifier (gh-1527).
 *
 * Separates PR-head check failures caused by infrastructure from failures
 * owned by the PR and writes `input/<id>/ci_classification.json`:
 *
 *   [{ "name": "build", "class": "infra|owned", "confirmedBy": "base|other-pr|none" }]
 *
 * Classification rules (conservative / fail-closed by default):
 * - A check is `infra` ONLY when BOTH hold:
 *   1. A (check name, log) pattern pair matches. The log must match a concrete
 *      network or runner symptom (`ECONNRESET`, `ETIMEDOUT`,
 *      `Could not resolve host`, HTTP 502/503/504, `No space left on device`,
 *      `runner has received a shutdown signal`, etc.). Generic words like
 *      "timeout" or "permission denied" never qualify.
 *   2. The same check also fails on the latest base-branch run.
 * - A failure confirmed only by another open PR is reported
 *   (`confirmedBy: "other-pr"`) but stays `owned`.
 * - Anything unconfirmed is `owned` (`confirmedBy: "none"`).
 *
 * Consumers can extend the name and log patterns through `customParams`
 * (`ciClassification.namePatterns` / `ciClassification.logPatterns` or
 * `ciInfraNamePatterns` / `ciInfraLogPatterns`).
 *
 * Pure module — no dmtools globals. GraalJS-clean (var + plain functions).
 */
'use strict';

var DEFAULT_INFRA_LOG_PATTERNS = [
    /\bECONNRESET\b/,
    /\bETIMEDOUT\b/,
    /\bECONNREFUSED\b/,
    /\bEAI_AGAIN\b/,
    /\bENETUNREACH\b/,
    /\bEHOSTUNREACH\b/,
    /Could not resolve host/i,
    / Temporary failure in name resolution/i,
    /\b(?:HTTP\/[0-9.]+\s+|status(?:\s+code)?[:=\s]+)(?:502|503|504)\b/i,
    /\b(?:502 Bad Gateway|503 Service Unavailable|504 Gateway Time-?out)\b/i,
    /No space left on device/i,
    /runner has received a shutdown signal/i,
    /The hosted runner lost communication with the server/i,
    /lost communication with the server/i
];

function toRegExp(pattern) {
    if (pattern instanceof RegExp) return pattern;
    if (typeof pattern === 'string' && pattern.trim() !== '') {
        try { return new RegExp(pattern, 'i'); } catch (e) { return null; }
    }
    return null;
}

function compilePatterns(list, defaults) {
    var out = (defaults || []).slice();
    if (!Array.isArray(list)) return out;
    for (var i = 0; i < list.length; i++) {
        var re = toRegExp(list[i]);
        if (re) out.push(re);
    }
    return out;
}

function resolveClassificationOptions(customParams) {
    var cp = customParams || {};
    var sub = cp.ciClassification || {};
    var rawNames = sub.namePatterns || cp.ciInfraNamePatterns || [];
    var rawLogs = sub.logPatterns || cp.ciInfraLogPatterns || [];
    return {
        namePatterns: compilePatterns(rawNames, []),
        logPatterns: compilePatterns(rawLogs, DEFAULT_INFRA_LOG_PATTERNS)
    };
}

function matchesCheckName(name, namePatterns) {
    var s = String(name == null ? '' : name).trim();
    if (!s) return false;
    if (!namePatterns || namePatterns.length === 0) return true;
    for (var i = 0; i < namePatterns.length; i++) {
        if (namePatterns[i].test(s)) return true;
    }
    return false;
}

function matchesInfraLog(logs, logPatterns) {
    var text = String(logs == null ? '' : logs);
    if (!text) return false;
    var patterns = logPatterns && logPatterns.length > 0 ? logPatterns : DEFAULT_INFRA_LOG_PATTERNS;
    for (var i = 0; i < patterns.length; i++) {
        if (patterns[i].test(text)) return true;
    }
    return false;
}

function normalizeNameSet(items) {
    var set = {};
    var list = Array.isArray(items) ? items : [];
    for (var i = 0; i < list.length; i++) {
        var it = list[i];
        var name = typeof it === 'string' ? it : (it && it.name);
        var key = String(name == null ? '' : name).trim();
        if (key) set[key] = true;
    }
    return set;
}

function confirmedByOf(name, baseSet, otherPrSet) {
    if (baseSet[name]) return 'base';
    if (otherPrSet[name]) return 'other-pr';
    return 'none';
}

/**
 * Pure classifier (`classify(failing, baseFailing, otherPrFailing, options)`).
 *
 * @param {Array<Object|string>} failing - Failing checks on the PR head (`{ name, logs }` or `{ check: { name }, sections: { logs } }`)
 * @param {Array<Object|string>} [baseFailing] - Failing check names on the latest base-branch run
 * @param {Array<Object|string>} [otherPrFailing] - Failing check names on another open PR
 * @param {Object} [options] - `{ namePatterns, logPatterns }` or `customParams`
 * @returns {Array<{name: string, class: string, confirmedBy: string}>}
 */
function classify(failing, baseFailing, otherPrFailing, options) {
    var list = Array.isArray(failing) ? failing : [];
    if (list.length === 0) return [];
    var opts = (options && (Array.isArray(options.logPatterns) || Array.isArray(options.namePatterns)))
        ? {
            namePatterns: compilePatterns(options.namePatterns, []),
            logPatterns: compilePatterns(options.logPatterns, DEFAULT_INFRA_LOG_PATTERNS)
        }
        : resolveClassificationOptions(options);
    var baseSet = normalizeNameSet(baseFailing);
    var otherPrSet = normalizeNameSet(otherPrFailing);
    var out = [];

    for (var i = 0; i < list.length; i++) {
        var item = list[i] || {};
        var name = typeof item === 'string'
            ? item
            : ((item.name) || (item.check && item.check.name) || '');
        name = String(name).trim();
        if (!name) continue;
        var logs = typeof item === 'string'
            ? ''
            : (item.logs || item.log || (item.sections && item.sections.logs) || '');
        var confirmedBy = confirmedByOf(name, baseSet, otherPrSet);
        var pairMatches = matchesCheckName(name, opts.namePatterns) && matchesInfraLog(logs, opts.logPatterns);
        var cls = (pairMatches && confirmedBy === 'base') ? 'infra' : 'owned';
        out.push({
            name: name,
            'class': cls,
            confirmedBy: confirmedBy
        });
    }
    return out;
}

function isFailedConclusion(conclusion) {
    var c = String(conclusion || '').toLowerCase();
    return c === 'failure' || c === 'timed_out' || c === 'failed';
}

function failedCheckNamesFromRuns(checkRuns) {
    var list = Array.isArray(checkRuns) ? checkRuns : [];
    var names = [];
    var seen = {};
    for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (!c || !isFailedConclusion(c.conclusion)) continue;
        var name = String(c.name || '').trim();
        if (name && !seen[name]) {
            seen[name] = true;
            names.push(name);
        }
    }
    return names;
}

function resolveBaseHeadSha(baseBranch, prDetails, workingDir, runCommand) {
    var fromPr = prDetails && prDetails.base && prDetails.base.sha ? String(prDetails.base.sha).trim() : '';
    if (/^[0-9a-f]{7,40}$/i.test(fromPr)) return fromPr;
    if (!baseBranch || typeof runCommand !== 'function') return null;
    try {
        var out = String(runCommand('git rev-parse origin/' + baseBranch, workingDir) || '').trim().split('\n').pop().trim();
        return /^[0-9a-f]{7,40}$/i.test(out) ? out : null;
    } catch (e) {
        return null;
    }
}

function collectBaseFailingChecks(fetchCheckRuns, baseSha, explicitBaseFailing) {
    if (Array.isArray(explicitBaseFailing)) return explicitBaseFailing;
    if (!baseSha || typeof fetchCheckRuns !== 'function') return [];
    try {
        return failedCheckNamesFromRuns(fetchCheckRuns(baseSha));
    } catch (e) {
        return [];
    }
}

function collectOtherPrFailingChecks(scm, fetchCheckRuns, currentPrNumber, currentHeadSha, explicitOtherPrFailing) {
    if (Array.isArray(explicitOtherPrFailing)) return explicitOtherPrFailing;
    if (!scm || typeof scm.listPrs !== 'function' || typeof fetchCheckRuns !== 'function') return [];
    try {
        var openPrs = scm.listPrs('open');
        if (!Array.isArray(openPrs)) return [];
        var names = [];
        var seen = {};
        var scanned = 0;
        for (var i = 0; i < openPrs.length && scanned < 3; i++) {
            var pr = openPrs[i];
            if (!pr) continue;
            if (currentPrNumber != null && String(pr.number) === String(currentPrNumber)) continue;
            var sha = pr.head && pr.head.sha ? String(pr.head.sha).trim() : '';
            if (!sha || (currentHeadSha && sha === String(currentHeadSha))) continue;
            scanned++;
            var failed = failedCheckNamesFromRuns(fetchCheckRuns(sha));
            for (var j = 0; j < failed.length; j++) {
                if (!seen[failed[j]]) {
                    seen[failed[j]] = true;
                    names.push(failed[j]);
                }
            }
        }
        return names;
    } catch (e) {
        return [];
    }
}

function writeCiClassificationJson(inputFolder, entries, writeFn, classifyOpts) {
    if (!inputFolder || !Array.isArray(entries) || entries.length === 0 || typeof writeFn !== 'function') {
        return [];
    }
    var opts = classifyOpts || {};
    var classification = classify(entries, opts.baseFailing || [], opts.otherPrFailing || [], opts.customParams || opts);
    if (classification.length === 0) return [];
    try {
        writeFn({
            path: inputFolder + '/ci_classification.json',
            content: JSON.stringify(classification, null, 2)
        });
        console.log('✅ Wrote ci_classification.json (' + classification.length + ' check(s))');
    } catch (e) {
        console.warn('Could not write ci_classification.json (non-fatal):', e && e.message ? e.message : String(e));
    }
    return classification;
}

function writeCiClassificationFromEntries(inputFolder, entries, scm, owner, repo, headSha, classifyOpts, deps) {
    var d = deps || {};
    if (!entries || entries.length === 0 || typeof d.writeFn !== 'function') return [];
    var opts = classifyOpts || {};
    var fetchRuns = function(sha) {
        return typeof d.fetchCheckRuns === 'function' ? (d.fetchCheckRuns(scm, owner, repo, sha) || []) : [];
    };
    var baseSha = opts.baseSha || resolveBaseHeadSha(opts.baseBranch, opts.prDetails, opts.workingDir, d.runCommand);
    var baseFailing = collectBaseFailingChecks(fetchRuns, baseSha, opts.baseFailing);
    var otherPrFailing = collectOtherPrFailingChecks(scm, fetchRuns, opts.prNumber, headSha, opts.otherPrFailing);
    return writeCiClassificationJson(inputFolder, entries, d.writeFn, {
        baseFailing: baseFailing,
        otherPrFailing: otherPrFailing,
        customParams: opts.customParams || opts
    });
}

module.exports = {
    DEFAULT_INFRA_LOG_PATTERNS: DEFAULT_INFRA_LOG_PATTERNS,
    resolveClassificationOptions: resolveClassificationOptions,
    matchesCheckName: matchesCheckName,
    matchesInfraLog: matchesInfraLog,
    classify: classify,
    failedCheckNamesFromRuns: failedCheckNamesFromRuns,
    resolveBaseHeadSha: resolveBaseHeadSha,
    collectBaseFailingChecks: collectBaseFailingChecks,
    collectOtherPrFailingChecks: collectOtherPrFailingChecks,
    writeCiClassificationJson: writeCiClassificationJson,
    writeCiClassificationFromEntries: writeCiClassificationFromEntries
};
