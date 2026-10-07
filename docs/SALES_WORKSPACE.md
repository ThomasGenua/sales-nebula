# Sales workspace

The sales workspace adds My Day, a pipeline board, saved list views, a report builder, a sequence editor, Outlook conversations, and creation from related lists.

## My Day and the pipeline

- **My Day** separates overdue activities, today's activities, owned leads still marked New, and owned open deals with no visible pending activity or no update for 14 days. Lists are paginated and honor record access. Calendar due dates and timed activities use the browser's day boundaries appropriately.
- Complete an activity and schedule its follow-up together. Both writes commit together and run the existing validation, audit, and automation rules. Calls and tasks can be linked to leads as well as contacts, accounts, and deals.
- **Pipeline** has one column per stage, 25 cards per page, stage age, next action, and amounts separated by currency. Drag a card or use its keyboard-accessible stage selector. Updates use the existing deal rules and stale-version checks.
- Save filters on the pipeline and core list pages. Private views belong to their creator; shared definitions do not grant access to additional records.
- **Related** cards have New buttons when the user may edit the related module. The creation dialog identifies the parent and preserves the relationship.

## Reports

Choose a module, columns, filters, grouping, measures, sorting, and a detail-row limit. Save private or shared definitions. Summary charts and rows drill into the underlying accessible records; individual results open the record. CSV export exports the displayed rows, with spreadsheet formula prefixes escaped.

Starter definitions cover pipeline by stage/currency, rep performance, and win/loss. Sales performance shows closed-deal win rate, recorded sales-cycle duration, and observed stage progression. Progression is based on current stages and recorded visits, not an inferred funnel. Missing stage history is not invented. Monetary starter reports group by currency.

## Sequences

Create email steps with whole-day delays, template content, and reordering. Save, activate, pause, enroll accessible contacts/leads, and stop individual enrollments. A running enrollment's steps cannot be changed; stop its active enrollments first. Drafts may be incomplete, but activation requires a subject and body (or valid template) for every step.

Sequences use the existing SMTP worker. Configure SMTP before delivery; the screen shows when it is unavailable. Activation/enrollment authorize later scheduled sending. Enrollment rows show status, next send date, last successful send, and delivery failure details. The existing suppression list still applies. Outlook connection does not configure sequence SMTP. Automatic sequence stop-on-reply and a campaign unsubscribe-link flow are not part of this editor.

## Outlook setup

1. Register a Microsoft identity application with a **Web** redirect URI equal to `FRONTEND_URL` plus `/app/mailbox` (the page displays the exact URL).
2. Configure `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, and optionally `MICROSOFT_TENANT_ID`. Keep the existing stable mail encryption secret configured across restarts.
3. Grant delegated `User.Read`, `Mail.Read`, `Mail.Send`, and `offline_access`; organization policy may require administrator consent.
4. In **Mailbox**, add a mailbox and choose **Connect Outlook**. Consent uses a ten-minute, single-use state bound to the signed-in owner, plus PKCE. Tokens are encrypted on the server.
5. Choose **Sync now**. Initial sync covers the last 30 days in Inbox and Sent Items. Each run imports up to 100 messages per folder and follows Microsoft's stored pagination cursor on later runs. The existing mailbox scheduler continues polling when enabled.

Only the owner can read, link, sync, disconnect, or reply through a personal mailbox. The shared support inbox excludes personal mailboxes. Reconnecting must use the same Outlook address; add another mailbox for another address. Disconnecting removes credentials but keeps imported conversations.

Unique visible contacts are matched by email; a single visible open deal on that contact is associated automatically. Ambiguous matches stay unlinked. Users can change links for the conversation. Linked mail appears on contact and deal pages for the mailbox owner. Sent Items sync marks older incoming messages in the same conversation as answered, including replies made outside the CRM. Messages render as plain text. Attachments and remote mailbox deletions/moves are not synchronized. A conversation displays its latest 100 messages and discloses that limit.

Reference: [Microsoft Graph message listing and pagination](https://learn.microsoft.com/en-us/graph/api/user-list-messages?view=graph-rest-1.0), [Microsoft authorization-code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow).

## Deployment and verification

Apply the normal Prisma migrations before starting the updated server, generate the client, and rebuild the frontend. The additive migration adds activity lead links, private mailbox ownership/consent/cursor fields, conversation associations, and sequence delivery details. No production data is reseeded.

`tests/salesWorkspace.test.js` covers queue boundaries, pagination, row permissions, atomic follow-ups, pipeline history, reports, sequences, and mocked Microsoft consent/sync/replies. `e2e/productivity.spec.js` covers the main browser journeys. Use a disposable PostgreSQL database whose name includes `test`; the test harness clears it. Live Microsoft consent requires real application credentials and a mailbox owner's consent and is not simulated as a successful live connection by these tests.
