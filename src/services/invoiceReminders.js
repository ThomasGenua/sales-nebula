const {
  asActor
} = require('./revenueActor');
const {
  reachableWhere
} = require('../middleware/access');
const {
  permits
} = require('../middleware/auth');
async function processDue(raw) {
  if (!require('../utils/mail').mailConfigured()) return {
    skipped: true
  };
  const rows = await raw.invoice.findMany({
    where: {
      deletedAt: null,
      remindersEnabled: true,
      remindersOwnerId: {
        not: null
      },
      nextReminderAt: {
        lte: new Date()
      },
      dueDate: {
        lt: new Date()
      },
      status: {
        in: ['Sent', 'Overdue', 'Partially Paid']
      }
    },
    take: 25
  });
  for (const invoice of rows) {
    const claim = await raw.invoice.updateMany({
      where: {
        id: invoice.id,
        nextReminderAt: invoice.nextReminderAt
      },
      data: {
        nextReminderAt: new Date(Date.now() + 7 * 86400000)
      }
    });
    if (!claim.count) continue;
    try {
      await asActor(raw, invoice.remindersOwnerId, 'invoices', async (db, req) => {
        const current = await db.invoice.findFirst({
          where: await reachableWhere(req, 'invoices', 'invoice', {
            id: invoice.id
          }, 'Edit')
        });
        if (!current) throw new Error('Invoice no longer accessible');
        const balance = await require('./payments').balance(db, current);
        if (!balance.outstandingMinor) return;
        if (!current.contactId || !permits(req, 'contacts', 'read')) throw new Error('An accessible invoice contact is required');
        const person = await db.contact.findFirst({
          where: await reachableWhere(req, 'contacts', 'contact', {
            id: current.contactId
          })
        });
        if (!person?.email) throw new Error('Invoice contact has no accessible email');
        if (await require('./campaignDelivery').suppressed(db, person.email.toLowerCase())) throw new Error('Contact email is suppressed');
        const delivery = await require('./mailer').sendEmail(db, {
          to: person.email,
          subject: 'Invoice ' + current.number + ' payment reminder',
          body: 'Our records show an outstanding balance of ' + current.currency + ' ' + (balance.outstandingMinor / 100).toFixed(2) + ' for invoice ' + current.number + '. Please contact us if you have already paid.'
        });
        if (!delivery.delivered) throw new Error(delivery.error || delivery.detail || 'Reminder was not delivered');
        await raw.invoice.update({
          where: {
            id: invoice.id
          },
          data: {
            lastReminderError: null
          }
        });
      });
    } catch (e) {
      await raw.invoice.update({
        where: {
          id: invoice.id
        },
        data: {
          lastReminderError: String(e.message).slice(0, 300)
        }
      });
    }
  }
  return {
    processed: rows.length
  };
}
module.exports = {
  processDue
};
