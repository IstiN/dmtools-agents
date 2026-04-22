/**
 * Unit tests for agents/js/fetchParentContextToInput.js
 *
 * Tests: no-op guard, parent resolution, JQL placeholder, context matching,
 *        file writing, re-fetch fallback, error resilience.
 *
 * Uses: loadModule(), makeRequire(), assert, test(), suite()
 */

// ── Loader helper ─────────────────────────────────────────────────────────────

function loadFetchParentContext(mocks) {
    return loadModule(
        'agents/js/fetchParentContextToInput.js',
        makeRequire({}),
        mocks || {}
    );
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

var PARENT_KEY = 'MAPC-100';
var TICKET_KEY = 'MAPC-101';
var INPUT_FOLDER = 'input/MAPC-101';

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
                return [makeSearchResult('MAPC-200', '[BA]')];
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
                return [makeSearchResult('MAPC-201', '[SA]')];
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
                    makeSearchResult('MAPC-200', '[BA]'),
                    makeSearchResult('MAPC-201', '[SA]')
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
                return [makeSearchResult('MAPC-200', '[ba]')]; // lowercase
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
                return [makeSearchResult('MAPC-202', '[QA]')]; // no QA context configured
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
                return [makeSearchResult('MAPC-200', '[BA]')];
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
                return [makeSearchResult('MAPC-200', '[BA]', { description: 'AC1: user can login' })];
            },
            file_write: function(p, c) { writtenContent = c; }
        });
        m.action(makeParams(MINIMAL_PARENT_CONTEXT_FETCH));
        assert.ok(writtenContent !== null, 'content was written');
        assert.ok(writtenContent.indexOf('MAPC-200') !== -1, 'ticket key in content');
        assert.ok(writtenContent.indexOf('Business Analysis') !== -1, 'label in content');
    });

    test('description content appears in written file', function() {
        var writtenContent = null;
        var m = loadFetchParentContext({
            jira_search_by_jql: function() {
                return [makeSearchResult('MAPC-200', '[BA]', { description: 'AC1: user can login' })];
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
                return [makeSearchResult('MAPC-200', '[BA]')];
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
                return [{ key: 'MAPC-200', fields: { summary: '[BA] Title', status: { name: 'Done' } } }];
            },
            jira_get_ticket: function(opts) {
                refetchedKeys.push(opts.key);
                return {
                    key: 'MAPC-200',
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
        assert.ok(refetchedKeys.indexOf('MAPC-200') !== -1, 're-fetch was triggered for MAPC-200');
    });

    test('re-fetched field content appears in output file', function() {
        var writtenContent = null;
        var m = loadFetchParentContext({
            jira_search_by_jql: function() {
                return [{ key: 'MAPC-200', fields: { summary: '[BA] Title', status: { name: 'Done' } } }];
            },
            jira_get_ticket: function() {
                return {
                    key: 'MAPC-200',
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
                return [makeSearchResult('MAPC-200', '[BA]')];
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
                    makeSearchResult('MAPC-200', '[BA]'),
                    makeSearchResult('MAPC-201', '[SA]')
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
