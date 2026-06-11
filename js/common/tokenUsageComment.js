/**
 * Token usage comment helper.
 *
 * Reads provider usage JSON files written by run-agent.sh (e.g. outputs/kimi_usage.json)
 * and posts them as Jira comments in the form:
 *
 *   [kimi_usage]: {"provider":"kimi","total_tokens":12345,...}
 *
 * The helper is provider-agnostic: any file matching outputs/*_usage.json is picked up.
 */

const fs = require('fs');
const path = require('path');

const OUTPUTS_DIR = 'outputs';
const USAGE_GLOB = '*_usage.json';

function findUsageFiles(outputsDir) {
    try {
        return fs.readdirSync(outputsDir)
            .filter(function(name) { return name.endsWith('_usage.json'); })
            .map(function(name) { return path.join(outputsDir, name); });
    } catch (e) {
        return [];
    }
}

function readJsonSafe(filePath) {
    try {
        var raw = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(raw);
    } catch (e) {
        console.warn('Failed to read/parse usage file ' + filePath + ': ' + (e.message || e));
        return null;
    }
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

function formatUsageComment(filePath, data, initiator) {
    var baseName = path.basename(filePath, '.json');
    // Strip the _usage suffix so the comment label matches the agent name
    // (e.g. outputs/story_acceptance_criteria_usage.json -> [story_acceptance_criteria]: {...})
    var label = baseName.replace(/_usage$/, '');
    var comment = '[' + label + ']: ' + JSON.stringify(data);
    var mention = formatJiraMention(initiator);
    if (mention) {
        comment += '\nInitiator: ' + mention;
    }
    return comment;
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
        var data = readJsonSafe(filePath);
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

module.exports = {
    postTokenUsageComments: postTokenUsageComments,
    findUsageFiles: findUsageFiles,
    formatUsageComment: formatUsageComment
};
