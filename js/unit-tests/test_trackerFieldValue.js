/**
 * Unit tests for js/common/trackerFieldValue.js (gh-1250 dedup helper).
 */

function loadTrackerFieldValue() {
    return loadModule('js/common/trackerFieldValue.js', makeRequire({}), {});
}

suite('trackerFieldValue — module shape', function() {
    test('exports readRawFieldValue behind the typeof module guard', function() {
        var mod = loadTrackerFieldValue();
        assert.equal(typeof mod.readRawFieldValue, 'function', 'readRawFieldValue exported');
        var code = file_read({ path: 'js/common/trackerFieldValue.js' });
        assert.equal(code.indexOf('typeof module') !== -1, true, 'module.exports guarded');
    });
});

suite('trackerFieldValue — readRawFieldValue', function() {
    test('reads the field through the fields wrapper', function() {
        var mod = loadTrackerFieldValue();
        var tracker = {
            getIssue: function(key, fields) {
                assert.equal(key, 'PROJ-1');
                assert.deepEqual(fields, ['description']);
                return { fields: { description: '  raw value  ' } };
            }
        };
        assert.equal(mod.readRawFieldValue(tracker, 'PROJ-1', 'description'), '  raw value  ',
            'value returned untrimmed');
    });

    test('falls back to the bare ticket object when there is no fields wrapper', function() {
        var mod = loadTrackerFieldValue();
        var tracker = { getIssue: function() { return { description: 'raw on ticket' }; } };
        assert.equal(mod.readRawFieldValue(tracker, 'PROJ-1', 'description'), 'raw on ticket');
    });

    test('returns null/undefined when the ticket is null or the field is absent', function() {
        var mod = loadTrackerFieldValue();
        assert.equal(mod.readRawFieldValue({ getIssue: function() { return null; } }, 'PROJ-1', 'description'), null);
        assert.equal(mod.readRawFieldValue({ getIssue: function() { return { fields: {} }; } }, 'PROJ-1', 'description'), undefined);
        assert.equal(mod.readRawFieldValue({ getIssue: function() { return { fields: null }; } }, 'PROJ-1', 'description'), undefined,
            'null fields wrapper falls back to the bare ticket (original inline behavior)');
    });

    test('propagates getIssue failures to the caller', function() {
        var mod = loadTrackerFieldValue();
        var tracker = { getIssue: function() { throw new Error('jira down'); } };
        var threw = false;
        try {
            mod.readRawFieldValue(tracker, 'PROJ-1', 'description');
        } catch (e) {
            threw = true;
        }
        assert.equal(threw, true, 'getIssue errors propagate (callers guard them)');
    });
});
