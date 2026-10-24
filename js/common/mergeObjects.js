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

/** Copy the caller's own enumerable keys into dest. */
function copyOwnKeys(src, dest, skipUndefined) {
    for (var key in (src || {})) {
        if (!Object.prototype.hasOwnProperty.call(src, key)) continue;
        if (skipUndefined && src[key] === undefined) continue;
        dest[key] = src[key];
    }
    return dest;
}

/** Shallow-merge: base keys first, override keys win. */
function mergeObjects(base, override, skipUndefined) {
    var result = copyOwnKeys(base, {}, false);
    return copyOwnKeys(override, result, !!skipUndefined);
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { mergeObjects: mergeObjects };
}
