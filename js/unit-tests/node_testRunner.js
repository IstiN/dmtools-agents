/**
 * Node-based test harness for agent unit tests.
 *
 * Mirrors the GraalJS testRunner API so the same test files can be executed
 * in environments where the dmtools JSRunner is not available.
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
    }
};

function file_read(args) {
    var p = args && args.path ? args.path : args;
    var resolved = path.resolve(process.cwd(), p);
    if (!fs.existsSync(resolved) && p.indexOf('js/') === 0) {
        resolved = path.resolve(process.cwd(), 'agents', p);
    }
    if (!fs.existsSync(resolved)) {
        throw new Error('file_read: file not found: ' + p);
    }
    return fs.readFileSync(resolved, 'utf8');
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
        if (moduleMap[id]) return moduleMap[id];

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

// Expose globals used by test files and modules
global.test = test;
global.suite = suite;
global.assert = assert;
global.loadModule = loadModule;
global.makeRequire = makeRequire;
global.file_read = file_read;

global.java = { lang: { System: { getenv: function() { return null; } } } };

// Pre-load base modules exactly like GraalJS testRunner does.
var configModule = loadModule('agents/js/config.js');
var scmModule = loadModule('agents/js/common/scm.js', require);
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

function main() {
    var testFiles = process.argv.slice(2);
    console.log('═══════════════════════════════════════════');
    console.log('  DMTools Agent Unit Tests (Node harness)');
    console.log('═══════════════════════════════════════════');

    for (var i = 0; i < testFiles.length; i++) {
        var filePath = testFiles[i];
        console.log('\n📂 ' + filePath);
        try {
            var testCode = file_read(filePath);
            eval(testCode);
        } catch (e) {
            _results_.failed++;
            console.log('  ❌ Error in test file: ' + (e.message || e));
        }
    }

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

    process.exit(_results_.failed === 0 ? 0 : 1);
}

main();
