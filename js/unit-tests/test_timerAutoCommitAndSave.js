/**
 * Unit tests for js/timerAutoCommitAndSave.js
 *
 * Tests the timer action that auto-commits and saves session artefacts.
 * Mocks releaseArtefacts.js (uploadRawFile) and configLoader.js
 * (loadProjectConfig, for scm.provider resolution) so no real MCP tools
 * or filesystem config discovery are needed.
 *
 * Uses: loadModule(), makeRequire(), assert, test(), suite()
 */

var gitStagingModule = loadModule('js/common/gitStaging.js');

function loadTimer(mocks, opts) {
    opts = opts || {};
    var uploadRawFileCalls = [];
    var releaseArtefactsMock = {
        buildTag: function(ticketKey, template) {
            var t = (template || 'ai-{ticketKey}').replace(/\{ticketKey\}/g, ticketKey);
            return t.toLowerCase().replace(/[^a-z0-9._/-]/g, '-');
        },
        buildReleaseName: function(ticketKey, template) {
            return (template || '[AI] [{ticketKey}] Artefacts').replace(/\{ticketKey\}/g, ticketKey);
        },
        resolveArtefactRepository: function(customParams) {
            if (!customParams) return null;
            var repo = customParams.artefactRepository || customParams.aiRepository || customParams.targetRepository;
            if (!repo || !repo.owner || !repo.repo) return null;
            return { owner: repo.owner, repo: repo.repo };
        },
        uploadRawFile: function(owner, repo, ticketKey, releaseConfig, filePath, assetName, providerName) {
            uploadRawFileCalls.push({
                owner: owner, repo: repo, ticketKey: ticketKey, releaseConfig: releaseConfig,
                filePath: filePath, assetName: assetName, providerName: providerName
            });
            if (opts.uploadRawFileImpl) return opts.uploadRawFileImpl(arguments);
            return { success: true, releaseUrl: 'https://example.com/releases/1', assetUrl: 'https://example.com/asset', error: null };
        }
    };

    var configLoaderMock = {
        loadProjectConfig: function(params) {
            return { scm: { provider: opts.scmProvider || 'github' } };
        }
    };

    var requireFn = makeRequire({
        './common/releaseArtefacts.js': releaseArtefactsMock,
        './common/gitStaging.js': gitStagingModule,
        './common/mergeState.js': loadModule('js/common/mergeState.js'),
        './configLoader.js': configLoaderMock
    });

    var mod = loadModule(
        'js/timerAutoCommitAndSave.js',
        requireFn,
        mocks || {}
    );
    mod._uploadRawFileCalls = uploadRawFileCalls;
    return mod;
}

// ── autoCommitAndPush ────────────────────────────────────────────────────────

suite('timerAutoCommitAndSave — autoCommitAndPush', function() {

    test('falls back to the job directory when targetRepository.workingDir is missing', function() {
        var cliCalls = [];
        var m = loadTimer({
            cli_execute_command: function(args) {
                cliCalls.push(args.command);
                if (args.command.indexOf('git status') !== -1) return ''; // clean tree
                return '';
            }
        });
        m.action({
            ticket: { key: 'PROJ-123' },
            jobParams: { customParams: {}, metadata: { contextId: 'sf_story_development' } },
            currentCliOutput: ''
        });
        // The timer must NOT silently no-op: it probes the job directory
        // (crash-safety contract — a missing config used to disable the
        // timer and kill-timeout runs lost the workspace).
        assert.ok(cliCalls.some(function(c) { return c.indexOf('git status') !== -1; }),
            'must probe the fallback job directory for changes');
    });

    test('does not commit when git status is clean', function() {
        var cliCalls = [];
        var m = loadTimer({
            cli_execute_command: function(args) {
                cliCalls.push(args.command);
                // gh-761 probe: no MERGE_HEAD — cli_execute_command throws on
                // the non-zero exit, simulated below by the probe branch.
                if (args.command.indexOf('git rev-parse --quiet --verify MERGE_HEAD') !== -1) {
                    throw new Error('Command execution failed (exit code 1)');
                }
                if (args.command.indexOf('git status') !== -1) return '';
                return '';
            }
        });
        m.action({
            ticket: { key: 'PROJ-123' },
            jobParams: {
                customParams: {
                    targetRepository: { workingDir: '/some/dir' }
                },
                metadata: { contextId: 'sf_story_development' }
            },
            currentCliOutput: ''
        });
        // MERGE_HEAD probe first, then the dirty-tree probe — nothing else.
        assert.equal(cliCalls.length, 2);
        assert.contains(cliCalls[0], 'git rev-parse --quiet --verify MERGE_HEAD');
        assert.contains(cliCalls[1], 'git status');
    });

    test('gh-761: skips the auto-commit while MERGE_HEAD exists — a mid-merge add/commit would finalize the conflicted merge', function() {
        // Live sequence (fa PR #1311, branch ai/gh-1308): WIP auto-saves every
        // 5 minutes while a conflicted merge of the base branch sits
        // unconcluded in the tree (MERGE_HEAD present). A blind
        // `git add -A && git commit` stages the unmerged paths — conflict
        // markers and all — and finalizes the merge as a 'WIP auto-save'
        // commit pushed to origin: silent branch corruption. The tick must
        // probe MERGE_HEAD BEFORE the dirty-tree probe (a mid-merge status is
        // always dirty) and refuse to touch the tree.
        var cliCalls = [];
        var m = loadTimer({
            cli_execute_command: function(args) {
                cliCalls.push(args.command);
                if (args.command.indexOf('git rev-parse --quiet --verify MERGE_HEAD') !== -1) {
                    return '9a7e2aecommitsha\n'; // merge in progress
                }
                if (args.command.indexOf('git status') !== -1) return 'UU lib/app.dart\nAA lib/other.dart\n';
                return '';
            }
        });
        m.action({
            ticket: { key: 'PROJ-123' },
            jobParams: {
                customParams: {
                    targetRepository: { workingDir: '/some/dir' }
                },
                metadata: { contextId: 'sf_story_development' }
            },
            currentCliOutput: ''
        });

        assert.ok(cliCalls.some(function(c) {
            return c.indexOf('git rev-parse --quiet --verify MERGE_HEAD') !== -1;
        }), 'must probe MERGE_HEAD every tick');
        assert.equal(cliCalls.filter(function(c) { return c.indexOf('git add') === 0; }).length, 0,
            'must never stage anything during a merge — add would resolve the unmerged paths');
        assert.equal(cliCalls.filter(function(c) { return c.indexOf('git commit') === 0; }).length, 0,
            'must never commit during a merge — commit would finalize it');
        assert.equal(cliCalls.filter(function(c) { return c.indexOf('git push') === 0; }).length, 0,
            'must never push during a merge');
        assert.equal(cliCalls.filter(function(c) { return c.indexOf('git ls-files -- ') === 0; }).length, 0,
            'untrack cleanup must not run either');
        var probeAt = cliCalls.map(function(c) { return c.indexOf('git rev-parse --quiet --verify MERGE_HEAD') !== -1; }).indexOf(true);
        var statusAt = cliCalls.map(function(c) { return c.indexOf('git status') !== -1; }).indexOf(true);
        assert.ok(statusAt === -1 || probeAt < statusAt,
            'MERGE_HEAD probe must come BEFORE the dirty-tree probe (mid-merge status is always dirty)');
    });

    test('gh-761: resumes normal auto-saving once the merge concludes (MERGE_HEAD gone)', function() {
        var cliCalls = [];
        var m = loadTimer({
            cli_execute_command: function(args) {
                cliCalls.push(args.command);
                if (args.command.indexOf('git rev-parse --quiet --verify MERGE_HEAD') !== -1) {
                    throw new Error('Command execution failed (exit code 1)'); // no MERGE_HEAD
                }
                if (args.command.indexOf('git check-ignore') === 0) {
                    throw new Error('Command execution failed (exit code 1)');
                }
                if (args.command.indexOf('git status') !== -1) return 'M fixed.js\n';
                return '';
            }
        });
        m.action({
            ticket: { key: 'PROJ-123' },
            jobParams: {
                customParams: {
                    targetRepository: { workingDir: '/some/dir' }
                },
                metadata: { contextId: 'sf_story_development' }
            },
            currentCliOutput: ''
        });
        assert.ok(cliCalls.filter(function(c) { return c.indexOf('git commit') === 0; }).length >= 1,
            'after the merge concludes the WIP save must flow again');
        assert.ok(cliCalls.some(function(c) { return c.indexOf('git push') === 0; }), 'push resumes too');
    });

    test('gh-761: a skipped auto-commit still uploads the session artefact — crash-safety is git-independent', function() {
        var fileWriteCalls = [];
        var m = loadTimer({
            cli_execute_command: function(args) {
                if (args.command.indexOf('git rev-parse --quiet --verify MERGE_HEAD') !== -1) {
                    return '9a7e2aecommitsha\n'; // merge in progress
                }
                if (args.command.indexOf('git status') !== -1) return 'UU lib/app.dart\n';
                return '';
            },
            file_write: function(args) { fileWriteCalls.push(args); },
            file_delete: function() {}
        });
        m.action({
            ticket: { key: 'PROJ-123' },
            jobParams: {
                customParams: {
                    targetRepository: { workingDir: '/some/dir' },
                    artefactRepository: { owner: 'Org', repo: 'repo' }
                },
                metadata: { contextId: 'sf_story_development' }
            },
            currentCliOutput: 'partial agent output while resolving conflicts'
        });
        assert.equal(m._uploadRawFileCalls.length, 1,
            'session log snapshot must still upload while the merge is unconcluded');
        assert.ok(fileWriteCalls.length >= 1, 'snapshot file written before upload');
    });

    test('commits and pushes when there are changes', function() {
        var cliCalls = [];
        var m = loadTimer({
            cli_execute_command: function(args) {
                cliCalls.push(args.command);
                // gh-683 probe: simulate a repo that does NOT ignore the
                // runtime paths — check-ignore exits 1 → exclusion kept.
                if (args.command.indexOf('git check-ignore') === 0) {
                    throw new Error('Command execution failed (exit code 1)');
                }
                if (args.command.indexOf('git status') !== -1) return 'M file.txt\n';
                return '';
            }
        });
        m.action({
            ticket: { key: 'PROJ-123' },
            jobParams: {
                customParams: {
                    targetRepository: { workingDir: '/some/dir' }
                },
                metadata: { contextId: 'sf_story_development' }
            },
            currentCliOutput: ''
        });
        assert.ok(cliCalls.length >= 4, 'should call status, add, commit, push');
        var untrack = cliCalls.filter(function(c) { return c.indexOf('git ls-files -- ') === 0; })[0];
        assert.ok(untrack, 'untrack-cleanup command present');
        assert.contains(untrack, '.dmtools/copilot-sessions');
        var addCall = cliCalls.filter(function(c) { return c.indexOf('git add -A') === 0; })[0];
        assert.ok(addCall, 'staging command present');
        var commitCall = cliCalls.filter(function(c) { return c.indexOf('git commit') === 0; })[0];
        assert.ok(commitCall, 'commit command present');
        assert.contains(commitCall, 'PROJ-123');
        assert.ok(cliCalls.some(function(c) { return c.indexOf('git push') === 0; }), 'push command present');
    });

    test('never stages machine-local .dmtools runtime logs — credential-helper.log leaked onto ai/gh-628 (gh-628)', function() {
        // Live 2026-10-03 (ai/gh-628 dev legs): the machine's runtime files
        // live INSIDE the committed .dmtools/ directory (config.js,
        // runners/), so the directory itself cannot be ignored — and the
        // timer's `git add -A` swept .dmtools/credential-helper.log (the
        // credential-helper's serving trace) into three WIP commits. The
        // add pathspec must exclude the runtime logs the same way it
        // excludes copilot-sessions, and the rm cleanup must untrack
        // already-poisoned branches.
        var cliCalls = [];
        var m = loadTimer({
            cli_execute_command: function(args) {
                cliCalls.push(args.command);
                // gh-683 probe: not-ignored repo — check-ignore exits 1 →
                // the exclusion pathspecs below must all be present.
                if (args.command.indexOf('git check-ignore') === 0) {
                    throw new Error('Command execution failed (exit code 1)');
                }
                if (args.command.indexOf('git status') !== -1) return 'M file.txt\n';
                return '';
            }
        });
        m.action({
            ticket: { key: 'PROJ-123' },
            jobParams: {
                customParams: {
                    targetRepository: { workingDir: '/some/dir' }
                },
                metadata: { contextId: 'sf_story_development' }
            },
            currentCliOutput: ''
        });
        var rmCalls = cliCalls.filter(function(c) { return c.indexOf('git ls-files -- ') === 0; });
        assert.equal(rmCalls.length, 1, 'exactly one untrack-cleanup command');
        assert.contains(rmCalls[0], '.dmtools/credential-helper.log',
            'already-tracked credential-helper.log is untracked (poisoned-branch self-heal)');
        assert.contains(rmCalls[0], '.dmtools/fa-sessions',
            'session store untracked too — untrack list must not drift from staging exclusions (gh-628)');
        assert.contains(rmCalls[0], '.dmtools/fa-trace.log', 'fa runtime trace untracked');
        var addCall = cliCalls.filter(function(c) { return c.indexOf('git add -A') === 0; })[0];
        assert.ok(addCall, 'staging command present');
        assert.contains(addCall, ':!.dmtools/credential-helper.log',
            'credential-serving trace never staged');
        assert.contains(addCall, ':!.dmtools/fa-trace.log', 'fa trace log never staged');
        assert.contains(addCall, ':!.dmtools/run-output.txt', 'fa run output never staged');
        assert.contains(addCall, ':!.dmtools/stall-capture.log', 'stall capture never staged');
        assert.contains(addCall, ':!.dmtools/fa-sessions', 'session store never staged');
        assert.contains(addCall, ':!.dmtools-session-output.log',
            'the timer\'s own CLI-stdout snapshot (crash-leftover) never staged');
    });

    test('gh-683: a repo that IGNORES the runtime paths gets no runtime pathspec — git add guard cannot fire', function() {
        // Live fa run 37153405587 (fa gh-1206, 2026-10-03): the timer's
        // `git add -A` died with exit 1 — "The following paths are ignored
        // by one of your .gitignore files: .dmtools/credential-helper.log
        // .dmtools/fa-sessions .dmtools/fa-trace.log .dmtools/run-output.txt
        // .dmtools/stall-capture.log — hint: Use -f if you really want to
        // add them". git add runs its ignored-pathspec guard on `:!`
        // EXCLUSION pathspecs too: naming an existing ignored-untracked
        // path fails the whole add. In such a repo the probe
        // (check-ignore exit 0, no throw) drops every runtime exclusion —
        // gitignore alone keeps the artifacts out — and only the
        // factory-kit specs (never ignored) remain.
        var cliCalls = [];
        var m = loadTimer({
            cli_execute_command: function(args) {
                cliCalls.push(args.command);
                if (args.command.indexOf('git status') !== -1) return 'M file.txt\n';
                if (args.command.indexOf('git check-ignore') === 0) {
                    if (args.command.indexOf('factory-kit') !== -1) {
                        // the nested machine-infra repo is NOT gitignored
                        throw new Error('Command execution failed (exit code 1)');
                    }
                    return ''; // runtime artifacts ignored → exclusions dropped
                }
                return '';
            }
        });
        m.action({
            ticket: { key: 'PROJ-123' },
            jobParams: {
                customParams: {
                    targetRepository: { workingDir: '/some/dir' }
                },
                metadata: { contextId: 'sf_story_development' }
            },
            currentCliOutput: ''
        });
        var addCall = cliCalls.filter(function(c) { return c.indexOf('git add -A') === 0; })[0];
        assert.ok(addCall, 'staging command present');
        assert.contains(addCall, ':!factory-kit', 'factory-kit exclusion stays (never ignored)');
        ['credential-helper.log', 'fa-trace.log', 'run-output.txt', 'stall-capture.log',
         'fa-sessions', 'copilot-sessions', '.dmtools-session-output.log'].forEach(function (p) {
            assert.notContains(addCall, ':!.' + (p.indexOf('.dmtools-session') === 0 ? p : 'dmtools/' + p),
                'ignored path ' + p + ' must not be named in the pathspec (guard)');
        });
    });

    test('gh-1164: factory-kit ignored+materialized — the add names NOTHING ignored, the WIP commit lands (red→green repro)', function() {
        // Live fa gh-1164 (runs 37153882406 + 37220167230, 2026-10-03/04): a
        // dev agent did real work live while this timer's `git add -A`
        // FAILED every 5 minutes for 40+ minutes — exit 1, "The following
        // paths are ignored by one of your .gitignore files" — the work was
        // never committed and died with the runner. Scratch-repo repro (git
        // 2.50.1) pinned the trip wire: the STATIC
        // `":!factory-kit" ":!factory-kit/**"` appended after the
        // probe-filtered specs — the guard fires on any literal pathspec
        // (exclusions included) naming an existing gitignored-untracked
        // path, and the runner workspace has exactly that when factory-kit
        // is materialized AND gitignored. This mock re-enacts the guard
        // faithfully: the add throws whenever its command line names a path
        // check-ignore reported as ignored.
        var cliCalls = [];
        var ignoredPaths = ['.dmtools/copilot-sessions', '.dmtools/credential-helper.log',
            '.dmtools/fa-trace.log', '.dmtools/run-output.txt', '.dmtools/stall-capture.log',
            '.dmtools/fa-sessions', '.dmtools-session-output.log', 'factory-kit'];
        var m = loadTimer({
            cli_execute_command: function(args) {
                cliCalls.push(args.command);
                if (args.command.indexOf('git status') !== -1) return 'M feature.js\n';
                if (args.command.indexOf('git check-ignore') === 0) {
                    return ''; // every candidate (incl. factory-kit) is gitignored here
                }
                if (args.command.indexOf('git add -A') === 0) {
                    // git add's ignored-pathspec guard, faithfully:
                    for (var i = 0; i < ignoredPaths.length; i++) {
                        if (args.command.indexOf(':!' + ignoredPaths[i]) !== -1) {
                            throw new Error('Command execution failed (exit code 1): ' +
                                'The following paths are ignored by one of your .gitignore files:\n' +
                                ignoredPaths[i] + '\nhint: Use -f if you really want to add them.');
                        }
                    }
                    return '';
                }
                return '';
            }
        });
        m.action({
            ticket: { key: 'GH-1164' },
            jobParams: {
                customParams: {
                    targetRepository: { workingDir: '/some/dir' }
                },
                metadata: { contextId: 'sf_story_development' }
            },
            currentCliOutput: ''
        });
        var addCall = cliCalls.filter(function(c) { return c.indexOf('git add -A') === 0; })[0];
        assert.ok(addCall, 'staging command present');
        ignoredPaths.forEach(function (p) {
            assert.notContains(addCall, ':!' + p,
                'ignored path ' + p + ' must never be named — the guard trips on it (gh-1164)');
        });
        var commitCall = cliCalls.filter(function(c) { return c.indexOf('git commit') === 0; })[0];
        assert.ok(commitCall, 'the WIP auto-save commit MUST land — the guard can no longer starve it');
        assert.contains(commitCall, 'GH-1164');
        assert.ok(cliCalls.some(function(c) { return c.indexOf('git push') === 0; }),
            'and the push runs — work survives a runner death');
    });

    test('refuses to commit/push when HEAD is on baseBranch', function() {
        var cliCalls = [];
        var m = loadTimer({
            cli_execute_command: function(args) {
                cliCalls.push(args.command);
                if (args.command.indexOf('rev-parse --abbrev-ref HEAD') !== -1) return 'develop\n';
                if (args.command.indexOf('git status') !== -1) return 'M file.txt\n';
                return '';
            }
        });
        m.action({
            ticket: { key: 'PROJ-123' },
            jobParams: {
                customParams: {
                    targetRepository: { workingDir: '/some/dir', baseBranch: 'develop' }
                },
                metadata: { contextId: 'pr_rework' }
            },
            currentCliOutput: ''
        });

        assert.equal(cliCalls.length, 1, 'must stop right after checking the current branch');
        assert.contains(cliCalls[0], 'rev-parse --abbrev-ref HEAD');
        assert.equal(cliCalls.filter(function(c) { return c.indexOf('git commit') !== -1; }).length, 0,
            'must never commit while on baseBranch');
        assert.equal(cliCalls.filter(function(c) { return c.indexOf('git push') !== -1; }).length, 0,
            'must never push while on baseBranch');
    });

    test('proceeds normally when HEAD is on the ticket branch (not baseBranch)', function() {
        var cliCalls = [];
        var m = loadTimer({
            cli_execute_command: function(args) {
                cliCalls.push(args.command);
                if (args.command.indexOf('rev-parse --abbrev-ref HEAD') !== -1) return 'bug/PROJ-123\n';
                if (args.command.indexOf('git status') !== -1) return 'M file.txt\n';
                return '';
            }
        });
        m.action({
            ticket: { key: 'PROJ-123' },
            jobParams: {
                customParams: {
                    targetRepository: { workingDir: '/some/dir', baseBranch: 'develop' }
                },
                metadata: { contextId: 'pr_rework' }
            },
            currentCliOutput: ''
        });

        assert.ok(cliCalls.filter(function(c) { return c.indexOf('git commit') !== -1; }).length >= 1,
            'should commit as normal when on the ticket branch');
        assert.ok(cliCalls.filter(function(c) { return c.indexOf('git push') !== -1; }).length >= 1,
            'should push as normal when on the ticket branch');
    });

    test('skips the branch check entirely when baseBranch is not configured (back-compat)', function() {
        var cliCalls = [];
        var m = loadTimer({
            cli_execute_command: function(args) {
                cliCalls.push(args.command);
                if (args.command.indexOf('git status') !== -1) return 'M file.txt\n';
                return '';
            }
        });
        m.action({
            ticket: { key: 'PROJ-123' },
            jobParams: {
                customParams: {
                    targetRepository: { workingDir: '/some/dir' } // no baseBranch
                },
                metadata: { contextId: 'sf_story_development' }
            },
            currentCliOutput: ''
        });

        assert.equal(cliCalls.filter(function(c) { return c.indexOf('rev-parse --abbrev-ref HEAD') !== -1; }).length, 0,
            'must not attempt the branch check when baseBranch is unknown');
        assert.ok(cliCalls.filter(function(c) { return c.indexOf('git commit') !== -1; }).length >= 1);
    });
});

// ── saveSessionArtefact ──────────────────────────────────────────────────────

suite('timerAutoCommitAndSave — saveSessionArtefact', function() {

    test('skips when artefactRepository is not configured', function() {
        var fileWriteCalls = [];
        var m = loadTimer({
            cli_execute_command: function(args) { return ''; },
            file_write: function(args) { fileWriteCalls.push(args); },
            file_delete: function() {}
        });
        m.action({
            ticket: { key: 'PROJ-123' },
            jobParams: { customParams: {}, metadata: { contextId: 'test' } },
            currentCliOutput: 'some output'
        });
        assert.equal(fileWriteCalls.length, 0);
    });

    test('skips when currentCliOutput is empty', function() {
        var fileWriteCalls = [];
        var m = loadTimer({
            cli_execute_command: function(args) { return ''; },
            file_write: function(args) { fileWriteCalls.push(args); },
            file_delete: function() {}
        });
        m.action({
            ticket: { key: 'PROJ-123' },
            jobParams: {
                customParams: {
                    artefactRepository: { owner: 'TestOrg', repo: 'test-repo' }
                },
                metadata: { contextId: 'test' }
            },
            currentCliOutput: ''
        });
        assert.equal(fileWriteCalls.length, 0);
    });

    test('uploads .log via releaseArtefacts.uploadRawFile (no CLI commands, no zip)', function() {
        var fileWriteCalls = [];
        var deleteCalls = [];
        var cliCalls = [];

        var m = loadTimer({
            cli_execute_command: function(args) {
                cliCalls.push(args.command);
                if (args.command.indexOf('git status') !== -1) return '';
                return '';
            },
            file_write: function(args) { fileWriteCalls.push(args); },
            file_delete: function(args) { deleteCalls.push(args); }
        });

        m.action({
            ticket: { key: 'PROJ-123' },
            jobParams: {
                customParams: {
                    artefactRepository: { owner: 'ExampleOrg', repo: 'example-app' },
                    targetRepository: { workingDir: '/some/dir' }
                },
                metadata: { contextId: 'sf_story_development' }
            },
            currentCliOutput: 'Hello CLI output\nline 2'
        });

        // file_write should write the CLI output wrapped in a snapshot
        assert.equal(fileWriteCalls.length, 1);
        assert.equal(fileWriteCalls[0].path, '.dmtools-session-output.log');
        assert.contains(fileWriteCalls[0].content, 'Hello CLI output\nline 2', 'raw CLI output preserved');
        assert.contains(fileWriteCalls[0].content, 'TIMER SESSION SNAPSHOT START', 'snapshot header present');
        assert.contains(fileWriteCalls[0].content, 'TIMER SESSION SNAPSHOT END', 'snapshot footer present');

        // Should delegate to releaseArtefacts.uploadRawFile with the 'github' provider (default)
        assert.equal(m._uploadRawFileCalls.length, 1);
        assert.equal(m._uploadRawFileCalls[0].owner, 'ExampleOrg');
        assert.equal(m._uploadRawFileCalls[0].repo, 'example-app');
        assert.equal(m._uploadRawFileCalls[0].ticketKey, 'PROJ-123');
        assert.equal(m._uploadRawFileCalls[0].filePath, '.dmtools-session-output.log');
        assert.equal(m._uploadRawFileCalls[0].assetName, 'sf_story_development-session.log');
        assert.equal(m._uploadRawFileCalls[0].providerName, 'github');

        // Should NOT call zip or any other CLI command for session save
        var zipCalls = cliCalls.filter(function(c) { return c.indexOf('zip') !== -1; });
        assert.equal(zipCalls.length, 0, 'should not use zip CLI command');

        // Should cleanup
        assert.ok(deleteCalls.length >= 1, 'should cleanup temp file');
    });

    test('resolves the gitlab provider from configLoader and passes it through', function() {
        var m = loadTimer({
            cli_execute_command: function() { return ''; },
            file_write: function() {},
            file_delete: function() {}
        }, { scmProvider: 'gitlab' });

        m.action({
            ticket: { key: 'PROJ-123' },
            jobParams: {
                customParams: {
                    artefactRepository: { owner: 'mygroup', repo: 'myrepo' }
                },
                metadata: { contextId: 'sf_story_development' }
            },
            currentCliOutput: 'some output'
        });

        assert.equal(m._uploadRawFileCalls.length, 1);
        assert.equal(m._uploadRawFileCalls[0].providerName, 'gitlab');
    });

    test('handles upload failure gracefully', function() {
        var m = loadTimer({
            cli_execute_command: function(args) { return ''; },
            file_write: function(args) {},
            file_delete: function(args) {}
        }, {
            uploadRawFileImpl: function() {
                return { success: false, releaseUrl: null, assetUrl: null, error: 'HTTP 401 Unauthorized' };
            }
        });

        // Should not throw — errors are caught
        m.action({
            ticket: { key: 'PROJ-123' },
            jobParams: {
                customParams: {
                    artefactRepository: { owner: 'Org', repo: 'repo' }
                },
                metadata: { contextId: 'test' }
            },
            currentCliOutput: 'some output'
        });
        // If we get here, the error was handled gracefully
        assert.ok(true);
    });

    test('no ticketKey — skips entirely', function() {
        var fileWriteCalls = [];
        var m = loadTimer({
            cli_execute_command: function() { return ''; },
            file_write: function(args) { fileWriteCalls.push(args); },
            file_delete: function() {}
        });
        m.action({
            jobParams: {
                customParams: {
                    artefactRepository: { owner: 'Org', repo: 'repo' }
                },
                metadata: { contextId: 'test' }
            },
            currentCliOutput: 'output'
        });
        assert.equal(fileWriteCalls.length, 0);
    });
});

// ── gh-798: non-fast-forward push self-heal (AC3) ────────────────────────────
// Live fa PR #1420 (gh-1415 rework leg, run 37828431528, 2026-10-08): the SM's
// silent-update merged main into the branch mid-run; the leg's timer push
// `git push origin HEAD` was rejected non-fast-forward and "⏱️ timer: git push
// failed" surfaced to the running agent. The agent's manual recovery (merge
// origin → push) is exactly what the wrapper encodes: ONE fetch+merge+retry,
// then the honest failure.

suite('timerAutoCommitAndSave — gh-798 push self-heal wrapper', function() {

    var NON_FF_ERROR = 'remote: error: GH003: Sorry, ref-lock protection\n' +
        'To https://github.com/acme/repo.git\n' +
        '! [rejected]        HEAD -> ai/gh-1415 (non-fast-forward)\n' +
        'hint: Updates were rejected because the tip of your current branch is behind';

    function makeCmd(script) {
        var calls = [];
        var cmd = function(command) {
            calls.push(command);
            return script(command);
        };
        cmd.calls = calls;
        return cmd;
    }

    test('push succeeds first try — no healing commands, no extra probes', function() {
        var m = loadTimer({});
        var cmd = makeCmd(function() { return ''; });
        var result = m.pushBranchWithSelfHeal(cmd, function() { return 'ai/gh-1'; });
        assert.ok(result && result.pushed, 'pushed');
        assert.equal(result.healed, false, 'no healing needed');
        assert.equal(cmd.calls.length, 1, 'exactly the bare push');
        assert.equal(cmd.calls[0], 'git push origin HEAD');
    });

    test('non-FF rejection → fetch + merge + ONE retry lands the commit', function() {
        var m = loadTimer({});
        var pushes = 0;
        var cmd = makeCmd(function(command) {
            if (command.indexOf('git push') === 0) {
                pushes++;
                if (pushes === 1) throw new Error(NON_FF_ERROR);
                return ''; // retry lands
            }
            return '';
        });
        var result = m.pushBranchWithSelfHeal(cmd, function() { return 'ai/gh-1415'; });
        assert.ok(result && result.pushed && result.healed, 'pushed after the self-heal');
        assert.equal(pushes, 2, 'exactly one retry');
        var fetchAt = -1, mergeAt = -1, retryAt = -1;
        cmd.calls.forEach(function(c, i) {
            if (c.indexOf('git -c fetch.recurseSubmodules=no fetch origin ai/gh-1415') === 0) fetchAt = i;
            if (c.indexOf('git merge --no-edit origin/ai/gh-1415') === 0) mergeAt = i;
            if (c.indexOf('git push') === 0 && i > 0) retryAt = i;
        });
        assert.ok(fetchAt !== -1, 'fetches the branch refspec (pushReworkChanges shape)');
        assert.ok(mergeAt !== -1, 'merge-style sync — matches the SM merge refreshes, no rebase of WIP commits');
        assert.ok(fetchAt < mergeAt && mergeAt < retryAt,
            'order: fetch → merge → retry push');
        assert.equal(cmd.calls[retryAt], 'git push origin HEAD', 'retry is the same bare push');
    });

    test('branch resolver consulted ONLY on the healing path', function() {
        var m = loadTimer({});
        var resolves = 0;
        var cmd = makeCmd(function() { return ''; });
        m.pushBranchWithSelfHeal(cmd, function() { resolves++; return 'ai/gh-2'; });
        assert.equal(resolves, 0, 'a clean push must not pay a branch probe');
    });

    test('retry also rejected → honest failure, exactly one retry (no force-push)', function() {
        var m = loadTimer({});
        var pushes = 0;
        var cmd = makeCmd(function(command) {
            if (command.indexOf('git push') === 0) {
                pushes++;
                throw new Error(NON_FF_ERROR);
            }
            return '';
        });
        var threw = null;
        try { m.pushBranchWithSelfHeal(cmd, function() { return 'ai/gh-3'; }); }
        catch (e) { threw = e; }
        assert.ok(threw, 'the failure surfaces after the self-heal');
        assert.ok(String(threw.message).indexOf('non-fast-forward') !== -1, 'the original rejection class');
        assert.equal(pushes, 2, 'first attempt + ONE retry — never more, never a force-push');
    });

    test('merge conflict during the heal → merge aborted, failure surfaces (no MERGE_HEAD left behind)', function() {
        // A MERGE_HEAD left in the tree would make every later timer tick
        // skip (gh-761) and strand conflict markers in the agent's working
        // state mid-run — abort restores the pre-merge tree, the push
        // failure surfaces honestly.
        var m = loadTimer({});
        var aborted = false;
        var cmd = makeCmd(function(command) {
            if (command.indexOf('git push') === 0) throw new Error(NON_FF_ERROR);
            if (command.indexOf('git merge --no-edit') === 0) {
                throw new Error('CONFLICT (content): Merge conflict in app.js\n' +
                    'Automatic merge failed; fix conflicts and then commit the result.');
            }
            if (command === 'git merge --abort') { aborted = true; return ''; }
            return '';
        });
        var threw = null;
        try { m.pushBranchWithSelfHeal(cmd, function() { return 'ai/gh-4'; }); }
        catch (e) { threw = e; }
        assert.ok(threw, 'the conflict surfaces — never swallowed');
        assert.ok(String(threw.message).indexOf('CONFLICT') !== -1, 'the merge error, not the push error');
        assert.ok(aborted, 'git merge --abort ran — the tree is back to the pre-merge state');
    });

    test('non-fast-forward ONLY: other push failures surface immediately, no healing', function() {
        var m = loadTimer({});
        var cmd = makeCmd(function(command) {
            if (command.indexOf('git push') === 0) {
                throw new Error('fatal: could not read Username for https://example.com: No such device');
            }
            return '';
        });
        var threw = null;
        try { m.pushBranchWithSelfHeal(cmd, function() { return 'ai/gh-5'; }); }
        catch (e) { threw = e; }
        assert.ok(threw, 'auth/network failures are not for this wrapper to fix');
        assert.equal(cmd.calls.length, 1, 'no fetch/merge/retry for a non-FF failure');
    });

    test('unresolvable branch name on a rejected push → surfaces the original failure', function() {
        var m = loadTimer({});
        var cmd = makeCmd(function(command) {
            if (command.indexOf('git push') === 0) throw new Error(NON_FF_ERROR);
            return '';
        });
        var threw = null;
        try { m.pushBranchWithSelfHeal(cmd, function() { return ''; }); }
        catch (e) { threw = e; }
        assert.ok(threw, 'no refspec to fetch — the original rejection surfaces');
        assert.equal(cmd.calls.length, 1, 'no half-applied healing');
    });

    test('isNonFastForwardError recognizes the rejection shapes', function() {
        var m = loadTimer({});
        assert.equal(m.isNonFastForwardError(new Error(NON_FF_ERROR)), true, '[rejected] + non-fast-forward');
        assert.equal(m.isNonFastForwardError(new Error(
            'error: failed to push some refs\nhint: Updates were rejected because the tip of your current branch is behind\nhint: Integrate the remote changes (e.g. git pull)')),
            true, 'behind-hint shape (older git)');
        assert.equal(m.isNonFastForwardError(new Error('fatal: could not read Username')), false);
        assert.equal(m.isNonFastForwardError(null), false);
    });

    test('end-to-end: a timer tick whose push is rejected self-heals inside the same tick', function() {
        var cliCalls = [];
        var pushes = 0;
        var m = loadTimer({
            cli_execute_command: function(args) {
                cliCalls.push(args.command);
                if (args.command.indexOf('git rev-parse --quiet --verify MERGE_HEAD') !== -1) {
                    throw new Error('Command execution failed (exit code 1)'); // no merge in progress
                }
                if (args.command.indexOf('git check-ignore') === 0) {
                    throw new Error('Command execution failed (exit code 1)');
                }
                if (args.command.indexOf('git rev-parse --abbrev-ref HEAD') !== -1) return 'ai/gh-1415\n';
                if (args.command.indexOf('git status') !== -1) return 'M fixed.js\n';
                if (args.command.indexOf('git push') === 0) {
                    pushes++;
                    if (pushes === 1) throw new Error(NON_FF_ERROR);
                    return '';
                }
                return '';
            }
        });
        m.action({
            ticket: { key: 'GH-1415' },
            jobParams: {
                customParams: { targetRepository: { workingDir: '/some/dir' } },
                metadata: { contextId: 'pr_rework' }
            },
            currentCliOutput: ''
        });
        assert.equal(pushes, 2, 'first push rejected, retry landed');
        assert.ok(cliCalls.some(function(c) { return c.indexOf('git merge --no-edit origin/ai/gh-1415') === 0; }),
            'the merge ran in the target working dir');
        assert.ok(cliCalls.some(function(c) { return c.indexOf('WIP auto-save') !== -1; }) ||
                  cliCalls.filter(function(c) { return c.indexOf('git commit') === 0; }).length >= 1,
            'the WIP commit still landed on the remote');
    });
});
