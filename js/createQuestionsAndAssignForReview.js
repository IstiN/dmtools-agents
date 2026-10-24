/**
 * Create Questions and Assign For Review Post-Action
 * Reads AI-generated outputs/questions.json, creates question subtasks in Jira,
 * labels the parent ticket, and assigns it for review.
 *
 * questions.json format:
 * [
 *   {
 *     "summary": "Clarify requirements",          // [Q] prefix added automatically if missing
 *     "priority": "High",
 *     "description": "outputs/questions/question-1.md",
 *     "answer": "..."                              // optional, pre-filled answer
 *   }
 * ]
 */

const { extractTicketKey } = require('./common/jiraHelpers.js');
const { buildSummary } = require('./common/aiResponseParser.js');
const configLoader = require('./configLoader.js');
const scmModule = require('./common/scm.js');
const autoStart = require('./common/autoStart.js');
const tokenUsageComment = require('./common/tokenUsageComment.js');
const outputFiles = require('./common/outputFiles.js');

// Tracker-agnostic ticket operations (jira / ado / github) — created lazily per action() run.
var trackersModule = require('./common/trackers.js');
var lazyTracker = require('./common/lazyTracker.js').createLazyTracker(trackersModule);
var initTracker = lazyTracker.initTracker;
var getTracker = lazyTracker.getTracker;

/**
 * Ensure summary starts with [Q] prefix
 */
function ensureQPrefix(summary) {
    if (!summary || summary.indexOf('[Q]') === 0) {
        return summary;
    }
    return '[Q] ' + summary;
}

// ── Pure decision/build helpers extracted from action() (gh-1038) ────────────
// No tracker/SCM/file side effects — kept separate so action()'s complexity
// drops and each decision can be unit-tested directly.

/**
 * WIP label for the workflow context, or null when no contextId is set.
 */
function buildWipLabel(metadata) {
    return metadata && metadata.contextId
        ? metadata.contextId + '_wip'
        : null;
}

/**
 * Agent id from the job metadata, defaulting to the story_questions workflow.
 */
function resolveAgentId(metadata) {
    return (metadata && metadata.agentId) || 'story_questions';
}

/**
 * Effective customParams: jobParams.customParams wins over params.customParams.
 */
function resolveActionCustomParams(params) {
    return (params.jobParams && params.jobParams.customParams) || params.customParams || {};
}

/**
 * Priority-name mapping: customParams > jobParamPatches[agentId] > project config.
 * @returns {Object|null} The resolved map, or null when none is configured.
 */
function resolvePriorityMap(customParams, projectConfig, agentId) {
    var jobParamPatch = projectConfig.jobParamPatches && projectConfig.jobParamPatches[agentId];
    return customParams.priorityMap
        || (jobParamPatch && jobParamPatch.customParams && jobParamPatch.customParams.priorityMap)
        || projectConfig.priorityMap
        || null;
}

/**
 * autoStartQuestionAnswer accepts both boolean true and the string 'true'.
 */
function shouldAutoStartQuestionAnswer(customParams) {
    return customParams.autoStartQuestionAnswer === true ||
        customParams.autoStartQuestionAnswer === 'true';
}

/**
 * Result message for the fatal CLI/provider error path.
 */
function buildCliFailureResult(cliErrorMessage) {
    return {
        success: false,
        error: 'CLI/provider failure: ' + cliErrorMessage,
        createdQuestions: []
    };
}

/**
 * Success-path result message, honest about the stage transition outcome.
 */
function buildActionMessage(ticketKey, stageOutcome, createdCount) {
    return stageOutcome === 'moved'
        ? 'Ticket ' + ticketKey + ' moved to PO Review, created ' + createdCount + ' question subtask(s)'
        : stageOutcome === 'marked'
            ? 'Ticket ' + ticketKey + ' marked stage PO Review (transition rejected), created ' + createdCount + ' question subtask(s)'
            : 'Ticket ' + ticketKey + ' NOT moved to PO Review (transition failed), created ' + createdCount + ' question subtask(s)';
}

/**
 * Per-question entry of the createdQuestions result list.
 */
function buildCreatedTicketReport(entry, key) {
    return {
        summary: ensureQPrefix(entry.summary || ''),
        priority: entry.priority,
        key: key,
        success: !!key
    };
}

/**
 * The Jira Server/DC assign failure mentions 'accountId' — those instances
 * want a silent skip instead of a noisy warning.
 */
function isAccountIdUnsupportedError(assignError) {
    var assignMsg = String(assignError && (assignError.message || assignError));
    return assignMsg.indexOf('accountId') !== -1;
}

/**
 * Read and parse outputs/questions.json
 * @returns {Array} Array of question entries, or empty array on error
 */
function readQuestionsJson() {
    try {
        var raw = file_read('outputs/questions.json');
        if (!raw || raw.trim() === '') {
            console.warn('outputs/questions.json is empty');
            return [];
        }
        var parsed = JSON.parse(raw);
        // Handle both plain array [...] and wrapped {"questions": [...]} formats
        if (!Array.isArray(parsed)) {
            if (parsed && Array.isArray(parsed.questions)) {
                console.warn('outputs/questions.json was wrapped in {"questions":[...]} — using inner array. Agent should write a plain JSON array.');
                return parsed.questions;
            }
            console.warn('outputs/questions.json is not an array');
            return [];
        }
        return parsed;
    } catch (error) {
        console.error('Failed to read/parse outputs/questions.json:', error);
        return [];
    }
}

/**
 * When the agent decides no clarifying questions are needed, it must still
 * explain why in outputs/response.md. Post that explanation as a Jira comment
 * so a human reviewer sees the reasoning instead of a silent skip.
 * If the agent did NOT write a response.md, post a visible warning instead of
 * silently moving the ticket forward with zero explanation.
 */
function postNoQuestionsExplanation(ticketKey) {
    var explanation = outputFiles.readOutputFile('response.md', { ticketKey: ticketKey });
    if (explanation && explanation.trim()) {
        try {
            getTracker().postComment(ticketKey, 'h3. \u2139\ufe0f No clarifying questions needed\n\n' + explanation.trim());
            console.log('Posted no-questions explanation from outputs/response.md');
        } catch (e) {
            console.warn('Failed to post no-questions explanation comment:', e);
        }
        return;
    }

    console.warn('No questions were raised AND outputs/response.md is missing/empty — posting fallback warning comment.');
    try {
        getTracker().postComment(ticketKey, 'h3. \u26a0\ufe0f No clarifying questions raised \u2014 no explanation provided\n\n' +
                'The AI agent did not create any clarifying questions for this ticket, and did not write ' +
                '{{outputs/response.md}} explaining why. Please verify manually whether the story is actually ' +
                'clear enough to proceed, or re-run the agent.');
    } catch (e) {
        console.warn('Failed to post fallback no-questions warning comment:', e);
    }
}

/**
 * Priority-name mapping for one question: the project-mapped name or the
 * agent's original name when unmapped.
 */
function resolveQuestionPriority(priorityMap, priorityName) {
    return (priorityMap && priorityMap[priorityName]) || priorityName;
}

/**
 * The Jira-shaped fieldsJson for one question subtask. Reads the required
 * config members eagerly (issuetype, label, answer field) — a broken config
 * throws before any tracker call, exactly as before the extraction.
 */
function buildQuestionFieldsJson(entry, summary, description, parentKey, jiraConfig, priorityMap) {
    var questionIssueType = jiraConfig.issueTypes.SUBTASK;
    var questionLabel = jiraConfig.labels.QUESTION;
    var answerField = jiraConfig.questions.answerField;

    var fieldsJson = {
        summary: summary,
        description: description,
        issuetype: { name: questionIssueType },
        parent: { key: parentKey },
        labels: [questionLabel]
    };

    if (entry.priority) {
        fieldsJson.priority = { name: resolveQuestionPriority(priorityMap, entry.priority) };
    }

    if (entry.answer) {
        fieldsJson[answerField] = entry.answer;
    }

    return fieldsJson;
}

/**
 * The ADO work-item type for question subtasks (jira.questions.workItemType,
 * default 'Task' — the child type of a PBI/Bug in the standard ADO processes).
 */
function resolveAdoQuestionType(jiraConfig) {
    return (jiraConfig.questions && jiraConfig.questions.workItemType) || 'Task';
}

/**
 * A string create result is the key itself; anything else goes through
 * extractTicketKey (null when unparseable).
 */
function normalizeCreatedKey(result) {
    return (typeof result === 'string' && result) ? result : extractTicketKey(result);
}

/**
 * ADO question creation (agents#870): the Jira-shaped fieldsJson cannot be sent
 * there — create the work item, link it to its parent, label it and set the
 * priority (non-fatal) through the tracker instead.
 */
function createAdoQuestion(tracker, projectKey, entry, summary, description, parentKey, questionLabel, priorityMap, adoType) {
    var result = tracker.createTicketWithParent(projectKey, adoType, summary, description, parentKey, { labels: [questionLabel] });
    if (result && entry.priority) {
        try {
            tracker.setPriority(result, resolveQuestionPriority(priorityMap, entry.priority));
        } catch (priorityError) {
            console.warn('Could not set priority on question ' + result + ' (non-fatal):', priorityError);
        }
    }
    return result;
}

/**
 * Create a single question subtask in Jira
 * @param {Object} entry - Entry from questions.json
 * @param {string} parentKey - Parent story ticket key
 * @param {string} projectKey - Jira project key
 * @param {Object} jiraConfig - Resolved jira config (issueTypes, labels, questions)
 * @param {Object} [priorityMap] - Optional mapping of agent priority names to project-specific names
 * @returns {string|null} Created ticket key or null on failure
 */
function createQuestion(entry, parentKey, projectKey, jiraConfig, priorityMap) {
    var summary = ensureQPrefix(buildSummary(entry.summary, 0));
    var description = outputFiles.readDescriptionFile(entry.description, entry.summary);
    var fieldsJson = buildQuestionFieldsJson(entry, summary, description, parentKey, jiraConfig, priorityMap);

    try {
        var tracker = getTracker();
        var result;
        if (tracker.provider() === 'ado') {
            result = createAdoQuestion(tracker, projectKey, entry, summary, description, parentKey,
                jiraConfig.labels.QUESTION, priorityMap, resolveAdoQuestionType(jiraConfig));
        } else {
            result = tracker.createTicketWithFields(projectKey, fieldsJson);
        }
        var key = normalizeCreatedKey(result);
        console.log('Created question subtask ' + (key || '(unknown key)') + ': ' + summary);
        return key;
    } catch (error) {
        console.error('Failed to create question subtask "' + summary + '":', error);
        return null;
    }
}

function loadConfigSafe(params) {
    try { return configLoader.loadProjectConfig(params); } catch (e) { return null; }
}

/**
 * customParams bootstrap for the pre-config tracker init: jobParams.customParams
 * or an empty object (deliberately NOT params.customParams — see action()).
 */
function bootstrapCustomParams(params) {
    return (params.jobParams && params.jobParams.customParams) || {};
}

/**
 * Fatal CLI/provider path (see action()): announce the failure on the ticket and
 * return the failure result WITHOUT touching labels, assignee or stage.
 */
function handleFatalCliError(ticketKey, params) {
    var cliErrorMessage = params.currentCliErrorMessage || 'unknown CLI/provider error';
    console.error('Fatal CLI/provider error for ' + ticketKey + ' — leaving the ticket untouched instead of treating it as "no questions needed": ' + cliErrorMessage);
    try {
        getTracker().postComment(ticketKey, 'h3. \u274c AI agent run failed \u2014 ticket left unchanged\n\n' +
                'The underlying CLI/AI provider call failed, so no clarifying questions could be generated:\n\n' +
                '{code}' + cliErrorMessage + '{code}\n\n' +
                'This ticket was NOT moved to PO Review and no labels were changed. Please retry the agent.');
    } catch (commentError) {
        console.warn('Failed to post CLI-failure comment:', commentError);
    }
    return buildCliFailureResult(cliErrorMessage);
}

/**
 * Create one subtask per question entry and collect the createdQuestions report.
 */
function createQuestionSubtasks(questions, ticketKey, projectKey, jiraConfig, priorityMap) {
    var createdTickets = [];
    questions.forEach(function (entry) {
        var key = createQuestion(entry, ticketKey, projectKey, jiraConfig, priorityMap);
        createdTickets.push(buildCreatedTicketReport(entry, key));
    });
    return createdTickets;
}

/**
 * Any failed question subtask fails the whole job (checked after the loop, so
 * every question gets its attempt and the errors are logged above).
 */
function assertAllQuestionsCreated(createdTickets, ticketKey) {
    var failedCount = createdTickets.filter(function (t) { return !t.success; }).length;
    if (failedCount > 0) {
        throw new Error(
            'Failed to create ' + failedCount + ' of ' + createdTickets.length +
            ' question subtask(s) under ' + ticketKey +
            ' — check the errors logged above for details'
        );
    }
}

/**
 * Steps 3+4: the parent labels (non-fatal individually).
 */
function addParentLabels(ticketKey, labels) {
    try {
        getTracker().addLabel(ticketKey, labels.AI_QUESTIONS_ASKED);
    } catch (labelError) {
        console.warn('Failed to add ' + labels.AI_QUESTIONS_ASKED + ' label:', labelError);
    }

    try {
        getTracker().addLabel(ticketKey, labels.AI_GENERATED);
    } catch (labelError) {
        console.warn('Failed to add ' + labels.AI_GENERATED + ' label:', labelError);
    }
}

/**
 * Step 5: assign the parent to the initiator (non-fatal; the Server/DC
 * accountId limitation is silently skipped).
 */
function assignToInitiator(ticketKey, initiatorId) {
    try {
        if (initiatorId) {
            getTracker().assignTo(ticketKey, initiatorId);
            console.log('Assigned ' + ticketKey + ' to initiator');
        } else {
            console.log('No initiator id — skipping assign');
        }
    } catch (assignError) {
        if (isAccountIdUnsupportedError(assignError)) {
            console.warn('Skipping assign — accountId not supported in this Jira instance (Server/DC uses username)');
        } else {
            console.warn('Failed to assign ticket:', assignError);
        }
    }
}

/**
 * Step 6: move the parent story to PO Review.
 * @returns {string} 'moved' | 'marked' | 'failed' — reported honestly in the result message
 */
function moveToPoReview(ticketKey, poReviewStatus) {
    try {
        var stageResult = getTracker().moveToStatusOrMark(ticketKey, poReviewStatus, 'PO_REVIEW');
        if (stageResult && stageResult.marked) {
            console.log('Marked ' + ticketKey + ' with ' + stageResult.label + ' (transition to PO Review rejected)');
            return 'marked';
        }
        console.log('Moved ' + ticketKey + ' to PO Review');
        return 'moved';
    } catch (statusError) {
        console.warn('Failed to move ' + ticketKey + ' to PO Review:', statusError);
        return 'failed';
    }
}

/**
 * Step 7: remove the WIP label when present (non-fatal).
 */
function removeWipLabel(ticketKey, wipLabel) {
    if (!wipLabel) {
        return;
    }
    try {
        getTracker().removeLabel(ticketKey, wipLabel);
        console.log('Removed WIP label "' + wipLabel + '" from ' + ticketKey);
    } catch (wipError) {
        console.warn('Failed to remove WIP label:', wipError);
    }
}

/**
 * Step 8: optionally auto-start question answering for each created question.
 * Requires BOTH autoStartQuestionAnswer and autoStartQuestionAnswerConfigFile.
 */
function triggerAutoStartQuestionAnswer(customParams, projectConfig, createdTickets) {
    if (!shouldAutoStartQuestionAnswer(customParams)) {
        return;
    }
    var questionAnswerConfigFile = customParams.autoStartQuestionAnswerConfigFile;
    if (!questionAnswerConfigFile) {
        return;
    }
    try {
        var scm = scmModule.createScm(projectConfig);
        createdTickets
            .filter(function (ticket) { return ticket.success && ticket.key; })
            .forEach(function (ticket) {
                autoStart.triggerConfiguredWorkflowForTicket({
                    scm: scm,
                    config: projectConfig,
                    ticketKey: ticket.key,
                    customParams: customParams,
                    configFile: questionAnswerConfigFile,
                    label: 'question answer',
                    stripKeys: ['autoStartQuestionAnswer', 'autoStartQuestionAnswerConfigFile']
                });
            });
    } catch (e) {
        console.warn('⚠️ autoStartQuestionAnswer trigger failed:', e.message || e);
    }
}

function action(params) {
    try {
        var ticketKey = params.ticket.key;
        var projectKey = ticketKey.split('-')[0];
        initTracker(loadConfigSafe(params), bootstrapCustomParams(params));
        var initiatorId = params.initiator;
        var wipLabel = buildWipLabel(params.metadata);

        // The CLI/AI-provider call can fail (missing binary, provider outage, HTTP 5xx, ...)
        // while outputType is 'none' and skipAIProcessing is true — in that setup Teammate's
        // own "skip field update, post error comment" safety net never runs (it's gated behind
        // outputType != none), so this is the only place left to detect the failure. Do NOT
        // let a fatal CLI error fall through to the "0 questions were raised" path below: that
        // path unconditionally labels, assigns and moves the ticket to PO Review as if the AI
        // had genuinely reviewed the story and found it clear, which silently hides the failure.
        if (params.currentCliHasFatalError) {
            return handleFatalCliError(ticketKey, params);
        }

        var projectConfig = configLoader.loadProjectConfig(params.jobParams || params);
        var jiraConfig = projectConfig.jira;
        var labels = projectConfig.labels;
        var customParams = resolveActionCustomParams(params);
        initTracker(projectConfig, customParams);
        var agentId = resolveAgentId(params.metadata);
        var priorityMap = resolvePriorityMap(customParams, projectConfig, agentId);

        console.log('Processing question creation for:', ticketKey);
        if (priorityMap) console.log('Priority map active:', JSON.stringify(priorityMap));

        // 1. Read questions.json
        var questions = readQuestionsJson();
        console.log('Found ' + questions.length + ' entries in questions.json');

        if (questions.length === 0) {
            console.log('No questions to create — skipping ticket creation.');
            postNoQuestionsExplanation(ticketKey);
        }

        // 2. Create question subtasks
        var createdTickets = createQuestionSubtasks(questions, ticketKey, projectKey,
            Object.assign({}, jiraConfig, { labels: labels }), priorityMap);
        assertAllQuestionsCreated(createdTickets, ticketKey);

        // 3-8. Parent labels, initiator assignment, PO Review stage, WIP cleanup,
        //      optional question-answer auto-start, token usage comments.
        addParentLabels(ticketKey, labels);
        assignToInitiator(ticketKey, initiatorId);
        var stageOutcome = moveToPoReview(ticketKey, jiraConfig.statuses.PO_REVIEW);
        removeWipLabel(ticketKey, wipLabel);
        triggerAutoStartQuestionAnswer(customParams, projectConfig, createdTickets);
        tokenUsageComment.postTokenUsageCommentsSafe(ticketKey, params);

        return {
            success: true,
            message: buildActionMessage(ticketKey, stageOutcome, createdTickets.length),
            stageStatus: stageOutcome,
            createdQuestions: createdTickets
        };

    } catch (error) {
        console.error('Error in createQuestionsAndAssignForReview:', error);
        throw error;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        action: action,
        buildWipLabel: buildWipLabel,
        resolveAgentId: resolveAgentId,
        resolveActionCustomParams: resolveActionCustomParams,
        resolvePriorityMap: resolvePriorityMap,
        shouldAutoStartQuestionAnswer: shouldAutoStartQuestionAnswer,
        buildCliFailureResult: buildCliFailureResult,
        buildActionMessage: buildActionMessage,
        buildCreatedTicketReport: buildCreatedTicketReport,
        isAccountIdUnsupportedError: isAccountIdUnsupportedError,
        bootstrapCustomParams: bootstrapCustomParams,
        handleFatalCliError: handleFatalCliError,
        createQuestionSubtasks: createQuestionSubtasks,
        assertAllQuestionsCreated: assertAllQuestionsCreated,
        addParentLabels: addParentLabels,
        assignToInitiator: assignToInitiator,
        moveToPoReview: moveToPoReview,
        removeWipLabel: removeWipLabel,
        triggerAutoStartQuestionAnswer: triggerAutoStartQuestionAnswer,
        resolveQuestionPriority: resolveQuestionPriority,
        buildQuestionFieldsJson: buildQuestionFieldsJson,
        resolveAdoQuestionType: resolveAdoQuestionType,
        normalizeCreatedKey: normalizeCreatedKey,
        createAdoQuestion: createAdoQuestion
    };
}
