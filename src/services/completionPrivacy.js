const { Prisma } = require('@prisma/client');
const { acquireLease, releaseLease } = require('../utils/lease');
const meetings = require('./meetingIntelligence');
async function findCopies(db, subject) {
  const ids = [subject.contactId, subject.leadId, subject.personAccountId].filter(Boolean);
  const migrationWhere = { OR: [...(ids.length ? [{ recordId: { in: ids } }] : []), ...subject.emails.flatMap(email => [{ data: { path: ['email'], equals: email.toLowerCase() } }, { before: { path: ['email'], equals: email.toLowerCase() } }])] };
  const migrationRows = migrationWhere.OR.length ? await db.migrationRow.findMany({ where: migrationWhere }) : [];
  const recordings = subject.contactId ? await db.callRecording.findMany({ where: { contactId: subject.contactId }, select: { id: true } }) : [];
  const jobs = await db.meetingJob.findMany({ where: { recordingId: { in: recordings.map(r => r.id) } } });
  return { migrationRows, jobs };
}
async function exportCopies(db, subject) {
  const { migrationRows, jobs } = await findCopies(db, subject);
  return { ...(migrationRows.length && { MigrationRow: migrationRows }), ...(jobs.length && { MeetingJob: jobs.map(({ fileKey, ...job }) => job) }) };
}
async function eraseCopies(db, subject, purge) {
  const { migrationRows, jobs } = await findCopies(db, subject), leases = [];
  try {
    for (const name of [...new Set(migrationRows.map(r => 'migration:' + r.batchId)), ...jobs.map(j => 'meeting:' + j.recordingId)]) {
      const token = await acquireLease(db, name, 120000);
      if (!token) throw Object.assign(new Error('An import or meeting is processing this person. Pause it or wait for it to finish, then retry erasure.'), { status: 409 });
      leases.push({ name, token });
    }
    // Imported snapshots could otherwise restore erased information through undo.
    await db.migrationRow.updateMany({ where: { id: { in: migrationRows.map(r => r.id) } }, data: { data: {}, before: Prisma.DbNull, status: 'Erased', error: 'Data removed by a subject erasure request' } });
    await db.migrationLink.deleteMany({ where: { recordId: { in: [subject.contactId, subject.leadId].filter(Boolean) } } });
    if (purge) {
      for (const job of jobs) await meetings.removeAudio(job.fileKey);
      await db.meetingJob.updateMany({ where: { recordingId: { in: jobs.map(j => j.recordingId) } }, data: { fileKey: null, suggestions: Prisma.DbNull, segments: Prisma.DbNull, status: 'Erased', error: null } });
    }
    return { MigrationRow: migrationRows.length, ...(purge && { MeetingJob: jobs.length }) };
  } finally { for (const lease of leases) await releaseLease(db, lease.name, lease.token); }
}
module.exports = { exportCopies, eraseCopies };
