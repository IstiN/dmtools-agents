/**
 * Restore Jira ticket description from changelog history.
 * Merges the last large "before accident" version with any unique content
 * found in the current (accidentally overridden) version.
 *
 * params.ticketKey  - Jira issue key, e.g. "MAPC-6815"
 */
function action(params) {
    var ticketKey = params.ticketKey || "MAPC-6815";

    // ── 1. Fetch the full changelog ──────────────────────────────────────────
    var changelogUrl = "https://postnl.atlassian.net/rest/api/3/issue/" + ticketKey + "/changelog?maxResults=100";
    var changelog = jira_execute_request(changelogUrl);

    if (!changelog || !changelog.values) {
        return { success: false, error: "Could not fetch changelog" };
    }

    // ── 2. Collect all description changes in order ──────────────────────────
    var descChanges = [];
    var values = changelog.values;
    for (var i = 0; i < values.length; i++) {
        var entry = values[i];
        var items = entry.items || [];
        for (var j = 0; j < items.length; j++) {
            var item = items[j];
            if (item.field === "description") {
                descChanges.push({
                    created:    entry.created,
                    author:     entry.author ? entry.author.displayName : "unknown",
                    fromString: item.fromString || "",
                    toString:   item.toString   || ""
                });
            }
        }
    }

    if (descChanges.length === 0) {
        return { success: false, error: "No description changes found in changelog" };
    }

    // ── 3. Identify key versions ─────────────────────────────────────────────
    // Current description = last change's toString
    var currentDesc = descChanges[descChanges.length - 1].toString;

    // Find the largest description ever stored (the "golden" version before accidents)
    var goldenDesc = "";
    for (var k = 0; k < descChanges.length; k++) {
        var candidate = descChanges[k].toString;
        if (candidate.length > goldenDesc.length) {
            goldenDesc = candidate;
        }
        candidate = descChanges[k].fromString;
        if (candidate.length > goldenDesc.length) {
            goldenDesc = candidate;
        }
    }

    // ── 4. Merge: take golden version, append unique lines from current ───────
    // Split both into lines for comparison
    var goldenLines = goldenDesc.split("\n");
    var currentLines = currentDesc.split("\n");

    // Find lines in currentDesc that are NOT present in goldenDesc
    var uniqueLines = [];
    for (var m = 0; m < currentLines.length; m++) {
        var line = currentLines[m].trim();
        if (line.length > 0 && goldenDesc.indexOf(currentLines[m].trim()) === -1) {
            uniqueLines.push(currentLines[m]);
        }
    }

    var mergedDesc = goldenDesc;
    if (uniqueLines.length > 0) {
        // Insert unique lines just before the first horizontal rule separator
        var sepIdx = mergedDesc.indexOf("----");
        var uniqueBlock = "\n" + uniqueLines.join("\n") + "\n";
        if (sepIdx !== -1) {
            mergedDesc = mergedDesc.substring(0, sepIdx) + uniqueBlock + "\n" + mergedDesc.substring(sepIdx);
        } else {
            mergedDesc = mergedDesc + uniqueBlock;
        }
    }

    // ── 5. Update the ticket description ────────────────────────────────────
    var updateResult = jira_update_ticket(ticketKey, {
        fields: { description: mergedDesc }
    });

    return {
        success: true,
        ticketKey: ticketKey,
        goldenLength: goldenDesc.length,
        currentLength: currentDesc.length,
        mergedLength: mergedDesc.length,
        uniqueLinesAdded: uniqueLines.length,
        uniqueLines: uniqueLines,
        updateResult: updateResult
    };
}
