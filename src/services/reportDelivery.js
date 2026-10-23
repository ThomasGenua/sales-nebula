const { permits } = require('../middleware/auth');
const { context, secureClient } = require('./fieldSecurity');
const intervals = { '0 * * * *': 3600000, '0 8 * * *': 86400000, '0 8 * * 1': 604800000 };
function nextRun(cron, now = new Date()) {
  if (!intervals[cron]) throw Object.assign(new Error('Choose hourly, daily at 08:00 UTC, or Monday at 08:00 UTC'), { status: 400 });
  const next = new Date(now);
  next.setUTCMinutes(0, 0, 0);
  if (cron === '0 * * * *') next.setUTCHours(next.getUTCHours() + 1);
  else {
    next.setUTCHours(8);
    if (cron === '0 8 * * 1') next.setUTCDate(next.getUTCDate() + (8 - next.getUTCDay()) % 7);
    if (next <= now) next.setUTCDate(next.getUTCDate() + (cron === '0 8 * * 1' ? 7 : 1));
  }
  return next;
}
async function deliverDue(raw, now = new Date()) {
  const schedules = await raw.reportSchedule.findMany({ where: { active: true, nextRun: { lte: now } }, include: { report: true }, take: 50 });
  for (const schedule of schedules) {
    const claim = await raw.reportSchedule.updateMany({ where: { id: schedule.id, active: true, nextRun: schedule.nextRun }, data: { nextRun: nextRun(schedule.cron, now) } });
    if (!claim.count) continue;
    try {
      // Delivery is to the subscribing owner only; results run with their
      // current role, row access and field permissions, never as an admin.
      const user = await raw.user.findFirst({ where: { id: schedule.report.createdById, active: true, isPortalUser: false }, include: { role: { include: { permissions: true } } } });
      const db = secureClient(raw), req = { user, userId: user?.id, app: { locals: { prisma: db } } };
      const permitted = schedule.report.module.startsWith('custom:') ? require('./customObjectAccess').canAccess(req, schedule.report.module.slice(7)) : permits(req, schedule.report.module, 'read');
      if (!user || !permitted) throw new Error('Schedule owner no longer has report access');
      const result = await context.run({ req, policyDb: raw }, () => require('../routes/reports').executeReport(db, schedule.report, req));
      const delivery = await require('./mailer').sendEmail(raw, { to: user.email, subject: 'Scheduled report: ' + schedule.report.name, body: JSON.stringify(result, null, 2) });
      if (!delivery.delivered) throw new Error(delivery.error || delivery.detail || 'Report was not delivered');
      await raw.reportSchedule.update({ where: { id: schedule.id }, data: { lastRun: now, lastError: null } });
    } catch (err) { await raw.reportSchedule.update({ where: { id: schedule.id }, data: { lastError: String(err.message).slice(0, 400) } }); }
  }
  return schedules.length;
}
module.exports = { nextRun, deliverDue };
