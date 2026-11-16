/**
 * Agent JSON Config Validator
 *
 * Validates agent JSON configs without executing real CLI commands.
 * Can load configs, resolve prompts, check file references, and mock
 * preCli/postCli JS actions.
 *
 * Usage standalone:
 *   dmtools run js/unit-tests/run_validateAllAgents.json
 *
 * Usage in tests:
 *   var validator = loadModule('js/agentValidator.js', ...);
 *   var result = validator.validateAgentJson('story_ba_check.json');
 */

// ── Constants ────────────────────────────────────────────────────────────────

var VALID_TRACKERS = ['jira', 'ado'];
var AGENT_JSON_PATTERN = /^[a-zA-Z0-9_]+\.json$/;

// ── Validation Result Builder ────────────────────────────────────────────────

function createResult(agentPath) {
    return {
        agentPath: agentPath,
        valid: true,
        errors: [],
        warnings: [],
        info: [],
        resolvedPrompts: { base: [], jira: [], ado: [] },
        mockCliResult: null,
        preCliResult: null,
        postCliResult: null
    };
}

function addError(result, message) {
    result.valid = false;
    result.errors.push(message);
}

function addWarning(result, message) {
    result.warnings.push(message);
}

function addInfo(result, message) {
    result.info.push(message);
}

// ── File helpers ─────────────────────────────────────────────────────────────

function resolveAgentPath(path) {
    if (path.indexOf('./agents/') === 0) return path.substring('./agents/'.length);
    if (path.indexOf('agents/') === 0) return path.substring('agents/'.length);
    return path;
}

function fileExists(path) {
    try {
        var resolved = resolveAgentPath(path);
        var content = file_read({ path: resolved });
        return content !== null && content !== undefined;
    } catch (e) {
        return false;
    }
}

function readJson(path) {
    try {
        var resolved = resolveAgentPath(path);
        var raw = file_read({ path: resolved });
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (e) {
        return null;
    }
}

// ── Prompt resolution (mirrors Teammate.resolveCliPrompts + configLoader) ────

function _normalizeTrackerType(trackerType) {
    if (!trackerType || trackerType.trim() === '') return 'jira';
    return trackerType;
}

function _asNonEmptyArray(items) {
    return (Array.isArray(items) && items.length > 0) ? items : [];
}

function resolveCliPrompts(baseCliPrompts, cliPromptsByTracker, trackerType) {
    var effectiveTracker = _normalizeTrackerType(trackerType);
    var merged = _asNonEmptyArray(baseCliPrompts).slice();
    var trackerPrompts = cliPromptsByTracker ? cliPromptsByTracker[effectiveTracker] : null;
    return merged.concat(_asNonEmptyArray(trackerPrompts));
}

function _isAgentFilePath(str) {
    return str.indexOf('./') === 0 || str.indexOf('agents/') === 0;
}

// ── Core validation ──────────────────────────────────────────────────────────

function _hasCliStep(agentJson, params) {
    if (agentJson.name !== 'Teammate' || agentJson.parent) return false;
    return _asNonEmptyArray(params.cliCommands).length > 0;
}

function _extractPromptEntry(entry) {
    var isObjectPrompt = entry && typeof entry === 'object' && typeof entry.prompt === 'string';
    return {
        prompt: isObjectPrompt ? entry.prompt : entry,
        conditional: Boolean(isObjectPrompt && entry.condition)
    };
}

function _validateSingleCliPrompt(result, entry, idx) {
    var extracted = _extractPromptEntry(entry);
    var prompt = extracted.prompt;
    if (typeof prompt !== 'string') {
        addError(result, 'cliPrompts[' + idx + '] is not a string: ' + typeof prompt);
        return;
    }
    var isPath = _isAgentFilePath(prompt);
    if (!extracted.conditional && isPath && !fileExists(prompt)) {
        addError(result, 'cliPrompts[' + idx + '] file not found: ' + prompt);
    }
    if (prompt.length > 200 && !isPath) {
        addWarning(result, 'cliPrompts[' + idx + '] contains long inline text (' + prompt.length + ' chars). Consider moving to a .md file.');
    }
}

function _validateCliPrompts(result, agentJson, params) {
    var isTeammate = agentJson.name === 'Teammate';
    var hasCliStep = _hasCliStep(agentJson, params);

    if (!isTeammate) {
        addInfo(result, 'Non-Teammate agent (' + agentJson.name + ') — skipping Teammate-specific checks');
    } else if (!hasCliStep) {
        addInfo(result, 'JS-only Teammate agent (no cliCommands) — skipping cliPrompts requirement');
    }

    var cliPrompts = _asNonEmptyArray(params.cliPrompts);
    if (cliPrompts.length === 0) {
        if (hasCliStep) addError(result, 'Missing or empty "cliPrompts" array');
        return;
    }
    if (!isTeammate) return;

    result.resolvedPrompts.base = params.cliPrompts;
    params.cliPrompts.forEach(function(entry, idx) {
        _validateSingleCliPrompt(result, entry, idx);
    });
}

function _validateTrackerPromptEntry(result, tracker, entry, idx) {
    var extracted = _extractPromptEntry(entry);
    var prompt = extracted.prompt;
    if (typeof prompt !== 'string') {
        addError(result, 'cliPromptsByTracker.' + tracker + '[' + idx + '] is not a string');
        return;
    }
    if (!extracted.conditional && _isAgentFilePath(prompt) && !fileExists(prompt)) {
        addError(result, 'cliPromptsByTracker.' + tracker + '[' + idx + '] file not found: ' + prompt);
    }
}

function _validateSingleTrackerPrompts(result, params, tracker) {
    var trackerPrompts = params.cliPromptsByTracker[tracker];
    if (!trackerPrompts) return;

    if (!Array.isArray(trackerPrompts)) {
        addError(result, 'cliPromptsByTracker.' + tracker + ' is not an array');
        return;
    }

    trackerPrompts.forEach(function(prompt, idx) {
        _validateTrackerPromptEntry(result, tracker, prompt, idx);
    });

    result.resolvedPrompts[tracker] = resolveCliPrompts(params.cliPrompts, params.cliPromptsByTracker, tracker);
}

function _validateCliPromptsByTracker(result, params) {
    if (!params.cliPromptsByTracker) {
        var fallback = params.cliPrompts || [];
        result.resolvedPrompts.jira = fallback;
        result.resolvedPrompts.ado = fallback;
        return;
    }
    VALID_TRACKERS.forEach(function(tracker) {
        _validateSingleTrackerPrompts(result, params, tracker);
    });
}

function _isLongInlineInstruction(inst) {
    return typeof inst === 'string' && inst.length > 100 && !_isAgentFilePath(inst);
}

function _validateLegacyAgentParams(result, params) {
    if (!params.agentParams) return;
    addWarning(result, 'Uses legacy "agentParams" — should be migrated to "cliPrompts" pattern');

    var instructions = params.agentParams.instructions;
    if (!Array.isArray(instructions)) return;

    var inlineCount = instructions.filter(_isLongInlineInstruction).length;
    if (inlineCount > 0) {
        addWarning(result, 'agentParams.instructions contains ' + inlineCount + ' long inline strings — should be extracted to .md files');
    }
}

function _validateSingleCliCommand(result, cmd, idx) {
    if (typeof cmd !== 'string') {
        addError(result, 'cliCommands[' + idx + '] is not a string');
        return;
    }
    var isPath = _isAgentFilePath(cmd);
    if (cmd.length > 200 && !isPath) {
        addWarning(result, 'cliCommands[' + idx + '] contains long inline text — should be a script reference');
    }
    if (isPath) {
        var scriptPath = cmd.split(' ')[0];
        if (!fileExists(scriptPath)) {
            addWarning(result, 'cliCommands[' + idx + '] script may not exist: ' + scriptPath);
        }
    }
}

function _validateCliCommands(result, params) {
    if (!params.cliCommands) return;
    if (!Array.isArray(params.cliCommands)) {
        addError(result, '"cliCommands" must be an array');
        return;
    }
    params.cliCommands.forEach(function(cmd, idx) {
        _validateSingleCliCommand(result, cmd, idx);
    });
}

function _validateJsActionFields(result, params) {
    ['preCliJSAction', 'postJSAction', 'preJSAction', 'postCliJSAction'].forEach(function(field) {
        var val = params[field];
        if (!val) return;
        if (typeof val !== 'string') {
            addError(result, '"' + field + '" must be a string path');
        } else if (!fileExists(val)) {
            addWarning(result, '"' + field + '" file not found: ' + val);
        }
    });
}

function _mockActionIfPresent(jsPath, agentJson, actionType, fallback) {
    return jsPath ? mockJsAction(jsPath, agentJson, actionType) : fallback;
}

function _runMockSteps(result, agentJson, params, options) {
    if (options.mockCli && params.cliCommands) {
        result.mockCliResult = mockCliExecution(params.cliCommands, result);
    }
    if (!options.mockActions) return;
    result.preCliResult = _mockActionIfPresent(params.preCliJSAction, agentJson, 'preCli', result.preCliResult);
    result.postCliResult = _mockActionIfPresent(params.postJSAction, agentJson, 'postCli', result.postCliResult);
    result.preCliResult = _mockActionIfPresent(params.preJSAction, agentJson, 'pre', result.preCliResult);
}

function validateAgentJson(agentPath, options) {
    options = options || {};
    var result = createResult(agentPath);

    var agentJson = readJson(agentPath);
    if (!agentJson) {
        addError(result, 'Cannot read or parse JSON: ' + agentPath);
        return result;
    }
    addInfo(result, 'Loaded JSON successfully');

    if (!agentJson.name) {
        addError(result, 'Missing "name" field');
    }
    if (!agentJson.params) {
        addError(result, 'Missing "params" field');
        return result;
    }

    var params = agentJson.params;
    _validateCliPrompts(result, agentJson, params);
    _validateCliPromptsByTracker(result, params);
    _validateLegacyAgentParams(result, params);
    _validateCliCommands(result, params);
    _validateJsActionFields(result, params);

    if (params.metadata && params.metadata.contextId) {
        addInfo(result, 'contextId: ' + params.metadata.contextId);
    }

    _runMockSteps(result, agentJson, params, options);
    return result;
}

// ── Mock CLI execution ───────────────────────────────────────────────────────

function mockCliExecution(cliCommands, result) {
    var mockResult = { commands: [], warnings: [] };

    cliCommands.forEach(function(cmd, idx) {
        var parts = cmd.split(' ');
        var entry = {
            index: idx,
            raw: cmd,
            scriptPath: parts[0],
            args: parts.slice(1),
            isScriptReference: _isAgentFilePath(parts[0])
        };

        if (entry.isScriptReference && !fileExists(entry.scriptPath)) {
            entry.warning = 'Script file not found: ' + entry.scriptPath;
            mockResult.warnings.push(entry.warning);
        }
        mockResult.commands.push(entry);
    });

    return mockResult;
}

// ── Mock JS action execution ─────────────────────────────────────────────────

function _hasActionDeclaration(code) {
    return code.indexOf('function action(') !== -1 || code.indexOf('function action ') !== -1;
}

function _probeActionExport(code, result) {
    try {
        var mockModule = { exports: {} };
        eval('(function(module, exports) {\n' + code + '\n})(mockModule, mockModule.exports)');
        if (mockModule.exports && typeof mockModule.exports.action === 'function') {
            result.hasActionFunction = true;
        }
    } catch (loadErr) {
        result.warnings.push('Module load check failed (non-critical): ' + loadErr.message);
    }
}

function mockJsAction(jsPath, agentJson, actionType) {
    var result = {
        path: jsPath,
        type: actionType,
        loaded: false,
        hasActionFunction: false,
        warnings: []
    };

    try {
        var code = file_read({ path: resolveAgentPath(jsPath) });
        if (!code) {
            result.warning = 'Cannot read JS file: ' + jsPath;
            return result;
        }
        result.loaded = true;
        result.hasActionFunction = _hasActionDeclaration(code);
        _probeActionExport(code, result);
    } catch (e) {
        result.warning = 'Error reading JS: ' + e.message;
    }

    return result;
}

// ── Batch validation ─────────────────────────────────────────────────────────

function validateAllAgents(agentJsonDir, options) {
    agentJsonDir = agentJsonDir || '.';
    options = options || {};

    var results = [];
    var allValid = true;

    try {
        var lsOutput = cli_execute_command({ command: 'git ls-files ' + agentJsonDir + '/*.json' });
        var files = (lsOutput || '').split('\n').filter(function(f) {
            return f && f.trim() && AGENT_JSON_PATTERN.test(f.trim().replace(/^.*\//, ''));
        });

        files.forEach(function(filePath) {
            var agentFile = filePath.trim().replace(/^.*\//, '');
            var result = validateAgentJson(agentJsonDir + '/' + agentFile, options);
            results.push(result);
            if (!result.valid) allValid = false;
        });
    } catch (e) {
        console.error('Failed to list agent JSON files:', e);
    }

    var passed = results.filter(function(r) { return r.valid; }).length;
    return { allValid: allValid, total: results.length, passed: passed, failed: results.length - passed, results: results };
}

// ── Main action (for dmtools run) ────────────────────────────────────────────

function action(params) {
    var p = params.jobParams || params;
    var mode = p.mode || 'validateAgent';
    var agentPath = p.agentPath;
    var agentJsonDir = p.agentJsonDir || '.';
    var options = {
        mockCli: p.mockCli !== false,
        mockActions: p.mockActions !== false
    };

    if (mode === 'validateAgent') {
        if (!agentPath) {
            console.error('Usage: set jobParams.agentPath to the agent JSON file');
            return { success: false, error: 'Missing agentPath' };
        }
        var result = validateAgentJson(agentPath, options);
        printResult(result);
        return { success: result.valid, result: result };
    }

    if (mode === 'validateAll') {
        var batchResult = validateAllAgents(agentJsonDir, options);
        printBatchResult(batchResult);
        return { success: batchResult.allValid, result: batchResult };
    }

    console.error('Unknown mode: ' + mode + '. Use "validateAgent" or "validateAll"');
    return { success: false, error: 'Unknown mode' };
}

// ── Output formatting ────────────────────────────────────────────────────────

function _logSection(title, prefix, items) {
    if (!items || items.length === 0) return;
    console.log('\n  ' + title + ':');
    items.forEach(function(msg) { console.log('    ' + prefix + msg); });
}

function _logMockCliResult(mockCliResult) {
    if (!mockCliResult) return;
    console.log('\n  Mock CLI (' + mockCliResult.commands.length + ' commands):');
    mockCliResult.commands.forEach(function(cmd) {
        var status = cmd.warning ? '⚠️' : '✅';
        console.log('    ' + status + ' [' + cmd.index + '] ' + cmd.scriptPath);
        if (cmd.warning) console.log('       ' + cmd.warning);
    });
}

function printResult(result) {
    console.log('\n═══════════════════════════════════════════');
    console.log('  Agent: ' + result.agentPath);
    console.log('  Status: ' + (result.valid ? '✅ VALID' : '❌ INVALID'));
    console.log('═══════════════════════════════════════════');

    _logSection('Info', 'ℹ️  ', result.info);
    _logSection('Errors', '❌ ', result.errors);
    _logSection('Warnings', '⚠️  ', result.warnings);

    console.log('\n  Resolved prompts:');
    console.log('    Base: ' + result.resolvedPrompts.base.length);
    console.log('    Jira: ' + result.resolvedPrompts.jira.length);
    console.log('    ADO:  ' + result.resolvedPrompts.ado.length);

    _logMockCliResult(result.mockCliResult);
}

function _formatBatchItemSummary(result) {
    var parts = [];
    if (result.errors.length > 0) parts.push(result.errors.length + ' errors');
    if (result.warnings.length > 0) parts.push(result.warnings.length + ' warnings');
    return parts.length > 0 ? ' (' + parts.join(', ') + ')' : '';
}

function printBatchResult(batchResult) {
    console.log('\n═══════════════════════════════════════════');
    console.log('  Agent Validation Batch Results');
    console.log('═══════════════════════════════════════════');
    console.log('  Total:  ' + batchResult.total);
    console.log('  Passed: ' + batchResult.passed);
    console.log('  Failed: ' + batchResult.failed);
    console.log('  Status: ' + (batchResult.allValid ? '✅ ALL VALID' : '❌ SOME FAILED'));

    batchResult.results.forEach(function(result) {
        var icon = result.valid ? '✅' : '❌';
        console.log('  ' + icon + ' ' + result.agentPath + _formatBatchItemSummary(result));
    });
}

// ── Exports ──────────────────────────────────────────────────────────────────

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        validateAgentJson: validateAgentJson,
        validateAllAgents: validateAllAgents,
        resolveCliPrompts: resolveCliPrompts,
        mockCliExecution: mockCliExecution,
        mockJsAction: mockJsAction,
        action: action
    };
}
