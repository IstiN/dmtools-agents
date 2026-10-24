/**
 * Unit tests: js/common/scm.js — normalization / remote-detection helpers
 * (gh-1194 CRAP ratchet).
 *
 * Two layers:
 *   1. Characterization — pin the CURRENT behavior of _normalizeGitLabPipelineStatus,
 *      _normalizeGitLabMr, _detectRepoFromGitRemote and createScm before the
 *      helper extraction (they must stay identical through the refactor).
 *   2. Direct helper tests — the pure field/parsing mappers the extraction
 *      introduces (exported like the gh-981 provider internals).
 */
/* global loadModule, assert, test, suite, makeRequire */

suite('scm normalize + detect (gh-1194)', function () {

    function loadScm(mocks) {
        return scmReal(mocks || {});
    }

    // A git remote that the github parser resolves, for detection-driven tests.
    var GITHUB_REMOTE = 'git@github.com:def/ult.git\n';

    // ── _normalizeGitLabPipelineStatus — full mapping table (characterization) ──

    test('pipeline status: every documented mapping (characterization)', function () {
        var scm = loadScm();
        var cases = [
            ['failure', 'failed'],
            ['failed', 'failed'],
            ['FAILURE', 'failed'],
            ['success', 'success'],
            ['succeeded', 'success'],
            ['Success', 'success'],
            ['in_progress', 'running'],
            ['IN_PROGRESS', 'running'],
            ['queued', 'pending'],
            ['pending', 'pending'],
            ['waiting', 'manual'],
            ['created', 'created'],      // unmapped → passthrough
            ['running', 'running'],      // unmapped → passthrough (already normalized)
            ['canceled', 'canceled']     // unmapped → passthrough
        ];
        for (var i = 0; i < cases.length; i++) {
            assert.equal(scm._normalizeGitLabPipelineStatus(cases[i][0]), cases[i][1],
                'status ' + cases[i][0]);
        }
    });

    test('pipeline status: falsy → null, unmapped non-string keeps the ORIGINAL value', function () {
        var scm = loadScm();
        assert.equal(scm._normalizeGitLabPipelineStatus(null), null);
        assert.equal(scm._normalizeGitLabPipelineStatus(''), null);
        assert.equal(scm._normalizeGitLabPipelineStatus(undefined), null);
        // Unmapped values return the ORIGINAL argument (not the lowercased form).
        var sentinel = { toString: function () { return 'WEIRD'; } };
        assert.equal(scm._normalizeGitLabPipelineStatus(sentinel), sentinel);
    });

    // ── _normalizeGitLabMr — both payload shapes (characterization) ────────────

    test('MR normalize: GitLab-native shape (characterization)', function () {
        var scm = loadScm();
        var mr = scm._normalizeGitLabMr({
            iid: 41,
            source_branch: 'ai/gh-41',
            target_branch: 'main',
            state: 'opened',
            web_url: 'https://gitlab.example.com/group/proj/-/merge_requests/41',
            labels: ['ai_developed'],
            sha: 'abc123',
            diff_refs: { base_sha: 'def456', head_sha: 'abc123', start_sha: 'abc123' },
            has_conflicts: false,
            detailed_merge_status: 'ci_still_running',
            merge_status: 'can_be_merged'
        });
        assert.deepEqual(mr, {
            iid: 41,
            source_branch: 'ai/gh-41',
            target_branch: 'main',
            state: 'opened',
            web_url: 'https://gitlab.example.com/group/proj/-/merge_requests/41',
            labels: ['ai_developed'],
            sha: 'abc123',
            diff_refs: { base_sha: 'def456', head_sha: 'abc123', start_sha: 'abc123' },
            has_conflicts: false,
            detailed_merge_status: 'ci_still_running',
            merge_status: 'can_be_merged',
            number: 41,
            html_url: 'https://gitlab.example.com/group/proj/-/merge_requests/41',
            merged_at: null,
            mergeable: true,
            mergeable_state: 'ci_still_running',
            head: { ref: 'ai/gh-41', sha: 'abc123' },
            base: { ref: 'main', sha: 'def456' }
        });
    });

    test('MR normalize: GitHub-ported shape + conflicts + missing fields (characterization)', function () {
        var scm = loadScm();
        var mr = scm._normalizeGitLabMr({
            number: 7,
            head: { ref: 'feature-x' },
            base: { ref: 'trunk' },
            html_url: 'https://gitlab.example.com/g/p/-/merge_requests/7',
            state: 'merged',
            merged_at: '2026-01-02T03:04:05Z',
            has_conflicts: true
        });
        // JSON-form comparison: keys absent from the payload stay absent
        // (no null-filling), head/base are rebuilt with ref + sha only.
        // Key order follows Object.assign({}, mr, override) — overrides last.
        assert.deepEqual(mr, {
            number: 7,
            head: { ref: 'feature-x' },
            base: { ref: 'trunk' },
            html_url: 'https://gitlab.example.com/g/p/-/merge_requests/7',
            state: 'merged',
            merged_at: '2026-01-02T03:04:05Z',
            has_conflicts: true,
            mergeable: false,
            mergeable_state: null,
            labels: []
        });
        assert.equal(mr.head.ref, 'feature-x');
        assert.equal(mr.base.ref, 'trunk');
        assert.equal(mr.number, 7);
    });

    test('MR normalize: falsy input passes through unchanged (characterization)', function () {
        var scm = loadScm();
        assert.equal(scm._normalizeGitLabMr(null), null);
        assert.equal(scm._normalizeGitLabMr(undefined), undefined);
        var empty = '';
        assert.equal(scm._normalizeGitLabMr(empty), empty);
    });

    suite('MR field mappers (gh-1194 extraction)', function () {
        var scm = loadScm();
        var ghShape = {
            id: 99,
            number: 41,
            source_branch: 'ai/gh-41',
            target_branch: 'main',
            web_url: 'https://x/g/p/-/mr/41',
            sha: 'headsha',
            diff_refs: { base_sha: 'basesha', head_sha: 'headsha' },
            head: { ref: 'gh-head-ref' },
            base: { ref: 'gh-base-ref' },
            detailed_merge_status: 'mergeable',
            merge_status: 'cannot_be_merged_recheck'
        };
        var nativeShape = {
            iid: 5,
            head: { ref: 'head-branch' },
            base: { ref: 'base-branch' },
            html_url: 'https://x/g/p/-/mr/5',
            diff_refs: { base_sha: 'b', head_sha: 'h' },
            merge_status: 'checking'
        };

        test('_mrSourceBranch / _mrTargetBranch: primary field, then head/base ref, then empty', function () {
            assert.equal(scm._mrSourceBranch(ghShape), 'ai/gh-41');
            assert.equal(scm._mrSourceBranch(nativeShape), 'head-branch');
            assert.equal(scm._mrSourceBranch({}), '');
            assert.equal(scm._mrTargetBranch(ghShape), 'main');
            assert.equal(scm._mrTargetBranch(nativeShape), 'base-branch');
            assert.equal(scm._mrTargetBranch({}), '');
        });

        test('_mrNumber: iid → number → id (in that order)', function () {
            assert.equal(scm._mrNumber({ iid: 1, number: 2, id: 3 }), 1);
            assert.equal(scm._mrNumber({ number: 2, id: 3 }), 2);
            assert.equal(scm._mrNumber({ id: 3 }), 3);
            assert.equal(scm._mrNumber({}), undefined);
        });

        test('_mrHtmlUrl: web_url → html_url → null', function () {
            assert.equal(scm._mrHtmlUrl({ web_url: 'w', html_url: 'h' }), 'w');
            assert.equal(scm._mrHtmlUrl({ html_url: 'h' }), 'h');
            assert.equal(scm._mrHtmlUrl({}), null);
        });

        test('_mrMergeableState: detailed_merge_status → merge_status → null', function () {
            assert.equal(scm._mrMergeableState(ghShape), 'mergeable');
            assert.equal(scm._mrMergeableState(nativeShape), 'checking');
            assert.equal(scm._mrMergeableState({}), null);
        });

        test('_mrHead / _mrBase: merged copy carries ref + sha (never mutates the payload)', function () {
            var head = scm._mrHead(ghShape, 'ai/gh-41');
            assert.deepEqual(head, { ref: 'ai/gh-41', sha: 'headsha' });
            assert.notEqual(head, ghShape.head, 'head must be a fresh object');
            var base = scm._mrBase(ghShape, 'main');
            assert.deepEqual(base, { ref: 'main', sha: 'basesha' });
            assert.notEqual(base, ghShape.base, 'base must be a fresh object');
            // head/base ref wins over the fallback field; sha falls back to diff_refs.
            assert.deepEqual(scm._mrHead(nativeShape, 'head-branch'), { ref: 'head-branch', sha: 'h' });
            assert.deepEqual(scm._mrBase(nativeShape, 'base-branch'), { ref: 'base-branch', sha: 'b' });
            // No diff_refs at all → base sha is undefined (JSON-dropped), not null.
            assert.deepEqual(scm._mrBase({}, 'r'), { ref: 'r' });
        });
    });

    // ── _detectRepoFromGitRemote + per-provider parsers (characterization) ─────

    suite('remote URL detection (gh-1194)', function () {
        test('github: https, ssh, .git suffix, multi-line junk filtering', function () {
            var scm = loadScm({ cli_execute_command: function () { return 'https://github.com/o/r.git\n'; } });
            assert.deepEqual(scm._detectRepoFromGitRemote('github'), { owner: 'o', repo: 'r' });
            scm = loadScm({ cli_execute_command: function () { return 'git@github.com:o/r.git'; } });
            assert.deepEqual(scm._detectRepoFromGitRemote('github'), { owner: 'o', repo: 'r' });
            scm = loadScm({
                cli_execute_command: function () {
                    return '  \njunk-line\n\ngit@github.com:example-org/example.repo.git\nCOMMAND_EXIT_CODE=0\n';
                }
            });
            assert.deepEqual(scm._detectRepoFromGitRemote('github'), { owner: 'example-org', repo: 'example.repo' });
        });

        test('github: no match → null (provider branch falls through)', function () {
            var scm = loadScm({ cli_execute_command: function () { return 'https://gitlab.example.com/g/p.git\n'; } });
            assert.equal(scm._detectRepoFromGitRemote('github'), null);
        });

        test('gitlab: ssh and https spellings, nested groups, query suffix', function () {
            var scm = loadScm({ cli_execute_command: function () { return 'git@gitlab.example.com:group/proj.git\n'; } });
            assert.deepEqual(scm._detectRepoFromGitRemote('gitlab'), { owner: 'group', repo: 'proj' });
            scm = loadScm({ cli_execute_command: function () { return 'ssh://git@gitlab.example.com/group/proj\n'; } });
            assert.deepEqual(scm._detectRepoFromGitRemote('gitlab'), { owner: 'group', repo: 'proj' });
            scm = loadScm({ cli_execute_command: function () { return 'https://gitlab.example.com/group/sub/proj.git\n'; } });
            assert.deepEqual(scm._detectRepoFromGitRemote('gitlab'), { owner: 'group/sub', repo: 'proj' });
            scm = loadScm({ cli_execute_command: function () { return 'https://gitlab.example.com/group/proj?foo=bar\n'; } });
            assert.deepEqual(scm._detectRepoFromGitRemote('gitlab'), { owner: 'group', repo: 'proj' });
        });

        test('gitlab: a foreign https host with owner/repo still parses (characterization — the regex is host-agnostic)', function () {
            var scm = loadScm({ cli_execute_command: function () { return 'git@github.com:o/r.git\n'; } });
            assert.deepEqual(scm._detectRepoFromGitRemote('gitlab'), { owner: 'o', repo: 'r' });
        });

        test('ado: https dev.azure.com and ssh v3 spellings', function () {
            var scm = loadScm({
                cli_execute_command: function () { return 'https://dev.azure.com/org/proj/_git/repo\n'; }
            });
            assert.deepEqual(scm._detectRepoFromGitRemote('ado'), { owner: 'org', repo: 'repo' });
            scm = loadScm({
                cli_execute_command: function () { return 'git@ssh.dev.azure.com:v3/org/proj/repo\n'; }
            });
            assert.deepEqual(scm._detectRepoFromGitRemote('ado'), { owner: 'org', repo: 'repo' });
        });

        test('ado: no match → null', function () {
            var scm = loadScm({ cli_execute_command: function () { return 'git@github.com:o/r.git\n'; } });
            assert.equal(scm._detectRepoFromGitRemote('ado'), null);
        });

        test('cli throw → null (fail-closed), empty output → null', function () {
            var scm = loadScm({ cli_execute_command: function () { throw new Error('boom'); } });
            assert.equal(scm._detectRepoFromGitRemote('github'), null);
            scm = loadScm({ cli_execute_command: function () { return ''; } });
            assert.equal(scm._detectRepoFromGitRemote('gitlab'), null);
            assert.equal(scm._detectRepoFromGitRemote('ado'), null);
        });

        test('_remoteUrlLine: first host-matching line, trimmed; none → empty string', function () {
            var scm = loadScm();
            assert.equal(
                scm._remoteUrlLine('garbage\n  https://github.com/o/r.git  \nmore'),
                'https://github.com/o/r.git');
            assert.equal(scm._remoteUrlLine('garbage\nnothing-hosty'), '');
            assert.equal(scm._remoteUrlLine(''), '');
            assert.equal(
                scm._remoteUrlLine('git@gitlab.example.com:g/p.git\ngit@github.com:o/r.git'),
                'git@gitlab.example.com:g/p.git');
        });

        test('per-provider pure parsers (gh-1194 extraction)', function () {
            var scm = loadScm();
            assert.deepEqual(scm._githubRepoFromRemote('https://github.com/o/r'), { owner: 'o', repo: 'r' });
            assert.deepEqual(scm._githubRepoFromRemote('github.com/o/r.git'), { owner: 'o', repo: 'r' });
            assert.equal(scm._githubRepoFromRemote('https://gitlab.example.com/g/p'), null);
            assert.deepEqual(scm._gitlabRepoFromRemote('git@gitlab.com:g/p.git'), { owner: 'g', repo: 'p' });
            assert.deepEqual(scm._gitlabRepoFromRemote('ssh://git@gitlab.com/g/p'), { owner: 'g', repo: 'p' });
            // Host-agnostic (characterization): any https host with owner/repo parses.
            assert.deepEqual(scm._gitlabRepoFromRemote('git@github.com:o/r.git'), { owner: 'o', repo: 'r' });
            assert.deepEqual(scm._adoRepoFromRemote('https://dev.azure.com/o/p/_git/r'), { owner: 'o', repo: 'r' });
            assert.deepEqual(scm._adoRepoFromRemote('ssh.dev.azure.com:v3/o/p/r'), { owner: 'o', repo: 'r' });
            assert.equal(scm._adoRepoFromRemote('https://github.com/o/r'), null);
        });
    });

    // ── createScm + config readers (characterization) ──────────────────────────

    suite('createScm wiring (gh-1194)', function () {
        test('config readers: null config, missing blocks, defaults', function () {
            var scm = loadScm();
            assert.equal(scm._scmProviderOf(null), 'github');
            assert.equal(scm._scmProviderOf({}), 'github');
            assert.equal(scm._scmProviderOf({ scm: {} }), 'github');
            assert.equal(scm._scmProviderOf({ scm: { provider: 'gitlab' } }), 'gitlab');
            assert.equal(scm._scmOwnerOf(null), '');
            assert.equal(scm._scmOwnerOf({ repository: { owner: 'o' } }), 'o');
            assert.equal(scm._scmRepoOf(null), '');
            assert.equal(scm._scmRepoOf({ repository: { repo: 'r' } }), 'r');
        });

        test('_applyDetectedRepo: explicit owner+repo skips detection entirely', function () {
            var scm = loadScm();
            assert.deepEqual(scm._applyDetectedRepo('o', 'r', 'github'), { owner: 'o', repo: 'r' });
        });

        test('_applyDetectedRepo: fills only the missing side (github remote)', function () {
            var scm = loadScm({ cli_execute_command: function () { return GITHUB_REMOTE; } });
            assert.deepEqual(scm._applyDetectedRepo('o', '', 'gitlab'), { owner: 'o', repo: 'ult' });
            assert.deepEqual(scm._applyDetectedRepo('', 'r', 'gitlab'), { owner: 'def', repo: 'r' });
            assert.deepEqual(scm._applyDetectedRepo('', '', 'gitlab'), { owner: 'def', repo: 'ult' });
        });

        test('_applyDetectedRepo: detection miss keeps the input unchanged', function () {
            var scm = loadScm({ cli_execute_command: function () { return ''; } });
            assert.deepEqual(scm._applyDetectedRepo('o', '', 'gitlab'), { owner: 'o', repo: '' });
            assert.deepEqual(scm._applyDetectedRepo('', 'r', 'ado'), { owner: '', repo: 'r' });
        });

        test('createScm picks the provider by config and passes owner/repo through', function () {
            var calls = [];
            var scm = loadScm({
                github_list_prs: function (args) { calls.push(['github', args]); return []; },
                gitlab_list_mrs: function (args) { calls.push(['gitlab', args]); return []; },
                ado_list_prs: function (args) { calls.push(['ado', args]); return []; },
                cli_execute_command: function () { return GITHUB_REMOTE; }
            });
            scm.createScm({ repository: { owner: 'o', repo: 'r' } }).listPrs('open');
            scm.createScm({ scm: { provider: 'gitlab' }, repository: { owner: 'o', repo: 'r' } }).listPrs('open');
            scm.createScm({ scm: { provider: 'ado' }, repository: { owner: 'o', repo: 'r' } }).listPrs('open');
            assert.deepEqual(calls, [
                ['github', { workspace: 'o', repository: 'r', state: 'open' }],
                ['gitlab', { workspace: 'o', repository: 'r', state: 'opened' }],
                ['ado', { repository: 'r', status: 'active' }]
            ]);
        });

        test('createScm: ADO auto-detect fills the repo from the git remote', function () {
            var calls = [];
            var scm = loadScm({
                ado_list_prs: function (args) { calls.push(args); return []; },
                cli_execute_command: function () { return 'https://dev.azure.com/org/proj/_git/repo\n'; }
            });
            scm.createScm({ scm: { provider: 'ado' } }).listPrs('open');
            assert.deepEqual(calls, [{ repository: 'repo', status: 'active' }]);
        });
    });
});
