/**
 * CI Analyst — preCliJSAction: stage the CI failure context into the input folder.
 *
 * Runs BEFORE the CLI agent (prompts/ci_analyst.md). The runner config (or the
 * kicker workflow) passes the analysis input via customParams:
 *
 *   customParams: {
 *     contextPath:      path to the CI context file (JSON; absolute or CWD-relative)
 *     dryRun:           true  -> analysis only, never create a GitHub issue
 *     machineAuthor:    login the follow-up dev leg is assigned to
 *     targetRepository: "owner/repo" the runs belong to (also inside the context file)
 *   }
 *
 * The context file is copied to a FIXED path (input/ci_analyst_context.md) so
 * the prompt can reference it by name: the engine's InstructionProcessor
 * embeds existing relative file paths into the prompt text, and the CLI agent
 * can always re-read the same path. The resolved launch flags land in
 * input/ci_analyst_params.json so prompt and post action read one truth.
 *
 * Missing/empty contextPath or an unreadable context file is a business
 * failure: preCliJSAction returns { success:false } and the engine skips the
 * CLI run — analyzing nothing would silently produce a bogus verdict.
 *
 * GraalJS-compatible: var declarations, plain functions, no arrow functions,
 * no template literals, no Node APIs. Globals: file_read, file_write.
 */

var CI_CONTEXT_TARGET = 'input/ci_analyst_context.md';
var CI_PARAMS_TARGET = 'input/ci_analyst_params.json';

/** customParams live on jobParams in JSRunner runs and as a top-level global
 *  in CliAgent runs — resolve both (postBugCreation.js pattern). */
function resolveCustomParams(params) {
    if (params && params.jobParams && params.jobParams.customParams) return params.jobParams.customParams;
    if (params && params.customParams) return params.customParams;
    if (typeof customParams !== 'undefined' && customParams) return customParams;
    return {};
}

/** dryRun arrives as a boolean or a string flag — normalize to a real boolean. */
function normalizeDryRun(value) {
    if (value === true) return true;
    if (value === false || value === null || value === undefined || value === '') return false;
    return String(value).toLowerCase() === 'true';
}

/** Read the context file: try the path as given, then relative to the repo root. */
function readContextFile(contextPath, workingDirectory) {
    var content = file_read({ path: contextPath });
    if (content !== null && content !== undefined && String(content).length > 0) return String(content);
    if (workingDirectory && contextPath && contextPath.indexOf('/') !== 0) {
        var joined = workingDirectory + '/' + contextPath;
        content = file_read({ path: joined });
        if (content !== null && content !== undefined && String(content).length > 0) return String(content);
    }
    return null;
}

function action(params) {
    // The engine injects the repo root as the top-level `workingDirectory`
    // global (CliAgent extra globals); a test harness may pass params.workingDirectory.
    var workDir = (typeof workingDirectory !== 'undefined' && workingDirectory) ? String(workingDirectory) : null;
    if (params && params.workingDirectory) workDir = String(params.workingDirectory);
    var custom = resolveCustomParams(params);

    var contextPath = custom.contextPath;
    if (!contextPath || String(contextPath).trim() === '') {
        console.error('ci_analyst: customParams.contextPath is required — the analyst has no CI context to read');
        return { success: false, error: 'ci_analyst: customParams.contextPath is required' };
    }
    contextPath = String(contextPath).trim();

    var content = readContextFile(contextPath, workDir);
    if (content === null) {
        console.error('ci_analyst: context file not readable at "' + contextPath + '"');
        return { success: false, error: 'ci_analyst: context file not readable at ' + contextPath };
    }

    var launchParams = {
        contextPath: contextPath,
        dryRun: normalizeDryRun(custom.dryRun),
        machineAuthor: custom.machineAuthor ? String(custom.machineAuthor) : '',
        targetRepository: custom.targetRepository ? String(custom.targetRepository) : ''
    };

    file_write({ path: CI_CONTEXT_TARGET, content: content });
    file_write({ path: CI_PARAMS_TARGET, content: JSON.stringify(launchParams, null, 2) + '\n' });
    console.log('ci_analyst: context staged ' + contextPath + ' -> ' + CI_CONTEXT_TARGET +
        ' (dryRun=' + launchParams.dryRun + ')');
    return true;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        resolveCustomParams: resolveCustomParams,
        normalizeDryRun: normalizeDryRun,
        readContextFile: readContextFile,
        CI_CONTEXT_TARGET: CI_CONTEXT_TARGET,
        CI_PARAMS_TARGET: CI_PARAMS_TARGET
    };
}
