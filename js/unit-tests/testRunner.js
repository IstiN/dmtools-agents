/**
 * DMTools Agent Unit Test Runner
 *
 * Runs unit tests for agent JS scripts in GraalJS environment.
 * Provides: test(), suite(), assert, loadModule(), makeRequire()
 *
 * Usage:
 *   dmtools run agents/js/unit-tests/run_all.json
 *   dmtools run agents/js/unit-tests/run_configLoader.json
 *   dmtools run agents/js/unit-tests/run_smAgent.json
 */

// ── Global state ─────────────────────────────────────────────────────────────

var _results_ = { passed: 0, failed: 0, errors: [] };
var _currentSuite_ = 'default';

// Pre-loaded base modules available to all test files as globals
var configModule = null;
var configLoaderModule = null;

// ── Test API (globals usable in test files) ──────────────────────────────────

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

// ── Assert library ────────────────────────────────────────────────────────────

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
    }
};

// ── Module loader ─────────────────────────────────────────────────────────────

/**
 * Load a JS file as a CommonJS module with optional dependency injection.
 *
 * @param {string}   path       - file path passed to file_read
 * @param {Function} requireFn  - custom require shim (use makeRequire)
 * @param {Object}   mocks      - global names → replacement values
 *                                (e.g. { file_read: fn, jira_search_by_jql: fn })
 *                                These are injected as local vars that shadow globals.
 * @returns {Object} module.exports
 */
function loadModule(path, requireFn, mocks) {
    var code = file_read({ path: path });
    if (!code || !code.trim()) {
        throw new Error('loadModule: cannot read file: ' + path);
    }

    // Build preamble that shadows dmtools globals with our mocks
    var _testMocks_ = mocks || {};
    var preamble = '';
    for (var k in _testMocks_) {
        if (_testMocks_.hasOwnProperty(k)) {
            preamble += 'var ' + k + ' = _testMocks_["' + k + '"];\n';
        }
    }

    var _testModule_ = { exports: {} };
    var _testRequire_ = requireFn || function(id) {
        throw new Error('loadModule: require("' + id + '") not provided for ' + path);
    };

    // eval runs in current scope — can access _testMocks_, _testModule_, _testRequire_
    eval(
        '(function(module, exports, require) {\n' +
        preamble +
        code +
        '\n})(_testModule_, _testModule_.exports, _testRequire_)'
    );

    return _testModule_.exports;
}

/**
 * Build a require() shim from a module map.
 * Matches on exact id, basename, or ./basename.js patterns.
 */
function makeRequire(moduleMap) {
    return function(id) {
        if (moduleMap[id]) return moduleMap[id];

        // Match by basename (e.g. './config.js' → 'config.js' → 'config')
        var base = id;
        var slash = id.lastIndexOf('/');
        if (slash !== -1) base = id.substring(slash + 1);
        var noExt = base.replace(/\.js$/, '');

        if (moduleMap[base]) return moduleMap[base];
        if (moduleMap[noExt]) return moduleMap[noExt];
        if (moduleMap['./' + base]) return moduleMap['./' + base];

        throw new Error('makeRequire: module not found: ' + id);
    };
}

// ── Main action ───────────────────────────────────────────────────────────────

function action(params) {
    var p = params.jobParams || params;
    var testFiles = p.testFiles || [];

    console.log('═══════════════════════════════════════════');
    console.log('  DMTools Agent Unit Tests');
    console.log('═══════════════════════════════════════════');

    // Pre-load base modules once — test files use these as globals
    try {
        configModule = loadModule('agents/js/config.js');
        configLoaderModule = loadModule(
            'agents/js/configLoader.js',
            makeRequire({ './config.js': configModule, 'config': configModule })
        );
        console.log('  Base modules loaded ✓');
    } catch (e) {
        console.log('  ❌ Failed to load base modules: ' + (e.message || e));
        return { success: false };
    }

    // Run each test file
    for (var i = 0; i < testFiles.length; i++) {
        var filePath = testFiles[i];
        console.log('\n📂 ' + filePath);
        try {
            var testCode = file_read({ path: filePath });
            if (!testCode || !testCode.trim()) {
                console.log('  ⚠️  File not found or empty');
                continue;
            }
            eval(testCode);
        } catch (e) {
            _results_.failed++;
            console.log('  ❌ Error in test file: ' + (e.message || e));
        }
    }

    // Summary
    console.log('\n═══════════════════════════════════════════');
    var status = _results_.failed === 0 ? '✅ PASS' : '❌ FAIL';
    console.log('  ' + status + '  —  ' + _results_.passed + ' passed, ' + _results_.failed + ' failed');
    if (_results_.errors.length > 0) {
        console.log('\n  Failed:');
        for (var j = 0; j < _results_.errors.length; j++) {
            console.log('    ❌ ' + _results_.errors[j].name);
            console.log('       ' + _results_.errors[j].error);
        }
    }
    console.log('═══════════════════════════════════════════');

    return {
        success: _results_.failed === 0,
        passed: _results_.passed,
        failed: _results_.failed
    };
}

module.exports = { action: action };
