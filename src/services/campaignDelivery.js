const crypto = require('crypto');
const policy = require('./sequencePolicy');
const {
  reachableWhere
} = require('../middleware/access');
const {
  permits
} = require('../middleware/auth');
const {
  asActor
} = require('./revenueActor');
const fail = message => {
  throw Object.assign(new Error(message), {
    status: 400
  });
};
const signature = id => crypto.createHmac('sha256', require('../utils/secrets').resolveJwtSecret()).update('campaign-unsubscribe:' + id).digest('hex');
function validToken(id, token) {
  return typeof token === 'string' && /^[a-f0-9]{64}$/.test(token) && crypto.timingSafeEqual(Buffer.from(signature(id), 'hex'), Buffer.from(token, 'hex'));
}
async function suppressed(db, email) {
  return !!(await db.emailSuppression.findFirst({
    where: {
      email: {
        in: [email, '@' + email.split('@')[1]]
      },
      OR: [{
        expiresAt: null
      }, {
        expiresAt: {
          gt: new Date()
        }
      }]
    }
  }));
}
async function queue(db, req, campaignId, {
  subject,
  body
}) {
  if (typeof subject !== 'string' || !subject.trim() || subject.length > 300 || typeof body !== 'string' || !body.trim() || body.length > 50000) fail('Provide a subject and message of at most 50,000 characters');
  if (policy.templateProblem(subject) || policy.templateProblem(body)) fail('Unsupported merge field');
  const campaign = await db.campaign.findFirst({
    where: await reachableWhere(req, 'campaigns', 'campaign', {
      id: campaignId
    }, 'Edit')
  });
  if (!campaign) fail('Campaign not found');
  const recipients = await db.campaignRecipient.findMany({
    where: {
      campaignId
    },
    take: 2001
  });
  if (recipients.length > 2000) fail('Use at most 2,000 recipients per campaign');
  let queued = 0,
    skipped = 0;
  for (const r of recipients) {
    const module = r.contactId ? 'contacts' : 'leads',
      model = r.contactId ? 'contact' : 'lead';
    const person = permits(req, module, 'read') ? await db[model].findFirst({
      where: await reachableWhere(req, module, model, {
        id: r.contactId || r.leadId || ''
      })
    }) : null;
    const email = person?.email?.trim().toLowerCase();
    if (!email || !/^\S+@\S+\.\S+$/.test(email) || (await suppressed(db, email))) {
      skipped++;
      continue;
    }
    try {
      await db.campaignDelivery.create({
        data: {
          campaignId,
          recipientKey: email,
          contactId: r.contactId,
          leadId: r.leadId,
          email,
          subject: policy.personalize(subject, person),
          body: policy.personalize(body, person),
          createdById: req.userId
        }
      });
      queued++;
    } catch (e) {
      if (e.code !== 'P2002') throw e;
      skipped++;
    }
  }
  await require('./recordWrites').updateRecord(db, 'campaigns', campaign, {
    status: 'Active'
  }, {
    req,
    userId: req.userId
  });
  return {
    queued,
    skipped
  };
}
async function recordTouches(db, req, row) {
  if (!row.contactId || !permits(req, 'deals', 'read')) return;
  const deals = await db.deal.findMany({
    where: await reachableWhere(req, 'deals', 'deal', {
      contactId: row.contactId
    }),
    take: 100
  });
  for (const deal of deals) await db.campaignInfluence.upsert({
    where: {
      campaignId_dealId_model: {
        campaignId: row.campaignId,
        dealId: deal.id,
        model: 'FirstTouch'
      }
    },
    create: {
      campaignId: row.campaignId,
      dealId: deal.id,
      model: 'FirstTouch',
      contactId: row.contactId,
      touchDate: row.sentAt || new Date(),
      influence: 0,
      revenue: 0
    },
    update: {}
  });
}
async function processDue(raw) {
  if (!require('../utils/mail').mailConfigured()) return {
    skipped: 'SMTP is not configured'
  };
  const lease = await require('../utils/lease').acquireLease(raw, 'campaign-delivery', 300000);
  if (!lease) return {
    busy: true
  };
  try {
    const rows = await raw.campaignDelivery.findMany({
      where: {
        status: 'Queued',
        nextAttemptAt: {
          lte: new Date()
        }
      },
      take: 25,
      orderBy: {
        createdAt: 'asc'
      }
    });
    let sent = 0;
    for (const row of rows) {
      try {
        await asActor(raw, row.createdById, 'campaigns', async (db, req) => {
          const campaign = await db.campaign.findFirst({
            where: await reachableWhere(req, 'campaigns', 'campaign', {
              id: row.campaignId,
              status: 'Active'
            })
          });
          if (!campaign) return;
          const module = row.contactId ? 'contacts' : 'leads',
            model = row.contactId ? 'contact' : 'lead';
          if ((await require('./fieldSecurity').policies(db)).some(p => p.module === module && !p.visible)) throw new Error('Full recipient field access is required to deliver a saved message');
          const person = permits(req, module, 'read') ? await db[model].findFirst({
            where: await reachableWhere(req, module, model, {
              id: row.contactId || row.leadId || ''
            })
          }) : null;
          if (!person || person.email?.toLowerCase() !== row.email || (await suppressed(db, row.email))) {
            await raw.campaignDelivery.update({
              where: {
                id: row.id
              },
              data: {
                status: 'Suppressed',
                error: 'Recipient is unavailable, changed, or suppressed'
              }
            });
            return;
          }
          const claim = await raw.campaignDelivery.updateMany({
            where: {
              id: row.id,
              status: 'Queued'
            },
            data: {
              status: 'Sending',
              attempts: {
                increment: 1
              }
            }
          });
          if (!claim.count) return;
          const base = (process.env.FRONTEND_URL || 'http://localhost:7544').split(',')[0],
            unsubscribe = base + '/api/public/campaigns/' + row.id + '/unsubscribe?token=' + signature(row.id);
          const delivery = await require('./mailer').sendEmail(db, {
            to: row.email,
            subject: row.subject,
            body: row.body + '\n\nUnsubscribe: ' + unsubscribe,
            headers: {
              'Message-ID': '<campaign-' + row.id + '@sales-nebula.local>',
              'List-Unsubscribe': '<' + unsubscribe + '>',
              'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
            }
          });
          const updated = await raw.campaignDelivery.update({
            where: {
              id: row.id
            },
            data: {
              status: delivery.delivered ? 'Sent' : 'Failed',
              sentAt: delivery.delivered ? new Date() : null,
              error: delivery.delivered ? null : delivery.error || delivery.detail || 'Delivery was not confirmed',
              messageId: 'campaign-' + row.id
            }
          });
          if (delivery.delivered) {
            sent++;
            await db.campaignRecipient.updateMany({
              where: {
                campaignId: row.campaignId,
                ...(row.contactId ? {
                  contactId: row.contactId
                } : {
                  leadId: row.leadId
                })
              },
              data: {
                status: 'sent',
                sentAt: updated.sentAt
              }
            });
            await recordTouches(db, req, updated);
          }
        });
      } catch (e) {
        await raw.campaignDelivery.update({
          where: {
            id: row.id
          },
          data: {
            error: String(e.message).slice(0, 300)
          }
        });
      }
    }
    return {
      processed: rows.length,
      sent
    };
  } finally {
    await require('../utils/lease').releaseLease(raw, 'campaign-delivery', lease);
  }
}
async function unsubscribe(db, id) {
  const row = await db.campaignDelivery.findUnique({
    where: {
      id
    }
  });
  if (!row) return false;
  await db.$transaction(async tx => {
    await tx.emailSuppression.upsert({
      where: {
        email: row.email
      },
      create: {
        email: row.email,
        reason: 'Unsubscribe',
        source: 'campaign'
      },
      update: {
        reason: 'Unsubscribe',
        expiresAt: null
      }
    });
    await tx.campaignDelivery.updateMany({
      where: {
        email: row.email,
        status: 'Queued'
      },
      data: {
        status: 'Suppressed'
      }
    });
    await tx.emailSequenceEnrollment.updateMany({
      where: {
        recipientEmail: row.email,
        status: {
          in: ['Active', 'Paused']
        }
      },
      data: {
        status: 'Opted Out',
        nextSendAt: null
      }
    });
  });
  return true;
}
async function bounce(db, id) {
  const row = await db.campaignDelivery.findUnique({
    where: {
      id
    }
  });
  if (!row) return false;
  await db.$transaction(async tx => {
    await tx.campaignDelivery.update({
      where: {
        id
      },
      data: {
        status: 'Bounced',
        error: 'Provider reported a hard bounce'
      }
    });
    await tx.emailSuppression.upsert({
      where: {
        email: row.email
      },
      create: {
        email: row.email,
        reason: 'Hard bounce',
        source: 'campaign'
      },
      update: {
        reason: 'Hard bounce',
        expiresAt: null
      }
    });
  });
  return true;
}
module.exports = {
  queue,
  processDue,
  signature,
  validToken,
  unsubscribe,
  bounce,
  suppressed,
  recordTouches
};
