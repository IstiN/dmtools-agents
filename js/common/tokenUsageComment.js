/**
 * Token usage comment helper.
 *
 * Reads provider usage JSON files written by run-agent.sh (e.g. outputs/story_solution_usage.json)
 * and posts them as Jira comments in the form:
 *
 *   [story_solution]: {"provider":"kimi","total_tokens":12345,...}
 *
 * The helper is provider-agnostic. run-agent.sh records usage files in
 * outputs/token_usage_files.json; this helper reads that manifest and posts a
 * comment for every *_usage.json file it points to.
 *
 * IMPORTANT: This module runs inside the DMTools GraalJS bridge, where Node.js
 * built-ins such as `fs` are NOT available. Use the exposed `file_read` tool.
 */

var OUTPUTS_DIR = 'outputs';
var USAGE_SUFFIX = '_usage.json';
var MANIFEST_NAME = 'token_usage_files.json';

// gh-823: load-time require — a deferred (in-function) require resolves
// against the pack's js/ root only at runtime ("Failed to require module:
// ./trackers.js"); load-time requires resolve file-relative and dmtools
// compile discovers them for the pack closure.
var trackersModule = require('./trackers.js');
var configLoader = null;
try { configLoader = require('../configLoader.js'); } catch (e) { /* unit tests inject their own */ }

function readTextFile(filePath) {
    if (!filePath) {
        return null;
    }
    try {
        var content = file_read({ path: filePath });
        if (content) {
            return content.toString();
        }
    } catch (e) {
        // File missing or unreadable — treat as absent.
    }
    return null;
}

function readJsonFile(filePath) {
    var text = readTextFile(filePath);
    if (!text) {
        return null;
    }
    try {
        return JSON.parse(text);
    } catch (e) {
        console.warn('Failed to parse JSON from ' + filePath + ': ' + (e.message || e));
        return null;
    }
}

function fileNameFromPath(filePath) {
    if (!filePath) {
        return '';
    }
    var idx = filePath.lastIndexOf('/');
    return idx >= 0 ? filePath.substring(idx + 1) : filePath;
}

function findUsageFiles(outputsDir) {
    var manifestPath = outputsDir + '/' + MANIFEST_NAME;
    var manifest = readJsonFile(manifestPath);
    if (Array.isArray(manifest)) {
        return manifest.filter(function(entry) {
            return typeof entry === 'string' && entry.indexOf(USAGE_SUFFIX) !== -1;
        });
    }
    return [];
}

function formatJiraMention(notifierId) {
    if (!notifierId) {
        return '';
    }
    var id = String(notifierId);
    if (id.indexOf('~') !== -1) {
        return '[' + id + ']';
    }
    return '[~accountid:' + id + ']';
}

/**
 * Work around a bug in the DMTools GraalJS bridge (JobJavaScriptBridge):
 * any string tool argument that starts with "[" and ends with "]" gets
 * speculatively parsed as a JSON array. org.json's lenient tokenizer can
 * "succeed" on a leading fragment (e.g. an unquoted bareword) and silently
 * discard everything after the first matching "]", corrupting the rest of
 * the string before it reaches the tool. See IstiN/dmtools-agents#360.
 *
 * Our comment format ("[label]: {...}\nInitiator: [~accountid:...]") is
 * exactly this shape: it starts with "[" (the label) and ends with "]"
 * (the mention). Appending a trailing period breaks the pattern without
 * changing the meaningful content.
 */
function avoidBridgeArrayMisparse(str) {
    if (typeof str !== 'string') {
        return str;
    }
    var trimmed = str.trim();
    if (trimmed.length > 2 && trimmed.charAt(0) === '[' && trimmed.charAt(trimmed.length - 1) === ']') {
        return str + '.';
    }
    return str;
}

function formatUsageComment(filePath, data, initiator, provider) {
    var fileName = fileNameFromPath(filePath);
    // Strip the _usage suffix so the comment label matches the agent name
    // (e.g. outputs/story_acceptance_criteria_usage.json -> [story_acceptance_criteria]: {...})
    // Use string operations instead of a regex literal because the GraalJS
    // bridge in this environment does not always have the regex language enabled.
    var label = fileName;
    var suffixIndex = fileName.lastIndexOf(USAGE_SUFFIX);
    if (suffixIndex !== -1 && fileName.substring(suffixIndex) === USAGE_SUFFIX) {
        label = fileName.substring(0, suffixIndex);
    }
    if (String(provider || '').toLowerCase() === 'ado') {
        // agents#877/#878: ADO comments are posted as Markdown, where "[label]: {json}" is a link-reference
        // definition (stored but never rendered) and "[~accountid:x]" is Jira mention markup, not a mention.
        // Use a bold label + fenced json block and show the initiator as plain text. A real @-mention would
        // need the identity GUID, which the job does not have. (Jira/GitHub keep the format below.)
        var adoComment = '**' + label + '**\n```json\n' + JSON.stringify(data) + '\n```';
        if (initiator) {
            adoComment += '\nInitiator: ' + plainInitiator(initiator);
        }
        return adoComment;
    }
    var comment = '[' + label + ']: ' + JSON.stringify(data);
    var mention = formatJiraMention(initiator);
    if (mention) {
        comment += '\nInitiator: ' + mention;
    }
    return avoidBridgeArrayMisparse(comment);
}

/**
 * The initiator as plain text: an account id / email as given, with Jira mention markup removed when the
 * caller passed an already formatted "[~accountid:x]".
 */
function plainInitiator(initiator) {
    var id = String(initiator).trim();
    var prefix = '[~accountid:';
    if (id.indexOf(prefix) === 0 && id.charAt(id.length - 1) === ']') {
        return id.substring(prefix.length, id.length - 1);
    }
    if (id.charAt(0) === '[' && id.charAt(1) === '~' && id.charAt(id.length - 1) === ']') {
        return id.substring(2, id.length - 1);
    }
    return id;
}

/**
 * The customParams of a job action's params (jobParams.customParams or params.customParams), {} when
 * absent. Call sites that have no tracker object pass this so the usage comment goes through the
 * provider the run selected (customParams.trackerProvider) and not through the Jira default (agents#854).
 * @param {Object|null} params the action params
 * @returns {Object}
 */
function customParamsOf(params) {
    return (params && params.jobParams && params.jobParams.customParams) ||
        (params && params.customParams) || {};
}

/**
 * The project config used to pick the tracker provider: the caller's options.config when given;
 * otherwise, only when the provider is not already pinned by customParams.trackerProvider, the
 * project config (config.tracker.provider) loaded best-effort, so a run that sets the provider only
 * there does not fall through to the Jira default (agents#942). Fail-open: null on any problem.
 * @param {Object} options postTokenUsageComments options
 * @returns {Object|null}
 */
function resolveConfig(options) {
    if (options.config) return options.config;
    var cp = options.customParams || {};
    if (cp.trackerProvider || !configLoader || typeof configLoader.loadProjectConfig !== 'function') return null;
    try {
        return configLoader.loadProjectConfig({ customParams: cp }) || null;
    } catch (e) {
        return null;
    }
}

/**
 * The tracker for the posting loop: the caller's explicit tracker when
 * given, else one built from the resolved config + customParams (agents#854
 * — agents#942). Extracted so postTokenUsageComments reads as a loop
 * skeleton (gh-1225).
 */
function resolvePostTracker(options, tracker) {
    return tracker || trackersModule.createTracker(resolveConfig(options), options.customParams || {});
}

/**
 * Post token usage comments for the given ticket.
 *
 * @param {string} ticketKey - Jira ticket key to comment on.
 * @param {object} options - Optional settings.
 * @param {string} options.outputsDir - Directory to scan for *_usage.json files (default: outputs).
 * @param {object} options.tracker - Optional tracker (js/common/trackers.js); defaults to the provider this
 *     job run already selected (agents#854), then env/jira.
 * @param {object} [options.config] - Optional project config used to build the tracker when none is passed.
 * @param {object} [options.customParams] - Optional customParams (trackerProvider) for the same purpose.
 * @param {string} options.initiator - Optional initiator account id to mention in the comment.
 * @returns {object} Result summary { posted: number, files: string[], errors: string[] }.
 */
function postTokenUsageComments(ticketKey, options) {
    options = options || {};
    var outputsDir = options.outputsDir || OUTPUTS_DIR;
    var initiator = options.initiator || '';
    var posted = 0;
    var files = [];
    var errors = [];
    var tracker = options.tracker || null;

    var usageFiles = findUsageFiles(outputsDir);
    if (!usageFiles.length) {
        console.log('No token usage files found in ' + outputsDir);
        return { posted: 0, files: [], errors: [] };
    }

    usageFiles.forEach(function(filePath) {
        var data = readJsonFile(filePath);
        if (!data) {
            errors.push(filePath + ' (parse error)');
            return;
        }

        try {
            tracker = resolvePostTracker(options, tracker);
            var comment = formatUsageComment(filePath, data, initiator,
                typeof tracker.provider === 'function' ? tracker.provider() : null);
            tracker.postComment(ticketKey, comment);
            console.log('Posted token usage comment for ' + ticketKey + ' from ' + filePath);
            posted += 1;
            files.push(filePath);
        } catch (e) {
            var err = 'Failed to post comment from ' + filePath + ': ' + (e.message || e);
            console.warn(err);
            errors.push(err);
        }
    });

    return { posted: posted, files: files, errors: errors };
}

/**
 * gh-1246: canonical post-action wrapper for the token-usage summary step —
 * the initiator mention plus the customParams bag every post-action builds,
 * with a swallow-all guard so a provider failure never fails the action.
 */
function postUsageSummariesSafely(ticketKey, params) {
    try {
        postTokenUsageComments(ticketKey, { initiator: params.initiator, customParams: customParamsOf(params) });
    } catch (e) {
        console.warn('Failed to post token usage comments:', e);
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        postTokenUsageComments: postTokenUsageComments,
        postUsageSummariesSafely: postUsageSummariesSafely,
        resolvePostTracker: resolvePostTracker,
        customParamsOf: customParamsOf,
        findUsageFiles: findUsageFiles,
        formatUsageComment: formatUsageComment,
        avoidBridgeArrayMisparse: avoidBridgeArrayMisparse
    };
}
