// ── gh-1436: plan-mode execution path — the plan-protocol prompt appendix ────
//
// When the resolved development mode is "plan" (gh-1435 knob), the dev leg
// works through an explicit task plan instead of free-form execution. The
// protocol reaches the agent as an APPENDIX on the assembled prompt, positioned
// after the standard instruction pack and before any tracker-specific parts.
//
// Mechanism (two cooperating halves, both engine-side):
//   1. Static wiring — the dev leg configs carry one conditional cliPrompts
//      entry (planAppendixCliEntry()) whose prompt is a RUNTIME path:
//      .dmtools/development-mode-plan-appendix.md. The entry sits LAST in the
//      base cliPrompts array; prompt assembly appends cliPromptsByTracker
//      entries after the base array, so the appendix lands after the
//      instruction pack and before the tracker parts. In default mode the
//      entry's condition is false and the assembly omits it — zero appendix,
//      zero plan expectations (invariant P1, regression-guarded).
//   2. Runtime materialization — the leg's preCli setup (preCliDevelopmentSetup)
//      resolves the appendix TEXT (engine default below, or the workflow's
//      developmentModeConfig.plan.appendixFile override used VERBATIM) and
//      writes it to the runtime path BEFORE the agent launches. An unreadable
//      override is a config error: the leg fails fast with the path named —
//      never a silently degraded prompt.
//
// Why a runtime file instead of a pack .md: the appendix content is mode- and
// override-dependent, and the entry must work identically on the plain and the
// encoded-config dispatch paths. Materializing at a fixed path keeps ONE
// engine-owned resolution point (this module) with no engine edit needed to
// reword — workflows override the text via developmentModeConfig.plan.appendixFile.
//
// Plan contract imposed by the appendix (the experiment-validated protocol):
//   - outputs/<KEY>/plan.md — numbered tasks T1..Tn, each with what + verify,
//     sections ## Decisions and ## Open questions (working copy; outputs/ is
//     leg context and never rides commits);
//   - .dmtools/plan-snapshot.md — mirror of the plan, COMMITTED on the dev
//     branch (<KEY>: plan) so plan state survives interruption and session-cache
//     loss; checkbox updates committed per task (<KEY>: plan update T# done);
//   - resume rule — plan present or branch non-empty at start ⇒ continuation:
//     read plan, git log, reconcile checkboxes against the diff, execute only
//     pending tasks.
//
// Failure handling stays with the existing feedbackLoop machinery — the plan
// adds no new failure states (the appendix materialization failure below is a
// config/setup error, reported through the existing setup-error path).

var developmentMode = require('./developmentMode.js');

// Stable id of the conditional cliPrompts entry in the dev leg configs.
var PLAN_APPENDIX_ENTRY_ID = 'developmentModePlan';

// The materialized appendix file, relative to the leg working directory — the
// same root every cliPrompts path resolves from. Local-only: the leg seeds it
// into .git/info/exclude (and the runtime-artifact lists keep it untracked),
// because the durable plan artifact is the AGENT-committed
// .dmtools/plan-snapshot.md, never this engine-owned materialization.
var PLAN_APPENDIX_FILE_PATH = '.dmtools/development-mode-plan-appendix.md';

var PLAN_APPENDIX_PROMPT_PATH = './' + PLAN_APPENDIX_FILE_PATH;
var PLAN_APPENDIX_CONDITION_PATH = 'agents/js/conditions/isDevelopmentModePlan.js';
var PLAN_APPENDIX_EXCLUDE_COMMENT =
    '# Development-mode plan appendix — runtime materialization, never committed';

// Engine-shipped appendix text (the plan-protocol protocol above, spelled out
// for the agent). Rewording later = a developmentModeConfig.plan.appendixFile
// override, never an engine edit — keep this text stable.
var DEFAULT_PLAN_APPENDIX = [
    '## Development Mode: Plan (plan-mode protocol appendix)',
    '',
    'This leg runs in **plan mode**: work through an explicit, committed task',
    'plan instead of free-form execution. Everything else in the instruction',
    'pack still applies unchanged — this appendix only structures HOW you work.',
    '`<KEY>` below is the current ticket key.',
    '',
    '### 1. Decompose before editing',
    '',
    '- Before writing any production code, break the ticket into numbered tasks',
    '  `T1..Tn` in `outputs/<KEY>/plan.md` (the working copy).',
    '- Every task carries exactly two fields:',
    '  - `what` — the concrete change this task makes;',
    '  - `verify` — how to check it passed (the command to run and the expected',
    '    result).',
    '- End the plan with two sections:',
    '  - `## Decisions` — the chosen approach for every open point;',
    '  - `## Open questions` — anything unresolved, with the workaround you picked.',
    '',
    '### 2. Mirror the plan into a committed snapshot',
    '',
    '- Mirror the plan to `.dmtools/plan-snapshot.md` and commit it on the dev',
    '  branch right away: commit subject `<KEY>: plan`.',
    '- The snapshot — not the working copy — is the durable artifact: it survives',
    '  interruption windows and CI session-cache loss. (`outputs/` never rides',
    '  commits.)',
    '- When a task completes: mark its checkbox `[x]` in BOTH files and commit',
    '  the snapshot update: `<KEY>: plan update T# done` (one commit per task).',
    '- The periodic WIP auto-save commits keep running as usual; your plan',
    '  commits coexist with them.',
    '',
    '### 3. Resume rule (continuation legs)',
    '',
    '- At leg start: if a plan file (`outputs/<KEY>/plan.md` or',
    '  `.dmtools/plan-snapshot.md`) already exists, or the branch already carries',
    '  commits, this leg is a CONTINUATION, not a fresh start:',
    '  1. Read the plan and `git log`.',
    '  2. Reconcile the plan checkboxes against the actual branch diff — a task',
    '     whose change is already on the branch is done, checkbox or not.',
    '  3. Execute ONLY the still-pending tasks.'
].join('\n');

function isPlainObject(value) {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** True when the resolved development mode is "plan" (gh-1435 resolver). */
function isPlanMode(customParams) {
    return developmentMode.resolveDevelopmentMode(customParams).mode === 'plan';
}

/**
 * The canonical conditional cliPrompts entry the dev leg configs carry. The
 * entry sits LAST in the base cliPrompts array: prompt assembly renders the
 * base array in order and appends the cliPromptsByTracker entries after it,
 * so the appendix lands after the instruction pack and before the tracker
 * parts. Tests pin the config-authored entries byte-identical to this output.
 */
function planAppendixCliEntry() {
    return {
        id: PLAN_APPENDIX_ENTRY_ID,
        prompt: PLAN_APPENDIX_PROMPT_PATH,
        condition: PLAN_APPENDIX_CONDITION_PATH
    };
}

/**
 * The developmentModeConfig.plan block when present and well-shaped, else
 * null — absent/garbled config reads as "no block" (permissive resolution,
 * same philosophy as validateDevelopmentModeConfig; never a throw).
 *
 * @returns {Object|null}
 */
function planConfigBlock(customParams) {
    return isPlainObject(customParams) && isPlainObject(customParams.developmentModeConfig)
        ? customParams.developmentModeConfig.plan
        : null;
}

/**
 * The appendixFile setting from a plan config block: the raw value when the
 * block is an object carrying the key, else null (absent). The value itself
 * may still be null/undefined/'' (reads as absent) or wrong-typed (the
 * caller warns).
 *
 * @returns {*}
 */
function appendixFileSetting(block) {
    return isPlainObject(block) && Object.prototype.hasOwnProperty.call(block, 'appendixFile')
        ? block.appendixFile
        : null;
}

/**
 * Resolve developmentModeConfig.plan.appendixFile permissively (same
 * philosophy as validateDevelopmentModeConfig): a non-empty string is the
 * override path (relative to the leg working directory, like every cliPrompts
 * path); empty/null/absent reads as "no override"; a wrong-typed value yields
 * ONE warning and no override — never a throw.
 *
 * Split into planConfigBlock/appendixFileSetting so every function in the
 * resolution chain stays under the crap4js CRAP threshold (gh-1436: the
 * monolith measured CRAP 9 > threshold 8 at 100% coverage — complexity, not
 * coverage, was the violation).
 *
 * @returns {{path: string|null, warnings: string[]}}
 */
function appendixOverridePath(customParams) {
    var raw = appendixFileSetting(planConfigBlock(customParams));
    if (raw === null || raw === undefined || raw === '') return { path: null, warnings: [] };
    if (typeof raw !== 'string') {
        return {
            path: null,
            warnings: ['⚠️ developmentModeConfig.plan.appendixFile: expected a file path string, got ' +
                developmentMode.describeRawValue(raw) + ' — using the engine default appendix.']
        };
    }
    return { path: raw, warnings: [] };
}

/**
 * Resolve the appendix text for a plan-mode leg.
 * - Inactive (non-plan) mode → { active: false } and ZERO file IO (P1: the
 *   appendix surface must be invisible on default-mode legs).
 * - No override → the engine default text, no file IO.
 * - Override → the file content VERBATIM (AC5); missing/blank/unreadable file
 *   → an error naming the path (the caller fails the leg fast, before agent
 *   launch — a missing override file is a config error, never a fallback).
 *
 * @returns {{active: boolean, text: string|null, overridden: boolean, path: string|null, error: string|null, warnings: string[]}}
 */
/**
 * Resolve the appendix TEXT source — the engine default, or the workflow's
 * developmentModeConfig.plan.appendixFile used VERBATIM. No mode gate:
 * callers gate on their own mode before calling (plan legs through
 * readAppendixText, adaptive legs routed-to-plan through the gh-1437
 * adaptive module). An unreadable/blank/missing override yields an error
 * naming the path — the caller fails the leg fast (a config error, never a
 * fallback). The IO global is resolved lazily INSIDE here, which keeps the
 * surface untouched for callers that never reach this function on inactive
 * legs (gh-1436 review discipline).
 *
 * @returns {{text: string|null, overridden: boolean, path: string|null, error: string|null, warnings: string[]}}
 */
function resolveAppendixSource(customParams, io) {
    var warnings = [];
    var read = (io && io.file_read) || file_read;
    var override = appendixOverridePath(customParams);
    warnings = warnings.concat(override.warnings);
    if (!override.path) {
        return { text: DEFAULT_PLAN_APPENDIX, overridden: false, path: null, error: null, warnings: warnings };
    }
    var content = null;
    try {
        content = read({ path: override.path });
    } catch (e) {
        content = null;
    }
    if (typeof content !== 'string' || !content.trim()) {
        return {
            text: null,
            overridden: true,
            path: override.path,
            error: 'developmentModeConfig.plan.appendixFile: appendix override not readable at "' +
                override.path + '" — expected a non-empty markdown file. Fix or remove the path.',
            warnings: warnings
        };
    }
    return { text: content, overridden: true, path: override.path, error: null, warnings: warnings };
}

function readAppendixText(customParams, io) {
    if (!isPlanMode(customParams)) {
        return { active: false, text: null, overridden: false, path: null, error: null, warnings: [] };
    }
    var resolved = resolveAppendixSource(customParams, io);
    resolved.active = true;
    return resolved;
}

/**
 * Materialize the appendix for the leg's preCli setup: resolve the text, write
 * it to the runtime path. Never throws — the caller turns { ok: false, error }
 * into the leg's fail-fast setup error. Inactive mode performs zero IO and
 * zero output (P1 golden).
 *
 * The inactive no-op shape is { ok: false, active: false, error: null }:
 * `ok:false` reads as "nothing materialized", NOT as a leg failure — callers
 * MUST check `active` first (runPlanModeAppendixStep returns on !active before
 * ever consulting ok).
 *
 * @returns {{ok: boolean, active: boolean, path: string|null, overridden: boolean, error: string|null, warnings: string[]}}
 */
/**
 * Write a resolved appendix to the runtime path. Never throws — the write
 * failure becomes ok:false + an honest error naming the path. Shared by the
 * plan-mode materialization and the adaptive routed-to-plan materialization
 * (gh-1437).
 *
 * @returns {{ok: boolean, path: string, overridden: boolean, error: string|null}}
 */
function writeResolvedAppendix(resolved, io) {
    // Resolved only when a write is actually due — an inactive or failed
    // resolution must not reference the IO globals at all (same lazy-gate
    // discipline as resolveAppendixSource above).
    var write = (io && io.file_write) || file_write;
    try {
        write({ path: PLAN_APPENDIX_FILE_PATH, content: resolved.text });
    } catch (e) {
        return {
            ok: false,
            path: PLAN_APPENDIX_FILE_PATH,
            overridden: resolved.overridden,
            error: 'developmentMode=plan: could not write the plan-mode appendix to "' +
                PLAN_APPENDIX_FILE_PATH + '": ' + e
        };
    }
    return { ok: true, path: PLAN_APPENDIX_FILE_PATH, overridden: resolved.overridden, error: null };
}

function materializePlanAppendix(customParams, io) {
    var resolved = readAppendixText(customParams, io);
    if (!resolved.active) {
        return { ok: false, active: false, path: null, overridden: false, error: null, warnings: [] };
    }
    if (resolved.error) {
        return { ok: false, active: true, path: resolved.path, overridden: resolved.overridden, error: resolved.error, warnings: resolved.warnings };
    }
    var written = writeResolvedAppendix(resolved, io);
    written.active = true;
    written.warnings = resolved.warnings;
    return written;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        PLAN_APPENDIX_ENTRY_ID: PLAN_APPENDIX_ENTRY_ID,
        PLAN_APPENDIX_FILE_PATH: PLAN_APPENDIX_FILE_PATH,
        PLAN_APPENDIX_PROMPT_PATH: PLAN_APPENDIX_PROMPT_PATH,
        PLAN_APPENDIX_CONDITION_PATH: PLAN_APPENDIX_CONDITION_PATH,
        PLAN_APPENDIX_EXCLUDE_COMMENT: PLAN_APPENDIX_EXCLUDE_COMMENT,
        DEFAULT_PLAN_APPENDIX: DEFAULT_PLAN_APPENDIX,
        isPlanMode: isPlanMode,
        planAppendixCliEntry: planAppendixCliEntry,
        appendixOverridePath: appendixOverridePath,
        resolveAppendixSource: resolveAppendixSource,
        writeResolvedAppendix: writeResolvedAppendix,
        readAppendixText: readAppendixText,
        materializePlanAppendix: materializePlanAppendix
    };
}
