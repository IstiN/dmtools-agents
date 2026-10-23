/**
 * Pure helpers for js/postMobileTestAutomationResults.js (gh-979, gh-1189).
 *
 * Decision and string-building logic extracted from action(),
 * updateFeaturePRBody(), getResultCounts() and performGitOperations() so
 * all of them shrink below the CRAP threshold.
 * Every function here is side-effect free (console/tracker/SCM calls stay
 * in the caller) and strings must stay byte-identical to the originals —
 * they are posted verbatim to the tracker / PR.
 */

/** Lowercased status decision shared by all post steps. */
function parseOutcome(result) {
    var status = String((result && result.status) || '').toLowerCase();
    return {
        status: status,
        passed: status === 'passed',
        blockedByHuman: status === 'blocked_by_human'
    };
}

/** True when value is a non-empty array. */
function hasWarningsArray(value) {
    return Array.isArray(value) && value.length > 0;
}

/** Per-TC or top-level a11y warnings — informational, never override status. */
function hasA11yWarnings(result) {
    var results = result && result.results;
    if (Array.isArray(results)) {
        for (var i = 0; i < results.length; i++) {
            if (hasWarningsArray(results[i].a11y_warnings)) {
                return true;
            }
        }
    }
    return hasWarningsArray(result && result.a11y_warnings);
}

/** Label names and test-files glob from customParams (with defaults). */
function decideLabels(customParams) {
    var labelsConfig = (customParams && customParams.labels) || {};
    return {
        labelPassed: labelsConfig.testsPassed || 'tests_passed',
        labelFailed: labelsConfig.testsFailed || 'tests_failed',
        testFilesPath: (customParams && customParams.testFilesGlob) || 'src/tests/'
    };
}

/** Feature repo owner/name from customParams.featurePR (empty strings when absent). */
function decideFeatureTarget(customParams) {
    var featurePRConfig = (customParams && customParams.featurePR) || {};
    return {
        owner: featurePRConfig.owner || '',
        repo: featurePRConfig.repo || ''
    };
}

/**
 * Label pair for the feature-PR result update (gh-1083): passed → add the
 * passed label and remove the failed one, otherwise the mirror image.
 */
function decideFeaturePrLabels(passed, labelPassed, labelFailed) {
    return {
        addLabel: passed ? labelPassed : labelFailed,
        removeLabel: passed ? labelFailed : labelPassed
    };
}

/** WIP label: context-specific or the mobile default. */
function decideWipLabel(metadata) {
    return metadata && metadata.contextId
        ? metadata.contextId + '_wip'
        : 'mobile_test_automation_wip';
}

/** SM trigger label to remove after completion (null when not configured). */
function decideSmTriggerLabel(customParams) {
    return ((customParams && customParams.removeLabel) || null);
}

/**
 * Read the feature-PR summary markdown: pr_feature_update.md with a
 * pr_body.md fallback. readFileFn(relativePath) returns file text or null.
 * Returns { content, fallback } or null when neither file exists —
 * the caller keeps the original log lines.
 */
function resolveFeatureSummary(readFileFn) {
    var content = readFileFn('pr_feature_update.md');
    var fallback = false;
    if (!content) {
        content = readFileFn('pr_body.md');
        fallback = true;
    }
    if (!content) {
        return null;
    }
    return { content: content, fallback: fallback };
}

/** True when the summary already carries a verdict/test-results section. */
function needsVerdictPrefix(content) {
    var lower = (content || '').toLowerCase();
    return lower.indexOf('verdict') !== -1 ||
        lower.indexOf('test results') !== -1 ||
        lower.indexOf('passed') !== -1 ||
        lower.indexOf('failed') !== -1;
}

/** Prepend the generated verdict section when the summary lacks one. */
function prependVerdictIfNeeded(content, result, buildVerdict) {
    if (!result) {
        return content;
    }
    if (!needsVerdictPrefix(content)) {
        return buildVerdict(result) + content;
    }
    return content;
}

/** Jira markup for the blocked_by_human path (Step 7). */
function buildBlockedComment(result) {
    var blockedComment = 'h3. 🚫 Test Automation Blocked — Awaiting Human Setup\n\n';
    if (result.blocked_reason) {
        blockedComment += result.blocked_reason + '\n\n';
    }
    if (result.missing && result.missing.length > 0) {
        blockedComment += 'h4. Required setup:\n\n';
        for (var i = 0; i < result.missing.length; i++) {
            var item = result.missing[i];
            blockedComment += '* *' + (item.name || '?') + '*';
            if (item.description) {
                blockedComment += ': ' + item.description;
            }
            blockedComment += '\n';
        }
    }
    blockedComment += '\nOnce setup is complete, move this ticket back to *Backlog* to trigger re-run.';
    return blockedComment;
}

/** Jira markup for the missing test_automation_result.json path (Step 4). */
function buildMissingResultComment(resumed, automationPrUrl) {
    var errMsg = 'h3. ⚠️ Test Automation Error\n\nFlows may have been written but output JSON is missing. Check workflow logs.' +
        (resumed ? '\n\n_Resume was attempted but also did not produce output files._' : '');
    if (automationPrUrl) {
        errMsg += '\n\n*Automation PR*: ' + automationPrUrl;
    }
    return errMsg;
}

/** Jira markup for the outer catch path. */
function buildErrorComment(error) {
    return 'h3. ❌ Test Automation Error\n\n{code}' + error.toString() + '{code}';
}

// ── gh-1189: result-count derivation ─────────────────────────────────────────

/** PR list of a parsed MCP-ish response (plain array or {data:[...] }). */
function parseMcpPrList(parsed) {
    if (Array.isArray(parsed)) return parsed;
    return (parsed && parsed.data) ? parsed.data : [];
}

/** Classify a per-entry result status ('error' counts as failed). */
function classifyResultStatus(status) {
    var s = String(status || '').toLowerCase();
    if (s === 'passed') return 'passed';
    if (s === 'skipped') return 'skipped';
    if (s === 'failed' || s === 'error') return 'failed';
    return null;
}

/** Passed/failed/skipped tallies over per-entry results. */
function countResultStatuses(results) {
    var counts = { passed: 0, failed: 0, skipped: 0 };
    for (var i = 0; i < results.length; i++) {
        var status = classifyResultStatus(results[i].status);
        if (status === 'passed') counts.passed += 1;
        else if (status === 'skipped') counts.skipped += 1;
        else if (status === 'failed') counts.failed += 1;
    }
    return counts;
}

/** Fill the null top-level counts from the per-entry tallies. */
function mergeFallbackCounts(primary, derived) {
    return {
        passed: primary.passed === null ? derived.passed : primary.passed,
        failed: primary.failed === null ? derived.failed : primary.failed,
        skipped: primary.skipped === null ? derived.skipped : primary.skipped
    };
}

/** Finalize null counts to 0. */
function finalizeCounts(counts) {
    return {
        passed: counts.passed === null ? 0 : counts.passed,
        failed: counts.failed === null ? 0 : counts.failed,
        skipped: counts.skipped === null ? 0 : counts.skipped
    };
}

/** No staged changes in a `git diff --cached --stat` capture. */
function decideNoStagedChanges(stagedOutput) {
    return !stagedOutput || !stagedOutput.trim();
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        parseOutcome: parseOutcome,
        hasA11yWarnings: hasA11yWarnings,
        decideLabels: decideLabels,
        decideFeatureTarget: decideFeatureTarget,
        decideFeaturePrLabels: decideFeaturePrLabels,
        decideWipLabel: decideWipLabel,
        decideSmTriggerLabel: decideSmTriggerLabel,
        resolveFeatureSummary: resolveFeatureSummary,
        needsVerdictPrefix: needsVerdictPrefix,
        prependVerdictIfNeeded: prependVerdictIfNeeded,
        buildBlockedComment: buildBlockedComment,
        buildMissingResultComment: buildMissingResultComment,
        buildErrorComment: buildErrorComment,
        parseMcpPrList: parseMcpPrList,
        classifyResultStatus: classifyResultStatus,
        countResultStatuses: countResultStatuses,
        mergeFallbackCounts: mergeFallbackCounts,
        finalizeCounts: finalizeCounts,
        decideNoStagedChanges: decideNoStagedChanges
    };
}
