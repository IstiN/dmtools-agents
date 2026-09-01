/**
 * Unit tests for js/common/validateInputJql.js
 *
 * Covers: extractTicketKeyFromJql, validateTicketKeyFormat,
 *         requireTicketExists, validateAndRequireTicket.
 */

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeValidator(jiraGetTicketMock) {
    return loadModule(
        'js/common/validateInputJql.js',
        makeRequire({}),
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

// ── validateTicketKeyFormat ───────────────────────────────────────────────────

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
