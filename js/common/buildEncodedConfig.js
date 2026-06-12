/**
 * Shared encoded config builder for SM Agent and autoStart triggers.
 *
 * Reads the target agent JSON, copies its params, merges project-specific
 * instructions from .dmtools/config.js, and produces the URL-encoded
 * `encoded_config` payload that `ai-teammate.yml` consumes.
 *
 * Keeping this logic in one place guarantees that a workflow triggered by
 * SM, by autoStart, or manually with the same builder always receives the
 * same resolved params (cliPrompts, customParams, feedbackLoop, etc.).
 */

var configLoader = require('../configLoader.js');

function extractAgentName(configFile) {
    if (!configFile) return '';
    var name = configFile;
    var slashIdx = name.lastIndexOf('/');
    if (slashIdx !== -1) name = name.substring(slashIdx + 1);
    if (name.indexOf('.json') !== -1) name = name.replace('.json', '');
    return name;
}

/**
 * Resolve the full path to an agent config JSON.
 *
 * @param {Object|string} rule - Either a rule object with a `configFile`
 *   property or a bare config file name/path.
 * @param {Object} effectiveConfig - Loaded project config; its
 *   `agentConfigsDir` is used when only a bare filename is provided.
 * @returns {string|null} Resolved config file path.
 */
function resolveConfigFile(rule, effectiveConfig) {
    var cf = (rule && rule.configFile) || rule;
    if (!cf || typeof cf !== 'string') return null;
    if (cf.indexOf('/') !== -1) return cf;
    var dir = effectiveConfig && effectiveConfig.agentConfigsDir;
    if (dir) {
        return dir.replace(/\/$/, '') + '/' + cf;
    }
    return cf;
}

function tryReadJson(path) {
    try {
        var raw = file_read({ path: path });
        if (raw && raw.trim()) {
            return JSON.parse(raw);
        }
    } catch (e) {
        // ignore
    }
    return null;
}

/**
 * Build the encoded config payload for a workflow dispatch.
 *
 * @param {string} ticketKey - Ticket key to process.
 * @param {Object|string} rule - Rule object or resolved config file path.
 * @param {Object} effectiveConfig - Project config from configLoader.
 * @returns {string} URL-encoded JSON string for workflow_dispatch `encoded_config`.
 */
function buildEncodedConfig(ticketKey, rule, effectiveConfig) {
    var p = { inputJql: 'key = ' + ticketKey };
    var resolvedCf = resolveConfigFile(rule, effectiveConfig);

    // Derive project key to resolve project-specific agent JSON
    // (e.g. "agents/pr_review.json" -> "ai_teammate/myproject/pr_review.json").
    var projectKey = (rule && rule.projectKey) || '';
    if (!projectKey && effectiveConfig && effectiveConfig._configPath) {
        var cp = effectiveConfig._configPath;
        var base = cp.substring(cp.lastIndexOf('/') + 1).replace(/\.js$/, '');
        if (base && base !== 'config') projectKey = base;
    }

    var agentParamsRoot = {};
    if (resolvedCf) {
        var agentJsonPath = resolvedCf;
        if (projectKey) {
            var filename = resolvedCf.replace(/^.*\//, '');
            var projectSpecific = 'ai_teammate/' + projectKey + '/' + filename;
            if (tryReadJson(projectSpecific)) {
                agentJsonPath = projectSpecific;
            }
        }

        var agentJson = tryReadJson(agentJsonPath);
        if (agentJson && agentJson.params) {
            agentParamsRoot = agentJson.params;
            var skipKeys = { inputJql: true };
            Object.keys(agentParamsRoot).forEach(function(paramKey) {
                if (skipKeys[paramKey]) return;
                var value = agentParamsRoot[paramKey];
                if (typeof value === 'string') {
                    if (value.indexOf('{jiraProject}') !== -1 || value.indexOf('{parentTicket}') !== -1) {
                        p[paramKey] = configLoader.interpolateJql(value, effectiveConfig);
                    } else {
                        p[paramKey] = value;
                    }
                } else if (typeof value === 'boolean' || typeof value === 'number') {
                    p[paramKey] = value;
                } else if (Array.isArray(value)) {
                    if (paramKey === 'cliPromptsByTracker') {
                        // Tracker prompts are merged into cliPrompts below.
                        return;
                    }
                    p[paramKey] = value.slice();
                } else if (typeof value === 'object' && value !== null) {
                    p[paramKey] = JSON.parse(JSON.stringify(value));
                }
            });

            var agentParams = agentParamsRoot.agentParams;
            if (agentParams && typeof agentParams === 'object') {
                p.agentParams = configLoader.deepMerge({}, agentParams);
            }
            var agentCustomParams = agentParamsRoot.customParams;
            if (agentCustomParams && typeof agentCustomParams === 'object') {
                p.customParams = Object.assign({}, agentCustomParams);
            }
        }
    }

    if (effectiveConfig && resolvedCf) {
        var agentName = extractAgentName(resolvedCf);
        var resolved = configLoader.resolveInstructions(agentName, null, effectiveConfig, agentParamsRoot.cliPromptsByTracker);

        if (resolved.instructionsOverridden) {
            if (!p.agentParams) p.agentParams = {};
            p.agentParams.instructions = resolved.instructions;
        }
        if (resolved.additionalInstructions && resolved.additionalInstructions.length > 0) {
            p.additionalInstructions = resolved.additionalInstructions;
        }
        if (resolved.cliPrompts && resolved.cliPrompts.length > 0) {
            var existing = Array.isArray(p.cliPrompts) ? p.cliPrompts : [];
            p.cliPrompts = existing.concat(resolved.cliPrompts);
        }
        if (resolved.cliPrompt) {
            p.cliPrompt = resolved.cliPrompt;
        }
        if (resolved.agentParamPatch) {
            if (!p.agentParams) p.agentParams = {};
            p.agentParams = configLoader.deepMerge(p.agentParams, resolved.agentParamPatch);
        }
        if (resolved.jobParamPatch) {
            p = configLoader.deepMerge(p, resolved.jobParamPatch);
        }

        var jiraFields = effectiveConfig.jira && effectiveConfig.jira.fields;
        if (jiraFields) {
            var fieldMap = {
                'story_acceptance_criteria': jiraFields.acceptanceCriteria,
                'story_acceptance_criterias': jiraFields.acceptanceCriteria
            };
            var override = fieldMap[agentName];
            if (override) {
                p.fieldName = override;
            }
        }
    }

    if (effectiveConfig && effectiveConfig._configPath) {
        if (!p.customParams) p.customParams = {};
        p.customParams.configPath = effectiveConfig._configPath;
    }

    if (!p.agentParams) p.agentParams = {};

    return encodeURIComponent(JSON.stringify({ params: p }));
}

module.exports = {
    extractAgentName: extractAgentName,
    resolveConfigFile: resolveConfigFile,
    buildEncodedConfig: buildEncodedConfig
};
