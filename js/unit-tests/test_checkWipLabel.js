/**
 * Unit tests for js/checkWipLabel.js
 */

// Real tracker layer loaded WITH the same tool mocks as the script under test
// (loadModule mocks only shadow globals inside the module they are passed to).
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

function loadCheckWipLabel(mocks) {
    mocks = mocks || {};
    return (function (_m) { return loadModule('js/checkWipLabel.js', makeRequire(Object.assign({}, {
            './configLoader.js': {
                loadProjectConfig: function() { return {}; },
                createScm: function() { return {}; }
            },
            './common/githubHelpers.js': {
                findPRForTicket: function() { return null; }
            }
        }, { './common/trackers.js': trackersWith(_m) })), _m); })(mocks);
}

function makeTicket(key, labels) {
    return {
        key: key,
        fields: {
            labels: labels || []
        }
    };
}

suite('checkWipLabel', function() {

    test('continues when no WIP label and no open-PR guard', function() {
        var comments = [];
        var module = loadCheckWipLabel({
            jira_post_comment: function(args) { comments.push(args); }
        });

        var result = module.action({
            ticket: makeTicket('TS-1'),
            metadata: { contextId: 'pr_review' }
        });

        assert.equal(result, true);
        assert.equal(comments.length, 0);
    });

    test('stops when WIP label is present', function() {
        var comments = [];
        var module = loadCheckWipLabel({
            jira_post_comment: function(args) { comments.push(args); }
        });

        var result = module.action({
            ticket: makeTicket('TS-1', ['pr_review_wip']),
            metadata: { contextId: 'pr_review' }
        });

        assert.equal(result, false);
        assert.ok(comments.some(function(c) { return c.comment.indexOf('work is in progress') !== -1; }));
    });

    test('stops when checkOpenPR is set and no open PR exists', function() {
        var comments = [];
        var module = loadCheckWipLabel({
            jira_post_comment: function(args) { comments.push(args); }
        });

        var result = module.action({
            ticket: makeTicket('TS-1'),
            metadata: { contextId: 'pr_rework' },
            jobParams: { customParams: { checkOpenPR: true } }
        });

        assert.equal(result, false);
        assert.ok(comments.some(function(c) { return c.comment.indexOf('No open Pull Request') !== -1; }));
    });

    test('continues when checkOpenPR is set and an open PR exists', function() {
        var module = (function (_m) { return loadModule('js/checkWipLabel.js', makeRequire(Object.assign({}, {
                './configLoader.js': {
                    loadProjectConfig: function() { return {}; },
                    createScm: function() { return {}; }
                },
                './common/githubHelpers.js': {
                    findPRForTicket: function() { return { number: 42 }; }
                }
            }, { './common/trackers.js': trackersWith(_m) })), _m); })({
                jira_post_comment: function() {}
            });

        var result = module.action({
            ticket: makeTicket('TS-1'),
            metadata: { contextId: 'pr_review' },
            jobParams: { customParams: { checkOpenPR: true } }
        });

        assert.equal(result, true);
    });

    test('PR check is skipped when checkOpenPR is not set even if no PR exists', function() {
        var module = loadCheckWipLabel({
            jira_post_comment: function() {}
        });

        var result = module.action({
            ticket: makeTicket('TS-1'),
            metadata: { contextId: 'pr_review' }
        });

        assert.equal(result, true);
    });

});

suite('checkWipLabel: ticket not found guard', function() {

    test('throws when params.ticket is null (ticket not found by inputJql)', function() {
        var wipLabel = loadCheckWipLabel({});
        assert.throws(function() {
            wipLabel.action({ ticket: null, metadata: { contextId: 'story_development' }, jobParams: {} });
        }, /Ticket not found/);
    });

    test('throws when params.ticket is undefined', function() {
        var wipLabel = loadCheckWipLabel({});
        assert.throws(function() {
            wipLabel.action({ metadata: { contextId: 'story_development' }, jobParams: {} });
        }, /Ticket not found/);
    });

    test('throws when params.ticket has no key', function() {
        var wipLabel = loadCheckWipLabel({});
        assert.throws(function() {
            wipLabel.action({ ticket: { fields: {} }, metadata: { contextId: 'story_development' }, jobParams: {} });
        }, /Ticket not found/);
    });

    test('still continues when ticket is present but contextId is missing', function() {
        var wipLabel = loadCheckWipLabel({});
        var result = wipLabel.action({ ticket: makeTicket('PROJ-1', []), metadata: {}, jobParams: {} });
        assert.equal(result, true);
    });

});

// ── PR-anchored start gate (githubSource pseudo-ticket pr-N) ─────────────────
// Live fa #1212 (2026-10-04, run 37200002499): checkOpenPR gate ran
// findPRForTicket('pr-1212') against a single listPrs page whose PRs reference
// their own work items — no match → "No open Pull Request found for this
// ticket" → job stopped → empty rework lap. The gate must resolve a pr-N key
// directly by PR number. These tests wire the REAL githubHelpers (only
// configLoader stays stubbed) so the full gate path is exercised.
suite('checkWipLabel — PR-anchored start gate (githubSource pr-N, fa #1212)', function() {

    var gitOpsStub = {
        checkoutPRBranch: function() {},
        getPRDiff: function() {},
        detectMergeConflicts: function() {},
        trimLargeTextForInput: function() {},
        writePRContext: function() {}
    };

    function loadWithRealHelpers(scm, mocks) {
        var gh = loadModule(
            'js/common/githubHelpers.js',
            makeRequire({
                './pullRequest.js': {
                    buildOriginFetchCommand: function() { return 'git fetch origin'; }
                },
                './gitOps.js': gitOpsStub,
                './machineNotice.js': loadModule('js/common/machineNotice.js'),
                './reviewThreadInventory.js': loadModule('js/common/reviewThreadInventory.js', makeRequire({ './machineNotice.js': loadModule('js/common/machineNotice.js') })),
                './ci.js': loadModule('js/common/ci.js'),
                './ciViolations.js': loadModule('js/common/ciViolations.js'),
                './githubReviewFetch.js': githubReviewFetchReal(),
            }),
            {}
        );
        return (function (_m) { return loadModule('js/checkWipLabel.js', makeRequire(Object.assign({}, {
                './configLoader.js': {
                    loadProjectConfig: function() { return {}; },
                    createScm: function() { return scm; }
                },
                './common/githubHelpers.js': gh
            }, { './common/trackers.js': trackersWith(_m) })), _m); })(mocks || {});
    }

    var anchoredPr = {
        number: 1212,
        title: 'ai/gh-1204: fix telemetry',
        head: { ref: 'ai/gh-1204' },
        state: 'open'
    };

    function anchoredScm() {
        return {
            listPrs: function() {
                // Single page of unrelated open PRs — #1212 is NOT in it.
                return [{ number: 1200, title: 'ai/gh-800: unrelated', head: { ref: 'ai/gh-800' } }];
            },
            getPr: function() { return anchoredPr; }
        };
    }

    test('repro (fa #1212): pr-N pseudo-ticket passes the checkOpenPR gate via direct PR fetch, not the list scan', function() {
        var comments = [];
        var module = loadWithRealHelpers(anchoredScm(), {
            jira_post_comment: function(args) { comments.push(args); }
        });

        var result = module.action({
            ticket: makeTicket('pr-1212'),
            metadata: { contextId: 'pr_rework' },
            jobParams: { customParams: { checkOpenPR: true } }
        });

        assert.equal(result, true, 'PR #1212 is open — the gate must let the rework leg run');
        assert.equal(
            comments.filter(function(c) { return String(c.comment).indexOf('No open Pull Request') !== -1; }).length,
            0,
            'must NOT post the false "No open Pull Request found" skip comment'
        );
    });

    test('pr-N gate still stops when the anchored PR cannot be fetched (honest stop, no false pass)', function() {
        var comments = [];
        var scm = anchoredScm();
        scm.getPr = function() { throw new Error('pulls/1212 not found'); };
        var module = loadWithRealHelpers(scm, {
            jira_post_comment: function(args) { comments.push(args); }
        });

        var result = module.action({
            ticket: makeTicket('pr-1213'),
            metadata: { contextId: 'pr_rework' },
            jobParams: { customParams: { checkOpenPR: true } }
        });

        assert.equal(result, false, 'a PR that cannot be fetched is treated as no open PR — the gate stops');
        assert.ok(
            comments.some(function(c) { return String(c.comment).indexOf('No open Pull Request') !== -1; }),
            'the skip comment is still posted (best-effort for pseudo-tickets)'
        );
    });

    test('jira regression: jira-shaped ticket keeps the exact pre-change gate behavior (list scan)', function() {
        var comments = [];
        var listCalls = [];
        var getPrCalls = [];
        var scm = {
            listPrs: function(state) {
                listCalls.push(state);
                return [{ number: 42, title: 'TS-1: fix', head: { ref: 'feature/ts-1' } }];
            },
            getPr: function(id) { getPrCalls.push(id); return anchoredPr; }
        };
        var module = loadWithRealHelpers(scm, {
            jira_post_comment: function(args) { comments.push(args); }
        });

        var result = module.action({
            ticket: makeTicket('TS-1'),
            metadata: { contextId: 'pr_rework' },
            jobParams: { customParams: { checkOpenPR: true } }
        });

        assert.equal(result, true, 'jira ticket with a scannable PR continues as before');
        assert.equal(comments.length, 0, 'no comments on the passing gate — identical to before');
        assert.deepEqual(listCalls, ['open']);
        assert.equal(getPrCalls.length, 0, 'jira keys never take the anchor fetch');
    });

});


suite('checkWipLabel: ado tracker provider', function() {
    test('posts the skip comment through ado_add_work_item_comment, no jira_* call', function() {
        var calls = [];
        var module = loadCheckWipLabel({
            ado_add_work_item_comment: function(a) { calls.push(a); },
            jira_post_comment: function() { throw new Error('jira_post_comment must not be called on ado'); }
        });
        var result = module.action({
            ticket: makeTicket('101', ['pr_review_wip']),
            metadata: { contextId: 'pr_review' },
            jobParams: { customParams: { trackerProvider: 'ado' } }
        });
        assert.equal(result, false);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].id, '101');
        assert.contains(calls[0].comment, 'work is in progress');
    });

    test('repro (gh-1163): project config tracker.provider="ado" without customParams.trackerProvider routes checkOpenPR skip comment to ado_add_work_item_comment', function() {
        var adoCalls = [];
        var mocks = {
            ado_add_work_item_comment: function(a) { adoCalls.push(a); },
            jira_post_comment: function() { throw new Error('jira_post_comment must not be called on ado'); }
        };
        var module = loadModule('js/checkWipLabel.js', makeRequire({
            './configLoader.js': {
                loadProjectConfig: function() { return { tracker: { provider: 'ado' } }; },
                createScm: function() { return {}; }
            },
            './common/githubHelpers.js': {
                findPRForTicket: function() { return null; }
            },
            './common/trackers.js': trackersWith(mocks)
        }), mocks);

        var result = module.action({
            ticket: makeTicket('2174969', []),
            metadata: { contextId: 'pr_rework' },
            jobParams: { customParams: { checkOpenPR: true } }
        });

        assert.equal(result, false);
        assert.equal(adoCalls.length, 1);
        assert.equal(adoCalls[0].id, '2174969');
        assert.contains(adoCalls[0].comment, 'No open Pull Request found');
    });
});

// ── gh-1077: open-PR guard branch coverage (characterization) ────────────────
suite('checkWipLabel — open-PR guard branch coverage (gh-1077)', function() {

    function loadWithGuard(config, ghMock, mocks) {
        return (function (_m) { return loadModule('js/checkWipLabel.js', makeRequire(Object.assign({}, {
                './configLoader.js': {
                    loadProjectConfig: function() { return config || {}; },
                    createScm: function() { return {}; }
                },
                './common/githubHelpers.js': ghMock || { findPRForTicket: function() { return null; } }
            }, { './common/trackers.js': trackersWith(_m) })), _m); })(mocks || {});
    }

    function guardParams(overrides) {
        return Object.assign({
            ticket: makeTicket('TS-1'),
            metadata: { contextId: 'pr_rework' },
            jobParams: { customParams: { checkOpenPR: true } }
        }, overrides || {});
    }

    test('PR check failure is non-fatal: processing continues (fail-open)', function() {
        var comments = [];
        var module = loadWithGuard({}, {
            findPRForTicket: function() { throw new Error('scm down'); }
        }, { jira_post_comment: function(args) { comments.push(args); } });

        var result = module.action(guardParams());

        assert.equal(result, true);
        assert.equal(comments.length, 0);
    });

    test('config.prSearchFn is forwarded to findPRForTicket', function() {
        var seen = [];
        var prSearchFn = function() { return null; };
        var module = loadWithGuard({ prSearchFn: prSearchFn }, {
            findPRForTicket: function(scm, key, options) { seen.push(options); return { number: 5 }; }
        }, { jira_post_comment: function() {} });

        var result = module.action(guardParams());

        assert.equal(result, true);
        assert.deepEqual(seen, [{ prSearchFn: prSearchFn }]);
    });

    test('without config.prSearchFn the search options are empty', function() {
        var seen = [];
        var module = loadWithGuard({}, {
            findPRForTicket: function(scm, key, options) { seen.push(options); return { number: 5 }; }
        }, { jira_post_comment: function() {} });

        module.action(guardParams());

        assert.deepEqual(seen, [{}]);
    });

    test('comment failure while stopping on a missing PR still stops processing', function() {
        var module = loadWithGuard({}, {
            findPRForTicket: function() { return null; }
        }, { jira_post_comment: function() { throw new Error('comment quota'); } });

        var result = module.action(guardParams());

        assert.equal(result, false);
    });

    test('comment failure on the WIP-label branch still stops processing', function() {
        var module = loadCheckWipLabel({
            jira_post_comment: function() { throw new Error('comment quota'); }
        });

        var result = module.action({
            ticket: makeTicket('TS-1', ['pr_review_wip']),
            metadata: { contextId: 'pr_review' }
        });

        assert.equal(result, false);
    });

    test('several labels: the WIP label is found among unrelated ones', function() {
        var comments = [];
        var module = loadCheckWipLabel({
            jira_post_comment: function(args) { comments.push(args); }
        });

        var result = module.action({
            ticket: makeTicket('TS-1', ['sm_story_development_triggered', 'pr_review_wip', 'other']),
            metadata: { contextId: 'pr_review' }
        });

        assert.equal(result, false);
        assert.equal(comments.length, 1);
    });

    test('labels array without the WIP label continues (multi-label shape)', function() {
        var module = loadCheckWipLabel({
            jira_post_comment: function() { throw new Error('must not comment'); }
        });

        var result = module.action({
            ticket: makeTicket('TS-1', ['sm_story_development_triggered', 'other']),
            metadata: { contextId: 'pr_review' }
        });

        assert.equal(result, true);
    });
});

// ── gh-1077: fail-open error contract (characterization) ─────────────────────
suite('checkWipLabel — fail-open error contract (gh-1077)', function() {

    test('null params (no ticket at all) → non-ticket error → continue processing', function() {
        var module = loadCheckWipLabel({});
        assert.equal(module.action(null), true);
    });

    test('metadata missing entirely → continue processing (no throw)', function() {
        var module = loadCheckWipLabel({});
        var result = module.action({ ticket: makeTicket('TS-1'), jobParams: {} });
        assert.equal(result, true);
    });
});

// ── gh-1077: extracted pure helpers ──────────────────────────────────────────
suite('checkWipLabel — extracted pure helpers (gh-1077)', function() {

    test('wipLabelFor derives <contextId>_wip', function() {
        var module = loadCheckWipLabel({});
        assert.equal(module.wipLabelFor('pr_review'), 'pr_review_wip');
        assert.equal(module.wipLabelFor('story_development'), 'story_development_wip');
    });

    test('labelsOf — fields.labels array, empty, missing labels, missing fields', function() {
        var module = loadCheckWipLabel({});
        assert.deepEqual(module.labelsOf({ fields: { labels: ['a'] } }), ['a']);
        assert.deepEqual(module.labelsOf({ fields: { labels: [] } }), []);
        assert.deepEqual(module.labelsOf({ fields: {} }), []);
        assert.deepEqual(module.labelsOf({}), []);
    });

    test('wipSkipComment embeds the label and the removal hint', function() {
        var module = loadCheckWipLabel({});
        var comment = module.wipSkipComment('pr_review_wip');
        assert.contains(comment, '*Processing Skipped*');
        assert.contains(comment, 'pr_review_wip');
        assert.contains(comment, '_Remove the label to allow automated processing._');
    });

    test('noOpenPrSkipComment carries the gate explanation', function() {
        var module = loadCheckWipLabel({});
        var comment = module.noOpenPrSkipComment();
        assert.contains(comment, '*Processing Skipped*');
        assert.contains(comment, 'No open Pull Request found for this ticket');
        assert.contains(comment, '_Ticket will be processed again once a PR is available._');
    });

    test('requireTicket throws the config-error for null, keyless tickets', function() {
        var module = loadCheckWipLabel({});
        assert.throws(function() { module.requireTicket(null); }, /Ticket not found/);
        assert.throws(function() { module.requireTicket({ fields: {} }); }, /Ticket not found/);
        module.requireTicket({ key: 'TS-1' }); // must not throw
    });

    test('hasContextId — ticket, metadata and contextId are all required', function() {
        var module = loadCheckWipLabel({});
        assert.equal(module.hasContextId({ key: 'k' }, { contextId: 'x' }), true);
        assert.equal(module.hasContextId({ key: 'k' }, { contextId: null }), false);
        assert.equal(module.hasContextId({ key: 'k' }, {}), false);
        assert.equal(module.hasContextId({ key: 'k' }, null), false);
        assert.equal(module.hasContextId(null, { contextId: 'x' }), false);
    });

    test('resolveCustomParams — jobParams win over params, defaults to {}', function() {
        var module = loadCheckWipLabel({});
        assert.deepEqual(module.resolveCustomParams({ jobParams: { customParams: { a: 1 } }, customParams: { b: 2 } }), { a: 1 });
        assert.deepEqual(module.resolveCustomParams({ customParams: { b: 2 } }), { b: 2 });
        assert.deepEqual(module.resolveCustomParams({ jobParams: {} }), {});
        assert.deepEqual(module.resolveCustomParams({}), {});
    });

    test('isTicketNotFoundError — only the exact ticket-missing config error rethrows', function() {
        var module = loadCheckWipLabel({});
        assert.equal(module.isTicketNotFoundError(new Error('Ticket not found or not provided: x')), true);
        assert.equal(module.isTicketNotFoundError(new Error('some transient failure')), false);
        assert.equal(module.isTicketNotFoundError({ message: 'wrapped Ticket not found text' }), false);
        assert.equal(module.isTicketNotFoundError({}), false);
        assert.equal(module.isTicketNotFoundError(null), false);
        assert.equal(module.isTicketNotFoundError('Ticket not found'), false);
    });
});
