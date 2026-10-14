const graph = require('./microsoftGraph');
const { parseAddress } = require('./inboundIngest');
const { permits } = require('../middleware/auth');
const { reachableWhere } = require('../middleware/access');
const { acquireLease, releaseLease } = require('../utils/lease');

// Personal mailbox ingestion never invokes support routing or auto-replies.
// Resolve only unambiguous records the mailbox owner may read.
async function pollPersonalMailbox(prisma, account) {
  const owner = await prisma.user.findFirst({ where: { id: account.ownerId, active: true, isPortalUser: false }, include: { role: { include: { permissions: true } } } });
  if (!owner) throw Object.assign(new Error('Mailbox owner is inactive'), { status: 403 });
  const req = { user: owner, userId: owner.id, app: { locals: { prisma } } };
  if (!permits(req, 'emails', 'edit')) throw Object.assign(new Error('Mailbox owner no longer has email access'), { status: 403 });
  const lease = await acquireLease(prisma, `sales-mail:${account.id}`, 5 * 60000);
  if (!lease) return { skipped: 'Mailbox sync is already running' };
  try {
    const { withToken } = require('./graphMailbox');
    let checkpoint = {};
    try { checkpoint = JSON.parse(account.syncCursor || '{}'); } catch { /* old single-folder cursor */ }
    let imported = 0, fetched = 0, moreMayBeAvailable = false;
    for (const folder of ['Inbox', 'SentItems']) {
      const outgoing = folder === 'SentItems';
      const saved = checkpoint[folder] || {};
      const since = saved.since ? new Date(+new Date(saved.since) - 1000) : new Date(Date.now() - 30 * 86400000);
      const page = await withToken(prisma, account, accessToken => graph.listMessagePage({ accessToken, mailboxAddress: account.mailboxAddress, folder, since, top: 100, cursor: saved.cursor }));
      const raw = page.messages;
      fetched += raw.length; moreMayBeAvailable ||= !!page.nextLink;
      let latest = saved.since ? new Date(saved.since) : since;
      for (const item of raw) {
        const m = graph.normalizeMessage(item);
        const receivedAt = new Date((outgoing && item.sentDateTime) || m.date || Date.now());
        if (!Number.isFinite(+receivedAt)) continue;
        if (!latest || receivedAt > latest) latest = receivedAt;
        if (await prisma.inboundEmailMessage.findFirst({ where: { accountId: account.id, externalId: m.graphId } })) continue;
        const sender = parseAddress(m.from || '');
        // The inbox renders text, never executes email HTML. Keep the full body
        // when Graph's text alternative is only the short preview.
        const body = item.body?.contentType?.toLowerCase() === 'html'
          ? String(item.body.content || '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?\s*>|<\/p>|<\/div>/gi, '\n').replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&amp;/gi, '&')
          : m.text || '';
        const correspondent = outgoing ? (item.toRecipients?.length === 1 ? item.toRecipients[0]?.emailAddress?.address : null) : sender.email;
        const matches = permits(req, 'contacts', 'read') && correspondent ? await prisma.contact.findMany({ where: await reachableWhere(req, 'contacts', 'contact', { email: { equals: correspondent, mode: 'insensitive' } }), take: 2, select: { id: true } }) : [];
        const contactId = matches.length === 1 ? matches[0].id : null;
        const deals = contactId && permits(req, 'deals', 'read') ? await prisma.deal.findMany({ where: await reachableWhere(req, 'deals', 'deal', { contactId, stage: { notIn: ['Closed Won', 'Closed Lost'] } }), take: 2, select: { id: true } }) : [];
        // Reconcile a reply just sent here with its later Sent Items copy.
        const localReply = outgoing && m.conversationId ? await prisma.inboundEmailMessage.findFirst({ where: { accountId: account.id, direction: 'outbound', externalId: null, threadKey: m.conversationId, textBody: body, receivedAt: { gte: new Date(+receivedAt - 5 * 60000), lte: new Date(+receivedAt + 5 * 60000) } } }) : null;
        // Inbox and Sent Items paginate independently. A reply may have arrived
        // on an earlier sync than the incoming message it answered.
        const alreadyAnswered = !outgoing && m.conversationId ? await prisma.inboundEmailMessage.findFirst({ where: { accountId: account.id, direction: 'outbound', threadKey: m.conversationId, receivedAt: { gte: receivedAt }, deletedAt: null }, orderBy: { receivedAt: 'desc' }, select: { receivedAt: true } }) : null;
        if (localReply) await prisma.inboundEmailMessage.update({ where: { id: localReply.id }, data: { externalId: m.graphId, messageId: m.messageId } });
        else await prisma.inboundEmailMessage.create({ data: {
          accountId: account.id, externalId: m.graphId, messageId: m.messageId,
          threadKey: m.conversationId || m.messageId || m.graphId, fromEmail: sender.email || '', fromName: sender.name,
          toEmails: m.to, subject: m.subject, textBody: body, snippet: body.slice(0, 200), receivedAt,
          contactId, dealId: deals.length === 1 ? deals[0].id : null,
          status: outgoing ? 'Sent' : alreadyAnswered ? 'Replied' : 'New',
          repliedAt: alreadyAnswered?.receivedAt || null, direction: outgoing ? 'outbound' : 'inbound',
        } });
        if (outgoing && m.conversationId) await prisma.inboundEmailMessage.updateMany({ where: { accountId: account.id, threadKey: m.conversationId, direction: 'inbound', receivedAt: { lte: receivedAt }, repliedAt: null }, data: { repliedAt: receivedAt, status: 'Replied' } });
        if (!localReply) imported++;
      }
      checkpoint[folder] = { since: latest.toISOString(), cursor: page.nextLink };
      await prisma.inboundEmailAccount.update({ where: { id: account.id }, data: { syncCursor: JSON.stringify(checkpoint), ...(!outgoing && { lastSyncAt: latest }) } });
    }
    await prisma.inboundEmailAccount.update({ where: { id: account.id }, data: { lastPolledAt: new Date(), lastError: null, status: 'Idle' } });
    return { fetched, imported, processed: imported, casesCreated: 0, leadsCreated: 0, moreMayBeAvailable };
  } catch (e) {
    await prisma.inboundEmailAccount.update({ where: { id: account.id }, data: { status: 'Error', lastError: String(e.message).slice(0, 300), lastPolledAt: new Date() } });
    throw e;
  } finally { await releaseLease(prisma, `sales-mail:${account.id}`, lease); }
}
module.exports = { pollPersonalMailbox };
