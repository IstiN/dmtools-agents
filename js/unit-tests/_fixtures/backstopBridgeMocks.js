/**
 * Shared merge-backstop bridge mocks (gh-1370 rework).
 *
 * backstopBridgeMocks lived duplicated in test_mergeBot.js
 * and test_mergeTrigger.js — near-identical only (5 differing lines: the
 * two builders' lead comments plus mergeBot's extra github_search_issues
 * slot), and gh-1370 had to extend BOTH copies with the
 * exact same resolveFailIds branch — the classic parallel-edit cost of
 * duplicated fixtures (miss one copy and the two suites silently diverge
 * in failure-injection capability). This module owns the builder in
 * exactly one place. The one genuine difference between the copies —
 * mergeBot also mocks github_search_issues (the digest dedup probe,
 * calls.debtSearches) while mergeTrigger serves that global with its
 * labeledIssues mock — is parameterized: pass the search mock as the
 * third argument; omit it to leave an existing github_search_issues
 * mapping untouched.
 *
 * Loaded by both test files via loadModule() (available at test-file top
 * level under testRunner.js and node_testRunner.js alike). GraalJS-safe:
 * var + function declarations only. Named builders (resolveThreadMock,
 * createIssueMock) keep every unit under the CRAP ratchet — the
 * resolveFailIds branch that pushed both twin copies to 9 > 8 lives here,
 * once (gh-1200 precedent: named mock builders).
 */

// gh-1370: resolveFailIds names thread ids whose resolve throws — the
// read-live opts lets a test clear the fault and replay the retry
// (the gate holds that merge; the next tick converges).
function resolveThreadMock(opts, calls) {
    return function (a) {
        if ((opts.resolveFailIds || []).indexOf(String(a.threadId)) !== -1) {
            throw new Error('422 ' + a.threadId);
        }
        calls.threadResolves.push(a);
        // gh-1417: a successful resolve MUTATES the served payload — the
        // stage-2 census re-reads the threads and must see the
        // post-resolution reality (a static payload would hold every
        // backstop replay forever).
        var prs = (opts.threadsByNumber || {})[String(a.pullRequestId)];
        (prs || []).forEach(function (n) {
            if (n && String(n.id) === String(a.threadId)) n.isResolved = true;
        });
        return '{}';
    };
}

function createIssueMock(opts, calls) {
    return function (a) {
        calls.debtIssues.push(a);
        if (opts.createIssueThrows) throw new Error(opts.createIssueThrows);
        return JSON.stringify({ number: 500 + calls.debtIssues.length, title: a.title });
    };
}

function backstopBridgeMocks(opts, calls, searchIssuesMock) {
    // gh-1353 merge-backstop bridge tools: the threads read serves
    // opts.threadsByNumber (PR number → reviewThread nodes) — empty by
    // default (clean replay, merges as today); noThreads removes the
    // primitive entirely (capability miss). The node arrays serve BY
    // REFERENCE and resolveThread MUTATES them (gh-1417: the stage-2
    // census re-reads the threads and must see the post-resolution
    // reality — a static payload would hold every backstop replay
    // forever; tests flip isResolved through the same opts objects).
    var bag = {
        github_get_pr_review_threads: opts.noThreads ? undefined : function (a) {
            calls.threads.push(a);
            return JSON.stringify({ data: { repository: { pullRequest:
                { reviewThreads: { nodes: (opts.threadsByNumber || {})[a.pullRequestId] || [] } } } } });
        },
        github_get_pr_comments: function (a) {
            return JSON.stringify(opts.prCommentsByNumber && opts.prCommentsByNumber[a.pullRequestId] || []);
        },
        github_create_issue: createIssueMock(opts, calls),
        github_resolve_pr_thread: resolveThreadMock(opts, calls),
        github_reply_to_pr_thread: function (a) { calls.threadReplies.push(a); return '{}'; }
    };
    if (searchIssuesMock) bag.github_search_issues = searchIssuesMock;
    return bag;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { backstopBridgeMocks: backstopBridgeMocks };
}
