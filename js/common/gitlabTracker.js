function createGitlabTracker(options) {
    var owner = options.owner;
    var repo = options.repo;

    function issueNumber(key) {
        var k = String(key == null ? '' : key).trim();
        var n = options.ticketKeyShapes.gitlabIssueNumberIn(k);
        if (n === null) {
            throw new Error('trackers: cannot parse GitLab issue key: ' + key);
        }
        return n;
    }

    function issueArgs(key) {
        var k = String(key == null ? '' : key).trim();
        var m = /^((?:[\w.-]+\/)*[\w.-]+)\/([\w.-]+)#(\d+)$/.exec(k);
        if (m) {
            return { workspace: m[1], repository: m[2], issueNumber: m[3] };
        }
        var args = { issueNumber: String(issueNumber(k)) };
        if (owner) args.workspace = owner;
        if (repo) args.repository = repo;
        return args;
    }

    function getTicket(key) {
        return options.normalizeTicket(gitlab_get_issue(issueArgs(key)));
    }

    function search(query) {
        return options.ticketPage(requireArrayPage(gitlab_search_issues({
            query: query,
            workspace: owner || undefined,
            repository: repo || undefined
        }), 'gitlab_search_issues', options.parseJson));
    }

    function withIssueArgs(key, values) {
        return Object.assign(values, issueArgs(key));
    }

    function postComment(key, comment) {
        return gitlab_create_issue_comment(withIssueArgs(key, { body: comment }));
    }

    function getComments(key) {
        return options.commentPage(requireArrayPage(gitlab_get_issue_comments(issueArgs(key)), 'gitlab_get_issue_comments', options.parseJson));
    }

    function requireArrayPage(raw, tool, parseJson) {
        var page = parseJson(raw);
        if (!Array.isArray(page)) {
            throw new Error('trackers: ' + tool + ' returned an unexpected page; expected an array');
        }
        return page;
    }

    function addLabel(key, label) {
        return gitlab_add_issue_label(withIssueArgs(key, { label: label }));
    }

    function removeLabel(key, label) {
        return gitlab_remove_issue_label(withIssueArgs(key, { label: label }));
    }

    function moveToStatus(key, status) {
        var s = String(status || '').trim();
        if (!s) {
            throw new Error('trackers: cannot map GitLab status: ' + status);
        }
        return gitlab_move_issue_to_status(withIssueArgs(key, { statusName: s }));
    }

    function assignTo(key, user) {
        return gitlab_assign_issue(withIssueArgs(key, { user: user }));
    }

    function createTicket(project, type, title, description) {
        var t = options.normalizeTicket(gitlab_create_issue({
            workspace: owner || undefined,
            repository: repo || undefined,
            title: title,
            body: description
        }));
        return t ? t.key : null;
    }

    return {
        getTicket: getTicket,
        search: search,
        postComment: postComment,
        getComments: getComments,
        addLabel: addLabel,
        removeLabel: removeLabel,
        moveToStatus: moveToStatus,
        assignTo: assignTo,
        createTicket: createTicket,
        getIssue: function (key) { return options.toIssueView(getTicket(key)); },
        searchIssues: function (query) {
            return search(query).map(function (n) { return options.toIssueView(n); });
        },
        linkIssues: function () { options.unsupported('linkIssues'); },
        updateField: function () { options.unsupported('updateField'); },
        updateDescription: function () { options.unsupported('updateDescription'); },
        setPriority: function () { options.unsupported('setPriority'); },
        attachFile: function () { options.unsupported('attachFile'); },
        fieldCode: function () { return null; },
        createTicketWithParent: function () { options.unsupported('createTicketWithParent'); },
        createTicketWithFields: function () { options.unsupported('createTicketWithFields'); },
        listChildTickets: function () { options.unsupported('listChildTickets'); }
    };
}

function assigneeName(fields) {
    var candidates = [fields.assignee, fields.assignments, fields['System.AssignedTo']];
    for (var i = 0; i < candidates.length; i++) {
        var name = assigneeCandidateName(candidates[i]);
        if (name) return name;
    }
    return null;
}

function assigneeCandidateName(candidate) {
    if (!candidate) return null;
    if (typeof candidate === 'string') return candidate;
    var names = ['displayName', 'login', 'username', 'uniqueName', 'accountId', 'name'];
    for (var i = 0; i < names.length; i++) {
        if (candidate[names[i]]) return candidate[names[i]];
    }
    return null;
}

function issueShape(ticket) {
    if (ticket.iid !== undefined) {
        return { number: ticket.iid, prefix: 'gl-', description: 'description', url: 'web_url' };
    }
    if (ticket.number !== undefined) {
        return { number: ticket.number, prefix: '#', description: 'body', url: 'html_url' };
    }
    return null;
}

function issueKey(ticket, options, shape) {
    if (options.owner && options.repo) {
        return options.owner + '/' + options.repo + '#' + shape.number;
    }
    return ticket.key != null ? String(ticket.key) : shape.prefix + shape.number;
}

function normalizeOtherProviderTicket(ticket, options) {
    var shape = issueShape(ticket);
    if (!shape) return null;
    return options.flatTicket(
        issueKey(ticket, options, shape),
        ticket.id != null ? String(ticket.id) : null,
        ticket.title || null,
        ticket.state || null,
        options.assigneeName(ticket),
        options.labelNames(ticket.labels),
        ticket[shape.description] || null,
        ticket[shape.url] || null
    );
}

module.exports = {
    create: createGitlabTracker,
    normalizeTicket: normalizeOtherProviderTicket,
    assigneeName: assigneeName
};
