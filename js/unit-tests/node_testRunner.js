/**
 * Node-based test harness for agent unit tests.
 *
 * Mirrors the GraalJS testRunner API so the same test files can be executed
 * in environments where the dmtools JSRunner is not available.
 * Provides: test(), suite(), assert, loadModule(), makeRequire(), trackersMock()
 */

const fs = require('fs');
const path = require('path');

var _results_ = { passed: 0, failed: 0, errors: [] };
var _currentSuite_ = 'default';

function test(name, fn) {
    var fullName = _currentSuite_ + ' > ' + name;
    try {
        fn();
        _results_.passed++;
        console.log('  ✅ ' + fullName);
    } catch (e) {
        _results_.failed++;
        var msg = e.message || String(e);
        _results_.errors.push({ name: fullName, error: msg });
        console.log('  ❌ ' + fullName);
        console.log('     ' + msg);
    }
}

function suite(name, fn) {
    var prev = _currentSuite_;
    _currentSuite_ = name;
    console.log('\n── ' + name + ' ──');
    fn();
    _currentSuite_ = prev;
}

var assert = {
    equal: function(actual, expected, msg) {
        if (actual !== expected) {
            throw new Error(
                (msg ? msg + ': ' : '') +
                'expected ' + JSON.stringify(expected) + ' but got ' + JSON.stringify(actual)
            );
        }
    },
    notEqual: function(actual, unexpected, msg) {
        if (actual === unexpected) {
            throw new Error(
                (msg ? msg + ': ' : '') +
                'expected value to not equal ' + JSON.stringify(unexpected)
            );
        }
    },
    deepEqual: function(actual, expected, msg) {
        var a = JSON.stringify(actual);
        var b = JSON.stringify(expected);
        if (a !== b) {
            throw new Error(
                (msg ? msg + ': ' : '') +
                '\n  expected: ' + b +
                '\n  actual:   ' + a
            );
        }
    },
    ok: function(val, msg) {
        if (!val) {
            throw new Error(msg || ('expected truthy, got: ' + JSON.stringify(val)));
        }
    },
    notOk: function(val, msg) {
        if (val) {
            throw new Error(msg || ('expected falsy, got: ' + JSON.stringify(val)));
        }
    },
    contains: function(str, substr, msg) {
        if (typeof str !== 'string' || str.indexOf(substr) === -1) {
            throw new Error(
                (msg ? msg + ': ' : '') +
                JSON.stringify(str) + ' does not contain ' + JSON.stringify(substr)
            );
        }
    },
    notContains: function(str, substr, msg) {
        if (typeof str === 'string' && str.indexOf(substr) !== -1) {
            throw new Error(
                (msg ? msg + ': ' : '') +
                JSON.stringify(str) + ' should not contain ' + JSON.stringify(substr)
            );
        }
    },
    throws: function(fn, msg) {
        var threw = false;
        try { fn(); } catch (e) { threw = true; }
        if (!threw) {
            throw new Error(msg || 'expected function to throw but it did not');
        }
    },
    doesNotThrow: function(fn, msg) {
        try {
            fn();
        } catch (e) {
            throw new Error(
                (msg ? msg + ': ' : '') +
                'expected function not to throw but it threw: ' + (e && e.message ? e.message : e)
            );
        }
    }
};

// The pack root is derived from this file (js/unit-tests/ -> repo root), so the harness works from
// any cwd and without an `agents/` symlink: a path is tried as given, against the pack root, and
// with a consumer-layout `agents/` prefix stripped.
var PACK_ROOT = path.resolve(__dirname, '..', '..');

function resolveExisting(p, accept) {
    var rel = path.isAbsolute(String(p)) ? String(p) : String(p).replace(/^\.\//, '');
    var stripped = rel.indexOf('agents/') === 0 ? rel.substring('agents/'.length) : rel;
    // Relative paths are pack-root relative first (as the dmtools runner, which runs from the repo
    // root, treats '.'); the caller's cwd is only a fallback.
    var candidates = [
        path.resolve(PACK_ROOT, rel),
        path.resolve(PACK_ROOT, stripped),
        path.resolve(process.cwd(), p),
        path.resolve(process.cwd(), 'agents', rel)
    ];
    for (var i = 0; i < candidates.length; i++) {
        try {
            if (accept(fs.statSync(candidates[i]))) return candidates[i];
        } catch (e) { /* try the next candidate */ }
    }
    return null;
}

function file_read(args) {
    var p = args && args.path ? args.path : args;
    var resolved = resolveExisting(p, function(st) { return st.isFile(); });
    if (!resolved) {
        throw new Error('file_read: file not found: ' + p);
    }
    return fs.readFileSync(resolved, 'utf8');
}

// Java FileTools / dmtools-dart parity: JSON {"entries": [absolute paths, sorted]} for a readable
// directory, null otherwise. Same 'agents/' fallback as file_read.
function file_list(args) {
    var p = args && args.path ? args.path : args;
    var dir = resolveExisting(p, function(st) { return st.isDirectory(); });
    if (!dir) return null;
    return JSON.stringify({ entries: fs.readdirSync(dir).map(function(n) { return path.join(dir, n); }).sort() });
}

function loadModule(modulePath, requireFn, mocks) {
    var code = file_read(modulePath);
    if (!code || !code.trim()) {
        throw new Error('loadModule: cannot read file: ' + modulePath);
    }

    var _testMocks_ = mocks || {};
    var preamble = '';
    for (var k in _testMocks_) {
        if (Object.prototype.hasOwnProperty.call(_testMocks_, k)) {
            preamble += 'var ' + k + ' = _testMocks_["' + k + '"];\n';
        }
    }

    var _testModule_ = { exports: {} };
    var _testRequire_ = requireFn || function(id) {
        throw new Error('loadModule: require("' + id + '") not provided for ' + modulePath);
    };

    eval(
        '(function(module, exports, require) {\n' +
        preamble +
        code +
        '\n})(_testModule_, _testModule_.exports, _testRequire_)'
    );

    return _testModule_.exports;
}

function makeRequire(moduleMap) {
    return function(id) {
        if (moduleMap[id]) return withModuleCompat(moduleMap[id]);

        var base = id;
        var slash = id.lastIndexOf('/');
        if (slash !== -1) base = id.substring(slash + 1);
        var noExt = base.replace(/\.js$/, '');

        if (moduleMap[base]) return withModuleCompat(moduleMap[base]);
        if (moduleMap[noExt]) return withModuleCompat(moduleMap[noExt]);
        if (moduleMap['./' + base]) return withModuleCompat(moduleMap['./' + base]);

        throw new Error('makeRequire: module not found: ' + id);
    };
}

/**
 * gh-1244 compat: production modules build their lazy tracker holder from
 * trackersModule.createTrackerHolder() at load time and delegate their
 * token-usage summary to tokenUsageComment.postTokenUsageSafely(). Mocks
 * written before gh-1244 provide only createTracker / postTokenUsageComments;
 * extend them with the canonical semantics so every mock keeps matching the
 * real js/common/trackers.js and js/common/tokenUsageComment.js contracts.
 */
function withModuleCompat(mock) {
    return withTokenUsageCompat(withTrackerHolderCompat(mock));
}

/**
 * tokenUsageComment mock compat (gh-1244): the canonical best-effort wrapper
 * (js/common/tokenUsageComment.js postTokenUsageSafely) — initiator from
 * params/override, customParams from customParamsOf, tracker/config override,
 * failures swallowed with a warning.
 */
function withTokenUsageCompat(mock) {
    if (mock && typeof mock === 'object' && typeof mock.postTokenUsageComments === 'function' &&
        typeof mock.postTokenUsageSafely !== 'function') {
        mock.postTokenUsageSafely = function (ticketKey, params, overrides) {
            try {
                var options = {
                    initiator: (overrides && overrides.initiator) || (params && params.initiator),
                    customParams: typeof mock.customParamsOf === 'function' ? mock.customParamsOf(params) : {}
                };
                if (overrides) {
                    if (overrides.tracker) options.tracker = overrides.tracker;
                    if (overrides.config) options.config = overrides.config;
                }
                mock.postTokenUsageComments(ticketKey, options);
            } catch (e) {
                console.warn('Failed to post token usage comments:', e);
            }
        };
    }
    return mock;
}

/**
 * gh-1244 compat: production modules build their lazy tracker holder from
 * trackersModule.createTrackerHolder() at load time. Trackers-module mocks
 * written before gh-1244 provide only createTracker; extend them with the
 * canonical holder semantics (lazy create via the mock's own createTracker,
 * cached instance, reset on re-init) so every mock keeps matching the real
 * js/common/trackers.js contract.
 */
function withTrackerHolderCompat(mock) {
    if (mock && typeof mock === 'object' && typeof mock.createTracker === 'function' &&
        typeof mock.createTrackerHolder !== 'function') {
        mock.createTrackerHolder = function () {
            var ctx = { config: null, customParams: {} };
            var inst = null;
            return {
                initTracker: function (config, customParams) {
                    ctx = { config: config || null, customParams: customParams || {} };
                    inst = null;
                },
                getTracker: function () {
                    if (!inst) inst = mock.createTracker(ctx.config, ctx.customParams);
                    return inst;
                }
            };
        };
    }
    return mock;
}

/**
 * The throwing './trackers.js' fallback mock shared by suites that load
 * contentOutput-backed modules (gh-824 rework) — must match testRunner.js.
 */
function trackersMock() {
    return { createTracker: function () { throw new Error('contentOutput tracker fallback not expected in this test'); } };
}

// Expose globals used by test files and modules
global.test = test;
global.suite = suite;
global.assert = assert;
global.loadModule = loadModule;
global.makeRequire = makeRequire;
global.trackersMock = trackersMock;
global.file_read = file_read;
global.file_list = file_list;
// Host-bridge parity: file_exists returns {exists: bool} (same 'agents/' fallback as file_read).
global.file_exists = function(args) {
    var p = args && args.path ? args.path : args;
    return { exists: resolveExisting(p, function() { return true; }) !== null };
};

// cli_*: real command execution in the pack root, like the dmtools runner (tests mock it via loadModule
// when they need to). Returns stdout (stderr merged on failure), '' for a failed command.
global.cli_execute_command = function(args) {
    var cmd = args && args.command ? args.command : args;
    try {
        return require('child_process').execSync(String(cmd), { cwd: PACK_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
        return String((e.stdout || '') + (e.stderr || ''));
    }
};

// Network guard, same contract as installNetworkGuard_ in testRunner.js: an unmocked network-backed
// integration tool throws a recognisable error instead of a ReferenceError / a real request.
['github_list_prs', 'github_get_pr', 'github_add_pr_comment', 'confluence_content_by_id',
 'confluence_content_by_title', 'jira_get_ticket', 'jira_post_comment', 'jira_search_by_jql',
 'ado_get_work_item', 'ado_add_work_item_comment', 'tracker_get_ticket', 'tracker_post_comment'
].forEach(function(name) {
    global[name] = function() {
        throw new Error('unit-test network guard: ' + name + '() is not mocked — unit tests must not call real services');
    };
});

global.java = { lang: { System: { getenv: function() { return null; } } } };

// Pre-load base modules exactly like GraalJS testRunner does.
var configModule = loadModule('agents/js/config.js');
// scm.js does a bare `require('./machineNotice.js')` — a raw node require
// resolves against js/unit-tests/ and cannot find it. Mirror testRunner.js:
// inject machineNotice through makeRequire.
var machineNoticeModule = loadModule('agents/js/common/machineNotice.js');
var reviewThreadInventoryModule = loadModule('agents/js/common/reviewThreadInventory.js',
    makeRequire({ './machineNotice.js': machineNoticeModule }));
var scmModule = loadModule('agents/js/common/scm.js',
    makeRequire({ './machineNotice.js': machineNoticeModule,
                  './reviewThreadInventory.js': reviewThreadInventoryModule }));
var configLoaderModule = loadModule(
    'agents/js/configLoader.js',
    makeRequire({
        './config.js': configModule,
        'config': configModule,
        './common/scm.js': scmModule,
        'scm': scmModule
    })
);

global.configModule = configModule;
global.configLoaderModule = configLoaderModule;
// ── Mirrored testRunner.js helpers (node mirror parity) ──────────────────────
// testRunner.js (the GraalJS harness) exposes these as suite globals; several
// suites (recover*/check* families) call makeDefaultConfigLoaderMock directly.
// Mirror them here so those suites run under the degraded node harness too.

function makeDefaultJiraConfig() {
    return {
        issueTypes: Object.assign({}, configModule.ISSUE_TYPES),
        statuses: Object.assign({}, configModule.STATUSES)
    };
}

function makeDefaultConfigLoaderMock(extraConfig) {
    // gh-1230 CRAP: the loader body is a named declaration so the mock factory
    // and the loader are measured as separate small functions.
    function loadProjectConfig(params) {
        var cfg = extraConfig || {};
        var result = {
            jira: makeDefaultJiraConfig()
        };
        if (cfg.repository) {
            result.repository = cfg.repository;
        }
        if (cfg.jobParamPatches) {
            result.jobParamPatches = cfg.jobParamPatches;
        }
        if (cfg.jira) {
            if (cfg.jira.issueTypes) {
                for (var it in cfg.jira.issueTypes) {
                    if (cfg.jira.issueTypes.hasOwnProperty(it)) {
                        result.jira.issueTypes[it] = cfg.jira.issueTypes[it];
                    }
                }
            }
            if (cfg.jira.statuses) {
                for (var st in cfg.jira.statuses) {
                    if (cfg.jira.statuses.hasOwnProperty(st)) {
                        result.jira.statuses[st] = cfg.jira.statuses[st];
                    }
                }
            }
        }
        return result;
    }
    return {
        loadProjectConfig: loadProjectConfig,
        // agents#855: scripts now resolve {jiraProject}/{status.*} through the loader; delegate to the real
        // implementation so mocks of the loader keep behaving like it for query building.
        interpolateJql: function(jql, config, trackerProvider) {
            return configLoaderModule.interpolateJql(jql, config, trackerProvider);
        }
    };
}

global.makeDefaultJiraConfig = makeDefaultJiraConfig;
global.makeDefaultConfigLoaderMock = makeDefaultConfigLoaderMock;

function runTestFile(filePath) {
    console.log('\n📂 ' + filePath);
    try {
        eval(file_read(filePath));
    } catch (e) {
        _results_.failed++;
        console.log('  ❌ Error in test file: ' + (e.message || e));
    }
}

function printSummary() {
    console.log('\n═══════════════════════════════════════════');
    var status = _results_.failed === 0 ? '✅ PASS' : '❌ FAIL';
    console.log('  ' + status + '  —  ' + _results_.passed + ' passed, ' + _results_.failed + ' failed');
    if (_results_.errors.length === 0) return;
    console.log('\n  Failed:');
    _results_.errors.forEach(function(err) {
        console.log('    ❌ ' + err.name);
        console.log('       ' + err.error);
    });
}

function main() {
    console.log('═══════════════════════════════════════════');
    console.log('  DMTools Agent Unit Tests (Node harness)');
    console.log('═══════════════════════════════════════════');
    process.argv.slice(2).forEach(runTestFile);
    printSummary();
    process.exit(_results_.failed === 0 ? 0 : 1);
}

main();
