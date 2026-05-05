/**
 * Configuration Loader for DMTools Agents
 *
 * Discovers and loads project-specific configuration from .dmtools/config.js,
 * merging with built-in defaults to support multi-repo agent deployments.
 *
 * Discovery order:
 *   1. customParams.configPath (explicit path)
 *   2. ../.dmtools/config.js   (relative to agents dir — submodule layout)
 *   3. Built-in defaults       (backward compatible)
 *
 * Merge strategy:
 *   - jira.statuses, jira.issueTypes, jira.questions, labels: FULL REPLACEMENT when provided
 *   - smRules, smMergeRules: FULL REPLACEMENT when provided
 *   - repository, git, formats, confluence, jira.fields: DEEP MERGE
 *   - additionalInstructions, instructionOverrides, cliPrompts, cliPromptOverrides, agentParamPatches, jobParamPatches:
 *     FULL REPLACEMENT when provided
 */

var DEFAULT_CONFIG = require('./config.js');

// Lazy-loaded to keep backward compat with test environments that don't provide scm.js
var _scmModule = null;
try { _scmModule = require('./common/scm.js'); } catch (e) { /* optional dep */ }

// ── Default project configuration ────────────────────────────────────────────

var DEFAULTS = {
    repository: {
        owner: '',
        repo: ''
    },

    jira: {
        project: '',
        parentTicket: '',
        statuses: DEFAULT_CONFIG.STATUSES,
        issueTypes: DEFAULT_CONFIG.ISSUE_TYPES,
        questions: {
            // JQL to fetch question subtasks. {ticketKey} is replaced at runtime.
            fetchJql: 'parent = {ticketKey} AND issuetype = Subtask ORDER BY created ASC',
            // Custom Jira field name that holds the answer to a question subtask.
            answerField: 'Answer'
        },
        parentContextFetch: {
            enabled: false
        },
        // Jira field names — override per project in .dmtools/config.js under jira.fields
        fields: {
            acceptanceCriteria: 'Acceptance Criteria'
        }
    },

    git: {
        baseBranch: DEFAULT_CONFIG.GIT_CONFIG.DEFAULT_BASE_BRANCH,
        authorName: DEFAULT_CONFIG.GIT_CONFIG.AUTHOR_NAME,
        authorEmail: DEFAULT_CONFIG.GIT_CONFIG.AUTHOR_EMAIL,
        branchPrefix: {
            development: 'ai',
            feature: DEFAULT_CONFIG.GIT_CONFIG.DEFAULT_ISSUE_TYPE_PREFIX,
            test: 'test'
        },
        branchNamingFn: null,   // function(ticket, branchRole) → string; overrides prefix-based naming
        featureBranch: {
            enabled: false       // two-branch flow: dev branch → feature branch PR (not → baseBranch)
        }
    },

    formats: {
        commitMessage: {
            development: '{ticketKey} {ticketSummary}',
            testAutomation: '{ticketKey} test: automate {ticketSummary}',
            testRework: '{ticketKey} test rework: {result} test after review',
            rework: '{ticketKey} Rework: address PR review comments',
            wip: '{ticketKey} WIP: partial analysis (agent interrupted)'
        },
        prTitle: {
            development: '{ticketKey} {ticketSummary}',
            testAutomation: '{ticketKey} {ticketSummary}',
            rework: '{ticketKey} {ticketSummary} (rework)'
        }
    },

    labels: DEFAULT_CONFIG.LABELS,

    confluence: {
        templateStory: 'https://dmtools.atlassian.net/wiki/spaces/AINA/pages/11665485/Template+Story',
        templateJiraMarkdown: 'https://dmtools.atlassian.net/wiki/spaces/AINA/pages/18186241/Template+Jira+Markdown',
        templateSolutionDesign: 'https://dmtools.atlassian.net/wiki/spaces/AINA/pages/56754177/Template+Solution+Design',
        templateQuestions: 'https://dmtools.atlassian.net/wiki/spaces/AINA/pages/11665581/Template+Q'
    },

    smRules: null,
    smMergeRules: null,

    // Base directory for agent JSON configs (e.g. "projects/alpha").
    // When set, smRules.configFile values without a "/" are resolved relative to this dir.
    // Allows config.js to own the full picture: repo, jira, rules, and agent paths.
    agentConfigsDir: null,

    additionalInstructions: {},
    instructionOverrides: {},
    cliPrompts: {},
    cliPromptOverrides: {},
    agentParamPatches: {},
    jobParamPatches: {},

    scm: {
        provider: 'github'   // 'github' | 'ado' — source control provider for PR operations
    }
};

// Default Confluence URL → config key mapping (for resolving URLs in agent configs)
var CONFLUENCE_URL_MAP = {};
(function() {
    var conf = DEFAULTS.confluence;
    for (var key in conf) {
        if (conf.hasOwnProperty(key)) {
            CONFLUENCE_URL_MAP[conf[key]] = key;
        }
    }
})();

// ── Merge utilities ──────────────────────────────────────────────────────────

/**
 * Simple deep merge of two plain objects. Source values override target.
 * Arrays and non-object values are replaced entirely.
 */
function deepMerge(target, source) {
    if (!source) return target;
    if (!target) return source;
    var result = {};
    var key;
    for (key in target) {
        if (target.hasOwnProperty(key)) {
            result[key] = target[key];
        }
    }
    for (key in source) {
        if (source.hasOwnProperty(key)) {
            var sv = source[key];
            var tv = result[key];
            if (sv && typeof sv === 'object' && !Array.isArray(sv) &&
                tv && typeof tv === 'object' && !Array.isArray(tv)) {
                result[key] = deepMerge(tv, sv);
            } else {
                result[key] = sv;
            }
        }
    }
    return result;
}

/**
 * Merge project config with defaults using section-level strategy:
 * - statuses, issueTypes, labels, smRules, smMergeRules: full replacement
 * - everything else: deep merge
 */
function mergeProjectConfig(defaults, overrides) {
    if (!overrides) return defaults;

    var result = deepMerge(defaults, overrides);

    // Full replacement sections: if override provides these, use them entirely
    if (overrides.jira) {
        if (overrides.jira.statuses) {
            result.jira.statuses = overrides.jira.statuses;
        }
        if (overrides.jira.issueTypes) {
            result.jira.issueTypes = overrides.jira.issueTypes;
        }
        if (overrides.jira.questions) {
            result.jira.questions = overrides.jira.questions;
        }
    }
    if (overrides.labels) {
        result.labels = overrides.labels;
    }
    if (overrides.smRules !== undefined) {
        result.smRules = overrides.smRules;
    }
    if (overrides.smMergeRules !== undefined) {
        result.smMergeRules = overrides.smMergeRules;
    }
    if (overrides.additionalInstructions) {
        result.additionalInstructions = overrides.additionalInstructions;
    }
    if (overrides.instructionOverrides) {
        result.instructionOverrides = overrides.instructionOverrides;
    }
    if (overrides.cliPrompts) {
        result.cliPrompts = overrides.cliPrompts;
    }
    if (overrides.cliPromptOverrides) {
        result.cliPromptOverrides = overrides.cliPromptOverrides;
    }
    if (overrides.agentParamPatches) {
        result.agentParamPatches = overrides.agentParamPatches;
    }
    if (overrides.jobParamPatches) {
        result.jobParamPatches = overrides.jobParamPatches;
    }

    return result;
}

// ── Config discovery and loading ─────────────────────────────────────────────

/**
 * Try to read a file and return its content, or null if not found.
 */
function tryReadFile(path) {
    try {
        var content = file_read({ path: path });
        if (content && content.trim()) {
            return content;
        }
    } catch (e) {
        // File not found or not readable
    }
    return null;
}

/**
 * Load and evaluate a CommonJS config file.
 * Returns the module.exports object, or null on failure.
 */
function loadConfigFile(path) {
    var content = tryReadFile(path);
    if (!content) return null;

    try {
        var moduleObj = { exports: {} };
        var fn = new Function('module', 'exports', 'require', content);
        fn(moduleObj, moduleObj.exports, function() { return {}; });
        return moduleObj.exports;
    } catch (e) {
        console.warn('configLoader: Failed to evaluate ' + path + ': ' + (e.message || e));
        return null;
    }
}

/**
 * Load project configuration with discovery and merging.
 *
 * Discovery order:
 *   1. params.configPath          — top-level param (e.g. jobParams.configPath in sm.json)
 *   2. params.customParams.configPath — explicit path from agent customParams
 *   3. params.agentConfigsDir + "/.dmtools/config.js" — when agentConfigsDir is passed
 *   4. ../.dmtools/config.js       — submodule layout (agents/ is a submodule)
 *   5. .dmtools/config.js          — co-located layout (agents/ in same repo)
 *   6. Defaults                    — built-in defaults from config.js
 *
 * @param {Object} params - Agent params (jobParams or top-level params)
 * @returns {Object} Merged configuration
 */
function loadProjectConfig(params) {
    var customParams = (params && params.customParams) || {};
    var loaded = null;
    var resolvedPath = null;

    // 1. Top-level configPath (e.g. jobParams.configPath or smAgent's p.configPath)
    if (params && params.configPath) {
        loaded = loadConfigFile(params.configPath);
        if (loaded) {
            resolvedPath = params.configPath;
            console.log('configLoader: Loaded config from ' + params.configPath);
        }
    }

    // 2. Explicit configPath in customParams (e.g. agent JSON customParams.configPath)
    if (!loaded && customParams.configPath) {
        loaded = loadConfigFile(customParams.configPath);
        if (loaded) {
            resolvedPath = customParams.configPath;
            console.log('configLoader: Loaded config from ' + customParams.configPath);
        }
    }

    // 3. agentConfigsDir convention: "{agentConfigsDir}/.dmtools/config.js"
    //    Allows sm.json to pass only "agentConfigsDir" and skip explicit configPath
    if (!loaded && params && params.agentConfigsDir) {
        var agentDirPath = params.agentConfigsDir + '/.dmtools/config.js';
        loaded = loadConfigFile(agentDirPath);
        if (loaded) {
            resolvedPath = agentDirPath;
            console.log('configLoader: Loaded config from ' + agentDirPath + ' (agentConfigsDir)');
        }
    }

    // 4. Relative discovery: ../.dmtools/config.js (submodule layout)
    if (!loaded) {
        var relativePath = '../.dmtools/config.js';
        loaded = loadConfigFile(relativePath);
        if (loaded) {
            resolvedPath = relativePath;
            console.log('configLoader: Loaded config from ' + relativePath);
        }
    }

    // 5. Co-located: .dmtools/config.js (same repo layout)
    if (!loaded) {
        var absolutePath = '.dmtools/config.js';
        loaded = loadConfigFile(absolutePath);
        if (loaded) {
            resolvedPath = absolutePath;
            console.log('configLoader: Loaded config from ' + absolutePath);
        }
    }

    if (!loaded) {
        console.log('configLoader: No project config found, using defaults');
    }

    var config = mergeProjectConfig(DEFAULTS, loaded);

    // Store resolved config path so callers can propagate it downstream
    if (resolvedPath) config._configPath = resolvedPath;

    // Apply targetRepository override from customParams
    if (customParams.targetRepository) {
        var tr = customParams.targetRepository;
        if (tr.owner) config.repository.owner = tr.owner;
        if (tr.repo) config.repository.repo = tr.repo;
        if (tr.baseBranch) config.git.baseBranch = tr.baseBranch;
        if (tr.workingDir) config.workingDir = tr.workingDir;
        console.log('configLoader: Applied targetRepository override → ' +
            config.repository.owner + '/' + config.repository.repo);
    }

    // Keep customParams available to extension hooks such as branchNamingFn.
    // This lets project-specific naming functions read explicit, non-generic
    // settings without hardcoding them in the shared agents repo.
    config.customParams = customParams;

    // Apply branchNamingFnPath from customParams — loads a JS file whose module.exports
    // is a function(ticket, branchRole, config) → string.  Takes priority over config.git.branchNamingFn.
    // Existing two-argument functions remain compatible because JavaScript ignores extra args.
    // Uses the same GraalJS-safe loadConfigFile() loader (new Function under the hood).
    if (customParams.branchNamingFnPath) {
        var namingFn = loadConfigFile(customParams.branchNamingFnPath);
        if (typeof namingFn === 'function') {
            config.git.branchNamingFn = namingFn;
            console.log('configLoader: Loaded branchNamingFn from ' + customParams.branchNamingFnPath);
        } else {
            console.warn('configLoader: branchNamingFnPath "' + customParams.branchNamingFnPath +
                '" did not export a function — ignoring');
        }
    }

    // Allow individual agents to enable two-branch flow via customParams.featureBranchEnabled,
    // without requiring a project-wide config.git.featureBranch.enabled change.
    if (customParams.featureBranchEnabled === true) {
        config.git.featureBranch = config.git.featureBranch || {};
        config.git.featureBranch.enabled = true;
        console.log('configLoader: Two-branch flow enabled via customParams.featureBranchEnabled');
    }

    // Apply scmProvider override from customParams
    if (customParams.scmProvider) {
        config.scm = config.scm || {};
        config.scm.provider = customParams.scmProvider;
        console.log('configLoader: SCM provider set to ' + customParams.scmProvider + ' via customParams.scmProvider');
    }

    return config;
}

// ── Template utilities ───────────────────────────────────────────────────────

/**
 * Replace {placeholder} tokens in a template string.
 * @param {string} template - Template with {varName} placeholders
 * @param {Object} vars - Key-value pairs for substitution
 * @returns {string} Resolved string
 */
function formatTemplate(template, vars) {
    if (!template) return '';
    var result = template;
    for (var key in vars) {
        if (vars.hasOwnProperty(key)) {
            // Replace all occurrences of {key}
            var placeholder = '{' + key + '}';
            while (result.indexOf(placeholder) !== -1) {
                result = result.replace(placeholder, vars[key] || '');
            }
        }
    }
    return result;
}

/**
 * Interpolate JQL template placeholders using config.
 * Replaces {jiraProject} and {parentTicket}.
 */
function interpolateJql(jql, config) {
    if (!jql) return jql;
    return formatTemplate(jql, {
        jiraProject: config.jira.project,
        parentTicket: config.jira.parentTicket
    });
}

/**
 * Build a branch name from prefix and ticket key.
 */
function formatBranchName(prefix, ticketKey) {
    return prefix + '/' + ticketKey;
}

/**
 * Resolve the working branch name for a ticket and role ('development', 'feature', 'test').
 * If config.git.branchNamingFn is set, delegates to it.
 * Otherwise falls back to formatBranchName(config.git.branchPrefix[branchRole], ticket.key).
 *
 * @param {Object} config     - Merged project config from loadProjectConfig()
 * @param {Object} ticket     - Jira ticket object ({ key, fields: { issuetype: { name } } })
 * @param {string} branchRole - 'development' | 'feature' | 'test'
 * @returns {string} Branch name
 */
function resolveBranchName(config, ticket, branchRole) {
    if (config.git.branchNamingFn && typeof config.git.branchNamingFn === 'function') {
        return config.git.branchNamingFn(ticket, branchRole, config);
    }
    var prefix = (config.git.branchPrefix && config.git.branchPrefix[branchRole])
              || config.git.branchPrefix.development;
    return formatBranchName(prefix, ticket.key);
}

/**
 * Resolve the PR target branch.
 * In two-branch mode (config.git.featureBranch.enabled = true):
 *   returns the feature branch name (resolveBranchName for 'feature' role).
 * Otherwise: returns config.git.baseBranch.
 *
 * @param {Object} config  - Merged project config
 * @param {Object} ticket  - Jira ticket object
 * @returns {string} Branch to open PR against
 */
function resolvePRTargetBranch(config, ticket) {
    if (config.git.featureBranch && config.git.featureBranch.enabled) {
        return resolveBranchName(config, ticket, 'feature');
    }
    return config.git.baseBranch;
}

// ── Confluence URL resolution ────────────────────────────────────────────────

/**
 * Resolve Confluence URLs in an array of strings (instructions, etc.)
 * Replaces default Confluence URLs with project-specific overrides from config.
 *
 * @param {string[]} items - Array of instruction strings (URLs, file paths, text)
 * @param {Object} config - Loaded project config
 * @returns {string[]} Array with URLs replaced where overrides exist
 */
function resolveConfluenceUrls(items, config) {
    if (!items || !Array.isArray(items)) return items;

    return items.map(function(item) {
        if (typeof item !== 'string') return item;

        // Check if this item is a known default Confluence URL
        var configKey = CONFLUENCE_URL_MAP[item];
        if (configKey && config.confluence && config.confluence[configKey]) {
            return config.confluence[configKey];
        }

        return item;
    });
}

/**
 * Resolve instructions for a specific agent, applying overrides and additions from config.
 *
 * @param {string} agentName - Agent config name (e.g., 'story_development')
 * @param {string[]} defaultInstructions - Default instructions from agent JSON
 * @param {Object} config - Loaded project config
 * @returns {Object} { instructions: string[], instructionsOverridden: boolean, additionalInstructions: string[], cliPrompts: string[], cliPrompt: string|null, agentParamPatch: Object|null, jobParamPatch: Object|null }
 */
function resolveInstructions(agentName, defaultInstructions, config) {
    var instructions = defaultInstructions || [];
    var instructionsOverridden = false;
    var additional = [];
    var cliPrompts = [];
    var cliPrompt = null;
    var agentParamPatch = null;
    var jobParamPatch = null;

    // Full override if instructionOverrides has this agent
    if (config.instructionOverrides && config.instructionOverrides[agentName]) {
        instructions = config.instructionOverrides[agentName];
        instructionsOverridden = true;
    } else {
        // Resolve Confluence URLs in default instructions
        instructions = resolveConfluenceUrls(instructions, config);
    }

    // Additional instructions (appended via dmtools-core's additionalInstructions field)
    if (config.additionalInstructions && config.additionalInstructions[agentName]) {
        additional = config.additionalInstructions[agentName];
    }

    if (config.cliPrompts && config.cliPrompts[agentName]) {
        cliPrompts = config.cliPrompts[agentName];
    }

    if (config.cliPromptOverrides && config.cliPromptOverrides[agentName]) {
        cliPrompt = config.cliPromptOverrides[agentName];
    }

    if (config.agentParamPatches && config.agentParamPatches[agentName]) {
        agentParamPatch = config.agentParamPatches[agentName];
    }
    if (config.jobParamPatches && config.jobParamPatches[agentName]) {
        jobParamPatch = config.jobParamPatches[agentName];
    }

    return {
        instructions: instructions,
        instructionsOverridden: instructionsOverridden,
        additionalInstructions: additional,
        cliPrompts: cliPrompts,
        cliPrompt: cliPrompt,
        agentParamPatch: agentParamPatch,
        jobParamPatch: jobParamPatch
    };
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    DEFAULTS: DEFAULTS,
    loadProjectConfig: loadProjectConfig,
    mergeProjectConfig: mergeProjectConfig,
    deepMerge: deepMerge,
    formatTemplate: formatTemplate,
    interpolateJql: interpolateJql,
    formatBranchName: formatBranchName,
    resolveBranchName: resolveBranchName,
    resolvePRTargetBranch: resolvePRTargetBranch,
    resolveConfluenceUrls: resolveConfluenceUrls,
    resolveInstructions: resolveInstructions,
    createScm: _scmModule ? _scmModule.createScm : function() { throw new Error('scm.js not available in this environment'); }
};
