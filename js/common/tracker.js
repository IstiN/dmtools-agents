/**
 * Task Tracker abstraction for operations that have no server-side tracker_* alias.
 *
 * Operations with server-side aliases (tracker_move_to_status, tracker_post_comment,
 * tracker_get_ticket, tracker_search, tracker_assign_ticket, tracker_get_comments,
 * tracker_create_ticket, tracker_link_tickets, tracker_get_my_profile) should be
 * called directly — the server routes them to the active tracker backend.
 *
 * This module covers: addLabel, removeLabel, setPriority, updateField, attachFile.
 *
 * Supported trackers: 'jira', 'jira_xray', 'ado'
 * NOT YET supported: 'rally' — Rally has no tracker_* server aliases and no rally_*
 *   MCP tools documented for label/priority/field operations. Calls log a warning and
 *   no-op rather than crash.
 *
 * Tracker selection: reads DEFAULT_TRACKER env var (set by dmtools runtime),
 * falls back to config.defaultTracker, then defaults to 'jira'.
 */

function _getTrackerType(config) {
    var trackerType = null;
    try {
        trackerType = java.lang.System.getenv('DEFAULT_TRACKER');
    } catch (e) {
        // Not running in GraalJS — ignore
    }
    if (!trackerType && config && config.defaultTracker) {
        trackerType = config.defaultTracker;
    }
    return (trackerType || 'jira').toLowerCase();
}

function _warnUnsupported(tracker, operation, key) {
    console.warn('tracker: "' + operation + '" is not implemented for tracker "' + tracker +
        '" (key=' + key + '). Skipping.');
}

// ── ADO helpers ───────────────────────────────────────────────────────────────

function _adoGetTags(key) {
    try {
        var raw = ado_get_work_item({ id: parseInt(key, 10) });
        var wi = typeof raw === 'string' ? JSON.parse(raw) : raw;
        var tagStr = wi && wi.fields && wi.fields['System.Tags'];
        return tagStr ? tagStr.split(';').map(function(t) { return t.trim(); }).filter(Boolean) : [];
    } catch (e) {
        console.warn('tracker: Failed to read ADO work item tags for ' + key + ':', e);
        return [];
    }
}

function _adoSetTags(key, tags) {
    ado_update_work_item({
        id: parseInt(key, 10),
        data: JSON.stringify({ 'System.Tags': tags.join('; ') })
    });
}

// ── Exported API ─────────────────────────────────────────────────────────────

/**
 * Add a label/tag to a ticket.
 * @param {string} key      - Ticket key (Jira) or work item ID (ADO)
 * @param {string} label    - Label or tag name
 * @param {Object} [config] - Optional project config (for defaultTracker fallback)
 */
function addLabel(key, label, config) {
    var tt = _getTrackerType(config);
    if (tt === 'jira' || tt === 'jira_xray') {
        jira_add_label({ key: key, label: label });
    } else if (tt === 'ado') {
        var tags = _adoGetTags(key);
        if (tags.indexOf(label) === -1) {
            tags.push(label);
            _adoSetTags(key, tags);
        }
    } else {
        _warnUnsupported(tt, 'addLabel', key);
    }
}

/**
 * Remove a label/tag from a ticket.
 * @param {string} key      - Ticket key (Jira) or work item ID (ADO)
 * @param {string} label    - Label or tag name
 * @param {Object} [config] - Optional project config (for defaultTracker fallback)
 */
function removeLabel(key, label, config) {
    var tt = _getTrackerType(config);
    if (tt === 'jira' || tt === 'jira_xray') {
        jira_remove_label({ key: key, label: label });
    } else if (tt === 'ado') {
        var tags = _adoGetTags(key);
        var filtered = tags.filter(function(t) { return t !== label; });
        if (filtered.length !== tags.length) {
            _adoSetTags(key, filtered);
        }
    } else {
        _warnUnsupported(tt, 'removeLabel', key);
    }
}

/**
 * Set priority on a ticket.
 * @param {string} key      - Ticket key or work item ID
 * @param {string} priority - Priority name (e.g. 'High', 'Medium', 'Low')
 * @param {Object} [config] - Optional project config
 */
function setPriority(key, priority, config) {
    var tt = _getTrackerType(config);
    if (tt === 'jira' || tt === 'jira_xray') {
        jira_set_priority({ key: key, priority: priority });
    } else if (tt === 'ado') {
        var priorityMap = { Highest: 1, High: 2, Medium: 3, Low: 4, Lowest: 4 };
        var adoPriority = priorityMap[priority] !== undefined ? priorityMap[priority] : 3;
        ado_update_work_item({
            id: parseInt(key, 10),
            data: JSON.stringify({ 'Microsoft.VSTS.Common.Priority': adoPriority })
        });
    } else {
        _warnUnsupported(tt, 'setPriority', key);
    }
}

/**
 * Update a named field on a ticket.
 * @param {string} key      - Ticket key or work item ID
 * @param {string} field    - Field name (Jira field name; ADO uses System.* naming)
 * @param {*}      value    - New value
 * @param {Object} [config] - Optional project config
 */
function updateField(key, field, value, config) {
    var tt = _getTrackerType(config);
    if (tt === 'jira' || tt === 'jira_xray') {
        jira_update_field({ key: key, field: field, value: value });
    } else if (tt === 'ado') {
        var adoFieldMap = {
            summary: 'System.Title',
            description: 'System.Description',
            priority: 'Microsoft.VSTS.Common.Priority',
            storyPoints: 'Microsoft.VSTS.Scheduling.StoryPoints'
        };
        var adoField = adoFieldMap[field] || field;
        var data = {};
        data[adoField] = value;
        ado_update_work_item({ id: parseInt(key, 10), data: JSON.stringify(data) });
    } else {
        _warnUnsupported(tt, 'updateField', key);
    }
}

/**
 * Attach a file to a ticket.
 * @param {string} key         - Ticket key or work item ID
 * @param {string} name        - Attachment file name
 * @param {string} filePath    - Local file path
 * @param {string} contentType - MIME type
 * @param {Object} [config]    - Optional project config
 */
function attachFile(key, name, filePath, contentType, config) {
    var tt = _getTrackerType(config);
    if (tt === 'jira' || tt === 'jira_xray') {
        jira_attach_file_to_ticket({
            ticketKey: key,
            name: name,
            filePath: filePath,
            contentType: contentType || 'application/octet-stream'
        });
    } else if (tt === 'ado') {
        ado_add_attachment({ id: parseInt(key, 10), filePath: filePath, fileName: name });
    } else {
        _warnUnsupported(tt, 'attachFile', key);
    }
}

module.exports = {
    addLabel: addLabel,
    removeLabel: removeLabel,
    setPriority: setPriority,
    updateField: updateField,
    attachFile: attachFile
};
