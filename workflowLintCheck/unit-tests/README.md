# Unit Tests for DMTools Agent Scripts

Unit tests for the GraalJS agent scripts in `agents/js/`, runnable via dmtools without any real Jira/GitHub connections.

## Running tests

```bash
# All tests
dmtools run agents/js/unit-tests/run_all.json

# configLoader only
dmtools run agents/js/unit-tests/run_configLoader.json

# smAgent only
dmtools run agents/js/unit-tests/run_smAgent.json
```

## Structure

```
unit-tests/
├── testRunner.js            # Test framework (loaded by JSRunner)
├── test_configLoader.js     # Tests for configLoader.js (35 tests)
├── test_smAgent.js          # Tests for smAgent.js (23 tests)
├── run_all.json             # JSRunner config — runs all test files
├── run_configLoader.json    # JSRunner config — runs configLoader tests only
└── run_smAgent.json         # JSRunner config — runs smAgent tests only
```

## Test framework API

Test files have access to these globals provided by `testRunner.js`:

| Global | Description |
|--------|-------------|
| `test(name, fn)` | Register a test case — `fn` throws on failure |
| `suite(name, fn)` | Group tests under a named section |
| `assert.equal(a, b, msg?)` | Strict equality (`===`) |
| `assert.deepEqual(a, b, msg?)` | JSON-serialized deep equality |
| `assert.ok(val, msg?)` | Truthy check |
| `assert.notOk(val, msg?)` | Falsy check |
| `assert.contains(str, sub, msg?)` | Substring check |
| `assert.notContains(str, sub, msg?)` | Negative substring check |
| `assert.throws(fn, msg?)` | Expects function to throw |
| `loadModule(path, requireFn?, mocks?)` | Load a JS module with optional mock injection |
| `makeRequire(moduleMap)` | Build a `require()` shim from a `{ id: exports }` map |
| `configModule` | Pre-loaded `agents/js/config.js` exports |
| `configLoaderModule` | Pre-loaded `agents/js/configLoader.js` exports |

## Mock injection

`loadModule(path, requireFn, mocks)` shadows global dmtools functions within the loaded module's scope. Mocked globals never affect the real environment.

```js
// Example: test a module that calls jira_search_by_jql
var capturedJqls = [];

var myMod = loadModule('agents/js/myScript.js',
    makeRequire({ './configLoader.js': configLoaderModule }),
    {
        jira_search_by_jql: function(opts) {
            capturedJqls.push(opts.jql);
            return [{ key: 'PROJ-1', fields: { labels: [] } }];
        },
        github_trigger_workflow: function() {},
        file_read: function(opts) { return null; }
    }
);

test('searches jira with correct JQL', function() {
    myMod.action({ jobParams: { owner: 'o', repo: 'r', rules: [] } });
    assert.equal(capturedJqls.length, 1);
    assert.contains(capturedJqls[0], 'project = PROJ');
});
```

## Writing new tests

1. Create `agents/js/unit-tests/test_myModule.js`
2. Use `suite()` + `test()` blocks:

```js
suite('myModule: core behaviour', function() {

    test('does something expected', function() {
        var mod = loadModule('agents/js/myModule.js',
            makeRequire({ './configLoader.js': configLoaderModule }),
            { file_read: function() { return null; } }
        );

        var result = mod.someFunction('input');
        assert.equal(result, 'expected output');
    });

});
```

3. Add your file to a run JSON:

```json
{
  "name": "JSRunner",
  "params": {
    "jsPath": "agents/js/unit-tests/testRunner.js",
    "jobParams": {
      "testFiles": [
        "agents/js/unit-tests/test_myModule.js"
      ]
    }
  }
}
```

## GraalJS compatibility notes

- Use `var` at module level (safer than `const`/`let` for top-level)
- No arrow functions in framework code (test bodies are fine)
- `new Function()` and `eval()` both work in GraalJS
- All dmtools MCP tools (`jira_search_by_jql`, `file_read`, etc.) are available as globals and can be shadowed by mock injection
