/**
 * js/common/labelList.js
 *
 * Label-list normalization shared by smAgent.js (trigger labels) and
 * pushReworkChanges.js (configured removeLabels) — gh-1249 deduplicated
 * the two verbatim normalizeLabels copies into this pure leaf module.
 *
 * Pure module — no requires, no tool globals.
 */

/**
 * Merges a single optional label and an optional label array into one
 * de-duplicated list, first-seen order preserved; falsy entries drop.
 * A non-array labelList is ignored (legacy contract both copies shared).
 */
function normalizeLabels(singleLabel, labelList) {
    var labels = [];
    if (singleLabel) labels.push(singleLabel);
    if (Array.isArray(labelList)) {
        labelList.forEach(function(label) {
            if (label && labels.indexOf(label) === -1) labels.push(label);
        });
    }
    return labels;
}

module.exports = {
    normalizeLabels: normalizeLabels
};
