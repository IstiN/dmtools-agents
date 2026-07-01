/**
 * Resolve Target Repository From Ticket — preJSAction
 *
 * Resolves which repository a ticket targets and writes it into
 * params.customParams.targetRepository so that configLoader and
 * preCliDevelopmentSetup pick up the correct repo, branch, and workingDir.
 *
 * Strategy (customParams.repoNameStrategy, default: 'fromSummary'):
 *   fromSummary — parses the leading [bracket-tag] from ticket summary, e.g.
 *                 "[gens-igt] Create PacBio WF" → "gens-igt"
 *
 * Additional strategies can be registered in STRATEGIES by extending this file
 * in the future (e.g. fromLabel, fromCustomField).
 *
 * Repository metadata (branch, owner/group) is looked up via
 * customParams.repositoriesFile (default: '.dmtools/repositories.json').
 * The file may store repos as:
 *   { "repositories": { "group": [{repo, branch, gitlabGroup, ...}] } }  — grouped
 *   { "repositories": [{repo, branch, ...}] }                            — flat array
 *   [{repo, branch, ...}]                                                 — bare array
 *
 * If the repo is not found in the file the action still succeeds — only repoName
 * is forwarded and the caller (configLoader) will use project defaults for the rest.
 */

// ─── Strategy registry ───────────────────────────────────────────────────────

/**
 * Strategy: extract repo name from the first [bracket-tag] in ticket summary.
 * e.g. "[my-repo] Story summary text" → "my-repo"
 *
 * @param {Object} ticket
 * @returns {string|null}
 */
function strategyFromSummary(ticket) {
    var summary = ticket && ticket.fields && ticket.fields.summary
        ? ticket.fields.summary.toString()
        : '';
    var bracketEnd = summary.indexOf(']');
    if (summary.charAt(0) !== '[' || bracketEnd === -1) return null;
    var name = summary.substring(1, bracketEnd).trim();
    return name || null;
}

/**
 * Public strategy map.  Keys are valid values for customParams.repoNameStrategy.
 * Add new strategies here — they become available automatically.
 */
var STRATEGIES = {
    fromSummary: strategyFromSummary
};

// ─── Repository file lookup ───────────────────────────────────────────────────

function readRepoFile(filePath) {
    var raw = null;
    try {
        raw = file_read({ path: filePath });
    } catch (e) {
        console.warn('resolveRepoFromTicket: could not read "' + filePath + '":', e);
        return null;
    }
    if (!raw) return null;
    try {
        return JSON.parse(raw);
    } catch (e) {
        console.warn('resolveRepoFromTicket: invalid JSON in "' + filePath + '"');
        return null;
    }
}

function findInArray(arr, repoName) {
    for (var i = 0; i < arr.length; i++) {
        if (arr[i] && arr[i].repo === repoName) return arr[i];
    }
    return null;
}

/**
 * Find a single repository entry by name from the repositories file.
 *
 * @param {string} repoName
 * @param {string} [repositoriesFile]
 * @returns {Object|null}
 */
function findRepoEntry(repoName, repositoriesFile) {
    var filePath = repositoriesFile || '.dmtools/repositories.json';
    var data = readRepoFile(filePath);
    if (!data) return null;

    // Support bare array at root
    if (Array.isArray(data)) return findInArray(data, repoName);

    var repos = data.repositories || data;

    // Flat array
    if (Array.isArray(repos)) return findInArray(repos, repoName);

    // Grouped object: { "group-name": [...], ... }
    if (typeof repos === 'object') {
        var groups = Object.keys(repos);
        for (var i = 0; i < groups.length; i++) {
            var arr = repos[groups[i]];
            if (Array.isArray(arr)) {
                var found = findInArray(arr, repoName);
                if (found) return found;
            }
        }
    }
    return null;
}

// ─── Main action ─────────────────────────────────────────────────────────────

function action(params) {
    var ticket = params.ticket;
    if (!ticket) {
        console.warn('resolveRepoFromTicket: no ticket in params — skipping repo resolution');
        return true;
    }

    var customParams = params.customParams
        || (params.jobParams && params.jobParams.customParams)
        || {};

    var strategyName = customParams.repoNameStrategy || 'fromSummary';
    var strategy = STRATEGIES[strategyName];
    if (!strategy) {
        console.warn('resolveRepoFromTicket: unknown strategy "' + strategyName +
            '" — available: ' + Object.keys(STRATEGIES).join(', ') + '. Skipping.');
        return true;
    }

    var repoName = strategy(ticket, customParams);
    if (!repoName) {
        console.warn('resolveRepoFromTicket: strategy "' + strategyName +
            '" could not resolve repo name from ticket ' + ticket.key + ' — skipping.');
        return true;
    }

    console.log('resolveRepoFromTicket: resolved repo "' + repoName +
        '" from ticket ' + ticket.key + ' via strategy "' + strategyName + '"');

    var entry = findRepoEntry(repoName, customParams.repositoriesFile);
    var targetRepository = { repo: repoName };

    if (entry) {
        if (entry.branch)       targetRepository.baseBranch = entry.branch;
        if (entry.gitlabGroup)  targetRepository.owner      = entry.gitlabGroup;
        if (entry.workingDir)   targetRepository.workingDir = entry.workingDir;
        console.log('resolveRepoFromTicket: repo entry found — branch=' +
            (entry.branch || 'n/a') + ', owner=' + (entry.gitlabGroup || 'n/a'));
    } else {
        console.warn('resolveRepoFromTicket: repo "' + repoName +
            '" not found in repositories file — forwarding repoName only');
    }

    // Mutate params so configLoader and preCliDevelopmentSetup pick it up downstream
    if (!params.customParams) params.customParams = {};
    params.customParams.targetRepository = targetRepository;

    return true;
}

if (typeof module !== 'undefined') {
    module.exports = { action: action, STRATEGIES: STRATEGIES, findRepoEntry: findRepoEntry };
}
