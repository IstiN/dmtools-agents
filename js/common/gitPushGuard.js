/**
 * Git Push Guard — canonical rule set for agent-session git push/commit
 * protection (dmtools-agents#542).
 *
 * RCA: 2026-09-26/27 night, machine loop gh-992 (IstiN/flutter_agent_harness)
 * — a rework agent leg crafted a commit tagged "(closes #992)" and pushed it
 * DIRECTLY to main (fa 8411523), bypassing PR + validation. Post-action
 * guards (pushReworkChanges.commitAndPush's base-branch invariant) only cover
 * pushes the post-action itself performs; the LLM agent's own `git push`
 * (via its shell tool) went straight past them.
 *
 * This module is the single source of truth for the guard rules. The
 * executable enforcement point is scripts/git-push-guard.sh (a `git` PATH
 * shim wired into agent sessions by scripts/run-agent.sh and the
 * factory-teammate workflow) — it mirrors these rules, and
 * js/unit-tests/test_gitPushGuard.js pins the two in sync.
 *
 * Rules:
 *  1. `git push` whose target ref is a protected branch (main, master, the
 *     remote default branch, or FA_GIT_GUARD_PROTECTED_BRANCHES entries) is
 *     refused. This covers: `git push origin main`, `git push origin
 *     HEAD:main`, `git push origin :main` / `--delete main`, `git push` from
 *     a checked-out protected branch, `--all` and `--mirror` (they push
 *     protected branches implicitly and are refused outright in agent
 *     sessions).
 *  2. `git commit` whose message contains a GitHub closing keyword
 *     ("closes/fixes/resolves #N", cross-repo "owner/repo#N", or an issue
 *     URL) is refused — closing keywords belong to the squash-merge message
 *     (PR body), which the human/merge step owns; a premature keyword
 *     auto-closes the issue before the fix is validated and merged.
 */

// Branch names that are ALWAYS protected in agent sessions, regardless of
// what the remote default branch is. Kept in sync with
// scripts/git-push-guard.sh (test_gitPushGuard.js asserts this).
var PROTECTED_BRANCHES = ['main', 'master'];

// GitHub auto-close keywords (case-insensitive) followed by an issue
// reference: #123, owner/repo#123, or an issue URL. Bare "fixes 123" without
// '#' does NOT auto-close on GitHub and is intentionally not matched (too
// many false positives: "fixed 42 tests").
var CLOSING_KEYWORD_PATTERN = /\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\s+(#[0-9]+|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[0-9]+|https?:\/\/\S+\/issues\/[0-9]+)/i;

/**
 * Returns all closing-keyword matches in a text, e.g. ["closes #992"].
 */
function findClosingKeywords(text) {
    if (!text) return [];
    var matches = [];
    var m;
    var re = new RegExp(CLOSING_KEYWORD_PATTERN.source, 'gi');
    while ((m = re.exec(text)) !== null) {
        matches.push(m[0]);
        if (matches.length > 20) break; // safety valve for pathological input
    }
    return matches;
}

/**
 * Splits a combined protected-branch env var into a normalized array.
 */
function parseProtectedList(envValue) {
    var list = [];
    if (!envValue) return list;
    String(envValue).split(/[,\s]+/).forEach(function(entry) {
        entry = entry.trim().replace(/^refs\/heads\//, '').replace(/^origin\//, '');
        if (entry && list.indexOf(entry) === -1) list.push(entry);
    });
    return list;
}

/**
 * Builds the effective protected-branch set.
 *
 * @param {Object} ctx
 * @param {string[]} [ctx.extraProtected]  - e.g. parsed FA_GIT_GUARD_PROTECTED_BRANCHES
 * @param {string}   [ctx.defaultBranch]   - remote default branch (origin/HEAD)
 */
function protectedBranches(ctx) {
    ctx = ctx || {};
    var list = PROTECTED_BRANCHES.slice();
    var extra = (ctx.extraProtected || []);
    if (ctx.defaultBranch) extra = extra.concat([ctx.defaultBranch]);
    extra.forEach(function(b) {
        b = String(b || '').trim().replace(/^refs\/heads\//, '').replace(/^origin\//, '');
        if (b && list.indexOf(b) === -1) list.push(b);
    });
    return list;
}

/**
 * Extracts the git subcommand from an argv (after the program name),
 * skipping global options. Handles: -C <dir>, -c k=v, --git-dir[=<d>],
 * --work-tree, --namespace, --exec-path, --config-env, --no-pager, -P, etc.
 *
 * @param {string[]} argv
 * @returns {{ subcommand: string|null, args: string[] }}
 */
function extractSubcommand(argv) {
    var valueOpts = {
        '-C': true, '-c': true, '--git-dir': true, '--work-tree': true,
        '--namespace': true, '--exec-path': true, '--config-env': true
    };
    var i = 0;
    while (i < argv.length) {
        var a = argv[i];
        if (valueOpts[a]) {
            i += 2;
            continue;
        }
        if (a.charAt(0) === '-') {
            // joined-value globals (--git-dir=x, -Cdir) and boolean globals
            // (--no-pager, -P, --literal-pathspecs, --version, --help, …)
            i += 1;
            continue;
        }
        return { subcommand: a, args: argv.slice(i + 1) };
    }
    return { subcommand: null, args: [] };
}

/**
 * Push options that consume the following token as their value.
 */
var PUSH_VALUE_OPTS = {
    '-o': true, '--push-option': true, '--receive-pack': true, '--exec': true,
    '--repo': true
};

/**
 * Parses `git push` args (tokens AFTER the "push" subcommand).
 *
 * @param {string[]} args
 * @param {string[]} knownRemotes - configured remote names (e.g. ["origin"])
 * @returns {{ remote: string|null, refspecs: string[], delete: boolean,
 *             all: boolean, mirror: boolean }}
 */
function parsePushArgs(args, knownRemotes) {
    knownRemotes = knownRemotes || ['origin'];
    var result = { remote: null, refspecs: [], delete: false, all: false, mirror: false };
    var i = 0;
    while (i < args.length) {
        var a = args[i];
        if (a === '--mirror') { result.mirror = true; i += 1; continue; }
        if (a === '--all') { result.all = true; i += 1; continue; }
        if (a === '-d' || a === '--delete') { result.delete = true; i += 1; continue; }
        if (PUSH_VALUE_OPTS[a]) { i += 2; continue; }
        if (a.charAt(0) === '-') { i += 1; continue; } // boolean / joined-value option
        // First positional: remote if it is a configured remote, a URL, or a
        // path; otherwise it is a refspec (remote omitted — push.default).
        if (result.remote === null && result.refspecs.length === 0 && !result.delete &&
            (knownRemotes.indexOf(a) !== -1 ||
             a.indexOf('://') !== -1 || a.indexOf('@') !== -1 ||
             a.indexOf('.git') !== -1)) {
            result.remote = a;
        } else {
            result.refspecs.push(a);
        }
        i += 1;
    }
    return result;
}

/**
 * Resolves the destination branch name a refspec would update on the remote.
 *
 * @param {string} spec   - e.g. "main", "HEAD:main", ":main", "+refs/heads/x:refs/heads/y"
 * @param {Object} ctx
 * @param {string} [ctx.currentBranch] - checked-out branch, for bare "HEAD"
 * @returns {string|null} branch name, or null when the destination is not a
 *          branch (e.g. a tag) and therefore not guarded.
 */
function refspecDestination(spec, ctx) {
    ctx = ctx || {};
    if (!spec) return null;
    spec = spec.replace(/^\+/, '');
    var src = spec, dst = spec;
    var colon = spec.indexOf(':');
    if (colon !== -1) {
        src = spec.substring(0, colon);
        dst = spec.substring(colon + 1);
    }
    if (!dst) dst = src; // "src:" — treat conservatively as touching src
    dst = dst.replace(/^refs\/heads\//, '');
    if (dst === 'HEAD') {
        dst = ctx.currentBranch || 'HEAD';
    }
    // Destinations outside the branch namespace (tags, notes, …) are not guarded.
    if (dst.indexOf('refs/') === 0 && dst.indexOf('refs/heads/') !== 0) return null;
    return dst || null;
}

/**
 * Evaluates a `git push` invocation against the guard rules.
 *
 * @param {string[]} args - tokens after "push"
 * @param {Object} ctx
 * @param {string[]} [ctx.protectedBranches] - effective set (default: main/master)
 * @param {string[]} [ctx.knownRemotes]
 * @param {string}   [ctx.currentBranch]
 * @returns {{ allowed: boolean, violations: string[], parsed: Object }}
 */
function evaluatePush(args, ctx) {
    ctx = ctx || {};
    var protectedSet = ctx.protectedBranches || protectedBranches(ctx);
    var parsed = parsePushArgs(args, ctx.knownRemotes);
    var violations = [];

    if (parsed.mirror) {
        violations.push('--mirror pushes every ref including protected branches (main/master)');
    }
    if (parsed.all) {
        violations.push('--all pushes every local branch including protected branches (main/master)');
    }

    var targets = [];
    if (parsed.refspecs.length === 0 && !parsed.mirror && !parsed.all) {
        // `git push` with no refspec: destination is the current branch
        // (push.default simple/upstream/current).
        targets.push(ctx.currentBranch || null);
    } else {
        parsed.refspecs.forEach(function(spec) {
            var dst = refspecDestination(spec, ctx);
            if (dst) targets.push(dst);
        });
    }

    targets.forEach(function(dst) {
        if (dst && protectedSet.indexOf(dst) !== -1) {
            violations.push('push targets protected branch "' + dst + '"');
        }
    });

    return { allowed: violations.length === 0, violations: violations, parsed: parsed };
}

/**
 * Extracts the commit message text from `git commit` args: all -m/--message
 * values plus the contents the caller provides for -F/--file (the caller
 * reads the file; this module stays I/O-free).
 *
 * @param {string[]} args - tokens after "commit"
 * @param {Object} [fileContents] - map of file path → content for -F/--file args
 * @returns {string}
 */
function commitMessageText(args, fileContents) {
    var parts = [];
    var i = 0;
    while (i < args.length) {
        var a = args[i];
        if (a === '-m' || a === '--message' || /^-[a-zA-Z]*m$/.test(a)) {
            if (i + 1 < args.length) { parts.push(args[i + 1]); i += 2; continue; }
            i += 1; continue;
        }
        if (a.indexOf('--message=') === 0) { parts.push(a.substring('--message='.length)); i += 1; continue; }
        if (a.indexOf('-m') === 0 && a.length > 2 && a.indexOf('--') !== 0) {
            // joined form: -m"text"
            parts.push(a.substring(2));
            i += 1; continue;
        }
        if (a === '-F' || a === '--file' || /^-[a-zA-Z]*F$/.test(a)) {
            if (i + 1 < args.length && fileContents && fileContents[args[i + 1]]) {
                parts.push(fileContents[args[i + 1]]);
            }
            i += 2; continue;
        }
        if (a.indexOf('--file=') === 0) {
            var f = a.substring('--file='.length);
            if (fileContents && fileContents[f]) parts.push(fileContents[f]);
            i += 1; continue;
        }
        i += 1;
    }
    return parts.join('\n');
}

/**
 * Evaluates a `git commit` invocation for closing keywords.
 *
 * @param {string[]} args - tokens after "commit"
 * @param {Object} [fileContents] - map for -F/--file contents
 * @returns {{ allowed: boolean, violations: string[], keywords: string[] }}
 */
function evaluateCommit(args, fileContents) {
    var text = commitMessageText(args, fileContents);
    var keywords = findClosingKeywords(text);
    var violations = keywords.map(function(k) {
        return 'commit message contains closing keyword "' + k + '" — issue-closing keywords belong to the PR body (squash-merge message), not to agent commit messages';
    });
    return { allowed: violations.length === 0, violations: violations, keywords: keywords };
}

/**
 * Loud, actionable refusal text (printed to stderr by the shim).
 */
function refusalMessage(kind, violations) {
    var lines = [
        '',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        '🛑 GIT PUSH GUARD — agent-session git ' + kind + ' REFUSED (dmtools-agents#542)',
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        ''
    ];
    violations.forEach(function(v) { lines.push('  ✗ ' + v); });
    lines.push('');
    lines.push('Agent sessions never push to the default/protected branch (main/master).');
    lines.push('Push only to the PR head branch — the ai/<ticket-key> branch or the branch');
    lines.push('recorded in input/<TICKET>/pr_info.md. Commit, push, and PR publication are');
    lines.push('performed by the automated post-actions; do not run `git push` yourself.');
    lines.push('Closing keywords (closes/fixes/resolves #N) belong to the PR body — the');
    lines.push('squash-merge message owns issue closing, never an agent commit message.');
    lines.push('');
    lines.push('Escape hatch (human/operator use only): FA_GIT_GUARD_OFF=1');
    lines.push('');
    return lines.join('\n');
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        PROTECTED_BRANCHES: PROTECTED_BRANCHES,
        CLOSING_KEYWORD_PATTERN: CLOSING_KEYWORD_PATTERN,
        findClosingKeywords: findClosingKeywords,
        parseProtectedList: parseProtectedList,
        protectedBranches: protectedBranches,
        extractSubcommand: extractSubcommand,
        parsePushArgs: parsePushArgs,
        refspecDestination: refspecDestination,
        evaluatePush: evaluatePush,
        evaluateCommit: evaluateCommit,
        commitMessageText: commitMessageText,
        refusalMessage: refusalMessage
    };
}
