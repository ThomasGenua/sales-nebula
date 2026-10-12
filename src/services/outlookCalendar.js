const crypto = require('crypto');
const graph = require('./microsoftGraph');
const { withToken } = require('./graphMailbox');
const { acquireLease, releaseLease } = require('../utils/lease');
const { permits } = require('../middleware/auth');
const HEADERS = { Prefer: 'outlook.timezone="UTC", outlook.body-content-type="text", IdType="ImmutableId", odata.maxpagesize=100' };
const fail = (message, status = 409) => Object.assign(new Error(message), { status });
const include = { invitees: true, reminders: true };
const fingerprint = e => crypto.createHash('sha256').update(JSON.stringify([e.title, e.description, e.location, new Date(e.startAt).toISOString(), new Date(e.endAt).toISOString(), e.allDay, e.status, e.isCancelled, !!e.deletedAt, (e.invitees || []).map(i => [i.email, i.userId, i.contactId, i.leadId, i.role]).sort(), (e.reminders || []).map(r => [r.userId, r.method, r.minutesBefore]).sort()])).digest('hex');
const remoteVersion = e => e['@odata.etag'] || (e.changeKey ? 'W/"' + e.changeKey + '"' : null);
const utc = time => {
  if (!time?.dateTime || time.timeZone && !['UTC', 'Etc/UTC'].includes(time.timeZone)) throw new Error('Outlook did not return the requested UTC dates');
  const date = new Date(time.dateTime + (/Z$|[+-]\d\d:\d\d$/.test(time.dateTime) ? '' : 'Z'));
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid Outlook event time');
  return date;
};
const cleanBody = body => String(body?.content || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').slice(0, 50000);
async function checkAccount(db, account) {
  if (!account.ownerId || !account.active || account.deletedAt || !account.calendarEnabled) throw fail('Enable Outlook calendar access from Mailbox first.');
  const user = await db.user.findUnique({ where: { id: account.ownerId }, include: { role: { include: { permissions: true } } } });
  if (!user?.active || !permits({ user }, 'activities', 'edit') || !permits({ user }, 'emails', 'edit')) throw fail('Calendar owner no longer has the required access.', 403);
}
async function request(db, account, path, options = {}) { return withToken(db, account, accessToken => graph.graphFetch(path, { accessToken, headers: HEADERS, ...options })); }
async function remoteEvent(db, account, id) { return request(db, account, '/me/events/' + encodeURIComponent(id)); }
async function importEvent(db, account, incoming, { force = false } = {}) {
  const link = await db.outlookEventLink.findUnique({ where: { accountId_remoteId: { accountId: account.id, remoteId: incoming.id } } });
  const event = link && await db.calendarEvent.findUnique({ where: { id: link.eventId }, include });
  if (incoming['@removed']) {
    try { incoming = await remoteEvent(db, account, incoming.id); } catch (e) { if (e.status !== 404) throw e; incoming = { id: incoming.id, deleted: true }; }
  }
  if (link && event) {
    if (!force && remoteVersion(incoming) && remoteVersion(incoming) === link.remoteVersion) return 'unchanged';
    if (!force && fingerprint(event) !== link.localHash) { await db.outlookEventLink.update({ where: { id: link.id }, data: { conflict: true } }); return 'conflict'; }
  }
  if (incoming.deleted && !event) return 'unchanged';
  return db.$transaction(async tx => {
    // A user edit during the remote fetch must not be replaced.
    if (event) {
      const current = await tx.calendarEvent.findUnique({ where: { id: event.id }, include });
      if (fingerprint(current) !== fingerprint(event)) throw fail('Meeting changed during sync. Try again.');
    }
    const fields = incoming.deleted ? { isCancelled: true, status: 'Cancelled' } : {
      title: String(incoming.subject || '(Untitled Outlook meeting)').slice(0, 500),
      description: cleanBody(incoming.body), location: String(incoming.location?.displayName || '').slice(0, 1000),
      startAt: utc(incoming.start), endAt: utc(incoming.end), timezone: 'UTC', allDay: !!incoming.isAllDay,
      isCancelled: !!incoming.isCancelled, status: incoming.isCancelled ? 'Cancelled' : 'Planned',
      meetingUrl: /^https:\/\//.test(incoming.onlineMeeting?.joinUrl || '') ? incoming.onlineMeeting.joinUrl : null,
    };
    const saved = event ? await tx.calendarEvent.update({ where: { id: event.id, updatedAt: event.updatedAt }, data: fields }) : await tx.calendarEvent.create({ data: { ...fields, ownerId: account.ownerId, visibility: 'Private' } });
    if (!incoming.deleted) {
      await tx.eventInvitee.deleteMany({ where: { eventId: saved.id } });
      const attendees = (incoming.attendees || []).filter(a => a.emailAddress?.address).slice(0, 500);
      if (attendees.length) await tx.eventInvitee.createMany({ data: attendees.map(a => ({ eventId: saved.id, email: a.emailAddress.address.toLowerCase(), name: a.emailAddress.name || null, role: a.type === 'optional' ? 'Optional' : 'Required', responseStatus: ({ accepted: 'Accepted', declined: 'Declined', tentativelyAccepted: 'Tentative' })[a.status?.response] || 'NeedsAction' })) });
    }
    await tx.reminder.deleteMany({ where: { eventId: saved.id, userId: account.ownerId, method: 'Popup' } });
    if (!incoming.deleted && !incoming.isCancelled && incoming.isReminderOn && fields.startAt > new Date()) {
      const minutes = Math.max(0, Math.min(40320, Number(incoming.reminderMinutesBeforeStart) || 0));
      await tx.reminder.create({ data: { eventId: saved.id, userId: account.ownerId, method: 'Popup', minutesBefore: minutes, triggerAt: new Date(fields.startAt.getTime() - minutes * 60000) } });
    }
    const current = await tx.calendarEvent.findUnique({ where: { id: saved.id }, include });
    const data = { remoteVersion: remoteVersion(incoming), localHash: fingerprint(current), conflict: false, remoteOrganizer: !!incoming.isOrganizer, remoteRecurring: incoming.type !== 'singleInstance' && !!incoming.type, syncedAt: new Date() };
    if (link) await tx.outlookEventLink.update({ where: { id: link.id }, data });
    else await tx.outlookEventLink.create({ data: { ...data, accountId: account.id, eventId: saved.id, remoteId: incoming.id } });
    return 'synced';
  }, { isolationLevel: 'Serializable' });
}
async function sync(db, account) {
  await checkAccount(db, account);
  const name = 'outlook-calendar:' + account.id, lease = await acquireLease(db, name, 5 * 60000);
  if (!lease) return { busy: true };
  try {
    // The delta window is renewed before its far edge reaches the next month.
    const reset = !account.calendarWindowEnd || account.calendarWindowEnd < new Date(Date.now() + 150 * 86400000);
    let cursor = reset ? null : account.calendarCursor;
    const start = new Date(Date.now() - 30 * 86400000), end = reset ? new Date(Date.now() + 180 * 86400000) : account.calendarWindowEnd;
    let path = '/me/calendarView/delta?startDateTime=' + start.toISOString() + '&endDateTime=' + end.toISOString(), count = 0, conflicts = 0;
    for (let page = 0; page < 10; page++) {
      if (cursor) { const url = new URL(cursor); if (url.origin !== 'https://graph.microsoft.com' || !url.pathname.startsWith('/v1.0/')) throw new Error('Invalid calendar cursor'); path = url.pathname.slice('/v1.0'.length) + url.search; }
      let result;
      try { result = await request(db, account, path); } catch (e) { if (e.status === 410) { await db.inboundEmailAccount.update({ where: { id: account.id }, data: { calendarCursor: null, calendarWindowEnd: null } }); throw fail('Outlook sync history expired. Sync again to refresh it.'); } throw e; }
      for (const event of result?.value || []) { const outcome = await importEvent(db, account, event); if (outcome === 'conflict') conflicts++; if (outcome === 'synced') count++; }
      cursor = result?.['@odata.nextLink'] || result?.['@odata.deltaLink'] || null;
      if (!cursor) throw new Error('Outlook did not return a calendar checkpoint');
      await db.inboundEmailAccount.update({ where: { id: account.id }, data: { calendarCursor: cursor, calendarWindowEnd: end, calendarLastSyncedAt: new Date(), calendarError: null } });
      if (!result['@odata.nextLink']) return { synced: count, conflicts, more: false };
    }
    return { synced: count, conflicts, more: true };
  } catch (e) { await db.inboundEmailAccount.update({ where: { id: account.id }, data: { calendarError: String(e.message).slice(0, 400) } }); throw e; }
  finally { await releaseLease(db, name, lease); }
}
async function publish(db, account, event) {
  await checkAccount(db, account);
  if (event.ownerId !== account.ownerId) throw fail('Only the meeting owner can publish it.', 403);
  if (event.isRecurring || event.parentEventId) throw fail('Manage recurring meetings in Outlook.');
  const link = await db.outlookEventLink.findUnique({ where: { eventId: event.id } });
  if (link && (link.accountId !== account.id || !link.remoteOrganizer || link.remoteRecurring)) throw fail('This meeting must be managed by its organizer in Outlook.');
  if (link?.conflict) throw fail('Resolve the Outlook conflict before publishing.');
  const name = 'outlook-calendar:' + account.id, lease = await acquireLease(db, name, 5 * 60000);
  if (!lease) throw fail('Calendar synchronization is already running.');
  try {
    const headers = { ...HEADERS, ...(link?.remoteVersion && { 'If-Match': link.remoteVersion }) };
    const cancelled = event.isCancelled || event.status === 'Cancelled' || !!event.deletedAt;
    if (cancelled && !link) throw fail('This meeting has not been published.');
    const attendees = [];
    for (const invitee of event.invitees) {
      if (invitee.isOrganizer) continue;
      let email = invitee.email;
      if (!email && invitee.userId) email = (await db.user.findUnique({ where: { id: invitee.userId }, select: { email: true } }))?.email;
      if (!email && invitee.contactId) email = (await db.contact.findUnique({ where: { id: invitee.contactId }, select: { email: true } }))?.email;
      if (!email && invitee.leadId) email = (await db.lead.findUnique({ where: { id: invitee.leadId }, select: { email: true } }))?.email;
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail('Every attendee needs a valid email address.', 400);
      if (!attendees.some(a => a.emailAddress.address.toLowerCase() === email.toLowerCase())) attendees.push({ emailAddress: { address: email, name: invitee.name || email }, type: invitee.role === 'Optional' ? 'optional' : 'required' });
    }
    const reminder = event.reminders.find(r => r.userId === account.ownerId && r.method === 'Popup');
    const body = { subject: event.title, body: { contentType: 'Text', content: event.description || '' }, start: { dateTime: event.startAt.toISOString().replace('Z', ''), timeZone: 'UTC' }, end: { dateTime: event.endAt.toISOString().replace('Z', ''), timeZone: 'UTC' }, isAllDay: event.allDay, location: { displayName: event.location || '' }, attendees, isReminderOn: !!reminder, reminderMinutesBeforeStart: reminder?.minutesBefore || 0, sensitivity: ['Private', 'Confidential'].includes(event.visibility) ? 'private' : 'normal' };
    const remote = await request(db, account, '/me/events' + (link ? '/' + encodeURIComponent(link.remoteId) : ''), { headers, method: cancelled ? 'DELETE' : link ? 'PATCH' : 'POST', ...(!cancelled && { body: { ...body, ...(!link && { transactionId: event.id }) } }) });
    const data = { remoteVersion: remoteVersion(remote || {}), localHash: fingerprint(event), conflict: false, remoteOrganizer: true, remoteRecurring: false, syncedAt: new Date() };
    if (link) await db.outlookEventLink.update({ where: { id: link.id }, data });
    else await db.outlookEventLink.create({ data: { ...data, eventId: event.id, accountId: account.id, remoteId: remote.id } });
    return { published: true, cancelled };
  } catch (e) { if (e.status === 412 && link) { await db.outlookEventLink.update({ where: { id: link.id }, data: { conflict: true } }); throw fail('Outlook changed this meeting. Sync and resolve the conflict first.'); } throw e; }
  finally { await releaseLease(db, name, lease); }
}
module.exports = { sync, publish, importEvent, remoteEvent, fingerprint, include };
