/**
 * Fetch Questions To Input Pre-CLI Action
 * Fetches existing question subtasks for the current story ticket and writes
 * them to the input folder before the CLI agent runs.
 * Receives params.inputFolderPath from DMTools after input folder creation.
 *
 * Tracker-aware (gh-770): the provider is probed via common/trackers.js and
 * the JQL is only fired on Jira — question subtasks (issuetype + answer
 * custom field) are a Jira concept, and the JQL is meaningless on GitHub/ADO
 * trackers, where it silently returned empty on every dev/rework leg.
 *
 * Configurable via .dmtools/config.js:
 *   jira.questions.fetchJql   — JQL to find question subtasks ({ticketKey} placeholder)
 *   jira.questions.answerField — Jira custom field name for the answer (default: 'Answer')
 */

var configLoader = require('./configLoader.js');
var trackersModule = require('./common/trackers.js');
// Load-time require (gh-823): a deferred require would resolve against the
// pack js/ root only — hoist every require to the top of the module.
var fetchParentContextToInput = require('./fetchParentContextToInput.js');

function hasAnswerValue(fields, key) {
    return Object.prototype.hasOwnProperty.call(fields, key)
        && fields[key] !== undefined
        && fields[key] !== null;
}

/**
 * The direct lookups: the answer field as configured, then lower-cased.
 * @returns {Object|undefined} the stored value, or undefined when neither key holds one
 */
function directAnswerValue(fields, answerField) {
    if (hasAnswerValue(fields, answerField)) {
        return fields[answerField];
    }
    if (hasAnswerValue(fields, answerField.toLowerCase())) {
        return fields[answerField.toLowerCase()];
    }
    return undefined;
}

/**
 * The `customfield_`-prefixed answer fields match their transformed
 * `name (customfield_xxx)` key by suffix; other names by the friendly prefix.
 * The prefix probe runs on the ORIGINAL-case answer field (gh-1191 parity),
 * the suffix text itself is lower-cased.
 */
function customFieldSuffixOf(answerField, answerFieldLower) {
    return answerField.indexOf('customfield_') === 0
        ? '(' + answerFieldLower + ')'
        : null;
}

/**
 * Whether one field key is a transformed variant of the answer field:
 * case-insensitive equality, the customfield suffix, or the `name (…)` shape.
 */
function answerKeyMatches(keyLower, answerFieldLower, customFieldSuffix, friendlyPrefix) {
    if (keyLower === answerFieldLower) {
        return true;
    }
    if (customFieldSuffix && keyLower.slice(-customFieldSuffix.length) === customFieldSuffix) {
        return true;
    }
    return keyLower.indexOf(friendlyPrefix) === 0 && keyLower.slice(-1) === ')';
}

/**
 * Scan every own field key for a transformed variant of the answer field
 * (insertion order decides which one wins).
 * @returns {Object|undefined} the first stored value, or undefined when none matches
 */
function answerFromTransformedKeys(fields, answerField) {
    var answerFieldLower = answerField.toLowerCase();
    var customFieldSuffix = customFieldSuffixOf(answerField, answerFieldLower);
    var transformedFriendlyPrefix = answerFieldLower + ' (';

    for (var key in fields) {
        if (!Object.prototype.hasOwnProperty.call(fields, key)) {
            continue;
        }
        if (answerKeyMatches(key.toLowerCase(), answerFieldLower, customFieldSuffix, transformedFriendlyPrefix)
                && hasAnswerValue(fields, key)) {
            return fields[key];
        }
    }
    return undefined;
}

function getAnswerValue(fields, answerField) {
    if (!fields || !answerField) {
        return null;
    }

    var direct = directAnswerValue(fields, answerField);
    if (direct !== undefined) {
        return direct;
    }

    var transformed = answerFromTransformedKeys(fields, answerField);
    return transformed !== undefined ? transformed : null;
}

/**
 * Build the question-subtask fetch plan for the ticket's tracker (gh-770).
 *
 * The configured query (`jira.questions.fetchJql`) is Jira-speak —
 * "parent = {ticketKey} AND issuetype = Subtask" — which routes fine on a
 * GitHub-backed deployment but is meaningless there: it silently returns
 * empty and the leg logs "Failed to fetch questions, continuing without
 * file". Question subtasks (issuetype + answer custom field) are a Jira
 * concept, so the JQL is only fired on the jira provider; github/ado skip
 * with an explicit reason instead of firing a query that can never match.
 *
 * @param {string} provider        - tracker provider (createTracker().provider())
 * @param {Object} questionsConfig - config.jira.questions (fetchJql, answerField)
 * @param {string} ticketKey       - the ticket whose questions are fetched
 * @returns {Object} { skip: false, jql } | { skip: true, reason }
 */
function questionsFetchPlan(provider, questionsConfig, ticketKey) {
    var p = String(provider || 'jira').toLowerCase();
    var fetchJql = String((questionsConfig && questionsConfig.fetchJql) || '');
    if (p === 'ado' && /^\s*SELECT\b/i.test(fetchJql)) {
        // agents#871: the project supplied a WIQL query for jira.questions.fetchJql — it is native to this
        // tracker, so run it. The shipped default is Jira JQL and still takes the skip branch below.
        return {
            skip: false,
            jql: fetchJql.replace('{ticketKey}', ticketKey)
        };
    }
    if (p !== 'jira') {
        return {
            skip: true,
            reason: 'question subtasks are a Jira issue-type concept (' + fetchJql +
                ') — the query is Jira-speak and would silently return nothing on the ' +
                p + ' tracker' +
                (p === 'ado' ? '; set jira.questions.fetchJql to a WIQL query (SELECT ...) to fetch them on ADO' : '')
        };
    }
    return {
        skip: false,
        jql: questionsConfig.fetchJql.replace('{ticketKey}', ticketKey)
    };
}

var COMMENT_SENTINELS = { comment: true, comments: true, 'system.history': true };

function isCommentAnswerSentinel(answerField) {
    var norm = String(answerField || '').trim().toLowerCase();
    return Boolean(COMMENT_SENTINELS[norm]);
}

function buildQuestionSearchFields(provider, answerField) {
    if (String(provider || 'jira').toLowerCase() !== 'ado') {
        return ['key', 'summary', 'description', 'status', 'priority', answerField];
    }
    if (!answerField || isCommentAnswerSentinel(answerField)) {
        return ['key', 'summary', 'description', 'status', 'priority'];
    }
    return ['key', 'summary', 'description', 'status', 'priority', answerField];
}

function extractLatestCommentAnswer(comments) {
    var list = Array.isArray(comments) ? comments : [];
    for (var i = list.length - 1; i >= 0; i--) {
        var c = list[i];
        if (c && typeof c.body === 'string' && c.body.trim().length > 0) {
            return c.body;
        }
    }
    return null;
}

function fetchCommentAnswer(tracker, issueKey) {
    try {
        return extractLatestCommentAnswer(tracker.getComments(issueKey));
    } catch (e) {
        console.warn('Failed to fetch comments for question ' + issueKey + ':', e && e.message ? e.message : String(e));
        return null;
    }
}

function rawFieldsOf(issue) {
    var raw = issue && issue.raw;
    return raw ? raw.fields : null;
}

function resolveFieldAnswer(issue, answerField) {
    var direct = getAnswerValue(issue && issue.fields, answerField);
    return direct !== null ? direct : getAnswerValue(rawFieldsOf(issue), answerField);
}

function usesAdoCommentThread(provider, answerField) {
    return String(provider || 'jira').toLowerCase() === 'ado' && isCommentAnswerSentinel(answerField);
}

function resolveQuestionAnswer(tracker, provider, issue, answerField) {
    if (usesAdoCommentThread(provider, answerField)) {
        return fetchCommentAnswer(tracker, issue ? issue.key : '');
    }
    return resolveFieldAnswer(issue, answerField);
}

/**
 * Enrich input with parent story + [BA]/[SA]/[VD] context (non-fatal).
 *
 * gh-1112: preCliContentOutputSetup runs this step itself (fault-isolated
 * in its own chain) and suppresses this built-in call via skipParentContext
 * so the parent-context JQL is not fired twice per run.
 */
function fetchParentContextSafely(params) {
    if (params.skipParentContext) return;
    try {
        fetchParentContextToInput.action(params);
    } catch (e) {
        console.warn('fetchParentContextToInput failed (non-fatal):', e);
    }
}

function namedField(obj) {
    return obj ? obj.name : '';
}

function textOrEmpty(val) {
    return val || '';
}

function toQuestionEntry(tracker, provider, issue, answerField) {
    var f = (issue && issue.fields) || {};
    return {
        key: textOrEmpty(issue && issue.key),
        summary: textOrEmpty(f.summary),
        description: textOrEmpty(f.description),
        status: namedField(f.status),
        priority: namedField(f.priority),
        answer: resolveQuestionAnswer(tracker, provider, issue, answerField)
    };
}

function fetchAndWriteQuestions(tracker, provider, plan, answerField, folder) {
    var rawQuestions = tracker.searchIssues(plan.jql, {
        fields: buildQuestionSearchFields(provider, answerField)
    });
    var questions = [];
    for (var i = 0; i < rawQuestions.length; i++) {
        questions.push(toQuestionEntry(tracker, provider, rawQuestions[i], answerField));
    }
    console.log('Found ' + questions.length + ' question subtasks');
    // Wrap in object: file_write bridge auto-parses strings starting with '[' as ArrayList.
    file_write(folder + '/existing_questions.json', '{"questions":' + JSON.stringify(questions, null, 2) + '}');
    console.log('Wrote existing_questions.json to ' + folder);
}

/**
 * Pre-CLI action: fetch question subtasks into input folder
 *
 * @param {Object} params - Parameters from DMTools
 * @param {string} params.inputFolderPath - Path to the input folder for this run
 */
function action(params) {
    try {
        var folder = params.inputFolderPath;
        // Ticket key is always the last segment of the input folder path.
        var ticketKey = folder.split('/').pop();
        console.log('Fetching question subtasks for ' + ticketKey + '...');

        var projectConfig = configLoader.loadProjectConfig(params.jobParams || params);
        var questionsConfig = projectConfig.jira.questions;
        var answerField = questionsConfig.answerField;

        // Probe the tracker provider once (gh-770): the same script then runs
        // unchanged on Jira / ADO / GitHub deployments.
        var customParams = (params.jobParams && params.jobParams.customParams) || params.customParams || {};
        var tracker = trackersModule.createTracker(projectConfig, customParams);
        var provider = tracker.provider();
        var plan = questionsFetchPlan(provider, questionsConfig, ticketKey);

        if (plan.skip) {
            console.warn('Skipping question subtask fetch — ' + plan.reason);
        } else try {
            fetchAndWriteQuestions(tracker, provider, plan, answerField, folder);
        } catch (fetchError) {
            // gh-802 AC3c: the host console renders a raw Error object as "{}"
            // (the cause was invisible in the logs) — log the CONTENT instead.
            var fetchErrorDetail = fetchError && fetchError.message
                ? fetchError.message
                : String(fetchError);
            console.error('Failed to fetch questions, continuing without file:', fetchErrorDetail);
        }
    } catch (error) {
        console.error('Error in fetchQuestionsToInput:', error);
    }

    fetchParentContextSafely(params);
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        getAnswerValue: getAnswerValue,
        hasAnswerValue: hasAnswerValue,
        directAnswerValue: directAnswerValue,
        customFieldSuffixOf: customFieldSuffixOf,
        answerKeyMatches: answerKeyMatches,
        answerFromTransformedKeys: answerFromTransformedKeys,
        questionsFetchPlan: questionsFetchPlan,
        fetchParentContextSafely: fetchParentContextSafely,
        isCommentAnswerSentinel: isCommentAnswerSentinel,
        buildQuestionSearchFields: buildQuestionSearchFields,
        extractLatestCommentAnswer: extractLatestCommentAnswer,
        resolveQuestionAnswer: resolveQuestionAnswer
    };
}
