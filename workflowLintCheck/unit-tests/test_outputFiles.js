/**
 * Unit tests for js/common/outputFiles.js.
 */

function loadOutputFiles(mocks) {
    return loadModule('js/common/outputFiles.js', makeRequire({}), mocks || {});
}

suite('outputFiles', function() {
    test('reads output file from root outputs directory', function() {
        var mod = loadOutputFiles({
            file_read: function(opts) {
                if (opts.path === 'outputs/pr_review.json') return '{"ok":true}';
                return null;
            }
        });

        var content = mod.readOutputFile('pr_review.json', { ticketKey: 'AITS-1' });
        assert.equal(content, '{"ok":true}');
    });

    test('falls back to ticket-keyed output subdirectory', function() {
        var mod = loadOutputFiles({
            file_read: function(opts) {
                if (opts.path === 'outputs/pr_review.json') return null;
                if (opts.path === 'outputs/AITS-757/pr_review.json') return '{"ok":"ticket-subdir"}';
                return null;
            }
        });

        var content = mod.readOutputFile('pr_review.json', { ticketKey: 'AITS-757' });
        assert.equal(content, '{"ok":"ticket-subdir"}');
    });

    test('falls back to workingDir ticket-keyed outputs path', function() {
        var mod = loadOutputFiles({
            file_read: function(opts) {
                if (opts.path === 'outputs/pr_review.json') return null;
                if (opts.path === 'outputs/AITS-757/pr_review.json') return null;
                if (opts.path === '/tmp/repo/outputs/pr_review.json') return null;
                if (opts.path === '/tmp/repo/outputs/AITS-757/pr_review.json') return '{"ok":"workingdir-ticket"}';
                return null;
            }
        });

        var content = mod.readOutputFile('pr_review.json', {
            ticketKey: 'AITS-757',
            workingDir: '/tmp/repo'
        });
        assert.equal(content, '{"ok":"workingdir-ticket"}');
    });
});
