/**
 * Unit tests for js/common/reviewThreadInventory.js (gh-957).
 *
 * The rework/review leg thread inventory must be enumerated from the SAME
 * GraphQL reviewThreads census the SM arm rule counts — the live dart #424
 * pathology was the arm rule counting 64 unresolved GraphQL threads while
 * the conversations export surfaced only 2 (both machine notices), so the
 * leg concluded 'nothing to fix' and the no-op loop never converged.
 *
 * Uses: loadModule(), makeRequire(), assert, test(), suite()
 */

function loadInventory() {
    return loadModule(
        'js/common/reviewThreadInventory.js',
        makeRequire({ './machineNotice.js': loadModule('js/common/machineNotice.js') })
    );
}

function gqlNode(opts) {
    var first = { databaseId: opts.dbId };
    if (opts.body) first.body = opts.body;
    if (opts.author) first.author = { login: opts.author };
    var node = {
        id: opts.graphqlId || ('PRRT_' + opts.dbId),
        isResolved: opts.isResolved === true,
        comments: { nodes: [first] }
    };
    if (opts.path) node.path = opts.path;
    if (opts.line !== undefined) node.line = opts.line;
    return node;
}

function gqlEnvelope(nodes) {
    return JSON.stringify({
        data: { repository: { pullRequest: { reviewThreads: { nodes: nodes } } } }
    });
}

function conversation(opts) {
    var root = {
        id: opts.id,
        databaseId: opts.id,
        body: opts.body,
        created_at: '2026-10-17T09:00:00Z'
    };
    root.user = { login: opts.author || 'reviewer' };
    var c = {
        rootComment: root,
        replies: opts.replies || [],
        path: opts.path !== undefined ? opts.path : 'src/foo.ts',
        line: opts.line !== undefined ? opts.line : 10
    };
    // The REST export carries the resolved flags on the conversation level.
    if (opts.resolved !== undefined) c.resolved = opts.resolved;
    if (opts.isResolved !== undefined) c.isResolved = opts.isResolved;
    return c;
}

suite('reviewThreadInventory.parseGraphQLNodes', function() {
    test('parses the full GraphQL envelope (object and JSON string)', function() {
        var inv = loadInventory();
        var nodes = [gqlNode({ dbId: 1 })];
        assert.equal(inv.parseGraphQLNodes(gqlEnvelope(nodes)).length, 1);
        assert.equal(inv.parseGraphQLNodes({
            data: { repository: { pullRequest: { reviewThreads: { nodes: nodes } } } }
        }).length, 1);
    });

    test('accepts a bare node array and a {nodes} short envelope', function() {
        var inv = loadInventory();
        var nodes = [gqlNode({ dbId: 1 }), gqlNode({ dbId: 2 })];
        assert.equal(inv.parseGraphQLNodes(nodes).length, 2);
        assert.equal(inv.parseGraphQLNodes({ nodes: nodes }).length, 2);
    });

    test('garbage input fails closed to an empty array', function() {
        var inv = loadInventory();
        assert.equal(inv.parseGraphQLNodes(null).length, 0);
        assert.equal(inv.parseGraphQLNodes('not json').length, 0);
        assert.equal(inv.parseGraphQLNodes({ data: {} }).length, 0);
    });
});

suite('reviewThreadInventory.collectThreadInventory — GraphQL-first (gh-957)', function() {

    test('dart #424 shape: threads missing from the conversations export still land in the inventory', function() {
        var inv = loadInventory();
        // GraphQL counts 3 unresolved threads; the conversations export
        // surfaced only 1 of them (plus a machine notice).
        var nodes = [
            gqlNode({ dbId: 101, graphqlId: 'PRRT_seen', path: 'src/a.ts', line: 5, body: 'seen body', author: 'alice' }),
            gqlNode({ dbId: 102, graphqlId: 'PRRT_missing1', path: 'src/b.ts', line: 7, body: 'missing body 1', author: 'bob' }),
            gqlNode({ dbId: 103, graphqlId: 'PRRT_missing2', path: null, body: 'missing body 2', author: 'carol' })
        ];
        var conversations = [
            conversation({ id: 101, body: 'seen body', author: 'alice', path: 'src/a.ts', line: 5 }),
            conversation({ id: 900, body: '🧵 Unresolved review threads — rework armed. boilerplate', path: null })
        ];

        var result = inv.collectThreadInventory(conversations, gqlEnvelope(nodes));

        assert.equal(result.threads.length, 3, 'ALL GraphQL threads are enumerated — not just the ones conversations surfaced');
        assert.equal(result.census.source, 'graphql');
        assert.equal(result.census.graphqlUnresolved, 3, 'the census is the arm-rule count');
        assert.equal(result.counts.notices, 1, 'the conversation-only machine notice is counted for the note');
        var bodies = result.threads.map(function(t) { return t.body; }).join('|');
        assert.contains(bodies, 'missing body 1');
        assert.contains(bodies, 'missing body 2');
        assert.contains(result.markdownSection, 'missing body 1', 'GraphQL-only threads render into the markdown');
        assert.contains(result.markdownSection, '1 machine notice(s) excluded');
        assert.notContains(result.markdownSection, 'rework armed', 'the notice never renders');
    });

    test('enrichment fills body/author/path/replies from the matched conversation', function() {
        var inv = loadInventory();
        var nodes = [gqlNode({ dbId: 201, graphqlId: 'PRRT_enriched', isResolved: false })];
        var conversations = [
            conversation({
                id: 201, body: 'conversation body', author: 'dave', path: 'src/c.ts', line: 42,
                replies: [{ user: { login: 'erin' }, body: 'a reply', created_at: '2026-10-17T10:00:00Z' }]
            })
        ];

        var result = inv.collectThreadInventory(conversations, gqlEnvelope(nodes));
        var t = result.threads[0];

        assert.equal(t.threadId, 'PRRT_enriched');
        assert.equal(t.rootCommentId, 201, 'reply anchor enriched from the conversation');
        assert.equal(t.path, 'src/c.ts');
        assert.equal(t.line, 42);
        assert.equal(t.body, 'conversation body');
        assert.contains(result.markdownSection, 'conversation body');
        assert.contains(result.markdownSection, 'a reply', 'conversation replies render');
        assert.contains(result.markdownSection, '**dave**', 'conversation author renders');
    });

    test('pathless GraphQL threads keep their resolve id but get no reply anchor', function() {
        var inv = loadInventory();
        var nodes = [gqlNode({ dbId: 301, graphqlId: 'PRRT_toplevel', path: null, body: 'top-level review comment', author: 'frank' })];
        var result = inv.collectThreadInventory([], gqlEnvelope(nodes));
        assert.equal(result.threads.length, 1);
        assert.equal(result.threads[0].threadId, 'PRRT_toplevel', 'resolvable via GraphQL id');
        assert.equal(result.threads[0].rootCommentId, null, 'no inline reply anchor without a path');
        assert.equal(result.threads[0].path, null);
    });

    test('GraphQL isResolved is the resolved truth — the arm-rule census can never disagree', function() {
        var inv = loadInventory();
        var nodes = [
            gqlNode({ dbId: 401, graphqlId: 'PRRT_open', isResolved: false, path: 'src/d.ts', body: 'still open', author: 'gina' }),
            gqlNode({ dbId: 402, graphqlId: 'PRRT_closed', isResolved: true, path: 'src/e.ts', body: 'resolved one', author: 'gina' })
        ];
        // The REST export disagrees (claims the open one is resolved) — GraphQL wins.
        var conversations = [
            conversation({ id: 401, body: 'still open', resolved: true }),
            conversation({ id: 402, body: 'resolved one' })
        ];
        var result = inv.collectThreadInventory(conversations, gqlEnvelope(nodes));
        var open = result.threads.filter(function(t) { return t.rootCommentId === 401; })[0];
        var closed = result.threads.filter(function(t) { return t.rootCommentId === 402; })[0];
        assert.equal(open.resolved, false, 'GraphQL isResolved=false stays open even when REST disagrees');
        assert.equal(closed.resolved, true);
        assert.contains(result.markdownSection, 'still open');
        assert.notContains(result.markdownSection, 'resolved one');
        assert.contains(result.markdownSection, '1 resolved thread(s) excluded');
    });

    test('machine-notice GraphQL threads are dropped and counted (gh-808 AC1 preserved)', function() {
        var inv = loadInventory();
        var nodes = [
            gqlNode({ dbId: 501, graphqlId: 'PRRT_notice', path: null, body: '### ✅ Rework Completed\npushed the fixes', author: 'ai-teammate' }),
            gqlNode({ dbId: 502, graphqlId: 'PRRT_real', path: 'src/f.ts', body: 'real finding', author: 'henry' })
        ];
        var result = inv.collectThreadInventory([], gqlEnvelope(nodes));
        assert.equal(result.threads.length, 1);
        assert.equal(result.threads[0].threadId, 'PRRT_real');
        assert.equal(result.counts.notices, 1);
    });

    test('bot-authored GraphQL threads stay flagged (informational, not actionable)', function() {
        var inv = loadInventory();
        var nodes = [
            gqlNode({ dbId: 601, graphqlId: 'PRRT_bot', path: 'src/g.ts', body: 'ci report', author: 'github-actions[bot]' }),
            gqlNode({ dbId: 602, graphqlId: 'PRRT_human', path: 'src/h.ts', body: 'human finding', author: 'ivy' })
        ];
        var result = inv.collectThreadInventory([], gqlEnvelope(nodes));
        assert.equal(result.threads.length, 2);
        assert.equal(result.threads[0].bot, true);
        assert.equal(result.threads[1].bot, false);
        assert.equal(result.counts.open, 1, 'only the human thread counts as open');
        assert.contains(result.markdownSection, '1 bot-generated thread(s) excluded');
        assert.contains(result.markdownSection, 'human finding');
        assert.notContains(result.markdownSection, 'ci report');
    });

    test('a GraphQL-only PR (zero conversations) still produces the full inventory', function() {
        var inv = loadInventory();
        var nodes = [
            gqlNode({ dbId: 701, graphqlId: 'PRRT_only', path: 'src/i.ts', line: 3, body: 'only-from-graphql', author: 'judy' })
        ];
        var result = inv.collectThreadInventory([], gqlEnvelope(nodes));
        assert.equal(result.threads.length, 1);
        assert.equal(result.threads[0].body, 'only-from-graphql');
        assert.equal(result.enriched[0].author, 'judy', 'author comes from the GraphQL first comment');
        assert.contains(result.markdownSection, 'only-from-graphql');
    });
});

suite('reviewThreadInventory.collectThreadInventory — legacy fallback', function() {

    test('GraphQL failure (null payload) falls back to the conversations path', function() {
        var inv = loadInventory();
        var conversations = [
            conversation({ id: 801, body: 'legacy open', author: 'kate' }),
            conversation({ id: 802, body: 'legacy resolved', resolved: true })
        ];
        var result = inv.collectThreadInventory(conversations, null);
        assert.equal(result.census.source, 'conversations');
        assert.equal(result.census.graphqlUnresolved, null);
        assert.equal(result.threads.length, 2);
        var open = result.threads.filter(function(t) { return t.rootCommentId === 801; })[0];
        var closed = result.threads.filter(function(t) { return t.rootCommentId === 802; })[0];
        assert.equal(open.resolved, false);
        assert.equal(closed.resolved, true);
        assert.contains(result.markdownSection, 'legacy open');
        assert.notContains(result.markdownSection, 'legacy resolved');
    });

    test('empty GraphQL node list uses the legacy path even when conversations exist', function() {
        var inv = loadInventory();
        var conversations = [conversation({ id: 901, body: 'conv only' })];
        var result = inv.collectThreadInventory(conversations, gqlEnvelope([]));
        assert.equal(result.census.source, 'conversations');
        assert.equal(result.threads.length, 1);
        assert.equal(result.threads[0].rootCommentId, 901);
    });
});

suite('reviewThreadInventory.buildFromConversations — GraphQL id enrichment', function() {

    test('threadId and isResolved enrich from the GraphQL nodes matched by databaseId', function() {
        var inv = loadInventory();
        var conversations = [
            conversation({ id: 1001, body: 'open finding' }),
            conversation({ id: 1002, body: 'graphql-resolved finding' })
        ];
        var nodes = [
            gqlNode({ dbId: 1001, graphqlId: 'PRRT_a', isResolved: false }),
            gqlNode({ dbId: 1002, graphqlId: 'PRRT_b', isResolved: true })
        ];
        var result = inv.buildFromConversations(conversations, nodes);
        assert.equal(result.enriched[0].threadId, 'PRRT_a');
        assert.equal(result.enriched[0].resolved, false);
        assert.equal(result.enriched[1].threadId, 'PRRT_b');
        assert.equal(result.enriched[1].resolved, true, 'GraphQL isResolved enriches the legacy path');
    });

    test('GraphQL nodes that cannot be joined (no id / no comments / no databaseId) are skipped', function() {
        var inv = loadInventory();
        var conversations = [conversation({ id: 1101, body: 'unjoined finding' })];
        var unjoinable = [
            { id: 'PRRT_noid', isResolved: true, comments: { nodes: [{}] } },
            { id: 'PRRT_nodbid', isResolved: true, comments: { nodes: [{ databaseId: null }] } },
            { id: 'PRRT_nocomments', isResolved: true },
            null
        ];
        var result = inv.buildFromConversations(conversations, unjoinable);
        assert.equal(result.enriched[0].threadId, null, 'no threadId enrichment from unjoinable nodes');
        assert.equal(result.enriched[0].resolved, false, 'no resolved enrichment either');
    });
});
