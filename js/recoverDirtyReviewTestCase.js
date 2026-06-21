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
var { STATUSES } = require('./config.js');

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
        file_write({ path: PR_CACHE_FILE, content: JSON.stringify({ timestamp: _now(), prList: prList }) });
    } catch (e) {
        // ignore cache write errors
    }
}

function _parseJson(raw) {
    if (typeof raw === 'string') {
        try { return JSON.parse(raw); } catch (e) { return raw; }
    }
    return raw;
}

function _toArray(raw) {
    var parsed = _parseJson(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && parsed.value) return parsed.value;
    if (parsed && parsed.items) return parsed.items;
    return parsed ? [parsed] : [];
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

function action(params) {
    var ticketKey = params.ticket && params.ticket.key;
    var config = configLoader.loadProjectConfig(params.jobParams || params || {});

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

    var prDetail;
    // Avoid an extra API call if the PR list already returned mergeability info
    if (pr.mergeable !== undefined || pr.mergeableState || pr.mergeable_state) {
        prDetail = pr;
    } else {
        try {
            prDetail = scm.getPr(pr.number);
        } catch (e) {
            console.error('Failed to get PR details:', e);
            prDetail = pr;
        }
    }

    var mergeableState = prDetail && (prDetail.mergeable_state || prDetail.mergeableState || '');
    var mergeable = prDetail && prDetail.mergeable;
    console.log('PR #' + pr.number + ' mergeable=' + mergeable + ' state=' + mergeableState);

    var isDirty = mergeableState === 'dirty' || mergeableState === 'conflicting' || mergeable === false;
    if (!isDirty) {
        console.log('PR #' + pr.number + ' is clean — no recovery needed');
        return { success: true, action: 'clean', ticketKey: ticketKey, prNumber: pr.number };
    }

    console.log('PR #' + pr.number + ' is dirty — moving ticket to In Rework for conflict resolution');
    try {
        jira_move_to_status({ key: ticketKey, statusName: STATUSES.IN_REWORK });
        console.log('Moved', ticketKey, 'to In Rework');
    } catch (e) {
        console.error('Failed to move to In Rework:', e);
        return { success: false, error: e.toString(), ticketKey: ticketKey, prNumber: pr.number };
    }

    // Remove stale labels so the rework agent can pick it up
    try { jira_remove_label({ key: ticketKey, label: 'sm_test_rework_triggered' }); } catch (e) {}
    try { jira_remove_label({ key: ticketKey, label: 'sm_test_automation_triggered' }); } catch (e) {}
    try { jira_remove_label({ key: ticketKey, label: 'sm_test_review_triggered' }); } catch (e) {}

    try {
        jira_post_comment({
            key: ticketKey,
            comment: '🔄 *Recovery*: Test Case PR #' + pr.number + ' became dirty while in code review. Moved to In Rework so the test-automation rework agent can resolve the merge conflicts.'
        });
    } catch (e) {
        console.warn('Failed to post recovery comment:', e);
    }

    return { success: true, action: 'moved_to_rework', ticketKey: ticketKey, prNumber: pr.number };
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { action };
}
