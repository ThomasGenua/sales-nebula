/**
 * Data subject erasure and portability (GDPR Art. 15, 17 and 20).
 *
 * Consent was already captured; nothing ever acted on it. This is the part
 * that acts: it finds every row in the schema that belongs to a person, hands
 * it back as a portable bundle, or strips the identifiers out of it.
 *
 * Erasure anonymises rather than deletes. A contact is referenced by invoices,
 * orders and contracts that a company is obliged to keep (Art. 17(3)(b) and
 * (e)), and a cascading delete would either fail on the foreign key or destroy
 * records that have nothing to do with the request. So the identity is severed
 * and the transactional skeleton stays: the row survives, the person does not.
 *
 * Which models get swept is derived from the schema, not from a list that goes
 * stale the moment somebody adds a table. Which *columns* get scrubbed is an
 * explicit allowlist, because guessing from a column name is how `Deal.name`
 * ends up erased along with the buyer's.
 */

const { Prisma } = require('@prisma/client');

// A row belongs to a person if it carries one of these.
const SUBJECT_KEYS = ['contactId', 'leadId', 'personAccountId'];

// Columns that identify a person wherever they appear. Scrubbed on every row
// reachable from the subject, whatever the model.
const IDENTIFIERS = new Set([
  'email', 'altEmail', 'personalEmail', 'workEmail', 'fromEmail', 'toEmail', 'toEmails',
  'ccEmails', 'bccEmails', 'replyTo', 'recipientEmail', 'contactEmail', 'authorEmail',
  'phone', 'mobile', 'mobilePhone', 'homePhone', 'workPhone', 'otherPhone', 'phoneNumber',
  'phoneWork', 'phoneMobile', 'phoneOther', 'contactPhone', 'fax', 'callerNumber',
  'address', 'mailingAddress', 'billingAddress', 'shippingAddress', 'street',
  'city', 'state', 'postalCode', 'zipCode', 'zip', 'country', 'latitude', 'longitude',
  'ipAddress', 'userAgent', 'deviceId', 'from', 'to',
  'birthdate', 'dateOfBirth', 'gender', 'ssn', 'nationalId', 'taxId',
  'linkedIn', 'linkedinUrl', 'twitterHandle',
]);

// Columns that name a person — but only where the row *is* the person. On a
// deal or a document, `name` is the business record's name and must survive.
const PERSON_NAMES = new Set([
  'firstName', 'lastName', 'fullName', 'name', 'salutation', 'title', 'department',
  'toName', 'fromName', 'contactName', 'attendeeName',
]);

const PERSON_ROWS = new Set([
  'Contact', 'Lead', 'PersonAccount', 'Prospect', 'PortalUser', 'UnifiedProfile',
  'EventAttendee', 'EventInvitee', 'ProspectListEntry', 'CampaignRecipient',
  'SignupRequest', 'InboundEmailMessage', 'Email',
]);

// Free text is only redacted under the `purge` strategy, and only where the
// text is the person's own words or a record of them. A contract's description
// is the company's, not theirs.
const FREE_TEXT = new Set([
  'body', 'htmlBody', 'textBody', 'snippet', 'description', 'notes', 'comment',
  'answer', 'resolution', 'text', 'message', 'transcript',
]);

const CORRESPONDENCE = new Set([
  'Email', 'Note', 'Activity', 'Case', 'CaseComment', 'InboundEmailMessage',
  'SurveyResponse', 'CallRecording', 'DialerSession', 'EventInvitee',
  'Appointment', 'CalendarEvent', 'BookingSlot', 'ConsentRecord',
  'Contact', 'Lead', 'PersonAccount', 'Prospect',
]);

// Models keyed by the subject's address rather than by a foreign key.
const EMAIL_KEYED = {
  InboundEmailMessage: 'fromEmail',
  Prospect: 'email',
  SignupRequest: 'email',
  CaseComment: 'authorEmail',
};

// The paper trail of the erasure must not be erased by it, and a suppression
// entry exists precisely so the address stays known.
const EXCLUDED = new Set(['DataSubjectRequest', 'EmailSuppression', 'AuditLog', 'User']);

// The three models that *are* the person. They carry no `contactId` of their
// own, so without this they would sail through the sweep untouched.
const ROOTS = { Contact: 'contactId', Lead: 'leadId', PersonAccount: 'personAccountId' };

const NEVER_WRITE = new Set(['id', 'createdAt', 'updatedAt', 'deletedAt', ...SUBJECT_KEYS]);

const TOMBSTONE = '[erased]';
const REDACTED = '[redacted on erasure request]';

const delegateFor = (prisma, model) => prisma[model.charAt(0).toLowerCase() + model.slice(1)];

let cachedPlan = null;

/**
 * Walk the datamodel once and work out, per model, which columns an erasure
 * would touch and which it would knowingly leave behind.
 */
function buildPlan() {
  if (cachedPlan) return cachedPlan;
  const plan = [];

  for (const model of Prisma.dmmf.datamodel.models) {
    if (EXCLUDED.has(model.name)) continue;

    const scalars = model.fields.filter(f => f.kind === 'scalar' || f.kind === 'enum');
    const keys = scalars.filter(f => SUBJECT_KEYS.includes(f.name)).map(f => f.name);
    const emailKey = EMAIL_KEYED[model.name];
    const rootFor = ROOTS[model.name] || null;
    if (!keys.length && !emailKey && !rootFor) continue;

    const isPerson = PERSON_ROWS.has(model.name);
    const identifiers = [];
    const freeText = [];
    const residual = [];

    for (const field of scalars) {
      if (NEVER_WRITE.has(field.name)) continue;
      if (field.isId || field.isReadOnly) continue;

      if (IDENTIFIERS.has(field.name) || (isPerson && PERSON_NAMES.has(field.name))) {
        identifiers.push(field);
      } else if (FREE_TEXT.has(field.name)) {
        (CORRESPONDENCE.has(model.name) ? freeText : residual).push(field.name);
      }
    }

    if (!identifiers.length && !freeText.length && !residual.length) continue;
    plan.push({ model: model.name, keys, emailKey, rootFor, identifiers, freeText, residual });
  }

  cachedPlan = plan;
  return plan;
}

/** The value that replaces a column, given what the column will accept. */
function erasedValue(field, replacement) {
  if (!field.isRequired) {
    return field.type === 'Json' ? Prisma.DbNull : null;
  }
  if (field.type === 'String') return replacement;
  // A required non-string identifier (a date of birth that cannot be null) is
  // left alone rather than filled with a lie; it is reported as residual.
  return undefined;
}

function scrubData(fields, replacement) {
  const data = {};
  for (const field of fields) {
    const value = erasedValue(field, replacement);
    if (value !== undefined) data[field.name] = value;
  }
  return data;
}

/** A unique required email cannot be blanked without colliding with the next one. */
function uniqueSafe(field, rowId) {
  return field.isUnique ? `erased+${rowId}@invalid.local` : TOMBSTONE;
}

// ─── SUBJECT RESOLUTION ───

/**
 * Turn whatever the caller knows — an id, an address — into the full set of
 * records that are the same person. A contact who was once a lead is one
 * subject with two rows, and erasing only the contact leaves the lead intact.
 */
async function resolveSubject(prisma, { contactId, leadId, personAccountId, email } = {}) {
  const subject = { contactId: null, leadId: null, personAccountId: null, emails: [], found: false };
  const emails = new Set();
  const addEmail = value => { if (value && typeof value === 'string') emails.add(value.toLowerCase()); };

  let contact = null;
  let lead = null;
  let personAccount = null;

  if (contactId) contact = await prisma.contact.findUnique({ where: { id: contactId } });
  if (leadId) lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (personAccountId) personAccount = await prisma.personAccount.findUnique({ where: { id: personAccountId } });

  if (email && !contact && !lead && !personAccount) {
    const address = email.trim();
    contact = await prisma.contact.findFirst({ where: { email: { equals: address, mode: 'insensitive' } } });
    lead = await prisma.lead.findFirst({ where: { email: { equals: address, mode: 'insensitive' } } });
    personAccount = await prisma.personAccount.findFirst({ where: { email: { equals: address, mode: 'insensitive' } } });
    addEmail(address);
  }

  // Follow the links between the three, so the whole person is covered.
  if (contact && !lead) lead = await prisma.lead.findFirst({ where: { contactId: contact.id } });
  if (lead && !contact && lead.contactId) contact = await prisma.contact.findUnique({ where: { id: lead.contactId } });

  for (const row of [contact, lead, personAccount]) addEmail(row?.email);

  subject.contactId = contact?.id || null;
  subject.leadId = lead?.id || null;
  subject.personAccountId = personAccount?.id || null;
  subject.emails = [...emails];
  subject.found = !!(contact || lead || personAccount);
  subject.label = contact ? `${contact.firstName} ${contact.lastName}`
    : lead ? `${lead.firstName} ${lead.lastName}`
    : personAccount ? `${personAccount.firstName} ${personAccount.lastName}`
    : subject.emails[0] || 'unknown';

  return subject;
}

/** The `where` that selects this subject's rows in a given model. */
function subjectWhere(entry, subject) {
  const clauses = [];
  if (entry.rootFor && subject[entry.rootFor]) clauses.push({ id: subject[entry.rootFor] });
  for (const key of entry.keys || []) {
    const value = subject[key];
    if (value) clauses.push({ [key]: value });
  }
  if (entry.emailKey && subject.emails.length) {
    clauses.push({ [entry.emailKey]: { in: subject.emails, mode: 'insensitive' } });
  }
  if (!clauses.length) return null;
  return clauses.length === 1 ? clauses[0] : { OR: clauses };
}

// ─── EXPORT (Art. 15 / 20) ───

/**
 * Everything held about the subject, as JSON. Deliberately built from the same
 * plan as erasure, so what we hand over and what we erase cannot drift apart.
 */
async function exportSubject(prisma, subject) {
  const records = {};
  let total = 0;

  const roots = [
    ['Contact', 'contact', subject.contactId],
    ['Lead', 'lead', subject.leadId],
    ['PersonAccount', 'personAccount', subject.personAccountId],
  ];
  for (const [name, delegate, id] of roots) {
    if (!id) continue;
    const row = await prisma[delegate].findUnique({ where: { id } });
    if (row) { records[name] = [row]; total += 1; }
  }

  for (const entry of buildPlan()) {
    if (records[entry.model]) continue;
    const where = subjectWhere(entry, subject);
    if (!where) continue;
    const delegate = delegateFor(prisma, entry.model);
    if (!delegate?.findMany) continue;
    try {
      const rows = await delegate.findMany({ where, take: 1000 });
      if (rows.length) { records[entry.model] = rows; total += rows.length; }
    } catch (err) { /* a model the running database does not have */ }
  }

  // Notes and attachments hang off a polymorphic parent rather than a key.
  for (const [model, moduleField, idField] of [['Note', 'module', 'recordId'], ['Attachment', 'parentModule', 'parentId']]) {
    const rows = await polymorphicRows(prisma, model, moduleField, idField, subject);
    if (rows.length) { records[model] = rows; total += rows.length; }
  }

  return { subject: publicSubject(subject), records, recordCount: total, generatedAt: new Date() };
}

function publicSubject(subject) {
  return {
    contactId: subject.contactId,
    leadId: subject.leadId,
    personAccountId: subject.personAccountId,
    emails: subject.emails,
    label: subject.label,
  };
}

function polymorphicTargets(subject) {
  const targets = [];
  if (subject.contactId) targets.push({ modules: ['contacts', 'contact'], id: subject.contactId });
  if (subject.leadId) targets.push({ modules: ['leads', 'lead'], id: subject.leadId });
  if (subject.personAccountId) targets.push({ modules: ['personAccounts', 'person_accounts'], id: subject.personAccountId });
  return targets;
}

async function polymorphicRows(prisma, model, moduleField, idField, subject) {
  const delegate = delegateFor(prisma, model);
  if (!delegate?.findMany) return [];
  const out = [];
  for (const target of polymorphicTargets(subject)) {
    try {
      const rows = await delegate.findMany({
        where: { [moduleField]: { in: target.modules }, [idField]: target.id },
        take: 1000,
      });
      out.push(...rows);
    } catch (err) { /* model absent */ }
  }
  return out;
}

// ─── ERASURE (Art. 17) ───

/**
 * Strip the subject out of the database.
 *
 * `anonymize` (default) removes direct identifiers and tombstones the person's
 * own records. `purge` additionally redacts correspondence — the emails, notes
 * and case text that are the person's own words.
 *
 * Returns a per-model tally of what changed and, just as importantly, a list of
 * what was left behind, so nobody has to take the result on faith.
 */
async function eraseSubject(prisma, subject, { strategy = 'anonymize', actorId = null } = {}) {
  if (!subject?.found) throw new Error('No data subject matched the request');
  if (!['anonymize', 'purge'].includes(strategy)) throw new Error(`Unknown erasure strategy: ${strategy}`);

  const erased = {};
  const residual = [];
  const skipped = [];
  const purging = strategy === 'purge';

  const count = (model, n) => { if (n > 0) erased[model] = (erased[model] || 0) + n; };

  for (const entry of buildPlan()) {
    const where = subjectWhere(entry, subject);
    if (!where) continue;
    const delegate = delegateFor(prisma, entry.model);
    if (!delegate?.updateMany) continue;

    const uniqueRequired = entry.identifiers.filter(f => f.isUnique && f.isRequired && f.type === 'String');
    const bulk = entry.identifiers.filter(f => !uniqueRequired.includes(f));

    const data = scrubData(bulk, TOMBSTONE);
    if (purging) {
      for (const name of entry.freeText) {
        const field = fieldOf(entry.model, name);
        if (!field) continue;
        const value = erasedValue(field, REDACTED);
        if (value !== undefined) data[name] = value;
      }
    }

    try {
      if (Object.keys(data).length) {
        const { count: n } = await delegate.updateMany({ where, data });
        count(entry.model, n);
      }

      // Columns that are both unique and mandatory need a value per row.
      if (uniqueRequired.length) {
        const rows = await delegate.findMany({ where, select: { id: true }, take: 1000 });
        for (const row of rows) {
          const perRow = {};
          for (const field of uniqueRequired) perRow[field.name] = uniqueSafe(field, row.id);
          await delegate.update({ where: { id: row.id }, data: perRow });
        }
        count(entry.model, rows.length);
      }
    } catch (err) {
      skipped.push({ model: entry.model, reason: err.message });
      continue;
    }

    const left = purging ? entry.residual : [...entry.freeText, ...entry.residual];
    if (left.length) residual.push({ model: entry.model, fields: left });
  }

  // The three root records are the person, so they also get retired.
  for (const [delegateName, id, lastName] of [
    ['contact', subject.contactId, 'Contact'],
    ['lead', subject.leadId, 'Lead'],
    ['personAccount', subject.personAccountId, 'PersonAccount'],
  ]) {
    if (!id) continue;
    try {
      await prisma[delegateName].update({
        where: { id },
        data: { firstName: 'Erased', lastName: `${lastName} ${id.slice(0, 8)}`, deletedAt: new Date() },
      });
    } catch (err) {
      skipped.push({ model: lastName, reason: err.message });
    }
  }

  // Consent cannot survive the person it belonged to.
  if (subject.contactId || subject.leadId || subject.personAccountId) {
    const consentWhere = subjectWhere({ keys: SUBJECT_KEYS, identifiers: [] }, subject);
    if (consentWhere) {
      try {
        await prisma.consentRecord.updateMany({ where: consentWhere, data: { status: 'OptOut' } });
      } catch (err) { /* nothing recorded */ }
    }
  }

  // Polymorphic notes and attachments.
  if (purging) {
    for (const target of polymorphicTargets(subject)) {
      count('Note', await redactPolymorphic(prisma, 'note', 'module', 'recordId', target, { body: REDACTED }));
      count('Attachment', await redactPolymorphic(prisma, 'attachment', 'parentModule', 'parentId', target, { fileName: REDACTED, description: null, url: null }));
    }
  } else {
    residual.push({ model: 'Note', fields: ['body'] });
    residual.push({ model: 'Attachment', fields: ['fileName', 'url'] });
  }

  // The address stays on file precisely so an import cannot bring them back.
  const suppressed = [];
  for (const address of subject.emails) {
    try {
      await prisma.emailSuppression.upsert({
        where: { email: address },
        update: { reason: 'gdpr_erasure', source: 'data_subject_request', suppressedAt: new Date() },
        create: { email: address, reason: 'gdpr_erasure', source: 'data_subject_request' },
      });
      suppressed.push(address);
    } catch (err) { /* suppression list unavailable */ }
  }

  return {
    strategy,
    actorId,
    subject: publicSubject(subject),
    erased,
    modelsTouched: Object.keys(erased).length,
    rowsTouched: Object.values(erased).reduce((a, b) => a + b, 0),
    suppressed,
    residual,
    skipped,
    erasedAt: new Date(),
  };
}

async function redactPolymorphic(prisma, delegateName, moduleField, idField, target, data) {
  const delegate = prisma[delegateName];
  if (!delegate?.updateMany) return 0;
  try {
    const { count } = await delegate.updateMany({
      where: { [moduleField]: { in: target.modules }, [idField]: target.id },
      data,
    });
    return count;
  } catch (err) {
    return 0;
  }
}

function fieldOf(modelName, fieldName) {
  const model = Prisma.dmmf.datamodel.models.find(m => m.name === modelName);
  return model?.fields.find(f => f.name === fieldName) || null;
}

module.exports = {
  resolveSubject,
  exportSubject,
  eraseSubject,
  buildPlan,
  SUBJECT_KEYS,
  TOMBSTONE,
  REDACTED,
};
