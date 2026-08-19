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

function formatUsageComment(filePath, data, initiator) {
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
    var comment = '[' + label + ']: ' + JSON.stringify(data);
    var mention = formatJiraMention(initiator);
    if (mention) {
        comment += '\nInitiator: ' + mention;
    }
    return avoidBridgeArrayMisparse(comment);
}

/**
 * Post token usage comments for the given ticket.
 *
 * @param {string} ticketKey - Jira ticket key to comment on.
 * @param {object} options - Optional settings.
 * @param {string} options.outputsDir - Directory to scan for *_usage.json files (default: outputs).
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

        var comment = formatUsageComment(filePath, data, initiator);
        try {
            jira_post_comment({ key: ticketKey, comment: comment });
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

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        postTokenUsageComments: postTokenUsageComments,
        findUsageFiles: findUsageFiles,
        formatUsageComment: formatUsageComment,
        avoidBridgeArrayMisparse: avoidBridgeArrayMisparse
    };
}
