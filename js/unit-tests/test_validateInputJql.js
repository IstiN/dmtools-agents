/**
 * Unit tests for js/common/validateInputJql.js
 *
 * Covers: extractTicketKeyFromJql, validateTicketKeyFormat,
 *         requireTicketExists, validateAndRequireTicket.
 */

// ── Helpers ───────────────────────────────────────────────────────────────────

// Single owner of the GitHub key-shape convention (gh-770) — validateInputJql
// must derive its gate and extraction alternation from this module, so the
// default loader wires the REAL one and the derivation suites below swap in
// controlled fakes.
var ticketKeyShapesModule = loadModule('js/common/ticketKeyShapes.js');

function makeValidator(jiraGetTicketMock, ticketKeyShapesOverride) {
    return loadModule(
        'js/common/validateInputJql.js',
        makeRequire({
            './ticketKeyShapes.js': ticketKeyShapesOverride || ticketKeyShapesModule,
            './trackers.js': loadModule('js/common/trackers.js', makeRequire({
                '../config.js': configModule,
                './ticketKeyShapes.js': ticketKeyShapesModule
            }), { jira_get_ticket: jiraGetTicketMock || function() { return null; } })
        }),
        { jira_get_ticket: jiraGetTicketMock || function() { return null; } }
    );
}

function existingTicketMock(key) {
    return function(opts) {
        var k = (opts && opts.key) ? opts.key : opts;
        if (k === key) return { key: k, fields: { summary: 'Test ticket' } };
        return null;
    };
}

function throwingTicketMock(msg) {
    return function() { throw new Error(msg || 'Jira error'); };
}

// ── extractTicketKeyFromJql ───────────────────────────────────────────────────

suite('validateInputJql: extractTicketKeyFromJql', function() {

    test('extracts key from "key = PROJ-123"', function() {
        var v = makeValidator();
        assert.equal(v.extractTicketKeyFromJql('key = PROJ-123'), 'PROJ-123');
    });

    test('extracts key from "key in (PROJ-123)" (story_development format)', function() {
        var v = makeValidator();
        assert.equal(v.extractTicketKeyFromJql('key in (PROJ-123)'), 'PROJ-123');
    });

    test('extracts key case-insensitively and normalises to uppercase', function() {
        var v = makeValidator();
        assert.equal(v.extractTicketKeyFromJql('KEY = proj-42'), 'PROJ-42');
    });

    test('returns null for null input', function() {
        var v = makeValidator();
        assert.equal(v.extractTicketKeyFromJql(null), null);
    });

    test('returns null for empty string', function() {
        var v = makeValidator();
        assert.equal(v.extractTicketKeyFromJql(''), null);
    });

    test('returns null when JQL has no key clause', function() {
        var v = makeValidator();
        assert.equal(v.extractTicketKeyFromJql("project = PROJ AND status = 'In Progress'"), null);
    });

});

// ── GitHub key shapes (gh-770) ────────────────────────────────────────────────
// The machine loop keys issues 'gh-N'; the gate must not abort GitHub-backed
// legs with "Invalid or missing Jira ticket key".

suite('validateInputJql: extractTicketKeyFromJql — GitHub key shapes (gh-770)', function() {

    test('extracts the gh-N router key as written (case preserved)', function() {
        var v = makeValidator();
        assert.equal(v.extractTicketKeyFromJql('key = gh-1308'), 'gh-1308');
        assert.equal(v.extractTicketKeyFromJql('key in (gh-7)'), 'gh-7');
    });

    test('extracts composite owner/repo#N, #N and bare-number keys', function() {
        var v = makeValidator();
        assert.equal(v.extractTicketKeyFromJql('key = acme/widgets#12'), 'acme/widgets#12');
        assert.equal(v.extractTicketKeyFromJql('key = #12'), '#12');
        assert.equal(v.extractTicketKeyFromJql('key = 12'), '12');
    });

    test('still normalises Jira keys to uppercase', function() {
        var v = makeValidator();
        assert.equal(v.extractTicketKeyFromJql('key = proj-42'), 'PROJ-42');
    });

});

suite('validateInputJql: validateTicketKeyFormat — GitHub key shapes (gh-770)', function() {

    test('accepts the gh-N router key', function() {
        var v = makeValidator();
        assert.doesNotThrow(function() { v.validateTicketKeyFormat('gh-1308'); });
    });

    test('accepts composite owner/repo#N, #N and bare-number keys', function() {
        var v = makeValidator();
        assert.doesNotThrow(function() { v.validateTicketKeyFormat('acme/widgets#123'); });
        assert.doesNotThrow(function() { v.validateTicketKeyFormat('#123'); });
        assert.doesNotThrow(function() { v.validateTicketKeyFormat('123'); });
    });

    test('still rejects lowercase Jira keys and junk', function() {
        var v = makeValidator();
        assert.throws(function() { v.validateTicketKeyFormat('proj-123'); }, /Invalid or missing/);
        assert.throws(function() { v.validateTicketKeyFormat('PROJ'); }, /Invalid or missing/);
        assert.throws(function() { v.validateTicketKeyFormat('gh-abc'); }, /Invalid or missing/);
        assert.throws(function() { v.validateTicketKeyFormat(null); }, /Invalid or missing/);
    });

});

suite('validateInputJql: validateAndRequireTicket — GitHub key shapes (gh-770)', function() {

    test('succeeds for inputJql "key = gh-12" when the issue exists', function() {
        var v = makeValidator(existingTicketMock('gh-12'));
        var ticket = v.validateAndRequireTicket({ jobParams: { inputJql: 'key = gh-12' } });
        assert.equal(ticket.key, 'gh-12');
    });

    test('reports the gh-N key as not found when the issue is missing', function() {
        var v = makeValidator(function() { return null; });
        assert.throws(function() {
            v.validateAndRequireTicket({ jobParams: { inputJql: 'key = gh-99' } });
        }, /not found/i);
    });

});

// ── shared key-shape owner derivation (gh-770 review thread 2) ────────────────
// The gate and the extraction alternation must be DERIVED from
// common/ticketKeyShapes.js — a local copy would drift the next time a shape
// is added. These suites swap in controlled fakes to prove the wiring.

suite('validateInputJql: derives GitHub key shapes from ticketKeyShapes (gh-770)', function() {

    test('gate consults the shared isGitHubKeyShape (no local copy)', function() {
        var rejectingShapes = {
            isGitHubKeyShape: function() { return false; },
            shapeSources: function() { return []; }
        };
        var v = makeValidator(undefined, rejectingShapes);
        assert.throws(function() { v.validateTicketKeyFormat('gh-12'); }, /Invalid or missing/);

        var acceptingShapes = {
            isGitHubKeyShape: function() { return true; },
            shapeSources: function() { return []; }
        };
        var v2 = makeValidator(undefined, acceptingShapes);
        assert.doesNotThrow(function() { v2.validateTicketKeyFormat('totally-not-a-key'); });
    });

    test('extraction alternation is built from the shared shapeSources', function() {
        var ghOnlyShapes = {
            isGitHubKeyShape: function(key) { return /^gh-\d+$/i.test(String(key)); },
            shapeSources: function() { return ['gh-\\d+']; }
        };
        var v = makeValidator(undefined, ghOnlyShapes);
        assert.equal(v.extractTicketKeyFromJql('key = gh-7'), 'gh-7');
        // No local fallback list: a shape the shared owner does not list is
        // simply not extracted.
        assert.equal(v.extractTicketKeyFromJql('key = acme/widgets#12'), null);
        assert.equal(v.extractTicketKeyFromJql('key = #12'), null);
    });

});

// ── requireTicketExists ───────────────────────────────────────────────────────

suite('validateInputJql: validateTicketKeyFormat', function() {

    test('accepts a valid key', function() {
        var v = makeValidator();
        assert.doesNotThrow(function() { v.validateTicketKeyFormat('PROJ-123'); });
    });

    test('accepts keys with digits and underscores in project part', function() {
        var v = makeValidator();
        assert.doesNotThrow(function() { v.validateTicketKeyFormat('AB2_C-1'); });
    });

    test('throws for null', function() {
        var v = makeValidator();
        assert.throws(function() { v.validateTicketKeyFormat(null); }, /Invalid or missing/);
    });

    test('throws for empty string', function() {
        var v = makeValidator();
        assert.throws(function() { v.validateTicketKeyFormat(''); }, /Invalid or missing/);
    });

    test('throws for lowercase project key', function() {
        var v = makeValidator();
        assert.throws(function() { v.validateTicketKeyFormat('proj-123'); }, /Invalid or missing/);
    });

    test('throws for missing numeric id', function() {
        var v = makeValidator();
        assert.throws(function() { v.validateTicketKeyFormat('PROJ'); }, /Invalid or missing/);
    });

    test('throws for JQL injection attempt', function() {
        var v = makeValidator();
        assert.throws(function() { v.validateTicketKeyFormat('PROJ-1 OR project = OTHER'); }, /Invalid or missing/);
    });

    test('throws for key with special characters', function() {
        var v = makeValidator();
        assert.throws(function() { v.validateTicketKeyFormat('PROJ-1; DROP'); }, /Invalid or missing/);
    });

});

// ── requireTicketExists ───────────────────────────────────────────────────────

suite('validateInputJql: requireTicketExists', function() {

    test('returns the ticket when it exists', function() {
        var v = makeValidator(existingTicketMock('PROJ-5'));
        var ticket = v.requireTicketExists('PROJ-5');
        assert.equal(ticket.key, 'PROJ-5');
    });

    test('throws when jira_get_ticket returns null', function() {
        var v = makeValidator(function() { return null; });
        assert.throws(function() { v.requireTicketExists('PROJ-9'); }, /not found/i);
    });

    test('throws when jira_get_ticket returns object without key', function() {
        var v = makeValidator(function() { return { fields: {} }; });
        assert.throws(function() { v.requireTicketExists('PROJ-9'); }, /not found/i);
    });

    test('throws and wraps Jira API error', function() {
        var v = makeValidator(throwingTicketMock('Connection refused'));
        assert.throws(function() { v.requireTicketExists('PROJ-9'); }, /not found/i);
    });

    test('error wording is tracker-neutral (gh-770: GitHub-shaped keys are valid keys)', function() {
        var v = makeValidator(function() { return null; });
        var thrown = null;
        try {
            v.requireTicketExists('gh-9');
        } catch (e) {
            thrown = e;
        }
        assert.notEqual(thrown, null, 'expected requireTicketExists to throw');
        assert.equal(/^Ticket not found/.test(thrown.message), true,
            'expected tracker-neutral wording, got: ' + thrown.message);
        assert.equal(/Jira ticket not found/.test(thrown.message), false,
            'stale Jira-only wording must not come back');
    });

});

// ── validateAndRequireTicket ──────────────────────────────────────────────────

suite('validateInputJql: validateAndRequireTicket', function() {

    test('succeeds for valid key = form when ticket exists', function() {
        var v = makeValidator(existingTicketMock('PROJ-55'));
        var ticket = v.validateAndRequireTicket({ jobParams: { inputJql: 'key = PROJ-55' } });
        assert.equal(ticket.key, 'PROJ-55');
    });

    test('succeeds for key in () form (story_development) when ticket exists', function() {
        var v = makeValidator(existingTicketMock('PROJ-55'));
        var ticket = v.validateAndRequireTicket({ jobParams: { inputJql: 'key in (PROJ-55)' } });
        assert.equal(ticket.key, 'PROJ-55');
    });

    test('throws when inputJql uses the placeholder default "JD-82" and ticket not found', function() {
        var v = makeValidator(function() { return null; });
        assert.throws(function() {
            v.validateAndRequireTicket({ jobParams: { inputJql: 'key = JD-82' } });
        }, /not found/i);
    });

    test('throws when inputJql is empty', function() {
        var v = makeValidator();
        assert.throws(function() {
            v.validateAndRequireTicket({ jobParams: { inputJql: '' } });
        }, /Invalid or missing/);
    });

    test('throws when inputJql is missing entirely', function() {
        var v = makeValidator();
        assert.throws(function() {
            v.validateAndRequireTicket({ jobParams: {} });
        }, /Invalid or missing/);
    });

    test('reads inputJql directly from params when jobParams not nested', function() {
        var v = makeValidator(existingTicketMock('PROJ-3'));
        var ticket = v.validateAndRequireTicket({ inputJql: 'key = PROJ-3' });
        assert.equal(ticket.key, 'PROJ-3');
    });

    test('rejects JQL injection attempt in ticket key position', function() {
        var v = makeValidator();
        assert.throws(function() {
            v.validateAndRequireTicket({ jobParams: { inputJql: 'key = PROJ-1 OR project = OTHER' } });
        }, /Invalid or missing/);
    });

});

suite('validateInputJql: ado tracker (wave2d3)', function() {
    test('requireTicketExists uses the injected ado tracker (ado_get_work_item {id}), no jira_get_ticket', function() {
        var adoCalls = [];
        var mocks = {
            ado_get_work_item: function(a) {
                adoCalls.push(a);
                return { id: 7, fields: { 'System.Title': 'T', 'System.State': 'New' } };
            },
            jira_get_ticket: function() { throw new Error('jira_get_ticket must not be called'); }
        };
        var trackers = loadModule('js/common/trackers.js', makeRequire({
            '../config.js': configModule,
            './ticketKeyShapes.js': ticketKeyShapesModule
        }), mocks);
        var v = loadModule('js/common/validateInputJql.js', makeRequire({
            './ticketKeyShapes.js': ticketKeyShapesModule,
            './trackers.js': trackers
        }), mocks);
        var tracker = trackers.createTracker(null, { trackerProvider: 'ado' });
        var t = v.requireTicketExists('7', tracker);
        assert.equal(adoCalls.length, 1);
        assert.equal(String(adoCalls[0].id), '7');
        assert.equal(String(t.key), '7');
    });
});
