/**
 * Unit tests for js/common/trackers.js
 *
 * The tracker-agnostic ticket layer (the scm.js analog for trackers):
 * a createTracker(config, customParams) factory that maps generic ticket operations
 * onto CANONICAL tracker tools per configured provider — jira_* / ado_* /
 * github_* — exactly like scm.js maps SCM operations onto providers.
 *
 * Why canonical tools: the Java runtime exposes only canonical tool names
 * to scripts (tracker_* exists solely as a CLI alias resolved via
 * DEFAULT_TRACKER), so provider mapping must live in this JS layer.
 *
 * Uses: configModule, loadModule(), makeRequire(), assert, test(), suite()
 */

// ── Loader helper ─────────────────────────────────────────────────────────────

function loadTrackers(mocks) {
    return loadModule(
        'js/common/trackers.js',
        makeRequire({
            '../config.js': configModule,
            'config': configModule,
            // Single owner of the GitHub key-shape convention (gh-770) —
            // the router's issue-number parser derives from it.
            './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
        }),
        mocks || {}
    );
}

// ── Recording tool mocks ──────────────────────────────────────────────────────

/**
 * A mock for a dmtools tool global that records every call.
 * `calls` holds the args bag of each invocation.
 */
function recorder(name, result) {
    var calls = [];
    var fn = function (args) {
        calls.push(args);
        if (result && result.__throw__) {
            throw result.__throw__;
        }
        return typeof result === 'function' ? result(args) : result;
    };
    fn.calls = calls;
    fn.toolName = name;
    return fn;
}

/** Standard jira provider mock set (canonical jira_* tools). */
function jiraMocks(opts) {
    return {
        jira_get_ticket: recorder('jira_get_ticket', JSON.stringify(JIRA_TICKET)),
        jira_search_by_jql: recorder('jira_search_by_jql', JSON.stringify({
            issues: [JIRA_TICKET]
        })),
        jira_post_comment: recorder('jira_post_comment', '{}'),
        jira_get_comments: recorder('jira_get_comments', JSON.stringify({
            comments: [{ author: { displayName: 'Reviewer' }, body: 'please fix', created: '2026-09-07T10:00:00Z' }]
        })),
        jira_add_label: recorder('jira_add_label', '{}'),
        jira_remove_label: opts && opts.removeLabelFails
            ? recorder('jira_remove_label', { __throw__: new Error('label api down') })
            : recorder('jira_remove_label', '{}'),
        jira_move_to_status: recorder('jira_move_to_status', '{}'),
        jira_assign_ticket_to: recorder('jira_assign_ticket_to', '{}'),
        jira_create_ticket_basic: recorder('jira_create_ticket_basic', '{"key":"PROJ-9"}')
    };
}

// ── Fixtures: backend-shaped ticket payloads ─────────────────────────────────

var JIRA_TICKET = {
    key: 'PROJ-123',
    id: '10001',
    fields: {
        summary: 'Fix the login flow',
        status: { name: 'In Progress' },
        assignee: { displayName: 'Jane Doe', accountId: 'acc-1' },
        labels: ['backend', 'wip'],
        description: 'Login breaks on expired sessions'
    }
};

var GITHUB_TICKET = {
    number: 41,
    id: 900001,
    title: 'Fix the login flow',
    state: 'open',
    assignee: { login: 'jane-doe' },
    labels: [{ name: 'bug' }, { name: 'wip' }],
    body: 'Login breaks on expired sessions',
    html_url: 'https://github.com/acme/widgets/issues/41'
};

var ADO_TICKET = {
    id: 4242,
    fields: {
        'System.Title': 'Fix the login flow',
        'System.State': 'Active',
        'System.AssignedTo': { displayName: 'Jane Doe', uniqueName: 'jane@acme.dev' },
        'System.Description': 'Login breaks on expired sessions'
    }
};

// ── Tests ─────────────────────────────────────────────────────────────────────

suite('trackers.js factory', function () {
    test('exports a createTracker factory', function () {
        var trackers = loadTrackers({});
        assert.ok(trackers.createTracker, 'createTracker export missing');
        var t = trackers.createTracker({}, { trackerProvider: 'jira' });
        assert.ok(t.getTicket, 'getTicket missing');
        assert.ok(t.search, 'search missing');
        assert.ok(t.postComment, 'postComment missing');
        assert.ok(t.getComments, 'getComments missing');
        assert.ok(t.addLabel, 'addLabel missing');
        assert.ok(t.removeLabel, 'removeLabel missing');
        assert.ok(t.moveToStatus, 'moveToStatus missing');
        assert.ok(t.assignTo, 'assignTo missing');
        assert.ok(t.createTicket, 'createTicket missing');
        assert.ok(t.normalizeTicket, 'normalizeTicket missing');
        assert.ok(t.extractTicketKey, 'extractTicketKey missing');
        assert.ok(t.assignForReview, 'assignForReview missing');
    });

    test('provider defaults to jira and honors config.tracker.provider', function () {
        var trackers = loadTrackers({});
        assert.equal(
            trackers.createTracker({ tracker: { provider: 'ADO' } }).provider(),
            'ado',
            'provider must be case-insensitive'
        );
        assert.equal(
            trackers.createTracker({ tracker: { provider: 'github' } }).provider(),
            'github'
        );

        var env = null;
        try { env = java.lang.System.getenv('DEFAULT_TRACKER'); } catch (e) {}
        if (env) {
            // DEFAULT_TRACKER outranks the built-in fallback — the plain default
            // is covered by the dedicated env-probing test below.
            return;
        }
        assert.equal(trackers.createTracker({}).provider(), 'jira');
    });

    test('unknown provider falls back to jira', function () {
        var trackers = loadTrackers({});
        assert.equal(
            trackers.createTracker({}, { trackerProvider: 'trello' }).provider(),
            'jira'
        );
    });

    test('customParams.trackerProvider overrides config.tracker.provider', function () {
        var trackers = loadTrackers({});
        assert.equal(
            trackers.createTracker(
                { tracker: { provider: 'ado' } },
                { trackerProvider: 'github' }
            ).provider(),
            'github',
            'per-agent customParams override must win over project config'
        );
    });

    test('config.defaultTracker is honored when no stronger signal exists', function () {
        var env = null;
        try { env = java.lang.System.getenv('DEFAULT_TRACKER'); } catch (e) {}
        if (env) {
            // DEFAULT_TRACKER env probing outranks config.defaultTracker —
            // nothing deterministic to assert while it is set.
            return;
        }
        var trackers = loadTrackers({});
        assert.equal(trackers.createTracker({ defaultTracker: 'ado' }).provider(), 'ado');
    });

    test('DEFAULT_TRACKER env is probed when config is silent', function () {
        var env = null;
        try { env = java.lang.System.getenv('DEFAULT_TRACKER'); } catch (e) {}
        if (!env) {
            // Nothing to assert without the env var — the probing layer is
            // exercised in production GraalJS runs only.
            return;
        }
        var trackers = loadTrackers({});
        assert.equal(
            trackers.createTracker({}).provider(),
            String(env).toLowerCase().trim(),
            'DEFAULT_TRACKER must drive the provider when the config never mentions a tracker'
        );
    });
});

suite('trackers.js jira provider (default)', function () {
    test('getTicket calls jira_get_ticket with the key', function () {
        var mocks = jiraMocks();
        var trackers = loadTrackers(mocks);
        var ticket = trackers.createTracker({}, { trackerProvider: 'jira' }).getTicket('PROJ-123');
        assert.deepEqual(mocks.jira_get_ticket.calls[0], { key: 'PROJ-123' });
        assert.equal(ticket.key, 'PROJ-123');
        assert.equal(ticket.title, 'Fix the login flow');
        assert.equal(ticket.status, 'In Progress');
        assert.equal(ticket.assignee, 'Jane Doe');
        assert.deepEqual(ticket.labels, ['backend', 'wip']);
    });

    test('search maps to jira_search_by_jql and normalizes the issues page', function () {
        var mocks = jiraMocks();
        var trackers = loadTrackers(mocks);
        var results = trackers.createTracker({}, { trackerProvider: 'jira' }).search('labels = wip');
        assert.deepEqual(mocks.jira_search_by_jql.calls[0], { jql: 'labels = wip' });
        assert.equal(results.length, 1);
        assert.equal(results[0].key, 'PROJ-123');
    });

    test('postComment / getComments use the canonical jira tools', function () {
        var mocks = jiraMocks();
        var trackers = loadTrackers(mocks);
        var t = trackers.createTracker({}, { trackerProvider: 'jira' });
        t.postComment('PROJ-123', 'looks good');
        var comments = t.getComments('PROJ-123');
        assert.deepEqual(mocks.jira_post_comment.calls[0], { key: 'PROJ-123', comment: 'looks good' });
        assert.deepEqual(mocks.jira_get_comments.calls[0], { key: 'PROJ-123' });
        assert.equal(comments.length, 1);
        assert.equal(comments[0].author, 'Reviewer');
        assert.equal(comments[0].body, 'please fix');
    });

    test('labels, status and assign use canonical jira args', function () {
        var mocks = jiraMocks();
        var trackers = loadTrackers(mocks);
        var t = trackers.createTracker({}, { trackerProvider: 'jira' });
        t.addLabel('PROJ-123', 'ai-generated');
        t.removeLabel('PROJ-123', 'wip');
        t.moveToStatus('PROJ-123', 'In Review');
        t.assignTo('PROJ-123', 'acc-1');
        assert.deepEqual(mocks.jira_add_label.calls[0], { key: 'PROJ-123', label: 'ai-generated' });
        assert.deepEqual(mocks.jira_remove_label.calls[0], { key: 'PROJ-123', label: 'wip' });
        assert.deepEqual(mocks.jira_move_to_status.calls[0], { key: 'PROJ-123', statusName: 'In Review' });
        assert.deepEqual(mocks.jira_assign_ticket_to.calls[0], { key: 'PROJ-123', accountId: 'acc-1' });
    });

    test('createTicket maps onto jira_create_ticket_basic and extracts the key', function () {
        var mocks = jiraMocks();
        var trackers = loadTrackers(mocks);
        var key = trackers.createTracker({}, { trackerProvider: 'jira' }).createTicket('PROJ', 'Bug', 'It breaks', 'details');
        assert.deepEqual(mocks.jira_create_ticket_basic.calls[0], {
            project: 'PROJ',
            issueType: 'Bug',
            summary: 'It breaks',
            description: 'details'
        });
        assert.equal(key, 'PROJ-9');
    });

    test('returns an empty search list when nothing is found', function () {
        var mocks = jiraMocks();
        mocks.jira_search_by_jql = recorder('jira_search_by_jql', JSON.stringify({ issues: [] }));
        var trackers = loadTrackers(mocks);
        assert.deepEqual(trackers.createTracker({}, { trackerProvider: 'jira' }).search('nope'), []);
    });
});

suite('trackers.js ado provider', function () {
    test('getTicket calls ado_get_work_item and normalizes the ADO shape', function () {
        var adoGet = recorder('ado_get_work_item', ADO_TICKET);
        var trackers = loadTrackers({ ado_get_work_item: adoGet });
        var ticket = trackers.createTracker({ tracker: { provider: 'ado' } }).getTicket('4242');
        assert.deepEqual(adoGet.calls[0], { id: '4242' });
        assert.equal(ticket.key, '4242');
        assert.equal(ticket.title, 'Fix the login flow');
        assert.equal(ticket.status, 'Active');
        assert.equal(ticket.assignee, 'Jane Doe');
    });

    test('search maps query onto ado_search_by_wiql wiql', function () {
        var adoSearch = recorder('ado_search_by_wiql', JSON.stringify({
            value: [ADO_TICKET]
        }));
        var trackers = loadTrackers({ ado_search_by_wiql: adoSearch });
        var results = trackers.createTracker({ tracker: { provider: 'ado' } }).search('q');
        assert.deepEqual(adoSearch.calls[0], { wiql: 'q' });
        assert.equal(results.length, 1);
        assert.equal(results[0].key, '4242');
    });

    test('comments map id and comment onto the ado comment tools', function () {
        var adoAdd = recorder('ado_add_work_item_comment', '{}');
        var adoList = recorder('ado_get_work_item_comments', JSON.stringify({
            value: [{ text: 'n1', createdBy: { displayName: 'A' }, createdDate: 'd1' }]
        }));
        var trackers = loadTrackers({
            ado_add_work_item_comment: adoAdd,
            ado_get_work_item_comments: adoList
        });
        var t = trackers.createTracker({ tracker: { provider: 'ado' } });
        t.postComment('4242', 'hello');
        var comments = t.getComments('4242');
        assert.deepEqual(adoAdd.calls[0], { id: '4242', comment: 'hello', format: 'markdown' });
        assert.deepEqual(adoList.calls[0], { id: '4242' });
        assert.equal('ticket' in adoList.calls[0], false, 'gh-1174: must not pass ticket: {} which throws ClassCastException in Java MCPToolExecutor');
        assert.equal(comments[0].body, 'n1');
        assert.equal(comments[0].author, 'A');
    });

    test('status and assignee map onto the ado state/assign tools', function () {
        var adoMove = recorder('ado_move_to_state', '{}');
        var adoAssign = recorder('ado_assign_work_item', '{}');
        var trackers = loadTrackers({
            ado_move_to_state: adoMove,
            ado_assign_work_item: adoAssign
        });
        var t = trackers.createTracker({ tracker: { provider: 'ado' } });
        t.moveToStatus('4242', 'Active');
        t.assignTo('4242', 'jane@acme.dev');
        assert.deepEqual(adoMove.calls[0], { id: '4242', state: 'Active' });
        assert.deepEqual(adoAssign.calls[0], { id: '4242', userEmail: 'jane@acme.dev' });
    });

    test('createTicket maps onto ado_create_work_item field names', function () {
        var adoCreate = recorder('ado_create_work_item', '{"id":4300}');
        var trackers = loadTrackers({ ado_create_work_item: adoCreate });
        var t = trackers.createTracker({ tracker: { provider: 'ado' } });
        var key = t.createTicket('Proj', 'Bug', 'It breaks', 'details');
        assert.deepEqual(adoCreate.calls[0], {
            project: 'Proj',
            workItemType: 'Bug',
            title: 'It breaks',
            description: 'details',
            format: 'markdown'
        });
        assert.equal(key, '4300');
    });

    test('addLabel routes onto ado_add_work_item_label with the id/label args', function () {
        var adoAdd = recorder('ado_add_work_item_label', '{}');
        var trackers = loadTrackers({ ado_add_work_item_label: adoAdd });
        trackers.createTracker({ tracker: { provider: 'ado' } }).addLabel('4242', 'ai-generated');
        assert.deepEqual(adoAdd.calls[0], { id: '4242', label: 'ai-generated' });
    });

    test('removeLabel routes onto ado_remove_work_item_label with the id/label args', function () {
        var adoRemove = recorder('ado_remove_work_item_label', '{}');
        var trackers = loadTrackers({ ado_remove_work_item_label: adoRemove });
        trackers.createTracker({ tracker: { provider: 'ado' } }).removeLabel('4242', 'wip');
        assert.deepEqual(adoRemove.calls[0], { id: '4242', label: 'wip' });
    });

    test('label keys are coerced with String(key) like every other ado helper', function () {
        var adoAdd = recorder('ado_add_work_item_label', '{}');
        var adoRemove = recorder('ado_remove_work_item_label', '{}');
        var trackers = loadTrackers({
            ado_add_work_item_label: adoAdd,
            ado_remove_work_item_label: adoRemove
        });
        var t = trackers.createTracker({ tracker: { provider: 'ado' } });
        t.addLabel(4242, 'ai-generated');
        t.removeLabel(4242, 'wip');
        assert.deepEqual(adoAdd.calls[0], { id: '4242', label: 'ai-generated' });
        assert.deepEqual(adoRemove.calls[0], { id: '4242', label: 'wip' });
    });

    test('the WIP lifecycle (assignForReview) exercises the ado label impls without throwing', function () {
        var adoAddLabel = recorder('ado_add_work_item_label', '{}');
        var adoRemoveLabel = recorder('ado_remove_work_item_label', '{}');
        var trackers = loadTrackers({
            ado_assign_work_item: recorder('ado_assign_work_item', '{}'),
            ado_move_to_state: recorder('ado_move_to_state', '{}'),
            ado_add_work_item_label: adoAddLabel,
            ado_remove_work_item_label: adoRemoveLabel
        });
        var result = trackers.createTracker({ tracker: { provider: 'ado' } })
            .assignForReview('4242', 'jane@acme.dev', 'wip');
        assert.ok(result.success, 'expected success: ' + JSON.stringify(result));
        assert.deepEqual(adoAddLabel.calls[0], { id: '4242', label: configModule.LABELS.AI_GENERATED });
        assert.deepEqual(adoRemoveLabel.calls[0], { id: '4242', label: 'wip' });
    });
});

suite('trackers.js github provider', function () {
    test('getTicket expands bare numbers via repository and normalizes', function () {
        var ghGet = recorder('github_get_issue', GITHUB_TICKET);
        var trackers = loadTrackers({ github_get_issue: ghGet });
        var ticket = trackers.createTracker({
            tracker: { provider: 'github' },
            repository: { owner: 'acme', repo: 'widgets' }
        }).getTicket('41');
        // Dart tool schema (github_get_issue): workspace/repository/issueNumber.
        assert.deepEqual(ghGet.calls[0], {
            workspace: 'acme',
            repository: 'widgets',
            issueNumber: 41
        });
        assert.equal(ticket.key, 'acme/widgets#41');
        assert.equal(ticket.status, 'open');
        assert.deepEqual(ticket.labels, ['bug', 'wip']);
    });

    test('moveToStatus maps done/closed (any case) onto close_issue', function () {
        var ghClose = recorder('github_close_issue', '{}');
        var trackers = loadTrackers({
            github_close_issue: ghClose,
            // Simulate a runtime without the dedicated tool (Dart catalog);
            // in GraalJS every configured tool exists as a real global and
            // would otherwise win over the fallback this test targets.
            github_move_issue_to_status: null
        });
        var t = trackers.createTracker({
            tracker: { provider: 'github' },
            repository: { owner: 'acme', repo: 'widgets' }
        });
        t.moveToStatus('acme/widgets#7', 'Done');
        t.moveToStatus('acme/widgets#8', 'CLOSED');
        // github_close_issue schema: owner/repo/number.
        assert.deepEqual(ghClose.calls[0], { owner: 'acme', repo: 'widgets', number: 7 });
        assert.deepEqual(ghClose.calls[1], { owner: 'acme', repo: 'widgets', number: 8 });
    });

    test('moveToStatus carries any other status as an issue label', function () {
        var ghClose = recorder('github_close_issue', '{}');
        var ghLabels = recorder('github_add_labels', '{}');
        var trackers = loadTrackers({
            github_close_issue: ghClose,
            github_add_labels: ghLabels,
            // Simulate a runtime without the dedicated tool (see above).
            github_move_issue_to_status: null
        });
        var t = trackers.createTracker({
            tracker: { provider: 'github' },
            repository: { owner: 'acme', repo: 'widgets' }
        });
        t.moveToStatus('acme/widgets#7', 'In Review');
        assert.deepEqual(ghLabels.calls[0], {
            owner: 'acme',
            repo: 'widgets',
            number: 7,
            labels: ['In Review']
        });
        assert.equal(ghClose.calls.length, 0);
        // Lowercase statuses that are not done/closed are labels too.
        t.moveToStatus('acme/widgets#8', 'reopened');
        assert.deepEqual(ghLabels.calls[1].labels, ['reopened']);
        assert.equal(ghClose.calls.length, 0);
    });

    test('empty status fails without an HTTP call', function () {
        var trackers = loadTrackers({});
        var t = trackers.createTracker({ tracker: { provider: 'github' } });
        assert.throws(function () { t.moveToStatus('acme/widgets#7', ''); });
    });

    test('addLabel / removeLabel use the canonical issue label tools', function () {
        var ghAdd = recorder('github_add_labels', '{}');
        var ghRemove = recorder('github_remove_label', '{}');
        var trackers = loadTrackers({
            github_add_labels: ghAdd,
            github_remove_label: ghRemove
        });
        var t = trackers.createTracker({
            tracker: { provider: 'github' },
            repository: { owner: 'acme', repo: 'widgets' }
        });
        t.addLabel('acme/widgets#7', 'ai-generated');
        t.removeLabel('acme/widgets#7', 'wip');
        assert.deepEqual(ghAdd.calls[0], {
            owner: 'acme',
            repo: 'widgets',
            number: 7,
            labels: ['ai-generated']
        });
        assert.deepEqual(ghRemove.calls[0], {
            owner: 'acme',
            repo: 'widgets',
            number: 7,
            label: 'wip'
        });
    });

    test('postComment / getComments use the issue comment surface', function () {
        var ghPost = recorder('github_create_comment', '{}');
        var ghList = recorder('github_get_pr_comments', [
            { user: { login: 'A' }, body: 'n1' },
            { user: { login: 'B' }, body: 'n2' }
        ]);
        var trackers = loadTrackers({
            github_create_comment: ghPost,
            github_get_pr_comments: ghList
        });
        var t = trackers.createTracker({
            tracker: { provider: 'github' },
            repository: { owner: 'acme', repo: 'widgets' }
        });
        t.postComment('acme/widgets#7', 'hello');
        var comments = t.getComments('acme/widgets#7');
        // github_create_comment / github_get_pr_comments hit the
        // issues/{n}/comments endpoint (PRs are issues upstream); the
        // number argument keeps the tools' canonical pullRequestId name.
        assert.deepEqual(ghPost.calls[0], {
            workspace: 'acme',
            repository: 'widgets',
            pullRequestId: 7,
            text: 'hello'
        });
        assert.deepEqual(ghList.calls[0], {
            workspace: 'acme',
            repository: 'widgets',
            pullRequestId: 7
        });
        assert.equal(comments.length, 2);
        assert.equal(comments[0].author, 'A');
        assert.equal(comments[1].body, 'n2');
    });

    test('createTicket opens an issue and returns owner/repo#N', function () {
        var ghCreate = recorder('github_create_issue', {
            number: 42,
            title: 'New bug',
            state: 'open',
            html_url: 'https://github.com/acme/widgets/issues/42'
        });
        var trackers = loadTrackers({ github_create_issue: ghCreate });
        var key = trackers.createTracker({
            tracker: { provider: 'github' },
            repository: { owner: 'acme', repo: 'widgets' }
        }).createTicket(null, 'bug', 'New bug', 'It broke');
        assert.deepEqual(ghCreate.calls[0], {
            owner: 'acme',
            repo: 'widgets',
            title: 'New bug',
            body: 'It broke'
        });
        assert.equal(key, 'acme/widgets#42');
    });

    test('search and assignTo fail with a clear error when the runtime lacks the dedicated tools', function () {
        // Explicit nulls simulate a runtime without the dedicated issue tools;
        // in GraalJS they exist as real globals and would make (real!) API
        // calls instead of throwing the unsupported-operation error.
        var trackers = loadTrackers({
            github_search_issues: null,
            github_assign_issue: null
        });
        var t = trackers.createTracker({ tracker: { provider: 'github' } });
        assert.throws(function () { t.search('is:open'); });
        assert.throws(function () { t.assignTo('acme/widgets#7', 'jane'); });
    });

    test('search dispatches to github_search_issues when the runtime exposes it', function () {
        var ghSearch = recorder('github_search_issues', JSON.stringify({
            items: [GITHUB_TICKET]
        }));
        var trackers = loadTrackers({ github_search_issues: ghSearch });
        var results = trackers.createTracker({
            tracker: { provider: 'github' },
            repository: { owner: 'acme', repo: 'widgets' }
        }).search('is:open label:bug');
        assert.deepEqual(ghSearch.calls[0], {
            query: 'is:open label:bug',
            workspace: 'acme',
            repository: 'widgets'
        });
        assert.equal(results.length, 1);
        assert.equal(results[0].key, 'acme/widgets#41');
    });

    test('assignTo dispatches to github_assign_issue with the composite key', function () {
        var ghAssign = recorder('github_assign_issue', '{}');
        var trackers = loadTrackers({ github_assign_issue: ghAssign });
        trackers.createTracker({
            tracker: { provider: 'github' },
            repository: { owner: 'acme', repo: 'widgets' }
        }).assignTo('acme/widgets#7', 'jane');
        assert.deepEqual(ghAssign.calls[0], {
            user: 'jane',
            key: 'acme/widgets#7',
            owner: 'acme',
            repo: 'widgets',
            number: 7
        });
    });

    test('assignTo expands a bare number into the composite key', function () {
        var ghAssign = recorder('github_assign_issue', '{}');
        var trackers = loadTrackers({ github_assign_issue: ghAssign });
        trackers.createTracker({
            tracker: { provider: 'github' },
            repository: { owner: 'acme', repo: 'widgets' }
        }).assignTo('7', 'jane');
        assert.deepEqual(ghAssign.calls[0], {
            user: 'jane',
            key: 'acme/widgets#7',
            owner: 'acme',
            repo: 'widgets',
            number: 7
        });
    });

    test('assignTo with a bare number and no repository config omits owner/repo', function () {
        var ghAssign = recorder('github_assign_issue', '{}');
        var trackers = loadTrackers({ github_assign_issue: ghAssign });
        trackers.createTracker({ tracker: { provider: 'github' } })
            .assignTo('7', 'jane');
        var call = ghAssign.calls[0];
        assert.equal(call.user, 'jane');
        assert.equal(call.key, '7');
        assert.equal(call.number, 7);
        assert.equal(call.owner, undefined, 'owner must be absent so the tool can apply its own defaults');
        assert.equal(call.repo, undefined, 'repo must be absent so the tool can apply its own defaults');
    });

    test('moveToStatus prefers github_move_issue_to_status when the runtime exposes it', function () {
        var ghMove = recorder('github_move_issue_to_status', '{}');
        var ghClose = recorder('github_close_issue', '{}');
        var trackers = loadTrackers({
            github_move_issue_to_status: ghMove,
            github_close_issue: ghClose
        });
        var t = trackers.createTracker({
            tracker: { provider: 'github' },
            repository: { owner: 'acme', repo: 'widgets' }
        });
        t.moveToStatus('acme/widgets#7', 'Done');
        t.moveToStatus('8', 'In Review');
        assert.deepEqual(ghMove.calls[0], {
            statusName: 'Done',
            key: 'acme/widgets#7',
            owner: 'acme',
            repo: 'widgets',
            number: 7
        });
        assert.deepEqual(ghMove.calls[1], {
            statusName: 'In Review',
            key: 'acme/widgets#8',
            owner: 'acme',
            repo: 'widgets',
            number: 8
        });
        assert.equal(ghClose.calls.length, 0, 'close/label fallback must not run when the dedicated tool exists');
    });
});

suite('trackers.js github provider — gh-N router keys (gh-770)', function () {
    var GH_CONFIG = {
        tracker: { provider: 'github' },
        repository: { owner: 'acme', repo: 'widgets' }
    };

    test('postComment parses the gh-N router key into the issue number', function () {
        var ghPost = recorder('github_create_comment', '{}');
        var trackers = loadTrackers({ github_create_comment: ghPost });
        trackers.createTracker(GH_CONFIG).postComment('gh-1308', 'hello');
        assert.deepEqual(ghPost.calls[0], {
            workspace: 'acme',
            repository: 'widgets',
            pullRequestId: 1308,
            text: 'hello'
        });
    });

    test('getTicket / addLabel / moveToStatus parse gh-N keys too', function () {
        var ghGet = recorder('github_get_issue', { number: 9, title: 'T', state: 'open' });
        var ghAdd = recorder('github_add_labels', '{}');
        var ghMove = recorder('github_move_issue_to_status', '{}');
        var trackers = loadTrackers({
            github_get_issue: ghGet,
            github_add_labels: ghAdd,
            github_move_issue_to_status: ghMove
        });
        var t = trackers.createTracker(GH_CONFIG);
        t.getTicket('gh-9');
        t.addLabel('gh-9', 'ai_generated');
        t.moveToStatus('gh-9', 'done');
        assert.equal(ghGet.calls[0].issueNumber, 9);
        assert.equal(ghAdd.calls[0].number, 9);
        assert.equal(ghMove.calls[0].number, 9);
        assert.equal(ghMove.calls[0].key, 'gh-9');
    });

    test('composite owner/repo#N and bare-number keys keep working alongside gh-N', function () {
        var ghPost = recorder('github_create_comment', '{}');
        var trackers = loadTrackers({ github_create_comment: ghPost });
        var t = trackers.createTracker(GH_CONFIG);
        t.postComment('acme/widgets#7', 'a');
        t.postComment('7', 'b');
        assert.equal(ghPost.calls[0].pullRequestId, 7);
        assert.equal(ghPost.calls[1].pullRequestId, 7);
    });

    test('the bare-hash #N dispatch-payload shape parses too (derived from the shared shape list)', function () {
        // '#N' appears in dispatch payloads and is part of the shared
        // convention (ticketKeyShapes.GITHUB_KEY_SHAPES) — a key the shared
        // owner accepts must not die with "cannot parse GitHub issue key".
        var ghPost = recorder('github_create_comment', '{}');
        var trackers = loadTrackers({ github_create_comment: ghPost });
        trackers.createTracker(GH_CONFIG).postComment('#12', 'hello');
        assert.equal(ghPost.calls[0].pullRequestId, 12);
    });

    test('a jira-provider tracker passes gh-N keys through untouched (no overreach)', function () {
        var jiraPost = recorder('jira_post_comment', '{}');
        var trackers = loadTrackers({ jira_post_comment: jiraPost });
        trackers.createTracker({ tracker: { provider: 'jira' } }).postComment('gh-5', 'x');
        assert.equal(jiraPost.calls[0].key, 'gh-5');
    });
});

suite('trackers.js normalizeTicket', function () {
    test('returns null for falsy input', function () {
        var trackers = loadTrackers({});
        assert.equal(trackers.createTracker({}, { trackerProvider: 'jira' }).normalizeTicket(null), null);
        assert.equal(trackers.createTracker({}, { trackerProvider: 'jira' }).normalizeTicket(''), null);
    });

    test('passes an already-normalized ticket through', function () {
        var trackers = loadTrackers({});
        var normalized = trackers.createTracker({}, { trackerProvider: 'jira' }).normalizeTicket({
            key: 'PROJ-1',
            title: 'Already flat'
        });
        assert.equal(normalized.key, 'PROJ-1');
        assert.equal(normalized.title, 'Already flat');
    });

    test('normalizes GitHub-shaped payloads with repository context', function () {
        var trackers = loadTrackers({});
        var ticket = trackers.createTracker({
            repository: { owner: 'acme', repo: 'widgets' }
        }).normalizeTicket(GITHUB_TICKET);
        assert.equal(ticket.key, 'acme/widgets#41');
        assert.equal(ticket.title, 'Fix the login flow');
        assert.deepEqual(ticket.labels, ['bug', 'wip']);
        assert.equal(ticket.raw, null, 'raw payload should not leak into the normalized view');
    });

    test('gh-1036 characterization pin — flat view shape per provider (pre-refactor)', function () {
        var trackers = loadTrackers({});
        var jira = trackers.createTracker({}, { trackerProvider: 'jira' });

        // Flat / already-normalized: description falls back to body, url to html_url|url.
        assert.deepEqual(jira.normalizeTicket({
            key: 'PROJ-9', id: '1009', title: 'Flat', status: 'Done',
            assignee: 'jane', labels: ['a'], body: 'B', url: 'http://u'
        }), {
            key: 'PROJ-9', id: '1009', title: 'Flat', status: 'Done',
            assignee: 'jane', labels: ['a'], description: 'B',
            url: 'http://u', raw: null
        });

        // Jira full shape: neutral extras ride along; absent ones are null/[].
        assert.deepEqual(jira.normalizeTicket({
            key: 'PROJ-7', id: 7007,
            fields: {
                summary: 'S', status: { name: 'Open' },
                labels: ['x'], description: 'D',
                issuetype: { name: 'Bug' },
                parent: { key: 'PROJ-1' },
                fixVersions: [{ name: '1.0' }, '2.0']
            }
        }), {
            key: 'PROJ-7', id: '7007', title: 'S', status: 'Open',
            assignee: null, labels: ['x'], description: 'D', url: null,
            raw: null, issueType: 'Bug', parentKey: 'PROJ-1',
            fixVersions: ['1.0', '2.0']
        });

        // Jira without key: stringified id becomes the key; missing
        // name-shaped fields stay null.
        var noKey = jira.normalizeTicket({ id: 55, fields: { summary: 'Only id' } });
        assert.equal(noKey.key, '55');
        assert.equal(noKey.id, '55');
        assert.equal(noKey.status, null);
        assert.equal(noKey.issueType, null);
        assert.equal(noKey.parentKey, null);

        // ADO full shape.
        assert.deepEqual(jira.normalizeTicket({
            id: 4242,
            fields: {
                'System.Title': 'Fix the login flow',
                'System.State': 'Active',
                'System.AssignedTo': { displayName: 'Jane Doe' },
                'System.Description': 'Login breaks on expired sessions',
                'System.WorkItemType': 'Bug',
                'System.Parent': 4241
            }
        }), {
            key: '4242', id: '4242', title: 'Fix the login flow',
            status: 'Active', assignee: 'Jane Doe',
            labels: [], description: 'Login breaks on expired sessions',
            url: null, raw: null, issueType: 'Bug', parentKey: '4241',
            fixVersions: []
        });

        // GitHub without repository context: '#N' key (no t.key on the payload).
        var ghNoRepo = jira.normalizeTicket(GITHUB_TICKET);
        assert.equal(ghNoRepo.key, '#41');
        assert.equal(ghNoRepo.status, 'open');
        assert.equal(ghNoRepo.url, 'https://github.com/acme/widgets/issues/41');

        // GitHub without repository context but carrying an explicit key.
        assert.equal(jira.normalizeTicket({ number: 3, key: 'EXT-3', title: 't' }).key, 'EXT-3');

        // Unrecognized shape → null.
        assert.equal(jira.normalizeTicket({ something: 'else' }), null);
    });
});

suite('trackers.js assignForReview', function () {
    test('assigns, moves, and adds the AI label, then reports success', function () {
        var mocks = jiraMocks();
        var trackers = loadTrackers(mocks);
        var result = trackers.createTracker({}, { trackerProvider: 'jira' }).assignForReview('PROJ-123', 'acc-1');
        assert.ok(result.success, 'expected success: ' + JSON.stringify(result));
        assert.deepEqual(mocks.jira_assign_ticket_to.calls[0], { key: 'PROJ-123', accountId: 'acc-1' });
        assert.equal(mocks.jira_move_to_status.calls[0].key, 'PROJ-123');
        assert.equal(mocks.jira_add_label.calls[0].label, configModule.LABELS.AI_GENERATED);
    });

    test('moves to the configured In Review status by default', function () {
        var mocks = jiraMocks();
        var trackers = loadTrackers(mocks);
        trackers.createTracker({}, { trackerProvider: 'jira' }).assignForReview('PROJ-123', 'acc-1');
        assert.equal(
            mocks.jira_move_to_status.calls[0].statusName,
            configModule.STATUSES.IN_REVIEW
        );
    });

    test('honors an explicit target status', function () {
        var mocks = jiraMocks();
        var trackers = loadTrackers(mocks);
        trackers.createTracker({}, { trackerProvider: 'jira' }).assignForReview('PROJ-123', 'acc-1', null, 'Done');
        assert.equal(mocks.jira_move_to_status.calls[0].statusName, 'Done');
    });

    test('removes the WIP label when provided', function () {
        var mocks = jiraMocks();
        var trackers = loadTrackers(mocks);
        trackers.createTracker({}, { trackerProvider: 'jira' }).assignForReview('PROJ-123', 'acc-1', 'wip');
        assert.deepEqual(mocks.jira_remove_label.calls[0], { key: 'PROJ-123', label: 'wip' });
    });

    test('a WIP removal failure does not fail the whole operation', function () {
        var mocks = jiraMocks({ removeLabelFails: true });
        var trackers = loadTrackers(mocks);
        var result = trackers.createTracker({}, { trackerProvider: 'jira' }).assignForReview('PROJ-123', 'acc-1', 'wip');
        assert.ok(result.success, 'WIP cleanup failure must not fail the flow');
    });

    test('a core step failure reports success: false with the error', function () {
        var trackers = loadTrackers({
            jira_assign_ticket_to: recorder('jira_assign_ticket_to', { __throw__: new Error('boom') }),
            jira_move_to_status: recorder('jira_move_to_status', '{}'),
            jira_add_label: recorder('jira_add_label', '{}'),
            jira_remove_label: recorder('jira_remove_label', '{}')
        });
        var result = trackers.createTracker({}, { trackerProvider: 'jira' }).assignForReview('PROJ-123', 'acc-1');
        assert.notOk(result.success);
        assert.contains(result.error, 'boom');
    });

    test('gh-1168: stageFallback="label" falls back to stage_in_review label and completes handoff when moveToStatus fails', function () {
        var adoMove = recorder('ado_move_to_state', {
            __throw__: new Error("The field 'State' contains the value 'In Review' that is not in the list of supported values")
        });
        var adoAddLabel = recorder('ado_add_work_item_label', '{}');
        var adoRemoveLabel = recorder('ado_remove_work_item_label', '{}');
        var adoComment = recorder('ado_add_work_item_comment', '{}');
        var adoGet = recorder('ado_get_work_item', JSON.stringify({
            id: 491,
            fields: { 'System.Title': 'Story', 'System.State': 'Active', 'System.Tags': 'story_wip' }
        }));
        var trackers = loadTrackers({
            ado_move_to_state: adoMove,
            ado_add_work_item_label: adoAddLabel,
            ado_remove_work_item_label: adoRemoveLabel,
            ado_add_work_item_comment: adoComment,
            ado_get_work_item: adoGet
        });
        var t = trackers.createTracker(
            { tracker: { provider: 'ado' }, jira: { stageFallback: 'label' } },
            { trackerProvider: 'ado' }
        );
        var result = t.assignForReview('491', undefined, 'story_wip', 'In Review');
        assert.equal(result.success, true, 'expected success with stageFallback=label: ' + JSON.stringify(result));
        assert.deepEqual(
            adoAddLabel.calls.map(function (c) { return c.label; }),
            ['stage_in_review', configModule.LABELS.AI_GENERATED]
        );
        assert.deepEqual(
            adoRemoveLabel.calls.map(function (c) { return c.label; }),
            ['story_wip']
        );
        assert.equal(adoComment.calls.length, 1);
        assert.contains(adoComment.calls[0].comment, 'stage_in_review');
    });

    test('gh-1168: default stageFallback="none" still fails assignForReview when moveToStatus throws', function () {
        var mocks = jiraMocks();
        mocks.jira_move_to_status = recorder('jira_move_to_status', {
            __throw__: new Error("The field 'State' contains the value 'In Review' that is not in the list of supported values")
        });
        var trackers = loadTrackers(mocks);
        var result = trackers.createTracker({}, { trackerProvider: 'jira' }).assignForReview('PROJ-123', 'acc-1', 'wip');
        assert.equal(result.success, false);
        assert.contains(result.error, 'not in the list of supported values');
        assert.equal(mocks.jira_add_label.calls.length, 0);
    });
});

suite('trackers.js extractTicketKey', function () {
    test('reads the key from an object', function () {
        var trackers = loadTrackers({});
        assert.equal(trackers.createTracker({}, { trackerProvider: 'jira' }).extractTicketKey({ key: 'PROJ-1' }), 'PROJ-1');
    });

    test('reads the key from a JSON string', function () {
        var trackers = loadTrackers({});
        assert.equal(
            trackers.createTracker({}, { trackerProvider: 'jira' }).extractTicketKey('{"key":"PROJ-2"}'),
            'PROJ-2'
        );
    });

    test('returns null for empty and unparseable input', function () {
        var trackers = loadTrackers({});
        var t = trackers.createTracker({}, { trackerProvider: 'jira' });
        assert.equal(t.extractTicketKey(null), null);
        assert.equal(t.extractTicketKey(''), null);
        assert.equal(t.extractTicketKey('not json'), null);
        assert.equal(t.extractTicketKey({ noKey: true }), null);
    });
});

// ── Extended operations (dm.ai#661 / tracker-agnostic agents) ────────────────

suite('trackers.js extended operations — jira provider', function () {
    function jira() { return { tracker: { provider: 'jira' } }; }

    test('linkIssues maps to jira_link_issues {sourceKey, anotherKey, relationship}', function () {
        var link = recorder('jira_link_issues', '{}');
        loadTrackers({ jira_link_issues: link }).createTracker(jira()).linkIssues('A-1', 'A-2', 'Blocks');
        assert.deepEqual(link.calls[0], { sourceKey: 'A-1', anotherKey: 'A-2', relationship: 'Blocks' });
    });

    test('updateField / updateDescription / setPriority map 1:1', function () {
        var uf = recorder('jira_update_field', '{}'), ud = recorder('jira_update_description', '{}'), sp = recorder('jira_set_priority', '{}');
        var t = loadTrackers({ jira_update_field: uf, jira_update_description: ud, jira_set_priority: sp }).createTracker(jira());
        t.updateField('A-1', 'Solution', 'x'); t.updateDescription('A-1', 'd'); t.setPriority('A-1', 'High');
        assert.deepEqual(uf.calls[0], { key: 'A-1', field: 'Solution', value: 'x' });
        assert.deepEqual(ud.calls[0], { key: 'A-1', description: 'd' });
        assert.deepEqual(sp.calls[0], { key: 'A-1', priority: 'High' });
    });

    test('attachFile maps to jira_attach_file_to_ticket {ticketKey, name, filePath}', function () {
        var at = recorder('jira_attach_file_to_ticket', '{}');
        loadTrackers({ jira_attach_file_to_ticket: at }).createTracker(jira()).attachFile('A-1', 'r.png', '/tmp/r.png', 'image/png');
        assert.deepEqual(at.calls[0], { ticketKey: 'A-1', name: 'r.png', filePath: '/tmp/r.png', contentType: 'image/png' });
    });

    test('fieldCode returns the resolved customfield id (unwraps {result})', function () {
        var fc = recorder('jira_get_field_custom_code', { result: 'customfield_10091' });
        assert.equal(loadTrackers({ jira_get_field_custom_code: fc }).createTracker(jira()).fieldCode('P', 'Solution'), 'customfield_10091');
        assert.deepEqual(fc.calls[0], { project: 'P', fieldName: 'Solution' });
    });

    test('createTicketWithParent returns the key and forwards labels', function () {
        var c = recorder('jira_create_ticket_with_parent', '{"key":"A-9"}');
        var key = loadTrackers({ jira_create_ticket_with_parent: c }).createTracker(jira())
            .createTicketWithParent('A', 'Sub-task', 's', 'd', 'A-1', { labels: ['ai'] });
        assert.equal(key, 'A-9');
        assert.deepEqual(c.calls[0], { project: 'A', issueType: 'Sub-task', summary: 's', description: 'd', parentKey: 'A-1', labels: ['ai'] });
    });

    test('createTicketWithFields returns the key', function () {
        var c = recorder('jira_create_ticket_with_json', '{"key":"A-7"}');
        assert.equal(loadTrackers({ jira_create_ticket_with_json: c }).createTracker(jira()).createTicketWithFields('A', { summary: 's' }), 'A-7');
        assert.deepEqual(c.calls[0], { project: 'A', fieldsJson: { summary: 's' } });
    });

    test('normalizeTicket exposes issueType, parentKey and fixVersions', function () {
        var t = loadTrackers({}).createTracker(jira()).normalizeTicket({
            key: 'A-1', fields: { summary: 's', status: { name: 'Open' }, issuetype: { name: 'Story' },
                parent: { key: 'A-0' }, fixVersions: [{ name: '1.2' }], labels: [] }
        });
        assert.equal(t.issueType, 'Story');
        assert.equal(t.parentKey, 'A-0');
        assert.deepEqual(t.fixVersions, ['1.2']);
    });
});

suite('trackers.js extended operations — ado provider', function () {
    function ado() { return { tracker: { provider: 'ado' } }; }

    test('linkIssues maps to ado_link_work_items {sourceId, targetId, relationship} with string ids', function () {
        var link = recorder('ado_link_work_items', '{}');
        loadTrackers({ ado_link_work_items: link }).createTracker(ado()).linkIssues(11, 12, 'blocks');
        assert.deepEqual(link.calls[0], { sourceId: '11', targetId: '12', relationship: 'blocks' });
    });

    test('updateDescription -> ado_update_description', function () {
        var ud = recorder('ado_update_description', '{}');
        loadTrackers({ ado_update_description: ud }).createTracker(ado()).updateDescription('5', 'd');
        assert.deepEqual(ud.calls[0], { id: '5', description: 'd', format: 'markdown' });
    });

    test('updateField on description/labels reuses the existing ado tools', function () {
        var ud = recorder('ado_update_description', '{}'), ut = recorder('ado_update_tags', '{}');
        var t = loadTrackers({ ado_update_description: ud, ado_update_tags: ut }).createTracker(ado());
        t.updateField('5', 'Description', 'body');
        t.updateField('5', 'labels', ['a', 'b']);
        assert.deepEqual(ud.calls[0], { id: '5', description: 'body', format: 'markdown' });
        assert.deepEqual(ut.calls[0], { id: '5', tags: 'a; b' });
    });

    // The ADO tools below ship with the Java (dm.ai#663) and Dart (dmtools-dart#373) runtimes. In the
    // unit-test runtime the network guard makes every integration tool a throwing stub, so the
    // "tool missing" path is simulated by shadowing the name with `undefined` inside trackers.js.
    var NO_ADO_NEW_TOOLS = { ado_update_field: undefined, ado_set_priority: undefined, ado_attach_file: undefined, ado_get_field_code: undefined };

    test('updateField on a custom field calls ado_update_field with the mapped reference name', function () {
        var uf = recorder('ado_update_field', '{}');
        var t = loadTrackers({ ado_update_field: uf }).createTracker(ado());
        t.updateField('5', 'summary', 'New');
        t.updateField('5', 'Custom.Solution', 'x');
        assert.deepEqual(uf.calls[0], { id: '5', field: 'System.Title', value: 'New' });
        assert.deepEqual(uf.calls[1], { id: '5', field: 'Custom.Solution', value: 'x', format: 'markdown' });
    });

    test('updateField on a runtime without ado_update_field names the missing tool', function () {
        var t = loadTrackers(NO_ADO_NEW_TOOLS).createTracker(ado());
        var msg = '';
        try { t.updateField('5', 'Custom.Solution', 'x'); } catch (e) { msg = String(e.message || e); }
        assert.ok(msg.indexOf('ado_update_field') !== -1 && msg.indexOf('#661') !== -1, 'got: ' + msg);
    });

    test('setPriority prefers ado_set_priority (the runtime maps the names)', function () {
        var sp = recorder('ado_set_priority', '{}');
        loadTrackers({ ado_set_priority: sp }).createTracker(ado()).setPriority('5', 'High');
        assert.deepEqual(sp.calls[0], { id: '5', priority: 'High' });
    });

    test('setPriority without ado_set_priority maps Jira names to ADO 1-4 through updateField', function () {
        var uf = recorder('ado_update_field', '{}');
        var t = loadTrackers({ ado_update_field: uf, ado_set_priority: undefined }).createTracker(ado());
        t.setPriority('5', 'High'); t.setPriority('5', 'Lowest'); t.setPriority('5', '3');
        assert.deepEqual(uf.calls.map(function (c) { return c.value; }), [2, 4, 3]);
        assert.equal(uf.calls[0].field, 'Microsoft.VSTS.Common.Priority');
        var bad = '';
        try { t.setPriority('5', 'Whatever'); } catch (e) { bad = String(e.message); }
        assert.ok(bad.indexOf('unknown priority') !== -1);
    });

    test('createTicketWithParent creates, links the parent (Hierarchy) and adds labels', function () {
        var create = recorder('ado_create_work_item', '{"id":77}');
        var link = recorder('ado_link_work_items', '{}');
        var lab = recorder('ado_add_work_item_label', '{}');
        var id = loadTrackers({ ado_create_work_item: create, ado_link_work_items: link, ado_add_work_item_label: lab })
            .createTracker(ado()).createTicketWithParent('P', 'Task', 'T', 'D', '70', { labels: ['ai_generated'] });
        assert.equal(id, '77');
        assert.deepEqual(link.calls[0], { sourceId: '77', targetId: '70', relationship: 'parent' });
        assert.deepEqual(lab.calls[0], { id: '77', label: 'ai_generated' });
    });

    test('createTicketWithFields splits workItemType/title from the remaining ADO fields', function () {
        var create = recorder('ado_create_work_item', '{"id":88}');
        var id = loadTrackers({ ado_create_work_item: create }).createTracker(ado())
            .createTicketWithFields('P', { workItemType: 'Bug', title: 'B', 'Microsoft.VSTS.Common.Priority': 1 });
        assert.equal(id, '88');
        assert.equal(create.calls[0].workItemType, 'Bug');
        assert.equal(create.calls[0].title, 'B');
        assert.deepEqual(JSON.parse(create.calls[0].fieldsJson), { 'Microsoft.VSTS.Common.Priority': 1 });
        var msg = '';
        try { loadTrackers({}).createTracker(ado()).createTicketWithFields('P', { 'System.Title': 'x' }); } catch (e) { msg = String(e.message); }
        assert.ok(msg.indexOf('workItemType') !== -1);
    });

    test('attachFile calls ado_attach_file with {id, name, filePath, contentType}', function () {
        var at = recorder('ado_attach_file', '{}');
        loadTrackers({ ado_attach_file: at }).createTracker(ado()).attachFile('5', 'a.png', '/tmp/a.png', 'image/png');
        assert.deepEqual(at.calls[0], { id: '5', name: 'a.png', filePath: '/tmp/a.png', contentType: 'image/png' });
    });

    test('attachFile on a runtime without ado_attach_file names the missing tool', function () {
        var t = loadTrackers(NO_ADO_NEW_TOOLS).createTracker(ado());
        var msg = '';
        try { t.attachFile('5', 'a.png', '/tmp/a.png'); } catch (e) { msg = String(e.message); }
        assert.ok(msg.indexOf('ado_attach_file') !== -1 && msg.indexOf('#661') !== -1, 'got: ' + msg);
    });

    test('fieldCode resolves through ado_get_field_code and degrades to null without it', function () {
        var fc = recorder('ado_get_field_code', { result: 'Custom.SolutionDesign' });
        assert.equal(loadTrackers({ ado_get_field_code: fc }).createTracker(ado()).fieldCode('P', 'Solution Design'), 'Custom.SolutionDesign');
        assert.deepEqual(fc.calls[0], { project: 'P', fieldName: 'Solution Design' });
        assert.equal(loadTrackers(NO_ADO_NEW_TOOLS).createTracker(ado()).fieldCode('P', 'Solution Design'), null);
    });

    test('ado text format (agents#805): markdown by default for comments, descriptions, create and long-text fields', function () {
        var pc = recorder('ado_add_work_item_comment', '{}'), ud = recorder('ado_update_description', '{}');
        var uf = recorder('ado_update_field', '{}'), cr = recorder('ado_create_work_item', '{"id":9}');
        var t = loadTrackers({ ado_add_work_item_comment: pc, ado_update_description: ud, ado_update_field: uf, ado_create_work_item: cr }).createTracker(ado());
        t.postComment('5', '**c**'); t.updateDescription('5', '# d'); t.updateField('5', 'Custom.Solution', 'x'); t.createTicket('P', 'Task', 'T', '# d');
        [pc, ud, uf, cr].forEach(function (r) { assert.equal(r.calls[0].format, 'markdown'); });
    });

    test('ado text format: short fields never get a format (title, priority, state)', function () {
        var uf = recorder('ado_update_field', '{}');
        var t = loadTrackers({ ado_update_field: uf }).createTracker(ado());
        t.updateField('5', 'summary', 'New'); t.updateField('5', 'Microsoft.VSTS.Common.Priority', 2); t.updateField('5', 'state', 'Done');
        uf.calls.forEach(function (c) { assert.equal(c.format, undefined, JSON.stringify(c)); });
    });

    test('ado text format: adoTextFormat=html (customParams or config) keeps the exact previous args (backward compatibility)', function () {
        var pc = recorder('ado_add_work_item_comment', '{}'), ud = recorder('ado_update_description', '{}');
        var m = { ado_add_work_item_comment: pc, ado_update_description: ud };
        var viaParams = loadTrackers(m).createTracker(ado(), { adoTextFormat: 'html' });
        viaParams.postComment('5', 'c'); viaParams.updateDescription('5', 'd');
        var viaConfig = loadTrackers(m).createTracker({ tracker: { provider: 'ado', adoTextFormat: 'HTML' } });
        viaConfig.postComment('6', 'c');
        assert.deepEqual(pc.calls[0], { id: '5', comment: 'c' });
        assert.deepEqual(ud.calls[0], { id: '5', description: 'd' });
        assert.deepEqual(pc.calls[1], { id: '6', comment: 'c' });
    });

    test('jira and github writes are untouched by the ado text format', function () {
        var jc = recorder('jira_post_comment', '{}');
        loadTrackers({ jira_post_comment: jc }).createTracker({}, { trackerProvider: 'jira' }).postComment('P-1', 'c');
        assert.equal(jc.calls[0].format, undefined);
        assert.equal(JSON.stringify(jc.calls[0]).indexOf('format'), -1);
    });

    test('normalizeTicket exposes issueType and parentKey from System.* fields', function () {
        var t = loadTrackers({}).createTracker(ado()).normalizeTicket({
            id: 9, fields: { 'System.Title': 't', 'System.State': 'Active', 'System.WorkItemType': 'Bug', 'System.Parent': 3 }
        });
        assert.equal(t.issueType, 'Bug');
        assert.equal(t.parentKey, '3');
        assert.deepEqual(t.fixVersions, []);
    });
});

suite('trackers.js extended operations — github provider', function () {
    test('operations GitHub cannot express fail with a provider-named error', function () {
        var t = loadTrackers({}).createTracker({ tracker: { provider: 'github' } });
        ['linkIssues', 'updateField', 'setPriority', 'attachFile', 'createTicketWithFields', 'updateDescription'].forEach(function (op) {
            var msg = '';
            try { t[op]('k', 'a', 'b'); } catch (e) { msg = String(e.message); }
            assert.ok(msg.indexOf('github') !== -1 && msg.indexOf(op) !== -1, op + ' -> ' + msg);
        });
        assert.equal(t.fieldCode('p', 'n'), null);
    });

    function githubTracker(mocks) {
        return loadTrackers(mocks).createTracker({
            tracker: { provider: 'github' },
            repository: { owner: 'acme', repo: 'widgets' }
        });
    }

    test('createTicketWithParent creates the issue and attaches it as a sub-issue by REST id', function () {
        var ghCreate = recorder('github_create_issue', { id: 9001, number: 43, title: 'Step 1', state: 'open' });
        var cli = recorder('cli_execute_command', '{"id": 77, "number": 12}');
        var key = githubTracker({ github_create_issue: ghCreate, cli_execute_command: cli })
            .createTicketWithParent(null, 'Story', 'Step 1', 'Part of #12', 'acme/widgets#12');
        assert.equal(key, 'acme/widgets#43');
        assert.deepEqual(ghCreate.calls[0], { owner: 'acme', repo: 'widgets', title: 'Step 1', body: 'Part of #12' });
        assert.equal(cli.calls[0].command,
            'gh api --method POST repos/acme/widgets/issues/12/sub_issues -F sub_issue_id=9001');
    });

    test('createTicketWithParent resolves a bare parent number against the configured repository', function () {
        var cli = recorder('cli_execute_command', '{}');
        githubTracker({
            github_create_issue: recorder('github_create_issue', { id: 5, number: 6, state: 'open' }),
            cli_execute_command: cli
        }).createTicketWithParent(null, 'Story', 't', 'd', '12');
        assert.contains(cli.calls[0].command, 'repos/acme/widgets/issues/12/sub_issues');
    });

    test('createTicketWithParent fails loudly when the created issue has no id, before linking', function () {
        var cli = recorder('cli_execute_command', '{}');
        assert.throws(function () {
            githubTracker({
                github_create_issue: recorder('github_create_issue', { message: 'Validation Failed' }),
                cli_execute_command: cli
            }).createTicketWithParent(null, 'Story', 't', 'd', '12');
        });
        assert.equal(cli.calls.length, 0, 'nothing is linked without a created issue');
    });

    test('createTicketWithParent with no repository for a bare parent number throws a clear error', function () {
        var msg = '';
        try {
            loadTrackers({ github_create_issue: recorder('github_create_issue', { id: 1, number: 2 }) })
                .createTracker({ tracker: { provider: 'github' } })
                .createTicketWithParent(null, 'Story', 't', 'd', '12');
        } catch (e) { msg = String(e.message); }
        assert.contains(msg, 'no repository');
    });

    test('listChildTickets returns the sub-issues in the parent order as flat views', function () {
        var cli = recorder('cli_execute_command', JSON.stringify([
            { id: 1, number: 13, title: 'Step 1', state: 'closed', labels: [{ name: 'agent:dev' }] },
            { id: 2, number: 14, title: 'Step 2', state: 'open', labels: [] }
        ]));
        var children = githubTracker({ cli_execute_command: cli }).listChildTickets('acme/widgets#12');
        assert.equal(cli.calls[0].command,
            'gh api --method GET repos/acme/widgets/issues/12/sub_issues -F per_page=100 -F page=1');
        assert.equal(cli.calls.length, 1, 'a short page is the last page');
        assert.equal(children.length, 2);
        assert.equal(children[0].key, 'acme/widgets#13');
        assert.equal(children[0].status, 'closed');
        assert.deepEqual(children[0].labels, ['agent:dev']);
        assert.equal(children[1].key, 'acme/widgets#14');
    });

    test('listChildTickets tolerates leading output noise before the JSON', function () {
        var cli = recorder('cli_execute_command', 'warning: something\n[{"id": 1, "number": 13, "state": "open"}]');
        var children = githubTracker({ cli_execute_command: cli }).listChildTickets('12');
        assert.equal(children.length, 1);
        assert.equal(children[0].key, 'acme/widgets#13');
    });

    test('listChildTickets reads every page while pages are full', function () {
        var full = [];
        for (var i = 0; i < 100; i++) full.push({ id: i, number: 100 + i, state: 'open' });
        var pages = [JSON.stringify(full), JSON.stringify([{ id: 500, number: 500, state: 'open' }])];
        var commands = [];
        var cli = function (a) { commands.push(a.command); return pages[commands.length - 1]; };
        var children = githubTracker({ cli_execute_command: cli }).listChildTickets('12');
        assert.equal(children.length, 101);
        assert.equal(children[100].key, 'acme/widgets#500');
        assert.equal(commands.length, 2);
        assert.contains(commands[1], '-F page=2');
        commands.forEach(function (c) { assert.equal(c.indexOf('&'), -1, 'no shell metacharacters: ' + c); });
    });

    test('a missing or unauthenticated gh fails with an error that names the requirement', function () {
        var msg = '';
        try {
            githubTracker({ cli_execute_command: recorder('cli_execute_command', 'bash: gh: command not found') })
                .listChildTickets('12');
        } catch (e) { msg = String(e.message); }
        assert.contains(msg, 'GitHub CLI (gh)');
        assert.contains(msg, 'command not found');
    });

    test('listChildTickets throws on a response that is not a list', function () {
        var cli = recorder('cli_execute_command', '{"message": "Not Found"}');
        assert.throws(function () { githubTracker({ cli_execute_command: cli }).listChildTickets('12'); });
    });

    test('listChildTickets is GitHub-only: jira and ado throw a provider-named error', function () {
        ['jira', 'ado'].forEach(function (provider) {
            var msg = '';
            try { loadTrackers({}).createTracker({ tracker: { provider: provider } }).listChildTickets('X-1'); }
            catch (e) { msg = String(e.message); }
            assert.ok(msg.indexOf(provider) !== -1 && msg.indexOf('listChildTickets') !== -1, provider + ' -> ' + msg);
        });
    });
});

// ── Jira-shaped issue view + ADO tag string (wave 2 foundation) ──────────────

suite('trackers.js toIssueView and ADO tags', function () {
    function t(provider) { return loadTrackers({}).createTracker({ tracker: { provider: provider } }); }

    test('ADO System.Tags string is split into label names', function () {
        var n = t('ado').normalizeTicket({ id: 5, fields: { 'System.Title': 'x', 'System.State': 'Active', 'System.Tags': 'sm_triggered; ai_generated ;wip' } });
        assert.deepEqual(n.labels, ['sm_triggered', 'ai_generated', 'wip']);
        assert.deepEqual(t('ado').normalizeTicket({ id: 6, fields: { 'System.Title': 'x', 'System.Tags': '' } }).labels, []);
    });

    test('a Jira payload passes through UNCHANGED (custom fields and issuelinks survive)', function () {
        var raw = { key: 'A-1', id: '1', fields: { summary: 's', status: { name: 'Open' }, customfield_10091: 'sol', issuelinks: [{ id: 1 }] } };
        var v = t('jira').toIssueView(raw);
        assert.equal(v, raw);
        assert.equal(v.fields.customfield_10091, 'sol');
        assert.equal(t('jira').toIssueView(JSON.stringify(raw)).fields.issuelinks.length, 1);
    });

    test('an ADO work item becomes a Jira-shaped view the existing readers understand', function () {
        var v = t('ado').toIssueView({ id: 77, fields: {
            'System.Title': 'Fix it', 'System.State': 'Active', 'System.WorkItemType': 'Bug', 'System.Parent': 70,
            'System.Tags': 'a; b', 'System.Description': 'd', 'System.AssignedTo': { displayName: 'Jane', uniqueName: 'j@x' } } });
        assert.equal(v.key, '77');
        assert.equal(v.fields.summary, 'Fix it');
        assert.equal(v.fields.status.name, 'Active');
        assert.equal(v.fields.issuetype.name, 'Bug');
        assert.equal(v.fields.parent.key, '70');
        assert.deepEqual(v.fields.labels, ['a', 'b']);
        assert.equal(v.fields.description, 'd');
        assert.equal(v.fields.assignee.displayName, 'Jane');
    });

    test('toIssueView returns null for empty/unparseable input', function () {
        assert.equal(t('ado').toIssueView(null), null);
        assert.equal(t('ado').toIssueView('not json'), null);
    });
});

suite('trackers.js getIssue / searchIssues (Jira-shaped reads)', function () {
    function make(provider, mocks) { return loadTrackers(mocks).createTracker({ tracker: { provider: provider } }); }

    test('jira getIssue forwards key + fields and returns the payload unchanged', function () {
        var raw = { key: 'A-1', fields: { summary: 's', status: { name: 'Open' }, customfield_1: 'v' } };
        var g = recorder('jira_get_ticket', raw);
        var v = make('jira', { jira_get_ticket: g }).getIssue('A-1', ['summary']);
        assert.deepEqual(g.calls[0], { key: 'A-1', fields: ['summary'] });
        assert.equal(v.fields.customfield_1, 'v');
        var g2 = recorder('jira_get_ticket', raw);
        make('jira', { jira_get_ticket: g2 }).getIssue('A-1');
        assert.deepEqual(g2.calls[0], { key: 'A-1' });
    });

    test('jira searchIssues accepts a bare array AND a {issues} page, forwards maxResults/fields', function () {
        var arr = recorder('jira_search_by_jql', [{ key: 'A-1', fields: { summary: 'a' } }]);
        var r1 = make('jira', { jira_search_by_jql: arr }).searchIssues('project = A', { maxResults: 5, fields: ['key'] });
        assert.deepEqual(arr.calls[0], { jql: 'project = A', fields: ['key'], maxResults: 5 });
        assert.equal(r1.length, 1);
        var page = recorder('jira_search_by_jql', JSON.stringify({ issues: [{ key: 'A-2', fields: { summary: 'b' } }] }));
        assert.equal(make('jira', { jira_search_by_jql: page }).searchIssues('q')[0].key, 'A-2');
        assert.deepEqual(make('jira', { jira_search_by_jql: recorder('x', null) }).searchIssues('q'), []);
    });

    test('ado getIssue returns a Jira-shaped view of the work item', function () {
        var g = recorder('ado_get_work_item', { id: 9, fields: { 'System.Title': 't', 'System.State': 'New', 'System.WorkItemType': 'Task', 'System.Tags': 'x; y' } });
        var v = make('ado', { ado_get_work_item: g }).getIssue(9);
        assert.deepEqual(g.calls[0], { id: '9' });
        assert.equal(v.key, '9');
        assert.equal(v.fields.issuetype.name, 'Task');
        assert.deepEqual(v.fields.labels, ['x', 'y']);
    });

    test('ado searchIssues sends the query as WIQL (no translation) and reads {value}', function () {
        var s = recorder('ado_search_by_wiql', JSON.stringify({ value: [{ id: 3, fields: { 'System.Title': 'a', 'System.State': 'Active' } }] }));
        var r = make('ado', { ado_search_by_wiql: s }).searchIssues("SELECT [System.Id] FROM WorkItems WHERE [System.State] = 'Active'");
        assert.equal(s.calls[0].wiql, "SELECT [System.Id] FROM WorkItems WHERE [System.State] = 'Active'");
        assert.equal(r[0].key, '3');
        assert.equal(r[0].fields.status.name, 'Active');
    });

    // agents#899: the SM asks for fields ['key','labels']; dmtools 1.7.280 returns only System.Id + System.Tags
    // (no System.Title), which used to be mistaken for a Jira payload and left key undefined.
    test('agents#899: ado searchIssues keeps the work item id as key when only System.Id/System.Tags come back', function () {
        var s = recorder('ado_search_by_wiql', JSON.stringify({ value: [{ id: 2041388, fields: { 'System.Id': 2041388, 'System.Tags': 'ai_factory; x' } }] }));
        var r = make('ado', { ado_search_by_wiql: s }).searchIssues('SELECT [System.Id] FROM WorkItems', { fields: ['key', 'labels'] });
        assert.equal(r.length, 1);
        assert.equal(r[0].key, '2041388');
        assert.deepEqual(r[0].fields.labels, ['ai_factory', 'x']);
    });

    test('agents#899: ado searchIssues drops Jira-only key/id columns, maps labels, always asks for Title/State/Tags/Type', function () {
        var s = recorder('ado_search_by_wiql', JSON.stringify({ value: [] }));
        make('ado', { ado_search_by_wiql: s }).searchIssues('q', { fields: ['key', 'id', 'labels', 'status', 'summary'] });
        var f = s.calls[0].fields;
        assert.equal(f.indexOf('key'), -1);
        assert.equal(f.indexOf('id'), -1);
        ['System.Title', 'System.State', 'System.Tags', 'System.WorkItemType'].forEach(function (x) {
            assert.ok(f.indexOf(x) !== -1, 'asks for ' + x);
        });
        assert.equal(f.filter(function (x) { return x === 'System.Tags'; }).length, 1, 'no duplicate columns');
    });

    test('agents#899: a Jira payload fetched with a fields filter is still passed through unchanged', function () {
        var t = make('jira', { jira_get_ticket: recorder('jira_get_ticket', JSON.stringify({ key: 'A-1', fields: { labels: ['x'] } })) });
        assert.equal(t.getIssue('A-1', ['labels']).key, 'A-1');
    });

    test('UT-1126-1: adoSearchFields strips comment/comments/COMMENT sentinels while keeping Custom.Answer', function () {
        var s = recorder('ado_search_by_wiql', JSON.stringify({ value: [] }));
        make('ado', { ado_search_by_wiql: s }).searchIssues('q', {
            fields: ['key', 'id', 'comment', 'comments', 'COMMENT', 'Custom.Answer']
        });
        var f = s.calls[0].fields;
        assert.equal(f.indexOf('comment'), -1);
        assert.equal(f.indexOf('comments'), -1);
        assert.equal(f.indexOf('COMMENT'), -1);
        assert.ok(f.indexOf('Custom.Answer') !== -1, 'preserves custom WIT field Custom.Answer');
    });
});

suite('trackers.js — moveToStatusOrMark / stageFallback (agents#856)', function () {
    function setup(opts) {
        opts = opts || {};
        var m = jiraMocks();
        m.jira_move_to_status = opts.moveOk
            ? recorder('jira_move_to_status', '{}')
            : recorder('jira_move_to_status', { __throw__: new Error("The field 'State' contains the value 'PO REVIEW' that is not in the list of supported values") });
        if (opts.addLabelFails) {
            m.jira_add_label = recorder('jira_add_label', { __throw__: new Error('label api down') });
        }
        var t = loadTrackers(m).createTracker({}, Object.assign({ trackerProvider: 'jira' }, opts.customParams || {}));
        return { t: t, m: m };
    }

    test('default is "none": a rejected transition throws exactly like moveToStatus (no labels, no comment)', function () {
        var x = setup();
        assert.equal(x.t.stageFallback(), 'none');
        assert.throws(function () { x.t.moveToStatusOrMark('PS-1', 'PO Review', 'PO_REVIEW'); }, /not in the list of supported values/);
        assert.equal(x.m.jira_add_label.calls.length, 0);
        assert.equal(x.m.jira_post_comment.calls.length, 0);
    });

    test('a successful move reports moved and touches no label (any mode)', function () {
        ['none', 'label'].forEach(function (mode) {
            var x = setup({ moveOk: true, customParams: { stageFallback: mode } });
            var r = x.t.moveToStatusOrMark('PS-1', 'PO Review', 'PO_REVIEW');
            assert.deepEqual(r, { moved: true, marked: false, label: null, error: null });
            assert.equal(x.m.jira_add_label.calls.length, 0);
            assert.equal(x.m.jira_post_comment.calls.length, 0);
        });
    });

    test('"label": a rejected transition adds stage_<key>, drops the previous stage label, explains in a comment', function () {
        var x = setup({ customParams: { stageFallback: 'label' } });
        var r = x.t.moveToStatusOrMark('PS-1', 'PO Review', 'PO_REVIEW', 'BA_ANALYSIS');
        assert.equal(r.moved, false);
        assert.equal(r.marked, true);
        assert.equal(r.label, 'stage_po_review');
        assert.contains(r.error, 'not in the list of supported values');
        assert.equal(x.m.jira_add_label.calls[0].label, 'stage_po_review');
        assert.equal(x.m.jira_remove_label.calls[0].label, 'stage_ba_analysis');
        assert.contains(x.m.jira_post_comment.calls[0].comment, 'stage_po_review');
        assert.contains(x.m.jira_post_comment.calls[0].comment, 'PO Review');
    });

    test('"label" via config.jira.stageFallback works too, and unknown values mean none', function () {
        var m = jiraMocks();
        m.jira_move_to_status = recorder('jira_move_to_status', { __throw__: new Error('nope') });
        var viaConfig = loadTrackers(m).createTracker({ jira: { stageFallback: 'LABEL' } }, { trackerProvider: 'jira' });
        assert.equal(viaConfig.stageFallback(), 'label');
        var weird = loadTrackers(jiraMocks()).createTracker({}, { trackerProvider: 'jira', stageFallback: 'banana' });
        assert.equal(weird.stageFallback(), 'none');
    });

    test('"label": when the marker cannot be added either, it throws loudly with both reasons', function () {
        var x = setup({ addLabelFails: true, customParams: { stageFallback: 'label' } });
        assert.throws(function () { x.t.moveToStatusOrMark('PS-1', 'PO Review', 'PO_REVIEW'); }, /stage label "stage_po_review" could not be added/);
    });

    test('"label": a failing comment or previous-label removal never fails the hand-off', function () {
        var m = jiraMocks();
        m.jira_move_to_status = recorder('jira_move_to_status', { __throw__: new Error('rejected') });
        m.jira_post_comment = recorder('jira_post_comment', { __throw__: new Error('comment api down') });
        m.jira_remove_label = recorder('jira_remove_label', { __throw__: new Error('no such label') });
        var t = loadTrackers(m).createTracker({}, { trackerProvider: 'jira', stageFallback: 'label' });
        var r = t.moveToStatusOrMark('PS-1', 'PO Review', 'PO_REVIEW', 'BA_ANALYSIS');
        assert.equal(r.marked, true);
    });

    test('agents#907 "label": a fallback mark keeps only the new marker — any other stale stage_* label is removed', function () {
        var m = jiraMocks();
        m.jira_move_to_status = recorder('jira_move_to_status', { __throw__: new Error('rejected') });
        m.jira_get_ticket = recorder('jira_get_ticket', JSON.stringify({ key: 'PS-1', fields: { summary: 's', labels: ['stage_po_review', 'stage_in_review', 'wip'] } }));
        var t = loadTrackers(m).createTracker({}, { trackerProvider: 'jira', stageFallback: 'label' });
        // skipped stage: the caller passes BA_ANALYSIS, but the ticket was stuck at PO_REVIEW
        var r = t.moveToStatusOrMark('PS-1', 'In Review', 'IN_REVIEW', 'BA_ANALYSIS');
        assert.equal(r.label, 'stage_in_review');
        assert.deepEqual(m.jira_remove_label.calls.map(function (c) { return c.label; }), ['stage_ba_analysis', 'stage_po_review']);
    });

    test('stage keys are normalized into safe labels', function () {
        var x = setup({ customParams: { stageFallback: 'label' } });
        assert.equal(x.t.moveToStatusOrMark('PS-1', 'In Review - Passed', 'In Review - Passed').label, 'stage_in_review_passed');
    });

    test('works on the ADO provider through the ADO label tool', function () {
        var m = {
            ado_move_to_state: recorder('ado_move_to_state', { __throw__: new Error('state not allowed') }),
            ado_add_work_item_label: recorder('ado_add_work_item_label', '{}'),
            ado_add_work_item_comment: recorder('ado_add_work_item_comment', '{}')
        };
        var t = loadTrackers(m).createTracker({}, { trackerProvider: 'ado', stageFallback: 'label' });
        var r = t.moveToStatusOrMark('2023979', 'PO Review', 'PO_REVIEW');
        assert.equal(r.marked, true);
        assert.equal(m.ado_add_work_item_label.calls[0].label, 'stage_po_review');
        assert.equal(m.ado_add_work_item_label.calls[0].id, '2023979');
    });

    test('agents#1178: formats a user-friendly fallback comment when the tracker returns a raw HTTP/JSON error payload', function () {
        var rawAdoError = 'Tool execution failed: printAndCreateException error: https://dev.azure.com/org/Proj/_apis/wit/workitems/2010283?api-version=7.0 \n' +
            '{"$id":"1","customProperties":{"FieldReferenceName":null,"FieldStatusFlags":"none","ErrorMessage":"The field \'State\' contains the value \'In Review\' that is not in the list of supported values","FieldStatusCode":0,"RuleValidationErrors":[{"fieldReferenceName":"System.State","fieldStatusFlags":"required, hasValues, limitedToValues, invalidListValue","errorMessage":"The field \'State\' contains the value \'In Review\' that is not in the list of supported values","fieldStatusCode":4194317,"ruleValidationErrors":null}]},"innerException":null,"message":"The field \'State\' contains the value \'In Review\' that is not in the list of supported values","typeName":"Microsoft.TeamFoundation.WorkItemTracking.Server.RuleValidationException, Microsoft.TeamFoundation.WorkItemTracking.Server","typeKey":"RuleValidationException","errorCode":0,"eventId":3200}\n' +
            'Bad Request\n400';
        var cases = [
            {
                err: rawAdoError,
                expected: 'Could not move this ticket to "In Review" (The field \'State\' contains the value \'In Review\' that is not in the list of supported values). The stage is recorded with the label `stage_in_review` instead.'
            },
            {
                err: 'Tool execution failed: {"customProperties":{"ErrorMessage":"Custom ADO error"}}',
                expected: 'Could not move this ticket to "In Review" (Custom ADO error). The stage is recorded with the label `stage_in_review` instead.'
            },
            {
                err: 'Tool execution failed: {"errorMessages":["Jira transition blocked"]}',
                expected: 'Could not move this ticket to "In Review" (Jira transition blocked). The stage is recorded with the label `stage_in_review` instead.'
            },
            {
                err: 'Tool execution failed: {not valid json} Bad Request 400',
                expected: 'Could not move this ticket to "In Review" ({not valid json}). The stage is recorded with the label `stage_in_review` instead.'
            },
            {
                err: 'Tool execution failed: printAndCreateException error: https://example.com/api Bad Request 400',
                expected: 'Could not move this ticket to "In Review" (the status "In Review" is not available for this ticket). The stage is recorded with the label `stage_in_review` instead.'
            },
            {
            {
                err: '   ',
                expected: 'Could not move this ticket to "In Review" (the status "In Review" is not available for this ticket). The stage is recorded with the label `stage_in_review` instead.'
            }
        cases.forEach(function (c) {
            var m = {
                ado_move_to_state: recorder('ado_move_to_state', { __throw__: new Error(c.err) }),
                ado_add_work_item_label: recorder('ado_add_work_item_label', '{}'),
                ado_add_work_item_comment: recorder('ado_add_work_item_comment', '{}')
            };
            var t = loadTrackers(m).createTracker({}, { trackerProvider: 'ado', stageFallback: 'label' });
            var r = t.moveToStatusOrMark('2010283', 'In Review', 'IN_REVIEW');
            assert.equal(r.marked, true);
            assert.equal(m.ado_add_work_item_comment.calls[0].comment, c.expected);
            assert.equal(m.ado_add_work_item_comment.calls[0].comment.indexOf('printAndCreateException'), -1);
            assert.equal(m.ado_add_work_item_comment.calls[0].comment.indexOf('RuleValidationException'), -1);
        });
    });
});

suite('trackers.js — stage label cleanup on a successful move (agents#855/#856)', function () {
    function t(mode) {
        var m = jiraMocks();
        var tr = loadTrackers(m).createTracker({}, { trackerProvider: 'jira', stageFallback: mode });
        return { t: tr, m: m };
    }
    test('label mode: after a real move the previous stage label is removed', function () {
        var x = t('label');
        var r = x.t.moveToStatusOrMark('PS-1', 'BA Analysis', 'BA_ANALYSIS', 'PO_REVIEW');
        assert.equal(r.moved, true);
        assert.equal(x.m.jira_remove_label.calls.length, 1);
        assert.equal(x.m.jira_remove_label.calls[0].label, 'stage_po_review');
    });
    test('default mode: a successful move makes no extra label call', function () {
        var x = t('none');
        x.t.moveToStatusOrMark('PS-1', 'BA Analysis', 'BA_ANALYSIS', 'PO_REVIEW');
        assert.equal(x.m.jira_remove_label.calls.length, 0);
    });
    test('label mode: no previous stage given means nothing to remove', function () {
        var x = t('label');
        x.t.moveToStatusOrMark('PS-1', 'BA Analysis', 'BA_ANALYSIS');
        assert.equal(x.m.jira_remove_label.calls.length, 0);
    });
    test('agents#907 label mode: a successful move sweeps every stage_* label, not only the previous one', function () {
        var m = jiraMocks();
        m.jira_get_ticket = recorder('jira_get_ticket', JSON.stringify({ key: 'PS-1', fields: { summary: 's', labels: ['backend', 'stage_po_review', 'stage_ba_analysis'] } }));
        var tr = loadTrackers(m).createTracker({}, { trackerProvider: 'jira', stageFallback: 'label' });
        tr.moveToStatusOrMark('PS-1', 'In Development', 'IN_DEVELOPMENT', 'SOLUTION_ARCHITECTURE');
        var removed = m.jira_remove_label.calls.map(function (c) { return c.label; });
        assert.deepEqual(removed, ['stage_solution_architecture', 'stage_po_review', 'stage_ba_analysis']);
    });
    test('agents#907 label mode: works without previousStageKey (caller does not need to know the stuck stage)', function () {
        var m = jiraMocks();
        m.jira_get_ticket = recorder('jira_get_ticket', JSON.stringify({ key: 'PS-1', fields: { summary: 's', labels: ['stage_po_review'] } }));
        var tr = loadTrackers(m).createTracker({}, { trackerProvider: 'jira', stageFallback: 'label' });
        tr.moveToStatusOrMark('PS-1', 'BA Analysis', 'BA_ANALYSIS');
        assert.deepEqual(m.jira_remove_label.calls.map(function (c) { return c.label; }), ['stage_po_review']);
    });
    test('agents#907 label mode: a failing label read falls back to removing only the previous stage label', function () {
        var m = jiraMocks();
        m.jira_get_ticket = recorder('jira_get_ticket', { __throw__: new Error('read down') });
        var tr = loadTrackers(m).createTracker({}, { trackerProvider: 'jira', stageFallback: 'label' });
        assert.equal(tr.moveToStatusOrMark('PS-1', 'BA Analysis', 'BA_ANALYSIS', 'PO_REVIEW').moved, true);
        assert.deepEqual(m.jira_remove_label.calls.map(function (c) { return c.label; }), ['stage_po_review']);
    });
    test('agents#907 default mode: no label read and no removal on a successful move', function () {
        var m = jiraMocks();
        var tr = loadTrackers(m).createTracker({}, { trackerProvider: 'jira' });
        tr.moveToStatusOrMark('PS-1', 'BA Analysis', 'BA_ANALYSIS', 'PO_REVIEW');
        assert.equal(m.jira_get_ticket.calls.length, 0);
        assert.equal(m.jira_remove_label.calls.length, 0);
    });
    test('label mode: a failing cleanup never fails a successful move', function () {
        var m = jiraMocks({ removeLabelFails: true });
        var tr = loadTrackers(m).createTracker({}, { trackerProvider: 'jira', stageFallback: 'label' });
        assert.equal(tr.moveToStatusOrMark('PS-1', 'BA Analysis', 'BA_ANALYSIS', 'PO_REVIEW').moved, true);
    });
});

suite('trackers.js — hasStage: stage-gate helper for tag-only statuses (gh-916)', function () {
    function t(mode) {
        return loadTrackers(jiraMocks()).createTracker({}, { trackerProvider: 'jira', stageFallback: mode });
    }
    function flat(status, labels) {
        return { key: 'PS-1', status: status, labels: labels || [] };
    }
    function shaped(status, labels) {
        return { key: 'PS-1', fields: { status: { name: status }, labels: labels || [] } };
    }

    test("'none' mode: pure status equality — the exact comparison the gates did before", function () {
        var tr = t('none');
        assert.equal(tr.hasStage(flat('Passed'), 'PASSED', 'Passed'), true);
        assert.equal(tr.hasStage(flat('Failed'), 'PASSED', 'Passed'), false);
        // a stage marker is IGNORED in 'none' mode — no behaviour change for default deployments
        assert.equal(tr.hasStage(flat('New', ['stage_passed']), 'PASSED', 'Passed'), false);
    });

    test("'none' mode: reads the Jira-shaped view exactly like `status === statuses.X` did", function () {
        var tr = t('none');
        assert.equal(tr.hasStage(shaped('In Review - Failed'), 'IN_REVIEW_FAILED', 'In Review - Failed'), true);
        assert.equal(tr.hasStage(shaped('Passed'), 'IN_REVIEW_FAILED', 'In Review - Failed'), false);
    });

    test("'label' mode: a ticket carrying stageLabel(stageKey) counts as being in the stage", function () {
        var tr = t('label');
        assert.equal(tr.hasStage(flat('New', ['stage_passed']), 'PASSED', 'Passed'), true);
        assert.equal(tr.hasStage(flat('New', ['stage_failed', 'other']), 'PASSED', 'Passed'), false);
        assert.equal(tr.hasStage(flat('Passed'), 'PASSED', 'Passed'), true, 'a real status still matches');
    });

    test("'label' mode: works on the Jira-shaped search view ({ fields: { status, labels } })", function () {
        var tr = t('label');
        assert.equal(tr.hasStage(shaped('New', ['stage_in_review_passed']), 'IN_REVIEW_PASSED', 'In Review - Passed'), true);
        assert.equal(tr.hasStage(shaped('New', ['wip']), 'IN_REVIEW_PASSED', 'In Review - Passed'), false);
    });

    test("the marker name is the one moveToStatusOrMark writes (shared stageLabel normalisation)", function () {
        var tr = t('label');
        assert.equal(tr.hasStage(flat('New', ['stage_in_review_passed']), 'IN_REVIEW_PASSED', 'In Review - Passed'), true);
        assert.equal(tr.hasStage(flat('New', ['stage_bug_to_fix']), 'BUG_TO_FIX', 'Bug To Fix'), true);
        assert.equal(tr.hasStage(flat('New', ['stage_ready_for_testing']), 'READY_FOR_TESTING', 'Ready For Testing'), true);
    });

    test('label entries in GitHub object shape ({ name }) are recognised', function () {
        var tr = t('label');
        assert.equal(tr.hasStage({ key: 'o/r#1', status: 'open', labels: [{ name: 'stage_failed' }] }, 'FAILED', 'Failed'), true);
    });

    test('an ADO System.Tags semicolon string is recognised', function () {
        var tr = t('label');
        assert.equal(tr.hasStage({ key: '42', status: 'New', labels: 'stage_skipped; ci' }, 'SKIPPED', 'Skipped'), true);
    });

    test('null/absent tickets answer false instead of throwing', function () {
        var tr = t('label');
        assert.equal(tr.hasStage(null, 'PASSED', 'Passed'), false);
        assert.equal(tr.hasStage(undefined, 'PASSED', 'Passed'), false);
    });

    test('no tool call is ever made — the ticket is inspected as given (no extra reads)', function () {
        var m = jiraMocks();
        ['jira_get_ticket', 'jira_search_by_jql'].forEach(function (n) {
            m[n] = recorder(n, { __throw__: new Error(n + ' must not be called by hasStage') });
        });
        var tr = loadTrackers(m).createTracker({}, { trackerProvider: 'jira', stageFallback: 'label' });
        assert.equal(tr.hasStage(flat('New', []), 'PASSED', 'Passed'), false);
    });
});

suite('trackers.js — createGithubTracker: repository-pinned tracker for the SM (agents: tracker abstraction)', function () {
    function gh() {
        var m = {
            github_add_labels: recorder('github_add_labels', '[]'),
            github_remove_label: recorder('github_remove_label', '{}'),
            github_create_comment: recorder('github_create_comment', '{}')
        };
        return { t: loadTrackers(m).createGithubTracker('epam', 'dmtools-dart'), m: m, mod: loadTrackers(m) };
    }

    test('is a github tracker even when the global provider is something else', function () {
        assert.equal(gh().t.provider(), 'github');
    });

    test('addLabel sends owner/repo of the RULE repository, the number and a one-element labels array', function () {
        var x = gh();
        x.t.addLabel(1211, 'agent:rework');
        assert.deepEqual(x.m.github_add_labels.calls[0], { owner: 'epam', repo: 'dmtools-dart', number: 1211, labels: ['agent:rework'] });
    });

    test('removeLabel sends owner/repo/number and the singular label', function () {
        var x = gh();
        x.t.removeLabel(1428, 'pr_approved');
        assert.deepEqual(x.m.github_remove_label.calls[0], { owner: 'epam', repo: 'dmtools-dart', number: 1428, label: 'pr_approved' });
    });

    test('postComment writes the text to the issue/PR number of that repository', function () {
        var x = gh();
        x.t.postComment(77, 'hello');
        var c = x.m.github_create_comment.calls[0];
        assert.equal(c.workspace, 'epam');
        assert.equal(c.repository, 'dmtools-dart');
        assert.equal(c.pullRequestId, 77);
        assert.equal(c.text, 'hello');
    });

    test('string numbers and gh-N / owner/repo#N keys all resolve to the same number', function () {
        var x = gh();
        x.t.addLabel('5', 'a');
        x.t.addLabel('gh-6', 'a');
        x.t.addLabel('epam/dmtools-dart#7', 'a');
        assert.deepEqual(x.m.github_add_labels.calls.map(function (c) { return c.number; }), [5, 6, 7]);
    });

    test('a composite key keeps its own repository (the key is authoritative)', function () {
        var x = gh();
        x.t.postComment('other/repo#9', 'hi');
        // the comment tool takes the number; the key's repo is not silently replaced by the pinned one
        assert.equal(x.m.github_create_comment.calls[0].pullRequestId, 9);
    });

    test('an unparsable key still fails loudly with the provider-named error', function () {
        assert.throws(function () { gh().t.addLabel('not-a-key', 'a'); }, /cannot parse GitHub issue key/);
    });
});

suite('trackers.js — ADO project for created work items (agents#870, found on a live ADO)', function () {

    function ado(config) {
        var m = {
            ado_create_work_item: recorder('ado_create_work_item', JSON.stringify({ id: 880 })),
            ado_link_work_items: recorder('ado_link_work_items', '{}'),
            ado_add_work_item_label: recorder('ado_add_work_item_label', '{}')
        };
        return { t: loadTrackers(m).createTracker(config || {}, { trackerProvider: 'ado' }), m: m };
    }

    test('a numeric "project" (taken from an ADO work item id) is replaced by the configured jira.project', function () {
        var x = ado({ jira: { project: 'ai-native-sdlc-blueprint' } });
        x.t.createTicketWithParent('879', 'Task', 'title', 'desc', '879');
        assert.equal(x.m.ado_create_work_item.calls[0].project, 'ai-native-sdlc-blueprint');
    });

    test('config.tracker.adoProject wins over jira.project', function () {
        var x = ado({ tracker: { adoProject: 'Team A' }, jira: { project: 'other' } });
        x.t.createTicketWithParent('12', 'Task', 't', 'd', '12');
        assert.equal(x.m.ado_create_work_item.calls[0].project, 'Team A');
    });

    test('a real project name is passed through untouched (and trimmed), whatever the config says', function () {
        var x = ado({ jira: { project: 'configured' } });
        x.t.createTicketWithParent('  my-project ', 'Task', 't', 'd', '5');
        assert.equal(x.m.ado_create_work_item.calls[0].project, 'my-project');
    });

    test('an alphanumeric Jira-style project prefix is a name, not an id: unchanged', function () {
        var x = ado({ jira: { project: 'configured' } });
        x.t.createTicketWithParent('PROJ', 'Task', 't', 'd', 'PROJ-1');
        assert.equal(x.m.ado_create_work_item.calls[0].project, 'PROJ');
    });

    test('createTicketWithFields uses the same project resolution', function () {
        var x = ado({ jira: { project: 'ai-native-sdlc-blueprint' } });
        x.t.createTicketWithFields('879', { workItemType: 'Task', title: 'q' });
        assert.equal(x.m.ado_create_work_item.calls[0].project, 'ai-native-sdlc-blueprint');
    });

    test('with nothing configured the original value is kept (no crash, same call as before)', function () {
        var x = ado({});
        x.t.createTicketWithParent('879', 'Task', 't', 'd', '879');
        assert.equal(x.m.ado_create_work_item.calls[0].project, '879');
    });

    test('Jira and GitHub are not affected by the ADO resolution', function () {
        var m = jiraMocks();
        m.jira_create_ticket_basic = recorder('jira_create_ticket_basic', '{"key":"PROJ-9"}');
        var t = loadTrackers(m).createTracker({ jira: { project: 'configured' } }, { trackerProvider: 'jira' });
        t.createTicket('123', 'Task', 'x', 'y');
        assert.equal(m.jira_create_ticket_basic.calls[0].project, '123', 'Jira path untouched');
    });
});

suite('trackers.js — tracker-agnostic status transitions & stageFallback (gh-932)', function () {
    test('stageFallback precedence: customParams > tracker.stageFallback > jira.stageFallback > none (fail alias)', function () {
        var mod = loadTrackers(jiraMocks());
        assert.equal(mod.createTracker({}, { trackerProvider: 'jira' }).stageFallback(), 'none');
        assert.equal(mod.createTracker({ jira: { stageFallback: 'label' } }, { trackerProvider: 'jira' }).stageFallback(), 'label');
        assert.equal(mod.createTracker({ tracker: { stageFallback: 'label' }, jira: { stageFallback: 'none' } }, { trackerProvider: 'jira' }).stageFallback(), 'label');
        assert.equal(mod.createTracker({ tracker: { stageFallback: 'fail' }, jira: { stageFallback: 'label' } }, { trackerProvider: 'jira' }).stageFallback(), 'none');
        assert.equal(mod.createTracker({ tracker: { stageFallback: 'label' } }, { trackerProvider: 'jira', stageFallback: 'fail' }).stageFallback(), 'none');
        assert.equal(mod.createTracker({ tracker: { stageFallback: 'none' } }, { trackerProvider: 'jira', stageFallback: 'label' }).stageFallback(), 'label');
    });

    test('moveToStatus routes through moveToStatusOrMark in label mode and adds stage_<key> on rejection', function () {
        var m = jiraMocks();
        m.jira_move_to_status = recorder('jira_move_to_status', { __throw__: new Error('Transition not allowed') });
        m.jira_get_ticket = recorder('jira_get_ticket', JSON.stringify({ key: 'PS-1', fields: { summary: 's', labels: ['stage_ba_analysis', 'wip'] } }));
        var t = loadTrackers(m).createTracker({ tracker: { stageFallback: 'label' } }, { trackerProvider: 'jira' });
        var r = t.moveToStatus('PS-1', 'In Review');
        assert.deepEqual(r, { moved: false, marked: true, label: 'stage_in_review', error: 'Transition not allowed' });
        assert.equal(m.jira_add_label.calls[0].label, 'stage_in_review');
        assert.deepEqual(m.jira_remove_label.calls.map(function (c) { return c.label; }), ['stage_ba_analysis']);
        assert.contains(m.jira_post_comment.calls[0].comment, 'stage_in_review');
    });

    test('moveToStatus in default none / fail mode rethrows original error with zero extra API calls', function () {
        ['none', 'fail'].forEach(function (mode) {
            var m = jiraMocks();
            m.jira_move_to_status = recorder('jira_move_to_status', { __throw__: new Error('bad status') });
            var t = loadTrackers(m).createTracker({ tracker: { stageFallback: mode } }, { trackerProvider: 'jira' });
            assert.throws(function () { t.moveToStatus('PS-1', 'In Review'); }, /bad status/);
            assert.equal(m.jira_add_label.calls.length, 0);
            assert.equal(m.jira_remove_label.calls.length, 0);
            assert.equal(m.jira_get_ticket.calls.length, 0);
            assert.equal(m.jira_post_comment.calls.length, 0);
        });
    });

    test('moveToStatus reverse-maps custom statusName to canonical STAGE_KEY (jira.statuses, tracker.statuses, per-provider, customStatuses)', function () {
        var m1 = jiraMocks();
        m1.jira_move_to_status = recorder('jira_move_to_status', { __throw__: new Error('no') });
        var t1 = loadTrackers(m1).createTracker({
            tracker: { stageFallback: 'label', statuses: { PO_REVIEW: 'In Spec' } }
        }, { trackerProvider: 'jira' });
        assert.equal(t1.moveToStatus('PS-1', 'In Spec').label, 'stage_po_review');

        var m2 = {
            ado_move_to_state: recorder('ado_move_to_state', { __throw__: new Error('no state') }),
            ado_add_work_item_label: recorder('ado_add_work_item_label', '{}'),
            ado_add_work_item_comment: recorder('ado_add_work_item_comment', '{}'),
            ado_get_work_item: recorder('ado_get_work_item', JSON.stringify({ id: 9, fields: { 'System.Title': 't', 'System.Tags': '' } }))
        };
        var t2 = loadTrackers(m2).createTracker({
            tracker: { provider: 'ado', stageFallback: 'label', statuses: { ado: { READY_FOR_TESTING: 'QA Ready' } } }
        });
        assert.equal(t2.moveToStatus('9', 'qa ready').label, 'stage_ready_for_testing');

        var m3 = jiraMocks();
        m3.jira_move_to_status = recorder('jira_move_to_status', { __throw__: new Error('no') });
        var t3 = loadTrackers(m3).createTracker(
            { jira: { stageFallback: 'label' } },
            { trackerProvider: 'jira', customStatuses: { SOLUTION_ARCHITECTURE: 'Arch Review' } }
        );
        assert.equal(t3.moveToStatus('PS-1', 'Arch Review').label, 'stage_solution_architecture');

        // Unknown custom status falls back to stageLabel(statusName)
        assert.equal(t3.moveToStatus('PS-1', 'Custom Freeform State').label, 'stage_custom_freeform_state');
    });

    test('GitHub provider in label mode never adds stage_* labels on moveToStatus or moveToStatusOrMark', function () {
        var ghLabels = recorder('github_add_labels', '{}');
        var ghClose = recorder('github_close_issue', '{}');
        var ghComment = recorder('github_create_comment', '{}');
        var t = loadTrackers({
            github_add_labels: ghLabels,
            github_close_issue: ghClose,
            github_create_comment: ghComment,
            github_move_issue_to_status: null
        }).createTracker({
            tracker: { provider: 'github', stageFallback: 'label' },
            repository: { owner: 'acme', repo: 'widgets' }
        });
        t.moveToStatus('acme/widgets#7', 'In Review');
        var r = t.moveToStatusOrMark('acme/widgets#7', 'Done', 'DONE');
        assert.deepEqual(r, { moved: true, marked: false, label: null, error: null });
        assert.equal(ghLabels.calls.length, 1);
        assert.deepEqual(ghLabels.calls[0].labels, ['In Review']);
        assert.equal(ghClose.calls.length, 1);
        assert.equal(ghComment.calls.length, 0);
    });

    test('moveToStatusStrict always calls impl.moveToStatus and throws on rejection even when stageFallback is label', function () {
        var m = jiraMocks();
        m.jira_move_to_status = recorder('jira_move_to_status', { __throw__: new Error('strict failure') });
        var t = loadTrackers(m).createTracker({ tracker: { stageFallback: 'label' } }, { trackerProvider: 'jira' });
        assert.throws(function () { t.moveToStatusStrict('PS-1', 'PO Review'); }, /strict failure/);
        assert.equal(m.jira_add_label.calls.length, 0);
        assert.equal(m.jira_post_comment.calls.length, 0);
    });
});

suite('trackers.js — gh-1163 config resolution & no createTracker(null / initTracker(null guard', function () {
    function listJsEntries(dir) {
        var out = file_list({ path: dir });
        if (typeof out === 'string') out = JSON.parse(out);
        return ((out && out.entries) || []).filter(function (p) {
            return /\.js$/.test(String(p));
        });
    }

    function hasNullTrackerCall(path) {
        return /createTracker\s*\(\s*null|initTracker\s*\(\s*null/.test(file_read({ path: path }));
    }

    test('lint guard: zero non-test js/ files call createTracker(null or initTracker(null', function () {
        var files = listJsEntries('js').concat(listJsEntries('js/common'));
        var violations = files.filter(hasNullTrackerCall);
        assert.deepEqual(violations, [], 'Production js/ files must not pass literal null config to createTracker/initTracker');
    });

    test('createTracker(null, customParams) auto-loads project config via configLoader when omitted', function () {
        var adoComments = [];
        var cl = {
            loadProjectConfig: function (params) {
                return { tracker: { provider: 'ado' }, customParams: (params && params.customParams) || {} };
            }
        };
        var mod = loadModule(
            'js/common/trackers.js',
            makeRequire({
                '../config.js': configModule,
                './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js'),
                '../configLoader.js': cl
            }),
            {
                ado_add_work_item_comment: function (a) { adoComments.push(a); return '{}'; },
                jira_post_comment: function () { throw new Error('jira_post_comment must not be called on ado'); }
            }
        );

        var t1 = mod.createTracker(null, {});
        assert.equal(t1.provider(), 'ado');
        t1.postComment('2174969', 'hello from ado');
        assert.equal(adoComments.length, 1);
        assert.equal(adoComments[0].id, '2174969');

        var t2 = mod.createTrackerFromParams({ jobParams: { customParams: {} }, ticket: { key: '2174969' } });
        assert.equal(t2.provider(), 'ado');

        var t3 = mod.createTrackerFromParams({ customParams: { trackerProvider: 'ado' } });
        assert.equal(t3.provider(), 'ado');

        assert.equal(mod.resolveProjectConfig({ jobParams: {} }).tracker.provider, 'ado');
    });

    test('createTracker(null, customParams) falls back cleanly when configLoader throws', function () {
        var cl = {
            loadProjectConfig: function () { throw new Error('disk error'); }
        };
        var mod = loadModule(
            'js/common/trackers.js',
            makeRequire({
                '../config.js': configModule,
                './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js'),
                '../configLoader.js': cl
            }),
            jiraMocks()
        );
        var t = mod.createTracker(null, {});
        assert.equal(t.provider(), 'jira');
        var tFromParams = mod.createTrackerFromParams(null);
        assert.equal(tFromParams.provider(), 'jira');
    });
});

