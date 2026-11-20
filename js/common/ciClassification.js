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

function readRawPatternList(primary, secondary) {
    if (Array.isArray(primary)) return primary;
    if (Array.isArray(secondary)) return secondary;
    return [];
}

function resolveClassificationOptions(customParams) {
    var cp = customParams || {};
    var sub = cp.ciClassification || {};
    var rawNames = readRawPatternList(sub.namePatterns, cp.ciInfraNamePatterns);
    var rawLogs = readRawPatternList(sub.logPatterns, cp.ciInfraLogPatterns);
    return {
        namePatterns: compilePatterns(rawNames, []),
        logPatterns: compilePatterns(rawLogs, DEFAULT_INFRA_LOG_PATTERNS)
    };
}

function testAnyPattern(text, patterns) {
    for (var i = 0; i < patterns.length; i++) {
        if (patterns[i].test(text)) return true;
    }
    return false;
}

function matchesCheckName(name, namePatterns) {
    var s = String(name == null ? '' : name).trim();
    if (!s) return false;
    if (!Array.isArray(namePatterns) || namePatterns.length === 0) return true;
    return testAnyPattern(s, namePatterns);
}

function matchesInfraLog(logs, logPatterns) {
    var text = String(logs == null ? '' : logs);
    if (!text) return false;
    var patterns = Array.isArray(logPatterns) && logPatterns.length > 0 ? logPatterns : DEFAULT_INFRA_LOG_PATTERNS;
    return testAnyPattern(text, patterns);
}

function entryNameOf(item) {
    if (!item) return '';
    if (typeof item === 'string') return item.trim();
    var raw = item.name || (item.check && item.check.name) || '';
    return String(raw).trim();
}

function entryLogsOf(item) {
    if (!item || typeof item === 'string') return '';
    return String(item.logs || item.log || (item.sections && item.sections.logs) || '');
}

function normalizeNameSet(items) {
    var set = {};
    var list = Array.isArray(items) ? items : [];
    for (var i = 0; i < list.length; i++) {
        var key = entryNameOf(list[i]);
        if (key) set[key] = true;
    }
    return set;
}

function confirmedByOf(name, baseSet, otherPrSet) {
    if (baseSet[name]) return 'base';
    if (otherPrSet[name]) return 'other-pr';
    return 'none';
}

function normalizeClassifyOptions(options) {
    if (options && (Array.isArray(options.logPatterns) || Array.isArray(options.namePatterns))) {
        return {
            namePatterns: compilePatterns(options.namePatterns, []),
            logPatterns: compilePatterns(options.logPatterns, DEFAULT_INFRA_LOG_PATTERNS)
        };
    }
    return resolveClassificationOptions(options);
}

function classifySingleItem(item, baseSet, otherPrSet, opts) {
    var name = entryNameOf(item);
    if (!name) return null;
    var confirmedBy = confirmedByOf(name, baseSet, otherPrSet);
    var isInfra = confirmedBy === 'base' &&
        matchesCheckName(name, opts.namePatterns) &&
        matchesInfraLog(entryLogsOf(item), opts.logPatterns);
    return {
        name: name,
        'class': isInfra ? 'infra' : 'owned',
        confirmedBy: confirmedBy
    };
}

/**
 * Pure classifier (`classify(failing, baseFailing, otherPrFailing, options)`).
 */
function classify(failing, baseFailing, otherPrFailing, options) {
    if (!Array.isArray(failing) || failing.length === 0) return [];
    var opts = normalizeClassifyOptions(options);
    var baseSet = normalizeNameSet(baseFailing);
    var otherPrSet = normalizeNameSet(otherPrFailing);
    var out = [];
    for (var i = 0; i < failing.length; i++) {
        var row = classifySingleItem(failing[i], baseSet, otherPrSet, opts);
        if (row) out.push(row);
    }
    return out;
}

var FAILED_CONCLUSIONS = { failure: true, timed_out: true, failed: true };

function isFailedConclusion(conclusion) {
    return Boolean(FAILED_CONCLUSIONS[String(conclusion || '').toLowerCase()]);
}

function appendUniqueNames(target, seen, names) {
    for (var i = 0; i < names.length; i++) {
        var n = names[i];
        if (n && !seen[n]) {
            seen[n] = true;
            target.push(n);
        }
    }
}

function failedCheckNamesFromRuns(checkRuns) {
    var list = Array.isArray(checkRuns) ? checkRuns : [];
    var names = [];
    var seen = {};
    for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (c && isFailedConclusion(c.conclusion)) {
            appendUniqueNames(names, seen, [String(c.name || '').trim()]);
        }
    }
    return names;
}

function validGitSha(candidate) {
    var s = String(candidate || '').trim().split('\n').pop().trim();
    return /^[0-9a-f]{7,40}$/i.test(s) ? s : null;
}

function prBaseShaOf(prDetails) {
    var base = prDetails && prDetails.base;
    return validGitSha(base && base.sha);
}

function resolveBaseHeadSha(baseBranch, prDetails, workingDir, runCommand) {
    var fromPr = prBaseShaOf(prDetails);
    if (fromPr) return fromPr;
    if (!baseBranch || typeof runCommand !== 'function') return null;
    try {
        return validGitSha(runCommand('git rev-parse origin/' + baseBranch, workingDir));
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

function prHeadShaOf(pr) {
    var head = pr && pr.head;
    return validGitSha(head && head.sha);
}

function isSamePrOrHead(pr, sha, currentPrNumber, currentHeadSha) {
    if (currentPrNumber != null && String(pr && pr.number) === String(currentPrNumber)) return true;
    return Boolean(currentHeadSha) && sha === String(currentHeadSha);
}

function otherPrCandidateShas(openPrs, currentPrNumber, currentHeadSha) {
    var list = Array.isArray(openPrs) ? openPrs : [];
    var shas = [];
    for (var i = 0; i < list.length; i++) {
        var sha = prHeadShaOf(list[i]);
        if (sha && !isSamePrOrHead(list[i], sha, currentPrNumber, currentHeadSha)) {
            shas.push(sha);
        }
    }
    return shas.slice(0, 3);
}

function collectOtherPrFailingChecks(scm, fetchCheckRuns, currentPrNumber, currentHeadSha, explicitOtherPrFailing) {
    if (Array.isArray(explicitOtherPrFailing)) return explicitOtherPrFailing;
    if (!scm || typeof scm.listPrs !== 'function' || typeof fetchCheckRuns !== 'function') return [];
    try {
        var shas = otherPrCandidateShas(scm.listPrs('open'), currentPrNumber, currentHeadSha);
        var names = [];
        var seen = {};
        for (var i = 0; i < shas.length; i++) {
            appendUniqueNames(names, seen, failedCheckNamesFromRuns(fetchCheckRuns(shas[i])));
        }
        return names;
    } catch (e) {
        return [];
    }
}

function tryWriteClassificationFile(inputFolder, classification, writeFn) {
    try {
        writeFn({
            path: inputFolder + '/ci_classification.json',
            content: JSON.stringify(classification, null, 2)
        });
        console.log('✅ Wrote ci_classification.json (' + classification.length + ' check(s))');
    } catch (e) {
        console.warn('Could not write ci_classification.json (non-fatal):', String(e && e.message || e));
    }
}

function writeCiClassificationJson(inputFolder, entries, writeFn, classifyOpts) {
    if (!inputFolder || typeof writeFn !== 'function') return [];
    var opts = classifyOpts || {};
    var classification = classify(entries, opts.baseFailing, opts.otherPrFailing, opts.customParams || opts);
    if (classification.length > 0) {
        tryWriteClassificationFile(inputFolder, classification, writeFn);
    }
    return classification;
}

function writeCiClassificationFromEntries(inputFolder, entries, scm, owner, repo, headSha, classifyOpts, deps) {
    var d = deps || {};
    if (typeof d.writeFn !== 'function' || typeof d.fetchCheckRuns !== 'function') return [];
    var opts = classifyOpts || {};
    var fetchRuns = function(sha) {
        return d.fetchCheckRuns(scm, owner, repo, sha) || [];
    };
    var baseSha = opts.baseSha || resolveBaseHeadSha(opts.baseBranch, opts.prDetails, opts.workingDir, d.runCommand);
    return writeCiClassificationJson(inputFolder, entries, d.writeFn, {
        baseFailing: collectBaseFailingChecks(fetchRuns, baseSha, opts.baseFailing),
        otherPrFailing: collectOtherPrFailingChecks(scm, fetchRuns, opts.prNumber, headSha, opts.otherPrFailing),
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
