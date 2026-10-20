/**
 * Leg toolchain annotation (gh-1137).
 *
 * The dev/rework leg's summary — outputs/response.md — must carry one
 * machine-generated line stating which Dart SDK the leg verified with:
 *
 *     toolchain: dart <version> (CI: <pin>, match: yes|no)
 *
 * Live evidence (#433): a rework leg ran a different Dart SDK than the
 * target repo's CI (3.13.5), reported the SAME tree as "436 files to
 * reflow" while CI said "3 changed", and loop-escalated over a mechanical
 * format fix. A summary that claims "format-clean" is only checkable when
 * the toolchain that produced the claim is visible.
 *
 * The line itself is produced by `setup/dart.sh summary` (network-free,
 * unit-tested in js/unit-tests/test_dartSetup.js). This module:
 *   1. resolves dart.sh inside the leg workspace — the engine tree may be
 *      mounted at the repo root (self-hosted legs), `agents/` (submodule)
 *      or `factory-agents/` (legacy tree copy);
 *   2. runs it at POST time — the leg preamble (the runner config's
 *      setupCommands dart.sh entry) has already installed the SDK, so the
 *      banner describes the toolchain the leg actually verified with;
 *   3. appends the `toolchain:` line (plus its warning line on a no-pin
 *      repo) to the response text.
 *
 * Contract: this runs inside the dev/rework post actions — it must NEVER
 * break them. Every failure path (script missing, bash not whitelisted,
 * command error) returns the input unchanged. A non-Dart repo's skip line
 * (`toolchain: dart none … match: n/a`) is NOT appended — a JS/Kotlin leg
 * summary carries no toolchain noise.
 */

// Stable markers shared with setup/dart.sh (grep-verified by a wiring
// contract in test_toolchainSummary.js — the summary line prefix and the
// no-pin warning token must never drift apart across the two files).
var TOOLCHAIN_LINE_PREFIX = 'toolchain:';
var TOOLCHAIN_WARN_TOKEN = 'toolchain-warn:';

/**
 * Find setup/dart.sh relative to the leg's working directory.
 * Returns the path that exists (workingDir-prefixed — file_read resolves
 * against the engine process cwd), or null when the engine tree is absent.
 */
function resolveDartScriptPath(workingDir) {
    var prefix = workingDir ? (workingDir + '/') : '';
    var candidates = [
        prefix + 'setup/dart.sh',
        prefix + 'agents/setup/dart.sh',
        prefix + 'factory-agents/setup/dart.sh'
    ];
    for (var i = 0; i < candidates.length; i++) {
        var content = null;
        try {
            content = file_read({ path: candidates[i] });
        } catch (e) {
            content = null;
        }
        if (content && String(content).trim()) {
            return candidates[i];
        }
    }
    return null;
}

/**
 * Command text is workingDirectory-relative in this engine (every sibling
 * caller pairs a plain repo-relative command with workingDirectory), so the
 * probe path above must be run WITHOUT the workingDir prefix — a prefixed
 * command executed inside workingDirectory would double it and exit 127 on
 * any nested workingDir layout.
 */
function dartScriptRunPath(scriptPath, workingDir) {
    var prefix = workingDir ? (workingDir + '/') : '';
    if (prefix && scriptPath.indexOf(prefix) === 0) {
        return scriptPath.substring(prefix.length);
    }
    return scriptPath;
}

/**
 * Run `dart.sh summary` inside the leg workspace. Returns the command
 * output, or null on any failure (script missing, command error).
 */
function runDartSummary(workingDir) {
    var scriptPath = resolveDartScriptPath(workingDir);
    if (!scriptPath) {
        return null;
    }
    try {
        var args = { command: 'bash ' + dartScriptRunPath(scriptPath, workingDir) + ' summary' };
        if (workingDir) {
            args.workingDirectory = workingDir;
        }
        return cli_execute_command(args);
    } catch (e) {
        console.warn('toolchainSummary: dart.sh summary failed (non-fatal):',
            e && e.message ? e.message : String(e));
        return null;
    }
}

/** True when the line is dart.sh's no-pin warning (stable toolchain-warn: token). */
function isToolchainWarnLine(line) {
    return String(line).indexOf(TOOLCHAIN_WARN_TOKEN) !== -1;
}

/**
 * Pick the summary lines from dart.sh's output: the `toolchain:` line plus
 * an immediately-following toolchain-warn line when the repo has no pin.
 * Returns the array of lines, or null when no toolchain line is present.
 */
function pickToolchainLines(lines) {
    var picked = [];
    var lastPick = -1;
    for (var i = 0; i < lines.length; i++) {
        var line = String(lines[i]).replace(/\r$/, '');
        if (line.indexOf(TOOLCHAIN_LINE_PREFIX) === 0) {
            picked.push(line);
            lastPick = i;
        } else if (picked.length > 0 && i === lastPick + 1 && isToolchainWarnLine(line)) {
            // dart.sh emits the warn line immediately after the toolchain
            // line when the repo has no pin — it rides along.
            picked.push(line);
        }
        if (picked.length >= 2) {
            break;
        }
    }
    return picked.length > 0 ? picked : null;
}

/**
 * Run `dart.sh summary` in the leg workspace and pick the summary lines.
 * Returns the array of lines, or null on any failure.
 */
function fetchToolchainLines(workingDir) {
    var out = runDartSummary(workingDir);
    if (out === null) {
        return null;
    }
    return pickToolchainLines(String(out || '').split('\n'));
}

/** True when the response text is blank — nothing to annotate. */
function isBlankResponse(responseText) {
    return !responseText || !String(responseText).trim();
}

/** True when the summary line (or dart none skip line) must not be appended. */
function isSkippedToolchainLine(line) {
    // Non-Dart repo: dart.sh prints the n/a skip line — no toolchain noise
    // on JS/Kotlin legs.
    return String(line).indexOf('toolchain: dart none') === 0;
}

/** True when the response text already carries a toolchain line (agent-written or a previous pass). */
function hasToolchainLine(responseText) {
    var lines = String(responseText || '').split('\n');
    for (var i = 0; i < lines.length; i++) {
        if (lines[i].indexOf(TOOLCHAIN_LINE_PREFIX) === 0) {
            return true;
        }
    }
    return false;
}

/**
 * Append the toolchain line to the leg summary text.
 *
 * @param {string} responseText - the outputs/response.md content (may be null/blank)
 * @param {Object} opts         - { workingDir } — the leg's target-repo working dir
 * @returns {string} the annotated text, or the input unchanged on any
 *                   no-op path (blank input, script missing, command error,
 *                   line already present, non-Dart repo)
 */
function withToolchainLine(responseText, opts) {
    opts = opts || {};
    if (isBlankResponse(responseText) || hasToolchainLine(responseText)) {
        return responseText;
    }
    var lines = null;
    try {
        lines = fetchToolchainLines(opts.workingDir);
    } catch (e) {
        lines = null;
    }
    if (!lines || lines.length === 0 || isSkippedToolchainLine(lines[0])) {
        return responseText;
    }
    return String(responseText).replace(/\s+$/, '') + '\n' + lines.join('\n') + '\n';
}

module.exports = {
    resolveDartScriptPath: resolveDartScriptPath,
    fetchToolchainLines: fetchToolchainLines,
    hasToolchainLine: hasToolchainLine,
    withToolchainLine: withToolchainLine
};
