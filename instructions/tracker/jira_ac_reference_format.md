# Solution Design AC Referencing — Jira Format

When referencing BA ticket in Jira wiki markup, use the link syntax:

*AC Coverage:*
All Acceptance Criteria are defined in \[BA\] ticket [PROJ-45|https://your-jira.atlassian.net/browse/PROJ-45]. Below is how each AC maps to the solution:
- AC1 (QR Code Button Display) → Addressed by AccountScreen component via new QRCodeButton widget
- AC2 (QR Code Dialog Content) → Addressed by QRCodeDialog component using QRGenerator service
- AC3 (QR Code Generation) → Addressed by QRGenerator service with email-to-QR encoding
- AC4 (Error Handling) → Addressed by ErrorHandler with analytics event tracking
