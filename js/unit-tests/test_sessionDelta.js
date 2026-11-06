/**
 * Unit + Integration tests for js/common/sessionDelta.js, preCliReworkSetup.js
 * integration, and scripts/providers/{_common.sh,fa.sh} (gh-1064).
 *
 * Covers:
 *   - AC1: Composite resume prompt embeds session_delta.md inline + pointer to prompt_file
 *   - AC2: Human comment / review thread capture since previous manifest watermark
 *   - AC3: Session-co-located storage (.session-input-manifest.json in session root) & quarantine safety
 *   - AC4: Post-turn commit (promote_pending_session_manifest only on exit 0)
 *   - AC5: Adapter seam & SCM parity (GitHub PR and GitLab MR fixtures produce identical structure)
 *   - AC6: Fallbacks (missing manifest -> FIRST-LEG, corrupt manifest -> CORRUPT-MANIFEST fail-open)
 *   - UT-1..UT-4, IT-1, REG-1
 *
 * Uses: loadModule(), makeRequire(), suite(), test(), assert, cli_execute_command()
 */
'use strict';

var sessionDelta = loadModule('js/common/sessionDelta.js');

function makeMemoryStorage(initialState) {
    var state = Object.assign({
        hasSession: true,
        sessionDir: '/tmp/fake-session-root',
        files: {}
    }, initialState || {});

    return {
        state: state,
        readFile: function(path) {
            return Object.prototype.hasOwnProperty.call(state.files, path) ? state.files[path] : null;
        },
        writeFile: function(path, content) {
            state.files[path] = String(content);
            return true;
        },
        listFiles: function(dirPath) {
            var prefix = dirPath.replace(/\/+$/, '') + '/';
            var out = [];
            Object.keys(state.files).forEach(function(k) {
                if (k.indexOf(prefix) === 0) {
                    var rest = k.substring(prefix.length);
                    if (rest && rest.indexOf('/') === -1) out.push(k);
                }
            });
            return out.sort();
        }
    };
}

suite('sessionDelta — UT-1: buildInputSnapshot & SCM parity (AC5)', function() {

    test('hashes input/<ticket>/ files deterministically while excluding session_delta.md and .pending-input-manifest.json', function() {
        var snap = sessionDelta.buildInputSnapshot('input/GH-1064', {
            recordedAt: '2026-10-20T00:00:00.000Z',
            inputFiles: {
                'pr_info.md': '# Pull Request Information\n\n- **PR #**: 10\n- **Branch**: `feat/x` → `main`\n- **State**: open\n',
                'pr_diff.txt': 'diff --git a/a.js b/a.js\n+var x = 1;\n',
                'rework_base_head.txt': 'sha-leg-1',
                'review_state.md': '# Review State\n\n**Review decision: `CHANGES_REQUESTED`**\n',
                'session_delta.md': 'should be excluded',
                '.pending-input-manifest.json': '{"excluded":true}'
            }
        });

        assert.equal(snap.ticketKey, 'GH-1064');
        assert.equal(snap.headSha, 'sha-leg-1');
        assert.equal(snap.baseBranch, 'main');
        assert.equal(snap.reviewDecision, 'CHANGES_REQUESTED');
        assert.deepEqual(Object.keys(snap.files), [
            'pr_diff.txt',
            'pr_info.md',
            'review_state.md',
            'rework_base_head.txt'
        ]);
        assert.equal(snap.files['session_delta.md'], undefined);
        assert.equal(snap.files['.pending-input-manifest.json'], undefined);
        assert.ok(snap.files['pr_diff.txt'].hash.indexOf('fnv1a64:') === 0);
        assert.equal(snap.files['pr_diff.txt'].size, 37);
    });

    test('AC5 SCM parity: GitHub PR and GitLab MR fixtures produce identical SCM-neutral comment/thread structures', function() {
        var githubRawThreads = JSON.stringify({
            threads: [{
                threadId: 'PRT_kwDO123',
                rootCommentId: 9001,
                author: 'alice',
                date: '2026-10-20',
                path: 'js/app.js',
                line: 42,
                resolved: false,
                body: 'Please handle null input here.'
            }]
        });
        var gitlabRawThreads = JSON.stringify({
            threads: [{
                discussionId: 'PRT_kwDO123',
                threadId: 'PRT_kwDO123',
                rootCommentId: 'PRT_kwDO123',
                author: 'alice',
                created_at: '2026-10-20',
                path: 'js/app.js',
                line: 42,
                resolved: false,
                body: 'Please handle null input here.'
            }]
        });

        var ghSnap = sessionDelta.buildInputSnapshot('input/PROJ-1', {
            recordedAt: '2026-10-20T00:00:00Z',
            headSha: 'abc1234',
            baseBranch: 'main',
            reviewDecision: 'CHANGES_REQUESTED',
            inputFiles: {
                'pr_discussions_raw.json': githubRawThreads
            }
        });
        var glSnap = sessionDelta.buildInputSnapshot('input/PROJ-1', {
            recordedAt: '2026-10-20T00:00:00Z',
            headSha: 'abc1234',
            baseBranch: 'main',
            reviewDecision: 'CHANGES_REQUESTED',
            inputFiles: {
                'pr_discussions_raw.json': gitlabRawThreads
            }
        });

        assert.deepEqual(ghSnap.comments, glSnap.comments);
        assert.equal(ghSnap.comments.length, 1);
        assert.equal(ghSnap.comments[0].id, 'PRT_kwDO123');
        assert.equal(ghSnap.comments[0].author, 'alice');
        assert.equal(ghSnap.comments[0].location, 'js/app.js:42');
        assert.equal(ghSnap.comments[0].body, 'Please handle null input here.');
    });

    test('extracts general PR comments from pr_discussions.md and comments.md plus thread replies', function() {
        var rawJson = JSON.stringify({
            threads: [{
                threadId: 'T-1',
                author: 'reviewer1',
                date: '2026-10-19',
                path: 'src/x.js',
                line: 10,
                resolved: false,
                body: 'Root thread comment',
                replies: [{
                    id: 'R-100',
                    author: 'human-dev',
                    date: '2026-10-20',
                    body: 'Follow-up reply inside thread'
                }]
            }]
        });
        var discussionsMd = [
            '# PR Discussion History',
            '',
            '## General PR Comments',
            '',
            '**product-owner** (2026-10-20):',
            '',
            'Can we also log a warning when manifest is corrupt?',
            '',
            '---',
            ''
        ].join('\n');

        var snap = sessionDelta.buildInputSnapshot('input/GH-1064', {
            inputFiles: {
                'pr_discussions_raw.json': rawJson,
                'pr_discussions.md': discussionsMd
            }
        });

        assert.equal(snap.comments.length, 3);
        assert.equal(snap.comments[0].id, 'T-1');
        assert.equal(snap.comments[1].id, 'R-100');
        assert.equal(snap.comments[1].body, 'Follow-up reply inside thread');
        assert.equal(snap.comments[2].author, 'product-owner');
        assert.contains(snap.comments[2].body, 'Can we also log a warning');
    });
});

suite('sessionDelta — UT-2: computeSessionDelta & comment watermark (AC2, AC6)', function() {

    test('AC2: identifies added, changed, unchanged, removed files and quotes new comments/threads since previous watermark', function() {
        var leg1 = sessionDelta.buildInputSnapshot('input/GH-1064', {
            recordedAt: '2026-10-20T01:00:00Z',
            headSha: 'sha-111',
            baseBranch: 'main',
            reviewDecision: 'CHANGES_REQUESTED',
            labels: ['agent:rework'],
            inputFiles: {
                'pr_info.md': 'info v1',
                'pr_diff.txt': 'diff v1',
                'ci_failures.md': 'ci red v1',
                'old_note.md': 'to be removed',
                'pr_discussions_raw.json': JSON.stringify({
                    threads: [{
                        threadId: 'T-1',
                        author: 'reviewer',
                        date: '2026-10-20',
                        path: 'a.js',
                        line: 5,
                        body: 'Thread 1 from leg 1'
                    }]
                })
            }
        });

        var leg2 = sessionDelta.buildInputSnapshot('input/GH-1064', {
            recordedAt: '2026-10-20T02:00:00Z',
            headSha: 'sha-222',
            baseBranch: 'main',
            reviewDecision: 'APPROVED',
            labels: ['agent:rework', 'ready-to-merge'],
            inputFiles: {
                'pr_info.md': 'info v1',
                'pr_diff.txt': 'diff v2 updated',
                'ci_failures.md': 'ci green v2',
                'new_questions.md': 'question 1',
                'pr_discussions_raw.json': JSON.stringify({
                    threads: [
                        {
                            threadId: 'T-1',
                            author: 'reviewer',
                            date: '2026-10-20',
                            path: 'a.js',
                            line: 5,
                            body: 'Thread 1 from leg 1'
                        },
                        {
                            threadId: 'T-2',
                            author: 'owner',
                            date: '2026-10-20',
                            path: 'b.js',
                            line: 19,
                            body: 'New human review comment in leg 2'
                        }
                    ]
                })
            }
        });

        var delta = sessionDelta.computeSessionDelta(leg1, leg2);
        assert.equal(delta.mode, 'DELTA');
        assert.deepEqual(delta.headTransition, { from: 'sha-111', to: 'sha-222', changed: true });
        assert.deepEqual(delta.reviewDecisionTransition, { from: 'CHANGES_REQUESTED', to: 'APPROVED', changed: true });
        assert.deepEqual(delta.labelDiff, { added: ['ready-to-merge'], removed: [] });
        assert.deepEqual(delta.files.added, ['new_questions.md']);
        assert.deepEqual(delta.files.changed, ['ci_failures.md', 'pr_diff.txt', 'pr_discussions_raw.json']);
        assert.deepEqual(delta.files.unchanged, ['pr_info.md']);
        assert.deepEqual(delta.files.removed, ['old_note.md']);
        assert.equal(delta.newComments.length, 1);
        assert.equal(delta.newComments[0].id, 'T-2');
        assert.equal(delta.newComments[0].author, 'owner');
        assert.equal(delta.newComments[0].body, 'New human review comment in leg 2');

        var md = sessionDelta.renderSessionDeltaMd(delta);
        assert.contains(md, '- **Mode**: `DELTA`');
        assert.contains(md, '- **HEAD SHA**: `sha-111` → `sha-222` *(changed)*');
        assert.contains(md, '- **NEW** (1): `new_questions.md`');
        assert.contains(md, '- **CHANGED** (3): `ci_failures.md`, `pr_diff.txt`, `pr_discussions_raw.json`');
        assert.contains(md, '- **UNCHANGED** (1): `pr_info.md`');
        assert.contains(md, '- **REMOVED** (1): `old_note.md`');
        assert.contains(md, '### 1. `T-2` — **owner** (`b.js:19`)');
        assert.contains(md, 'New human review comment in leg 2');
    });

    test('AC6: missing manifest produces FIRST-LEG marker and marks all current files as NEW', function() {
        var snap = sessionDelta.buildInputSnapshot('input/GH-1064', {
            headSha: 'sha-100',
            inputFiles: { 'pr_info.md': 'v1', 'pr_diff.txt': 'd1' }
        });
        var delta = sessionDelta.computeSessionDelta(null, snap);
        assert.equal(delta.mode, 'FIRST-LEG');
        assert.deepEqual(delta.files.added, ['pr_diff.txt', 'pr_info.md']);
        assert.deepEqual(delta.files.unchanged, []);

        var md = sessionDelta.renderSessionDeltaMd(delta);
        assert.contains(md, '- **Mode**: `FIRST-LEG`');
        assert.contains(md, 'Read all files in `input/` in full (`FIRST-LEG` — do not rely on prior memory).');
    });

    test('AC6: corrupt manifest produces CORRUPT-MANIFEST fail-open warning and marks all files as CHANGED', function() {
        var snap = sessionDelta.buildInputSnapshot('input/GH-1064', {
            headSha: 'sha-100',
            inputFiles: { 'pr_info.md': 'v1', 'pr_diff.txt': 'd1' }
        });
        var delta = sessionDelta.computeSessionDelta(null, snap, {
            corruptManifest: true,
            corruptReason: 'Unexpected token in JSON'
        });
        assert.equal(delta.mode, 'CORRUPT-MANIFEST');
        assert.contains(delta.warning, 'Unexpected token in JSON');
        assert.deepEqual(delta.files.changed, ['pr_diff.txt', 'pr_info.md']);
        assert.deepEqual(delta.files.unchanged, []);

        var md = sessionDelta.renderSessionDeltaMd(delta);
        assert.contains(md, '- **Mode**: `CORRUPT-MANIFEST`');
        assert.contains(md, 'Warning');
        assert.contains(md, 'Read all files in `input/` in full (`CORRUPT-MANIFEST` — do not rely on prior memory).');
    });
});

suite('sessionDelta — UT-3: session-co-located storage, quarantine safety & post-turn commit (AC3, AC4, AC5)', function() {

    test('AC3: resolves session state directory from FA_SESSION_ROOT / provider env or deterministic fallback', function() {
        // env maps must override EVERY ladder name (empty string = blocked) —
        // otherwise a host-exported FA_SESSION_ROOT/COPILOT_HOME leaks into the assertion
        var blocked = { FA_SESSION_ROOT: '', COPILOT_HOME: '', KIMI_CODE_HOME: '', CURSOR_SESSION_CACHE_PATH: '' };
        assert.equal(
            sessionDelta.resolveSessionStateDir({ env: Object.assign({}, blocked, { FA_SESSION_ROOT: '/workspace/.dmtools/fa-sessions/r/k/dev-write/' }) }),
            '/workspace/.dmtools/fa-sessions/r/k/dev-write'
        );
        assert.equal(
            sessionDelta.resolveSessionStateDir({ env: Object.assign({}, blocked, { COPILOT_HOME: '/tmp/copilot-home' }) }),
            '/tmp/copilot-home'
        );
        assert.equal(
            sessionDelta.resolveSessionStateDir({
                repo: 'IstiN/dmtools-agents',
                ticketKey: 'GH-1064',
                configFile: 'agents/pr_rework.json',
                workspace: '/work',
                env: { FA_SESSION_ROOT: '', COPILOT_HOME: '', KIMI_CODE_HOME: '', CURSOR_SESSION_CACHE_PATH: '' }
            }),
            '/work/.dmtools/fa-sessions/istin-dmtools-agents/gh-1064/dev-write'
        );
    });

    test('AC3 quarantine safety: if session directory has no active session transcript on disk, treats leg as FIRST-LEG even if a stale manifest exists', function() {
        var mem = makeMemoryStorage({ sessionDir: '/sess' });
        // Only the manifest exists, no session .jsonl / store.db (simulating quarantined/empty session)
        mem.writeFile('/sess/.session-input-manifest.json', JSON.stringify({
            schemaVersion: 1,
            headSha: 'old',
            files: { 'pr_info.md': { hash: 'fnv1a64:0000', size: 10 } },
            comments: []
        }));
        mem.writeFile('input/GH-1064/pr_info.md', 'new info');

        var res = sessionDelta.prepareLegSessionDelta({
            inputFolder: 'input/GH-1064',
            sessionStateDir: '/sess',
            readFile: mem.readFile,
            writeFile: mem.writeFile,
            listFiles: mem.listFiles
        });

        assert.equal(res.ok, true);
        assert.equal(res.readStatus, 'NO_ACTIVE_SESSION');
        assert.equal(res.mode, 'FIRST-LEG');
        assert.contains(mem.readFile('input/GH-1064/session_delta.md'), '`FIRST-LEG`');
    });

    test('AC4 post-turn commit: prepareLegSessionDelta writes .pending-input-manifest.json without overwriting .session-input-manifest.json until commitPendingManifest', function() {
        var mem = makeMemoryStorage({ sessionDir: '/sess' });
        // Active session file present on disk
        mem.writeFile('/sess/session-1.jsonl', '{"turn":1}\n');
        mem.writeFile('input/GH-1064/pr_info.md', '# PR\n- **Branch**: `feat/1` → `main`\n');
        mem.writeFile('input/GH-1064/rework_base_head.txt', 'sha-leg-1');

        // Leg 1 pre-CLI
        var leg1 = sessionDelta.prepareLegSessionDelta({
            inputFolder: 'input/GH-1064',
            sessionStateDir: '/sess',
            readFile: mem.readFile,
            writeFile: mem.writeFile,
            listFiles: mem.listFiles
        });
        assert.equal(leg1.mode, 'FIRST-LEG');
        assert.equal(mem.readFile('/sess/.session-input-manifest.json'), null,
            'manifest in session dir must NOT be written before the CLI turn completes');
        assert.ok(mem.readFile('input/GH-1064/.pending-input-manifest.json'),
            'pending manifest is staged in input/<ticket>/');

        // Simulate Leg 1 CLI turn succeeding -> commitPendingManifest
        var committed = sessionDelta.defaultDeltaStorage.commitPendingManifest({
            inputFolder: 'input/GH-1064',
            sessionStateDir: '/sess',
            readFile: mem.readFile,
            writeFile: mem.writeFile
        });
        assert.equal(committed, true);
        assert.ok(mem.readFile('/sess/.session-input-manifest.json'),
            'session manifest promoted after turn completion');

        // Leg 2 pre-CLI: human adds a review thread, head SHA advances, but CLI crashes mid-turn
        mem.writeFile('input/GH-1064/rework_base_head.txt', 'sha-leg-2');
        mem.writeFile('input/GH-1064/pr_discussions_raw.json', JSON.stringify({
            threads: [{ threadId: 'T-99', author: 'reviewer', path: 'x.js', line: 1, body: 'Fix edge case' }]
        }));

        var leg2Attempt1 = sessionDelta.prepareLegSessionDelta({
            inputFolder: 'input/GH-1064',
            sessionStateDir: '/sess',
            readFile: mem.readFile,
            writeFile: mem.writeFile,
            listFiles: mem.listFiles
        });
        assert.equal(leg2Attempt1.mode, 'DELTA');
        assert.equal(leg2Attempt1.delta.newComments.length, 1);
        assert.equal(leg2Attempt1.delta.newComments[0].id, 'T-99');

        // Simulate CLI exit != 0 (no commitPendingManifest called).
        // Retry of Leg 2 must STILL see the exact same delta against Leg 1's manifest!
        var leg2Retry = sessionDelta.prepareLegSessionDelta({
            inputFolder: 'input/GH-1064',
            sessionStateDir: '/sess',
            readFile: mem.readFile,
            writeFile: mem.writeFile,
            listFiles: mem.listFiles
        });
        assert.equal(leg2Retry.mode, 'DELTA');
        assert.equal(leg2Retry.delta.headTransition.from, 'sha-leg-1');
        assert.equal(leg2Retry.delta.headTransition.to, 'sha-leg-2');
        assert.equal(leg2Retry.delta.newComments.length, 1);
        assert.equal(leg2Retry.delta.newComments[0].id, 'T-99');
    });

    test('AC5: custom storageAdapter override is respected by prepareLegSessionDelta', function() {
        var customCalls = { read: 0, pending: 0 };
        var customAdapter = {
            readManifest: function() {
                customCalls.read++;
                return {
                    status: 'OK',
                    manifest: {
                        schemaVersion: 1,
                        headSha: 'custom-sha-0',
                        files: { 'pr_info.md': { hash: sessionDelta.hashContent('same'), size: 4 } },
                        comments: []
                    }
                };
            },
            writePendingManifest: function() {
                customCalls.pending++;
                return true;
            }
        };

        var writtenDelta = null;
        var res = sessionDelta.prepareLegSessionDelta({
            inputFolder: 'input/CUSTOM-1',
            headSha: 'custom-sha-1',
            inputFiles: { 'pr_info.md': 'same', 'ci_failures.md': 'new failure' },
            storageAdapter: customAdapter,
            writeFile: function(p, c) {
                if (p === 'input/CUSTOM-1/session_delta.md') writtenDelta = c;
            }
        });

        assert.equal(res.ok, true);
        assert.equal(customCalls.read, 1);
        assert.equal(customCalls.pending, 1);
        assert.equal(res.delta.files.unchanged[0], 'pr_info.md');
        assert.equal(res.delta.files.added[0], 'ci_failures.md');
        assert.contains(writtenDelta, '`custom-sha-0` → `custom-sha-1`');
    });
});


var _sdCanBash_ = typeof cli_execute_command === 'function';
if (_sdCanBash_) {
    try {
        cli_execute_command({ command: 'bash -c "echo __sd_probe__"' });
    } catch (eProbe) {
        _sdCanBash_ = false;
    }
}

suite('sessionDelta — UT-4 & IT-1: composite resume prompt & bash provider integration (AC1, AC4, REG-1)', function() {

    test('AC1: buildCompositeResumeNotice embeds session_delta.md and points to prompt_file', function() {
        var deltaMd = '# Session Delta — What Changed Since Your Last Leg\n\n- **Mode**: `DELTA`\n';
        var notice = sessionDelta.buildCompositeResumeNotice('/tmp/prompt.txt', deltaMd);
        assert.contains(notice, '**IMPORTANT — resumed session (Session Delta):**');
        assert.contains(notice, '# Session Delta — What Changed Since Your Last Leg');
        assert.contains(notice, '/tmp/prompt.txt');
        assert.contains(notice, '**UNCHANGED** files may be trusted from your prior session memory.');
    });

    test('REG-1: buildCompositeResumeNotice falls back to classic reread pointer when delta content is empty', function() {
        var notice = sessionDelta.buildCompositeResumeNotice('/tmp/prompt.txt', '');
        assert.contains(notice, '**IMPORTANT — resumed session:** this is a re-run of this job');
        assert.contains(notice, '/tmp/prompt.txt');
    });

    test('IT-1 (bash): _common.sh resumed_session_reread_pointer_notice + promote_pending_session_manifest + fa.sh resume flow', function() {
        if (!_sdCanBash_) return;
        var out = cli_execute_command({
            command: [
                'bash -c \'set -euo pipefail',
                'TMP="$(mktemp -d)"',
                'trap "rm -rf \\"$TMP\\"" EXIT',
                'REPO_ROOT="$(pwd)"',
                'mkdir -p "$TMP/input/GH-1064" "$TMP/sess"',
                'printf "Full static prompt instructions" > "$TMP/prompt.txt"',
                'cat > "$TMP/input/GH-1064/session_delta.md" << "EOF"',
                '# Session Delta — What Changed Since Your Last Leg',
                '- **Mode**: `DELTA`',
                '- **HEAD SHA**: `111` → `222` *(changed)*',
                '### 1. `T-55` — **reviewer** (`src/main.js:12`)',
                'Please rename variable foo to bar.',
                'EOF',
                'printf "{\\"schemaVersion\\":1,\\"headSha\\":\\"222\\"}" > "$TMP/input/GH-1064/.pending-input-manifest.json"',
                'cd "$TMP"',
                'source "$REPO_ROOT/scripts/providers/_common.sh"',
                'NOTICE="$(resumed_session_reread_pointer_notice "$TMP/prompt.txt")"',
                'printf "%s" "$NOTICE" | grep -q "Session Delta"',
                'printf "%s" "$NOTICE" | grep -q "Please rename variable foo to bar."',
                'printf "%s" "$NOTICE" | grep -q "$TMP/prompt.txt"',
                'export FA_SESSION_ROOT="$TMP/sess"',
                '# Exit != 0 must NOT promote pending manifest (AC4)',
                'promote_pending_session_manifest 1',
                '[ ! -f "$TMP/sess/.session-input-manifest.json" ]',
                '# Exit == 0 MUST promote pending manifest (AC4)',
                'promote_pending_session_manifest 0',
                '[ -f "$TMP/sess/.session-input-manifest.json" ]',
                'grep -q "\\"headSha\\":\\"222\\"" "$TMP/sess/.session-input-manifest.json"',
                'echo "BASH_IT_OK"\''
            ].join('\n')
        });
        assert.contains(out, 'BASH_IT_OK', 'bash integration test failed: ' + out);
    });

    test('IT-1 (bash): fa.sh sends full prompt on fresh session and composite delta notice on resumed session', function() {
        if (!_sdCanBash_) return;
        var out = cli_execute_command({
            command: [
                'bash -c \'set -euo pipefail',
                'TMP="$(mktemp -d)"',
                'trap "rm -rf \\"$TMP\\"" EXIT',
                'REPO_ROOT="$(pwd)"',
                'mkdir -p "$TMP/bin" "$TMP/input/GH-1064" "$TMP/sess"',
                'cat > "$TMP/bin/fa" << "FAEOF"',
                '#!/usr/bin/env bash',
                'while [ $# -gt 0 ]; do',
                '  if [ "$1" = "-p" ]; then',
                '    printf "%s" "$2" > "$FA_CAPTURED_PROMPT_FILE"',
                '    break',
                '  fi',
                '  shift',
                'done',
                'exit "${FA_MOCK_EXIT_CODE:-0}"',
                'FAEOF',
                'chmod +x "$TMP/bin/fa"',
                'export PATH="$TMP/bin:$PATH"',
                'export FA_PROVIDER_TYPE="openai"',
                'export FA_PROVIDER_CONFIG="{\\"baseUrl\\":\\"https://example.com\\",\\"model\\":\\"gpt-4o\\"}"',
                'export FA_SESSION_NAME="fa-test-sess"',
                'export FA_SESSION_ROOT="$TMP/sess"',
                'export FA_CAPTURED_PROMPT_FILE="$TMP/captured_prompt.txt"',
                'printf "Static 50KB prompt body" > "$TMP/full_prompt.txt"',
                'PROMPT_ARG="$TMP/full_prompt.txt"',
                'PROMPT="$(cat "$PROMPT_ARG")"',
                'PASS_ARGS=()',
                'cat > "$TMP/input/GH-1064/session_delta.md" << "EOF"',
                '# Session Delta — What Changed Since Your Last Leg',
                'New reviewer comment body XYZ-987',
                'EOF',
                'printf "{\\"schemaVersion\\":1,\\"headSha\\":\\"after-leg1\\"}" > "$TMP/input/GH-1064/.pending-input-manifest.json"',
                'cd "$TMP"',
                'source "$REPO_ROOT/scripts/providers/_common.sh"',
                'source "$REPO_ROOT/scripts/providers/fa.sh"',
                '# 1. Fresh session (no .jsonl in FA_SESSION_ROOT yet): sends full prompt',
                'run_fa >/dev/null',
                'grep -q "Static 50KB prompt body" "$FA_CAPTURED_PROMPT_FILE"',
                '[ -f "$TMP/sess/.session-input-manifest.json" ]',
                '# 2. Now simulate persisted session file (.jsonl) in FA_SESSION_ROOT -> resumed session!',
                'printf "{\\"id\\":1}\\n" > "$TMP/sess/fa-test-sess.jsonl"',
                'printf "{\\"schemaVersion\\":1,\\"headSha\\":\\"after-leg2\\"}" > "$TMP/input/GH-1064/.pending-input-manifest.json"',
                'run_fa >/dev/null',
                'grep -q "New reviewer comment body XYZ-987" "$FA_CAPTURED_PROMPT_FILE"',
                'grep -q "$TMP/full_prompt.txt" "$FA_CAPTURED_PROMPT_FILE"',
                'grep -q "\\"headSha\\":\\"after-leg2\\"" "$TMP/sess/.session-input-manifest.json"',
                'echo "FA_RESUME_IT_OK"\''
            ].join('\n')
        });
        assert.contains(out, 'FA_RESUME_IT_OK', 'fa.sh resume test failed: ' + out);
    });

    test('IT-1 (bash): fa.sh _fa_resolve_env handles FA_PROVIDERS_QUEUE, indirect $VAR, and legacy FA_PROVIDER_TYPE', function() {
        if (!_sdCanBash_) return;
        var out = cli_execute_command({
            command: [
                'bash -c \'set -euo pipefail',
                'REPO_ROOT="$(pwd)"',
                'source "$REPO_ROOT/scripts/providers/fa.sh"',
                '# hermetic: no real ZAI creds / probe in this test (gh-1385) — env-provided secrets must not influence it',
                'unset ZAI_CODE_KEY ZAI_CODE_KEY_1 ZAI_CODE_KEY_2 ZAI_CODE_KEY_3 ZAI_CODE_KEY_4 ZAI_CODE_KEY_5',
                'export FA_QUOTA_PROBE=off',
                '# Case 1: neither set -> fails',
                'unset FA_PROVIDER_TYPE FA_PROVIDER_CONFIG FA_PROVIDERS_QUEUE',
                'if _fa_resolve_env 2>/dev/null; then exit 1; fi',
                '# Case 2: FA_PROVIDERS_QUEUE alone derives FA_PROVIDER_TYPE and FA_PROVIDER_CONFIG (with apiKeyEnvVar and stripped timeout keys)',
                'export KIMI_KEY="secret-kimi"',
                'export FA_PROVIDERS_QUEUE="[{\\"provider_type\\":\\"zai\\",\\"provider_config\\":{\\"model\\":\\"glm-5\\",\\"apiKeyEnv\\":\\"UNSET_ZAI_KEY\\",\\"connectTimeoutMs\\":5000}},{\\"provider_type\\":\\"openai-completions\\",\\"provider_config\\":{\\"baseUrl\\":\\"https://api.kimi.com/v1\\",\\"model\\":\\"kimi-k2\\",\\"apiKeyEnv\\":\\"KIMI_KEY\\",\\"streamIdleTimeoutMs\\":10000}}]"',
                '_fa_resolve_env',
                '[ "$FA_PROVIDER_TYPE" = "openai-completions" ]',
                'printf "%s" "$FA_PROVIDER_CONFIG" | grep -q "\\"apiKeyEnvVar\\":\\"KIMI_KEY\\""',
                'if printf "%s" "$FA_PROVIDER_CONFIG" | grep -q "streamIdleTimeoutMs"; then exit 1; fi',
                '[ "$FA_KEY_ENV_VAR" = "KIMI_KEY" ]',
                '# Case 3: indirect $ENV_VAR_DEV_QUEUE resolution and default baseUrl lookup for zai',
                'unset FA_PROVIDER_TYPE FA_PROVIDER_CONFIG KIMI_KEY',
                'export ENV_VAR_DEV_QUEUE="[{\\"provider_type\\":\\"zai\\",\\"provider_config\\":{\\"model\\":\\"glm-5.3-flash\\",\\"apiKeyEnv\\":\\"ZAI_CODE_KEY\\"}}]"',
                'export FA_PROVIDERS_QUEUE="\\$ENV_VAR_DEV_QUEUE"',
                '_fa_resolve_env',
                '[ "$FA_PROVIDERS_QUEUE" = "$ENV_VAR_DEV_QUEUE" ]',
                '[ "$FA_PROVIDER_TYPE" = "zai" ]',
                'printf "%s" "$FA_PROVIDER_CONFIG" | grep -q "\\"baseUrl\\":\\"https://api.z.ai/api/coding/paas/v4\\""',
                'printf "%s" "$FA_PROVIDER_CONFIG" | grep -q "\\"apiKeyEnvVar\\":\\"ZAI_CODE_KEY\\""',
                '# Case 4: indirect unset var fails',
                'unset FA_PROVIDER_TYPE FA_PROVIDER_CONFIG UNSET_QUEUE_REF',
                'export FA_PROVIDERS_QUEUE="\\$UNSET_QUEUE_REF"',
                'if _fa_resolve_env 2>/dev/null; then exit 1; fi',
                '# Case 4b: un-derivable queues (invalid JSON, empty array, unknown provider without baseUrl, missing @file) fail fast',
                'for bad_q in "not-json{" "[]" "[{\\"provider_type\\":\\"dial\\",\\"provider_config\\":{\\"model\\":\\"m1\\"}}]" "@/tmp/nonexistent-fa-queue-99999.json"; do',
                '  unset FA_PROVIDER_TYPE FA_PROVIDER_CONFIG',
                '  export FA_PROVIDERS_QUEUE="$bad_q"',
                '  if _fa_resolve_env 2>/dev/null; then echo "expected failure for $bad_q"; exit 1; fi',
                'done',
                '# Case 5: legacy FA_PROVIDER_TYPE + FA_PROVIDER_CONFIG alone',
                'unset FA_PROVIDERS_QUEUE',
                'export FA_PROVIDER_TYPE="openai"',
                'export FA_PROVIDER_CONFIG="{\\"baseUrl\\":\\"https://api.openai.com/v1\\",\\"model\\":\\"gpt-4o\\",\\"apiKeyEnvVar\\":\\"OPENAI_API_KEY\\"}"',
                '_fa_resolve_env',
                '[ "$FA_KEY_ENV_VAR" = "OPENAI_API_KEY" ]',
                'echo "FA_QUEUE_IT_OK"\''
            ].join('\n')
        });
        assert.contains(out, 'FA_QUEUE_IT_OK', 'fa.sh queue resolve test failed: ' + out);
    });

    test('IT-1b (bash): fa.sh auto-appends fallback provider keys (<KEY>_1.._5) to the queue (gh-1381)', function() {
        if (!_sdCanBash_) return;
        var out = cli_execute_command({
            command: [
                'bash -c \'set -euo pipefail',
                'REPO_ROOT="$(pwd)"',
                'source "$REPO_ROOT/scripts/providers/fa.sh"',
                'unset FA_PROVIDER_TYPE FA_PROVIDER_CONFIG KIMI_KEY',
                'unset ZAI_CODE_KEY ZAI_CODE_KEY_1 ZAI_CODE_KEY_2 ZAI_CODE_KEY_3 ZAI_CODE_KEY_4 ZAI_CODE_KEY_5',
                'export FA_QUOTA_PROBE=off',
                'export ENV_VAR_DEV_QUEUE="[{\\"provider_type\\":\\"zai\\",\\"provider_config\\":{\\"model\\":\\"glm-5.3-flash\\",\\"apiKeyEnv\\":\\"ZAI_CODE_KEY\\"}}]"',
                '# Case A: primary + _1 + _2 set -> both appended in order, same model, catalog baseUrl',
                'export ZAI_CODE_KEY="primary-key"',
                'export ZAI_CODE_KEY_1="fallback-1"',
                'export ZAI_CODE_KEY_2="fallback-2"',
                'export FA_PROVIDERS_QUEUE="\\$ENV_VAR_DEV_QUEUE"',
                '_fa_resolve_env',
                'printf "%s" "$FA_PROVIDERS_QUEUE" | grep -q "\\"apiKeyEnv\\":\\"ZAI_CODE_KEY_1\\""',
                'printf "%s" "$FA_PROVIDERS_QUEUE" | grep -q "\\"apiKeyEnv\\":\\"ZAI_CODE_KEY_2\\""',
                'printf "%s" "$FA_PROVIDERS_QUEUE" | grep -q "\\"model\\":\\"glm-5.3-flash\\""',
                'printf "%s" "$FA_PROVIDERS_QUEUE" | grep -q "\\"baseUrl\\":\\"https://api.z.ai/api/coding/paas/v4\\""',
                '[ "$FA_PROVIDER_TYPE" = "zai" ]',
                '# Case B: _1 already referenced by an existing entry -> no duplicate append',
                'export ENV_VAR_DEV_QUEUE="[{\\"provider_type\\":\\"zai\\",\\"provider_config\\":{\\"model\\":\\"glm-5.3-flash\\",\\"apiKeyEnv\\":\\"ZAI_CODE_KEY\\"}},{\\"provider_type\\":\\"zai\\",\\"provider_config\\":{\\"model\\":\\"glm-5.3-flash\\",\\"apiKeyEnv\\":\\"ZAI_CODE_KEY_1\\"}}]"',
                'export FA_PROVIDERS_QUEUE="\\$ENV_VAR_DEV_QUEUE"',
                '_fa_resolve_env',
                '[ "$(printf "%s" "$FA_PROVIDERS_QUEUE" | grep -o "\\"apiKeyEnv\\":\\"ZAI_CODE_KEY_1\\"" | wc -l | tr -d " ")" = "1" ]',
                '# Case C: empty _3 skipped, no _N vars at all -> queue byte-identical',
                'unset ZAI_CODE_KEY ZAI_CODE_KEY_1 ZAI_CODE_KEY_2',
                'export FA_PROVIDERS_QUEUE="\\$ENV_VAR_DEV_QUEUE"',
                '_fa_resolve_env',
                '[ "$FA_PROVIDERS_QUEUE" = "$ENV_VAR_DEV_QUEUE" ]',
                'echo "FA_FALLBACK_IT_OK"\'',
            ].join('\n')
        });
        assert.contains(out, 'FA_FALLBACK_IT_OK', 'fa.sh fallback append test failed: ' + out);
    });
    test('IT-1c (bash): multi-entry queue - per-entry fallbacks in order, dedup-break, per-entry models (gh-1381)', function() {
        if (!_sdCanBash_) return;
        var out = cli_execute_command({
            command: [
                'bash -c \'set -euo pipefail',
                'REPO_ROOT="$(pwd)"',
                'source "$REPO_ROOT/scripts/providers/fa.sh"',
                'unset FA_PROVIDER_TYPE FA_PROVIDER_CONFIG',
                'unset ZAI_CODE_KEY ZAI_CODE_KEY_1 ZAI_CODE_KEY_2 ZAI_CODE_KEY_3 ZAI_CODE_KEY_4 ZAI_CODE_KEY_5',
                'export FA_QUOTA_PROBE=off',
                'export ENV_VAR_DEV_QUEUE="[{\\"provider_type\\":\\"zai\\",\\"provider_config\\":{\\"model\\":\\"m1\\",\\"apiKeyEnv\\":\\"ONE_KEY\\"}},{\\"provider_type\\":\\"zai\\",\\"provider_config\\":{\\"model\\":\\"m2\\",\\"apiKeyEnv\\":\\"ONE_KEY_2\\"}},{\\"provider_type\\":\\"zai\\",\\"provider_config\\":{\\"model\\":\\"m3\\",\\"apiKeyEnv\\":\\"SECOND_KEY\\"}}]"',
                'export FA_PROVIDERS_QUEUE="\\$ENV_VAR_DEV_QUEUE"',
                'export ONE_KEY="k-one" ONE_KEY_1="k-one-1" SECOND_KEY="k-two" SECOND_KEY_1="k-two-1"',
                'unset ONE_KEY_3 SECOND_KEY_2 ZAI_CODE_KEY ZAI_CODE_KEY_1 ZAI_CODE_KEY_2 || true',
                '_fa_resolve_env',
                'ORDER="$(printf "%s" "$FA_PROVIDERS_QUEUE" | grep -o "\\"apiKeyEnv\\":\\"[A-Z_0-9]*\\"" | sed "s/^.*://;s/\\"//g" | tr "\\n" "-")"',
                '[ "$ORDER" = "ONE_KEY-ONE_KEY_1-ONE_KEY_2-SECOND_KEY-SECOND_KEY_1-" ]',
                'MODELS="$(printf "%s" "$FA_PROVIDERS_QUEUE" | grep -o "\\"model\\":\\"[a-z0-9]*\\"" | sed "s/^.*://;s/\\"//g" | tr "\\n" "-")"',
                '[ "$MODELS" = "m1-m1-m2-m3-m3-" ]',
                '[ "$FA_PROVIDER_TYPE" = "zai" ]',
                'echo "IT_1C_OK"\','
            ].join('\n')
        });
        assert.contains(out, 'IT_1C_OK', 'fa.sh multi-entry fallback test failed: ' + out);
    });

    test('covers sessionGroupForConfig, defaultDeltaStorage file_read/file_write/file_list bridges, edited comments, and corrupt JSON on disk', function() {
        assert.equal(sessionDelta.sessionGroupForConfig('agents/story_development.json'), 'dev-write');
        assert.equal(sessionDelta.sessionGroupForConfig('agents/pr_review.json'), 'dev-review');
        assert.equal(sessionDelta.sessionGroupForConfig('agents/test_case_automation.json'), 'test-write');
        assert.equal(sessionDelta.sessionGroupForConfig('agents/pr_test_automation_review.json'), 'test-review');
        assert.equal(sessionDelta.sessionGroupForConfig('/home/u/.dmtools/packs/pr_rework-0.1.9/launch.json'), 'dev-write');
        assert.equal(sessionDelta.sessionGroupForConfig('custom_agent.json'), 'custom_agent');

        // Edited comment body detection + label removal in computeSessionDelta
        var prev = {
            schemaVersion: 1,
            headSha: 's1',
            reviewDecision: 'CHANGES_REQUESTED',
            labels: ['a', 'b'],
            files: { 'a.md': { hash: sessionDelta.hashContent('1'), size: 1 } },
            comments: [{ id: 'C-1', author: 'bob', createdAt: '2026-10-20', location: 'x.js:1', body: 'old text' }]
        };
        var curr = {
            schemaVersion: 1,
            headSha: 's1',
            reviewDecision: 'CHANGES_REQUESTED',
            labels: ['a'],
            files: { 'a.md': { hash: sessionDelta.hashContent('1'), size: 1 } },
            comments: [{ id: 'C-1', author: 'bob', createdAt: '2026-10-20', location: 'x.js:1', body: 'edited text' }]
        };
        var d = sessionDelta.computeSessionDelta(prev, curr);
        assert.equal(d.newComments.length, 1);
        assert.equal(d.newComments[0].edited, true);
        assert.deepEqual(d.labelDiff, { added: [], removed: ['b'] });
        var md = sessionDelta.renderSessionDeltaMd(d);
        assert.contains(md, '[EDITED]');
        assert.contains(md, '-b');

        // Corrupt manifest JSON via defaultDeltaStorage.readManifest
        var mem = makeMemoryStorage({ sessionDir: '/sess' });
        mem.writeFile('/sess/session.jsonl', '{}');
        mem.writeFile('/sess/.session-input-manifest.json', '{not-json');
        mem.writeFile('input/GH-1064/pr_info.md', '- **Labels**: `l1`, `l2`\n- **Head SHA**: `deadbeef`\n- **State**: open\n');
        var corruptRes = sessionDelta.prepareLegSessionDelta({
            inputFolder: 'input/GH-1064',
            sessionStateDir: '/sess',
            readFile: mem.readFile,
            writeFile: mem.writeFile,
            listFiles: mem.listFiles
        });
        assert.equal(corruptRes.mode, 'CORRUPT-MANIFEST');
        assert.equal(corruptRes.snapshot.headSha, 'deadbeef');
        assert.deepEqual(corruptRes.snapshot.labels, ['l1', 'l2']);

        // Missing inputFolder guard
        assert.equal(sessionDelta.prepareLegSessionDelta({}).ok, false);
    });

    test('preCliReworkSetup.enrichReworkInputStep invokes sessionDelta.prepareLegSessionDelta and swallows errors non-fatally', function() {
        var deltaCalledWith = null;
        var forkCheckoutMod = loadModule('js/common/forkCheckout.js',
            makeRequire({ './validationLiveness.js': loadModule('js/common/validationLiveness.js', makeRequire({}), {}) }), {});
        var reworkMod = loadModule('js/preCliReworkSetup.js', makeRequire({
            './configLoader.js': { loadHookFn: function() { return null; } },
            './common/reviewPolicy.js': (function() {
                var machineAuthor = loadModule('js/common/machineAuthor.js', makeRequire({}), {});
                var reviewVerdicts = loadModule('js/common/reviewVerdicts.js',
                    makeRequire({ './machineAuthor.js': machineAuthor }), {});
                return loadModule('js/common/reviewPolicy.js',
                    makeRequire({ './reviewVerdicts.js': reviewVerdicts }), {});
            })(),
            './common/githubHelpers.js': { buildOriginFetchCommand: function() { return ''; } },
            './forkCheckout.js': forkCheckoutMod,
            './common/gitOps.js': {},
            './common/commentMarkup.js': loadModule('js/common/commentMarkup.js',
                makeRequire({ './ticketKeyShapes.js': loadModule('js/common/ticketKeyShapes.js') })),
            './fetchQuestionsToInput.js': { action: function() {} },
            './fetchParentContextToInput.js': { action: function() {} },
            './restoreFromReleases.js': {},
            './common/trackers.js': { createTracker: function() { return {}; } },
            './common/setupCommands.js': loadModule('js/common/setupCommands.js'),
            './common/baseBranchMarker.js': { writeBaseBranchMarker: function() {} },
            './common/sessionDelta.js': {
                prepareLegSessionDelta: function(ctx) {
                    deltaCalledWith = ctx;
                    throw new Error('simulated delta error');
                }
            },
            './config.js': { resolveStatuses: function() { return {}; } }
        }));

        assert.doesNotThrow(function() {
            reworkMod.enrichReworkInputStep({}, {}, {
                inputFolder: 'input/GH-1064',
                ticketKey: 'GH-1064',
                repo: 'IstiN/dmtools-agents',
                headSha: 'abc',
                baseBranch: 'main'
            });
        });
        assert.ok(deltaCalledWith);
        assert.equal(deltaCalledWith.ticketKey, 'GH-1064');
    });

    test('covers global file_read/file_write/file_list bridges and edge cases', function() {
        var written = {};
        var bridged = loadModule('js/common/sessionDelta.js', null, {
            file_read: function(args) {
                if (args.path === '/throw-read') throw new Error('read fail');
                return Object.prototype.hasOwnProperty.call(written, args.path) ? written[args.path] : null;
            },
            file_write: function(args) {
                if (args.path === '/throw-write/.session-input-manifest.json') throw new Error('write fail');
                written[args.path] = args.content;
            },
            file_list: function(args) {
                if (args.path === '/throw-list') throw new Error('list fail');
                if (args.path === '/array-list') return JSON.stringify(['/array-list/a.txt']);
                if (args.path === '/sess-bridge') return JSON.stringify({ entries: ['/sess-bridge/run.jsonl', '/sess-bridge/.session-input-manifest.json'] });
                if (args.path === 'input/B-1') return JSON.stringify({ entries: ['input/B-1/pr_info.md', 'input/B-1/session_delta.md'] });
                return null;
            }
        });

        written['input/B-1/pr_info.md'] = '- **Branch**: `b` -> `main`\n';
        written['/sess-bridge/.session-input-manifest.json'] = JSON.stringify({
            schemaVersion: 1,
            headSha: 'h0',
            files: { 'pr_info.md': { hash: bridged.hashContent('- **Branch**: `b` -> `main`\n'), size: 26 } },
            comments: []
        });

        var res = bridged.prepareLegSessionDelta({
            inputFolder: 'input/B-1',
            sessionStateDir: '/sess-bridge',
            comments: [{ id: 'extra-1', user: { login: 'octocat' }, body: 'Extra comment' }]
        });
        assert.equal(res.ok, true);
        assert.equal(res.mode, 'DELTA');
        assert.equal(res.delta.newComments[0].author, 'octocat');

        assert.equal(bridged.defaultDeltaStorage.commitPendingManifest({
            inputFolder: 'input/B-1',
            sessionStateDir: '/sess-bridge'
        }), true);
        assert.equal(bridged.defaultDeltaStorage.commitPendingManifest({ inputFolder: '' }), false);
        assert.equal(bridged.defaultDeltaStorage.writePendingManifest({ inputFolder: '' }, {}), false);
        assert.equal(bridged.defaultDeltaStorage.writeManifest({ sessionStateDir: '/throw-write' }, {}), false);
        assert.equal(bridged.hasActiveSessionOnDisk({ sessionStateDir: '/throw-list' }), false);
        assert.equal(bridged.hasActiveSessionOnDisk({ sessionStateDir: '/array-list' }), true);
        assert.equal(bridged.hasActiveSessionOnDisk({ hasActiveSession: true }), true);

        // Invalid schema object in manifest
        written['/sess-bridge/.session-input-manifest.json'] = JSON.stringify({ schemaVersion: 1 });
        var badSchema = bridged.defaultDeltaStorage.readManifest({ sessionStateDir: '/sess-bridge' });
        assert.equal(badSchema.status, 'CORRUPT');

        // parseDiscussionsRawJson edge cases (array root, corrupt json, non-object thread)
        assert.equal(bridged.parseDiscussionsRawJson('not-json').length, 0);
        assert.equal(bridged.parseDiscussionsRawJson(JSON.stringify([null, { id: 'arr-1', body: 'hi' }])).length, 1);
    });
});

// ── gh-1224: resolveDefaultSessionSubpath — deterministic fallback ladder ────
// Every name in an env ladder is pinned in ctx.env (hasOwnProperty override),
// so these assertions never read the runner's own environment.

suite('sessionDelta.resolveDefaultSessionSubpath (gh-1224)', function() {

    function envOf(map) { return map; }

    test('explicit ctx fields win over everything', function() {
        assert.equal(
            sessionDelta.resolveDefaultSessionSubpath({
                repo: 'IstiN/dmtools-agents',
                ticketKey: 'GH-1224',
                configFile: 'agents/pr_review.json',
                sessionGroup: 'custom-group',
                env: envOf({
                    GITHUB_REPOSITORY: 'should-not-win',
                    AI_TEAMMATE_DISPLAY_KEY: 'should-not-win',
                    AI_TEAMMATE_CONFIG_FILE: 'should-not-win'
                })
            }),
            '.dmtools/fa-sessions/istin-dmtools-agents/gh-1224/custom-group');
    });

    test('env ladders fill the gaps when ctx fields are absent', function() {
        assert.equal(
            sessionDelta.resolveDefaultSessionSubpath({
                env: envOf({
                    GITHUB_REPOSITORY: 'Acme/Corp Repo',
                    AI_TEAMMATE_DISPLAY_KEY: 'display-9',
                    AI_TEAMMATE_CONFIG_FILE: 'agents/pr_test_automation_review.json'
                })
            }),
            '.dmtools/fa-sessions/acme-corp-repo/display-9/test-review');
    });

    test('second and third ladder entries are honoured when the first is empty', function() {
        assert.equal(
            sessionDelta.resolveDefaultSessionSubpath({
                env: envOf({
                    GITHUB_REPOSITORY: '',
                    AI_TEAMMATE_DISPLAY_KEY: '',
                    DISPLAY_KEY: 'display-fallback',
                    AI_TEAMMATE_CONCURRENCY_KEY: 'concurrency-ignored',
                    AI_TEAMMATE_CONFIG_FILE: '',
                    CONFIG_FILE: 'agents/pr_rework.json'
                })
            }),
            '.dmtools/fa-sessions/local/display-fallback/dev-write');
    });

    test('a fully unpinned context degrades to the local defaults', function() {
        assert.equal(
            sessionDelta.resolveDefaultSessionSubpath({
                env: envOf({
                    GITHUB_REPOSITORY: '',
                    AI_TEAMMATE_DISPLAY_KEY: '',
                    DISPLAY_KEY: '',
                    AI_TEAMMATE_CONCURRENCY_KEY: '',
                    AI_TEAMMATE_CONFIG_FILE: '',
                    CONFIG_FILE: ''
                })
            }),
            '.dmtools/fa-sessions/local/local/dev-write');
    });

    test('a config outside the session-group map slugifies to itself', function() {
        assert.equal(
            sessionDelta.resolveDefaultSessionSubpath({
                configFile: 'agents/my_custom_flow.json',
                env: envOf({
                    GITHUB_REPOSITORY: '',
                    AI_TEAMMATE_DISPLAY_KEY: '',
                    DISPLAY_KEY: '',
                    AI_TEAMMATE_CONCURRENCY_KEY: '',
                    AI_TEAMMATE_CONFIG_FILE: '',
                    CONFIG_FILE: ''
                })
            }),
            '.dmtools/fa-sessions/local/local/my_custom_flow');
    });

    test('null/undefined ctx fields behave like absent ones', function() {
        assert.equal(
            sessionDelta.resolveDefaultSessionSubpath({
                repo: null,
                ticketKey: undefined,
                configFile: null,
                env: envOf({
                    GITHUB_REPOSITORY: '',
                    AI_TEAMMATE_DISPLAY_KEY: '',
                    DISPLAY_KEY: '',
                    AI_TEAMMATE_CONCURRENCY_KEY: '',
                    AI_TEAMMATE_CONFIG_FILE: '',
                    CONFIG_FILE: ''
                })
            }),
            '.dmtools/fa-sessions/local/local/dev-write');
    });
});

// ════════════════════════════════════════════════════════════════════════════
// gh-1385 rework — readEnv / readRuntimeEnv direct unit coverage (crap gate).
//
// The AC3 hermeticity change (empty-string overrides blocking every ladder
// name) removed the last indirect path reaching readRuntimeEnv, dropping its
// coverage to 0% and tripping the crap ratchet (CC 6, CRAP 42 > 8). These
// tests exercise the env ladder directly: the Node process.env branch, the
// QuickJS/java-bridge branch (mocked global — hit and null fall-through), and
// the readEnv override precedence (override wins, empty string blocks, miss
// falls through).
// ════════════════════════════════════════════════════════════════════════════

suite('sessionDelta — readEnv/readRuntimeEnv ladder (gh-1385 rework: crap gate)', function() {

    test('exports readEnv and readRuntimeEnv — the crap gate needs direct unit coverage', function() {
        assert.equal(typeof sessionDelta.readRuntimeEnv, 'function');
        assert.equal(typeof sessionDelta.readEnv, 'function');
    });
});

var _sdHasNodeProcess_ = (function() {
    try {
        return typeof process !== 'undefined' && !!(process.versions && process.versions.node);
    } catch (e) { return false; }
})();

if (_sdHasNodeProcess_) {
    suite('sessionDelta — readRuntimeEnv engine branches (gh-1385 rework: crap gate)', function() {

        test('Node branch: process.env hit returns the value, miss returns empty string', function() {
            // no `java` global under node — the java-bridge try must throw and be swallowed
            assert.equal(typeof java, 'undefined');
            process.env.SD_GH1385_PROBE = 'runtime-value';
            try {
                assert.equal(sessionDelta.readRuntimeEnv('SD_GH1385_PROBE'), 'runtime-value');
                assert.equal(sessionDelta.readRuntimeEnv('SD_GH1385_PROBE_MISSING'), '');
            } finally {
                delete process.env.SD_GH1385_PROBE;
            }
        });

        test('java-bridge branch: a bridge value wins over process.env; a null bridge answer falls through', function() {
            var prevJava = global.java;
            global.java = { lang: { System: { getenv: function(name) {
                return name === 'SD_GH1385_JAVA_SET' ? 'from-java' : null;
            } } } };
            process.env.SD_GH1385_JAVA_SET = 'from-node';
            process.env.SD_GH1385_JAVA_NULL = 'from-node';
            try {
                assert.equal(sessionDelta.readRuntimeEnv('SD_GH1385_JAVA_SET'), 'from-java');
                assert.equal(sessionDelta.readRuntimeEnv('SD_GH1385_JAVA_NULL'), 'from-node');
                assert.equal(sessionDelta.readRuntimeEnv('SD_GH1385_JAVA_NEITHER'), '');
            } finally {
                if (prevJava === undefined) { delete global.java; } else { global.java = prevJava; }
                delete process.env.SD_GH1385_JAVA_SET;
                delete process.env.SD_GH1385_JAVA_NULL;
            }
        });

        test('readEnv ladder: override map wins, empty string blocks, miss falls through to readRuntimeEnv', function() {
            process.env.SD_GH1385_FALLBACK = 'runtime-value';
            try {
                assert.equal(sessionDelta.readEnv('SD_GH1385_FALLBACK', { env: { SD_GH1385_FALLBACK: 'override' } }), 'override');
                assert.equal(sessionDelta.readEnv('SD_GH1385_FALLBACK', { env: {} }), 'runtime-value');
                assert.equal(sessionDelta.readEnv('SD_GH1385_FALLBACK', { env: { SD_GH1385_FALLBACK: '' } }), '');
                assert.equal(sessionDelta.readEnv('SD_GH1385_FALLBACK', { env: { SD_GH1385_FALLBACK: null } }), '');
                assert.equal(sessionDelta.readEnv('SD_GH1385_FALLBACK'), 'runtime-value');
                assert.equal(sessionDelta.readEnv('SD_GH1385_FALLBACK', null), 'runtime-value');
            } finally {
                delete process.env.SD_GH1385_FALLBACK;
            }
        });
    });
}

// ════════════════════════════════════════════════════════════════════════════
// gh-1385 — quota-aware provider queue ordering (scripts/providers/fa.sh).
//
// Offline fixture probes (AC1): a fake curl on PATH serves per-key fixture
// payloads — 200 healthy / 200 exhausted / 500 no-plan / 401 / timeout /
// shape-changed — and logs every invocation, so NO test ever hits the live
// endpoint. The API key is handed to the fake curl via stdin config, never
// argv. A live IT (AC2) is OPT-IN: it runs only with FA_QUOTA_LIVE_IT=on,
// otherwise it reports QUOTA_LIVE_SKIPPED — runner creds in the environment
// must not turn the shared suite into live HTTP (gh-1385 rework).
// ════════════════════════════════════════════════════════════════════════════

var _sdFaQuotaSharedBash_ = [
    'unset FA_PROVIDER_TYPE FA_PROVIDER_CONFIG FA_PROVIDERS_QUEUE FA_QUOTA_PROBE',
    'unset ZAI_CODE_KEY ZAI_CODE_KEY_1 ZAI_CODE_KEY_2 ZAI_CODE_KEY_3 ZAI_CODE_KEY_4 ZAI_CODE_KEY_5 ENV_VAR_DEV_QUEUE',
    'TMP="$(mktemp -d)"',
    'trap "rm -rf \\"$TMP\\"" EXIT',
    'BIN="$TMP/bin"; FX="$TMP/fixtures"; mkdir -p "$BIN" "$FX"',
    'cat > "$FX/healthy.json" << "JSONEOF"',
    '{"code":200,"success":true,"data":{"level":"max","limits":[{"type":"CREDIT_LIMIT","unit":3,"number":5,"usage":28000,"currentValue":1382,"remaining":2617,"percentage":4,"nextResetTime":179394845215},{"type":"CREDIT_LIMIT","unit":6,"number":1,"usage":140000,"currentValue":11896,"remaining":128103,"percentage":8,"nextResetTime":1794278259998}]}}',
    'JSONEOF',
    'cat > "$FX/exhausted.json" << "JSONEOF"',
    '{"code":200,"success":true,"data":{"level":"max","limits":[{"type":"CREDIT_LIMIT","unit":3,"number":5,"usage":28000,"currentValue":28000,"remaining":0,"percentage":100,"nextResetTime":179394845215},{"type":"CREDIT_LIMIT","unit":6,"number":1,"usage":140000,"currentValue":11896,"remaining":128103,"percentage":8,"nextResetTime":1794278259998}]}}',
    'JSONEOF',
    'cat > "$FX/shape-changed.json" << "JSONEOF"',
    '{"code":200,"success":true,"data":{"level":"max"}}',
    'JSONEOF',
    'export FAKE_FIXTURES="$FX" FAKE_CURL_LOG="$TMP/calls.log" FAKE_CURL_ARGV_LOG="$TMP/curl-argv.log"',
    ': > "$FAKE_CURL_LOG"',
    ': > "$FAKE_CURL_ARGV_LOG"'
];

if (_sdCanBash_) {
    suite('fa provider quota ordering (gh-1385) — probe, re-order, kill-switch', function() {

        test('IT-2 (bash): re-orders most-unspent-first over all fixture classes; failures keep the static slot; one call per key; derived primary = top score', function() {
            var out = cli_execute_command({
                command: [
                    'bash -c \'set -euo pipefail',
                    'REPO_ROOT="$(pwd)"'
                ].concat(_sdFaQuotaSharedBash_).concat([
                    'K_HEALTHY="zt-key-healthy-01"; K_EXHAUSTED="zt-key-exhausted-02"; K_NOPLAN="zt-key-noplan-03"; K_AUTH="zt-key-unauth-04"; K_TIMEOUT="zt-key-timeout-05"; K_SHAPE="zt-key-shape-06"',
                    'export K_HEALTHY K_EXHAUSTED K_NOPLAN K_AUTH K_TIMEOUT K_SHAPE',
                    'cat > "$BIN/curl" << "CUREOF"',
                    '#!/bin/bash',
                    'LOG="${FAKE_CURL_LOG:?}"',
                    'printf "%s\\n" "$*" >> "${FAKE_CURL_ARGV_LOG:?}"',
                    'KEY=""; maxt=""',
                    'while [ $# -gt 0 ]; do',
                    ' if [ "$1" = "-m" ]; then maxt="$2"; fi',
                    ' shift',
                    'done',
                    'IFS= read -r CFG || true',
                    'KEY="${CFG#*Bearer }"',
                    'KEY="${KEY%\"}"',
                    'case "$maxt" in "" | *[!0-9]*) exit 3 ;; esac',
                    '[ "$maxt" -ge 1 ] && [ "$maxt" -le 10 ] || exit 3',
                    '[ -n "$KEY" ] || exit 2',
                    'printf "%s\\n" "$KEY" >> "$LOG"',
                    'case "$KEY" in',
                    ' "$K_HEALTHY") cat "$FAKE_FIXTURES/healthy.json"; printf "\\n200"; exit 0 ;;',
                    ' "$K_EXHAUSTED") cat "$FAKE_FIXTURES/exhausted.json"; printf "\\n200"; exit 0 ;;',
                    ' "$K_NOPLAN") printf "%s" "{\\"error\\":{\\"title\\":\\"internal\\"}}"; printf "\\n500"; exit 0 ;;',
                    ' "$K_AUTH") printf "%s" "{\\"error\\":{\\"title\\":\\"unauthorized\\"}}"; printf "\\n401"; exit 0 ;;',
                    ' "$K_TIMEOUT") exit 28 ;;',
                    ' "$K_SHAPE") cat "$FAKE_FIXTURES/shape-changed.json"; printf "\\n200"; exit 0 ;;',
                    'esac',
                    'printf "%s" "{}"; printf "\\n200"',
                    'CUREOF',
                    'chmod +x "$BIN/curl"',
                    'export PATH="$BIN:$PATH"',
                    'export ENV_VAR_DEV_QUEUE="[{\\"provider_type\\":\\"zai\\",\\"provider_config\\":{\\"model\\":\\"glm-test\\",\\"apiKeyEnv\\":\\"ZAI_CODE_KEY\\"}}]"',
                    'export FA_PROVIDERS_QUEUE="\\$ENV_VAR_DEV_QUEUE"',
                    'export ZAI_CODE_KEY="$K_HEALTHY" ZAI_CODE_KEY_1="$K_EXHAUSTED" ZAI_CODE_KEY_2="$K_NOPLAN" ZAI_CODE_KEY_3="$K_AUTH" ZAI_CODE_KEY_4="$K_TIMEOUT" ZAI_CODE_KEY_5="$K_SHAPE"',
                    'source "$REPO_ROOT/scripts/providers/fa.sh"',
                    '# stderr -> file (a $() capture would run _fa_resolve_env in a subshell and lose its env mutations)',
                    'exec 2> "$TMP/stderr.log"',
                    '_fa_resolve_env',
                    'grep -q "queue re-ordered by remaining z.ai quota" "$TMP/stderr.log" || { echo "NO_REORDER_LOG"; exit 1; }',
                    'if grep -q "$K_HEALTHY" "$TMP/stderr.log"; then echo "KEY_VALUE_LEAK"; exit 1; fi',
                    'if grep -q "Bearer" "$TMP/stderr.log"; then echo "BEARER_LEAK"; exit 1; fi',
                    '# the key must ride curl stdin config (-K -), never argv (ps/proc cmdline exposure)',
                    'if grep -q "Bearer" "$FAKE_CURL_ARGV_LOG"; then echo "KEY_IN_ARGV"; exit 1; fi',
                    'if grep -q -e "$K_HEALTHY" -e "$K_AUTH" "$FAKE_CURL_ARGV_LOG"; then echo "KEY_VALUE_IN_ARGV"; exit 1; fi',
                    'ORDER="$(printf "%s" "$FA_PROVIDERS_QUEUE" | grep -o "\\"apiKeyEnv\\":\\"ZAI_CODE_KEY[0-9_]*\\"" | sed "s/^.*://;s/\\"//g" | tr "\\n" "-")"',
                    '# healthy first; unknown (500 / timeout / shape) keep static slots; exhausted (0) + 401 at the END',
                    '[ "$ORDER" = "ZAI_CODE_KEY-ZAI_CODE_KEY_2-ZAI_CODE_KEY_4-ZAI_CODE_KEY_5-ZAI_CODE_KEY_1-ZAI_CODE_KEY_3-" ] || { echo "ORDER=$ORDER"; exit 1; }',
                    'CALLS="$(wc -l < "$FAKE_CURL_LOG" | tr -d " ")"',
                    'UNIQ="$(sort -u "$FAKE_CURL_LOG" | wc -l | tr -d " ")"',
                    '[ "$CALLS" = "6" ] || { echo "CALLS=$CALLS"; exit 1; }',
                    '[ "$UNIQ" = "6" ] || { echo "UNIQ=$UNIQ"; exit 1; }',
                    '[ "$FA_PROVIDER_TYPE" = "zai" ]',
                    'printf "%s" "$FA_PROVIDER_CONFIG" | grep -q "\\"apiKeyEnvVar\\":\\"ZAI_CODE_KEY\\""',
                    'echo "QUOTA_ORDER_OK"\''
                ]).join('\n')
            });
            assert.contains(out, 'QUOTA_ORDER_OK', 'quota ordering test failed: ' + out);
        });

        test('IT-2b (bash): equal-score keys preserve the static order (no churn); same key VALUE in two vars is probed once', function() {
            var out = cli_execute_command({
                command: [
                    'bash -c \'set -euo pipefail',
                    'REPO_ROOT="$(pwd)"'
                ].concat(_sdFaQuotaSharedBash_).concat([
                    'K_A="zt-eq-a-01"; K_B="zt-eq-b-02"',
                    'export K_A K_B',
                    'cat > "$FX/equal.json" << "JSONEOF"',
                    '{"code":200,"success":true,"data":{"level":"max","limits":[{"type":"CREDIT_LIMIT","unit":3,"number":5,"usage":28000,"currentValue":100,"remaining":500,"percentage":20,"nextResetTime":179394845215}]}}',
                    'JSONEOF',
                    'cat > "$BIN/curl" << "CUREOF"',
                    '#!/bin/bash',
                    'LOG="${FAKE_CURL_LOG:?}"',
                    'IFS= read -r CFG || true',
                    'KEY="${CFG#*Bearer }"',
                    'KEY="${KEY%\"}"',
                    '[ -n "$KEY" ] || exit 2',
                    'printf "%s\\n" "$KEY" >> "$LOG"',
                    'cat "$FAKE_FIXTURES/equal.json"; printf "\\n200"',
                    'CUREOF',
                    'chmod +x "$BIN/curl"',
                    'export PATH="$BIN:$PATH"',
                    'export ENV_VAR_DEV_QUEUE="[{\\"provider_type\\":\\"zai\\",\\"provider_config\\":{\\"model\\":\\"glm-test\\",\\"apiKeyEnv\\":\\"ZAI_CODE_KEY\\"}},{\\"provider_type\\":\\"zai\\",\\"provider_config\\":{\\"model\\":\\"glm-test\\",\\"apiKeyEnv\\":\\"ZAI_CODE_KEY_1\\"}}]"',
                    '# Case A: two DISTINCT keys with equal remaining -> static order byte-identical, 2 calls',
                    'export ZAI_CODE_KEY="$K_A" ZAI_CODE_KEY_1="$K_B"',
                    'export FA_PROVIDERS_QUEUE="\\$ENV_VAR_DEV_QUEUE"',
                    'source "$REPO_ROOT/scripts/providers/fa.sh"',
                    '_fa_resolve_env',
                    '[ "$FA_PROVIDERS_QUEUE" = "$ENV_VAR_DEV_QUEUE" ] || { echo "CHURN=$FA_PROVIDERS_QUEUE"; exit 1; }',
                    'CALLS="$(wc -l < "$FAKE_CURL_LOG" | tr -d " ")"',
                    '[ "$CALLS" = "2" ] || { echo "CALLS=$CALLS"; exit 1; }',
                    '# Case B: same key VALUE behind two vars (same-account set) -> ONE call, still static',
                    'unset FA_PROVIDER_TYPE FA_PROVIDER_CONFIG',
                    'export ZAI_CODE_KEY="$K_A" ZAI_CODE_KEY_1="$K_A"',
                    'export FA_PROVIDERS_QUEUE="\\$ENV_VAR_DEV_QUEUE"',
                    ': > "$FAKE_CURL_LOG"',
                    '_fa_resolve_env',
                    '[ "$FA_PROVIDERS_QUEUE" = "$ENV_VAR_DEV_QUEUE" ] || { echo "CHURN2=$FA_PROVIDERS_QUEUE"; exit 1; }',
                    'CALLS2="$(wc -l < "$FAKE_CURL_LOG" | tr -d " ")"',
                    '[ "$CALLS2" = "1" ] || { echo "CALLS2=$CALLS2"; exit 1; }',
                    'echo "QUOTA_EQUAL_OK"\''
                ]).join('\n')
            });
            assert.contains(out, 'QUOTA_EQUAL_OK', 'equal-score test failed: ' + out);
        });

        test('IT-2c (bash): FA_QUOTA_PROBE=off disables probing entirely — zero HTTP calls, byte-identical queue', function() {
            var out = cli_execute_command({
                command: [
                    'bash -c \'set -euo pipefail',
                    'REPO_ROOT="$(pwd)"'
                ].concat(_sdFaQuotaSharedBash_).concat([
                    'K_HEALTHY="zt-ks-healthy-01"; K_EXHAUSTED="zt-ks-exhausted-02"',
                    'export K_HEALTHY K_EXHAUSTED',
                    'cat > "$BIN/curl" << "CUREOF"',
                    '#!/bin/bash',
                    'printf "%s\\n" "$@" >> "${FAKE_CURL_LOG:?}"',
                    'exit 0',
                    'CUREOF',
                    'chmod +x "$BIN/curl"',
                    'export PATH="$BIN:$PATH"',
                    'export ENV_VAR_DEV_QUEUE="[{\\"provider_type\\":\\"zai\\",\\"provider_config\\":{\\"model\\":\\"glm-test\\",\\"apiKeyEnv\\":\\"ZAI_CODE_KEY\\"}}]"',
                    'export FA_PROVIDERS_QUEUE="\\$ENV_VAR_DEV_QUEUE"',
                    'export ZAI_CODE_KEY="$K_HEALTHY" ZAI_CODE_KEY_1="$K_EXHAUSTED"',
                    'export FA_QUOTA_PROBE=off',
                    'source "$REPO_ROOT/scripts/providers/fa.sh"',
                    '_fa_resolve_env',
                    'ORDER="$(printf "%s" "$FA_PROVIDERS_QUEUE" | grep -o "\\"apiKeyEnv\\":\\"ZAI_CODE_KEY[0-9_]*\\"" | sed "s/^.*://;s/\\"//g" | tr "\\n" "-")"',
                    '[ "$ORDER" = "ZAI_CODE_KEY-ZAI_CODE_KEY_1-" ] || { echo "ORDER=$ORDER"; exit 1; }',
                    '[ ! -s "$FAKE_CURL_LOG" ] || { echo "curl was invoked:"; cat "$FAKE_CURL_LOG"; exit 1; }',
                    'echo "QUOTA_KILLSWITCH_OK"\''
                ]).join('\n')
            });
            assert.contains(out, 'QUOTA_KILLSWITCH_OK', 'kill-switch test failed: ' + out);
        });

        test('IT-2d (bash): no curl available -> probe skipped, static order kept, leg still resolves', function() {
            var out = cli_execute_command({
                command: [
                    'bash -c \'set -euo pipefail',
                    'REPO_ROOT="$(pwd)"'
                ].concat(_sdFaQuotaSharedBash_).concat([
                    'K_A="zt-nocurl-a-01"; K_B="zt-nocurl-b-02"',
                    'export K_A K_B',
                    'NODEONLY="$TMP/nodeonly"; mkdir -p "$NODEONLY"',
                    'ln -s "$(command -v node)" "$NODEONLY/node"',
                    'ln -s "$(command -v sed)" "$NODEONLY/sed"',
                    'export ENV_VAR_DEV_QUEUE="[{\\"provider_type\\":\\"zai\\",\\"provider_config\\":{\\"model\\":\\"glm-test\\",\\"apiKeyEnv\\":\\"ZAI_CODE_KEY\\"}},{\\"provider_type\\":\\"zai\\",\\"provider_config\\":{\\"model\\":\\"glm-test\\",\\"apiKeyEnv\\":\\"ZAI_CODE_KEY_1\\"}}]"',
                    'export ZAI_CODE_KEY="$K_A" ZAI_CODE_KEY_1="$K_B"',
                    'export FA_PROVIDERS_QUEUE="\\$ENV_VAR_DEV_QUEUE"',
                    'OLD_PATH="$PATH"',
                    'export PATH="$NODEONLY"',
                    'source "$REPO_ROOT/scripts/providers/fa.sh"',
                    '_fa_resolve_env',
                    'export PATH="$OLD_PATH"',
                    'ORDER="$(printf "%s" "$FA_PROVIDERS_QUEUE" | grep -o "\\"apiKeyEnv\\":\\"ZAI_CODE_KEY[0-9_]*\\"" | sed "s/^.*://;s/\\"//g" | tr "\\n" "-")"',
                    '[ "$ORDER" = "ZAI_CODE_KEY-ZAI_CODE_KEY_1-" ] || { echo "ORDER=$ORDER"; exit 1; }',
                    '[ "$FA_PROVIDER_TYPE" = "zai" ]',
                    'echo "QUOTA_NOCURL_OK"\''
                ]).join('\n')
            });
            assert.contains(out, 'QUOTA_NOCURL_OK', 'no-curl test failed: ' + out);
        });

        test('IT-2f (bash): a non-api.z.ai baseUrl (china-platform host) is never probed — zero calls for its key, static slot kept', function() {
            var out = cli_execute_command({
                command: [
                    'bash -c \'set -euo pipefail',
                    'REPO_ROOT="$(pwd)"'
                ].concat(_sdFaQuotaSharedBash_).concat([
                    'K_CN="zt-cn-host-01"; K_ZAI="zt-global-02"',
                    'export K_CN K_ZAI',
                    'cat > "$BIN/curl" << "CUREOF"',
                    '#!/bin/bash',
                    'LOG="${FAKE_CURL_LOG:?}"',
                    'IFS= read -r CFG || true',
                    'KEY="${CFG#*Bearer }"',
                    'KEY="${KEY%\"}"',
                    '[ -n "$KEY" ] || exit 2',
                    'printf "%s\\n" "$KEY" >> "$LOG"',
                    'cat "$FAKE_FIXTURES/healthy.json"; printf "\\n200"',
                    'CUREOF',
                    'chmod +x "$BIN/curl"',
                    'export PATH="$BIN:$PATH"',
                    'export ENV_VAR_DEV_QUEUE="[{\\"provider_type\\":\\"zai\\",\\"provider_config\\":{\\"model\\":\\"glm-test\\",\\"apiKeyEnv\\":\\"ZAI_CODE_KEY\\",\\"baseUrl\\":\\"https://api.z.ai.cn/api/coding/paas/v4\\"}},{\\"provider_type\\":\\"zai\\",\\"provider_config\\":{\\"model\\":\\"glm-test\\",\\"apiKeyEnv\\":\\"ZAI_CODE_KEY_1\\"}}]"',
                    'export FA_PROVIDERS_QUEUE="\\$ENV_VAR_DEV_QUEUE"',
                    'export ZAI_CODE_KEY="$K_CN" ZAI_CODE_KEY_1="$K_ZAI"',
                    'source "$REPO_ROOT/scripts/providers/fa.sh"',
                    'exec 2> "$TMP/stderr.log"',
                    '_fa_resolve_env',
                    '# the china-platform key must never reach the global endpoint (host-boundary guard)',
                    '[ ! grep -q "$K_CN" "$FAKE_CURL_LOG" ] || { echo "CN_KEY_PROBED"; exit 1; }',
                    'CALLS="$(wc -l < "$FAKE_CURL_LOG" | tr -d " ")"',
                    '[ "$CALLS" = "1" ] || { echo "CALLS=$CALLS"; exit 1; }',
                    '# the canonical entry is probed healthy -> primary; the china entry keeps its static slot ("not-probed")',
                    'grep -q "not-probed" "$TMP/stderr.log" || { echo "NO_NOT_PROBED_WHY"; exit 1; }',
                    'ORDER="$(printf "%s" "$FA_PROVIDERS_QUEUE" | grep -o "\\"apiKeyEnv\\":\\"ZAI_CODE_KEY[0-9_]*\\"" | sed "s/^.*://;s/\\"//g" | tr "\\n" "-")"',
                    '[ "$ORDER" = "ZAI_CODE_KEY_1-ZAI_CODE_KEY-" ] || { echo "ORDER=$ORDER"; exit 1; }',
                    '[ "$FA_PROVIDER_TYPE" = "zai" ]',
                    'echo "QUOTA_HOST_BOUNDARY_OK"\''
                ]).join('\n')
            });
            assert.contains(out, 'QUOTA_HOST_BOUNDARY_OK', 'host-boundary test failed: ' + out);
        });

        test('IT-2g (bash): aggregate probe budget stops the fan-out — unprobed keys keep static slots, leg still resolves', function() {
            var out = cli_execute_command({
                command: [
                    'bash -c \'set -euo pipefail',
                    'REPO_ROOT="$(pwd)"'
                ].concat(_sdFaQuotaSharedBash_).concat([
                    'K_EXHAUSTED="zt-budget-exh-01"; K_A="zt-budget-a-02"; K_B="zt-budget-b-03"; K_C="zt-budget-c-04"',
                    'export K_EXHAUSTED K_A K_B K_C',
                    'cat > "$BIN/curl" << "CUREOF"',
                    '#!/bin/bash',
                    'LOG="${FAKE_CURL_LOG:?}"',
                    'IFS= read -r CFG || true',
                    'KEY="${CFG#*Bearer }"',
                    'KEY="${KEY%\"}"',
                    'printf "%s\\n" "$KEY" >> "$LOG"',
                    'sleep 1',
                    'if [ "$KEY" = "$K_EXHAUSTED" ]; then cat "$FAKE_FIXTURES/exhausted.json"; else cat "$FAKE_FIXTURES/healthy.json"; fi',
                    'printf "\\n200"',
                    'CUREOF',
                    'chmod +x "$BIN/curl"',
                    'export PATH="$BIN:$PATH"',
                    'export ENV_VAR_DEV_QUEUE="[{\\"provider_type\\":\\"zai\\",\\"provider_config\\":{\\"model\\":\\"glm-test\\",\\"apiKeyEnv\\":\\"ZAI_CODE_KEY\\"}},{\\"provider_type\\":\\"zai\\",\\"provider_config\\":{\\"model\\":\\"glm-test\\",\\"apiKeyEnv\\":\\"ZAI_CODE_KEY_1\\"}},{\\"provider_type\\":\\"zai\\",\\"provider_config\\":{\\"model\\":\\"glm-test\\",\\"apiKeyEnv\\":\\"ZAI_CODE_KEY_2\\"}},{\\"provider_type\\":\\"zai\\",\\"provider_config\\":{\\"model\\":\\"glm-test\\",\\"apiKeyEnv\\":\\"ZAI_CODE_KEY_3\\"}}]"',
                    'export FA_PROVIDERS_QUEUE="\\$ENV_VAR_DEV_QUEUE"',
                    'export ZAI_CODE_KEY="$K_EXHAUSTED" ZAI_CODE_KEY_1="$K_A" ZAI_CODE_KEY_2="$K_B" ZAI_CODE_KEY_3="$K_C"',
                    '# budget knob (default 10 s) — 600 ms so the 1 s fake curl exhausts it after the FIRST probe',
                    'export FA_QUOTA_PROBE_BUDGET_MS=600',
                    'source "$REPO_ROOT/scripts/providers/fa.sh"',
                    'exec 2> "$TMP/stderr.log"',
                    '_fa_resolve_env',
                    '# one real probe only; keys 2-4 are skipped by the budget and keep their static slots',
                    'CALLS="$(wc -l < "$FAKE_CURL_LOG" | tr -d " ")"',
                    '[ "$CALLS" = "1" ] || { echo "CALLS=$CALLS"; exit 1; }',
                    'grep -q "probe-budget" "$TMP/stderr.log" || { echo "NO_BUDGET_WHY"; cat "$TMP/stderr.log"; exit 1; }',
                    'grep -q "exhausted" "$TMP/stderr.log" || { echo "NO_EXHAUSTED_WHY"; exit 1; }',
                    'ORDER="$(printf "%s" "$FA_PROVIDERS_QUEUE" | grep -o "\\"apiKeyEnv\\":\\"ZAI_CODE_KEY[0-9_]*\\"" | sed "s/^.*://;s/\\"//g" | tr "\\n" "-")"',
                    '# probed exhausted key demoted to the END; probe-budget keys keep static order',
                    '[ "$ORDER" = "ZAI_CODE_KEY_1-ZAI_CODE_KEY_2-ZAI_CODE_KEY_3-ZAI_CODE_KEY-" ] || { echo "ORDER=$ORDER"; exit 1; }',
                    '[ "$FA_PROVIDER_TYPE" = "zai" ]',
                    'echo "QUOTA_BUDGET_OK"\''
                ]).join('\n')
            });
            assert.contains(out, 'QUOTA_BUDGET_OK', 'probe-budget test failed: ' + out);
        });

        test('IT-2e (live IT, opt-in FA_QUOTA_LIVE_IT=on): real endpoint re-orders when two keys have different remaining (skipped otherwise)', function() {
            var out = cli_execute_command({
                command: [
                    'bash -c \'set -euo pipefail',
                    'REPO_ROOT="$(pwd)"',
                    'unset FA_PROVIDER_TYPE FA_PROVIDER_CONFIG FA_PROVIDERS_QUEUE FA_QUOTA_PROBE',
                    'unset ZAI_CODE_KEY_2 ZAI_CODE_KEY_3 ZAI_CODE_KEY_4 ZAI_CODE_KEY_5 ENV_VAR_DEV_QUEUE',
                    '# opt-in gate (gh-1385 rework): exported runner creds must NOT turn the shared suite',
                    '# into live third-party HTTP on every run — the offline matrix pins the logic.',
                    'if [ "${FA_QUOTA_LIVE_IT:-off}" != "on" ]; then echo "QUOTA_LIVE_SKIPPED"; exit 0; fi',
                    'TMP="$(mktemp -d)"',
                    'trap "rm -rf \\"$TMP\\"" EXIT',
                    'export ENV_VAR_DEV_QUEUE="[{\\"provider_type\\":\\"zai\\",\\"provider_config\\":{\\"model\\":\\"glm-test\\",\\"apiKeyEnv\\":\\"ZAI_CODE_KEY\\"}},{\\"provider_type\\":\\"zai\\",\\"provider_config\\":{\\"model\\":\\"glm-test\\",\\"apiKeyEnv\\":\\"ZAI_CODE_KEY_1\\"}}]"',
                    'export FA_PROVIDERS_QUEUE="\\$ENV_VAR_DEV_QUEUE"',
                    'source "$REPO_ROOT/scripts/providers/fa.sh"',
                    '_fa_resolve_env',
                    'FIRST="$(printf "%s" "$FA_PROVIDERS_QUEUE" | grep -o "\\"apiKeyEnv\\":\\"ZAI_CODE_KEY[0-9_]*\\"" | head -1 | sed "s/^.*://;s/\\"//g")"',
                    'cat > "$TMP/measure.js" << "MEOF"',
                    'const cp = require("child_process");',
                    'function remaining(key) {',
                    ' let out = null;',
                    ' try {',
                    '  out = cp.execFileSync("curl", ["-sS", "-m", "8", "-H", "Authorization: Bearer " + key, "-w", "\\n%{http_code}", "https://api.z.ai/api/monitor/usage/quota/limit"], { encoding: "utf8", timeout: 12000, stdio: ["ignore", "pipe", "pipe"] });',
                    ' } catch (e) { return null; }',
                    ' const nl = out.lastIndexOf("\\n");',
                    ' if (parseInt(out.slice(nl + 1).trim(), 10) !== 200) return null;',
                    ' try {',
                    '  const limits = JSON.parse(out.slice(0, nl)).data.limits;',
                    '  let win = null;',
                    '  for (const l of limits) { if (l && l.number === 5 && l.unit === 3) { win = l; break; } }',
                    '  if (!win) {',
                    '   const rs = limits.filter(l => l && typeof l.nextResetTime === "number").sort((a, b) => a.nextResetTime - b.nextResetTime);',
                    '   if (rs.length > 0) win = rs[0];',
                    '  }',
                    '  return win && typeof win.remaining === "number" ? win.remaining : null;',
                    ' } catch (e) { return null; }',
                    '}',
                    'const a = remaining(process.env.FA_PROBE_KEY_A);',
                    'const b = remaining(process.env.FA_PROBE_KEY_B);',
                    'process.stdout.write(a === null || b === null || a === b ? "EQ_OR_UNKNOWN" : (a > b ? "A_FIRST" : "B_FIRST"));',
                    'MEOF',
                    'VERDICT="$(FA_PROBE_KEY_A="$ZAI_CODE_KEY" FA_PROBE_KEY_B="$ZAI_CODE_KEY_1" node "$TMP/measure.js")"',
                    'case "$VERDICT" in',
                    ' A_FIRST) [ "$FIRST" = "ZAI_CODE_KEY" ] || { echo "VERDICT=$VERDICT FIRST=$FIRST"; exit 1; } ;;',
                    ' B_FIRST) [ "$FIRST" = "ZAI_CODE_KEY_1" ] || { echo "VERDICT=$VERDICT FIRST=$FIRST"; exit 1; } ;;',
                    ' *) echo "live probe inconclusive — static order accepted (FIRST=$FIRST)" ;;',
                    'esac',
                    'echo "QUOTA_LIVE_OK"\''
                ].join('\n')
            });
            assert.ok(out.indexOf('QUOTA_LIVE_OK') !== -1 || out.indexOf('QUOTA_LIVE_SKIPPED') !== -1,
                'live IT failed: ' + out);
        });
    });
}
