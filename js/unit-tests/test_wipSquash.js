/**
 * Unit tests for js/common/wipSquash.js (gh-1472).
 */

var wipSquash = loadModule('js/common/wipSquash.js');

suite('wipSquash (gh-1472)', function () {

    test('isValidGitSha and cleanText handle valid/invalid inputs and git warnings', function () {
        assert.equal(wipSquash.isValidGitSha('deadbeef12345678'), true);
        assert.equal(wipSquash.isValidGitSha('abc1234'), true);
        assert.equal(wipSquash.isValidGitSha('not-a-sha'), false);
        assert.equal(wipSquash.isValidGitSha(null), false);
        assert.equal(wipSquash.cleanText('warning: inexact rename\nnote: hint\nabc1234\n'), 'abc1234');
        assert.equal(wipSquash.cleanText(null), '');
    });

    test('readExistingBaseFile returns trimmed content or null on missing/error', function () {
        assert.equal(wipSquash.readExistingBaseFile(null, null), null);
        assert.equal(wipSquash.readExistingBaseFile('a', function () { return '  abc1234 \n'; }), 'abc1234');
        assert.equal(wipSquash.readExistingBaseFile('a', function () { return '   '; }), null);
        assert.equal(wipSquash.readExistingBaseFile('a', function () { throw new Error('missing'); }), null);
    });

    test('isWipOrTicketSubject identifies WIP auto-save, target message, and ticket-key subjects', function () {
        assert.equal(wipSquash.isWipOrTicketSubject('', 'PROJ-1', 'msg'), false);
        assert.equal(wipSquash.isWipOrTicketSubject('PROJ-1: WIP auto-save 2026-11-11', 'OTHER', 'msg'), true);
        assert.equal(wipSquash.isWipOrTicketSubject('exact target', 'OTHER', 'exact target'), true);
        assert.equal(wipSquash.isWipOrTicketSubject('feat(PROJ-1): add handler', 'PROJ-1', 'other'), true);
        assert.equal(wipSquash.isWipOrTicketSubject('chore: unrelated commit', 'PROJ-1', 'other'), false);
    });

    test('rangeHasOnlyWipOrTicketCommits checks ancestor and subject safety', function () {
        assert.equal(wipSquash.rangeHasOnlyWipOrTicketCommits(null, 'bad', 'PROJ-1'), false);
        assert.equal(wipSquash.rangeHasOnlyWipOrTicketCommits(function (cmd) {
            if (cmd.indexOf('git log') === 0) return '';
            return '';
        }, 'abc1234', 'PROJ-1'), true);
        assert.equal(wipSquash.rangeHasOnlyWipOrTicketCommits(function (cmd) {
            if (cmd.indexOf('git log') === 0) return 'PROJ-1 WIP auto-save 1\nPROJ-1 feat\n';
            return '';
        }, 'abc1234', 'PROJ-1'), true);
        assert.equal(wipSquash.rangeHasOnlyWipOrTicketCommits(function (cmd) {
            if (cmd.indexOf('git log') === 0) return 'PROJ-1 WIP auto-save 1\nsomeone else\n';
            return '';
        }, 'abc1234', 'PROJ-1'), false);
        assert.equal(wipSquash.rangeHasOnlyWipOrTicketCommits(function () {
            throw new Error('not ancestor');
        }, 'abc1234', 'PROJ-1'), false);
    });

    test('walkBackContiguousWipBase walks back across contiguous WIP auto-save commits', function () {
        assert.equal(wipSquash.walkBackContiguousWipBase(null, 'not-sha'), 'not-sha');
        assert.equal(wipSquash.walkBackContiguousWipBase(function () {
            return 'abc1234:Normal commit\n';
        }, 'abc1234'), 'abc1234');
        assert.equal(wipSquash.walkBackContiguousWipBase(function (cmd) {
            if (cmd.indexOf('git log') === 0) {
                return '3333333:PROJ-1: WIP auto-save 2\n2222222:PROJ-1: WIP auto-save 1\n1111111:Initial commit\n';
            }
            if (cmd === 'git rev-parse 2222222^') return '1111111\n';
            return '';
        }, '3333333'), '1111111');
        assert.equal(wipSquash.walkBackContiguousWipBase(function (cmd) {
            if (cmd.indexOf('git log') === 0) return 'malformed-line-without-colon\n';
            return '';
        }, '3333333'), '3333333');
        assert.equal(wipSquash.walkBackContiguousWipBase(function () {
            throw new Error('git error');
        }, '3333333'), '3333333');
    });

    test('resolvePersistedBaseHead preserves valid base across interrupted/resumed runs or walks back WIP commits', function () {
        // Case 1: existing === current
        assert.equal(wipSquash.resolvePersistedBaseHead({
            filePath: 'base.txt',
            currentSha: 'abc1234',
            readFn: function () { return 'abc1234\n'; }
        }), 'abc1234');

        // Case 2: existing is ancestor with only WIP/ticket commits
        assert.equal(wipSquash.resolvePersistedBaseHead({
            filePath: 'base.txt',
            currentSha: 'def5678',
            ticketKey: 'PROJ-1',
            readFn: function () { return 'abc1234\n'; },
            runCommand: function (cmd) {
                if (cmd.indexOf('git log --no-merges') === 0) return 'PROJ-1 WIP auto-save 1\n';
                return '';
            }
        }), 'abc1234');

        // Case 3: no existing file, current sits on WIP commits -> walks back
        assert.equal(wipSquash.resolvePersistedBaseHead({
            filePath: 'base.txt',
            currentSha: 'def5678',
            ticketKey: 'PROJ-1',
            readFn: function () { return null; },
            runCommand: function (cmd) {
                if (cmd.indexOf('git log --no-merges --format=%H:%s') === 0) {
                    return 'def5678:PROJ-1 WIP auto-save 1\nabc1234:Base commit\n';
                }
                if (cmd === 'git rev-parse def5678^') return 'abc1234\n';
                return '';
            }
        }), 'abc1234');

        // Case 4: no currentSha
        assert.equal(wipSquash.resolvePersistedBaseHead({}), null);
    });

    test('isReworkWipSquashEnabled defaults to true unless explicitly false', function () {
        assert.equal(wipSquash.isReworkWipSquashEnabled(undefined), true);
        assert.equal(wipSquash.isReworkWipSquashEnabled({}), true);
        assert.equal(wipSquash.isReworkWipSquashEnabled({ squashReworkWip: null }), true);
        assert.equal(wipSquash.isReworkWipSquashEnabled({ squashReworkWip: true }), true);
        assert.equal(wipSquash.isReworkWipSquashEnabled({ squashReworkWip: false }), false);
        assert.equal(wipSquash.isReworkWipSquashEnabled({ squashReworkWip: 'true' }), false);
    });

    test('inspectSquashRange and inspectReworkSquashRange handle self-heal merges and reject foreign merges', function () {
        var devOk = wipSquash.inspectSquashRange(function (cmd) {
            if (cmd.indexOf('git rev-list --merges') === 0) return 'm1\n';
            if (cmd.indexOf('git log --merges') === 0) return "Merge branch 'origin/ai/PROJ-1' into ai/PROJ-1\n";
            if (cmd.indexOf('git log --no-merges') === 0) return 'PROJ-1 WIP auto-save 1\nPROJ-1 feat\n';
            return '';
        }, 'abc..HEAD', 'PROJ-1', 'PROJ-1 final');
        assert.equal(devOk.skipReason, null);
        assert.equal(devOk.subjects.length, 2);

        var devForeignAcrossMerge = wipSquash.inspectSquashRange(function (cmd) {
            if (cmd.indexOf('git rev-list --merges') === 0) return 'm1\n';
            if (cmd.indexOf('git log --merges') === 0) return "Merge branch 'origin/ai/PROJ-1' into ai/PROJ-1\n";
            if (cmd.indexOf('git log --no-merges') === 0) return 'PROJ-1 WIP auto-save 1\nforeign commit\n';
            return '';
        }, 'abc..HEAD', 'PROJ-1', 'PROJ-1 final');
        assert.ok(devForeignAcrossMerge.skipReason.indexOf('merge commit') !== -1);

        var devEmptyMerges = wipSquash.inspectSquashRange(function (cmd) {
            if (cmd.indexOf('git rev-list --merges') === 0) return 'm1\n';
            if (cmd.indexOf('git log --merges') === 0) return '';
            return '';
        }, 'abc..HEAD', 'PROJ-1', 'PROJ-1 final');
        assert.ok(devEmptyMerges.skipReason.indexOf('merge commit') !== -1);

        var devThrowsAcrossMerge = wipSquash.inspectSquashRange(function (cmd) {
            if (cmd.indexOf('git rev-list --merges') === 0) return 'm1\n';
            throw new Error('git boom');
        }, 'abc..HEAD', 'PROJ-1', 'PROJ-1 final');
        assert.ok(devThrowsAcrossMerge.skipReason.indexOf('merge commit') !== -1);

        var devBadMerge = wipSquash.inspectSquashRange(function (cmd) {
            if (cmd.indexOf('git rev-list --merges') === 0) return 'm1\n';
            if (cmd.indexOf('git log --merges') === 0) return 'Custom merge commit\n';
            return '';
        }, 'abc..HEAD', 'PROJ-1', 'PROJ-1 final');
        assert.ok(devBadMerge.skipReason.indexOf('merge commit') !== -1);

        var reworkBadMerge = wipSquash.inspectReworkSquashRange(function (cmd) {
            if (cmd.indexOf('git rev-list --merges') === 0) return 'm1\n';
            if (cmd.indexOf('git log --merges') === 0) return 'Custom merge commit\n';
            return '';
        }, 'abc..HEAD', 'PROJ-1', 'PROJ-1 rework');
        assert.ok(reworkBadMerge.skipReason.indexOf('non-self-heal merge') !== -1);

        assert.equal(wipSquash.persistBaseHeadFile({}), null);
    });
});
