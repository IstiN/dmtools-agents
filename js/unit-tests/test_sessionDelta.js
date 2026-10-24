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
        assert.equal(
            sessionDelta.resolveSessionStateDir({ env: { FA_SESSION_ROOT: '/workspace/.dmtools/fa-sessions/r/k/dev-write/' } }),
            '/workspace/.dmtools/fa-sessions/r/k/dev-write'
        );
        assert.equal(
            sessionDelta.resolveSessionStateDir({ env: { COPILOT_HOME: '/tmp/copilot-home' } }),
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
