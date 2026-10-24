/**
 * Unit tests for js/factory/mark_job_done.js — the issue task-list job
 * marker (port of awf scripts/mark-job-done.sh, extracted byte-exact in
 * IstiN/dmtools-agentic-workflows#34 from the factory-teammate.yml
 * «Mark machine job done (issue task list)» step).
 *
 * Owner directive 2026-10-13/14: factory glue moves into dmtools-agents as
 * JS agent code; awf workflows become thin callers (final rewire PR later —
 * the sh + its A/B harness stay intact as the executable spec until every
 * block is ported).
 *
 * Behavior contract (1:1 with the sh):
 *   mark     = success→✅ failure→❌ cancelled→🚫 else→"⚠️ <JOB_RESULT>"
 *   end      = UTC HH:MM
 *   flip     = every body line that CONTAINS "(<RUN_URL>)" (literal needle,
 *              awk index()) AND starts "- [ ] " becomes "- [x] ", and if the
 *              line matches /started \d\d:\d\d/ the tail from the FIRST
 *              full-pattern "started \d\d:\d\d .*$" occurrence is replaced
 *              with "<st> · done <end> <mark>" (st from match(), possibly a
 *              different occurrence than the replace hit — awk sub quirk,
 *              kept byte-identical).
 *   changed  → gh issue edit --body-file + "job marker flipped to [x] <mark>"
 *   unchanged→ "::warning::start marker not found for <RUN_URL> — nothing to flip"
 *
 * Pure functions at module top; the publisher takes { exec, writeFile,
 * clock, log } capturers (factoryState.js convention) — no global tool
 * calls. assert = the harness global (equal/deepEqual/ok/contains/throws).
 */

var assert = globalThis.assert;

var tokenUsageModule = loadModule('js/factory/token_usage.js', makeRequire({}, {}), {});
var mjdModule = loadModule('js/factory/mark_job_done.js', makeRequire({
  './token_usage.js': tokenUsageModule
}), {});

// Fixed clock: 2026-10-13T12:34:56Z → "12:34".
var RUN_URL = 'https://github.com/IstiN/target-repo/actions/runs/1777';
var NOW_MS = Date.UTC(2026, 9, 13, 12, 34, 56);

// ── markFor ──────────────────────────────────────────────────────────────────

suite('factoryMarkJobDone — markFor', function () {

  test('success → ✅', function () {
    assert.equal(mjdModule.markFor('success'), '✅');
  });

  test('failure → ❌', function () {
    assert.equal(mjdModule.markFor('failure'), '❌');
  });

  test('cancelled → 🚫', function () {
    assert.equal(mjdModule.markFor('cancelled'), '🚫');
  });

  test('unknown result → "⚠️ <result>"', function () {
    assert.equal(mjdModule.markFor('superseded'), '⚠️ superseded');
  });

  test('empty result → "⚠️ " (the sh case-* fallback with unset JOB_RESULT)', function () {
    assert.equal(mjdModule.markFor(''), '⚠️ ');
  });
});

// ── flipTaskListItems (the awk port — parity core) ──────────────────────────

suite('factoryMarkJobDone — flipTaskListItems', function () {

  test('flips the run-url checkbox line and appends the done suffix', function () {
    var body = '- [ ] Run factory agent started 09:15 [1777](' + RUN_URL + ')\n';
    var r = mjdModule.flipTaskListItems(body, RUN_URL, '✅', '12:34');
    assert.equal(r.body, '- [x] Run factory agent started 09:15 · done 12:34 ✅\n');
    assert.equal(r.flipped, 1);
  });

  test('only lines whose checkbox is unchecked flip', function () {
    var body = '- [x] Run factory agent started 09:15 [1777](' + RUN_URL + ')\n';
    var r = mjdModule.flipTaskListItems(body, RUN_URL, '✅', '12:34');
    assert.equal(r.body, body);
    assert.equal(r.flipped, 0);
  });

  test('the run url is a literal "(url)" needle — bare occurrences do not flip', function () {
    var body = '- [ ] plain mention ' + RUN_URL + ' without parens\n';
    var r = mjdModule.flipTaskListItems(body, RUN_URL, '✅', '12:34');
    assert.equal(r.body, body);
    assert.equal(r.flipped, 0);
  });

  test('near-miss run url (different id) does not flip', function () {
    var other = 'https://github.com/IstiN/target-repo/actions/runs/1778';
    var body = '- [ ] Run factory agent started 09:15 [1778](' + other + ')\n';
    var r = mjdModule.flipTaskListItems(body, RUN_URL, '✅', '12:34');
    assert.equal(r.flipped, 0);
  });

  test('non-checkbox line containing the url is untouched', function () {
    var body = 'Log for ' + RUN_URL + ' stays as-is\n';
    var r = mjdModule.flipTaskListItems(body, RUN_URL, '✅', '12:34');
    assert.equal(r.body, body);
    assert.equal(r.flipped, 0);
  });

  test('unchecked line without a started time flips without a done suffix', function () {
    var body = '- [ ] Run factory agent [1777](' + RUN_URL + ')\n';
    var r = mjdModule.flipTaskListItems(body, RUN_URL, '✅', '12:34');
    assert.equal(r.body, '- [x] Run factory agent [1777](' + RUN_URL + ')\n');
    assert.equal(r.flipped, 1);
  });

  test('single-digit hour "started 9:15" does not match the two-digit pattern', function () {
    var body = '- [ ] Run started 9:15 [1777](' + RUN_URL + ')\n';
    var r = mjdModule.flipTaskListItems(body, RUN_URL, '✅', '12:34');
    assert.equal(r.body, '- [x] Run started 9:15 [1777](' + RUN_URL + ')\n');
  });

  test('"started 0915" (no colon) does not match', function () {
    var body = '- [ ] Run started 0915 [1777](' + RUN_URL + ')\n';
    var r = mjdModule.flipTaskListItems(body, RUN_URL, '✅', '12:34');
    assert.equal(r.body, '- [x] Run started 0915 [1777](' + RUN_URL + ')\n');
  });

  test('one non-digit in the minute "started 09:4a" does not match', function () {
    var body = '- [ ] Run started 09:4a [1777](' + RUN_URL + ')\n';
    var r = mjdModule.flipTaskListItems(body, RUN_URL, '✅', '12:34');
    assert.equal(r.body, '- [x] Run started 09:4a [1777](' + RUN_URL + ')\n');
  });

  test('checkbox without trailing space: no flip, but the done tail still lands (awk guard has no trailing space)', function () {
    var body = '- [ ]Run started 09:15 [1777](' + RUN_URL + ')\n';
    var r = mjdModule.flipTaskListItems(body, RUN_URL, '✅', '12:34');
    assert.equal(r.body, '- [ ]Run started 09:15 · done 12:34 ✅\n');
    assert.equal(r.flipped, 1, 'body changed (cmp -s would see a diff)');
  });

  test('checkbox without trailing space and no started time: fully untouched', function () {
    var body = '- [ ]Run [1777](' + RUN_URL + ')\n';
    var r = mjdModule.flipTaskListItems(body, RUN_URL, '✅', '12:34');
    assert.equal(r.body, body);
    assert.equal(r.flipped, 0);
  });

  test('several matching lines all flip', function () {
    var body = '- [ ] A started 09:15 (' + RUN_URL + ')\n' +
               '- [ ] B started 10:00 (' + RUN_URL + ')\n';
    var r = mjdModule.flipTaskListItems(body, RUN_URL, '❌', '12:34');
    assert.equal(r.body,
      '- [x] A started 09:15 · done 12:34 ❌\n' +
      '- [x] B started 10:00 · done 12:34 ❌\n');
    assert.equal(r.flipped, 2);
  });

  test('time at absolute end-of-line (no trailing space): flips but no done suffix (awk-verified)', function () {
    var body = '- [ ] Run [1777](' + RUN_URL + ') started 09:15';
    var r = mjdModule.flipTaskListItems(body, RUN_URL, '✅', '12:34');
    assert.equal(r.body, '- [x] Run [1777](' + RUN_URL + ') started 09:15\n');
  });

  test('trailing space at EOL: empty .* still matches → done suffix lands, trailing space consumed', function () {
    var body = '- [ ] Run started 09:15 [1777](' + RUN_URL + ') \n';
    var r = mjdModule.flipTaskListItems(body, RUN_URL, '✅', '12:34');
    assert.equal(r.body, '- [x] Run started 09:15 · done 12:34 ✅\n');
  });

  test('first match() wins for st when the replace must skip it (awk quirk, awk-verified)', function () {
    // "09:00" is followed directly by "started" (no space) — match() finds
    // "started 09:00" but the full tail pattern first matches at the LATER
    // "started 10:00 tail…", whose replacement TEXT reuses st. Verified
    // byte-for-byte against the sh's awk program (see the parity harness).
    var body = '- [ ] A started 09:00started 10:00 tail [1777](' + RUN_URL + ')\n';
    var r = mjdModule.flipTaskListItems(body, RUN_URL, '✅', '12:34');
    assert.equal(r.body,
      '- [x] A started 09:00started 09:00 · done 12:34 ✅\n');
  });

  test('already-done tail is replaced wholesale — everything after "started HH:MM " is consumed (awk-verified)', function () {
    var body = '- [ ] Run started 09:15 · done 09:40 ✅ [1777](' + RUN_URL + ')\n';
    var r = mjdModule.flipTaskListItems(body, RUN_URL, '❌', '12:34');
    assert.equal(r.body, '- [x] Run started 09:15 · done 12:34 ❌\n');
  });

  test('body without trailing newline still comes out with one (awk { print } ORS)', function () {
    var body = '- [ ] Run started 09:15 (' + RUN_URL + ')';
    var r = mjdModule.flipTaskListItems(body, RUN_URL, '✅', '12:34');
    assert.equal(r.body, '- [x] Run started 09:15 · done 12:34 ✅\n');
  });

  test('CRLF record: the replaced tail consumes the CR (awk .* eats it)', function () {
    var body = '- [ ] Run started 09:15 (' + RUN_URL + ')\r\n- [ ] other\r\n';
    var r = mjdModule.flipTaskListItems(body, RUN_URL, '✅', '12:34');
    assert.equal(r.body, '- [x] Run started 09:15 · done 12:34 ✅\n- [ ] other\r\n');
  });

  test('empty body is a no-op', function () {
    var r = mjdModule.flipTaskListItems('', RUN_URL, '✅', '12:34');
    assert.equal(r.body, '');
    assert.equal(r.flipped, 0);
  });

  test('CR stays attached on CRLF bodies outside the replaced tail', function () {
    var body = '- [ ] Run [1777](' + RUN_URL + ')\r\n- [ ] other\r\n';
    var r = mjdModule.flipTaskListItems(body, RUN_URL, '✅', '12:34');
    assert.equal(r.body, '- [x] Run [1777](' + RUN_URL + ')\r\n- [ ] other\r\n');
  });

  test('unknown-result mark flows into the done suffix', function () {
    var body = '- [ ] Run started 09:15 (' + RUN_URL + ')\n';
    var r = mjdModule.flipTaskListItems(body, RUN_URL, '⚠️ superseded', '12:34');
    assert.equal(r.body, '- [x] Run started 09:15 · done 12:34 ⚠️ superseded\n');
  });
});

// ── markJobDone (orchestration, capturer-injected) ──────────────────────────

suite('factoryMarkJobDone — markJobDone', function () {

  function ioStub(body, map) {
    var io = {
      commands: [],
      written: null,
      logLines: [],
      exec: function (cmd) {
        io.commands.push(cmd);
        if (cmd.indexOf('issue view') !== -1) {
          if (map && map.viewThrows) throw new Error('gh: view failed');
          return body;
        }
        if (cmd.indexOf('issue edit') !== -1) {
          if (map && map.editThrows) throw new Error('gh: edit failed');
          return '';
        }
        throw new Error('unexpected command: ' + cmd);
      },
      writeFile: function (path, content) { io.written = { path: path, content: content }; },
      clock: function () { return new Date(NOW_MS); },
      log: function (line) { io.logLines.push(line); }
    };
    return io;
  }

  test('flipped path: exact view cmd, temp write, exact edit cmd, sh log line', function () {
    var body = '- [ ] Run factory agent started 09:15 [1777](' + RUN_URL + ')\n';
    var io = ioStub(body);
    var r = mjdModule.markJobDone({
      repo: 'IstN/target-repo', number: 42, runUrl: RUN_URL,
      jobResult: 'success', endTs: '12:34'
    }, io);
    assert.equal(io.commands[0], "gh issue view '42' --repo 'IstN/target-repo' --json body -q .body");
    assert.equal(io.commands[1], "gh issue edit '42' --repo 'IstN/target-repo' --body-file '/tmp/issue_body_new.md'");
    assert.ok(io.written, 'temp body written');
    assert.equal(io.written.path, '/tmp/issue_body_new.md');
    assert.equal(io.written.content, '- [x] Run factory agent started 09:15 · done 12:34 ✅\n');
    assert.equal(io.logLines.join('\n'), 'job marker flipped to [x] ✅');
    assert.equal(r.status, 'flipped');
    assert.equal(r.mark, '✅');
    assert.equal(r.flipped, 1);
  });

  test('custom tempPath is honored', function () {
    var body = '- [ ] Run started 09:15 (' + RUN_URL + ')\n';
    var io = ioStub(body);
    mjdModule.markJobDone({
      repo: 'O/R', number: 7, runUrl: RUN_URL, jobResult: 'failure',
      endTs: '23:59', tempPath: '/var/tmp/issue_body_new.md'
    }, io);
    assert.equal(io.commands[1], "gh issue edit '7' --repo 'O/R' --body-file '/var/tmp/issue_body_new.md'");
    assert.equal(io.written.path, '/var/tmp/issue_body_new.md');
  });

  test('no-marker path: no write, no edit, sh warning line', function () {
    var io = ioStub('- [ ] other task\n- [x] done task\n');
    var r = mjdModule.markJobDone({
      repo: 'O/R', number: 42, runUrl: RUN_URL, jobResult: 'success', endTs: '12:34'
    }, io);
    assert.equal(io.commands.length, 1, 'only the view ran');
    assert.equal(io.written, null);
    assert.equal(io.logLines.join('\n'),
      '::warning::start marker not found for ' + RUN_URL + ' — nothing to flip');
    assert.equal(r.status, 'no-marker');
    assert.equal(r.flipped, 0);
  });

  test('endTs defaults to the injected UTC clock (12:34)', function () {
    var body = '- [ ] Run started 09:15 (' + RUN_URL + ')\n';
    var io = ioStub(body);
    var r = mjdModule.markJobDone({
      repo: 'O/R', number: 42, runUrl: RUN_URL, jobResult: 'success'
    }, io);
    assert.equal(r.endTs, '12:34');
    assert.equal(io.written.content, '- [x] Run started 09:15 · done 12:34 ✅\n');
  });

  test('gh view failure propagates (the sh dies under bash -e)', function () {
    var io = ioStub('', { viewThrows: true });
    assert.throws(function () {
      mjdModule.markJobDone({
        repo: 'O/R', number: 42, runUrl: RUN_URL, jobResult: 'success'
      }, io);
    });
  });

  test('gh edit failure propagates', function () {
    var io = ioStub('- [ ] Run started 09:15 (' + RUN_URL + ')\n', { editThrows: true });
    assert.throws(function () {
      mjdModule.markJobDone({
        repo: 'O/R', number: 42, runUrl: RUN_URL, jobResult: 'success'
      }, io);
    });
  });
});

// ── JSRunner entry (mark_job_done_publish.js) ───────────────────────────────

suite('factoryMarkJobDone — entry action (mark_job_done_publish.js)', function () {

  var writtenObj = {};
  var writtenStdout = {};
  var writtenStr = {};

  var entryModule = loadModule('js/factory/mark_job_done_publish.js', makeRequire({
    './mark_job_done.js': mjdModule
  }), {});

  test('resolveParams: customParams win over env, env over defaults', function () {
    var p = entryModule.resolveParams(
      { jobParams: { customParams: { number: '1', repo: 'C/R' } } },
      { NUMBER: '42', GITHUB_REPOSITORY: 'E/R', RUN_URL: 'u', JOB_RESULT: 'success' });
    assert.equal(p.number, '1');
    assert.equal(p.repo, 'C/R');
    assert.equal(p.runUrl, 'u');
    assert.equal(p.jobResult, 'success');
  });

  test('resolveParams: env fallback fills the rest', function () {
    var p = entryModule.resolveParams({}, { NUMBER: '42', GITHUB_REPOSITORY: 'E/R' });
    assert.equal(p.number, '42');
    assert.equal(p.repo, 'E/R');
    assert.equal(p.runUrl, '');
    assert.equal(p.jobResult, '');
  });

  test('resolveParams: no input at all degrades to empty strings (no throw)', function () {
    var p = entryModule.resolveParams(undefined, undefined);
    assert.equal(p.number, '');
    assert.equal(p.repo, '');
  });

  test('action wires cli_execute_command/file_write capturers end-to-end', function () {
    var commands = [];
    var written = null;
    var r = entryModule.action(
      { jobParams: { customParams: {
        repo: 'IstN/target-repo', number: '42', runUrl: RUN_URL,
        jobResult: 'success', endTs: '12:34'
      } } },
      {
        cli_execute_command: function (args) {
          var cmd = String((args && args.command) || args || '');
          commands.push(cmd);
          if (cmd.indexOf('issue view') !== -1) {
            return '- [ ] Run started 09:15 [1777](' + RUN_URL + ')\n';
          }
          return '';
        },
        file_write: function (path, content) { written = { path: path, content: content }; },
        env: {}
      });
    assert.equal(commands[0], "gh issue view '42' --repo 'IstN/target-repo' --json body -q .body");
    assert.equal(commands[1], "gh issue edit '42' --repo 'IstN/target-repo' --body-file '/tmp/issue_body_new.md'");
    assert.equal(written.content, '- [x] Run started 09:15 · done 12:34 ✅\n');
    assert.equal(r.status, 'flipped');
  });

  test('action unwraps a result-object transport ({output}) — String() would silently no-op the flip', function () {
    var r = entryModule.action(
      { jobParams: { customParams: {
        repo: 'IstN/target-repo', number: '42', runUrl: RUN_URL,
        jobResult: 'success', endTs: '12:34'
      } } },
      {
        // the runtime transport shape (cli_execute_command in some dmtools
        // runtimes returns a result object, not a bare string)
        cli_execute_command: function () {
          return { output: '- [ ] Run started 09:15 [1777](' + RUN_URL + ')\n' };
        },
        file_write: function (path, content) { writtenObj.content = content; },
        env: {}
      });
    assert.equal(r.status, 'flipped', 'result-object transport must still flip');
    assert.equal(writtenObj.content, '- [x] Run started 09:15 · done 12:34 ✅\n');
  });

  test('action unwraps a result-object transport ({stdout}) too', function () {
    var r = entryModule.action(
      { jobParams: { customParams: {
        repo: 'IstN/target-repo', number: '42', runUrl: RUN_URL,
        jobResult: 'success', endTs: '12:34'
      } } },
      {
        cli_execute_command: function () {
          return { stdout: '- [ ] Run started 09:15 [1777](' + RUN_URL + ')\n' };
        },
        file_write: function (path, content) { writtenStdout.content = content; },
        env: {}
      });
    assert.equal(r.status, 'flipped');
    assert.equal(writtenStdout.content, '- [x] Run started 09:15 · done 12:34 ✅\n');
  });

  test('action with a plain-string transport keeps working (backward compat)', function () {
    var r = entryModule.action(
      { jobParams: { customParams: {
        repo: 'IstN/target-repo', number: '42', runUrl: RUN_URL,
        jobResult: 'success', endTs: '12:34'
      } } },
      {
        cli_execute_command: function () {
          return '- [ ] Run started 09:15 [1777](' + RUN_URL + ')\n';
        },
        file_write: function (path, content) { writtenStr.content = content; },
        env: {}
      });
    assert.equal(r.status, 'flipped');
    assert.equal(writtenStr.content, '- [x] Run started 09:15 · done 12:34 ✅\n');
  });

  test('action with a throwing transport surfaces the error (stubbed — no network, AGENTS.md mock rule)', function () {
    assert.throws(function () {
      entryModule.action(
        { jobParams: { customParams: { repo: 'O/R', number: '1', runUrl: 'u', jobResult: 'success' } } },
        {
          cli_execute_command: function () { throw new Error('gh: view failed'); },
          env: {}
        });
    });
  });
});

// ── gh-1225 — entry action edge branches: global fallbacks, the missing
// file_write throw, transport unwrap paths, and the envValue no-bridge path.

suite('factoryMarkJobDone — entry action edge branches (gh-1225)', function () {

  function bodyExec() {
    var calls = [];
    return {
      calls: calls,
      exec: function (args) {
        var cmd = String((args && args.command) || args || '');
        calls.push(cmd);
        if (cmd.indexOf('issue view') !== -1) {
          return '- [ ] Run started 09:15 [1777](' + RUN_URL + ')\n';
        }
        return '';
      }
    };
  }

  function actionParams() {
    return { jobParams: { customParams: {
      repo: 'IstiN/target-repo', number: '42', runUrl: RUN_URL,
      jobResult: 'success', endTs: '12:34'
    } } };
  }

  test('envValue degrades to empty string without a java env bridge', function () {
    var entryModule = loadModule('js/factory/mark_job_done_publish.js', makeRequire({
      './mark_job_done.js': mjdModule
    }), {});
    assert.equal(entryModule.envValue('NUMBER'), '');
    assert.equal(entryModule.envValue('GITHUB_REPOSITORY'), '');
  });

  test('action resolves the dmtools globals when deps is omitted (default deps = {})', function () {
    var transport = bodyExec();
    var written = null;
    var entryModule = loadModule('js/factory/mark_job_done_publish.js', makeRequire({
      './mark_job_done.js': mjdModule
    }), {
      cli_execute_command: transport.exec,
      file_write: function (path, content) { written = { path: path, content: content }; }
    });
    var r = entryModule.action(actionParams());
    assert.equal(r.status, 'flipped');
    assert.equal(written.content, '- [x] Run started 09:15 · done 12:34 ✅\n');
    assert.equal(transport.calls.length, 2);
  });

  test('action throws when neither deps nor the file_write global is available', function () {
    var transport = bodyExec();
    var entryModule = loadModule('js/factory/mark_job_done_publish.js', makeRequire({
      './mark_job_done.js': mjdModule
    }), { cli_execute_command: transport.exec });
    assert.throws(function () {
      entryModule.action(actionParams());
    }, /file_write is not available/);
  });

  test('action unwraps a null transport result to an empty body (no silent [object Object])', function () {
    var entryModule = loadModule('js/factory/mark_job_done_publish.js', makeRequire({
      './mark_job_done.js': mjdModule
    }), {});
    var seen = [];
    var r = entryModule.action(actionParams(), {
      cli_execute_command: function (args) {
        var cmd = String((args && args.command) || args || '');
        seen.push(cmd);
        return null;
      },
      file_write: function () {},
      env: {}
    });
    assert.equal(r.status, 'no-marker', JSON.stringify(r));
    assert.equal(seen.length, 1, 'the flip must not run against a null body');
  });

  test('resolveParams: pick() degrades null/undefined customParams values to env/defaults', function () {
    var entryModule = loadModule('js/factory/mark_job_done_publish.js', makeRequire({
      './mark_job_done.js': mjdModule
    }), {});
    var p = entryModule.resolveParams(
      { jobParams: { customParams: { number: null, runUrl: undefined } } },
      { NUMBER: '42', RUN_URL: 'u' });
    assert.equal(p.number, '42');
    assert.equal(p.runUrl, 'u');
  });
});
