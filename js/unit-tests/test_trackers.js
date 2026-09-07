/**
 * Unit tests for js/common/trackers.js
 *
 * The tracker-agnostic ticket layer (the scm.js analog for trackers):
 * a createTracker(config) factory that maps generic ticket operations
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
            'config': configModule
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
        var t = trackers.createTracker({});
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
        assert.equal(trackers.createTracker({}).provider(), 'jira');
        assert.equal(
            trackers.createTracker({ tracker: { provider: 'ADO' } }).provider(),
            'ado',
            'provider must be case-insensitive'
        );
        assert.equal(
            trackers.createTracker({ tracker: { provider: 'github' } }).provider(),
            'github'
        );
    });

    test('unknown provider falls back to jira', function () {
        var trackers = loadTrackers({});
        assert.equal(
            trackers.createTracker({ tracker: { provider: 'trello' } }).provider(),
            'jira'
        );
    });
});

suite('trackers.js jira provider (default)', function () {
    test('getTicket calls jira_get_ticket with the key', function () {
        var mocks = jiraMocks();
        var trackers = loadTrackers(mocks);
        var ticket = trackers.createTracker({}).getTicket('PROJ-123');
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
        var results = trackers.createTracker({}).search('labels = wip');
        assert.deepEqual(mocks.jira_search_by_jql.calls[0], { jql: 'labels = wip' });
        assert.equal(results.length, 1);
        assert.equal(results[0].key, 'PROJ-123');
    });

    test('postComment / getComments use the canonical jira tools', function () {
        var mocks = jiraMocks();
        var trackers = loadTrackers(mocks);
        var t = trackers.createTracker({});
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
        var t = trackers.createTracker({});
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
        var key = trackers.createTracker({}).createTicket('PROJ', 'Bug', 'It breaks', 'details');
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
        assert.deepEqual(trackers.createTracker({}).search('nope'), []);
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

    test('labels are not supported on ado and fail with a clear error', function () {
        var trackers = loadTrackers({});
        var t = trackers.createTracker({ tracker: { provider: 'ado' } });
        assert.throws(function () { t.addLabel('4242', 'x'); });
        assert.throws(function () { t.removeLabel('4242', 'x'); });
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
        var trackers = loadTrackers({ github_close_issue: ghClose });
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
            github_add_labels: ghLabels
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
});

suite('trackers.js normalizeTicket', function () {
    test('returns null for falsy input', function () {
        var trackers = loadTrackers({});
        assert.equal(trackers.createTracker({}).normalizeTicket(null), null);
        assert.equal(trackers.createTracker({}).normalizeTicket(''), null);
    });

    test('passes an already-normalized ticket through', function () {
        var trackers = loadTrackers({});
        var normalized = trackers.createTracker({}).normalizeTicket({
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
        var result = trackers.createTracker({}).assignForReview('PROJ-123', 'acc-1');
        assert.ok(result.success, 'expected success: ' + JSON.stringify(result));
        assert.deepEqual(mocks.jira_assign_ticket_to.calls[0], { key: 'PROJ-123', accountId: 'acc-1' });
        assert.equal(mocks.jira_move_to_status.calls[0].key, 'PROJ-123');
        assert.equal(mocks.jira_add_label.calls[0].label, configModule.LABELS.AI_GENERATED);
    });

    test('moves to the configured In Review status by default', function () {
        var mocks = jiraMocks();
        var trackers = loadTrackers(mocks);
        trackers.createTracker({}).assignForReview('PROJ-123', 'acc-1');
        assert.equal(
            mocks.jira_move_to_status.calls[0].statusName,
            configModule.STATUSES.IN_REVIEW
        );
    });

    test('honors an explicit target status', function () {
        var mocks = jiraMocks();
        var trackers = loadTrackers(mocks);
        trackers.createTracker({}).assignForReview('PROJ-123', 'acc-1', null, 'Done');
        assert.equal(mocks.jira_move_to_status.calls[0].statusName, 'Done');
    });

    test('removes the WIP label when provided', function () {
        var mocks = jiraMocks();
        var trackers = loadTrackers(mocks);
        trackers.createTracker({}).assignForReview('PROJ-123', 'acc-1', 'wip');
        assert.deepEqual(mocks.jira_remove_label.calls[0], { key: 'PROJ-123', label: 'wip' });
    });

    test('a WIP removal failure does not fail the whole operation', function () {
        var mocks = jiraMocks({ removeLabelFails: true });
        var trackers = loadTrackers(mocks);
        var result = trackers.createTracker({}).assignForReview('PROJ-123', 'acc-1', 'wip');
        assert.ok(result.success, 'WIP cleanup failure must not fail the flow');
    });

    test('a core step failure reports success: false with the error', function () {
        var trackers = loadTrackers({
            jira_assign_ticket_to: recorder('jira_assign_ticket_to', { __throw__: new Error('boom') }),
            jira_move_to_status: recorder('jira_move_to_status', '{}'),
            jira_add_label: recorder('jira_add_label', '{}'),
            jira_remove_label: recorder('jira_remove_label', '{}')
        });
        var result = trackers.createTracker({}).assignForReview('PROJ-123', 'acc-1');
        assert.notOk(result.success);
        assert.contains(result.error, 'boom');
    });
});

suite('trackers.js extractTicketKey', function () {
    test('reads the key from an object', function () {
        var trackers = loadTrackers({});
        assert.equal(trackers.createTracker({}).extractTicketKey({ key: 'PROJ-1' }), 'PROJ-1');
    });

    test('reads the key from a JSON string', function () {
        var trackers = loadTrackers({});
        assert.equal(
            trackers.createTracker({}).extractTicketKey('{"key":"PROJ-2"}'),
            'PROJ-2'
        );
    });

    test('returns null for empty and unparseable input', function () {
        var trackers = loadTrackers({});
        var t = trackers.createTracker({});
        assert.equal(t.extractTicketKey(null), null);
        assert.equal(t.extractTicketKey(''), null);
        assert.equal(t.extractTicketKey('not json'), null);
        assert.equal(t.extractTicketKey({ noKey: true }), null);
    });
});
