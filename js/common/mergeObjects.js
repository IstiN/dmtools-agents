/**
 * mergeObjects — shared shallow-merge helper for config resolution.
 *
 * Extracted from js/common/contentOutput.js and js/fetchParentContextToInput.js
 * (gh-1250): both carried near-identical copies of this loop.
 *
 * @param {Object}  base          lower-priority map (its keys are copied first)
 * @param {Object}  override      higher-priority map (its keys win)
 * @param {boolean} skipUndefined when true, an explicit `undefined` override
 *     value does NOT shadow the base value (contentOutput's semantics);
 *     when false, `undefined` is copied verbatim (fetchParentContextToInput's
 *     legacy semantics — kept for behavior parity).
 */

function mergeObjects(base, override, skipUndefined) {
    var result = {};
    var key;
    for (key in (base || {})) {
        if (Object.prototype.hasOwnProperty.call(base, key)) result[key] = base[key];
    }
    for (key in (override || {})) {
        if (!Object.prototype.hasOwnProperty.call(override, key)) continue;
        if (skipUndefined && override[key] === undefined) continue;
        result[key] = override[key];
    }
    return result;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { mergeObjects: mergeObjects };
}
