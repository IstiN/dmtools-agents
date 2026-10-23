/**
 * Configuration Loader for DMTools Agents
 *
 * Discovers and loads project-specific configuration from .dmtools/config.js,
 * merging with built-in defaults to support multi-repo agent deployments.
 *
 * Discovery order:
 *   1. customParams.configPath (explicit path)
 *   2. .dmtools/config.js      (target repo root layout)
 *   3. ../.dmtools/config.js   (when running directly from agents submodule)
 *   4. Built-in defaults       (backward compatible)
 *
 * Merge strategy:
 *   - jira.statuses, jira.issueTypes: DEEP MERGE over built-in defaults — a project may
 *     override only the keys it renames; unspecified keys keep the defaults from config.js
 *   - jira.questions, labels: FULL REPLACEMENT when provided
 *   - smRules, smMergeRules: FULL REPLACEMENT when provided
 *   - repository, git, formats, confluence, discovery, jira.fields: DEEP MERGE
 *   - additionalInstructions, instructionOverrides, cliPrompts, cliPromptOverrides, agentParamPatches, jobParamPatches:
 *     FULL REPLACEMENT when provided (per agent key)
 *   - globalCliPrompts, globalAdditionalInstructions: APPENDED to every agent (inject-to-all)
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
        // Opt-in: also transition the ticket to statuses.IN_DEVELOPMENT when rework setup
        // begins (see preCliReworkSetup.js). Off by default so the generic rework flow
        // (bounce back to IN_REWORK, an already-"actively worked" status) is unchanged;
        // enable for projects whose rework bounce-back target is a "queued" status instead.
        markReworkInDevelopment: false,
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
        snapshotBranch: '',     // optional branch for BA/SA/discovery codegraph snapshots
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

    // Used by the discovery agent (discovery.json) to publish outputs/discovery/
    // to Confluence. Left blank by default — every project MUST set these in its
    // own .dmtools/config.js before discovery pages can be published; this repo
    // stays project-agnostic.
    discovery: {
        space: '',            // Confluence space key discovery pages are created in
        parentPageId: '',     // Confluence page ID each ticket's discovery page nests under
        deleteOrphans: false  // Whether confluence_sync_markdown_directory removes child
                               // pages no longer present in outputs/discovery/
    },

    smRules: null,
    smMergeRules: null,
    workflowRef: '',
    sm: {
        workflowRef: ''
    },

    // Base directory for agent JSON configs (e.g. "projects/alpha").
    // When set, smRules.configFile values without a "/" are resolved relative to this dir.
    // Allows config.js to own the full picture: repo, jira, rules, and agent paths.
    agentConfigsDir: null,

    additionalInstructions: {},
    instructionOverrides: {},
    cliPrompts: {},
    cliPromptOverrides: {},
    cliPromptsByTracker: {},
    agentParamPatches: {},
    jobParamPatches: {},

    // Injected into every agent without repeating per-context.
    // Merged AFTER per-agent entries so global items always appear last.
    globalCliPrompts: [],
    globalAdditionalInstructions: [],

    scm: {
        provider: 'github',  // 'github' | 'gitlab' | 'ado' — source control provider for PR/MR operations
        jenkinsBasePath: ''  // Optional: base URL of Jenkins instance for fetching failed-check logs in pr_rework
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
 * - jira.statuses, jira.issueTypes: deep merge over defaults, so partial
 *   overrides keep unspecified default keys (backward compatible)
 * - jira.questions, labels, smRules, smMergeRules: full replacement
 * - everything else: deep merge
 */
/**
 * Copy flat string entries (and optional per-provider sub-map entries) from a
 * tracker/jira statuses object onto target.
 */
function _copyStringStatuses(target, statuses) {
    var keys = Object.keys(statuses);
    for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (typeof statuses[k] === 'string') target[k] = statuses[k];
    }
    return target;
}

function _applyProviderSubmap(target, statuses, provider) {
    if (!provider) return target;
    var provMap = statuses[provider];
    return (provMap && typeof provMap === 'object') ? Object.assign(target, provMap) : target;
}

function copyStatusEntries(target, statuses, provider) {
    if (!statuses || typeof statuses !== 'object') return target;
    return _applyProviderSubmap(_copyStringStatuses(target, statuses), statuses, provider);
}

function _trackerProviderOf(config, trackerProvider) {
    var trackerCfg = (config && config.tracker) || {};
    var raw = trackerProvider || trackerCfg.provider || (config && config.defaultTracker) || '';
    return String(raw).toLowerCase();
}

function _trackerStatusesOf(overrides) {
    var tr = overrides && overrides.tracker;
    return (tr && tr.statuses && typeof tr.statuses === 'object') ? tr.statuses : null;
}

function syncTrackerStatuses(result, defaults, overrides) {
    var jiraCfg = result.jira || (result.jira = {});
    jiraCfg.statuses = Object.assign({}, defaults.jira.statuses, jiraCfg.statuses || {});
    var trackerStatuses = _trackerStatusesOf(overrides);
    if (!trackerStatuses) return;
    jiraCfg.statuses = copyStatusEntries(jiraCfg.statuses, trackerStatuses, _trackerProviderOf(result));
}

function mergeProjectConfig(defaults, overrides) {
    if (!overrides) return defaults;

    var result = deepMerge(defaults, overrides);

    // Full replacement sections: if override provides these, use them entirely
    if (overrides.jira) {
        // statuses/issueTypes merge over defaults via deepMerge above — restore them
        // if an explicit null in overrides wiped the section
        if (!result.jira.statuses) result.jira.statuses = defaults.jira.statuses;
        if (!result.jira.issueTypes) result.jira.issueTypes = defaults.jira.issueTypes;
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
    if (overrides.cliPromptsByTracker) {
        result.cliPromptsByTracker = overrides.cliPromptsByTracker;
    }
    if (overrides.agentParamPatches) {
        result.agentParamPatches = overrides.agentParamPatches;
    }
    if (overrides.jobParamPatches) {
        result.jobParamPatches = overrides.jobParamPatches;
    }

    syncTrackerStatuses(result, defaults, overrides);
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

// ── Agent config "parent" inheritance (gh-1112) ──────────────────────────────
//
// A child agent JSON in a consuming repo specializes a base agent (e.g. the
// generic wiki_publisher.json) instead of forking it:
//
//   {
//     "parent": { "path": "../agents/wiki_publisher.json", "merge": ["params.cliPrompts"] },
//     "params": { "metadata": { "contextId": "story_checklist" }, ... }
//   }
//
// Resolution: the parent config is loaded (recursively), the child's params
// deep-merge over it (child wins), and every path in `merge` has its ARRAY
// value concatenated parent-first + child entries appended (de-duplicated).
// Paths where the parent/child value is not an array are ignored by the merge
// list — plain deep merge already lets the child override them.

var DEFAULT_PARENT_MERGE = ['params.cliPrompts'];

/** Read a dotted 'params.cliPrompts' style path; undefined when absent. */
function getPathValue(obj, path) {
    var cur = obj;
    var parts = String(path || '').split('.');
    for (var i = 0; i < parts.length; i++) {
        if (!cur || typeof cur !== 'object') return undefined;
        cur = cur[parts[i]];
    }
    return cur;
}

/** Write a dotted path in place, creating intermediate objects as needed. */
function setPathValue(obj, path, value) {
    var parts = String(path || '').split('.');
    var cur = obj;
    for (var i = 0; i < parts.length - 1; i++) {
        if (!cur[parts[i]] || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
        cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
}

/**
 * Resolve a parent path to a readable file. Child configs live in consuming
 * repos ('../agents/wiki_publisher.json', './wiki_publisher.json') or beside
 * the base agent ('wiki_publisher.json'); strip the layout prefixes and try
 * repo-root-relative when the literal path is not readable.
 */
function resolveAgentConfigPath(path) {
    var p = String(path || '').trim();
    var candidates = [p];
    if (p.indexOf('../agents/') === 0) candidates.push(p.substring('../'.length));
    if (p.indexOf('agents/') === 0) candidates.push(p.substring('agents/'.length));
    if (p.indexOf('./') === 0) candidates.push(p.substring(2));
    for (var i = 0; i < candidates.length; i++) {
        if (tryReadFile(candidates[i]) !== null) return candidates[i];
    }
    return p;
}

/** Read and parse an agent JSON config; null (with a warning) when unreadable/unparseable. */
function readAgentConfigJson(path) {
    var raw = tryReadFile(path);
    if (!raw) {
        console.warn('configLoader: cannot read agent config "' + path + '"');
        return null;
    }
    try {
        return JSON.parse(raw);
    } catch (e) {
        console.warn('configLoader: cannot parse agent config "' + path + '": ' + (e.message || e));
        return null;
    }
}

/** The inheritance marker is accepted at the top level or inside params. */
function extractParentRef(config) {
    return config.parent || (config.params && config.params.parent) || null;
}

/** The per-path array list to concatenate; defaults to params.cliPrompts. */
function resolveMergePaths(parentRef) {
    return (Array.isArray(parentRef.merge) && parentRef.merge.length > 0)
        ? parentRef.merge
        : DEFAULT_PARENT_MERGE;
}

/** Copy source's top-level keys onto target (skipping the params/parent keys). */
function copyTopLevelKeys(target, source) {
    for (var key in source) {
        if (Object.prototype.hasOwnProperty.call(source, key) && key !== 'params' && key !== 'parent') {
            target[key] = source[key];
        }
    }
    return target;
}

function extractSectionPromptsList(sec) {
    var out = [];
    if (typeof sec.prompt === 'string') out.push(sec.prompt);
    if (Array.isArray(sec.prompts)) {
        for (var i = 0; i < sec.prompts.length; i++) {
            if (typeof sec.prompts[i] === 'string') out.push(sec.prompts[i]);
        }
    }
    return out;
}

function combineSectionPrompts(basePrompts, overPrompts, strategy) {
    if (strategy === 'replace') return overPrompts;
    if (strategy === 'prepend') return overPrompts.concat(basePrompts);
    return basePrompts.concat(overPrompts);
}

function mergeCliPromptSections(baseSec, overSec) {
    var strategy = String(overSec.mergeStrategy || baseSec.mergeStrategy || 'append').toLowerCase();
    var result = {
        id: overSec.id || baseSec.id,
        prompts: combineSectionPrompts(extractSectionPromptsList(baseSec), extractSectionPromptsList(overSec), strategy),
        mergeStrategy: strategy
    };
    var cond = String(overSec.condition || baseSec.condition || '').trim();
    if (cond) result.condition = cond;
    return result;
}

function isPromptSectionObj(item) {
    return !!(item && typeof item === 'object' && !Array.isArray(item) && item.id);
}

function findPromptSectionIndex(list, id) {
    for (var k = 0; k < list.length; k++) {
        if (isPromptSectionObj(list[k]) && list[k].id === id) return k;
    }
    return -1;
}

/** Parent-first array concat; child entries already present are not repeated, and section objects with matching id merge in-place. */
function concatUnique(parentList, childList) {
    var combined = parentList.slice();
    for (var j = 0; j < childList.length; j++) {
        var item = childList[j];
        if (isPromptSectionObj(item)) {
            var idx = findPromptSectionIndex(combined, item.id);
            if (idx !== -1) combined[idx] = mergeCliPromptSections(combined[idx], item);
            else combined.push(item);
        } else if (combined.indexOf(item) === -1) {
            combined.push(item);
        }
    }
    return combined;
}

/** Apply one dotted merge path: parent array first, unseen child entries appended. */
function applyParentMergePath(merged, parentConfig, config, mergePath) {
    var parentVal = getPathValue(parentConfig, mergePath);
    var childVal = getPathValue(config, mergePath);
    if (!Array.isArray(parentVal) && !Array.isArray(childVal)) return;
    setPathValue(merged, mergePath, concatUnique(
        Array.isArray(parentVal) ? parentVal : [],
        Array.isArray(childVal) ? childVal : []
    ));
}

/** Apply every dotted merge path of the parent's arrays onto the merged config. */
function applyParentMergePaths(merged, parentConfig, config, mergePaths) {
    for (var i = 0; i < mergePaths.length; i++) {
        applyParentMergePath(merged, parentConfig, config, mergePaths[i]);
    }
}

/**
 * Merge a resolved parent under its child: child top-level keys win, child
 * params deep-merge over the parent's (child wins on scalars and nested
 * objects, e.g. a child contentOutput block overrides the parent's).
 */
function mergeParentIntoChild(parentConfig, config) {
    var merged = copyTopLevelKeys(copyTopLevelKeys({}, parentConfig), config);
    merged.params = deepMerge(parentConfig.params || {}, config.params || {});
    return merged;
}

/**
 * Load an agent JSON config, resolving its "parent" inheritance chain.
 * Returns the merged config (child fields win, merged array paths are
 * concatenated parent-first), or null when the file is missing/unparseable.
 * A missing or broken parent is non-fatal: the child config is returned
 * as-is (minus the parent marker) with a warning.
 */
function loadAgentConfig(path) {
    var config = readAgentConfigJson(resolveAgentConfigPath(path));
    if (!config) return null;

    var parentRef = extractParentRef(config);
    if (!parentRef || !parentRef.path) return config;

    var parentConfig = loadAgentConfig(resolveAgentConfigPath(parentRef.path));
    // The marker is consumed either way — it never appears on resolved configs.
    delete config.parent;
    if (config.params) delete config.params.parent;
    if (!parentConfig) {
        console.warn('configLoader: parent "' + parentRef.path + '" of "' + path + '" could not be loaded — using the child config as-is');
        return config;
    }

    var merged = mergeParentIntoChild(parentConfig, config);
    applyParentMergePaths(merged, parentConfig, config, resolveMergePaths(parentRef));
    return merged;
}

/**
 * Loads a project-supplied "hook" JS file (same GraalJS-safe loader as branchNamingFnPath)
 * whose module.exports must be a function. Used for extension points such as
 * customParams.branchCreateFnPath / branchSyncFnPath, where a project can plug in custom
 * branch-creation/sync logic (e.g. delegating to an external CI job) without that logic
 * living in this generic repo. Returns null (with a console.warn) if the path isn't set,
 * the file can't be loaded, or it doesn't export a function.
 *
 * @param {string} path     - customParams.<x>FnPath value
 * @param {string} hookName - label used in warning messages, e.g. "branchCreateFnPath"
 * @returns {Function|null}
 */
function loadHookFn(path, hookName) {
    if (!path) return null;
    var fn = loadConfigFile(path);
    if (typeof fn !== 'function') {
        console.warn('configLoader: ' + hookName + ' "' + path + '" did not export a function — ignoring');
        return null;
    }
    return fn;
}

/**
 * Build the params object to pass into loadProjectConfig() when the caller needs
 * ticket-aware resolvers (baseBranchResolverFnPath / snapshotBranchResolverFnPath).
 *
 * Background: in the real Teammate execution path, preJSAction/postJSAction params
 * have `jobParams` and `ticket` as *sibling* top-level keys (see JavaScriptExecutor.
 * withJobContext in dm.ai — parameters.put("jobParams", ...); parameters.put("ticket", ...)).
 * Most call sites use `params.jobParams || params` to read customParams/configPath,
 * which silently drops the sibling `params.ticket` since it's never nested inside
 * jobParams in that mode. Any resolver keyed off params.ticket (fixVersion-based
 * branch resolution, etc.) would then never fire. This helper re-attaches the
 * ticket without mutating the original params/jobParams objects.
 *
 * @param {Object} params - Full action params (may have .jobParams and/or .ticket)
 * @returns {Object} params object safe to pass into loadProjectConfig()
 */
function paramsForConfigLoad(params) {
    var base = (params && params.jobParams) || params || {};
    var ticket = (base && base.ticket) || (params && params.ticket);
    if (ticket && base.ticket !== ticket) {
        base = Object.assign({}, base, { ticket: ticket });
    }
    return base;
}

/**
 * Build the ordered list of config sources to probe for loadProjectConfig().
 * Each candidate is { path, logSuffix } — logSuffix is appended to the
 * 'Loaded config from …' line so the agentConfigsDir convention stays
 * distinguishable in logs.
 */
function buildConfigCandidates(params, customParams) {
    var candidates = [];
    // 1. Top-level configPath (e.g. jobParams.configPath or smAgent's p.configPath)
    if (params && params.configPath) {
        candidates.push({ path: params.configPath, logSuffix: '' });
    }
    // 2. Explicit configPath in customParams (e.g. agent JSON customParams.configPath)
    if (customParams.configPath) {
        candidates.push({ path: customParams.configPath, logSuffix: '' });
    }
    // 3. agentConfigsDir convention: "{agentConfigsDir}/.dmtools/config.js"
    //    Allows sm.json to pass only "agentConfigsDir" and skip explicit configPath
    if (params && params.agentConfigsDir) {
        candidates.push({ path: params.agentConfigsDir + '/.dmtools/config.js', logSuffix: ' (agentConfigsDir)' });
    }
    // 4. Co-located/target-root discovery: .dmtools/config.js
    candidates.push({ path: '.dmtools/config.js', logSuffix: '' });
    // 5. Relative discovery: ../.dmtools/config.js (when running from agents/)
    candidates.push({ path: '../.dmtools/config.js', logSuffix: '' });
    return candidates;
}

/**
 * Probe the candidate config sources in order and return the first one that
 * loads, mirroring the historical precedence:
 *   configPath → customParams.configPath → agentConfigsDir → .dmtools → ../.dmtools
 *
 * @returns {Object} { loaded: Object|null, resolvedPath: string|null }
 */
function discoverProjectConfig(params, customParams) {
    var candidates = buildConfigCandidates(params, customParams);
    var loaded = null;
    var resolvedPath = null;
    for (var i = 0; i < candidates.length; i++) {
        if (loaded) break;
        var candidate = candidates[i];
        var config = loadConfigFile(candidate.path);
        if (config) {
            loaded = config;
            resolvedPath = candidate.path;
            console.log('configLoader: Loaded config from ' + candidate.path + candidate.logSuffix);
        }
    }
    if (!loaded) {
        console.log('configLoader: No project config found, using defaults');
    }
    return { loaded: loaded, resolvedPath: resolvedPath };
}

/**
 * Apply the explicit repository from the job params (SM passes the rule's
 * target repo) — wins over the config file and remote-derived defaults.
 */
function applyJobRepository(config, params) {
    if (params && params.repository && params.repository.owner && params.repository.repo) {
        config.repository.owner = params.repository.owner;
        config.repository.repo = params.repository.repo;
    }
}

/**
 * Apply the targetRepository override from customParams. Individual fields
 * are applied only when present; the resulting owner/repo is always logged.
 */
function applyTargetRepository(config, customParams) {
    if (!customParams.targetRepository) return;
    var tr = customParams.targetRepository;
    if (tr.owner) config.repository.owner = tr.owner;
    if (tr.repo) config.repository.repo = tr.repo;
    if (tr.baseBranch) config.git.baseBranch = tr.baseBranch;
    if (tr.workingDir) config.workingDir = tr.workingDir;
    console.log('configLoader: Applied targetRepository override → ' +
        config.repository.owner + '/' + config.repository.repo);
}

/**
 * Candidate branch a resolver receives: the snapshot resolver may fall back
 * to the latest existing release branch rather than the repository's default
 * base branch; the base-branch resolver always starts from baseBranch.
 */
function resolveCandidateBranch(config, branchKey) {
    if (branchKey === 'snapshotBranch') {
        return config.git.snapshotBranch || config.git.baseBranch;
    }
    return config.git.baseBranch;
}

/**
 * Invoke a branch resolver hook: a truthy return replaces the branch, a
 * falsy return keeps the candidate, a throwing resolver is logged and
 * ignored (candidate kept).
 */
function runBranchResolver(resolver, ticket, candidateBranch, config, branchKey, resolverPath) {
    try {
        var resolvedBranch = resolver(ticket, candidateBranch, config);
        if (resolvedBranch) {
            config.git[branchKey] = resolvedBranch;
            console.log('configLoader: Resolved ' + branchKey + ' via ' + resolverPath + ' → ' + resolvedBranch);
        }
    } catch (e) {
        console.warn('configLoader: ' + branchKey + 'Resolver failed, keeping candidate ' + branchKey + ':', e.message || e);
    }
}

/**
 * Apply a project-specific branch resolver hook (config.git.baseBranchResolverFnPath
 * or config.git.snapshotBranchResolverFnPath). The resolver receives
 * (ticket, candidateBranch, config) and must return a branch name; a falsy
 * return keeps the candidate, a throwing resolver is logged and ignored.
 *
 * @param {Object} config    - Merged project config (mutated in place)
 * @param {Object} params    - Agent params (must carry .ticket for the hook to fire)
 * @param {string} pathKey   - 'baseBranchResolverFnPath' | 'snapshotBranchResolverFnPath'
 * @param {string} branchKey - 'baseBranch' | 'snapshotBranch' (the git key to update)
 */
function applyBranchResolverFn(config, params, pathKey, branchKey) {
    var resolverPath = config.git && config.git[pathKey];
    if (!resolverPath || !params || !params.ticket) return;
    var resolver = loadHookFn(resolverPath, pathKey);
    if (!resolver) return;
    runBranchResolver(resolver, params.ticket, resolveCandidateBranch(config, branchKey), config, branchKey, resolverPath);
}

/**
 * Load a customParams.*FnPath hook file whose module.exports must be a
 * function, and install it on the given target under exportKey. Used for
 * branchNamingFnPath (target: config.git) and prSearchFnPath (target:
 * config); warns and ignores non-function exports. The path is read by the
 * caller via a literal customParams.<key> member access (NOT a dynamic
 * customParams[key]) so js/agentDocGenerator.js regex-based discovery keeps
 * seeing the supported keys.
 *
 * @param {Object} target    - Object to receive the loaded function
 * @param {string} path      - customParams.<key> value (hook file path)
 * @param {string} key       - customParams key name, used in the warn line
 * @param {string} exportKey - Target property to install the function on
 */
function loadCustomParamFnHook(target, path, key, exportKey) {
    if (!path) return;
    var fn = loadConfigFile(path);
    if (typeof fn === 'function') {
        target[exportKey] = fn;
        console.log('configLoader: Loaded ' + exportKey + ' from ' + path);
    } else {
        console.warn('configLoader: ' + key + ' "' + path + '" did not export a function — ignoring');
    }
}

/**
 * Apply the simple customParams switches: featureBranchEnabled opts an
 * individual agent into the two-branch flow, scmProvider overrides the
 * source-control provider.
 */
function applyCustomParamOverrides(config, customParams) {
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
}

/**
 * Load project configuration with discovery and merging.
 *
 * Discovery order:
 *   1. params.configPath          — top-level param (e.g. jobParams.configPath in sm.json)
 *   2. params.customParams.configPath — explicit path from agent customParams
 *   3. params.agentConfigsDir + "/.dmtools/config.js" — when agentConfigsDir is passed
 *   4. .dmtools/config.js          — target repo root layout
 *   5. ../.dmtools/config.js       — running directly from agents submodule
 *   6. Defaults                    — built-in defaults from config.js
 *
 * @param {Object} params - Agent params (jobParams or top-level params)
 * @returns {Object} Merged configuration
 */
function loadProjectConfig(params) {
    var customParams = (params && params.customParams) || {};

    var discovered = discoverProjectConfig(params, customParams);
    var config = mergeProjectConfig(DEFAULTS, discovered.loaded);

    // Store resolved config path so callers can propagate it downstream
    if (discovered.resolvedPath) config._configPath = discovered.resolvedPath;

    applyJobRepository(config, params);
    applyTargetRepository(config, customParams);

    // Keep customParams available to extension hooks such as branchNamingFn.
    // This lets project-specific naming functions read explicit, non-generic
    // settings without hardcoding them in the shared agents repo.
    config.customParams = customParams;

    // Apply baseBranchResolverFnPath / snapshotBranchResolverFnPath from
    // config.git — project-specific functions that can override the base
    // branch (e.g. mapped from a Jira fixVersion) or select the snapshot
    // branch used for BA/SA/discovery codegraph snapshots.
    applyBranchResolverFn(config, params, 'baseBranchResolverFnPath', 'baseBranch');
    applyBranchResolverFn(config, params, 'snapshotBranchResolverFnPath', 'snapshotBranch');

    // Apply branchNamingFnPath / prSearchFnPath from customParams — loads JS
    // files whose module.exports is a function. branchNamingFn takes
    // (ticket, branchRole, config) and overrides config.git.branchNamingFn;
    // prSearchFn takes (candidates, ticketKey, options). Both use the same
    // GraalJS-safe loadConfigFile() loader (new Function under the hood).
    loadCustomParamFnHook(config.git, customParams.branchNamingFnPath, 'branchNamingFnPath', 'branchNamingFn');
    loadCustomParamFnHook(config, customParams.prSearchFnPath, 'prSearchFnPath', 'prSearchFn');

    applyCustomParamOverrides(config, customParams);

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
 * Replaces `{status.KEY}` and `{status.KEY:Literal}` placeholders in a JQL template (agents#855).
 *
 * - `{status.KEY:Literal}` — the form used by the shipped SM rules. It resolves to the project's
 *   `jira.statuses.KEY` ONLY when the project opted in with `jira.useConfiguredStatusesInQueries: true`;
 *   otherwise it resolves to `Literal`, so every existing deployment sends byte-for-byte the same JQL as
 *   before the placeholders existed. (Several `jira.statuses` values are transition NAMES, not status
 *   names — e.g. PO_REVIEW 'PO REVIEW' reaches status 'PO Review' — so substituting them by default
 *   would change what existing projects query.)
 * - `{status.KEY}` (no literal) — always the configured/default `jira.statuses.KEY`.
 * - An unknown KEY is left untouched, like every other unknown placeholder.
 * Quoting: inside quotes written in the template the value is only escaped; in an unquoted position a plain
 * word stays bare (so the default query is byte-identical to the old literal) and any other value is
 * wrapped in double quotes.
 */
/**
 * Resolve effective status map for placeholder interpolation:
 * built-in defaults < jira.statuses < tracker.statuses < tracker.statuses.<provider>.
 */
function _sectionOf(config, key) {
    return (config && config[key]) || {};
}

function resolveEffectiveStatuses(config, trackerProvider) {
    var prov = _trackerProviderOf(config, trackerProvider);
    var merged = copyStatusEntries({}, _sectionOf(config, 'jira').statuses, prov);
    return copyStatusEntries(merged, _sectionOf(config, 'tracker').statuses, prov);
}

function resolveUseConfiguredStatuses(config) {
    var trackerFlag = _sectionOf(config, 'tracker').useConfiguredStatusesInQueries;
    if (typeof trackerFlag === 'boolean') return trackerFlag;
    return _sectionOf(config, 'jira').useConfiguredStatusesInQueries === true;
}

function _rawStageFallback(config, customParams) {
    customParams = customParams || _sectionOf(config, 'customParams');
    return customParams.stageFallback || _sectionOf(config, 'tracker').stageFallback || _sectionOf(config, 'jira').stageFallback || 'none';
}

function resolveStageFallbackMode(config, customParams) {
    return String(_rawStageFallback(config, customParams)).toLowerCase() === 'label' ? 'label' : 'none';
}

/** Pick the status name for a `{status.KEY[:Literal]}` or `{stage.KEY[:Literal]}` placeholder. */
function pickPlaceholderStatus(statuses, useConfigured, key, literal) {
    var configured = statuses[key];
    if (literal !== undefined) {
        return (useConfigured && configured) ? String(configured) : String(literal);
    }
    return configured ? String(configured) : null;
}

/** Quote or escape a status value according to its surrounding characters in a query template. */
function formatStatusToken(value, before, after) {
    var quoted = (before === "'" || before === '"') && after === before;
    if (quoted) {
        return value.replace(new RegExp(before, 'g'), '\\' + before);
    }
    return /^[A-Za-z0-9_]+$/.test(value) ? value : '"' + value.replace(/"/g, '\\"') + '"';
}

function interpolateStatusPlaceholders(jql, config, trackerProvider) {
    var statuses = resolveEffectiveStatuses(config, trackerProvider);
    var useConfigured = resolveUseConfiguredStatuses(config);
    return String(jql).replace(/\{status\.([A-Za-z0-9_]+)(?::([^}]*))?\}/g, function (match, key, literal, offset, whole) {
        var value = pickPlaceholderStatus(statuses, useConfigured, key, literal);
        if (value === null) return match;
        var before = offset > 0 ? whole.charAt(offset - 1) : '';
        var after = whole.charAt(offset + match.length);
        return formatStatusToken(value, before, after);
    });
}

/** Build the status clause and optional stage-label fallback clause for `{stage.KEY[:Literal]}`. */
function formatStageClause(name, key, withLabel, ado) {
    var quotedName = "'" + name.replace(/'/g, "\\'") + "'";
    var statusClause = ado ? '[System.State] IN (' + quotedName + ')' : 'status in (' + quotedName + ')';
    if (!withLabel) return statusClause;
    var label = DEFAULT_CONFIG.stageLabel(key);
    var labelClause = ado ? "[System.Tags] CONTAINS '" + label + "'" : "labels = '" + label + "'";
    return '(' + statusClause + ' OR ' + labelClause + ')';
}

/**
 * Expands `{stage.KEY:Literal}` into a clause that selects a ticket by its status OR by the stage label a
 * rejected status transition left behind (agents#855/#856/#932), in the syntax of the tracker in use:
 *   Jira / GitHub:  (status in ('X') OR labels = 'stage_x')
 *   Azure DevOps:   ([System.State] IN ('X') OR [System.Tags] CONTAINS 'stage_x')
 * It is OFF by default — the placeholder then expands to the plain status clause the rule always had
 * (`status in ('X')` / `[System.State] IN ('X')`), so nothing changes unless the project sets
 * `tracker.stageFallback: 'label'` or `jira.stageFallback: 'label'`.
 */
function interpolateStagePlaceholders(jql, config, trackerProvider) {
    var statuses = resolveEffectiveStatuses(config, trackerProvider);
    var useConfigured = resolveUseConfiguredStatuses(config);
    var withLabel = resolveStageFallbackMode(config) === 'label';
    var ado = String(trackerProvider || '').toLowerCase() === 'ado';
    return String(jql).replace(/\{stage\.([A-Za-z0-9_]+)(?::([^}]*))?\}/g, function (match, key, literal) {
        var name = pickPlaceholderStatus(statuses, useConfigured, key, literal);
        if (name === null || name === '') return match;
        return formatStageClause(name, key, withLabel, ado);
    });
}

/**
 * Picks the query for the tracker in use: `rule.jqlByTracker[provider]` wins over `rule.jql` when present
 * (agents#855 — an ADO project supplies native WIQL for a rule without forking sm.json). Rules without
 * `jqlByTracker`, and trackers without an entry, use `rule.jql` exactly as before.
 */
function selectRuleQuery(rule, trackerProvider) {
    if (!rule) return null;
    var map = rule.jqlByTracker;
    var provider = String(trackerProvider || '').toLowerCase();
    if (map && typeof map === 'object' && provider && typeof map[provider] === 'string' && map[provider]) {
        return map[provider];
    }
    return rule.jql;
}

/**
 * Interpolate JQL template placeholders using config.
 * Replaces {jiraProject}, {parentTicket}, {status.KEY[:Literal]} (see interpolateStatusPlaceholders) and
 * {stage.KEY[:Literal]} (see interpolateStagePlaceholders; needs trackerProvider for the ADO syntax).
 */
function interpolateJql(jql, config, trackerProvider) {
    if (!jql) return jql;
    var jiraCfg = (config && config.jira) || {};
    var withStage = interpolateStagePlaceholders(jql, config, trackerProvider);
    var withStatus = interpolateStatusPlaceholders(withStage, config, trackerProvider);
    return formatTemplate(withStatus, {
        jiraProject: jiraCfg.project,
        parentTicket: jiraCfg.parentTicket
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

function _configuredWorkflowRefOf(cfg) {
    var top = (cfg && cfg.workflowRef) || '';
    var sm = (cfg && cfg.sm && cfg.sm.workflowRef) || '';
    return top || sm;
}

function _configuredBaseBranchOf(cfg) {
    var git = cfg && cfg.git;
    return (git && git.baseBranch) || '';
}

function _firstWorkflowRef(a, b, c) {
    return a || b || c || '';
}

/**
 * Resolve the default git ref for SM workflow_dispatch when a rule omits
 * workflowRef (or when {branch} expands to empty).
 * Precedence: config.workflowRef -> config.sm.workflowRef -> rule.baseBranch
 * -> config.git.baseBranch -> fallbackConfig equivalents -> 'main'.
 */
function resolveDefaultWorkflowRef(rule, effectiveConfig, fallbackConfig) {
    var explicit = _firstWorkflowRef(
        _configuredWorkflowRefOf(effectiveConfig),
        _configuredWorkflowRefOf(fallbackConfig),
        rule && rule.baseBranch
    );
    var fallback = _firstWorkflowRef(
        _configuredBaseBranchOf(effectiveConfig),
        _configuredBaseBranchOf(fallbackConfig),
        DEFAULT_CONFIG.GIT_CONFIG.DEFAULT_BASE_BRANCH
    );
    return explicit || fallback;
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

// ── resolveInstructions helpers (gh-1086 extraction) ─────────────────────────
// Pure deciders pulled out of resolveInstructions; each is exported for unit
// testing. resolveInstructions keeps the exact original call/merge order.

/**
 * Base instructions for an agent: instructionOverrides fully replace the agent
 * JSON defaults; otherwise default Confluence URLs are resolved against the
 * project config.
 *
 * @returns {{ instructions: string[], instructionsOverridden: boolean }}
 */
function resolveBaseInstructions(agentName, defaultInstructions, config) {
    if (config.instructionOverrides && config.instructionOverrides[agentName]) {
        return {
            instructions: config.instructionOverrides[agentName],
            instructionsOverridden: true
        };
    }
    return {
        instructions: resolveConfluenceUrls(defaultInstructions || [], config),
        instructionsOverridden: false
    };
}

/**
 * Per-agent additional instructions plus the global inject-to-all entries,
 * appended in that order (per-agent array reference is kept when no globals
 * are configured).
 */
function collectAdditionalInstructions(agentName, config) {
    var additional = [];
    if (config.additionalInstructions && config.additionalInstructions[agentName]) {
        additional = config.additionalInstructions[agentName];
    }
    if (config.globalAdditionalInstructions && config.globalAdditionalInstructions.length > 0) {
        additional = additional.concat(config.globalAdditionalInstructions);
    }
    return additional;
}

/**
 * Per-agent CLI prompt entries: short array form (merge strategy, backward
 * compatible) or long { strategy, prompts } form. The configured array
 * reference is returned untouched.
 *
 * @returns {{ prompts: string[], strategy: string }}
 */
function resolveConfiguredCliPrompts(agentName, config) {
    var prompts = [];
    var strategy = 'merge'; // default: append to existing JSON cliPrompts
    if (config.cliPrompts && config.cliPrompts[agentName]) {
        var entry = config.cliPrompts[agentName];
        if (Array.isArray(entry)) {
            // Short form: array → merge strategy (default, backward compatible)
            prompts = entry;
        } else if (entry && typeof entry === 'object' && Array.isArray(entry.prompts)) {
            // Long form: { strategy: 'merge'|'replace', prompts: [...] }
            prompts = entry.prompts;
            if (entry.strategy === 'replace') {
                strategy = 'replace';
            }
        }
    }
    return { prompts: prompts, strategy: strategy };
}

/**
 * Per-agent CLI entry prompt replacement, or null.
 */
function resolveCliPromptOverride(agentName, config) {
    if (config.cliPromptOverrides && config.cliPromptOverrides[agentName]) {
        return config.cliPromptOverrides[agentName];
    }
    return null;
}

function _configuredTrackerProvider(config) {
    if (!config) return null;
    return (config.tracker && config.tracker.provider) || config.defaultTracker || null;
}

/**
 * Tracker type driving cliPromptsByTracker selection: DEFAULT_TRACKER env var,
 * then config.tracker.provider, then config.defaultTracker, then 'jira'.
 * options.trackerOverride (content routed exclusively to Confluence must be
 * authored in Markdown, not in the tracker's markup) wins over all of them.
 */
function resolveTrackerType(config, options) {
    if (options && options.trackerOverride) {
        return options.trackerOverride;
    }
    var trackerType = null;
    try {
        trackerType = java.lang.System.getenv('DEFAULT_TRACKER');
    } catch (e) {
        // Not running in GraalJS environment
    }
    return trackerType || _configuredTrackerProvider(config) || 'jira';
}

/**
 * Tracker-specific prompts from a cliPromptsByTracker object. Flat structure:
 * tracker → array of prompts (used in agent JSON files). Nested structure:
 * tracker → agentName → array of prompts (legacy / unit tests).
 */
function extractTrackerPrompts(source, trackerType, agentName) {
    if (!source || !source[trackerType]) {
        return null;
    }
    var trackerSpecific = source[trackerType];
    if (Array.isArray(trackerSpecific)) {
        return trackerSpecific;
    } else if (trackerSpecific && typeof trackerSpecific === 'object') {
        return trackerSpecific[agentName];
    }
    return null;
}

/**
 * Append tracker prompts to cliPrompts when present (concat always yields a
 * new array; the reference is kept otherwise, as before the extraction).
 */
function appendTrackerPrompts(cliPrompts, trackerPrompts) {
    if (trackerPrompts && trackerPrompts.length > 0) {
        return cliPrompts.concat(trackerPrompts);
    }
    return cliPrompts;
}

/**
 * Per-agent patch entry from a patches map, or null.
 */
function pickAgentPatch(patches, agentName) {
    if (patches && patches[agentName]) {
        return patches[agentName];
    }
    return null;
}

/**
 * Resolve instructions for a specific agent, applying overrides and additions from config.
 *
 * @param {string} agentName - Agent config name (e.g., 'story_development')
 * @param {string[]} defaultInstructions - Default instructions from agent JSON
 * @param {Object} config - Loaded project config
 * @param {Object} [agentCliPromptsByTracker] - Optional agent JSON's cliPromptsByTracker so project config extends rather than replaces it
 * @param {Object} [options] - Optional settings
 * @param {string} [options.trackerOverride] - Tracker key to use for cliPromptsByTracker
 *        selection instead of DEFAULT_TRACKER (e.g. 'confluence' when the agent's
 *        contentOutput routes generated content exclusively to a Confluence page,
 *        which needs Markdown rather than tracker markup)
 * @returns {Object} { instructions: string[], instructionsOverridden: boolean, additionalInstructions: string[], cliPrompts: string[], cliPrompt: string|null, agentParamPatch: Object|null, jobParamPatch: Object|null }
 */
function resolveInstructions(agentName, defaultInstructions, config, agentCliPromptsByTracker, options) {
    var base = resolveBaseInstructions(agentName, defaultInstructions, config);
    var additional = collectAdditionalInstructions(agentName, config);
    var configuredPrompts = resolveConfiguredCliPrompts(agentName, config);

    var cliPrompts = configuredPrompts.prompts;
    // Global CLI prompts injected into every agent
    if (config.globalCliPrompts && config.globalCliPrompts.length > 0) {
        cliPrompts = cliPrompts.concat(config.globalCliPrompts);
    }

    // Merge tracker-specific CLI prompts based on the resolved tracker type:
    // agent JSON first, then project config. This ensures .dmtools/config.js
    // EXTENDS the agent's base tracker prompts rather than replacing them.
    var trackerType = resolveTrackerType(config, options);
    cliPrompts = appendTrackerPrompts(cliPrompts, extractTrackerPrompts(agentCliPromptsByTracker, trackerType, agentName));
    cliPrompts = appendTrackerPrompts(cliPrompts, extractTrackerPrompts(config.cliPromptsByTracker, trackerType, agentName));

    return {
        instructions: base.instructions,
        instructionsOverridden: base.instructionsOverridden,
        additionalInstructions: additional,
        cliPrompts: cliPrompts,
        cliPromptsStrategy: configuredPrompts.strategy,
        cliPrompt: resolveCliPromptOverride(agentName, config),
        agentParamPatch: pickAgentPatch(config.agentParamPatches, agentName),
        jobParamPatch: pickAgentPatch(config.jobParamPatches, agentName)
    };
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    DEFAULTS: DEFAULTS,
    loadProjectConfig: loadProjectConfig,
    paramsForConfigLoad: paramsForConfigLoad,
    mergeProjectConfig: mergeProjectConfig,
    deepMerge: deepMerge,
    formatTemplate: formatTemplate,
    interpolateJql: interpolateJql,
    interpolateStatusPlaceholders: interpolateStatusPlaceholders,
    interpolateStagePlaceholders: interpolateStagePlaceholders,
    selectRuleQuery: selectRuleQuery,
    resolveEffectiveStatuses: resolveEffectiveStatuses,
    resolveUseConfiguredStatuses: resolveUseConfiguredStatuses,
    resolveStageFallbackMode: resolveStageFallbackMode,
    formatBranchName: formatBranchName,
    resolveBranchName: resolveBranchName,
    resolvePRTargetBranch: resolvePRTargetBranch,
    resolveDefaultWorkflowRef: resolveDefaultWorkflowRef,
    resolveConfluenceUrls: resolveConfluenceUrls,
    resolveInstructions: resolveInstructions,
    resolveBaseInstructions: resolveBaseInstructions,
    collectAdditionalInstructions: collectAdditionalInstructions,
    resolveConfiguredCliPrompts: resolveConfiguredCliPrompts,
    resolveCliPromptOverride: resolveCliPromptOverride,
    resolveTrackerType: resolveTrackerType,
    extractTrackerPrompts: extractTrackerPrompts,
    appendTrackerPrompts: appendTrackerPrompts,
    pickAgentPatch: pickAgentPatch,
    loadConfigFile: loadConfigFile,
    loadAgentConfig: loadAgentConfig,
    loadHookFn: loadHookFn,
    buildConfigCandidates: buildConfigCandidates,
    discoverProjectConfig: discoverProjectConfig,
    applyJobRepository: applyJobRepository,
    applyTargetRepository: applyTargetRepository,
    resolveCandidateBranch: resolveCandidateBranch,
    applyBranchResolverFn: applyBranchResolverFn,
    runBranchResolver: runBranchResolver,
    loadCustomParamFnHook: loadCustomParamFnHook,
    applyCustomParamOverrides: applyCustomParamOverrides,
    createScm: _scmModule ? _scmModule.createScm : function() { throw new Error('scm.js not available in this environment'); }
};
