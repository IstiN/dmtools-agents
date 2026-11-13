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
        return options.ticketPage(gitlab_search_issues({
            query: query,
            workspace: owner || undefined,
            repository: repo || undefined
        }));
    }

    function withIssueArgs(key, values) {
        return Object.assign(values, issueArgs(key));
    }

    function postComment(key, comment) {
        return gitlab_create_issue_comment(withIssueArgs(key, { body: comment }));
    }

    function getComments(key) {
        return options.commentPage(gitlab_get_issue_comments(issueArgs(key)));
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

function normalizeOtherProviderTicket(ticket, options) {
    var gitlab = ticket.iid !== undefined;
    if (!gitlab && ticket.number === undefined) return null;
    var number = gitlab ? ticket.iid : ticket.number;
    var key = options.owner && options.repo
        ? options.owner + '/' + options.repo + '#' + number
        : ticket.key != null ? String(ticket.key) : (gitlab ? 'gl-' : '#') + number;
    return options.flatTicket(
        key,
        ticket.id != null ? String(ticket.id) : null,
        ticket.title || null,
        ticket.state || null,
        options.assigneeName(ticket),
        options.labelNames(ticket.labels),
        gitlab ? ticket.description || null : ticket.body || null,
        gitlab ? ticket.web_url || null : ticket.html_url || null
    );
}

module.exports = {
    create: createGitlabTracker,
    normalizeTicket: normalizeOtherProviderTicket
};
