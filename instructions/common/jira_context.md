**IMPORTANT** When the active tracker is Jira, check child tickets and parent story via the following command to get better context (for other trackers, use the active tracker's search/context command from the tracker-specific instructions): dmtools jira_search_by_jql <<EOF
{
  "jql": "parent = TICKET-XXX OR key = PARENT-KEY"
}
EOF

