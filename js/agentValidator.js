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
        resolvedPrompts: {
            base: [],
            jira: [],
            ado: []
        },
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
    // When running from agents/ directory, paths like ./agents/... or agents/... need translation
    if (path.indexOf('./agents/') === 0) {
        return path.substring('./agents/'.length);
    }
    if (path.indexOf('agents/') === 0) {
        return path.substring('agents/'.length);
    }
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

function resolveCliPrompts(baseCliPrompts, cliPromptsByTracker, trackerType) {
    var effectiveTracker = trackerType;
    if (!effectiveTracker || effectiveTracker.trim() === '') {
        effectiveTracker = 'jira';
    }

    var merged = [];
    if (baseCliPrompts && Array.isArray(baseCliPrompts)) {
        merged = merged.concat(baseCliPrompts);
    }

    if (cliPromptsByTracker && cliPromptsByTracker[effectiveTracker]) {
        var trackerPrompts = cliPromptsByTracker[effectiveTracker];
        if (trackerPrompts && Array.isArray(trackerPrompts) && trackerPrompts.length > 0) {
            merged = merged.concat(trackerPrompts);
        }
    }

    return merged;
}

// ── Core validation ──────────────────────────────────────────────────────────

function validateAgentJson(agentPath, options) {
    options = options || {};
    var result = createResult(agentPath);

    // 1. Load JSON
    var agentJson = readJson(agentPath);
    if (!agentJson) {
        addError(result, 'Cannot read or parse JSON: ' + agentPath);
        return result;
    }
    addInfo(result, 'Loaded JSON successfully');

    // 2. Basic structure
    if (!agentJson.name) {
        addError(result, 'Missing "name" field');
    }
    if (!agentJson.params) {
        addError(result, 'Missing "params" field');
        return result;
    }

    var params = agentJson.params;
    var isTeammate = agentJson.name === 'Teammate';

    // 3. Check cliPrompts (only for Teammate agents)
    if (!isTeammate) {
        addInfo(result, 'Non-Teammate agent (' + agentJson.name + ') — skipping Teammate-specific checks');
    }

    if (!params.cliPrompts || !Array.isArray(params.cliPrompts) || params.cliPrompts.length === 0) {
        if (isTeammate) {
            addError(result, 'Missing or empty "cliPrompts" array');
        }
    } else if (isTeammate) {
        result.resolvedPrompts.base = params.cliPrompts;

        // Validate each prompt reference
        params.cliPrompts.forEach(function(prompt, idx) {
            if (typeof prompt !== 'string') {
                addError(result, 'cliPrompts[' + idx + '] is not a string: ' + typeof prompt);
                return;
            }
            // If it's a file path, check it exists
            if (prompt.indexOf('./') === 0 || prompt.indexOf('agents/') === 0) {
                if (!fileExists(prompt)) {
                    addError(result, 'cliPrompts[' + idx + '] file not found: ' + prompt);
                }
            }
            // Warn about inline text that looks like instructions
            if (prompt.length > 200 && prompt.indexOf('./') !== 0 && prompt.indexOf('agents/') !== 0) {
                addWarning(result, 'cliPrompts[' + idx + '] contains long inline text (' + prompt.length + ' chars). Consider moving to a .md file.');
            }
        });
    }

    // 4. Check cliPromptsByTracker
    if (params.cliPromptsByTracker) {
        VALID_TRACKERS.forEach(function(tracker) {
            var trackerPrompts = params.cliPromptsByTracker[tracker];
            if (!trackerPrompts) return;

            if (!Array.isArray(trackerPrompts)) {
                addError(result, 'cliPromptsByTracker.' + tracker + ' is not an array');
                return;
            }

            trackerPrompts.forEach(function(prompt, idx) {
                if (typeof prompt !== 'string') {
                    addError(result, 'cliPromptsByTracker.' + tracker + '[' + idx + '] is not a string');
                    return;
                }
                if (prompt.indexOf('./') === 0 || prompt.indexOf('agents/') === 0) {
                    if (!fileExists(prompt)) {
                        addError(result, 'cliPromptsByTracker.' + tracker + '[' + idx + '] file not found: ' + prompt);
                    }
                }
            });

            // Resolve merged prompts for this tracker
            result.resolvedPrompts[tracker] = resolveCliPrompts(
                params.cliPrompts,
                params.cliPromptsByTracker,
                tracker
            );
        });
    } else {
        // No tracker-specific prompts — base prompts are used for all trackers
        result.resolvedPrompts.jira = params.cliPrompts || [];
        result.resolvedPrompts.ado = params.cliPrompts || [];
    }

    // 5. Check agentParams (legacy pattern)
    if (params.agentParams) {
        addWarning(result, 'Uses legacy "agentParams" — should be migrated to "cliPrompts" pattern');

        if (params.agentParams.instructions && Array.isArray(params.agentParams.instructions)) {
            var inlineCount = 0;
            params.agentParams.instructions.forEach(function(inst, idx) {
                if (typeof inst === 'string' && inst.length > 100 &&
                    inst.indexOf('./') !== 0 && inst.indexOf('agents/') !== 0) {
                    inlineCount++;
                }
            });
            if (inlineCount > 0) {
                addWarning(result, 'agentParams.instructions contains ' + inlineCount + ' long inline strings — should be extracted to .md files');
            }
        }
    }

    // 6. Check cliCommands
    if (params.cliCommands) {
        if (!Array.isArray(params.cliCommands)) {
            addError(result, '"cliCommands" must be an array');
        } else {
            params.cliCommands.forEach(function(cmd, idx) {
                if (typeof cmd !== 'string') {
                    addError(result, 'cliCommands[' + idx + '] is not a string');
                    return;
                }
                // Warn about inline text in cliCommands
                if (cmd.length > 200 && cmd.indexOf('./') !== 0 && cmd.indexOf('agents/') !== 0) {
                    addWarning(result, 'cliCommands[' + idx + '] contains long inline text — should be a script reference');
                }
                // Check script reference exists
                if (cmd.indexOf('./') === 0 || cmd.indexOf('agents/') === 0) {
                    // Extract just the script path (before any arguments)
                    var scriptPath = cmd.split(' ')[0];
                    if (!fileExists(scriptPath)) {
                        addWarning(result, 'cliCommands[' + idx + '] script may not exist: ' + scriptPath);
                    }
                }
            });
        }
    }

    // 7. Check preCliJSAction / postJSAction file existence
    ['preCliJSAction', 'postJSAction', 'preJSAction', 'postCliJSAction'].forEach(function(field) {
        if (params[field]) {
            if (typeof params[field] !== 'string') {
                addError(result, '"' + field + '" must be a string path');
            } else if (!fileExists(params[field])) {
                addWarning(result, '"' + field + '" file not found: ' + params[field]);
            }
        }
    });

    // 8. Check metadata
    if (params.metadata && params.metadata.contextId) {
        addInfo(result, 'contextId: ' + params.metadata.contextId);
    }

    // 9. Mock CLI execution (if requested)
    if (options.mockCli && params.cliCommands) {
        result.mockCliResult = mockCliExecution(params.cliCommands, result);
    }

    // 10. Mock preCli/postCli (if requested)
    if (options.mockActions) {
        if (params.preCliJSAction) {
            result.preCliResult = mockJsAction(params.preCliJSAction, agentJson, 'preCli');
        }
        if (params.postJSAction) {
            result.postCliResult = mockJsAction(params.postJSAction, agentJson, 'postCli');
        }
        if (params.preJSAction) {
            result.preCliResult = mockJsAction(params.preJSAction, agentJson, 'pre');
        }
    }

    return result;
}

// ── Mock CLI execution ───────────────────────────────────────────────────────

function mockCliExecution(cliCommands, result) {
    var mockResult = {
        commands: [],
        warnings: []
    };

    cliCommands.forEach(function(cmd, idx) {
        var entry = {
            index: idx,
            raw: cmd,
            scriptPath: null,
            args: [],
            isScriptReference: false
        };

        var parts = cmd.split(' ');
        entry.scriptPath = parts[0];
        entry.args = parts.slice(1);
        entry.isScriptReference = entry.scriptPath.indexOf('./') === 0 ||
                                   entry.scriptPath.indexOf('agents/') === 0;

        if (entry.isScriptReference) {
            var resolvedPath = resolveAgentPath(entry.scriptPath);
            if (!fileExists(resolvedPath)) {
                entry.warning = 'Script file not found: ' + entry.scriptPath;
                mockResult.warnings.push(entry.warning);
            }
        }

        mockResult.commands.push(entry);
    });

    return mockResult;
}

// ── Mock JS action execution ─────────────────────────────────────────────────

function mockJsAction(jsPath, agentJson, actionType) {
    var result = {
        path: jsPath,
        type: actionType,
        loaded: false,
        hasActionFunction: false,
        warnings: []
    };

    try {
        var resolvedPath = resolveAgentPath(jsPath);
        var code = file_read({ path: resolvedPath });
        if (!code) {
            result.warning = 'Cannot read JS file: ' + jsPath;
            return result;
        }
        result.loaded = true;

        // Check if file contains an action function
        if (code.indexOf('function action(') !== -1 ||
            code.indexOf('function action ') !== -1) {
            result.hasActionFunction = true;
        }

        // Try to load it as a module in a safe way
        try {
            var mockModule = { exports: {} };
            eval(
                '(function(module, exports) {\n' +
                code + '\n' +
                '})(mockModule, mockModule.exports)'
            );
            if (mockModule.exports && typeof mockModule.exports.action === 'function') {
                result.hasActionFunction = true;
            }
        } catch (loadErr) {
            result.warnings.push('Module load check failed (non-critical): ' + loadErr.message);
        }
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

    // Find all .json files in the directory
    try {
        // Use git ls-files to list tracked JSON files (avoids CLI whitelist issues)
        var lsOutput = cli_execute_command({
            command: 'git ls-files ' + agentJsonDir + '/*.json'
        });
        var files = (lsOutput || '').split('\n').filter(function(f) {
            return f && f.trim() && AGENT_JSON_PATTERN.test(f.trim().replace(/^.*\//, ''));
        });

        files.forEach(function(filePath) {
            var agentFile = filePath.trim().replace(/^.*\//, '');
            var fullPath = agentJsonDir + '/' + agentFile;
            var result = validateAgentJson(fullPath, options);
            results.push(result);
            if (!result.valid) allValid = false;
        });
    } catch (e) {
        console.error('Failed to list agent JSON files:', e);
    }

    return {
        allValid: allValid,
        total: results.length,
        passed: results.filter(function(r) { return r.valid; }).length,
        failed: results.filter(function(r) { return !r.valid; }).length,
        results: results
    };
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

function printResult(result) {
    console.log('\n═══════════════════════════════════════════');
    console.log('  Agent: ' + result.agentPath);
    console.log('  Status: ' + (result.valid ? '✅ VALID' : '❌ INVALID'));
    console.log('═══════════════════════════════════════════');

    if (result.info.length > 0) {
        console.log('\n  Info:');
        result.info.forEach(function(msg) { console.log('    ℹ️  ' + msg); });
    }

    if (result.errors.length > 0) {
        console.log('\n  Errors:');
        result.errors.forEach(function(msg) { console.log('    ❌ ' + msg); });
    }

    if (result.warnings.length > 0) {
        console.log('\n  Warnings:');
        result.warnings.forEach(function(msg) { console.log('    ⚠️  ' + msg); });
    }

    console.log('\n  Resolved prompts:');
    console.log('    Base: ' + result.resolvedPrompts.base.length);
    console.log('    Jira: ' + result.resolvedPrompts.jira.length);
    console.log('    ADO:  ' + result.resolvedPrompts.ado.length);

    if (result.mockCliResult) {
        console.log('\n  Mock CLI (' + result.mockCliResult.commands.length + ' commands):');
        result.mockCliResult.commands.forEach(function(cmd) {
            var status = cmd.warning ? '⚠️' : '✅';
            console.log('    ' + status + ' [' + cmd.index + '] ' + cmd.scriptPath);
            if (cmd.warning) console.log('       ' + cmd.warning);
        });
    }
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
        var extra = '';
        if (result.errors.length > 0) extra += ' (' + result.errors.length + ' errors';
        if (result.warnings.length > 0) extra += (extra ? ', ' : ' (') + result.warnings.length + ' warnings)';
        else if (extra) extra += ')';
        console.log('  ' + icon + ' ' + result.agentPath + extra);
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
