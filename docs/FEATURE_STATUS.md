# Feature status

What Sales Nebula does today, checked against the code in October 2026.
When a change makes a line here wrong, fix the line in the same pull request.

Sales Nebula is a working CRM for accounts, contacts, leads, deals, quotes,
invoices and cases, with the rules, approvals and automation around them. It
is not a Salesforce replacement feature for feature. Earlier releases claimed
"132/132 Salesforce feature parity"; that claim was wrong and is withdrawn.
Many modules from those releases store configuration that nothing acts on yet.

Something can be missing in three ways:

- **Answers 501.** The action is in the API, but nothing would carry it out,
  so it refuses with HTTP 501, a `code` naming the feature, and a sentence
  saying what did not happen. Nothing is changed. The screens for these say
  so on the page.
- **Stored only.** The configuration can be saved, and nothing reads it.
- **Not built.** There is no API or screen for it.

## Works

| Area | What works |
|---|---|
| Records | Accounts, contacts, leads, deals, activities, cases, products, quotes, invoices, orders, contracts and the other standard modules: lists with search, column filters and paging; record pages; create, edit, delete to the recycle bin, restore. Accounts, contacts, deals and quotes have a **Related** tab. |
| Rules on every save | Every create, update and delete of a module's records goes through one write path, whether it comes from a screen, import, the bulk API, mass actions, mobile sync, a conversion or a job. Validation rules run before every create and update, and duplicate and assignment rules before every create; audit, workflows and webhooks run after the write (`src/services/recordWrites.js`). |
| Access | Roles with read, edit or full access per module. Row-level security from record owners, the role hierarchy, org-wide defaults, sharing rules, record shares and security groups. Nobody can grant more access than they hold. |
| Users | The **Users** screen: invite, edit, deactivate, reactivate, send a password reset, resend or revoke an invite. Public sign-up requests are reviewed under **Access requests**. |
| Sign-in | Password, with account lockout; authenticator-app (TOTP) two-factor; API keys; Sales Nebula as an OAuth 2.0 provider for connected apps (authorization code with PKCE); Google and Microsoft sign-in APIs for existing accounts, which the sign-in page does not offer yet. |
| Approvals | Multi-step processes. A step's approvers are a user, a role, the submitter's manager or a queue, and the first to decide settles the step. Entry conditions, and final approve and reject actions. Processes are set up through the API; the **Approvals** screen lists pending requests to approve or reject. |
| Workflows | Run on create, update, status change and on a schedule. Actions: update a field, create a task, notify, send an email; other action types are ignored. They are set up through the API: the screen has no condition or action editor. |
| Email | One email at a time over SMTP when `SMTP_HOST` is set, or from a connected Microsoft mailbox through Microsoft Graph. Sequences send their due steps every 10 minutes when SMTP is set up, as written (no merge fields). Mail arriving in a connected Microsoft mailbox opens cases or leads, and replies thread onto their case. |
| Webhooks | Outbound, signed with HMAC-SHA256, retried, with delivery logs. |
| Quotes and invoices | Line items and totals, discounts, accept, invoice from a quote, convert to an order, versions. They print from the browser as HTML: no PDF file is generated. |
| Forecasts | Built from the owner's open deals in the period and refreshed every 4 hours; quotas are entered by hand. Deals that move into the period later are not added. |
| Reports | Running a report returns real rows and totals, limited to what the viewer may see. The API exports CSV or JSON. |
| Calendar, projects, SLA | Recurring events with invitees and an iCal feed; projects with a critical path; SLA timers that count business hours only. |
| Search | Global search across modules, matching substrings. |
| Collaboration | Chatter posts with likes and comments; notes; tags; favorites. |
| Data | CSV import with per-row errors; the bulk API; mass actions; the recycle bin. |
| AI Copilot | Answers questions with Claude when `ANTHROPIC_API_KEY` is set. |

## Limited

| Area | What it does | What it does not do |
|---|---|---|
| AI Copilot without a key | Answers from fixed rules using your open deals, cases and activities; the screen says so under each answer. | `/api/copilot/chat` answers 503. Conversation threads exist in the API only. |
| Lead scoring | Scores leads by your rules. Not AI. | Runs by itself only for leads from the web-to-lead form; other leads are scored on request (`POST /api/leads/:id/score`). |
| Deal prediction, call analysis | Deal prediction uses stage weights. Call analysis matches keywords in a transcript you supply. | No model, no recording upload, no transcription. |
| Reports | Tabular, summary and chart reports, and report folders. | Scheduled delivery (501). "Matrix" runs as a summary, and joins are ignored. Export gives the raw rows, not the totals. There is no report builder screen. |
| Analytics | Overview, ad-hoc query, funnel, cohort and activity effectiveness. | A dataset's refresh only counts rows; saved dashboards are layouts nothing displays. |
| Campaigns | Planning, members, recipients, responses, ROI. Attribution models computed from the campaign touches you enter. | Bulk sending (501). Nothing creates touches from campaign members. |
| Import | CSV files, with columns matched by name. | Excel. A column-mapping screen (the API takes a mapping). |
| Export | CSV and JSON. | Excel. Scheduled exports are saved and never run. |
| Custom objects | Define objects and fields, and store records, through the API. | Records are not checked against their field definitions. The screen edits object definitions only: no fields or records. |
| Custom fields (Studio) | Field definitions, picklists, and validation rules, which apply on every save. | Values cannot be stored (501), and no form, list, report or export shows custom fields. |
| Formula fields | Evaluated on request (`/api/formulas/evaluate`). | Not computed on records; no cross-object references; no screen. |
| Sharing | Org-wide defaults, the role hierarchy, owner- and criteria-based rules, record shares. | `externalAccess`, `manual` rules and the `criteria` grant mode are saved and do nothing. |
| Platform events | Published events are stored and sent to webhooks registered for `platform.<channel>`. | A subscription's own endpoint and secret are unused, and nothing in the app publishes events. |
| Territories | A territory hierarchy; accounts mapped to territories by hand. | Assignment rules never run. Territory models can only be listed. |
| Omnichannel | "Least Active" routing gives work to the available agent with the fewest open items. | Other routing types assign nothing; agent capacity and skills are not checked. |
| Entitlements | Case counts per entitlement. | Milestones are stored only; the SLA view uses fixed hours per priority; consuming an entitlement changes nothing. |
| Knowledge | Articles, categories, search, publishing. A new version is a copy of the article. | Attachments. Versions are not linked to each other. |
| CPQ | Bundles, price books, discount tiers, guided selling. | Price rules never apply. Product rules are checked only by `POST /api/cpq/advanced/validate-quote`. |
| Macros | Update a field; add a comment to a case. | Any other action reports that it was not done. Scheduling (501). |
| Field service | Work orders: dispatch, schedule (dates and assignee), complete, cancel. | No conflict check, appointments or line items. The "route" is the day's work orders in start order. |
| Customer data platform | A contact's live profile (lifetime value, engagement) and segment evaluation over contacts. | Stored profiles' scores are never computed. Ingesting data (501). |
| Integrations | Stores configuration and field mappings. | Sync, connection tests and sync schedules (501). |
| Inbound email | Microsoft mailboxes through Graph; IMAP and POP3 accounts with encrypted passwords. | IMAP and POP3 need an outside worker to fetch mail. Replies go only from Microsoft mailboxes (501 otherwise). |
| Email status | "sent" when a mail server took the message. | Without SMTP an email is logged and shown as **not sent**; nothing sends it later. Opens are not tracked. |
| Sales path, person accounts | Work through the API. | No screens. |
| Full-text search index | Ranked search with phrase, exclusion and field syntax (`/api/search-index`). | It is filled by explicit indexing calls, not when a record is saved, so it falls behind; the app's search box does not use it. |
| Audit log | Every record write through the write path, and the actions routes log themselves. | Entries are deleted after 90 days. Some administrative changes are not audited (deleting a user, MFA and SSO settings, `/api/configuration`, flows, saved views, CDP, platform events), and a write with no signed-in user, such as a web form or a job, records no entry. |
| Monitoring | Login history, and sign-in figures for the last 24 hours. | Nothing writes event logs, so event lists are empty and API-call and error counts read 0. |
| Recycle bin | Restoring a deleted record within 30 days. | The deleted row stays in its table until an administrator purges deleted records. No search. |
| Duplicate rules | Checked when a record is created; merge for contacts, leads and accounts. | Not checked on update. `auto_merge` only warns. |
| Consent | Consent per contact and type, for signed-in users. | No public opt-out or unsubscribe link. |
| Customer portal | One configuration with branding; portal logins for contacts, created by an administrator. | Self-registration; portals for partners or employees (the portal type is a label). |
| Timeline | A record's own activities, emails, notes, cases, changes and posts. | Items from child records (an account's contacts or deals); quotes, invoices and events. |
| Scheduler | Booking with an overlap check, and cancellation. | Open slots assume 9 to 5 in server time and offer one slot per free gap; editing skips the overlap check; "availability" only says who is busy now. |
| Currencies | One exchange rate per currency; deal totals converted in dashboards and forecasts. | Only deals have a currency, and reports add up unconverted amounts. No rate history. |
| Revenue recognition | Schedules split evenly by month. | Periods are recognized by hand; the recognition method is ignored. |
| Flows | Flows can be designed and saved. | Nothing runs them: run, test, activate and publish (501). |
| AI agents | Agents can be configured and saved. | No model is called with an agent's settings: run, activate and training (501). |
| Custom code | Code can be saved, and its syntax checked. | Custom code never runs: activate and schedule (501). |
| Sandboxes | The list, and metadata export. | Create, deploy, change sets, import, rollback and compare (501). |
| Marketplace | A catalog to browse, with reviews. | Installing an app (501). |
| Security settings | Field permissions and encryption policies saved before can be listed. | Saving IP rules, field permissions or encryption policies, and rotating keys (501): nothing would enforce them. |

## Stored only

Saving these changes nothing:

- Record types and page layouts, in `/api/configuration` and in Studio's layouts
- Custom components (nothing renders them)
- Report types
- Analytics dashboards
- Territory assignment rules and entitlement milestones
- CPQ price rules
- Omnichannel agent capacity and skills

## Answers 501

| Feature | Endpoints | Code |
|---|---|---|
| Flows | `POST /api/flows/:id/run`, `/test`, `/activate`, `/publish` | `FLOWS_UNAVAILABLE` |
| Sandboxes | `POST /api/environments`, `/:id/deploy`, `/:id/rollback`, `/change-sets`, `/metadata/import`; `GET /api/environments/:id/compare` | `SANDBOXES_UNAVAILABLE` |
| AI agents | `POST /api/ai-agents/:id/run`, `/activate`; `PUT /api/ai-agents/:id/training` | `AI_AGENTS_UNAVAILABLE` |
| AI lead scoring | `POST /api/ai/leads/batch-score` | `AI_LEAD_SCORING_UNAVAILABLE` |
| Custom code | `POST /api/custom-code/:id/activate`, `/schedule` | `CUSTOM_CODE_UNAVAILABLE` |
| Marketplace | `POST /api/marketplace/:id/install` | `APP_INSTALL_UNAVAILABLE` |
| Dialer | `POST /api/conversation-intelligence/dialer/call` | `DIALER_UNAVAILABLE` |
| Mobile | `POST /api/mobile/push`; `POST /api/mobile/sync/resolve` | `PUSH_UNAVAILABLE`, `CONFLICT_RESOLUTION_UNAVAILABLE` |
| Macros | `POST /api/macros/:id/schedule` | `MACRO_SCHEDULE_UNAVAILABLE` |
| Customer data platform | `POST /api/cdp/streams/:id/ingest` | `CDP_INGEST_UNAVAILABLE` |
| IP rules | `POST /api/security/ip-rules` | `IP_RULES_UNAVAILABLE` |
| Field-level security | `POST /api/configuration/field-permissions`, `/bulk` | `FIELD_SECURITY_UNAVAILABLE` |
| Encryption | `POST /api/security/encryption/policies`, `PUT /api/security/encryption/policies/:id`, `POST /api/security/encryption/rotate-key` | `ENCRYPTION_UNAVAILABLE` |
| SMS and email sign-in codes | `POST /api/security/mfa/challenge` | `MFA_CODE_DELIVERY_UNAVAILABLE` |
| Scheduled reports | `POST /api/reports/:id/schedule`; `POST /api/analytics/scheduled-reports` | `REPORT_DELIVERY_UNAVAILABLE` |
| Integration sync schedules | `PUT /api/integrations/:id/schedule` | `INTEGRATION_SYNC_UNAVAILABLE` |
| Quote approval shortcut | `POST /api/quotes/:id/submit-approval` (use an approval process) | `QUOTE_APPROVAL_UNAVAILABLE` |
| Custom field values | `PUT /api/studio/values/:module/:recordId` | `CUSTOM_FIELD_VALUES_UNAVAILABLE` |
| Campaign sending | `POST /api/campaigns/:id/send` | `CAMPAIGN_DELIVERY_UNAVAILABLE` |
| SSO sign-in | `POST /api/security/sso/login` | none; the error says so |
| Integration sync and tests | `POST /api/integrations/:id/sync`, `/test` | none; the error says so |
| Mail from other mailboxes | `POST /api/inbound-email/messages/:id/reply` and `POST /api/emails/send` naming a mailbox that is not Microsoft | none; the error says so |

`tests/unavailableFeatures.test.js` checks each refusal from `FLOWS_UNAVAILABLE` to `CUSTOM_FIELD_VALUES_UNAVAILABLE`, and that nothing changed; `tests/securityHardening.test.js` checks campaign sending.

## Not built

- Mail and calendar sync with Gmail or Outlook. Only the Microsoft mailbox connection exists.
- E-signature.
- Slack or Teams.
- PDF files of quotes and invoices; they print from the browser.
- A Kanban board for deals.
- A screen for saved list views (the API, `/api/views`, exists).
- A report builder screen.
- A mobile app (the `/api/mobile` endpoints exist).
- Multi-tenancy: one install serves one company.
- A visual flow designer, and anything that runs flows.
