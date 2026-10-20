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
 *   2. runs it at POST time — the leg preamble (customParams.setupCommands
 *      → dart.sh) has already installed the SDK, so the banner describes
 *      the toolchain the leg actually verified with;
 *   3. appends the `toolchain:` line (plus its warning line on a no-pin
 *      repo) to the response text.
 *
 * Contract: this runs inside the dev/rework post actions — it must NEVER
 * break them. Every failure path (script missing, bash not whitelisted,
 * command error) returns the input unchanged. A non-Dart repo's skip line
 * (`toolchain: dart none … match: n/a`) is NOT appended — a JS/Kotlin leg
 * summary carries no toolchain noise.
 */

/**
 * Find setup/dart.sh relative to the leg's working directory.
 * Returns the path that exists, or null when the engine tree is not there.
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
 * Run `dart.sh summary` in the leg workspace and pick the summary lines:
 * the `toolchain:` line plus an immediately-following ⚠️ warning line when
 * the repo has no pin. Returns the array of lines, or null on any failure.
 */
function fetchToolchainLines(workingDir) {
    var scriptPath = resolveDartScriptPath(workingDir);
    if (!scriptPath) {
        return null;
    }
    var out = null;
    try {
        var args = { command: 'bash ' + scriptPath + ' summary' };
        if (workingDir) {
            args.workingDirectory = workingDir;
        }
        out = cli_execute_command(args);
    } catch (e) {
        console.warn('toolchainSummary: dart.sh summary failed (non-fatal):',
            e && e.message ? e.message : String(e));
        return null;
    }
    var lines = String(out || '').split('\n');
    var picked = [];
    var lastPick = -1;
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i].replace(/\r$/, '');
        if (line.indexOf('toolchain:') === 0) {
            picked.push(line);
            lastPick = i;
        } else if (picked.length > 0 && i === lastPick + 1 &&
                   line.indexOf('⚠️') === 0 && line.indexOf('differ from CI') !== -1) {
            // dart.sh emits the ⚠️ warning line immediately after the
            // toolchain line when the repo has no pin — it rides along.
            picked.push(line);
        }
        if (picked.length >= 2) {
            break;
        }
    }
    return picked.length > 0 ? picked : null;
}

/** True when the response text already carries a toolchain line (agent-written or a previous pass). */
function hasToolchainLine(responseText) {
    var lines = String(responseText || '').split('\n');
    for (var i = 0; i < lines.length; i++) {
        if (lines[i].indexOf('toolchain:') === 0) {
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
    var text = responseText;
    if (!text || !String(text).trim()) {
        return responseText;
    }
    if (hasToolchainLine(text)) {
        return responseText;
    }
    var lines = null;
    try {
        lines = fetchToolchainLines(opts.workingDir);
    } catch (e) {
        lines = null;
    }
    if (!lines || lines.length === 0) {
        return responseText;
    }
    // Non-Dart repo: dart.sh prints the n/a skip line — no toolchain noise
    // on JS/Kotlin legs.
    if (String(lines[0]).indexOf('toolchain: dart none') === 0) {
        return responseText;
    }
    return String(text).replace(/\s+$/, '') + '\n' + lines.join('\n') + '\n';
}

module.exports = {
    resolveDartScriptPath: resolveDartScriptPath,
    fetchToolchainLines: fetchToolchainLines,
    hasToolchainLine: hasToolchainLine,
    withToolchainLine: withToolchainLine
};
