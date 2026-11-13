var workingDirMarker = loadModule('js/common/workingDirMarker.js');
var MARKER_CONFLICT = new Error(
    'The following untracked working tree files would be overwritten by checkout:\n' +
    '\t.dmtools-target-workingdir\nAborting'
);
var MARKER_TMP = '/tmp/dmtools-marker.ABCDEF';
var MARKER_SAFE_CHECK = 'bash -c "test ! -L .dmtools-target-workingdir -a ! -d .dmtools-target-workingdir"';

function markerGuardHarness(options) {
    options = options || {};
    var calls = [];
    var checkouts = 0;
    var guard = workingDirMarker.createCheckoutGuard(function(args) {
        calls.push(args);
        if (args.command === 'git checkout topic') {
            checkouts++;
            if (checkouts === 1) throw options.initialError || MARKER_CONFLICT;
            if (options.retryError) throw options.retryError;
            return 'checked out';
        }
        if (args.command === 'bash -c "mktemp -d -t dmtools-marker.XXXXXXXX"') {
            return options.tempDir || MARKER_TMP;
        }
        if (args.command === 'bash -c "mv -- .dmtools-target-workingdir ' + MARKER_TMP + '/marker"' &&
            options.stashError) throw options.stashError;
        if (args.command === MARKER_SAFE_CHECK && options.restoreError) throw options.restoreError;
        if (args.command === 'bash -c "rmdir -- ' + MARKER_TMP + '"' && options.cleanupError) {
            throw options.cleanupError;
        }
        return '';
    });
    return { guard: guard, calls: calls };
}

function markerCommands(calls) {
    return calls.map(function(args) { return args.command; });
}

suite('workingDirMarker checkout guard', function() {
    test('does not intercept marker conflicts outside branch setup', function() {
        var h = markerGuardHarness();
        assert.throws(function() { h.guard.run({ command: 'git checkout topic' }); });
        assert.deepEqual(markerCommands(h.calls), ['git checkout topic']);
        assert.equal(h.guard.finish(), true);
    });

    test('does not intercept unrelated errors or non-branch checkout commands', function() {
        var calls = [];
        var guard = workingDirMarker.createCheckoutGuard(function(args) {
            calls.push(args.command);
            throw new Error('untracked working tree files would be overwritten by checkout:\n\tother.txt');
        });
        guard.begin();
        assert.throws(function() { guard.run({ command: 'git checkout topic' }); });
        assert.throws(function() { guard.run({ command: 'git checkout -- .dmtools-target-workingdir' }); });
        assert.throws(function() { guard.run({ command: 'git fetch origin' }); });
        assert.equal(guard.finish(), true);
        assert.equal(calls.length, 3, 'does not try to move an unrelated file');
    });

    test('temporarily preserves a marker, retries, and restores it in the target directory', function() {
        var h = markerGuardHarness();
        h.guard.begin();
        assert.equal(h.guard.run({ command: 'git checkout topic', workingDirectory: '/repo' }), 'checked out');
        assert.equal(h.guard.finish(), true);
        assert.deepEqual(markerCommands(h.calls), [
            'git checkout topic',
            'bash -c "mktemp -d -t dmtools-marker.XXXXXXXX"',
            'bash -c "mv -- .dmtools-target-workingdir ' + MARKER_TMP + '/marker"',
            'git checkout topic',
            MARKER_SAFE_CHECK,
            'bash -c "rm -f -- .dmtools-target-workingdir"',
            'bash -c "mv -- ' + MARKER_TMP + '/marker .dmtools-target-workingdir"',
            'bash -c "rmdir -- ' + MARKER_TMP + '"'
        ]);
        assert.ok(h.calls.every(function(args) { return args.workingDirectory === '/repo'; }));
    });

    test('restores the saved marker when the retry still fails', function() {
        var h = markerGuardHarness({ retryError: new Error('another file conflicts') });
        h.guard.begin();
        assert.throws(function() { h.guard.run({ command: 'git checkout topic' }); });
        assert.throws(function() { h.guard.run({ command: 'git checkout topic' }); });
        assert.equal(h.guard.finish(), true);
        assert.ok(markerCommands(h.calls).indexOf(
            'bash -c "mv -- ' + MARKER_TMP + '/marker .dmtools-target-workingdir"'
        ) !== -1);
    });

    test('rejects an unsafe temporary path without moving the marker', function() {
        var h = markerGuardHarness({ tempDir: '/tmp/../dmtools-marker.BAD' });
        h.guard.begin();
        assert.throws(function() { h.guard.run({ command: 'git checkout topic' }); });
        assert.equal(h.guard.finish(), true);
        assert.equal(h.calls.length, 2);
    });

    test('reports a backup failure and attempts to remove its empty directory', function() {
        var h = markerGuardHarness({
            stashError: new Error('move failed'),
            cleanupError: new Error('cleanup failed')
        });
        var warnings = [];
        var originalWarn = console.warn;
        try {
            console.warn = function() { warnings.push(Array.prototype.slice.call(arguments).join(' ')); };
            h.guard.begin();
            assert.throws(function() { h.guard.run({ command: 'git checkout topic' }); });
            assert.equal(h.guard.finish(), true);
        } finally {
            console.warn = originalWarn;
        }
        assert.contains(warnings.join('\n'), 'Could not remove empty marker backup directory');
        assert.ok(markerCommands(h.calls).indexOf('bash -c "rmdir -- ' + MARKER_TMP + '"') !== -1);
    });

    test('keeps the backup and refuses another run when restoration is unsafe', function() {
        var h = markerGuardHarness({ restoreError: new Error('marker is a symlink') });
        var errors = [];
        var originalError = console.error;
        try {
            console.error = function() { errors.push(Array.prototype.slice.call(arguments).join(' ')); };
            h.guard.begin();
            assert.equal(h.guard.run({ command: 'git checkout topic' }), 'checked out');
            assert.equal(h.guard.finish(), false);
            assert.throws(function() { h.guard.begin(); });
        } finally {
            console.error = originalError;
        }
        assert.contains(errors.join('\n'), MARKER_TMP + '/marker');
        assert.ok(markerCommands(h.calls).indexOf('bash -c "rm -f -- .dmtools-target-workingdir"') === -1);
    });

    test('warns if an empty backup directory cannot be removed after restoration', function() {
        var h = markerGuardHarness({ cleanupError: new Error('cleanup failed') });
        var warnings = [];
        var originalWarn = console.warn;
        try {
            console.warn = function() { warnings.push(Array.prototype.slice.call(arguments).join(' ')); };
            h.guard.begin();
            h.guard.run({ command: 'git checkout topic' });
            assert.equal(h.guard.finish(), true);
            h.guard.begin();
            assert.equal(h.guard.finish(), true);
        } finally {
            console.warn = originalWarn;
        }
        assert.contains(warnings.join('\n'), 'Could not remove empty marker backup directory');
    });
});

suite('workingDirMarker write', function() {
    test('checks the job root before writing the resolved directory', function() {
        var calls = [];
        workingDirMarker.writeWorkingDirMarker('/repo', function(args) {
            calls.push(args);
        }, function(args) {
            calls.push(args);
        });
        assert.deepEqual(calls, [
            { command: MARKER_SAFE_CHECK },
            { path: '.dmtools-target-workingdir', content: '/repo' }
        ]);
    });

    test('does not write when the safety check fails', function() {
        var writes = [];
        assert.throws(function() {
            workingDirMarker.writeWorkingDirMarker('/repo', function() {
                throw new Error('unsafe');
            }, function(args) { writes.push(args); });
        });
        assert.equal(writes.length, 0);
    });

    test('logs a failed marker write without failing setup', function() {
        var warnings = [];
        var originalWarn = console.warn;
        try {
            console.warn = function() { warnings.push(Array.prototype.slice.call(arguments).join(' ')); };
            workingDirMarker.writeWorkingDirMarker('/repo', function() {}, function() {
                throw new Error('disk full');
            });
        } finally {
            console.warn = originalWarn;
        }
        assert.contains(warnings.join('\n'), 'Could not write .dmtools-target-workingdir');
        assert.contains(warnings.join('\n'), 'disk full');
    });
});
