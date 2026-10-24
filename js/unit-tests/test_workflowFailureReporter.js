/**
 * Unit tests for js/workflowFailureReporter.js (gh-1007 CRAP reduction).
 *
 * Covers the pure helpers extracted from action() (parseWorkflowRuns,
 * detectTicketKey, buildBugSummary, buildBugDescription, extractKeyFromString,
 * extractCreatedTicketKey, processFailedRun) and the jira-path behavior of
 * action() itself: dedup by ci-run label, open-bug skip by ci-ticket label,
 * bug creation, labeling and linking.
 *
 * Uses: configModule, loadModule(), makeRequire(), assert, test(), suite()
 */

// ── Loader helper ─────────────────────────────────────────────────────────────

function wfrTrackers(mocks) {
    return loadModule('js/common/trackers.js', makeRequire({
        '../config.js': configModule,
        './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
    }), mocks || {});
}

function loadReporter(mocks, scmStub) {
    var scm = scmStub || {
        createScm: function() {
            throw new Error('createScm not expected — pass scmStub explicitly');
        }
    };
    return loadModule('js/workflowFailureReporter.js', makeRequire({
        './common/scm.js': scm,
        './common/trackers.js': wfrTrackers(mocks)
    }), mocks || {});
}

function scmWithRuns(runsResult) {
    return {
        createScm: function() {
            return { listWorkflowRuns: function() { return runsResult; } };
        }
    };
}

function jiraMocks(calls, extra) {
    var m = {};
    ['jira_search_by_jql', 'jira_create_ticket_basic', 'jira_add_label', 'jira_link_issues'].forEach(function(n) {
        m[n] = function(a) { calls.push({ tool: n, args: a }); };
    });
    return Object.assign(m, extra || {});
}

function jiraFind(calls, tool) {
    return calls.filter(function(c) { return c.tool === tool; });
}

var WFR_PARAMS = { jobParams: { customParams: { workspace: 'w', repository: 'r', jiraProject: 'PROJ' } } };

function runAction(mod, customParams) {
    return mod.action({ jobParams: { customParams: customParams } });
}

// ── parseWorkflowRuns ─────────────────────────────────────────────────────────

suite('workflowFailureReporter.parseWorkflowRuns', function() {
    test('extracts workflow_runs from an object payload', function() {
        var mod = loadReporter();
        var r = mod.parseWorkflowRuns({ workflow_runs: [{ id: 1 }, { id: 2 }] });
        assert.deepEqual(r, { runs: [{ id: 1 }, { id: 2 }] });
    });

    test('parses a JSON string payload', function() {
        var mod = loadReporter();
        var r = mod.parseWorkflowRuns('{"workflow_runs":[{"id":7}]}');
        assert.equal(r.runs.length, 1);
        assert.equal(r.runs[0].id, 7);
    });

    test('returns an empty run list when workflow_runs is missing', function() {
        var mod = loadReporter();
        assert.deepEqual(mod.parseWorkflowRuns({}), { runs: [] });
    });

    test('returns an error for an unparseable string payload', function() {
        var mod = loadReporter();
        var r = mod.parseWorkflowRuns('{not json');
        assert.equal(r.error, 'Failed to parse workflow runs');
    });

    test('returns an error for a JSON null payload (null.workflow_runs throws)', function() {
        var mod = loadReporter();
        assert.equal(mod.parseWorkflowRuns('null').error, 'Failed to parse workflow runs');
    });
});

// ── detectTicketKey ───────────────────────────────────────────────────────────

suite('workflowFailureReporter.detectTicketKey', function() {
    test('extracts the key from a "name : PROJ-123" run name', function() {
        var mod = loadReporter();
        assert.equal(mod.detectTicketKey('ci.yml : PROJ-123'), 'PROJ-123');
    });

    test('returns null when the run name has no ticket key', function() {
        var mod = loadReporter();
        assert.equal(mod.detectTicketKey('ci'), null);
    });

    test('returns null for a null run name', function() {
        var mod = loadReporter();
        assert.equal(mod.detectTicketKey(null), null);
    });
});

// ── buildBugSummary / buildBugDescription ─────────────────────────────────────

suite('workflowFailureReporter bug text builders', function() {
    function sampleRun(extra) {
        return Object.assign({
            id: 9,
            name: 'ci : PROJ-1',
            run_number: 3,
            head_branch: 'main',
            head_sha: 'abcdef1234567',
            html_url: 'https://example/run/9'
        }, extra || {});
    }

    test('summary includes run name, number and workflow id when configured', function() {
        var mod = loadReporter();
        assert.equal(mod.buildBugSummary(sampleRun(), 'ci.yml'),
            'Failed CI: ci : PROJ-1 #3 [ci.yml]');
    });

    test('summary omits the workflow id bracket when not configured', function() {
        var mod = loadReporter();
        assert.equal(mod.buildBugSummary(sampleRun(), null), 'Failed CI: ci : PROJ-1 #3');
    });

    test('description carries ticket, branch, short commit and run url', function() {
        var mod = loadReporter();
        var d = mod.buildBugDescription(sampleRun(), 'ci : PROJ-1', 'PROJ-1');
        assert.contains(d, '*Ticket:* [PROJ-1]');
        assert.contains(d, '*Workflow:* ci : PROJ-1');
        assert.contains(d, '*Branch:* main');
        assert.contains(d, '*Commit:* abcdef1');
        assert.contains(d, '*URL:* https://example/run/9');
        assert.contains(d, '*Run ID:* 9');
    });

    test('description tolerates missing ticket key and missing run fields', function() {
        var mod = loadReporter();
        var d = mod.buildBugDescription(sampleRun({ head_branch: undefined, head_sha: undefined }), 'unknown', null);
        assert.notContains(d, '*Ticket:*');
        assert.contains(d, '*Branch:* unknown');
        assert.contains(d, '*Commit:* unknown');
    });
});

// ── extractCreatedTicketKey ───────────────────────────────────────────────────

suite('workflowFailureReporter.extractCreatedTicketKey', function() {
    function load() { return loadReporter(); }

    test('returns null for empty results', function() {
        assert.equal(load().extractCreatedTicketKey(null), null);
        assert.equal(load().extractCreatedTicketKey(''), null);
    });

    test('extracts the key from a JSON string result', function() {
        assert.equal(load().extractCreatedTicketKey('{"id":"5","key":"PROJ-42"}'), 'PROJ-42');
    });

    test('accepts a bare key string', function() {
        assert.equal(load().extractCreatedTicketKey('PROJ-42'), 'PROJ-42');
    });

    test('extracts the key from a /browse/ URL string', function() {
        assert.equal(load().extractCreatedTicketKey('https://jira/browse/PROJ-42'), 'PROJ-42');
    });

    test('returns the key of an object result', function() {
        assert.equal(load().extractCreatedTicketKey({ key: 'PROJ-42', id: '5' }), 'PROJ-42');
    });

    test('returns null when no shape matches', function() {
        assert.equal(load().extractCreatedTicketKey({ id: '5' }), null);
        assert.equal(load().extractCreatedTicketKey('🚨 boom'), null);
        assert.equal(load().extractCreatedTicketKey(42), null);
    });
});

// ── processFailedRun (stub tracker) ───────────────────────────────────────────

suite('workflowFailureReporter.processFailedRun', function() {
    function stubTracker(overrides) {
        var t = {
            searchIssues: function() { return []; },
            createTicket: function() { return 'PROJ-99'; },
            addLabel: function() {},
            linkIssues: function() {},
            calls: []
        };
        return Object.assign(t, overrides || {});
    }

    function run(extra) {
        return Object.assign({
            id: 9, name: 'ci : PROJ-1', run_number: 3,
            head_branch: 'main', head_sha: 'abcdef1234567', html_url: 'u'
        }, extra || {});
    }

    test('skips when a bug with the ci-run label already exists', function() {
        var t = stubTracker({ searchIssues: function(q) { return [{ key: 'PROJ-5' }]; } });
        var mod = loadReporter();
        var r = mod.processFailedRun(run(), { tracker: t, jiraProject: 'PROJ', workflowId: null });
        assert.equal(r.status, 'skipped_existing');
    });

    test('skips when an open bug for the detected ticket exists', function() {
        var t = stubTracker({
            searchIssues: function(q) {
                if (q.indexOf('ci-ticket-') !== -1) return [{ key: 'PROJ-6' }];
                return [];
            }
        });
        var mod = loadReporter();
        var r = mod.processFailedRun(run(), { tracker: t, jiraProject: 'PROJ', workflowId: null });
        assert.equal(r.status, 'skipped_open_bug');
    });

    test('search errors are tolerated and treated as no matches', function() {
        var t = stubTracker({ searchIssues: function() { throw new Error('jql down'); } });
        var mod = loadReporter();
        var r = mod.processFailedRun(run(), { tracker: t, jiraProject: 'PROJ', workflowId: null });
        assert.equal(r.status, 'created');
        assert.equal(r.key, 'PROJ-99');
    });

    test('creates the bug, labels it and links it to the detected ticket', function() {
        var labels = [], links = [];
        var created;
        var t = stubTracker({
            createTicket: function(p, type, summary, description) {
                created = { project: p, type: type, summary: summary, description: description };
                return 'PROJ-99';
            },
            addLabel: function(key, label) { labels.push(key + ':' + label); },
            linkIssues: function(a, b, rel) { links.push([a, b, rel]); }
        });
        var mod = loadReporter();
        var r = mod.processFailedRun(run(), { tracker: t, jiraProject: 'PROJ', workflowId: 'ci.yml' });
        assert.equal(r.status, 'created');
        assert.equal(r.key, 'PROJ-99');
        assert.equal(created.project, 'PROJ');
        assert.equal(created.type, 'Bug');
        assert.contains(created.summary, '#3 [ci.yml]');
        assert.deepEqual(labels, ['PROJ-99:ci-run-9', 'PROJ-99:ci-ticket-PROJ-1']);
        assert.deepEqual(links, [['PROJ-1', 'PROJ-99', 'is blocked by']]);
    });

    test('a created bug without an extractable key gets no labels or links', function() {
        var labels = [], links = [];
        var t = stubTracker({
            createTicket: function() { return '🚨'; },
            addLabel: function(k, l) { labels.push(l); },
            linkIssues: function() { links.push(1); }
        });
        var mod = loadReporter();
        var r = mod.processFailedRun(run(), { tracker: t, jiraProject: 'PROJ', workflowId: null });
        assert.equal(r.status, 'created_keyless');
        assert.equal(labels.length, 0, 'no labels without a key');
        assert.equal(links.length, 0, 'no links without a key');
    });

    test('a createTicket failure is reported as create_failed', function() {
        var t = stubTracker({ createTicket: function() { throw new Error('denied'); } });
        var mod = loadReporter();
        var r = mod.processFailedRun(run(), { tracker: t, jiraProject: 'PROJ', workflowId: null });
        assert.equal(r.status, 'create_failed');
    });

    test('label/link failures do not block a successful creation', function() {
        var t = stubTracker({
            addLabel: function() { throw new Error('label denied'); },
            linkIssues: function() { throw new Error('link denied'); }
        });
        var mod = loadReporter();
        var r = mod.processFailedRun(run(), { tracker: t, jiraProject: 'PROJ', workflowId: null });
        assert.equal(r.status, 'created');
        assert.equal(r.key, 'PROJ-99');
    });
});

// ── checkRunDedup / createBugTicket (stub tracker) ────────────────────────────

suite('workflowFailureReporter.checkRunDedup and createBugTicket', function() {
    function run(extra) {
        return Object.assign({ id: 9, name: 'ci', run_number: 3, html_url: 'u' }, extra || {});
    }

    test('checkRunDedup returns the detected ticket key when nothing is found', function() {
        var seen = [];
        var t = { searchIssues: function(q, opts) { seen.push(q); return []; } };
        var mod = loadReporter();
        assert.deepEqual(mod.checkRunDedup(run({ name: 'ci : PROJ-1' }), t, 'PROJ'), { ticketKey: 'PROJ-1' });
        assert.equal(seen.length, 2, 'ci-run and ci-ticket searches both ran');
    });

    test('checkRunDedup stops after the ci-run search when no ticket key is detected', function() {
        var seen = [];
        var t = { searchIssues: function(q) { seen.push(q); return []; } };
        var mod = loadReporter();
        assert.deepEqual(mod.checkRunDedup(run(), t, 'PROJ'), { ticketKey: null });
        assert.equal(seen.length, 1);
    });

    test('createBugTicket reports create_failed when the tracker throws', function() {
        var t = { createTicket: function() { throw new Error('denied'); } };
        var mod = loadReporter();
        var r = mod.createBugTicket(t, 'PROJ', run(), null, null);
        assert.equal(r.status, 'create_failed');
    });

    test('createBugTicket passes the built summary and description to the tracker', function() {
        var captured;
        var t = {
            createTicket: function(p, type, summary, description) {
                captured = { project: p, type: type, summary: summary, description: description };
                return { key: 'PROJ-50' };
            }
        };
        var mod = loadReporter();
        var r = mod.createBugTicket(t, 'PROJ', run({ name: 'ci : PROJ-1' }), 'ci.yml', 'PROJ-1');
        assert.equal(r.status, 'created');
        assert.equal(r.key, 'PROJ-50');
        assert.equal(captured.summary, 'Failed CI: ci : PROJ-1 #3 [ci.yml]');
        assert.contains(captured.description, '*Ticket:* [PROJ-1]');
    });
});

// ── action (jira path) ────────────────────────────────────────────────────────

suite('workflowFailureReporter.action', function() {
    test('fails when required customParams are missing', function() {
        var mod = loadReporter(jiraMocks([]), scmWithRuns({ workflow_runs: [] }));
        var r = runAction(mod, { workspace: 'w', repository: 'r' });
        assert.equal(r.success, false);
        assert.contains(r.error, 'Missing required customParams');
    });

    test('fails when the SCM provider does not support listWorkflowRuns', function() {
        var mod = loadReporter(jiraMocks([]), scmWithRuns(null));
        var r = runAction(mod, { workspace: 'w', repository: 'r', jiraProject: 'PROJ' });
        assert.equal(r.success, false);
        assert.contains(r.error, 'listWorkflowRuns not supported');
    });

    test('fails when the runs payload cannot be parsed', function() {
        var mod = loadReporter(jiraMocks([]), scmWithRuns('{oops'));
        var r = runAction(mod, { workspace: 'w', repository: 'r', jiraProject: 'PROJ' });
        assert.equal(r.success, false);
        assert.equal(r.error, 'Failed to parse workflow runs');
    });

    test('reports success with zero counts when there are no failed runs', function() {
        var mod = loadReporter(jiraMocks([]), scmWithRuns({ workflow_runs: [] }));
        var r = runAction(mod, { workspace: 'w', repository: 'r', jiraProject: 'PROJ' });
        assert.deepEqual(r, { success: true, created: 0, skipped: 0, totalRuns: 0 });
    });

    test('creates a bug via jira tools and labels+links it for a detected ticket', function() {
        var calls = [];
        var mocks = jiraMocks(calls, {
            jira_create_ticket_basic: function(a) {
                calls.push({ tool: 'jira_create_ticket_basic', args: a });
                return { key: 'PROJ-42', id: '1' };
            }
        });
        var mod = loadReporter(mocks, scmWithRuns({ workflow_runs: [
            { id: 9, name: 'ci : PROJ-1', run_number: 3, html_url: 'u', head_branch: 'main', head_sha: 'abcdef1234567' }
        ] }));
        var r = runAction(mod, { workspace: 'w', repository: 'r', jiraProject: 'PROJ', workflowId: 'ci.yml' });
        assert.equal(r.success, true);
        assert.equal(r.created, 1);
        assert.equal(r.skipped, 0);
        assert.equal(r.totalRuns, 1);
        assert.deepEqual(r.createdKeys, ['PROJ-42']);

        var create = jiraFind(calls, 'jira_create_ticket_basic')[0].args;
        assert.equal(create.project, 'PROJ');
        assert.equal(create.issueType, 'Bug');
        assert.equal(create.summary, 'Failed CI: ci : PROJ-1 #3 [ci.yml]');
        assert.contains(create.description, '*Ticket:* [PROJ-1]');

        assert.deepEqual(jiraFind(calls, 'jira_add_label').map(function(c) { return c.args.key + ':' + c.args.label; }),
            ['PROJ-42:ci-run-9', 'PROJ-42:ci-ticket-PROJ-1']);
        assert.deepEqual(jiraFind(calls, 'jira_link_issues')[0].args,
            { sourceKey: 'PROJ-1', anotherKey: 'PROJ-42', relationship: 'is blocked by' });
    });

    test('skips a run whose ci-run label bug already exists', function() {
        var calls = [];
        var mocks = jiraMocks(calls, {
            jira_search_by_jql: function(a) {
                calls.push({ tool: 'jira_search_by_jql', args: a });
                return [{ key: 'PROJ-7' }];
            }
        });
        var mod = loadReporter(mocks, scmWithRuns({ workflow_runs: [
            { id: 9, name: 'ci', run_number: 3, html_url: 'u', head_branch: 'main' }
        ] }));
        var r = runAction(mod, { workspace: 'w', repository: 'r', jiraProject: 'PROJ' });
        assert.equal(r.created, 0);
        assert.equal(r.skipped, 1);
        assert.equal(jiraFind(calls, 'jira_create_ticket_basic').length, 0, 'no bug should be created');
    });

    test('skips a run when an open bug for the detected ticket exists', function() {
        var calls = [];
        var mocks = jiraMocks(calls, {
            jira_search_by_jql: function(a) {
                calls.push({ tool: 'jira_search_by_jql', args: a });
                if (a.jql.indexOf('ci-ticket-') !== -1) return [{ key: 'PROJ-8' }];
                return [];
            }
        });
        var mod = loadReporter(mocks, scmWithRuns({ workflow_runs: [
            { id: 11, name: 'ci : PROJ-2', run_number: 4, html_url: 'u', head_branch: 'main' }
        ] }));
        var r = runAction(mod, { workspace: 'w', repository: 'r', jiraProject: 'PROJ' });
        assert.equal(r.created, 0);
        assert.equal(r.skipped, 1);
        assert.equal(jiraFind(calls, 'jira_create_ticket_basic').length, 0);
    });

    test('still counts a bug as created when the tracker returns no key', function() {
        var calls = [];
        var mocks = jiraMocks(calls, {
            jira_create_ticket_basic: function(a) {
                calls.push({ tool: 'jira_create_ticket_basic', args: a });
                return null;
            }
        });
        var mod = loadReporter(mocks, scmWithRuns({ workflow_runs: [
            { id: 9, name: 'ci', run_number: 3, html_url: 'u', head_branch: 'main' }
        ] }));
        var r = runAction(mod, { workspace: 'w', repository: 'r', jiraProject: 'PROJ' });
        assert.equal(r.created, 1);
        assert.deepEqual(r.createdKeys, []);
        assert.equal(jiraFind(calls, 'jira_add_label').length, 0);
    });
});

// ── gh-1198 CRAP extraction: action decomposition helpers ────────────────────

suite('workflowFailureReporter action decomposition (gh-1198)', function() {
    test('helpers exist (extraction landed)', function() {
        var mod = loadReporter({}, scmWithRuns(null));
        ['fetchFailedRuns', 'processAllFailedRuns', 'tallyRunOutcome'].forEach(function(name) {
            assert.equal(typeof mod[name], 'function', name + ' exported');
        });
    });

    suite('tallyRunOutcome (pure)', function() {
        function m() { return loadReporter({}, scmWithRuns(null)); }

        test('skip outcomes count as skipped', function() {
            assert.deepEqual(m().tallyRunOutcome({ status: 'skipped_existing' }, []),
                { created: 0, skipped: 1 });
            assert.deepEqual(m().tallyRunOutcome({ status: 'skipped_open_bug' }, []),
                { created: 0, skipped: 1 });
        });

        test('created outcomes count as created and collect the key (multi-key order)', function() {
            var keys = [];
            assert.deepEqual(m().tallyRunOutcome({ status: 'created', key: 'PROJ-2' }, keys),
                { created: 1, skipped: 0 });
            m().tallyRunOutcome({ status: 'created', key: 'PROJ-3' }, keys);
            m().tallyRunOutcome({ status: 'created_keyless' }, keys);
            assert.deepEqual(keys, ['PROJ-2', 'PROJ-3'], 'keyless runs contribute nothing to createdKeys');
        });

        test('create_failed counts as neither', function() {
            assert.deepEqual(m().tallyRunOutcome({ status: 'create_failed' }, []),
                { created: 0, skipped: 0 });
        });
    });

    suite('fetchFailedRuns (transport + parse)', function() {
        test('null payload → unsupported-provider error result + warn', function() {
            var mod = loadReporter({}, scmWithRuns(null));
            var out = mod.fetchFailedRuns({ workspace: 'w', repository: 'r', scmProvider: 'ado' }, 'ci.yml');
            assert.equal(out.error, 'unsupported');
            assert.deepEqual(out.result,
                { success: false, error: 'listWorkflowRuns not supported by provider: ado' });
        });

        test('null payload without scmProvider reports the github default', function() {
            var mod = loadReporter({}, scmWithRuns(null));
            var out = mod.fetchFailedRuns({ workspace: 'w', repository: 'r' }, null);
            assert.deepEqual(out.result,
                { success: false, error: 'listWorkflowRuns not supported by provider: github' });
        });

        test('unparsable payload → parse error', function() {
            var mod = loadReporter({}, scmWithRuns('{nope'));
            var out = mod.fetchFailedRuns({ workspace: 'w', repository: 'r' }, 'ci.yml');
            assert.equal(out.error, 'parse');
            assert.deepEqual(out.result, { success: false, error: 'Failed to parse workflow runs' });
        });

        test('happy path returns the workflow_runs array', function() {
            var mod = loadReporter({}, scmWithRuns(JSON.stringify({ total_count: 1, workflow_runs: [{ id: 1 }] })));
            var out = mod.fetchFailedRuns({ workspace: 'w', repository: 'r' }, 'ci.yml');
            assert.deepEqual(out, { runs: [{ id: 1 }] });
        });

        test('runs list queries the failure status, workflowId and 50-run page', function() {
            var seen = null;
            var mod = loadReporter({}, { createScm: function(cfg) {
                assert.deepEqual(cfg, { repository: { owner: 'w', repo: 'r' },
                                        scm: { provider: 'github' } });
                return { listWorkflowRuns: function(status, workflowId, limit) {
                    seen = { status: status, workflowId: workflowId, limit: limit };
                    return '{"workflow_runs":[]}';
                } };
            } });
            mod.fetchFailedRuns({ workspace: 'w', repository: 'r' }, 'quality.yml');
            assert.deepEqual(seen, { status: 'failure', workflowId: 'quality.yml', limit: 50 });
        });
    });

    suite('processAllFailedRuns (loop + rollup, tracker calls in run order)', function() {
        function modWithRuns(runs) {
            var seq = 0;
            var calls = [];
            var mod = loadReporter(jiraMocks(calls, {
                jira_create_ticket_basic: function(a) {
                    calls.push({ tool: 'jira_create_ticket_basic', args: a });
                    seq += 1;
                    return { key: 'PROJ-' + (20 + seq), id: String(seq) };
                }
            }), scmWithRuns(JSON.stringify({ workflow_runs: runs })));
            return { mod: mod, calls: calls };
        }

        test('created + skipped tally rolls into the action result (multi-run)', function() {
            var runs = [
                { id: 1, name: 'config.json : PROJ-11', run_number: 5, html_url: 'u1', head_branch: 'b', head_sha: 's', url: 'u' },
                { id: 2, name: 'config.json : PROJ-12', run_number: 6, html_url: 'u2', head_branch: 'b', head_sha: 's', url: 'u' }
            ];
            var ctx = modWithRuns(runs);
            var result = ctx.mod.action({ jobParams: { customParams: {
                workspace: 'w', repository: 'r', jiraProject: 'PROJ'
            } } });
            assert.equal(result.success, true);
            assert.equal(result.totalRuns, 2);
            assert.ok(result.created + result.skipped === 2, 'every run lands in exactly one bucket');
        });

        test('createdKeys ride the result in creation order (multi-run)', function() {
            var runs = [
                { id: 1, name: 'config.json : PROJ-21', run_number: 5, html_url: 'u1', head_branch: 'b', head_sha: 's', url: 'u' },
                { id: 2, name: 'no ticket key here', run_number: 6, html_url: 'u2', head_branch: 'b', head_sha: 's', url: 'u' },
                { id: 3, name: 'config.json : PROJ-22', run_number: 7, html_url: 'u3', head_branch: 'b', head_sha: 's', url: 'u' }
            ];
            var ctx = modWithRuns(runs);
            var result = ctx.mod.action({ jobParams: { customParams: {
                workspace: 'w', repository: 'r', jiraProject: 'PROJ'
            } } });
            assert.equal(result.created, 3);
            assert.deepEqual(result.createdKeys, ['PROJ-21', 'PROJ-22', 'PROJ-23']);
        });
    });
});
