/**
 * Unit tests for js/common/branchSetup.js (gh-1247)
 *
 * The module is require-free by design (all collaborators are injected), so
 * it loads bare and every test pins one helper's exact command/log behavior.
 *
 * Uses: loadModule(), assert, test(), suite()
 */

function loadBranchSetup(mocks) {
    return loadModule('js/common/branchSetup.js', null, mocks || {});
}

/** prHelper stub with the four collaborators branchSetup delegates to. */
function makePrHelper(overrides) {
    var base = {
        cleanCommandOutput: function (out) {
            if (!out) return '';
            return String(out).split('\n').filter(function (line) {
                return line.indexOf('Script started') === -1 && line.indexOf('Script done') === -1;
            }).join('\n').trim();
        },
        buildTargetedOriginFetchCommand: function (branches) {
            return branches && branches.length ? 'git fetch origin ' + branches.join(' ') : null;
        },
        remoteBranchExists: function (exec, workingDir, branchName) {
            return String(exec('git ls-remote --heads origin ' + branchName)).indexOf('refs/heads/' + branchName) !== -1;
        },
        decideFeatureBranchRoute: function (localList, remoteExists) {
            if (localList) return 'checkout-local';
            return remoteExists ? 'checkout-remote' : 'create';
        },
        buildOriginFetchCommand: function () { return 'git fetch origin --prune'; },
        ensureRemoteBranchRef: function (exec, workingDir, branchName) {
            exec('git fetch origin +refs/heads/' + branchName + ':refs/remotes/origin/' + branchName);
        }
    };
    return Object.assign({}, base, overrides || {});
}

/** Recording exec: returns responses[command] (or ''), records every command. */
function makeExec(calls, responses) {
    return function (command) {
        calls.push(command);
        if (responses && Object.prototype.hasOwnProperty.call(responses, command)) {
            return responses[command];
        }
        return '';
    };
}

var CONFIG = {
    git: { baseBranch: 'main', authorName: 'AI Teammate', authorEmail: 'ai@example.com' },
    workingDir: null
};

suite('branchSetup.configureGitAuthor', function() {

    test('runs both git config commands', function() {
        var calls = [];
        loadBranchSetup().configureGitAuthor(makeExec(calls), CONFIG, false);
        assert.equal(calls.length, 2);
        assert.equal(calls[0], 'git config user.name "AI Teammate"');
        assert.equal(calls[1], 'git config user.email "ai@example.com"');
    });

    test('logs success only when logSuccess is set', function() {
        var logs = [];
        var origLog = console.log;
        console.log = function(msg) { logs.push(msg); };
        try {
            loadBranchSetup().configureGitAuthor(makeExec([]), CONFIG, true);
            loadBranchSetup().configureGitAuthor(makeExec([]), CONFIG, false);
        } finally {
            console.log = origLog;
        }
        assert.deepEqual(logs, ['Configured git author']);
    });

    test('failure is a warning, not a throw', function() {
        var warns = [];
        var origWarn = console.warn;
        console.warn = function(msg) { warns.push(msg); };
        try {
            loadBranchSetup().configureGitAuthor(function () { throw new Error('no git'); }, CONFIG, false);
        } finally {
            console.warn = origWarn;
        }
        assert.equal(warns.length, 1);
        assert.ok(warns[0].indexOf('Failed to configure git author:') === 0);
    });
});

suite('branchSetup.fetchBranchRefs', function() {

    test('runs the targeted fetch for the given refs', function() {
        var calls = [];
        loadBranchSetup().fetchBranchRefs(makePrHelper(), makeExec(calls), ['dev/x', 'main'], 'warn');
        assert.deepEqual(calls, ['git fetch origin dev/x main']);
    });

    test('skips when the builder returns no command', function() {
        var calls = [];
        var prHelper = makePrHelper({ buildTargetedOriginFetchCommand: function () { return null; } });
        loadBranchSetup().fetchBranchRefs(prHelper, makeExec(calls), ['x'], 'warn');
        assert.equal(calls.length, 0);
    });

    test('failure logs the caller warn message', function() {
        var warns = [];
        var origWarn = console.warn;
        console.warn = function(msg) { warns.push(msg); };
        try {
            loadBranchSetup().fetchBranchRefs(makePrHelper(), function () { throw new Error('net'); }, ['x'], 'Could not fetch remote branches:');
        } finally {
            console.warn = origWarn;
        }
        assert.equal(warns.length, 1);
        assert.deepEqual(warns, ['Could not fetch remote branches:']);
    });
});

suite('branchSetup.readLocalBranchList', function() {

    test('returns the cleaned branch list output', function() {
        var out = loadBranchSetup().readLocalBranchList(
            makePrHelper(),
            makeExec([], { 'git branch --list "dev/x"': 'Script started\n* dev/x\nScript done\n' }),
            'dev/x',
            null
        );
        assert.equal(out, '* dev/x');
    });

    test('failure returns empty string and logs the warn message', function() {
        var warns = [];
        var origWarn = console.warn;
        console.warn = function(msg) { warns.push(msg); };
        var out;
        try {
            out = loadBranchSetup().readLocalBranchList(makePrHelper(), function () { throw new Error('boom'); }, 'dev/x', 'Error checking local branches:');
        } finally {
            console.warn = origWarn;
        }
        assert.equal(out, '');
        assert.deepEqual(warns, ['Error checking local branches:']);
    });

    test('silent probe (null warnMessage) swallows failures', function() {
        var warns = [];
        var origWarn = console.warn;
        console.warn = function(msg) { warns.push(msg); };
        var out;
        try {
            out = loadBranchSetup().readLocalBranchList(makePrHelper(), function () { throw new Error('boom'); }, 'dev/x', null);
        } finally {
            console.warn = origWarn;
        }
        assert.equal(out, '');
        assert.equal(warns.length, 0);
    });
});

suite('branchSetup.probeRemoteBranch', function() {

    test('returns true when the refs/heads line exists', function() {
        var exists = loadBranchSetup().probeRemoteBranch(
            makePrHelper(),
            makeExec([], { 'git ls-remote --heads origin dev/x': 'abc\trefs/heads/dev/x\n' }),
            'wd',
            'dev/x',
            null
        );
        assert.equal(exists, true);
    });

    test('returns false on probe failure, warning only when message given', function() {
        var warns = [];
        var origWarn = console.warn;
        console.warn = function(msg) { warns.push(msg); };
        var out;
        try {
            out = loadBranchSetup().probeRemoteBranch(makePrHelper(), function () { throw new Error('net'); }, 'wd', 'dev/x', 'Error checking remote branches:');
        } finally {
            console.warn = origWarn;
        }
        assert.equal(out, false);
        assert.deepEqual(warns, ['Error checking remote branches:']);
    });
});

suite('branchSetup.createFeatureBranch / establishFeatureBranch', function() {

    function makeDeps(calls, hookFn) {
        return {
            prHelper: makePrHelper(),
            configLoader: {
                loadHookFn: function (path, name) {
                    calls.push('hook:' + path + ':' + name);
                    return hookFn || null;
                },
                resolveBranchName: function (cfg, ticket, role) { return role + '/' + ticket.key; }
            },
            exec: makeExec(calls)
        };
    }

    test('hook path delegates creation and checks out the fetched branch', function() {
        var calls = [];
        var hookCalls = [];
        var deps = makeDeps(calls, function (ctx) { hookCalls.push(ctx); });
        var customParams = { branchCreateFnPath: 'hooks/create.js' };
        var ticket = { key: 'PROJ-1' };
        loadBranchSetup().createFeatureBranch(deps.prHelper, deps.configLoader, deps.exec, CONFIG, customParams, ticket, 'feature/PROJ-1', function () {
            calls.push('PLAIN-TAIL');
        });
        assert.equal(hookCalls.length, 1);
        assert.equal(hookCalls[0].branchName, 'feature/PROJ-1');
        assert.equal(hookCalls[0].baseBranch, 'main');
        assert.deepEqual(calls, [
            'hook:hooks/create.js:branchCreateFnPath',
            'git fetch origin --prune',
            'git checkout -b feature/PROJ-1 origin/feature/PROJ-1'
        ]);
    });

    test('no-hook path runs the caller plain-creation tail', function() {
        var calls = [];
        var deps = makeDeps(calls);
        loadBranchSetup().createFeatureBranch(deps.prHelper, deps.configLoader, deps.exec, CONFIG, {}, { key: 'PROJ-1' }, 'feature/PROJ-1', function (name) {
            calls.push('plain:' + name);
        });
        assert.deepEqual(calls, ['plain:feature/PROJ-1']);
    });

    test('establishFeatureBranch routes create via the plain tail', function() {
        var calls = [];
        var deps = makeDeps(calls);
        var name = loadBranchSetup().establishFeatureBranch(
            deps.prHelper, deps.configLoader, deps.exec, null, CONFIG, {}, { key: 'PROJ-1' },
            function (n) { calls.push('plain:' + n); }
        );
        assert.equal(name, 'feature/PROJ-1');
        assert.deepEqual(calls, ['git branch --list "feature/PROJ-1"', 'git ls-remote --heads origin feature/PROJ-1', 'plain:feature/PROJ-1']);
    });

    test('establishFeatureBranch checks out a pre-existing remote branch', function() {
        var calls = [];
        var deps = makeDeps(calls);
        var exec = makeExec(calls, { 'git ls-remote --heads origin feature/PROJ-2': 'abc\trefs/heads/feature/PROJ-2\n' });
        var name = loadBranchSetup().establishFeatureBranch(
            deps.prHelper, deps.configLoader, exec, null, CONFIG, {}, { key: 'PROJ-2' },
            function (n) { calls.push('plain:' + n); }
        );
        assert.equal(name, 'feature/PROJ-2');
        assert.deepEqual(calls, [
            'git branch --list "feature/PROJ-2"',
            'git ls-remote --heads origin feature/PROJ-2',
            'git checkout -b feature/PROJ-2 origin/feature/PROJ-2'
        ]);
    });

    test('establishFeatureBranch switches to an existing local branch', function() {
        var calls = [];
        var deps = makeDeps(calls);
        var exec = makeExec(calls, { 'git branch --list "feature/PROJ-3"': '* feature/PROJ-3\n' });
        var name = loadBranchSetup().establishFeatureBranch(
            deps.prHelper, deps.configLoader, exec, null, CONFIG, {}, { key: 'PROJ-3' },
            function (n) { calls.push('plain:' + n); }
        );
        assert.equal(name, 'feature/PROJ-3');
        assert.deepEqual(calls, [
            'git branch --list "feature/PROJ-3"',
            'git ls-remote --heads origin feature/PROJ-3',
            'git checkout feature/PROJ-3'
        ]);
    });
});

suite('branchSetup.ensureGitInfoExclude', function() {

    test('appends the entry with its comment when absent', function() {
        var writes = [];
        var mod = loadBranchSetup({
            file_read: function (opts) { return opts.path === '.git/info/exclude' ? '*.bak\n' : ''; },
            file_write: function (opts) { writes.push(opts); }
        });
        mod.ensureGitInfoExclude('outputs/', '# keep outputs out', 'warn:');
        assert.equal(writes.length, 1);
        assert.equal(writes[0].path, '.git/info/exclude');
        assert.equal(writes[0].content, '*.bak\n\n# keep outputs out\noutputs/\n');
    });

    test('is a no-op when the entry already exists', function() {
        var writes = [];
        var mod = loadBranchSetup({
            file_read: function (opts) { return opts.path === '.git/info/exclude' ? 'outputs/\n' : ''; },
            file_write: function (opts) { writes.push(opts); }
        });
        mod.ensureGitInfoExclude('outputs/', '# comment', 'warn:');
        assert.equal(writes.length, 0);
    });

    test('adds a separator when the file lacks a trailing newline', function() {
        var writes = [];
        var mod = loadBranchSetup({
            file_read: function (opts) { return opts.path === '.git/info/exclude' ? '*.bak' : ''; },
            file_write: function (opts) { writes.push(opts); }
        });
        mod.ensureGitInfoExclude('.codegraph/', '# cg', 'warn:');
        assert.equal(writes[0].content, '*.bak\n\n# cg\n.codegraph/\n');
    });

    test('read failure still writes a fresh file', function() {
        var writes = [];
        var mod = loadBranchSetup({
            file_read: function () { throw new Error('no repo'); },
            file_write: function (opts) { writes.push(opts); }
        });
        mod.ensureGitInfoExclude('outputs/', '# c', 'warn:');
        assert.equal(writes.length, 1);
        assert.equal(writes[0].content, '\n# c\noutputs/\n');
    });

    test('write failure is a non-fatal warning', function() {
        var warns = [];
        var origWarn = console.warn;
        console.warn = function(msg) { warns.push(msg); };
        var mod = loadBranchSetup({
            file_read: function () { return ''; },
            file_write: function () { throw new Error('ro'); }
        });
        try {
            mod.ensureGitInfoExclude('outputs/', '# c', 'ensureOutputsLocalExclude: failed to update .git/info/exclude (non-fatal):');
        } finally {
            console.warn = origWarn;
        }
        assert.equal(warns.length, 1);
        assert.ok(warns[0].indexOf('ensureOutputsLocalExclude: failed to update .git/info/exclude (non-fatal):') === 0);
    });
});

suite('branchSetup.branchHasUniquePatches', function() {

    test('false when cherry output is empty', function() {
        var out = loadBranchSetup().branchHasUniquePatches(makePrHelper(), makeExec([], { 'git cherry origin/main HEAD': '' }), 'main', 'warn:');
        assert.equal(out, false);
    });

    test('false when only already-upstream (-) lines exist', function() {
        var out = loadBranchSetup().branchHasUniquePatches(
            makePrHelper(),
            makeExec([], { 'git cherry origin/main HEAD': '- abc\n- def\n' }),
            'main', 'warn:'
        );
        assert.equal(out, false);
    });

    test('true when at least one + line exists (multi-line case)', function() {
        var out = loadBranchSetup().branchHasUniquePatches(
            makePrHelper(),
            makeExec([], { 'git cherry origin/main HEAD': '- abc\n+ def\n' }),
            'main', 'warn:'
        );
        assert.equal(out, true);
    });

    test('failure warns and returns true (keep divergent branch)', function() {
        var warns = [];
        var origWarn = console.warn;
        console.warn = function(msg) { warns.push(msg); };
        var out;
        try {
            out = loadBranchSetup().branchHasUniquePatches(makePrHelper(), function () { throw new Error('x'); }, 'main', 'Could not inspect unique branch patches:');
        } finally {
            console.warn = origWarn;
        }
        assert.equal(out, true);
        assert.deepEqual(warns, ['Could not inspect unique branch patches:']);
    });
});

suite('branchSetup.findMergeBase / collectMergeTreeDetails', function() {

    test('findMergeBase cleans the script output', function() {
        var out = loadBranchSetup().findMergeBase(
            makePrHelper(),
            makeExec([], { 'bash agents/scripts/git-merge-base-or-empty.sh HEAD origin/main': 'Script started\nabc123\nScript done\n' }),
            'HEAD', 'origin/main'
        );
        assert.equal(out, 'abc123');
    });

    test('findMergeBase returns empty string on failure', function() {
        var out = loadBranchSetup().findMergeBase(makePrHelper(), function () { throw new Error('x'); }, 'HEAD', 'origin/main');
        assert.equal(out, '');
    });

    test('collectMergeTreeDetails returns merge-tree output when a base exists', function() {
        var calls = [];
        var out = loadBranchSetup().collectMergeTreeDetails(
            makePrHelper(),
            makeExec(calls, {
                'bash agents/scripts/git-merge-base-or-empty.sh HEAD origin/main': 'abc123\n',
                'git merge-tree abc123 HEAD origin/main': 'conflict markers\n'
            }),
            'main', 'NO-BASE-TEXT'
        );
        assert.equal(out, 'conflict markers');
        assert.deepEqual(calls, [
            'bash agents/scripts/git-merge-base-or-empty.sh HEAD origin/main',
            'git merge-tree abc123 HEAD origin/main'
        ]);
    });

    test('collectMergeTreeDetails falls back to the caller no-base text', function() {
        var out = loadBranchSetup().collectMergeTreeDetails(
            makePrHelper(),
            makeExec([], { 'bash agents/scripts/git-merge-base-or-empty.sh HEAD origin/main': '' }),
            'main', 'NO-BASE-TEXT'
        );
        assert.equal(out, 'NO-BASE-TEXT');
    });

    test('collectMergeTreeDetails returns the raw error string on probe failure', function() {
        var exec = function (command) {
            if (command.indexOf('git-merge-base-or-empty.sh') !== -1) return 'abc\n';
            throw new Error('merge-tree failed');
        };
        var out = loadBranchSetup().collectMergeTreeDetails(makePrHelper(), exec, 'main', 'NO-BASE-TEXT');
        assert.ok(out.indexOf('Error: merge-tree failed') === 0);
    });
});

suite('branchSetup.writeBranchConflictGuidance', function() {

    function writtenContent(intro, guidance, notes) {
        var writes = [];
        var mod = loadBranchSetup({
            file_write: function (opts) { writes.push(opts); }
        });
        mod.writeBranchConflictGuidance('PROJ-1', 'dev/x', 'main', 'DETAILS', intro, guidance, notes);
        return writes.length === 1 ? writes[0] : null;
    }

    test('writes the guidance file with intro, guidance and notes', function() {
        var w = writtenContent('test automation work', 'GUIDANCE-PARA.', 'NOTES-PARA.');
        assert.equal(w.path, 'input/PROJ-1/merge_conflicts.md');
        assert.equal(w.content,
            '# Branch Conflict Guidance\n\n' +
            'Branch `dev/x` has test automation work that is not already merged into `origin/main`, ' +
            'and `origin/main` is not an ancestor of this branch.\n\n' +
            'GUIDANCE-PARA.\n\n' +
            'NOTES-PARA.\n\n' +
            'Details:\n\n```\nDETAILS\n```\n');
    });

    test('omits the notes paragraph when null (development variant)', function() {
        var w = writtenContent('work', 'DEV-GUIDANCE.', null);
        assert.equal(w.content,
            '# Branch Conflict Guidance\n\n' +
            'Branch `dev/x` has work that is not already merged into `origin/main`, ' +
            'and `origin/main` is not an ancestor of this branch.\n\n' +
            'DEV-GUIDANCE.\n\n' +
            'Details:\n\n```\nDETAILS\n```\n');
    });

    test('defaults missing details to a placeholder', function() {
        var writes = [];
        var mod = loadBranchSetup({
            file_write: function (opts) { writes.push(opts); }
        });
        mod.writeBranchConflictGuidance('PROJ-1', 'dev/x', 'main', '', 'work', 'G.', null);
        assert.ok(writes[0].content.indexOf('\n(not available)\n') !== -1);
    });

    test('write failure is a non-fatal warning', function() {
        var warns = [];
        var origWarn = console.warn;
        console.warn = function(msg) { warns.push(msg); };
        var mod = loadBranchSetup({
            file_write: function () { throw new Error('ro'); }
        });
        try {
            mod.writeBranchConflictGuidance('PROJ-1', 'dev/x', 'main', 'd', 'w', 'g', null);
        } finally {
            console.warn = origWarn;
        }
        assert.equal(warns.length, 1);
    });
});

suite('branchSetup.isAncestorRefRevList', function() {

    test('true when rev-list --not output is empty', function() {
        var out = loadBranchSetup().isAncestorRefRevList(
            makePrHelper(),
            makeExec([], { 'git rev-list -1 HEAD --not origin/main': '' }),
            'HEAD', 'origin/main', 'warn-prefix'
        );
        assert.equal(out, true);
    });

    test('false when a commit is listed', function() {
        var out = loadBranchSetup().isAncestorRefRevList(
            makePrHelper(),
            makeExec([], { 'git rev-list -1 HEAD --not origin/main': 'abc123\n' }),
            'HEAD', 'origin/main', 'warn-prefix'
        );
        assert.equal(out, false);
    });

    test('failure warns with the caller prefix and returns false', function() {
        var warns = [];
        var origWarn = console.warn;
        console.warn = function(msg) { warns.push(msg); };
        var out;
        try {
            out = loadBranchSetup().isAncestorRefRevList(makePrHelper(), function () { throw new Error('x'); }, 'HEAD', 'origin/main', 'Could not inspect branch ancestry for');
        } finally {
            console.warn = origWarn;
        }
        assert.equal(out, false);
        assert.equal(warns.length, 1);
        assert.ok(warns[0].indexOf('Could not inspect branch ancestry for HEAD -> origin/main:') === 0);
    });
});

suite('branchSetup.resolveInputParams', function() {

    test('resolves folder and ticket key from params.inputFolderPath', function() {
        var seen;
        var out = loadBranchSetup().resolveInputParams(
            { inputFolderPath: 'input/PROJ-9' },
            function (p) { seen = p; return CONFIG; }
        );
        assert.equal(out.actualParams.inputFolderPath, 'input/PROJ-9');
        assert.equal(out.folder, 'input/PROJ-9');
        assert.equal(out.ticketKey, 'PROJ-9');
        assert.equal(out.config, CONFIG);
        assert.deepEqual(seen, { inputFolderPath: 'input/PROJ-9' });
    });

    test('falls back to jobParams when inputFolderPath is absent', function() {
        var seen;
        var jobParams = { inputFolderPath: 'input/PROJ-10', marker: true };
        var out = loadBranchSetup().resolveInputParams(
            { jobParams: jobParams },
            function (p) { seen = p; return CONFIG; }
        );
        assert.equal(out.ticketKey, 'PROJ-10');
        assert.deepEqual(seen, jobParams);
    });
});

suite('branchSetup.findOpenTestPrForBranch / findPrForBranch', function() {

    function makeScm(openPrs, closedPrs) {
        return {
            listPrs: function (state) {
                if (state === 'open') return openPrs;
                return closedPrs || [];
            }
        };
    }

    test('findOpenTestPrForBranch returns the first matching open PR', function() {
        var pr = loadBranchSetup().findOpenTestPrForBranch(
            makeScm([{ number: 7, head: { ref: 'test/PROJ-1' } }, { number: 8, head: { ref: 'test/PROJ-2' } }]),
            'test/PROJ-2'
        );
        assert.equal(pr.number, 8);
    });

    test('findOpenTestPrForBranch returns null when nothing matches', function() {
        var pr = loadBranchSetup().findOpenTestPrForBranch(
            makeScm([{ number: 7, head: { ref: 'test/PROJ-1' } }]),
            'test/PROJ-9'
        );
        assert.equal(pr, null);
    });

    test('findPrForBranch uses Array.find semantics and warns on failure', function() {
        var pr = loadBranchSetup().findPrForBranch(
            makeScm([{ number: 3, head: { ref: 'test/PROJ-3' } }]),
            'test/PROJ-3',
            'warn:'
        );
        assert.equal(pr.number, 3);

        var warns = [];
        var origWarn = console.warn;
        console.warn = function(msg) { warns.push(msg); };
        var out;
        try {
            out = loadBranchSetup().findPrForBranch({ listPrs: function () { throw new Error('api down'); } }, 'test/X', 'Could not list open PRs for test branch:');
        } finally {
            console.warn = origWarn;
        }
        assert.equal(out, null);
        assert.deepEqual(warns, ['Could not list open PRs for test branch:']);
    });
});
