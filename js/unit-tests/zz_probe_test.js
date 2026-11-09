var harnessExpr = null;
suite('probe action', function() {
    test('action probe', function() {
        // reuse the exact loader of the failing test via copy
        var commentMarkupModule = loadModule('js/common/commentMarkup.js',
            makeRequire({ './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') }));
        var fileMap = {
            'input/PROJ-1/pr_info.md': '- **PR #**: 42\n- **URL**: https://github.com/IstiN/dmtools-agents/pull/42\n- **Branch**: bug/PROJ-1\n',
            'outputs/pr_review.json': JSON.stringify({
                recommendation: 'APPROVE',
                issueCounts: { blocking: 0, important: 1, suggestions: 0, nits: 0, digest: 0 },
                inlineComments: [{ path: 'a.js', line: 10, severity: 'IMPORTANT', body: 'overstated claim' }],
                generalComment: 'outputs/pr_review_general.md'
            }),
            'outputs/pr_review_general.md': '## General review\n',
            'outputs/pr_review_filter.json': JSON.stringify({ verdicts: [
                { id: 0, decision: 'drop', reason: 'verified wrong' }
            ] })
        };
        function mapFileRead(fm) {
            return function (args) {
                var p = args && (args.path || args);
                if (fm[p] !== undefined) return fm[p];
                if (p && p.indexOf('.dmtools/config') !== -1) return null;
                return null;
            };
        }
        var fileRead = mapFileRead(fileMap);
        var writes = [];
        var cliCalls = [];
        var mod = loadModule('js/postPRReviewComments.js',
            makeRequire({
                './common/ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js'),
                './common/machineAuthor.js': loadModule('js/common/machineAuthor.js', makeRequire({}), {}),
                './common/prTerminalState.js': loadModule('js/common/prTerminalState.js'),
                './config.js': loadModule('js/config.js', makeRequire({
                    './common/ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js')
                }), {}),
                './common/scm.js': { createScm: function() { return {
                    listPrs: function() { return []; },
                    getRemoteRepoInfo: function() { return { owner: 'IstiN', repo: 'dmtools-agents' }; },
                    addLabel: function() {}, removeLabel: function() {},
                    fetchDiscussions: function() { return { rawThreads: { threads: [] } }; },
                    addComment: function(id, body) { console.log('ADD-COMMENT: ' + String(body).substring(0, 80)); },
                    addInlineComment: function() { console.log('ADD-INLINE'); }
                }; } },
                './common/autoStart.js': { triggerConfiguredWorkflowForTicket: function() { return false; }, triggerSmIfIdle: function() {} },
                './configLoader.js': { loadProjectConfig: function() { return {}; }, resolveInstructions: function() { return { jobParamPatch: {} }; } },
                './common/outputFiles.js': loadModule('js/common/outputFiles.js', makeRequire({
                    './common/commentMarkup.js': commentMarkupModule
                }), { file_read: fileRead }),
                './common/githubHelpers.js': { findPRForTicket: function() { return null; }, findMergedPRForTicket: function() { return null; } },
                './common/trackers.js': { createTracker: function() { return {
                    postComment: function(k, c) { console.log('JIRA-COMMENT: ' + String(c).substring(0, 120)); },
                    addLabel: function() {}, removeLabel: function() {}, moveToStatusOrMark: function() { return { moved: false, label: 'x' }; },
                    assignTo: function() {}
                }; } },
                './common/tokenUsageComment.js': { postTokenUsageComments: function() {} },
                './common/commentMarkup.js': commentMarkupModule,
                './common/reviewVerdicts.js': loadModule('js/common/reviewVerdicts.js', makeRequire({ './machineAuthor.js': loadModule('js/common/machineAuthor.js', makeRequire({}), {}) }), {}),
                './common/reviewPolicy.js': loadModule('js/common/reviewPolicy.js', makeRequire({
                    './reviewVerdicts.js': loadModule('js/common/reviewVerdicts.js', makeRequire({ './machineAuthor.js': loadModule('js/common/machineAuthor.js', makeRequire({}), {}) }), {})
                }), {}),
                './common/findingRegistry.js': loadModule('js/common/findingRegistry.js', makeRequire({
                    './machineAuthor.js': loadModule('js/common/machineAuthor.js', makeRequire({}), {}),
                    './reviewVerdicts.js': loadModule('js/common/reviewVerdicts.js', makeRequire({ './machineAuthor.js': loadModule('js/common/machineAuthor.js', makeRequire({}), {}) }), {})
                }), {}),
                './common/reviewSpecClaims.js': loadModule('js/common/reviewSpecClaims.js', makeRequire({
                    './findingRegistry.js': loadModule('js/common/findingRegistry.js', makeRequire({
                        './machineAuthor.js': loadModule('js/common/machineAuthor.js', makeRequire({}), {}),
                        './reviewVerdicts.js': loadModule('js/common/reviewVerdicts.js', makeRequire({ './machineAuthor.js': loadModule('js/common/machineAuthor.js', makeRequire({}), {}) }), {})
                    }), {})
                }), {}),
                './common/reviewFilter.js': loadModule('js/common/reviewFilter.js', makeRequire({
                    './reviewPolicy.js': loadModule('js/common/reviewPolicy.js', makeRequire({
                        './reviewVerdicts.js': loadModule('js/common/reviewVerdicts.js', makeRequire({ './machineAuthor.js': loadModule('js/common/machineAuthor.js', makeRequire({}), {}) }), {})
                    }), {}),
                    './reviewVerdicts.js': loadModule('js/common/reviewVerdicts.js', makeRequire({ './machineAuthor.js': loadModule('js/common/machineAuthor.js', makeRequire({}), {}) }), {}),
                    './reviewSpecClaims.js': loadModule('js/common/reviewSpecClaims.js', makeRequire({
                        './findingRegistry.js': loadModule('js/common/findingRegistry.js', makeRequire({
                            './machineAuthor.js': loadModule('js/common/machineAuthor.js', makeRequire({}), {}),
                            './reviewVerdicts.js': loadModule('js/common/reviewVerdicts.js', makeRequire({ './machineAuthor.js': loadModule('js/common/machineAuthor.js', makeRequire({}), {}) }), {})
                        }), {})
                    }), {})
                }), {}),
                './postStoryTestAutomationReviewHelpers.js': loadModule('js/postStoryTestAutomationReviewHelpers.js')
            }),
            {
                file_read: fileRead,
                file_write: function(a, b) { writes.push(typeof a === 'string' ? { path: a, content: b } : a); },
                cli_execute_command: function(args) { cliCalls.push(args); return 'filter cli ok'; },
                jira_add_label: function() {}, jira_move_to_status: function() {},
                jira_post_comment: function(args) { console.log('JIRA-TOOL: ' + String(args.comment).substring(0, 120)); },
                jira_remove_label: function() {}, jira_assign_ticket_to: function() {}
            });
        var result = mod.action({
            ticket: { key: 'PROJ-1', fields: { labels: [] } },
            response: 'Jira review content',
            inputFolderPath: 'input/PROJ-1',
            jobParams: { reviewPolicy: JSON.stringify({ verification: 'filter' }) }
        });
        console.log('RESULT: ' + JSON.stringify(result).substring(0, 400));
        console.log('CLI: ' + cliCalls.length + ' -> ' + (cliCalls[0] && cliCalls[0].command));
        console.log('WRITES: ' + writes.map(function(w) { return w.path; }).join(', '));
        assert.equal(1, 1);
    });
});
