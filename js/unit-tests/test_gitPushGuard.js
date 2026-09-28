/**
 * Unit tests for js/common/gitPushGuard.js — the canonical rule set behind
 * the agent-session git push/commit guard (dmtools-agents#542).
 *
 * RCA: 2026-09-26/27 night, machine loop gh-992 (IstiN/flutter_agent_harness)
 * — a rework agent leg crafted a commit tagged "(closes #992)" and pushed it
 * DIRECTLY to main (fa 8411523), bypassing PR + validation. Prompts saying
 * "do not push" proved insufficient; these tests pin the mechanical rules.
 *
 * The executable enforcement point is scripts/git-push-guard.sh (a `git` PATH
 * shim). The last suite pins shim ↔ module rule parity so the two cannot
 * silently drift apart.
 *
 * Uses: loadModule(), makeRequire(), assert, test(), suite()
 */

function loadGitPushGuard() {
    return loadModule('js/common/gitPushGuard.js', makeRequire({}), {});
}

suite('gitPushGuard.evaluatePush — protected branch refusals', function() {
    var guard = loadGitPushGuard();

    test('refuses: git push origin main', function() {
        var r = guard.evaluatePush(['origin', 'main'], { knownRemotes: ['origin'], currentBranch: 'main' });
        assert.equal(r.allowed, false);
        assert.contains(r.violations[0], 'main');
    });

    test('refuses: git push origin master', function() {
        var r = guard.evaluatePush(['origin', 'master'], { knownRemotes: ['origin'], currentBranch: 'master' });
        assert.equal(r.allowed, false);
    });

    test('refuses: git push origin HEAD:main (the gh-992 incident shape)', function() {
        var r = guard.evaluatePush(['origin', 'HEAD:main'], { knownRemotes: ['origin'], currentBranch: 'ai/gh-992' });
        assert.equal(r.allowed, false);
        assert.contains(r.violations[0], 'protected branch "main"');
    });

    test('refuses: git push origin feature:refs/heads/main', function() {
        var r = guard.evaluatePush(['origin', 'feature:refs/heads/main'], { knownRemotes: ['origin'], currentBranch: 'feature' });
        assert.equal(r.allowed, false);
    });

    test('refuses: git push origin :main (branch deletion)', function() {
        var r = guard.evaluatePush(['origin', ':main'], { knownRemotes: ['origin'], currentBranch: 'ai/gh-1' });
        assert.equal(r.allowed, false);
    });

    test('refuses: git push origin --delete main', function() {
        var r = guard.evaluatePush(['origin', '--delete', 'main'], { knownRemotes: ['origin'], currentBranch: 'ai/gh-1' });
        assert.equal(r.allowed, false);
    });

    test('refuses: bare git push while main is checked out', function() {
        var r = guard.evaluatePush(['origin'], { knownRemotes: ['origin'], currentBranch: 'main' });
        assert.equal(r.allowed, false);
        assert.contains(r.violations[0], 'main');
    });

    test('refuses: bare git push (no remote) while main is checked out', function() {
        var r = guard.evaluatePush([], { knownRemotes: ['origin'], currentBranch: 'main' });
        assert.equal(r.allowed, false);
    });

    test('refuses: git push --mirror (pushes everything incl. protected)', function() {
        var r = guard.evaluatePush(['--mirror', 'origin'], { knownRemotes: ['origin'], currentBranch: 'ai/gh-1' });
        assert.equal(r.allowed, false);
        assert.contains(r.violations[0], '--mirror');
    });

    test('refuses: git push --all', function() {
        var r = guard.evaluatePush(['origin', '--all'], { knownRemotes: ['origin'], currentBranch: 'ai/gh-1' });
        assert.equal(r.allowed, false);
        assert.contains(r.violations[0], '--all');
    });

    test('refuses: remote default branch beyond main/master (origin/HEAD = develop)', function() {
        var r = guard.evaluatePush(['origin', 'develop'], {
            knownRemotes: ['origin'],
            currentBranch: 'develop',
            defaultBranch: 'develop'
        });
        assert.equal(r.allowed, false);
    });

    test('refuses: extra protected branches via FA_GIT_GUARD_PROTECTED_BRANCHES', function() {
        var r = guard.evaluatePush(['origin', 'release/1.0'], {
            knownRemotes: ['origin'],
            currentBranch: 'release/1.0',
            extraProtected: guard.parseProtectedList('develop, release/1.0')
        });
        assert.equal(r.allowed, false);
    });
});

suite('gitPushGuard.evaluatePush — allowed agent pushes', function() {
    var guard = loadGitPushGuard();

    test('allows: git push -u origin ai/gh-123 (PR head branch)', function() {
        var r = guard.evaluatePush(['-u', 'origin', 'ai/gh-123'], { knownRemotes: ['origin'], currentBranch: 'ai/gh-123' });
        assert.equal(r.allowed, true, JSON.stringify(r.violations));
    });

    test('allows: git push origin ai/gh-123 while on ai/gh-123', function() {
        var r = guard.evaluatePush(['origin', 'ai/gh-123'], { knownRemotes: ['origin'], currentBranch: 'ai/gh-123' });
        assert.equal(r.allowed, true);
    });

    test('allows: bare git push while a feature branch is checked out', function() {
        var r = guard.evaluatePush(['origin'], { knownRemotes: ['origin'], currentBranch: 'ai/gh-123' });
        assert.equal(r.allowed, true);
    });

    test('allows: git push origin HEAD while on a feature branch', function() {
        var r = guard.evaluatePush(['origin', 'HEAD'], { knownRemotes: ['origin'], currentBranch: 'ai/gh-123' });
        assert.equal(r.allowed, true);
    });

    test('allows: git push origin HEAD:ai/gh-123', function() {
        var r = guard.evaluatePush(['origin', 'HEAD:ai/gh-123'], { knownRemotes: ['origin'], currentBranch: 'ai/gh-123' });
        assert.equal(r.allowed, true);
    });

    test('allows: tag pushes (not a branch ref)', function() {
        var r = guard.evaluatePush(['origin', 'v1.2.3'], { knownRemotes: ['origin'], currentBranch: 'main' });
        assert.equal(r.allowed, true);
    });

    test('allows: force push to a feature branch', function() {
        var r = guard.evaluatePush(['origin', 'ai/gh-123', '--force-with-lease'], { knownRemotes: ['origin'], currentBranch: 'ai/gh-123' });
        assert.equal(r.allowed, true);
    });

    test('allows: push to URL remote with feature refspec', function() {
        var r = guard.evaluatePush(['git@github.com:org/repo.git', 'ai/gh-123'], { knownRemotes: ['origin'], currentBranch: 'ai/gh-123' });
        assert.equal(r.allowed, true);
        assert.equal(r.parsed.remote, 'git@github.com:org/repo.git');
    });
});

suite('gitPushGuard.extractSubcommand — global git options', function() {
    var guard = loadGitPushGuard();

    test('plain subcommand', function() {
        var r = guard.extractSubcommand(['push', 'origin', 'main']);
        assert.equal(r.subcommand, 'push');
        assert.deepEqual(r.args, ['origin', 'main']);
    });

    test('skips -C <dir>', function() {
        var r = guard.extractSubcommand(['-C', '/repo', 'push', 'origin', 'main']);
        assert.equal(r.subcommand, 'push');
        assert.deepEqual(r.args, ['origin', 'main']);
    });

    test('skips -c k=v and joined --git-dir', function() {
        var r = guard.extractSubcommand(['-c', 'fetch.recurseSubmodules=no', '--git-dir=/r/.git', 'commit', '-m', 'x']);
        assert.equal(r.subcommand, 'commit');
        assert.deepEqual(r.args, ['-m', 'x']);
    });
});

suite('gitPushGuard.evaluateCommit — closing-keyword detection', function() {
    var guard = loadGitPushGuard();

    test('refuses: (closes #992) — the incident message', function() {
        var r = guard.evaluateCommit(['-m', 'GH-992 fix loop (closes #992)']);
        assert.equal(r.allowed, false);
        assert.contains(r.violations[0], 'closes #992');
    });

    test('refuses: fixes #N, case-insensitive', function() {
        assert.equal(guard.evaluateCommit(['-m', 'Fixes #42']).allowed, false);
        assert.equal(guard.evaluateCommit(['-m', 'RESOLVES #7']).allowed, false);
        assert.equal(guard.evaluateCommit(['-m', 'close #1']).allowed, false);
    });

    test('refuses: cross-repo and URL references', function() {
        assert.equal(guard.evaluateCommit(['-m', 'closes IstiN/dmtools-agents#542']).allowed, false);
        assert.equal(guard.evaluateCommit(['-m', 'fixes https://github.com/org/repo/issues/12']).allowed, false);
    });

    test('refuses: keyword in any of multiple -m parts', function() {
        var r = guard.evaluateCommit(['-m', 'subject', '-m', 'body text\n\nresolves #9']);
        assert.equal(r.allowed, false);
    });

    test('refuses: keyword via --message= joined form and -F file', function() {
        assert.equal(guard.evaluateCommit(['--message=closes #3']).allowed, false);
        assert.equal(guard.evaluateCommit(['-F', 'msg.txt'], { 'msg.txt': 'work\n\nfixes #11' }).allowed, false);
    });

    test('allows: conventional fix(scope) subject without #', function() {
        assert.equal(guard.evaluateCommit(['-m', 'fix(542): guard agent pushes']).allowed, true);
    });

    test('allows: "fixed 42 tests" — no issue reference, no auto-close on GitHub', function() {
        assert.equal(guard.evaluateCommit(['-m', 'fixed 42 tests']).allowed, true);
    });

    test('allows: normal agent commit messages', function() {
        assert.equal(guard.evaluateCommit(['-m', 'GH-123 Rework: address PR review comments']).allowed, true);
        assert.equal(guard.evaluateCommit(['-m', 'GH-992 fix loop']).allowed, true);
        assert.equal(guard.evaluateCommit(['-m', 'mention issue #42 without keyword']).allowed, true);
    });

    test('findClosingKeywords: collects multiple matches', function() {
        var m = guard.findClosingKeywords('closes #1 and fixes #2');
        assert.equal(m.length, 2);
        assert.equal(guard.findClosingKeywords('nothing here').length, 0);
        assert.equal(guard.findClosingKeywords(null).length, 0);
    });
});

suite('gitPushGuard — shim parity (scripts/git-push-guard.sh)', function() {
    var guard = loadGitPushGuard();
    var shim = file_read({ path: 'scripts/git-push-guard.sh' });

    test('shim exists and is a git wrapper with a loud refusal', function() {
        assert.ok(shim && shim.length > 1000, 'shim script missing or suspiciously small');
        assert.contains(shim, 'GIT PUSH GUARD');
        assert.contains(shim, 'dmtools-agents#542');
        assert.contains(shim, 'exit 2');
    });

    test('shim protects the same default branches as the module', function() {
        guard.PROTECTED_BRANCHES.forEach(function(b) {
            assert.contains(shim, b, 'shim is missing protected branch ' + b);
        });
        assert.contains(shim, '_protected=" main master "');
    });

    test('shim uses the same closing-keyword class as the module', function() {
        // Both must recognize the same keyword stems and the #N reference form.
        ['close[sd]?', 'fix(e[sd])?', 'resolve[sd]?', '#[0-9]+'].forEach(function(fragment) {
            assert.contains(shim, fragment, 'shim regex missing ' + fragment);
        });
        // The module regex must accept everything the shim regex shape describes.
        var shimShape = 'closes #992';
        assert.ok(guard.CLOSING_KEYWORD_PATTERN.test(shimShape));
    });

    test('shim covers the same push shapes as the module', function() {
        ['--mirror', '--all', '--delete', 'refs/heads/', 'rev-parse --abbrev-ref HEAD'].forEach(function(fragment) {
            assert.contains(shim, fragment, 'shim missing push handling for ' + fragment);
        });
    });

    test('shim exposes the same env knobs', function() {
        ['FA_GIT_GUARD_OFF', 'FA_GIT_GUARD_ALLOW_CLOSING_KEYWORDS', 'FA_GIT_GUARD_PROTECTED_BRANCHES'].forEach(function(knob) {
            assert.contains(shim, knob, 'shim missing env knob ' + knob);
        });
    });

    test('shim is wired into the session entrypoints', function() {
        var runAgent = file_read({ path: 'scripts/run-agent.sh' });
        assert.contains(runAgent, 'git-push-guard.sh');
        assert.contains(runAgent, 'export PATH="${GIT_GUARD_DIR}:${PATH}"');
        var workflow = file_read({ path: '.github/workflows/factory-teammate.yml' });
        assert.contains(workflow, 'factory-agents/scripts/git-push-guard.sh');
        assert.contains(workflow, 'export PATH="${GIT_GUARD_BIN}:${PATH}"');
    });

    // RCA 2026-09-28: two guard copies on PATH (factory step + run-agent.sh)
    // resolved each other as "real git" and exec-looped forever — every git
    // call in the session froze (child stuck in anon_pipe_read, fd 255 on
    // the guard script). These tests pin the double-install defenses.
    test('shim real-git resolution skips sibling guard copies', function() {
        // Not just "$_cand_resolved != $_self_resolved" — a second copy is a
        // DIFFERENT file, so self-comparison alone does not break the loop.
        assert.contains(shim, '*/git-push-guard.sh) continue;;');
    });

    test('run-agent.sh does not arm a second shim when one is already on PATH', function() {
        var runAgent = file_read({ path: 'scripts/run-agent.sh' });
        assert.contains(runAgent, 'already armed on PATH');
    });
});
