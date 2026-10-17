/**
 * Unit tests for js/fetchParentContextToInput.js
 *
 * Tests: no-op guard, parent resolution, JQL placeholder, context matching,
 *        file writing, re-fetch fallback, error resilience.
 *
 * Uses: loadModule(), makeRequire(), assert, test(), suite()
 */

// ── Loader helper ─────────────────────────────────────────────────────────────

function loadFetchParentContext(mocks) {
    return loadModule(
        'js/fetchParentContextToInput.js',
        makeRequire({
            './common/trackers.js': loadModule('js/common/trackers.js', makeRequire({
                '../config.js': configModule,
                './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
            }), mocks || {})
        }),
        mocks || {}
    );
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

var PARENT_KEY = 'PROJ-100';
var TICKET_KEY = 'PROJ-101';
var INPUT_FOLDER = 'input/PROJ-101';

function makeParams(customParams, overrides) {
    return Object.assign({
        inputFolderPath: INPUT_FOLDER,
        ticket: {
            key: TICKET_KEY,
            fields: {
                parent: { key: PARENT_KEY },
                summary: '[SA] Solution Architecture ticket',
                status: { name: 'In Progress' }
            }
        },
        jobParams: {
            customParams: customParams || {}
        }
    }, overrides || {});
}

function makeSearchResult(key, summaryPrefix, extraFields) {
    var fields = Object.assign({
        summary: summaryPrefix + ' Some Title',
        description: 'Ticket description content',
        status: { name: 'Done' }
    }, extraFields || {});
    return { key: key, fields: fields };
}

var MINIMAL_PARENT_CONTEXT_FETCH = {
    jql: 'parent = {parentKey}',
    fields: ['key', 'summary', 'description', 'status'],
    contexts: [
        { prefix: '[BA]', file: 'ba.md', label: 'Business Analysis', description: 'BA desc' },
        { prefix: '[SA]', file: 'sa.md', label: 'Solution Architecture', description: 'SA desc' }
    ]
};

// ── Suite: no-op guard ────────────────────────────────────────────────────────

suite('fetchParentContextToInput — no-op guard', function() {

    test('does nothing when parentContextFetch is absent from customParams', function() {
        var writtenFiles = [];
        var m = loadFetchParentContext({
            jira_search_by_jql: function() { throw new Error('should not be called'); },
            file_write: function(p, c) { writtenFiles.push(p); }
        });
        m.action(makeParams({}));
        assert.equal(writtenFiles.length, 0, 'no files written');
    });

    test('does nothing when customParams is absent entirely', function() {
        var writtenFiles = [];
        var m = loadFetchParentContext({
            jira_search_by_jql: function() { throw new Error('should not be called'); },
            file_write: function(p, c) { writtenFiles.push(p); }
        });
        var params = {
            inputFolderPath: INPUT_FOLDER,
            ticket: { key: TICKET_KEY, fields: { parent: { key: PARENT_KEY } } },
            jobParams: {}
        };
        m.action(params);
        assert.equal(writtenFiles.length, 0, 'no files written');
    });

    test('does nothing when ticket has no parent', function() {
        var writtenFiles = [];
        var m = loadFetchParentContext({
            jira_get_ticket: function() { return { key: TICKET_KEY, fields: { summary: 'no parent' } }; },
            jira_search_by_jql: function() { throw new Error('should not be called'); },
            file_write: function(p, c) { writtenFiles.push(p); }
        });
        var params = makeParams(MINIMAL_PARENT_CONTEXT_FETCH);
        params.ticket = { key: TICKET_KEY, fields: {} }; // no parent field
        m.action(params);
        assert.equal(writtenFiles.length, 0, 'no files written when parent absent');
    });

    test('does nothing when JQL returns empty results', function() {
        var writtenFiles = [];
        var m = loadFetchParentContext({
            jira_search_by_jql: function() { return []; },
            file_write: function(p, c) { writtenFiles.push(p); }
        });
        m.action(makeParams(MINIMAL_PARENT_CONTEXT_FETCH));
        assert.equal(writtenFiles.length, 0, 'no files written for empty results');
    });

});

// ── Suite: JQL placeholder ────────────────────────────────────────────────────

suite('fetchParentContextToInput — JQL placeholder', function() {

    test('replaces {parentKey} in JQL with actual parent key', function() {
        var capturedJql = null;
        var m = loadFetchParentContext({
            jira_search_by_jql: function(opts) { capturedJql = opts.jql; return []; },
            file_write: function() {}
        });
        m.action(makeParams(MINIMAL_PARENT_CONTEXT_FETCH));
        assert.notEqual(capturedJql, null, 'JQL was called');
        assert.ok(capturedJql.indexOf(PARENT_KEY) !== -1, 'parent key substituted: ' + capturedJql);
        assert.ok(capturedJql.indexOf('{parentKey}') === -1, 'placeholder removed: ' + capturedJql);
    });

    test('passes configured fields to jira_search_by_jql', function() {
        var capturedFields = null;
        var m = loadFetchParentContext({
            jira_search_by_jql: function(opts) { capturedFields = opts.fields; return []; },
            file_write: function() {}
        });
        var cfg = Object.assign({}, MINIMAL_PARENT_CONTEXT_FETCH, {
            fields: ['key', 'summary', 'description', 'status', 'High-Level Solution']
        });
        m.action(makeParams(cfg));
        assert.ok(capturedFields !== null, 'fields passed to search');
        assert.ok(capturedFields.indexOf('High-Level Solution') !== -1, 'custom field included');
    });

});

// ── Suite: context matching ───────────────────────────────────────────────────

suite('fetchParentContextToInput — context matching', function() {

    test('matches [BA] prefix and writes ba.md', function() {
        var writtenFiles = [];
        var m = loadFetchParentContext({
            jira_search_by_jql: function() {
                return [makeSearchResult('PROJ-200', '[BA]')];
            },
            file_write: function(p, c) { writtenFiles.push(p); }
        });
        m.action(makeParams(MINIMAL_PARENT_CONTEXT_FETCH));
        assert.equal(writtenFiles.length, 1, 'one file written');
        assert.ok(writtenFiles[0].indexOf('ba.md') !== -1, 'ba.md written: ' + writtenFiles[0]);
    });

    test('matches [SA] prefix and writes sa.md', function() {
        var writtenFiles = [];
        var m = loadFetchParentContext({
            jira_search_by_jql: function() {
                return [makeSearchResult('PROJ-201', '[SA]')];
            },
            file_write: function(p, c) { writtenFiles.push(p); }
        });
        m.action(makeParams(MINIMAL_PARENT_CONTEXT_FETCH));
        assert.equal(writtenFiles.length, 1, 'one file written');
        assert.ok(writtenFiles[0].indexOf('sa.md') !== -1, 'sa.md written: ' + writtenFiles[0]);
    });

    test('matches multiple results and writes separate files', function() {
        var writtenFiles = [];
        var m = loadFetchParentContext({
            jira_search_by_jql: function() {
                return [
                    makeSearchResult('PROJ-200', '[BA]'),
                    makeSearchResult('PROJ-201', '[SA]')
                ];
            },
            file_write: function(p, c) { writtenFiles.push(p); }
        });
        m.action(makeParams(MINIMAL_PARENT_CONTEXT_FETCH));
        assert.equal(writtenFiles.length, 2, 'two files written');
    });

    test('prefix matching is case-insensitive', function() {
        var writtenFiles = [];
        var m = loadFetchParentContext({
            jira_search_by_jql: function() {
                return [makeSearchResult('PROJ-200', '[ba]')]; // lowercase
            },
            file_write: function(p, c) { writtenFiles.push(p); }
        });
        m.action(makeParams(MINIMAL_PARENT_CONTEXT_FETCH));
        assert.equal(writtenFiles.length, 1, 'case-insensitive match writes file');
    });

    test('unmatched prefix writes no file', function() {
        var writtenFiles = [];
        var m = loadFetchParentContext({
            jira_search_by_jql: function() {
                return [makeSearchResult('PROJ-202', '[QA]')]; // no QA context configured
            },
            file_write: function(p, c) { writtenFiles.push(p); }
        });
        m.action(makeParams(MINIMAL_PARENT_CONTEXT_FETCH));
        assert.equal(writtenFiles.length, 0, 'no file for unmatched prefix');
    });

    test('file is written under inputFolderPath', function() {
        var writtenPaths = [];
        var m = loadFetchParentContext({
            jira_search_by_jql: function() {
                return [makeSearchResult('PROJ-200', '[BA]')];
            },
            file_write: function(p, c) { writtenPaths.push(p); }
        });
        m.action(makeParams(MINIMAL_PARENT_CONTEXT_FETCH));
        assert.ok(writtenPaths[0].indexOf(INPUT_FOLDER) === 0, 'path starts with input folder: ' + writtenPaths[0]);
    });

});

// ── Suite: file content ───────────────────────────────────────────────────────

suite('fetchParentContextToInput — file content', function() {

    test('written markdown contains ticket key and label', function() {
        var writtenContent = null;
        var m = loadFetchParentContext({
            jira_search_by_jql: function() {
                return [makeSearchResult('PROJ-200', '[BA]', { description: 'AC1: user can login' })];
            },
            file_write: function(p, c) { writtenContent = c; }
        });
        m.action(makeParams(MINIMAL_PARENT_CONTEXT_FETCH));
        assert.ok(writtenContent !== null, 'content was written');
        assert.ok(writtenContent.indexOf('PROJ-200') !== -1, 'ticket key in content');
        assert.ok(writtenContent.indexOf('Business Analysis') !== -1, 'label in content');
    });

    test('description content appears in written file', function() {
        var writtenContent = null;
        var m = loadFetchParentContext({
            jira_search_by_jql: function() {
                return [makeSearchResult('PROJ-200', '[BA]', { description: 'AC1: user can login' })];
            },
            file_write: function(p, c) { writtenContent = c; }
        });
        m.action(makeParams(MINIMAL_PARENT_CONTEXT_FETCH));
        assert.ok(writtenContent.indexOf('AC1: user can login') !== -1, 'description content present');
    });

    test('uses DEFAULT contexts when cfg.contexts is not provided', function() {
        var writtenPaths = [];
        var m = loadFetchParentContext({
            jira_search_by_jql: function() {
                return [makeSearchResult('PROJ-200', '[BA]')];
            },
            file_write: function(p, c) { writtenPaths.push(p); }
        });
        // cfg without contexts — should fall back to defaults
        m.action(makeParams({ jql: 'parent = {parentKey}' }));
        assert.equal(writtenPaths.length, 1, 'default contexts applied');
        assert.ok(writtenPaths[0].indexOf('parent_context_ba.md') !== -1, 'default BA filename used');
    });

});

// ── Suite: re-fetch fallback ──────────────────────────────────────────────────

suite('fetchParentContextToInput — re-fetch fallback', function() {

    test('re-fetches full ticket when a configured field is missing in search result', function() {
        var refetchedKeys = [];
        var m = loadFetchParentContext({
            jira_search_by_jql: function() {
                // Returns result WITHOUT 'High-Level Solution' field
                return [{ key: 'PROJ-200', fields: { summary: '[BA] Title', status: { name: 'Done' } } }];
            },
            jira_get_ticket: function(opts) {
                refetchedKeys.push(opts.key);
                return {
                    key: 'PROJ-200',
                    fields: {
                        summary: '[BA] Title',
                        description: 'Full description',
                        status: { name: 'Done' },
                        'High-Level Solution': 'Architecture overview'
                    }
                };
            },
            file_write: function() {}
        });
        var cfg = Object.assign({}, MINIMAL_PARENT_CONTEXT_FETCH, {
            fields: ['key', 'summary', 'description', 'status', 'High-Level Solution']
        });
        m.action(makeParams(cfg));
        assert.ok(refetchedKeys.indexOf('PROJ-200') !== -1, 're-fetch was triggered for PROJ-200');
    });

    test('re-fetched field content appears in output file', function() {
        var writtenContent = null;
        var m = loadFetchParentContext({
            jira_search_by_jql: function() {
                return [{ key: 'PROJ-200', fields: { summary: '[BA] Title', status: { name: 'Done' } } }];
            },
            jira_get_ticket: function() {
                return {
                    key: 'PROJ-200',
                    fields: {
                        summary: '[BA] Title',
                        description: 'Full description from re-fetch',
                        status: { name: 'Done' },
                        'High-Level Solution': 'Architecture overview'
                    }
                };
            },
            file_write: function(p, c) { writtenContent = c; }
        });
        var cfg = Object.assign({}, MINIMAL_PARENT_CONTEXT_FETCH, {
            fields: ['key', 'summary', 'description', 'status', 'High-Level Solution']
        });
        m.action(makeParams(cfg));
        assert.ok(writtenContent !== null, 'file written');
        assert.ok(writtenContent.indexOf('Architecture overview') !== -1, 're-fetched field in output');
    });

});

// ── Suite: parentAsContext ────────────────────────────────────────────────────

suite('fetchParentContextToInput — parentAsContext', function() {

    function makeParentTicket(key, summaryPrefix, extraFields) {
        var fields = Object.assign({
            summary: summaryPrefix + ' Parent Story Title',
            description: 'Parent description content',
            status: { name: 'In Progress' }
        }, extraFields || {});
        return { key: key, fields: fields };
    }

    test('writes named context file when parentAsContext is configured', function() {
        var writtenFiles = [];
        var m = loadFetchParentContext({
            jira_get_ticket: function(opts) {
                return makeParentTicket(opts.key || PARENT_KEY, '[EXAMPLE]');
            },
            jira_search_by_jql: function() { return []; },
            file_write: function(p, c) { writtenFiles.push(p); }
        });
        var cfg = Object.assign({}, MINIMAL_PARENT_CONTEXT_FETCH, {
            parentAsContext: {
                file: 'parent_context_ba.md',
                label: 'Business Analysis',
                description: 'BA context from parent story'
            }
        });
        m.action(makeParams(cfg));
        var contextFiles = writtenFiles.filter(function(p) { return p.indexOf('parent_context_ba.md') !== -1; });
        assert.equal(contextFiles.length, 1, 'parent_context_ba.md written via parentAsContext');
    });

    test('does not write named context file when parentAsContext is absent', function() {
        var writtenFiles = [];
        var m = loadFetchParentContext({
            jira_get_ticket: function(opts) {
                return makeParentTicket(opts.key || PARENT_KEY, '[EXAMPLE]');
            },
            jira_search_by_jql: function() { return []; },
            file_write: function(p, c) { writtenFiles.push(p); }
        });
        m.action(makeParams(MINIMAL_PARENT_CONTEXT_FETCH));
        var contextFiles = writtenFiles.filter(function(p) { return p.indexOf('parent_context_ba.md') !== -1; });
        assert.equal(contextFiles.length, 0, 'parent_context_ba.md NOT written without parentAsContext');
    });

    test('always writes parent-{KEY}.md alongside the named context file', function() {
        var writtenFiles = [];
        var m = loadFetchParentContext({
            jira_get_ticket: function(opts) {
                return makeParentTicket(opts.key || PARENT_KEY, '[EXAMPLE]');
            },
            jira_search_by_jql: function() { return []; },
            file_write: function(p, c) { writtenFiles.push(p); }
        });
        var cfg = Object.assign({}, MINIMAL_PARENT_CONTEXT_FETCH, {
            parentAsContext: { file: 'parent_context_ba.md', label: 'Business Analysis' }
        });
        m.action(makeParams(cfg));
        var rawParent = writtenFiles.filter(function(p) { return p.indexOf('parent-' + PARENT_KEY + '.md') !== -1; });
        var ctxFile   = writtenFiles.filter(function(p) { return p.indexOf('parent_context_ba.md') !== -1; });
        assert.equal(rawParent.length, 1, 'parent-KEY.md always written');
        assert.equal(ctxFile.length, 1, 'parent_context_ba.md also written');
        assert.equal(writtenFiles.length, 2, 'exactly two files written total');
    });

    test('named context file content includes label heading and ticket key', function() {
        var writtenContents = {};
        var m = loadFetchParentContext({
            jira_get_ticket: function(opts) {
                return makeParentTicket(opts.key || PARENT_KEY, '[EXAMPLE]');
            },
            jira_search_by_jql: function() { return []; },
            file_write: function(p, c) { writtenContents[p] = c; }
        });
        var cfg = Object.assign({}, MINIMAL_PARENT_CONTEXT_FETCH, {
            parentAsContext: {
                file: 'parent_context_ba.md',
                label: 'Business Analysis',
                description: 'This is the authoritative source'
            }
        });
        m.action(makeParams(cfg));
        var key = INPUT_FOLDER + '/parent_context_ba.md';
        var content = writtenContents[key];
        assert.ok(content !== undefined, 'content written for parent_context_ba.md');
        assert.ok(content.indexOf('Business Analysis') !== -1, 'label heading present');
        assert.ok(content.indexOf(PARENT_KEY) !== -1, 'parent key present');
        assert.ok(content.indexOf('This is the authoritative source') !== -1, 'description blurb present');
        assert.ok(content.indexOf('Parent description content') !== -1, 'parent description field present');
    });

    test('named context file includes extra fields like Acceptance Criteria', function() {
        var writtenContents = {};
        var m = loadFetchParentContext({
            jira_get_ticket: function(opts) {
                return makeParentTicket(opts.key || PARENT_KEY, '[EXAMPLE]', {
                    'Acceptance Criteria': 'AC 1 - User can login\nAC 2 - User can logout'
                });
            },
            jira_search_by_jql: function() { return []; },
            file_write: function(p, c) { writtenContents[p] = c; }
        });
        var cfg = Object.assign({}, MINIMAL_PARENT_CONTEXT_FETCH, {
            fields: ['key', 'summary', 'description', 'status', 'Acceptance Criteria'],
            parentAsContext: { file: 'parent_context_ba.md', label: 'Business Analysis' }
        });
        m.action(makeParams(cfg));
        var content = writtenContents[INPUT_FOLDER + '/parent_context_ba.md'];
        assert.ok(content !== undefined, 'file written');
        assert.ok(content.indexOf('AC 1 - User can login') !== -1, 'Acceptance Criteria content present');
    });

    test('parentAsContext is non-fatal when jira_get_ticket throws', function() {
        var writtenFiles = [];
        var m = loadFetchParentContext({
            jira_get_ticket: function() { throw new Error('network error'); },
            jira_search_by_jql: function() { return []; },
            file_write: function(p, c) { writtenFiles.push(p); }
        });
        var cfg = Object.assign({}, MINIMAL_PARENT_CONTEXT_FETCH, {
            parentAsContext: { file: 'parent_context_ba.md', label: 'Business Analysis' }
        });
        var threw = false;
        try { m.action(makeParams(cfg)); } catch (e) { threw = true; }
        assert.ok(!threw, 'jira_get_ticket error is non-fatal');
        assert.equal(writtenFiles.length, 0, 'no files written on fetch error');
    });

    test('parentAsContext works alongside sibling context matching', function() {
        var writtenFiles = [];
        var m = loadFetchParentContext({
            jira_get_ticket: function(opts) {
                return makeParentTicket(opts.key || PARENT_KEY, '[EXAMPLE]');
            },
            jira_search_by_jql: function() {
                return [makeSearchResult('PROJ-300', '[SA]')];
            },
            file_write: function(p, c) { writtenFiles.push(p); }
        });
        var cfg = Object.assign({}, MINIMAL_PARENT_CONTEXT_FETCH, {
            parentAsContext: { file: 'parent_context_ba.md', label: 'Business Analysis' }
        });
        m.action(makeParams(cfg));
        var baFiles = writtenFiles.filter(function(p) { return p.indexOf('parent_context_ba.md') !== -1; });
        var saFiles = writtenFiles.filter(function(p) { return p.indexOf('sa.md') !== -1; });
        assert.equal(baFiles.length, 1, 'BA context from parentAsContext');
        assert.equal(saFiles.length, 1, 'SA context from sibling match');
    });

});

// ── Suite: error resilience ───────────────────────────────────────────────────

suite('fetchParentContextToInput — error resilience', function() {

    test('is non-fatal when JQL search throws', function() {
        var m = loadFetchParentContext({
            jira_search_by_jql: function() { throw new Error('Jira unavailable'); },
            file_write: function() { throw new Error('should not write'); }
        });
        // Should not throw
        var threw = false;
        try {
            m.action(makeParams(MINIMAL_PARENT_CONTEXT_FETCH));
        } catch (e) {
            threw = true;
        }
        assert.ok(!threw, 'JQL error is non-fatal');
    });

    test('is non-fatal when file_write throws', function() {
        var m = loadFetchParentContext({
            jira_search_by_jql: function() {
                return [makeSearchResult('PROJ-200', '[BA]')];
            },
            file_write: function() { throw new Error('disk full'); }
        });
        var threw = false;
        try {
            m.action(makeParams(MINIMAL_PARENT_CONTEXT_FETCH));
        } catch (e) {
            threw = true;
        }
        assert.ok(!threw, 'file_write error is non-fatal');
    });

    test('is non-fatal when ticket fetch for parent key fails', function() {
        var m = loadFetchParentContext({
            jira_get_ticket: function() { throw new Error('ticket not found'); },
            jira_search_by_jql: function() { return []; },
            file_write: function() {}
        });
        var params = makeParams(MINIMAL_PARENT_CONTEXT_FETCH);
        params.ticket = null; // force jira_get_ticket call
        var threw = false;
        try {
            m.action(params);
        } catch (e) {
            threw = true;
        }
        assert.ok(!threw, 'ticket fetch error is non-fatal');
    });

    test('processes remaining results after one file_write fails', function() {
        var writtenFiles = [];
        var writeCount = 0;
        var m = loadFetchParentContext({
            jira_search_by_jql: function() {
                return [
                    makeSearchResult('PROJ-200', '[BA]'),
                    makeSearchResult('PROJ-201', '[SA]')
                ];
            },
            file_write: function(p, c) {
                writeCount++;
                if (writeCount === 1) throw new Error('first write fails');
                writtenFiles.push(p);
            }
        });
        var threw = false;
        try {
            m.action(makeParams(MINIMAL_PARENT_CONTEXT_FETCH));
        } catch (e) {
            threw = true;
        }
        assert.ok(!threw, 'first write failure does not crash');
        assert.equal(writtenFiles.length, 1, 'second file still written');
    });

});

// ── Suite: comments rendering ─────────────────────────────────────────────────

suite('fetchParentContextToInput — comments rendering', function() {

    var COMMENTS_CFG = Object.assign({}, MINIMAL_PARENT_CONTEXT_FETCH, {
        fields: ['key', 'summary', 'description', 'status', 'comment']
    });

    function runWithComment(commentField) {
        var written = {};
        var m = loadFetchParentContext({
            jira_get_ticket: function() { throw new Error('parent story unavailable'); },
            jira_search_by_jql: function() {
                return [makeSearchResult('PROJ-200', '[BA]', { comment: commentField })];
            },
            file_write: function(p, c) { written[p] = c; }
        });
        m.action(makeParams(COMMENTS_CFG));
        return written;
    }

    function contentOf(written) {
        assert.ok(Object.prototype.hasOwnProperty.call(written, INPUT_FOLDER + '/ba.md'), 'ba.md written');
        return written[INPUT_FOLDER + '/ba.md'];
    }

    test('renders Jira comment object shape with author displayName and date', function() {
        var content = contentOf(runWithComment({
            total: 1,
            comments: [
                { author: { displayName: 'Jane Doe' }, created: '2024-01-15T10:00:00.000+0000', body: 'Looks good' }
            ]
        }));
        assert.ok(content.indexOf('**Comments:**') !== -1, 'comments section present');
        assert.ok(content.indexOf('> **Jane Doe** (2024-01-15):') !== -1, 'author and date rendered');
        assert.ok(content.indexOf('> Looks good') !== -1, 'body rendered as blockquote');
    });

    test('renders plain array comment shape', function() {
        var content = contentOf(runWithComment([
            { author: { displayName: 'Jane Doe' }, created: '2024-01-15T10:00:00.000+0000', body: 'Looks good' }
        ]));
        assert.ok(content.indexOf('> **Jane Doe** (2024-01-15):') !== -1, 'array shape rendered');
    });

    test('falls back to author emailAddress when displayName is missing', function() {
        var content = contentOf(runWithComment({
            total: 1,
            comments: [
                { author: { emailAddress: 'jane@example.com' }, created: '2024-02-01T00:00:00.000+0000', body: 'hi' }
            ]
        }));
        assert.ok(content.indexOf('> **jane@example.com** (2024-02-01):') !== -1, 'email fallback rendered');
    });

    test("uses 'Unknown' when author is absent", function() {
        var content = contentOf(runWithComment({
            total: 1,
            comments: [{ created: '2024-03-01T00:00:00.000+0000', body: 'anon' }]
        }));
        assert.ok(content.indexOf('> **Unknown** (2024-03-01):') !== -1, 'Unknown author rendered');
    });

    test('renders empty date parens when created is missing', function() {
        var content = contentOf(runWithComment({
            total: 1,
            comments: [{ author: { displayName: 'Jane Doe' }, body: 'no date' }]
        }));
        assert.ok(content.indexOf('> **Jane Doe** ():') !== -1, 'empty date rendered');
    });

    test('prefixes every body line with a blockquote marker', function() {
        var content = contentOf(runWithComment({
            total: 1,
            comments: [
                { author: { displayName: 'Jane Doe' }, created: '2024-01-15T10:00:00.000+0000', body: 'line1\nline2' }
            ]
        }));
        assert.ok(content.indexOf('> line1\n> line2') !== -1, 'multiline body blockquoted');
    });

    test('separates multiple comments with a blank line', function() {
        var content = contentOf(runWithComment({
            total: 2,
            comments: [
                { author: { displayName: 'A' }, created: '2024-01-15T10:00:00.000+0000', body: 'first' },
                { author: { displayName: 'B' }, created: '2024-01-16T10:00:00.000+0000', body: 'second' }
            ]
        }));
        assert.ok(content.indexOf('> first\n\n> **B**') !== -1, 'comments separated by blank line');
    });

    test('omits the comments section when the comments list is empty', function() {
        var content = contentOf(runWithComment({ total: 0, comments: [] }));
        assert.ok(content.indexOf('**Comments:**') === -1, 'empty comments omitted');
    });

    test('omits the comments section when comment field is absent', function() {
        var content = contentOf(runWithComment(null));
        assert.ok(content.indexOf('**Comments:**') === -1, 'missing comment field omitted');
    });

});

// ── Suite: child questions ────────────────────────────────────────────────────

suite('fetchParentContextToInput — child questions', function() {

    var CHILD_QUESTIONS_CFG = {
        jql: 'parent = {parentKey}',
        fields: ['key', 'summary', 'description', 'status'],
        contexts: [
            { prefix: '[BA]', file: 'ba.md', label: 'Business Analysis', description: 'BA desc' }
        ],
        childQuestions: {}
    };

    function makeQuestionMocks(opts) {
        opts = opts || {};
        var files = {};
        var readCalls = 0;
        var searchCalls = [];
        var mocks = {
            jira_get_ticket: function() {
                return { key: PARENT_KEY, fields: { summary: 'parent', status: { name: 'Done' } } };
            },
            jira_search_by_jql: function(q) {
                searchCalls.push(q.jql);
                if (q.jql.indexOf('PROJ-200') !== -1) {
                    if (opts.questionsThrow) throw new Error('question search failed');
                    return opts.questions || [];
                }
                return [makeSearchResult('PROJ-200', '[BA]')];
            },
            file_read: function(args) {
                readCalls++;
                if (opts.readThrows) throw new Error('read failed');
                return files[args.path] || '';
            },
            file_write: function(p, c) {
                if (opts.appendThrows && readCalls > 0) throw new Error('append failed');
                files[p] = c;
            }
        };
        return { mocks: mocks, files: files, searchCalls: searchCalls, readCount: function() { return readCalls; } };
    }

    function runChildQuestions(customQuestionsCfg, opts) {
        var ctx = makeQuestionMocks(opts);
        var cfg = Object.assign({}, CHILD_QUESTIONS_CFG, {
            childQuestions: customQuestionsCfg === undefined ? {} : customQuestionsCfg
        });
        var m = loadFetchParentContext(ctx.mocks);
        var threw = false;
        try {
            m.action(makeParams(cfg));
        } catch (e) {
            threw = true;
        }
        return { ctx: ctx, threw: threw };
    }

    test('appends a Questions & Answers section answered from the description', function() {
        var r = runChildQuestions(undefined, {
            questions: [
                { key: 'PROJ-300', fields: { summary: 'Why this?', description: 'Because reasons.' } },
                { key: 'PROJ-301', fields: { summary: 'And that?', description: 'Also reasons.' } }
            ]
        });
        assert.ok(!r.threw, 'action completed');
        var content = r.ctx.files[INPUT_FOLDER + '/ba.md'];
        assert.ok(content.indexOf('## Questions & Answers (PROJ-200)') !== -1, 'Q&A section appended');
        assert.ok(content.indexOf('**Q1: Why this?**') !== -1, 'first question numbered and titled');
        assert.ok(content.indexOf('**Q2: And that?**') !== -1, 'second question numbered and titled');
        assert.ok(content.indexOf('_Answer: Because reasons._') !== -1, 'first answer rendered');
        assert.ok(content.indexOf('_Answer: Also reasons._') !== -1, 'second answer rendered');
    });

    test('uses the default child-questions JQL with {contextTicketKey} replaced', function() {
        var r = runChildQuestions(undefined, {
            questions: [{ key: 'PROJ-300', fields: { summary: 'Q', description: 'A' } }]
        });
        var seen = false;
        for (var i = 0; i < r.ctx.searchCalls.length; i++) {
            if (r.ctx.searchCalls[i].indexOf('labels = Q') !== -1) {
                seen = true;
                assert.ok(r.ctx.searchCalls[i].indexOf('parent = PROJ-200') !== -1, 'placeholder replaced: ' + r.ctx.searchCalls[i]);
                assert.ok(r.ctx.searchCalls[i].indexOf('{contextTicketKey}') === -1, 'placeholder removed');
            }
        }
        assert.ok(seen, 'default question JQL issued');
    });

    test('honours a custom question JQL and answerField', function() {
        var r = runChildQuestions({
            jql: 'parent = {contextTicketKey} AND labels = Question',
            answerField: 'comment'
        }, {
            questions: [{ key: 'PROJ-300', fields: { summary: 'Q', comment: 'Resolved in chat' } }]
        });
        var content = r.ctx.files[INPUT_FOLDER + '/ba.md'];
        assert.ok(content.indexOf('_Answer: Resolved in chat_') !== -1, 'custom answerField used');
        var seen = false;
        for (var i = 0; i < r.ctx.searchCalls.length; i++) {
            if (r.ctx.searchCalls[i].indexOf('labels = Question') !== -1) {
                seen = true;
                assert.ok(r.ctx.searchCalls[i].indexOf('parent = PROJ-200') !== -1, 'custom JQL placeholder replaced');
            }
        }
        assert.ok(seen, 'custom question JQL issued');
    });

    test('falls back to the lowercase answer field name', function() {
        var r = runChildQuestions({ answerField: 'My Answer' }, {
            questions: [{ key: 'PROJ-300', fields: { summary: 'Q', 'my answer': 'lowercase hit' } }]
        });
        var content = r.ctx.files[INPUT_FOLDER + '/ba.md'];
        assert.ok(content.indexOf('_Answer: lowercase hit_') !== -1, 'lowercase fallback used');
    });

    test('marks unanswered questions explicitly', function() {
        var r = runChildQuestions(undefined, {
            questions: [{ key: 'PROJ-300', fields: { summary: 'Q' } }]
        });
        var content = r.ctx.files[INPUT_FOLDER + '/ba.md'];
        assert.ok(content.indexOf('_Answer: (not yet answered)_') !== -1, 'unanswered marker rendered');
    });

    test('does not duplicate the description when it equals the answer', function() {
        var r = runChildQuestions(undefined, {
            questions: [{ key: 'PROJ-300', fields: { summary: 'Q', description: 'same text' } }]
        });
        var content = r.ctx.files[INPUT_FOLDER + '/ba.md'];
        var first = content.indexOf('same text');
        var last = content.lastIndexOf('same text');
        assert.ok(first !== -1, 'answer present');
        assert.equal(first, last, 'description not duplicated');
    });

    test('does not append anything when the question search returns no results', function() {
        var r = runChildQuestions(undefined, { questions: [] });
        assert.ok(!r.threw, 'action completed');
        assert.equal(r.ctx.readCount(), 0, 'no file read without questions');
        var content = r.ctx.files[INPUT_FOLDER + '/ba.md'];
        assert.ok(content.indexOf('Questions & Answers') === -1, 'no Q&A section');
    });

    test('is non-fatal when the question search fails', function() {
        var r = runChildQuestions(undefined, { questionsThrow: true });
        assert.ok(!r.threw, 'question search failure is non-fatal');
        var content = r.ctx.files[INPUT_FOLDER + '/ba.md'];
        assert.ok(content.indexOf('**Ticket:** PROJ-200') !== -1, 'context file still written');
    });

    test('is non-fatal when appending to the context file fails', function() {
        var r = runChildQuestions(undefined, {
            appendThrows: true,
            questions: [{ key: 'PROJ-300', fields: { summary: 'Q', description: 'A' } }]
        });
        assert.ok(!r.threw, 'append failure is non-fatal');
    });

});

// ── Suite: remaining action branches ──────────────────────────────────────────

suite('fetchParentContextToInput — remaining branches', function() {

    test('skips the parent story file when includeParentStory is false', function() {
        var written = [];
        var m = loadFetchParentContext({
            jira_get_ticket: function() { throw new Error('parent story must not be fetched'); },
            jira_search_by_jql: function() { return [makeSearchResult('PROJ-200', '[BA]')]; },
            file_write: function(p, c) { written.push(p); }
        });
        var cfg = Object.assign({}, MINIMAL_PARENT_CONTEXT_FETCH, { includeParentStory: false });
        m.action(makeParams(cfg));
        assert.deepEqual(written, [INPUT_FOLDER + '/ba.md'], 'only the sibling file written');
    });

    test('derives the ticket key from the input folder when ticket is absent', function() {
        var fetchedKeys = [];
        var m = loadFetchParentContext({
            jira_get_ticket: function(args) {
                fetchedKeys.push(args.key);
                if (args.key === TICKET_KEY) {
                    return { key: TICKET_KEY, fields: { parent: { key: PARENT_KEY }, summary: '[SA] x', status: { name: 'Open' } } };
                }
                return { key: PARENT_KEY, fields: { summary: 'parent', status: { name: 'Done' } } };
            },
            jira_search_by_jql: function() { return []; },
            file_write: function() {}
        });
        var params = {
            inputFolderPath: INPUT_FOLDER,
            jobParams: { customParams: MINIMAL_PARENT_CONTEXT_FETCH }
        };
        var threw = false;
        try {
            m.action(params);
        } catch (e) {
            threw = true;
        }
        assert.ok(!threw, 'action completed without an explicit ticket');
        assert.deepEqual(fetchedKeys, [TICKET_KEY, PARENT_KEY], 'ticket then parent fetched by key');
    });

    test('resolves human field names to tracker codes when resolveFieldNames is set', function() {
        var capturedFields = null;
        var written = {};
        var m = loadFetchParentContext({
            jira_get_ticket: function(args) {
                if (args.key === PARENT_KEY) {
                    return { key: PARENT_KEY, fields: { summary: 'parent', status: { name: 'Done' } } };
                }
                return { key: 'PROJ-200', fields: { 'customfield_10101': 'architecture decision' } };
            },
            jira_get_field_custom_code: function(args) {
                if (args.fieldName === 'High-Level Design') return 'customfield_10101';
                return args.fieldName;
            },
            jira_search_by_jql: function(opts) {
                capturedFields = opts.fields;
                return [makeSearchResult('PROJ-200', '[BA]')];
            },
            file_write: function(p, c) { written[p] = c; }
        });
        var cfg = Object.assign({}, MINIMAL_PARENT_CONTEXT_FETCH, {
            fields: ['Description', 'High-Level Design'],
            resolveFieldNames: true
        });
        m.action(makeParams(cfg));
        assert.ok(capturedFields.indexOf('customfield_10101') !== -1, 'resolved code passed to search');
        var content = written[INPUT_FOLDER + '/ba.md'];
        assert.ok(content.indexOf('**High-Level Design:**\n\narchitecture decision') !== -1, 'resolved field rendered with original name as label');
    });

    test('prefers siblingFields over fields when both are configured', function() {
        var capturedFields = null;
        var m = loadFetchParentContext({
            jira_get_ticket: function() {
                return { key: PARENT_KEY, fields: { summary: 'parent', status: { name: 'Done' } } };
            },
            jira_search_by_jql: function(opts) { capturedFields = opts.fields; return []; },
            file_write: function() {}
        });
        var cfg = Object.assign({}, MINIMAL_PARENT_CONTEXT_FETCH, {
            fields: ['description'],
            siblingFields: ['High-Level Solution']
        });
        m.action(makeParams(cfg));
        assert.ok(capturedFields.indexOf('High-Level Solution') !== -1, 'siblingFields used');
        assert.ok(capturedFields.indexOf('description') === -1, 'fields ignored when siblingFields present');
    });

    test('uses cfg.fieldLabels for field display names', function() {
        var written = {};
        var m = loadFetchParentContext({
            jira_get_ticket: function() {
                return { key: PARENT_KEY, fields: { summary: 'parent', status: { name: 'Done' } } };
            },
            jira_search_by_jql: function() { return [makeSearchResult('PROJ-200', '[BA]')]; },
            file_write: function(p, c) { written[p] = c; }
        });
        var cfg = Object.assign({}, MINIMAL_PARENT_CONTEXT_FETCH, { fieldLabels: { description: 'Details' } });
        m.action(makeParams(cfg));
        assert.ok(written[INPUT_FOLDER + '/ba.md'].indexOf('**Details:**') !== -1, 'custom label used');
    });

    test('does nothing when customParams.enabled is false', function() {
        var m = loadFetchParentContext({
            jira_get_ticket: function() { throw new Error('should not be called'); },
            jira_search_by_jql: function() { throw new Error('should not be called'); },
            file_write: function() { throw new Error('should not be called'); }
        });
        var threw = false;
        try {
            m.action(makeParams({ enabled: false, parentContextFetch: MINIMAL_PARENT_CONTEXT_FETCH }));
        } catch (e) {
            threw = true;
        }
        assert.ok(!threw, 'enabled:false is a clean no-op');
    });

    test('keeps partial data when the full-ticket re-fetch fails', function() {
        var written = {};
        var getCalls = 0;
        var m = loadFetchParentContext({
            jira_get_ticket: function(args) {
                getCalls++;
                if (args.key === PARENT_KEY) {
                    return { key: PARENT_KEY, fields: { summary: 'parent', status: { name: 'Done' } } };
                }
                throw new Error('re-fetch failed');
            },
            jira_search_by_jql: function() { return [makeSearchResult('PROJ-200', '[BA]')]; },
            file_write: function(p, c) { written[p] = c; }
        });
        var cfg = Object.assign({}, MINIMAL_PARENT_CONTEXT_FETCH, { fields: ['High-Level Design'] });
        m.action(makeParams(cfg));
        assert.ok(getCalls > 1, 're-fetch was attempted');
        assert.ok(written[INPUT_FOLDER + '/ba.md'].indexOf('**Ticket:** PROJ-200') !== -1, 'file written from partial data');
    });

    test('renders object-valued fields as pretty JSON', function() {
        var written = {};
        var m = loadFetchParentContext({
            jira_get_ticket: function() {
                return { key: PARENT_KEY, fields: { summary: 'parent', status: { name: 'Done' } } };
            },
            jira_search_by_jql: function() {
                return [makeSearchResult('PROJ-200', '[BA]', { components: [{ name: 'web' }] })];
            },
            file_write: function(p, c) { written[p] = c; }
        });
        var cfg = Object.assign({}, MINIMAL_PARENT_CONTEXT_FETCH, { fields: ['components'] });
        m.action(makeParams(cfg));
        assert.ok(written[INPUT_FOLDER + '/ba.md'].indexOf('**components:**\n\n[\n  {\n    "name": "web"\n  }\n]') !== -1, 'object rendered as JSON');
    });

    test('extracts the display label from a dmtools key (Label (customfield_xxx))', function() {
        var written = {};
        var m = loadFetchParentContext({
            jira_get_ticket: function() {
                return { key: PARENT_KEY, fields: { summary: 'parent', status: { name: 'Done' } } };
            },
            jira_search_by_jql: function() {
                return [makeSearchResult('PROJ-200', '[BA]', { 'Acceptance Criteria (customfield_10200)': 'AC text' })];
            },
            file_write: function(p, c) { written[p] = c; }
        });
        var cfg = Object.assign({}, MINIMAL_PARENT_CONTEXT_FETCH, { fields: ['Acceptance Criteria (customfield_10200)'] });
        m.action(makeParams(cfg));
        assert.ok(written[INPUT_FOLDER + '/ba.md'].indexOf('**Acceptance Criteria:**\n\nAC text') !== -1, 'label extracted from key');
    });

    test('continues with siblings when the parent story has empty fields', function() {
        var written = [];
        var m = loadFetchParentContext({
            jira_get_ticket: function() { return 'parent not found'; },
            jira_search_by_jql: function() { return [makeSearchResult('PROJ-200', '[BA]')]; },
            file_write: function(p, c) { written.push(p); }
        });
        var threw = false;
        try {
            m.action(makeParams(MINIMAL_PARENT_CONTEXT_FETCH));
        } catch (e) {
            threw = true;
        }
        assert.ok(!threw, 'empty parent fields are non-fatal');
        assert.deepEqual(written, [INPUT_FOLDER + '/ba.md'], 'sibling file written without parent story');
    });

});
