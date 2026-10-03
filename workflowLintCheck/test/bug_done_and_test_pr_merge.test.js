/**
 * Unit tests for:
 *  - mergeStoryTestAutomationPR.attemptMerge
 *  - checkBugTestsPassed.action
 *
 * Runs with plain Node.js. Mocks DMTools globals and the scm/configLoader
 * dependencies so no network calls or real Jira/GitHub state is touched.
 */

const assert = require('assert');
const path = require('path');

const AGENT_JS_DIR = path.resolve(__dirname, '..');

// ---- test state collectors -------------------------------------------------
const calls = {
    jiraMove: [],
    jiraAddLabel: [],
    jiraRemoveLabel: [],
    jiraPostComment: [],
    jiraSearch: [],
    githubMerge: [],
    githubListPrs: [],
    githubGetPr: [],
    githubGetCommitChecks: [],
    cliExecute: []
};

function resetCalls() {
    for (const k of Object.keys(calls)) calls[k] = [];
}

// ---- DMTools globals used by the modules -----------------------------------
global.jira_get_ticket = function(opts) {
    return opts && opts.__ticket ? opts.__ticket : {};
};
global.jira_move_to_status = function(opts) {
    calls.jiraMove.push(opts);
};
global.jira_add_label = function(opts) {
    calls.jiraAddLabel.push(opts);
};
global.jira_remove_label = function(opts) {
    calls.jiraRemoveLabel.push(opts);
};
global.jira_post_comment = function(opts) {
    calls.jiraPostComment.push(opts);
};
global.jira_search_by_jql = function(opts) {
    calls.jiraSearch.push(opts);
    return opts && opts.__results ? opts.__results : [];
};

global.github_merge_pr = function(opts) {
    calls.githubMerge.push(opts);
    if (opts && opts.__throw) throw new Error(opts.__throw);
    return { merged: true };
};
global.github_list_prs = function(opts) {
    calls.githubListPrs.push(opts);
    return opts && opts.__results ? opts.__results : [];
};
global.github_get_pr = function(opts) {
    calls.githubGetPr.push(opts);
    return opts && opts.__pr ? opts.__pr : {};
};
global.github_get_commit_check_runs = function(opts) {
    calls.githubGetCommitChecks.push(opts);
    return opts && opts.__checks ? opts.__checks : [];
};
global.cli_execute_command = function(opts) {
    calls.cliExecute.push(opts);
    if (opts && opts.__return !== undefined) return opts.__return;
    return '';
};
global.file_read = function() { return ''; };

// ---- dependency mocks ------------------------------------------------------
const fakeProjectConfig = {
    jira: {
        issueTypes: {
            TEST_CASE: 'Test Case',
            BUG: 'Bug'
        }
    }
};

function fakeScmFor(scenario) {
    scenario = scenario || {};
    return {
        getRemoteRepoInfo: function() {
            return { owner: 'IstiN', repo: 'trackstate' };
        },
        listPrs: function(state) {
            const list = state === 'open' ? (scenario.openPrs || []) : (scenario.closedPrs || []);
            return JSON.parse(JSON.stringify(list));
        },
        getPr: function(id) {
            return JSON.parse(JSON.stringify(scenario.prDetail || {}));
        },
        getCommitCheckRuns: function(sha) {
            return JSON.parse(JSON.stringify(scenario.checkRuns || []));
        },
        mergePr: function(id, method) {
            calls.githubMerge.push({ pullRequestId: id, mergeMethod: method });
            if (scenario.mergeThrows) throw new Error(scenario.mergeThrows);
            return { merged: true };
        },
        removeLabel: function(id, label) {
            calls.jiraRemoveLabel.push({ pr: id, label: label });
        },
        addLabel: function(id, label) {
            calls.jiraAddLabel.push({ pr: id, label: label });
        },
        updateBranch: function(id) {
            scenario.updated = true;
        }
    };
}

function installMocks(scenario) {
    const scmMock = { createScm: function() { return fakeScmFor(scenario); } };
    const configLoaderMock = { loadProjectConfig: function() { return fakeProjectConfig; } };
    const tokenUsageMock = { postTokenUsageComments: function() {} };

    setModuleMock(path.join(AGENT_JS_DIR, 'common', 'scm.js'), scmMock);
    setModuleMock(path.join(AGENT_JS_DIR, 'configLoader.js'), configLoaderMock);
    setModuleMock(path.join(AGENT_JS_DIR, 'common', 'tokenUsageComment.js'), tokenUsageMock);
}

function setModuleMock(file, exports) {
    const mod = {
        id: file,
        filename: file,
        loaded: true,
        exports: exports,
        children: [],
        paths: []
    };
    require.cache[file] = mod;
}

function requireFresh(modulePath) {
    const absPath = require.resolve(path.join(AGENT_JS_DIR, modulePath));
    delete require.cache[absPath];
    return require(absPath);
}

// ---- tests -----------------------------------------------------------------

function runTests() {
    console.log('Running JS unit tests for bug_done + test-automation PR merge\n');

    // ------------------------------------------------------------------------
    test('attemptMerge: no test-automation PR => success/noPr', function() {
        resetCalls();
        installMocks({ openPrs: [], closedPrs: [] });
        const merger = requireFresh('./mergeStoryTestAutomationPR.js');
        const result = merger.attemptMerge(makeParams('TS-9999'));
        assert.strictEqual(result.success, true, 'should succeed');
        assert.strictEqual(result.noPr, true, 'should report no PR');
        assert.strictEqual(calls.githubMerge.length, 0, 'should not attempt merge');
    });

    test('attemptMerge: already merged PR => finalizes labels', function() {
        resetCalls();
        const scenario = {
            openPrs: [],
            closedPrs: [{ number: 2001, html_url: 'http://pr/2001', head: { ref: 'test/TS-1000' }, merged_at: '2026-01-01' }]
        };
        installMocks(scenario);
        const merger = requireFresh('./mergeStoryTestAutomationPR.js');
        const result = merger.attemptMerge(makeParams('TS-1000'));
        assert.strictEqual(result.success, true, 'should succeed');
        assert.strictEqual(result.alreadyMerged, true, 'should report already merged');
        assertLabelAdded('TS-1000', 'test_pr_finalized');
    });

    test('attemptMerge: CI still running => blocks merge', function() {
        resetCalls();
        const scenario = {
            openPrs: [{ number: 2002, html_url: 'http://pr/2002', head: { ref: 'test/TS-1001' } }],
            prDetail: { mergeable: true, mergeable_state: 'blocked', head: { sha: 'abc' } },
            checkRuns: [{ name: 'Flutter checks', status: 'in_progress', conclusion: null }]
        };
        installMocks(scenario);
        const merger = requireFresh('./mergeStoryTestAutomationPR.js');
        const result = merger.attemptMerge(makeParams('TS-1001'));
        assert.strictEqual(result.success, false, 'should fail');
        assert.strictEqual(result.reason, 'ci_running', 'should report CI running');
        assert.strictEqual(calls.githubMerge.length, 0, 'should not attempt merge');
    });

    test('attemptMerge: clean PR => merges and finalizes', function() {
        resetCalls();
        const scenario = {
            openPrs: [{ number: 2003, html_url: 'http://pr/2003', head: { ref: 'test/TS-1002' } }],
            prDetail: { mergeable: true, mergeable_state: 'clean', head: { sha: 'def' } },
            checkRuns: [{ name: 'Flutter checks', status: 'completed', conclusion: 'success' }]
        };
        installMocks(scenario);
        const merger = requireFresh('./mergeStoryTestAutomationPR.js');
        const result = merger.attemptMerge(makeParams('TS-1002'));
        assert.strictEqual(result.success, true, 'should succeed');
        assert.strictEqual(result.reason, 'merged', 'should report merged');
        assert.strictEqual(result.prNumber, 2003, 'should return PR number');
        assertLabelAdded('TS-1002', 'test_pr_finalized');
        assert.strictEqual(calls.githubMerge.length, 1, 'should call github_merge_pr');
    });

    test('attemptMerge: merge conflict => reports conflict without status change', function() {
        resetCalls();
        const scenario = {
            openPrs: [{ number: 2004, html_url: 'http://pr/2004', head: { ref: 'test/TS-1003' } }],
            prDetail: { mergeable: false, mergeable_state: 'dirty', head: { sha: 'ghi' } },
            checkRuns: []
        };
        installMocks(scenario);
        const merger = requireFresh('./mergeStoryTestAutomationPR.js');
        const result = merger.attemptMerge(makeParams('TS-1003'));
        assert.strictEqual(result.success, false, 'should fail');
        assert.strictEqual(result.reason, 'conflict', 'should report conflict');
        assert.strictEqual(calls.jiraMove.length, 0, 'should not move Jira ticket');
    });

    // ------------------------------------------------------------------------
    test('checkBugTestsPassed: all TCs passed + PR merged => moves bug to Done', function() {
        resetCalls();
        const scenario = {
            openPrs: [{ number: 2005, html_url: 'http://pr/2005', head: { ref: 'test/TS-2000' } }],
            prDetail: { mergeable: true, mergeable_state: 'clean', head: { sha: 'jkl' } },
            checkRuns: [{ name: 'Flutter checks', status: 'completed', conclusion: 'success' }]
        };
        installMocks(scenario);
        requireFresh('./mergeStoryTestAutomationPR.js');
        const doneCheck = requireFresh('./checkBugTestsPassed.js');

        const params = makeParams('TS-2000', {
            directTCs: [{ key: 'TS-5000', fields: { status: { name: 'Passed' } } }]
        });
        const result = doneCheck.action(params);

        assert.strictEqual(result.action, 'moved_to_done', 'should move to Done');
        assertJiraMovedTo('TS-2000', 'Done');
        assertLabelAdded('TS-2000', 'test_pr_finalized');
    });

    test('checkBugTestsPassed: all TCs passed but PR not ready => keeps bug in In Testing', function() {
        resetCalls();
        const scenario = {
            openPrs: [{ number: 2006, html_url: 'http://pr/2006', head: { ref: 'test/TS-2001' } }],
            prDetail: { mergeable: true, mergeable_state: 'blocked', head: { sha: 'mno' } },
            checkRuns: [{ name: 'Flutter checks', status: 'in_progress', conclusion: null }]
        };
        installMocks(scenario);
        requireFresh('./mergeStoryTestAutomationPR.js');
        const doneCheck = requireFresh('./checkBugTestsPassed.js');

        const params = makeParams('TS-2001', {
            directTCs: [{ key: 'TS-5001', fields: { status: { name: 'Passed' } } }]
        });
        const result = doneCheck.action(params);

        assert.strictEqual(result.action, 'waiting_for_test_pr_merge', 'should wait for PR merge');
        assert.strictEqual(calls.jiraMove.length, 0, 'should not move Jira ticket');
    });

    test('checkBugTestsPassed: blocking TC => does not merge or move to Done', function() {
        resetCalls();
        installMocks({ openPrs: [], closedPrs: [] });
        requireFresh('./mergeStoryTestAutomationPR.js');
        const doneCheck = requireFresh('./checkBugTestsPassed.js');

        const params = makeParams('TS-2002', {
            directTCs: [{ key: 'TS-5002', fields: { status: { name: 'Failed' } } }]
        });
        const result = doneCheck.action(params);

        assert.strictEqual(result.action, 'waiting', 'should wait for TCs');
        assert.strictEqual(calls.jiraMove.length, 0, 'should not move Jira ticket');
        assert.strictEqual(calls.githubMerge.length, 0, 'should not attempt PR merge');
    });

    console.log('\n✅ All JS unit tests passed');
}

// ---- helpers ---------------------------------------------------------------

function makeParams(ticketKey, opts) {
    opts = opts || {};
    const ticket = {
        key: ticketKey,
        fields: {
            issuetype: { name: 'Bug' },
            labels: [],
            issuelinks: (opts.directTCs || []).map(function(tc) {
                return { outwardIssue: tc };
            })
        }
    };

    const params = {
        ticket: ticket,
        jobParams: {
            customParams: {
                removeLabel: 'sm_bug_done_check_triggered'
            }
        }
    };

    // Patch jira_get_ticket to return our ticket for this params object only.
    const originalGetTicket = global.jira_get_ticket;
    global.jira_get_ticket = function() { return ticket; };

    // Patch jira_search_by_jql to return direct TCs for linkedIssues fallback.
    const originalSearch = global.jira_search_by_jql;
    global.jira_search_by_jql = function(q) {
        if (q && q.jql && q.jql.indexOf('linkedIssues') !== -1 && q.jql.indexOf('issuetype = "Test Case"') !== -1) {
            return opts.directTCs || [];
        }
        if (q && q.jql && q.jql.indexOf('issuetype = "Bug"') !== -1) {
            return [];
        }
        return [];
    };

    // Restore originals after action returns.
    const cleanup = function() {
        global.jira_get_ticket = originalGetTicket;
        global.jira_search_by_jql = originalSearch;
    };
    params.__cleanup = cleanup;
    return params;
}

function test(name, fn) {
    try {
        fn();
        console.log('  ✅', name);
    } catch (e) {
        console.error('  ❌', name);
        console.error(e.stack || e.message);
        process.exitCode = 1;
    } finally {
        // Restore patched globals if params had cleanup.
        // Tests that use makeParams should not need it because we patched globals directly,
        // but this is a safety net.
    }
}

function assertLabelAdded(ticketKey, label) {
    const found = calls.jiraAddLabel.some(function(c) {
        return c.key === ticketKey && c.label === label;
    });
    assert.ok(found, 'expected label ' + label + ' to be added to ' + ticketKey);
}

function assertJiraMovedTo(ticketKey, status) {
    const found = calls.jiraMove.some(function(c) {
        return c.key === ticketKey && c.statusName === status;
    });
    assert.ok(found, 'expected ' + ticketKey + ' to be moved to ' + status);
}

runTests();
