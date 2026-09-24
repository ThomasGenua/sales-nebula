/**
 * In-app notifications, by kind, as each user has chosen in Settings.
 *
 * Settings showed notification switches that were stored nowhere and read by
 * nothing. The kinds below can be turned off per user (their preferences,
 * `notifications.<kind>: false`); anything else (a failed background job, a
 * notification an administrator's workflow rule sends) always goes.
 */
const NOTIFICATION_KINDS = ['mentions', 'approvals', 'reminders', 'dealAlerts', 'caseAlerts'];

/** Whether a user takes notifications of this kind; on unless they turned it off. */
async function wantsNotification(prisma, userId, kind) {
  if (!NOTIFICATION_KINDS.includes(kind) || !userId) return true;
  const row = await prisma.adminConfig.findUnique({ where: { key: `user_prefs:${userId}` }, select: { value: true } }).catch(() => null);
  if (!row) return true;
  try { return JSON.parse(row.value)?.notifications?.[kind] !== false; } catch (e) { return true; }
}

/** Create the notification `data` for its user, unless they turned `kind` off; null then. */
async function notify(prisma, kind, data) {
  if (!(await wantsNotification(prisma, data.userId, kind))) return null;
  return prisma.notification.create({ data });
}

module.exports = { notify, wantsNotification, NOTIFICATION_KINDS };
