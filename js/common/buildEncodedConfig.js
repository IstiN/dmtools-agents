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
var validateInputJql = require('./validateInputJql.js');
var trackers = require('./trackers.js');

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
 * Resolve the directory portion of a file path.
 * "agents/story_solution_e2e.json" → "agents/"
 */
function dirOf(filePath) {
    var idx = filePath.lastIndexOf('/');
    return idx >= 0 ? filePath.substring(0, idx + 1) : '';
}

/**
 * Recursively resolve parent inheritance for an agent JSON config.
 *
 * Supports `parent.merge` for array fields (currently only params.cliPrompts).
 * Per the JSON config spec: merged array = parent items + child items.
 *
 * @param {Object} agentJson   - Parsed agent JSON (may contain a `parent` block).
 * @param {string} agentPath   - File path used to resolve relative `parent.path` values.
 * @param {number} [depth=0]   - Recursion guard (max 10 levels).
 * @returns {Object} Fully-resolved `params` object with parent inheritance applied.
 */
function resolveParentMerge(agentJson, agentPath, depth) {
    depth = depth || 0;
    var childParams = (agentJson && agentJson.params) ? agentJson.params : {};

    if (!agentJson || !agentJson.parent || !agentJson.parent.path || depth > 10) {
        return childParams;
    }

    var parentRelPath = agentJson.parent.path;
    var parentAbsPath = dirOf(agentPath) + parentRelPath;
    var parentJson = tryReadJson(parentAbsPath);
    if (!parentJson) {
        return childParams;
    }

    // Resolve grandparent chain first
    var parentParams = resolveParentMerge(parentJson, parentAbsPath, depth + 1);

    // Deep-merge: parent as base, child overrides
    var merged = configLoader.deepMerge(parentParams, childParams);

    // Apply merge directives — merge = parent items prepended before child items
    var mergeFields = (agentJson.parent.merge && Array.isArray(agentJson.parent.merge))
        ? agentJson.parent.merge : [];

    mergeFields.forEach(function(fieldPath) {
        // Accept both "params.cliPrompts" and bare "cliPrompts"
        var key = fieldPath;
        if (key.indexOf('params.') === 0) {
            key = key.substring('params.'.length);
        }
        var parentArr = Array.isArray(parentParams[key]) ? parentParams[key] : [];
        var childArr  = Array.isArray(childParams[key])  ? childParams[key]  : [];
        merged[key] = parentArr.concat(childArr);
    });

    return merged;
}

/**
 * Read contentOutput.target from a customParams object, if present.
 */
function readContentOutputTarget(customParams) {
    if (customParams && customParams.contentOutput &&
            typeof customParams.contentOutput.target === 'string') {
        return customParams.contentOutput.target;
    }
    return null;
}

/**
 * Resolve the 'confluence' tracker-prompt override for an agent.
 *
 * When the effective customParams (agent JSON customParams, overridable via the project
 * config's jobParamPatches.<agent>.customParams) route generated content exclusively to
 * Confluence (contentOutput.target === 'confluence'), tracker-specific CLI prompts must be
 * selected by the 'confluence' key so the CLI agent authors Markdown instead of tracker
 * markup (e.g. Jira wiki). Returns 'confluence' only when confluence tracker prompts are
 * actually declared (agent JSON or project config); otherwise null — callers then keep the
 * default tracker, matching the runtime fallback in CliCommandBuilder.
 */
function resolveConfluenceTrackerOverride(agentParamsRoot, effectiveConfig, agentName) {
    var target = readContentOutputTarget(agentParamsRoot && agentParamsRoot.customParams);
    var patchCustomParams = effectiveConfig && effectiveConfig.jobParamPatches &&
        effectiveConfig.jobParamPatches[agentName] &&
        effectiveConfig.jobParamPatches[agentName].customParams;
    var patchedTarget = readContentOutputTarget(patchCustomParams);
    if (patchedTarget) {
        target = patchedTarget;
    }
    if (target !== 'confluence') {
        return null;
    }
    var agentByTracker = agentParamsRoot && agentParamsRoot.cliPromptsByTracker;
    var configByTracker = effectiveConfig && effectiveConfig.cliPromptsByTracker;
    if ((agentByTracker && agentByTracker.confluence) ||
            (configByTracker && configByTracker.confluence)) {
        return 'confluence';
    }
    return null;
}

/**
 * Build the encoded config payload for a workflow dispatch.
 *
 * @param {string} ticketKey - Ticket key to process.
 * @param {Object|string} rule - Rule object or resolved config file path.
 * @param {Object} effectiveConfig - Project config from configLoader.
 * @param {boolean} [isLocal] - When true, marks the built config with
 *   `customParams.localTeammate = true` so the job it starts knows it is
 *   running locally (via smAgent's runTeammateLocally/forceLocalTeammate path)
 *   rather than as a GitHub Actions workflow_dispatch. Consumed by
 *   autoStart.js's triggerConfiguredWorkflowForTicket() to keep any further
 *   autoStartReview/autoStartRework chaining on the same machine instead of
 *   dispatching to GitHub Actions.
 * @returns {string} URL-encoded JSON string for workflow_dispatch `encoded_config`.
 */
/**
 * Derive the project key used to resolve a project-specific agent JSON
 * (e.g. "agents/pr_review.json" -> "ai_teammate/myproject/pr_review.json").
 * Explicit rule.projectKey wins; otherwise the basename of the loaded
 * project config path is used unless it is the generic "config".
 *
 * @param {Object|string} rule - Rule object or resolved config file path.
 * @param {Object} effectiveConfig - Loaded project config.
 * @returns {string} Project key ('' when none can be derived).
 */
function resolveProjectKey(rule, effectiveConfig) {
    var projectKey = (rule && rule.projectKey) || '';
    if (!projectKey && effectiveConfig && effectiveConfig._configPath) {
        var cp = effectiveConfig._configPath;
        var base = cp.substring(cp.lastIndexOf('/') + 1).replace(/\.js$/, '');
        if (base && base !== 'config') projectKey = base;
    }
    return projectKey;
}

/**
 * Resolve which agent JSON file to read: the project-specific variant
 * ("ai_teammate/<projectKey>/<filename>") when it exists, otherwise the
 * generic resolved config file.
 */
function resolveAgentJsonPath(resolvedCf, projectKey) {
    var agentJsonPath = resolvedCf;
    if (projectKey) {
        var filename = resolvedCf.replace(/^.*\//, '');
        var projectSpecific = 'ai_teammate/' + projectKey + '/' + filename;
        if (tryReadJson(projectSpecific)) {
            agentJsonPath = projectSpecific;
        }
    }
    return agentJsonPath;
}

/**
 * True when a string param carries a JQL placeholder that must be
 * interpolated against the project config.
 */
function needsJqlInterpolation(value) {
    return value.indexOf('{jiraProject}') !== -1 || value.indexOf('{parentTicket}') !== -1;
}

/**
 * Copy a single agent-JSON param value into the encoded params payload,
 * applying the JQL interpolation to strings carrying {jiraProject} /
 * {parentTicket} placeholders and deep-copying structured values.
 * cliPromptsByTracker is NOT copied: tracker prompts are already resolved
 * and flattened into cliPrompts (resolveInstructions); copying the map
 * would make the runtime merge them a second time.
 */
function copyParamValue(p, paramKey, value, effectiveConfig) {
    if (typeof value === 'string') {
        if (needsJqlInterpolation(value)) {
            p[paramKey] = configLoader.interpolateJql(value, effectiveConfig);
        } else {
            p[paramKey] = value;
        }
    } else if (typeof value === 'boolean' || typeof value === 'number') {
        p[paramKey] = value;
    } else if (Array.isArray(value)) {
        p[paramKey] = value.slice();
    } else if (typeof value === 'object' && value !== null) {
        p[paramKey] = JSON.parse(JSON.stringify(value));
    }
}

/**
 * Copy all scalar/array/object params from the resolved agent JSON into the
 * encoded params payload (skipping inputJql and cliPromptsByTracker).
 */
function copyAgentParams(p, agentParamsRoot, effectiveConfig) {
    var skipKeys = { inputJql: true, cliPromptsByTracker: true };
    Object.keys(agentParamsRoot).forEach(function(paramKey) {
        if (skipKeys[paramKey]) return;
        copyParamValue(p, paramKey, agentParamsRoot[paramKey], effectiveConfig);
    });
}

/**
 * Copy the nested agentParams / customParams objects from the agent JSON
 * into the encoded params payload (agentParams deep-merged from empty,
 * customParams shallow-copied).
 */
function copyNestedAgentObjects(p, agentParamsRoot) {
    var agentParams = agentParamsRoot.agentParams;
    if (agentParams && typeof agentParams === 'object') {
        p.agentParams = configLoader.deepMerge({}, agentParams);
    }
    var agentCustomParams = agentParamsRoot.customParams;
    if (agentCustomParams && typeof agentCustomParams === 'object') {
        p.customParams = Object.assign({}, agentCustomParams);
    }
}

/**
 * Apply the instruction-level resolutions from resolveInstructions():
 * a full instructions override lands in agentParams.instructions;
 * additionalInstructions are appended.
 */
function applyInstructionExtras(p, resolved) {
    if (resolved.instructionsOverridden) {
        if (!p.agentParams) p.agentParams = {};
        p.agentParams.instructions = resolved.instructions;
    }
    if (resolved.additionalInstructions && resolved.additionalInstructions.length > 0) {
        p.additionalInstructions = resolved.additionalInstructions;
    }
}

/**
 * Apply the resolved CLI prompts: 'replace' strategy swaps the JSON-inherited
 * cliPrompts entirely, the default 'merge' strategy appends after them.
 * A resolved cliPrompt override wins last.
 */
function applyCliPrompts(p, resolved) {
    if (resolved.cliPrompts && resolved.cliPrompts.length > 0) {
        if (resolved.cliPromptsStrategy === 'replace') {
            // replace: config.js prompts replace the JSON-inherited cliPrompts entirely
            p.cliPrompts = resolved.cliPrompts;
        } else {
            // merge (default): append config.js prompts after the JSON-inherited ones
            var existing = Array.isArray(p.cliPrompts) ? p.cliPrompts : [];
            p.cliPrompts = existing.concat(resolved.cliPrompts);
        }
    }
    if (resolved.cliPrompt) {
        p.cliPrompt = resolved.cliPrompt;
    }
}

/**
 * Apply the agentParamPatch / jobParamPatch from the project config. The
 * jobParamPatch deep-merges into the whole params payload, so it is applied
 * last and its result is returned (p may be replaced by the merge).
 */
function applyConfigPatches(p, resolved) {
    if (resolved.agentParamPatch) {
        if (!p.agentParams) p.agentParams = {};
        p.agentParams = configLoader.deepMerge(p.agentParams, resolved.agentParamPatch);
    }
    if (resolved.jobParamPatch) {
        p = configLoader.deepMerge(p, resolved.jobParamPatch);
    }
    return p;
}

/**
 * Resolve the Jira field-name override for story_acceptance_criteria agents
 * from config.jira.fields.acceptanceCriteria (null when not configured).
 */
function resolveFieldNameOverride(agentName, effectiveConfig) {
    var jiraFields = effectiveConfig.jira && effectiveConfig.jira.fields;
    if (!jiraFields) return null;
    var fieldMap = {
        'story_acceptance_criteria': jiraFields.acceptanceCriteria,
        'story_acceptance_criterias': jiraFields.acceptanceCriteria
    };
    return fieldMap[agentName] || null;
}

/**
 * Build the metadata block for the encoded payload: agentId and/or contextId
 * (upper-cased project key). Returns null when both are absent.
 */
function buildMetadata(agentId, contextId) {
    if (!agentId && !contextId) return null;
    var metadata = {};
    if (agentId) metadata.agentId = agentId;
    if (contextId) metadata.contextId = contextId;
    return metadata;
}

/**
 * Build the encoded config payload for a workflow dispatch.
 *
 * @param {string} ticketKey - Ticket key to process.
 * @param {Object|string} rule - Rule object or resolved config file path.
 * @param {Object} effectiveConfig - Project config from configLoader.
 * @param {boolean} [isLocal] - When true, marks the built config with
 *   `customParams.localTeammate = true` so the job it starts knows it is
 *   running locally (via smAgent's runTeammateLocally/forceLocalTeammate path)
 *   rather than as a GitHub Actions workflow_dispatch. Consumed by
 *   autoStart.js's triggerConfiguredWorkflowForTicket() to keep any further
 *   autoStartReview/autoStartRework chaining on the same machine instead of
 *   dispatching to GitHub Actions.
 * @returns {string} URL-encoded JSON string for workflow_dispatch `encoded_config`.
 */
function buildEncodedConfig(ticketKey, rule, effectiveConfig, isLocal) {
    // One owner of the key rules (validateInputJql): Jira PROJECT-123, GitHub gh-N / owner/repo#N /
    // #N / N and a bare numeric Azure DevOps work item id (#804). Injection-shaped keys still fail.
    if (!validateInputJql.isValidTicketKey(ticketKey)) {
        throw new Error('Invalid ticket key: "' + ticketKey +
            '". Expected a Jira key (PROJECT-123), a GitHub issue key or an Azure DevOps work item id');
    }
    var provider = trackers.createTracker(effectiveConfig, {}).provider();
    var p = { inputJql: validateInputJql.inputJqlForKey(ticketKey, provider) };
    var resolvedCf = resolveConfigFile(rule, effectiveConfig);
    var projectKey = resolveProjectKey(rule, effectiveConfig);
    var agentParamsRoot = {};

    if (resolvedCf) {
        var agentJsonPath = resolveAgentJsonPath(resolvedCf, projectKey);
        var agentJson = tryReadJson(agentJsonPath);
        if (agentJson && agentJson.params) {
            agentParamsRoot = resolveParentMerge(agentJson, agentJsonPath);
            copyAgentParams(p, agentParamsRoot, effectiveConfig);
            copyNestedAgentObjects(p, agentParamsRoot);
        }
    }

    if (effectiveConfig && resolvedCf) {
        var agentName = extractAgentName(resolvedCf);
        var trackerOverride = resolveConfluenceTrackerOverride(agentParamsRoot, effectiveConfig, agentName);
        var resolved = configLoader.resolveInstructions(agentName, null, effectiveConfig, agentParamsRoot.cliPromptsByTracker,
            trackerOverride ? { trackerOverride: trackerOverride } : undefined);

        applyInstructionExtras(p, resolved);
        applyCliPrompts(p, resolved);
        p = applyConfigPatches(p, resolved);

        var fieldName = resolveFieldNameOverride(agentName, effectiveConfig);
        if (fieldName) {
            p.fieldName = fieldName;
        }
    }

    if (effectiveConfig && effectiveConfig._configPath) {
        if (!p.customParams) p.customParams = {};
        p.customParams.configPath = effectiveConfig._configPath;
    }

    if (isLocal) {
        if (!p.customParams) p.customParams = {};
        p.customParams.localTeammate = true;
    }

    if (!p.agentParams) p.agentParams = {};

    var agentId = resolvedCf ? extractAgentName(resolvedCf) : null;
    var contextId = projectKey ? projectKey.toUpperCase() : null;
    var metadata = buildMetadata(agentId, contextId);
    if (metadata) {
        p.metadata = metadata;
    }

    return encodeURIComponent(JSON.stringify({ params: p }));
}


module.exports = {
    extractAgentName: extractAgentName,
    resolveConfigFile: resolveConfigFile,
    resolveParentMerge: resolveParentMerge,
    resolveConfluenceTrackerOverride: resolveConfluenceTrackerOverride,
    buildEncodedConfig: buildEncodedConfig,
    resolveProjectKey: resolveProjectKey,
    resolveAgentJsonPath: resolveAgentJsonPath,
    copyParamValue: copyParamValue,
    needsJqlInterpolation: needsJqlInterpolation,
    copyAgentParams: copyAgentParams,
    copyNestedAgentObjects: copyNestedAgentObjects,
    applyInstructionExtras: applyInstructionExtras,
    applyCliPrompts: applyCliPrompts,
    applyConfigPatches: applyConfigPatches,
    resolveFieldNameOverride: resolveFieldNameOverride,
    buildMetadata: buildMetadata
};
