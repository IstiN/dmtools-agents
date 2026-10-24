/**
 * recoverDirtyReviewTestCase.js
 *
 * Local-execution recovery for Test Cases stuck in code review because the
 * underlying test-automation PR has become dirty (merge conflicts with main).
 *
 * The normal flow is:
 *   In Review - Passed/Failed -> pr_test_automation_review -> pr_approved -> merge
 *
 * When the PR is dirty, merge is impossible and review cannot complete. This
 * handler detects a dirty/conflicting PR and moves the ticket to "In Rework"
 * so the dedicated pr_test_automation_rework agent resolves the conflicts.
 */

var scmModule = require('./common/scm.js');
var configLoader = require('./configLoader.js');
var trackersModule = require('./common/trackers.js');
// gh-1248: the lenient JSON coercion helpers — canonical copy in
// common/loseJson.js (shared with scm.js).
var loseJson = require('./common/loseJson.js');

var PR_CACHE_FILE = 'outputs/.recover_dirty_prs_cache.json';
var PR_CACHE_TTL_MS = 5 * 60 * 1000;

function _now() {
    return new Date().getTime();
}

function _readCache() {
    try {
        var raw = file_read({ path: PR_CACHE_FILE });
        if (raw) {
            var parsed = JSON.parse(raw);
            if (parsed && parsed.timestamp && (_now() - parsed.timestamp) < PR_CACHE_TTL_MS) {
                return parsed.prList;
            }
        }
    } catch (e) {
        // ignore cache read errors
    }
    return null;
}

function _writeCache(prList) {
    try {
        var slim = prList.map(function(pr) {
            return {
                number: pr.number,
                title: pr.title,
                head: { ref: pr.head && pr.head.ref ? pr.head.ref : '' },
                mergeable: pr.mergeable,
                mergeable_state: pr.mergeable_state || pr.mergeableState,
                mergeableState: pr.mergeableState || pr.mergeable_state
            };
        });
        file_write({ path: PR_CACHE_FILE, content: JSON.stringify({ timestamp: _now(), prList: slim }) });
    } catch (e) {
        console.warn('Failed to write PR cache:', e.message || e);
    }
}

function _parseJson(raw) {
    return loseJson.parseJsonLose(raw);
}

function _toArray(raw) {
    return loseJson.toArrayLose(raw, ['items']);
}

function listOpenPrsCached(scm, config) {
    var cached = _readCache();
    if (cached) {
        console.log('Using cached open PR list (' + cached.length + ' PRs)');
        return cached;
    }
    try {
        var prList = scm.listPrs('open');
        prList = _toArray(prList);
        _writeCache(prList);
        return prList;
    } catch (e) {
        console.error('Failed to list PRs:', e);
        return [];
    }
}

function findOpenPRForTicket(scm, config, ticketKey) {
    var prList = listOpenPrsCached(scm, config);
    return prList.find(function(pr) {
        // Exact ticket match only — avoid false positives like TS-135 matching TS-1359
        var titleMatch = pr.title && new RegExp('^' + ticketKey + '(\\b|\\s|[-:_])').test(pr.title);
        var ref = pr.head && pr.head.ref ? pr.head.ref : '';
        var branchMatch = ref === ticketKey || ref.endsWith('/' + ticketKey);
        return titleMatch || branchMatch;
    }) || null;
}

// ── gh-1077 extracted pure helpers (parse/build/decide) ─────────────────────

function resolveTicketKey(params) {
    return params.ticket && params.ticket.key;
}

function resolveCustomParams(params) {
    return (params.jobParams && params.jobParams.customParams) || params.customParams || {};
}

function loadConfig(params) {
    return configLoader.loadProjectConfig(params.jobParams || params || {});
}

// True when the PR list row already carries mergeability info, so the extra
// getPr call can be avoided.
function prHasMergeInfo(pr) {
    return pr.mergeable !== undefined || pr.mergeableState || pr.mergeable_state;
}

// Fetch PR details, falling back to the list row when the call fails.
function fetchPrDetail(scm, pr) {
    try {
        return scm.getPr(pr.number);
    } catch (e) {
        console.error('Failed to get PR details:', e);
        return pr;
    }
}

function mergeStateOf(prDetail) {
    return prDetail && (prDetail.mergeable_state || prDetail.mergeableState || '');
}

function mergeableFlagOf(prDetail) {
    return prDetail && prDetail.mergeable;
}

// dirty = conflicting merge state or an explicit mergeable=false
function isDirtyMergeState(mergeableState, mergeable) {
    return mergeableState === 'dirty' || mergeableState === 'conflicting' || mergeable === false;
}

// Remove stale labels so the rework agent can pick it up (best effort, in order)
function stripStaleRecoveryLabels(tracker, ticketKey) {
    try { tracker.removeLabel(ticketKey, 'sm_test_rework_triggered'); } catch (e) {}
    try { tracker.removeLabel(ticketKey, 'sm_test_automation_triggered'); } catch (e) {}
    try { tracker.removeLabel(ticketKey, 'sm_test_review_triggered'); } catch (e) {}
}

function postRecoveryComment(tracker, ticketKey, prNumber) {
    try {
        tracker.postComment(ticketKey, '🔄 *Recovery*: Test Case PR #' + prNumber + ' became dirty while in code review. Moved to In Rework so the test-automation rework agent can resolve the merge conflicts.'
        );
    } catch (e) {
        console.warn('Failed to post recovery comment:', e);
    }
}

function action(params) {
    var ticketKey = resolveTicketKey(params);
    var config = loadConfig(params);
    var jiraConfig = config.jira;
    var tracker = trackersModule.createTracker(config, resolveCustomParams(params));

    if (!ticketKey) {
        console.error('No ticket key found');
        return { success: false, error: 'missing ticket key' };
    }

    console.log('Recovering dirty-review Test Case:', ticketKey);

    var scm = scmModule.createScm(config);
    var pr = findOpenPRForTicket(scm, config, ticketKey);

    if (!pr) {
        console.log('No open PR found for', ticketKey, '— nothing to recover');
        return { success: true, action: 'no_pr', ticketKey: ticketKey };
    }

    console.log('Found open PR #' + pr.number + ': ' + pr.title);

    // Avoid an extra API call if the PR list already returned mergeability info
    var prDetail = prHasMergeInfo(pr) ? pr : fetchPrDetail(scm, pr);
    var mergeableState = mergeStateOf(prDetail);
    var mergeable = mergeableFlagOf(prDetail);
    console.log('PR #' + pr.number + ' mergeable=' + mergeable + ' state=' + mergeableState);

    if (!isDirtyMergeState(mergeableState, mergeable)) {
        console.log('PR #' + pr.number + ' is clean — no recovery needed');
        return { success: true, action: 'clean', ticketKey: ticketKey, prNumber: pr.number };
    }

    console.log('PR #' + pr.number + ' is dirty — moving ticket to In Rework for conflict resolution');
    try {
        tracker.moveToStatus(ticketKey, jiraConfig.statuses.IN_REWORK);
        console.log('Moved', ticketKey, 'to In Rework');
    } catch (e) {
        console.error('Failed to move to In Rework:', e);
        return { success: false, error: e.toString(), ticketKey: ticketKey, prNumber: pr.number };
    }

    stripStaleRecoveryLabels(tracker, ticketKey);
    postRecoveryComment(tracker, ticketKey, pr.number);

    return { success: true, action: 'moved_to_rework', ticketKey: ticketKey, prNumber: pr.number };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        resolveTicketKey: resolveTicketKey,
        resolveCustomParams: resolveCustomParams,
        prHasMergeInfo: prHasMergeInfo,
        fetchPrDetail: fetchPrDetail,
        mergeStateOf: mergeStateOf,
        mergeableFlagOf: mergeableFlagOf,
        isDirtyMergeState: isDirtyMergeState,
        _parseJson: _parseJson,
        _toArray: _toArray,
        _readCache: _readCache
    };
}
