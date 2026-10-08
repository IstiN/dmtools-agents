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
        assert.deepEqual(adoAdd.calls[0], { id: '4242', comment: 'hello' });
        assert.deepEqual(adoList.calls[0], { id: '4242' });
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
            description: 'details'
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
        assert.deepEqual(ud.calls[0], { id: '5', description: 'd' });
    });

    test('updateField on description/labels reuses the existing ado tools', function () {
        var ud = recorder('ado_update_description', '{}'), ut = recorder('ado_update_tags', '{}');
        var t = loadTrackers({ ado_update_description: ud, ado_update_tags: ut }).createTracker(ado());
        t.updateField('5', 'Description', 'body');
        t.updateField('5', 'labels', ['a', 'b']);
        assert.deepEqual(ud.calls[0], { id: '5', description: 'body' });
        assert.deepEqual(ut.calls[0], { id: '5', tags: 'a; b' });
    });

    test('updateField on a custom field needs ado_update_field and names the missing tool otherwise', function () {
        var t = loadTrackers({}).createTracker(ado());
        var msg = '';
        try { t.updateField('5', 'Custom.Solution', 'x'); } catch (e) { msg = String(e.message || e); }
        assert.ok(msg.indexOf('ado_update_field') !== -1 && msg.indexOf('#661') !== -1, 'got: ' + msg);
        var uf = recorder('ado_update_field', '{}');
        // a runtime that has the tool: it is used, with the human alias mapped to the reference name
        var g = (typeof globalThis !== 'undefined') ? globalThis : this;
        g.ado_update_field = uf;
        try {
            loadTrackers({}).createTracker(ado()).updateField('5', 'summary', 'New');
            assert.deepEqual(uf.calls[0], { id: '5', field: 'System.Title', value: 'New' });
        } finally { delete g.ado_update_field; }
    });

    test('setPriority maps Jira names to ADO 1-4 and falls back to updateField', function () {
        var g = (typeof globalThis !== 'undefined') ? globalThis : this;
        var uf = recorder('ado_update_field', '{}');
        g.ado_update_field = uf;
        try {
            var t = loadTrackers({}).createTracker(ado());
            t.setPriority('5', 'High'); t.setPriority('5', 'Lowest'); t.setPriority('5', '3');
            assert.deepEqual(uf.calls.map(function (c) { return c.value; }), [2, 4, 3]);
            assert.equal(uf.calls[0].field, 'Microsoft.VSTS.Common.Priority');
            var bad = '';
            try { t.setPriority('5', 'Whatever'); } catch (e) { bad = String(e.message); }
            assert.ok(bad.indexOf('unknown priority') !== -1);
        } finally { delete g.ado_update_field; }
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

    test('attachFile names the missing ado_attach_file tool; fieldCode degrades to null', function () {
        var t = loadTrackers({}).createTracker(ado());
        var msg = '';
        try { t.attachFile('5', 'a.png', '/tmp/a.png'); } catch (e) { msg = String(e.message); }
        assert.ok(msg.indexOf('ado_attach_file') !== -1 && msg.indexOf('#661') !== -1, 'got: ' + msg);
        assert.equal(t.fieldCode('P', 'Solution'), null);
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
        ['linkIssues', 'updateField', 'setPriority', 'attachFile', 'createTicketWithParent', 'createTicketWithFields', 'updateDescription'].forEach(function (op) {
            var msg = '';
            try { t[op]('k', 'a', 'b'); } catch (e) { msg = String(e.message); }
            assert.ok(msg.indexOf('github') !== -1 && msg.indexOf(op) !== -1, op + ' -> ' + msg);
        });
        assert.equal(t.fieldCode('p', 'n'), null);
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
});

