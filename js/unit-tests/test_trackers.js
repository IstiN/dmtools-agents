/**
 * Unit tests for js/common/trackers.js
 *
 * The tracker-agnostic ticket layer (the scm.js analog for trackers):
 * every operation goes through the generic tracker_* tool family and the
 * runtime routes to the configured backend (Jira | ADO | GitHub issues).
 * When a runtime does not expose tracker_* tools (legacy Java), the layer
 * falls back to the native jira_* tools so scripts stay portable.
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

    test('reports the tracker-agnostic provider', function () {
        var trackers = loadTrackers({});
        assert.equal(trackers.createTracker({}).provider(), 'tracker');
    });
});

suite('trackers.js key normalization', function () {
    test('expands a bare issue number with the configured repository', function () {
        var getTicket = recorder('tracker_get_ticket', JSON.stringify(GITHUB_TICKET));
        var trackers = loadTrackers({ tracker_get_ticket: getTicket });
        var t = trackers.createTracker({ repository: { owner: 'acme', repo: 'widgets' } });
        t.getTicket('41');
        assert.equal(getTicket.calls[0].key, 'acme/widgets#41');
    });

    test('passes full keys through unchanged', function () {
        var getTicket = recorder('tracker_get_ticket', JSON.stringify(GITHUB_TICKET));
        var trackers = loadTrackers({ tracker_get_ticket: getTicket });
        var t = trackers.createTracker({ repository: { owner: 'acme', repo: 'widgets' } });
        t.getTicket('acme/widgets#7');
        t.getTicket('PROJ-123');
        assert.equal(getTicket.calls[0].key, 'acme/widgets#7');
        assert.equal(getTicket.calls[1].key, 'PROJ-123');
    });

    test('bare numbers without repository config stay unchanged', function () {
        var getTicket = recorder('tracker_get_ticket', JSON.stringify(GITHUB_TICKET));
        var trackers = loadTrackers({ tracker_get_ticket: getTicket });
        trackers.createTracker({}).getTicket('41');
        assert.equal(getTicket.calls[0].key, '41');
    });
});

suite('trackers.js getTicket', function () {
    test('calls tracker_get_ticket with the key', function () {
        var getTicket = recorder('tracker_get_ticket', JSON.stringify(JIRA_TICKET));
        var trackers = loadTrackers({ tracker_get_ticket: getTicket });
        var ticket = trackers.createTracker({}).getTicket('PROJ-123');
        assert.deepEqual(getTicket.calls[0], { key: 'PROJ-123' });
        assert.equal(ticket.key, 'PROJ-123');
    });

    test('normalizes a Jira-shaped response', function () {
        var trackers = loadTrackers({
            tracker_get_ticket: recorder('tracker_get_ticket', JSON.stringify(JIRA_TICKET))
        });
        var ticket = trackers.createTracker({}).getTicket('PROJ-123');
        assert.equal(ticket.key, 'PROJ-123');
        assert.equal(ticket.title, 'Fix the login flow');
        assert.equal(ticket.status, 'In Progress');
        assert.equal(ticket.assignee, 'Jane Doe');
        assert.deepEqual(ticket.labels, ['backend', 'wip']);
        assert.equal(ticket.raw, null, 'raw payload should not leak into the normalized view');
    });

    test('normalizes a GitHub-shaped response and builds the issue key', function () {
        var trackers = loadTrackers({
            tracker_get_ticket: recorder('tracker_get_ticket', GITHUB_TICKET)
        });
        var ticket = trackers.createTracker({
            repository: { owner: 'acme', repo: 'widgets' }
        }).getTicket('acme/widgets#41');
        assert.equal(ticket.key, 'acme/widgets#41');
        assert.equal(ticket.title, 'Fix the login flow');
        assert.equal(ticket.status, 'open');
        assert.equal(ticket.assignee, 'jane-doe');
        assert.deepEqual(ticket.labels, ['bug', 'wip']);
    });

    test('normalizes an ADO-shaped response', function () {
        var trackers = loadTrackers({
            tracker_get_ticket: recorder('tracker_get_ticket', ADO_TICKET)
        });
        var ticket = trackers.createTracker({}).getTicket('4242');
        assert.equal(ticket.key, '4242');
        assert.equal(ticket.title, 'Fix the login flow');
        assert.equal(ticket.status, 'Active');
        assert.equal(ticket.assignee, 'Jane Doe');
        assert.deepEqual(ticket.labels, []);
    });

    test('returns null for an empty or unparseable response', function () {
        var trackers = loadTrackers({
            tracker_get_ticket: recorder('tracker_get_ticket', '   ')
        });
        assert.equal(trackers.createTracker({}).getTicket('PROJ-123'), null);
    });
});

suite('trackers.js search', function () {
    test('calls tracker_search with the query', function () {
        var search = recorder('tracker_search', JSON.stringify({
            issues: [JIRA_TICKET]
        }));
        var trackers = loadTrackers({ tracker_search: search });
        var results = trackers.createTracker({}).search('labels = wip');
        assert.deepEqual(search.calls[0], { query: 'labels = wip' });
        assert.equal(results.length, 1);
        assert.equal(results[0].key, 'PROJ-123');
        assert.equal(results[0].title, 'Fix the login flow');
    });

    test('returns an empty list when nothing is found', function () {
        var trackers = loadTrackers({
            tracker_search: recorder('tracker_search', JSON.stringify({ issues: [] }))
        });
        assert.deepEqual(trackers.createTracker({}).search('nope'), []);
    });
});

suite('trackers.js comments', function () {
    test('postComment calls tracker_post_comment with key and body', function () {
        var postComment = recorder('tracker_post_comment', '{"id":"c1"}');
        var trackers = loadTrackers({ tracker_post_comment: postComment });
        trackers.createTracker({}).postComment('PROJ-123', 'looks good');
        assert.deepEqual(postComment.calls[0], { key: 'PROJ-123', comment: 'looks good' });
    });

    test('getComments normalizes Jira-shaped comment pages', function () {
        var getComments = recorder('tracker_get_comments', JSON.stringify({
            comments: [
                { author: { displayName: 'Reviewer' }, body: 'please fix', created: '2026-09-07T10:00:00Z' }
            ]
        }));
        var trackers = loadTrackers({ tracker_get_comments: getComments });
        var comments = trackers.createTracker({}).getComments('PROJ-123');
        assert.deepEqual(getComments.calls[0], { key: 'PROJ-123' });
        assert.equal(comments.length, 1);
        assert.equal(comments[0].author, 'Reviewer');
        assert.equal(comments[0].body, 'please fix');
        assert.equal(comments[0].created, '2026-09-07T10:00:00Z');
    });

    test('getComments normalizes GitHub-shaped comment lists', function () {
        var getComments = recorder('tracker_get_comments', JSON.stringify([
            { user: { login: 'reviewer' }, body: 'please fix', created_at: '2026-09-07T10:00:00Z' }
        ]));
        var trackers = loadTrackers({ tracker_get_comments: getComments });
        var comments = trackers.createTracker({}).getComments('acme/widgets#41');
        assert.equal(comments.length, 1);
        assert.equal(comments[0].author, 'reviewer');
        assert.equal(comments[0].body, 'please fix');
    });
});

suite('trackers.js labels, status, assignee', function () {
    test('addLabel and removeLabel pass exact args', function () {
        var addLabel = recorder('tracker_add_label', '{}');
        var removeLabel = recorder('tracker_remove_label', '{}');
        var trackers = loadTrackers({
            tracker_add_label: addLabel,
            tracker_remove_label: removeLabel
        });
        var t = trackers.createTracker({});
        t.addLabel('PROJ-123', 'ai-generated');
        t.removeLabel('PROJ-123', 'wip');
        assert.deepEqual(addLabel.calls[0], { key: 'PROJ-123', label: 'ai-generated' });
        assert.deepEqual(removeLabel.calls[0], { key: 'PROJ-123', label: 'wip' });
    });

    test('moveToStatus passes the friendly status through', function () {
        var moveToStatus = recorder('tracker_move_to_status', '{}');
        var trackers = loadTrackers({ tracker_move_to_status: moveToStatus });
        trackers.createTracker({}).moveToStatus('PROJ-123', 'In Review');
        assert.deepEqual(moveToStatus.calls[0], { key: 'PROJ-123', status: 'In Review' });
    });

    test('assignTo passes the user through', function () {
        var assignTo = recorder('tracker_assign_to', '{}');
        var trackers = loadTrackers({ tracker_assign_to: assignTo });
        trackers.createTracker({}).assignTo('PROJ-123', 'acc-1');
        assert.deepEqual(assignTo.calls[0], { key: 'PROJ-123', user: 'acc-1' });
    });

    test('createTicket passes project, type, title and description', function () {
        var createTicket = recorder('tracker_create_ticket', '{"key":"PROJ-9"}');
        var trackers = loadTrackers({ tracker_create_ticket: createTicket });
        var key = trackers.createTracker({})
            .createTicket('PROJ', 'Bug', 'It breaks', 'details here');
        assert.deepEqual(createTicket.calls[0], {
            project: 'PROJ',
            type: 'Bug',
            title: 'It breaks',
            description: 'details here'
        });
        assert.equal(key, 'PROJ-9');
    });
});

suite('trackers.js jira fallback', function () {
    test('getTicket falls back to jira_get_ticket when tracker tools are absent', function () {
        var jiraGet = recorder('jira_get_ticket', JSON.stringify(JIRA_TICKET));
        var trackers = loadTrackers({
            tracker_get_ticket: undefined,
            jira_get_ticket: jiraGet
        });
        var ticket = trackers.createTracker({}).getTicket('PROJ-123');
        assert.deepEqual(jiraGet.calls[0], { key: 'PROJ-123' });
        assert.equal(ticket.key, 'PROJ-123');
        assert.equal(ticket.title, 'Fix the login flow');
    });

    test('moveToStatus fallback maps status → statusName', function () {
        var jiraMove = recorder('jira_move_to_status', '{}');
        var trackers = loadTrackers({
            tracker_move_to_status: undefined,
            jira_move_to_status: jiraMove
        });
        trackers.createTracker({}).moveToStatus('PROJ-123', 'In Review');
        assert.deepEqual(jiraMove.calls[0], { key: 'PROJ-123', statusName: 'In Review' });
    });

    test('assignTo fallback maps user → accountId', function () {
        var jiraAssign = recorder('jira_assign_ticket_to', '{}');
        var trackers = loadTrackers({
            tracker_assign_to: undefined,
            jira_assign_ticket_to: jiraAssign
        });
        trackers.createTracker({}).assignTo('PROJ-123', 'acc-1');
        assert.deepEqual(jiraAssign.calls[0], { key: 'PROJ-123', accountId: 'acc-1' });
    });

    test('search fallback maps query → jql and unwraps the issues page', function () {
        var jiraSearch = recorder('jira_search_by_jql', JSON.stringify({
            issues: [JIRA_TICKET]
        }));
        var trackers = loadTrackers({
            tracker_search: undefined,
            jira_search_by_jql: jiraSearch
        });
        var results = trackers.createTracker({}).search('labels = wip');
        assert.deepEqual(jiraSearch.calls[0], { jql: 'labels = wip' });
        assert.equal(results.length, 1);
        assert.equal(results[0].key, 'PROJ-123');
    });

    test('comment and label operations fall back to their jira twins', function () {
        var jiraComment = recorder('jira_post_comment', '{}');
        var jiraComments = recorder('jira_get_comments', JSON.stringify({
            comments: [{ author: { displayName: 'A' }, body: 'b', created: 'c' }]
        }));
        var jiraAdd = recorder('jira_add_label', '{}');
        var jiraRemove = recorder('jira_remove_label', '{}');
        var trackers = loadTrackers({
            tracker_post_comment: undefined,
            tracker_get_comments: undefined,
            tracker_add_label: undefined,
            tracker_remove_label: undefined,
            jira_post_comment: jiraComment,
            jira_get_comments: jiraComments,
            jira_add_label: jiraAdd,
            jira_remove_label: jiraRemove
        });
        var t = trackers.createTracker({});
        t.postComment('PROJ-123', 'hi');
        t.getComments('PROJ-123');
        t.addLabel('PROJ-123', 'x');
        t.removeLabel('PROJ-123', 'y');
        assert.deepEqual(jiraComment.calls[0], { key: 'PROJ-123', comment: 'hi' });
        assert.deepEqual(jiraComments.calls[0], { key: 'PROJ-123' });
        assert.deepEqual(jiraAdd.calls[0], { key: 'PROJ-123', label: 'x' });
        assert.deepEqual(jiraRemove.calls[0], { key: 'PROJ-123', label: 'y' });
    });

    test('createTicket fallback maps onto the jira_create_ticket args', function () {
        var jiraCreate = recorder('jira_create_ticket', '{"key":"PROJ-9"}');
        var trackers = loadTrackers({
            tracker_create_ticket: undefined,
            jira_create_ticket: jiraCreate
        });
        trackers.createTracker({}).createTicket('PROJ', 'Bug', 'It breaks', 'details');
        assert.deepEqual(jiraCreate.calls[0], {
            project: 'PROJ',
            issueType: 'Bug',
            summary: 'It breaks',
            description: 'details'
        });
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
});

suite('trackers.js assignForReview', function () {
    function happyMocks(opts) {
        return {
            tracker_assign_to: recorder('tracker_assign_to', '{}'),
            tracker_move_to_status: recorder('tracker_move_to_status', '{}'),
            tracker_add_label: recorder('tracker_add_label', '{}'),
            tracker_remove_label: opts && opts.removeLabelFails
                ? recorder('tracker_remove_label', { __throw__: new Error('label api down') })
                : recorder('tracker_remove_label', '{}')
        };
    }

    test('assigns, moves, and adds the AI label, then reports success', function () {
        var mocks = happyMocks();
        var trackers = loadTrackers(mocks);
        var result = trackers.createTracker({}).assignForReview('PROJ-123', 'acc-1');
        assert.ok(result.success, 'expected success: ' + JSON.stringify(result));
        assert.deepEqual(mocks.tracker_assign_to.calls[0], { key: 'PROJ-123', user: 'acc-1' });
        assert.equal(mocks.tracker_move_to_status.calls[0].key, 'PROJ-123');
        assert.equal(mocks.tracker_add_label.calls[0].label, configModule.LABELS.AI_GENERATED);
    });

    test('moves to the configured In Review status by default', function () {
        var mocks = happyMocks();
        var trackers = loadTrackers(mocks);
        trackers.createTracker({}).assignForReview('PROJ-123', 'acc-1');
        assert.equal(mocks.tracker_move_to_status.calls[0].status, configModule.STATUSES.IN_REVIEW);
    });

    test('honors an explicit target status', function () {
        var mocks = happyMocks();
        var trackers = loadTrackers(mocks);
        trackers.createTracker({}).assignForReview('PROJ-123', 'acc-1', null, 'Done');
        assert.equal(mocks.tracker_move_to_status.calls[0].status, 'Done');
    });

    test('removes the WIP label when provided', function () {
        var mocks = happyMocks();
        var trackers = loadTrackers(mocks);
        trackers.createTracker({}).assignForReview('PROJ-123', 'acc-1', 'wip');
        assert.deepEqual(mocks.tracker_remove_label.calls[0], { key: 'PROJ-123', label: 'wip' });
    });

    test('a WIP removal failure does not fail the whole operation', function () {
        var mocks = happyMocks({ removeLabelFails: true });
        var trackers = loadTrackers(mocks);
        var result = trackers.createTracker({}).assignForReview('PROJ-123', 'acc-1', 'wip');
        assert.ok(result.success, 'WIP cleanup failure must not fail the flow');
    });

    test('a core step failure reports success: false with the error', function () {
        var trackers = loadTrackers({
            tracker_assign_to: recorder('tracker_assign_to', { __throw__: new Error('boom') }),
            tracker_move_to_status: recorder('tracker_move_to_status', '{}'),
            tracker_add_label: recorder('tracker_add_label', '{}'),
            tracker_remove_label: recorder('tracker_remove_label', '{}')
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
