/**
 * Unit tests for js/prepareDiscoveryContext.js.
 */

function loadPrepareDiscoveryContext(mocks, discoveryConfig) {
    var defaults = {
        confluence_get_children_by_id: function() { return []; },
        confluence_content_by_id: function() { return { body: { storage: { value: '' } } }; },
        confluence_get_page_inline_comments: function() { return '{}'; },
        file_write: function() {}
    };

    var configLoaderMock = {
        loadProjectConfig: function() {
            return { discovery: discoveryConfig || {} };
        }
    };
    var globals = Object.assign({}, defaults, mocks || {});

    return loadModule(
        'js/prepareDiscoveryContext.js',
        makeRequire({
            './configLoader.js': configLoaderMock,
            './common/contentOutput.js': loadModule('js/common/contentOutput.js',
                makeRequire({ '../configLoader.js': { loadProjectConfig: function() { return {}; } }, './trackers.js': trackersMock() }),
                globals)
        }),
        globals
    );
}

function makeParams(overrides) {
    return Object.assign({
        inputFolderPath: 'input/PROJ-2',
        ticket: { key: 'PROJ-2' },
        jobParams: {}
    }, overrides || {});
}

suite('prepareDiscoveryContext', function() {

    test('not configured — writes meta with nulls and does not query Confluence', function() {
        var queried = false;
        var writes = {};
        var mod = loadPrepareDiscoveryContext({
            confluence_get_children_by_id: function() { queried = true; return []; },
            file_write: function(p, c) { writes[p] = c; }
        }, {});

        var result = mod.action(makeParams());

        assert.equal(result.action, 'not_configured');
        assert.equal(queried, false, 'should not query Confluence when not configured');
        var meta = JSON.parse(writes['input/PROJ-2/discovery_meta.json']);
        assert.equal(meta.space, null);
        assert.equal(meta.parentPageId, null);
        assert.equal(meta.existingPageId, null);
    });

    test('first run — no existing page found for ticket key', function() {
        var writes = {};
        var mod = loadPrepareDiscoveryContext({
            confluence_get_children_by_id: function() {
                return [{ id: '999', title: 'OTHER-1 Unrelated ticket' }];
            },
            file_write: function(p, c) { writes[p] = c; }
        }, { space: 'DISC', parentPageId: '123' });

        var result = mod.action(makeParams());

        assert.equal(result.action, 'first_run');
        var meta = JSON.parse(writes['input/PROJ-2/discovery_meta.json']);
        assert.equal(meta.space, 'DISC');
        assert.equal(meta.parentPageId, '123');
        assert.equal(meta.existingPageId, null);
    });

    test('iteration — existing page found, seeds outputs/discovery/ with root + children content', function() {
        var writes = {};
        var mod = loadPrepareDiscoveryContext({
            confluence_get_children_by_id: function(args) {
                if (args.contentId === '123') {
                    return [{ id: '456', title: 'PROJ-2 Some feature' }];
                }
                if (args.contentId === '456') {
                    return [
                        { id: '457', title: 'PRD', body: { storage: { value: '# PRD\ncontent' } } }
                    ];
                }
                return [];
            },
            confluence_content_by_id: function(args) {
                assert.equal(args.contentId, '456');
                return { body: { storage: { value: '# Index\nlanding page' } } };
            },
            file_write: function(p, c) { writes[p] = c; }
        }, { space: 'DISC', parentPageId: '123' });

        var result = mod.action(makeParams());

        assert.equal(result.action, 'iteration');
        assert.equal(result.existingPageId, '456');
        assert.equal(result.snapshottedPages, 1);
        assert.equal(writes['outputs/discovery/index.md'], '# Index\nlanding page');
        assert.equal(writes['outputs/discovery/PRD.md'], '# PRD\ncontent');

        var meta = JSON.parse(writes['input/PROJ-2/discovery_meta.json']);
        assert.equal(meta.existingPageId, '456');
    });

    test('iteration — recursively seeds a MULTI-LEVEL tree (grandchildren into a subfolder)', function() {
        // Mirrors a real, mature discovery page tree that has grown nested
        // sub-trees over time: root -> "Topic Area" (a child with its OWN
        // children) -> "Detail Page" (a leaf grandchild), alongside a plain
        // leaf child ("PRD"). Before the recursive fix, only the direct
        // children (root's own level) were snapshotted, silently dropping
        // "Detail Page" from the seeded outputs/discovery/ tree.
        var writes = {};
        var mod = loadPrepareDiscoveryContext({
            confluence_content_by_id: function(args) {
                if (args.contentId === '456') return { body: { storage: { value: '# Index\nroot body' } } };
                if (args.contentId === '500') return { body: { storage: { value: '# Topic Area\nintro' } } };
                return { body: { storage: { value: '' } } };
            },
            confluence_get_children_by_id: function(args) {
                if (args.contentId === '123') {
                    return [{ id: '456', title: 'PROJ-2 Some feature' }];
                }
                if (args.contentId === '456') {
                    return [
                        { id: '457', title: 'PRD', body: { storage: { value: '# PRD\ncontent' } } },
                        { id: '500', title: 'Topic Area' }
                    ];
                }
                if (args.contentId === '500') {
                    return [
                        { id: '501', title: 'Detail Page', body: { storage: { value: '# Detail Page\nnested content' } } }
                    ];
                }
                return [];
            },
            file_write: function(p, c) { writes[p] = c; }
        }, { space: 'DISC', parentPageId: '123' });

        var result = mod.action(makeParams());

        assert.equal(result.action, 'iteration');
        // 3 descendants total: PRD (leaf), Topic Area (branch), Detail Page (leaf grandchild)
        assert.equal(result.snapshottedPages, 3);
        assert.equal(writes['outputs/discovery/index.md'], '# Index\nroot body');
        assert.equal(writes['outputs/discovery/PRD.md'], '# PRD\ncontent');
        // The branch child becomes a SUBFOLDER with its own index.md ...
        assert.equal(writes['outputs/discovery/Topic Area/index.md'], '# Topic Area\nintro');
        // ... and its own child becomes a leaf file inside that subfolder.
        assert.equal(writes['outputs/discovery/Topic Area/Detail Page.md'], '# Detail Page\nnested content');
    });

    test('iteration — collects inline comments across the whole tree into discovery_comments.md/json', function() {
        var writes = {};
        var mod = loadPrepareDiscoveryContext({
            confluence_get_children_by_id: function(args) {
                if (args.contentId === '123') {
                    return [{ id: '456', title: 'PROJ-2 Some feature' }];
                }
                if (args.contentId === '456') {
                    return [{ id: '457', title: 'PRD', body: { storage: { value: '# PRD\ncontent' } } }];
                }
                return [];
            },
            confluence_content_by_id: function(args) {
                return { body: { storage: { value: '' } } };
            },
            confluence_get_page_inline_comments: function(args) {
                if (args.pageId === '456') {
                    return JSON.stringify({ results: [{ id: 'c1', resolutionStatus: 'open', body: 'Root comment' }] });
                }
                if (args.pageId === '457') {
                    return JSON.stringify({ results: [{ id: 'c2', resolutionStatus: 'open', body: 'PRD comment' }] });
                }
                return '{}';
            },
            file_write: function(p, c) { writes[p] = c; }
        }, { space: 'DISC', parentPageId: '123' });

        var result = mod.action(makeParams());

        assert.equal(result.action, 'iteration');
        assert.equal(result.commentsCount, 2);
        var commentsJson = JSON.parse(writes['input/PROJ-2/discovery_comments.json']);
        assert.equal(commentsJson.comments.length, 2);
        assert.equal(commentsJson.comments[0].pageId, '456');
        assert.equal(commentsJson.comments[0].commentId, 'c1');
        assert.equal(commentsJson.comments[1].pageId, '457');
        assert.equal(commentsJson.comments[1].commentId, 'c2');
        assert.contains(writes['input/PROJ-2/discovery_comments.md'], 'Root comment');
        assert.contains(writes['input/PROJ-2/discovery_comments.md'], 'PRD comment');
    });

    test('iteration — no comments anywhere in the tree does not write discovery_comments files', function() {
        var writes = {};
        var mod = loadPrepareDiscoveryContext({
            confluence_get_children_by_id: function(args) {
                if (args.contentId === '123') return [{ id: '456', title: 'PROJ-2 Some feature' }];
                return [];
            },
            confluence_get_page_inline_comments: function() { return '{}'; },
            file_write: function(p, c) { writes[p] = c; }
        }, { space: 'DISC', parentPageId: '123' });

        mod.action(makeParams());

        assert.equal(writes['input/PROJ-2/discovery_comments.json'], undefined);
        assert.equal(writes['input/PROJ-2/discovery_comments.md'], undefined);
    });

    test('iteration — inline comment anchors are re-exposed as [[ic:REF]] placeholders in the snapshotted body', function() {
        var writes = {};
        var REF = 'a40ec14d-0d73-4f55-9a69-7026900b6623';
        var mod = loadPrepareDiscoveryContext({
            confluence_get_children_by_id: function(args) {
                if (args.contentId === '123') return [{ id: '456', title: 'PROJ-2 Some feature' }];
                return [];
            },
            confluence_content_by_id: function(args) {
                // First call (format:'md') returns the Markdown body; the second,
                // format-less call (from injectCommentAnchors) returns the storage
                // XML carrying the actual marker.
                if (args.format === 'md') {
                    return { body: { storage: { value: '# Index\nSome important text here.' } } };
                }
                return { body: { storage: { value: '<p>Some <ac:inline-comment-marker ac:ref="' + REF + '">important text</ac:inline-comment-marker> here.</p>' } } };
            },
            file_write: function(p, c) { writes[p] = c; }
        }, { space: 'DISC', parentPageId: '123' });

        mod.action(makeParams());

        assert.contains(writes['outputs/discovery/index.md'], '[[ic:' + REF + ']]important text[[/ic]]');
    });

    test('ticket-key prefix matching ignores tickets with the key as a substring elsewhere', function() {
        var writes = {};
        var mod = loadPrepareDiscoveryContext({
            confluence_get_children_by_id: function() {
                return [{ id: '999', title: 'Something mentions PROJ-2 but is not it' }];
            },
            file_write: function(p, c) { writes[p] = c; }
        }, { space: 'DISC', parentPageId: '123' });

        var result = mod.action(makeParams());

        assert.equal(result.action, 'first_run');
    });

    test('children lookup failure is resilient — returns failure without throwing', function() {
        var writes = {};
        var mod = loadPrepareDiscoveryContext({
            confluence_get_children_by_id: function() { throw new Error('Confluence unavailable'); },
            file_write: function(p, c) { writes[p] = c; }
        }, { space: 'DISC', parentPageId: '123' });

        var result = mod.action(makeParams());

        assert.equal(result.success, false);
        assert.equal(result.action, 'children_lookup_failed');
        assert.contains(writes['input/PROJ-2/discovery_meta.json'], '"space": "DISC"');
    });

});

// ── gh-1187 CRAP split: characterization tests for the extracted helpers ────

// Loader variant with an injectable configLoader mock (the default loader
// hardcodes a working one; the config-failure tests need a throwing one).
function loadPrepareDiscoveryContextWithConfigLoader(configLoaderMock, globals) {
    var defaults = {
        confluence_get_children_by_id: function() { return []; },
        confluence_content_by_id: function() { return { body: { storage: { value: '' } } }; },
        confluence_get_page_inline_comments: function() { return '{}'; },
        file_write: function() {}
    };
    var g = Object.assign({}, defaults, globals || {});
    return loadModule(
        'js/prepareDiscoveryContext.js',
        makeRequire({
            './configLoader.js': configLoaderMock,
            './common/contentOutput.js': loadModule('js/common/contentOutput.js',
                makeRequire({ '../configLoader.js': { loadProjectConfig: function() { return {}; } }, './trackers.js': trackersMock() }),
                g)
        }),
        g
    );
}

suite('prepareDiscoveryContext — gh-1187 extracted helpers', function() {

    test('resolveTicketKey: params.ticket.key wins over the folder name', function() {
        var mod = loadPrepareDiscoveryContext({});
        assert.equal(mod.resolveTicketKey({ ticket: { key: 'PROJ-9' }, inputFolderPath: 'input/PROJ-2' }, 'input/PROJ-2'), 'PROJ-9');
    });

    test('resolveTicketKey: falls back to the trailing inputFolderPath segment', function() {
        var mod = loadPrepareDiscoveryContext({});
        assert.equal(mod.resolveTicketKey({ inputFolderPath: 'input/PROJ-5' }, 'input/PROJ-5'), 'PROJ-5');
    });

    test('resolveTicketKey: null when neither ticket nor folder is present', function() {
        var mod = loadPrepareDiscoveryContext({});
        assert.equal(mod.resolveTicketKey({}, null), null);
    });

    test('action without params.ticket derives the ticket key from inputFolderPath', function() {
        var writes = {};
        var mod = loadPrepareDiscoveryContext({
            file_write: function(p, c) { writes[p] = c; }
        }, {});

        var result = mod.action({ inputFolderPath: 'input/PROJ-5', jobParams: {} });

        assert.equal(result.action, 'not_configured');
        var meta = JSON.parse(writes['input/PROJ-5/discovery_meta.json']);
        assert.equal(meta.ticketKey, 'PROJ-5');
    });

    test('applyDiscoveryConfig: fills meta from project config and reports unconfigured state', function() {
        var mod = loadPrepareDiscoveryContext({});
        var meta = { ticketKey: 'PROJ-2', space: null, parentPageId: null, existingPageId: null };

        assert.equal(mod.applyDiscoveryConfig(meta, { jobParams: {} }), true, 'unconfigured → true');
        assert.equal(meta.space, null);

        var meta2 = { ticketKey: 'PROJ-2', space: null, parentPageId: null, existingPageId: null };
        var configuredMod = loadPrepareDiscoveryContext({}, { space: 'DISC', parentPageId: '123' });
        assert.equal(configuredMod.applyDiscoveryConfig(meta2, { jobParams: {} }), false, 'configured → false');
        assert.equal(meta2.space, 'DISC');
        assert.equal(meta2.parentPageId, '123');
    });

    test('fetchParentChildren: returns the children payload on success', function() {
        var mod = loadPrepareDiscoveryContext({
            confluence_get_children_by_id: function() { return [{ id: '456', title: 'PROJ-2 x' }]; }
        }, { space: 'DISC', parentPageId: '123' });

        var fetched = mod.fetchParentChildren('123');
        assert.equal(fetched.error, undefined);
        assert.equal(fetched.children.length, 1);
    });

    test('fetchParentChildren: returns an error marker on failure', function() {
        var mod = loadPrepareDiscoveryContext({
            confluence_get_children_by_id: function() { throw new Error('confluence down'); }
        }, { space: 'DISC', parentPageId: '123' });

        var fetched = mod.fetchParentChildren('123');
        assert.contains(fetched.error, 'confluence down');
    });

    test('writeCollectedComments: skipped when the folder is missing or there are no comments', function() {
        var writes = {};
        var mod = loadPrepareDiscoveryContext({
            file_write: function(p, c) { writes[p] = c; }
        }, { space: 'DISC', parentPageId: '123' });

        mod.writeCollectedComments(null, [{ pageId: '1' }], 'PROJ-2', 0);
        mod.writeCollectedComments('input/PROJ-2', [], 'PROJ-2', 0);
        assert.deepEqual(Object.keys(writes), []);
    });

    test('writeCollectedComments: writes the comments files and logs the page count', function() {
        var writes = {};
        var mod = loadPrepareDiscoveryContext({
            file_write: function(p, c) { writes[p] = c; }
        }, { space: 'DISC', parentPageId: '123' });

        mod.writeCollectedComments('input/PROJ-2', [
            { pageId: '456', commentId: 'c1', body: 'Root comment' }
        ], 'PROJ-2', 2);

        var commentsJson = JSON.parse(writes['input/PROJ-2/discovery_comments.json']);
        assert.equal(commentsJson.comments.length, 1);
        assert.equal(commentsJson.comments[0].commentId, 'c1');
    });

    test('writeDiscoveryMeta / writeDiscoveryMetaQuietly: quiet variant swallows write failures', function() {
        var mod = loadPrepareDiscoveryContext({
            file_write: function() { throw new Error('disk full'); }
        }, {});

        var meta = { ticketKey: 'PROJ-2', space: null, parentPageId: null, existingPageId: null };
        var errors = [];
        var origError = console.error;
        console.error = function(m) { errors.push(m); };
        try {
            mod.writeDiscoveryMetaQuietly('input/PROJ-2', meta);
        } finally {
            console.error = origError;
        }
        assert.equal(errors.length, 1);
        assert.contains(errors[0], 'discovery_meta.json');
    });

    test('project config load failure — error result, meta still written', function() {
        var writes = {};
        var mod = loadPrepareDiscoveryContextWithConfigLoader({
            loadProjectConfig: function() { throw new Error('cfg boom'); }
        }, {
            file_write: function(p, c) { writes[p] = c; }
        });

        var result = mod.action(makeParams());

        assert.equal(result.success, false);
        assert.equal(result.action, 'error');
        assert.contains(result.error, 'cfg boom');
        var meta = JSON.parse(writes['input/PROJ-2/discovery_meta.json']);
        assert.equal(meta.ticketKey, 'PROJ-2');
        assert.equal(meta.space, null);
    });

    test('meta write failure on the error path is logged, not thrown', function() {
        var errors = [];
        var origError = console.error;
        console.error = function(m) { errors.push(m); };
        var mod = loadPrepareDiscoveryContextWithConfigLoader({
            loadProjectConfig: function() { throw new Error('cfg boom'); }
        }, {
            file_write: function() { throw new Error('disk full'); }
        });
        try {
            var result = mod.action(makeParams());
        } finally {
            console.error = origError;
        }
        assert.equal(result.success, false);
        assert.equal(result.action, 'error');
        var alsoFailed = errors.filter(function(m) { return String(m).indexOf('Also failed') !== -1; });
        assert.equal(alsoFailed.length, 1, 'quiet meta-write failure logged once');
    });

});

// ── snapshotPageTree failure paths (gh-1228 CRAP characterization) ──────────

suite('prepareDiscoveryContext — snapshotPageTree failure paths', function() {

    function treeModule(mocks) {
        return loadPrepareDiscoveryContext(Object.assign({
            confluence_get_children_by_id: function() { return []; },
            confluence_content_by_id: function() { return { body: { storage: { value: '# Root' } } }; },
            confluence_get_page_inline_comments: function() { return '{}'; },
            file_write: function() {}
        }, mocks || {}), { space: 'DISC', parentPageId: '123' });
    }

    test('root body fetch failure snapshots nothing and returns 0 (non-fatal)', function() {
        var writes = {};
        var mod = treeModule({
            confluence_content_by_id: function() { throw new Error('confluence down'); },
            file_write: function(p, c) { writes[p] = c; }
        });

        var total = mod.snapshotPageTree({ id: '456', title: 'PROJ-2 root' }, 'outputs/discovery', []);

        assert.equal(total, 0, 'nothing counted when the root fetch fails');
        assert.equal(Object.keys(writes).length, 0, 'no files written');
    });

    test('grandchild lookup failure degrades the child to a leaf file', function() {
        var writes = {};
        var mod = treeModule({
            confluence_get_children_by_id: function(args) {
                if (args.contentId === 'root') {
                    return [{ id: '457', title: 'PRD', body: { storage: { value: '# PRD\ncontent' } } }];
                }
                if (args.contentId === '457') { throw new Error('child lookup down'); }
                return [];
            },
            file_write: function(p, c) { writes[p] = c; }
        });

        var total = mod.snapshotPageTree({ id: 'root', title: 'PROJ-2 root' }, 'outputs/discovery', []);

        assert.equal(total, 1, 'the child still counted');
        assert.equal(writes['outputs/discovery/PRD.md'], '# PRD\ncontent', 'child body written as a leaf file');
    });

    test('inline comment fetch failure for one page does not stop the snapshot', function() {
        var writes = {};
        var mod = treeModule({
            confluence_get_children_by_id: function(args) {
                if (args.contentId === 'root') {
                    return [{ id: '457', title: 'PRD', body: { storage: { value: '# PRD\ncontent' } } }];
                }
                return [];
            },
            confluence_get_page_inline_comments: function(args) {
                if (args.pageId === '457') { throw new Error('comments down'); }
                return '{}';
            },
            file_write: function(p, c) { writes[p] = c; }
        });

        var total = mod.snapshotPageTree({ id: 'root', title: 'PROJ-2 root' }, 'outputs/discovery', []);

        assert.equal(total, 1, 'snapshot completed');
        assert.equal(writes['outputs/discovery/PRD.md'], '# PRD\ncontent', 'child file written');
        assert.equal(writes['outputs/discovery/index.md'], '# Root', 'root file written');
    });

    test('page body without comment anchors is written unchanged', function() {
        var writes = {};
        var mod = treeModule({
            confluence_content_by_id: function() {
                return { body: { storage: { value: '# Root\nplain body, no markers' } } };
            },
            file_write: function(p, c) { writes[p] = c; }
        });

        var total = mod.snapshotPageTree({ id: 'root', title: 'PROJ-2 root' }, 'outputs/discovery', []);

        assert.equal(total, 0, 'no descendants');
        assert.equal(writes['outputs/discovery/index.md'], '# Root\nplain body, no markers', 'body written unchanged');
    });

    test('empty root body falls back to the placeholder text', function() {
        var writes = {};
        var mod = treeModule({
            confluence_content_by_id: function() { return { body: { storage: { value: '' } } }; },
            file_write: function(p, c) { writes[p] = c; }
        });

        mod.snapshotPageTree({ id: 'root', title: 'PROJ-2 root' }, 'outputs/discovery', []);

        assert.equal(writes['outputs/discovery/index.md'], '_(existing page had no body)_', 'placeholder written');
    });
});
