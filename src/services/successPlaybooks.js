const {
  asActor
} = require('./revenueActor');
const {
  reachableWhere
} = require('../middleware/access');
const {
  permits
} = require('../middleware/auth');
const {
  createRecord,
  runAfter
} = require('./recordWrites');
const metrics = ['overdueMilestones', 'openCases', 'overdueInvoices', 'staleDeals'];
const fail = message => {
  throw Object.assign(new Error(message), {
    status: 400
  });
};
function validate(input) {
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 150) fail('A playbook name is required');
  if (!Number.isInteger(input.riskThreshold) || input.riskThreshold < 0 || input.riskThreshold > 100) fail('Risk threshold must be 0–100');
  if (!Array.isArray(input.milestones) || input.milestones.length > 30 || input.milestones.some(m => !m || typeof m.title !== 'string' || !m.title.trim() || m.title.length > 200 || !Number.isInteger(m.days) || m.days < 0 || m.days > 730)) fail('Use up to 30 milestones with titles and due days from 0–730');
  if (!Array.isArray(input.healthRules) || input.healthRules.length > 20 || input.healthRules.some(r => !r || !metrics.includes(r.metric) || !Number.isInteger(r.threshold) || r.threshold < 0 || !Number.isInteger(r.penalty) || r.penalty < 0 || r.penalty > 100)) fail('Use supported metrics with nonnegative thresholds and penalties up to 100');
}
async function enroll(db, req, accountId, playbookId) {
  const account = await db.account.findFirst({
      where: await reachableWhere(req, 'accounts', 'account', {
        id: accountId
      }, 'Edit')
    }),
    playbook = await db.successPlaybook.findFirst({
      where: {
        id: playbookId,
        active: true
      }
    });
  if (!account || !playbook) fail('Account or active playbook not found');
  if (!permits(req, 'activities', 'edit')) fail('Activity edit access is required');
  const after = [];
  const result = await db.$transaction(async tx => {
    const row = await tx.accountPlaybook.create({
      data: {
        accountId,
        playbookId,
        ownerId: req.userId,
        definition: {
          milestones: playbook.milestones,
          healthRules: playbook.healthRules,
          riskThreshold: playbook.riskThreshold,
          name: playbook.name
        }
      }
    });
    for (const [i, m] of playbook.milestones.entries()) {
      const dueDate = new Date(Date.now() + m.days * 86400000);
      const {
        record
      } = await createRecord(tx, 'activities', {
        type: 'Task',
        subject: m.title,
        accountId,
        assignedId: req.userId,
        ownerId: req.userId,
        dueDate,
        status: 'Pending',
        cadenceKey: 'playbook:' + row.id + ':' + i
      }, {
        req,
        userId: req.userId,
        after,
        prisma: db,
        managedFields: true
      });
      await tx.playbookMilestone.create({
        data: {
          enrollmentId: row.id,
          title: m.title,
          dueDate,
          activityId: record.id
        }
      });
    }
    return row;
  });
  await runAfter(after);
  return result;
}
async function evaluate(raw, row) {
  return asActor(raw, row.ownerId, 'accounts', async (db, req) => {
    if (!(await db.account.findFirst({
      where: await reachableWhere(req, 'accounts', 'account', {
        id: row.accountId
      }, 'Edit')
    }))) fail('Account is no longer accessible');
    if (!permits(req, 'activities', 'read')) fail('Activity read access is required');
    const values = {},
      milestones = await db.playbookMilestone.findMany({
        where: {
          enrollmentId: row.id
        }
      });
    for (const m of milestones) {
      const activity = m.activityId ? await db.activity.findFirst({
        where: await reachableWhere(req, 'activities', 'activity', {
          id: m.activityId
        })
      }) : null;
      if (!activity) fail('Milestone activity is no longer accessible');
      if (activity.status !== 'Completed' && m.completedAt) {
        m.completedAt = null;
        await db.playbookMilestone.update({
          where: {
            id: m.id
          },
          data: {
            completedAt: null
          }
        });
      }
      if (activity?.status === 'Completed' && !m.completedAt) {
        m.completedAt = activity.completedAt || new Date();
        await db.playbookMilestone.update({
          where: {
            id: m.id
          },
          data: {
            completedAt: m.completedAt
          }
        });
      }
    }
    values.overdueMilestones = milestones.filter(m => !m.completedAt && m.dueDate < new Date()).length;
    for (const metric of new Set(row.definition.healthRules.map(r => r.metric))) {
      if (metric === 'overdueMilestones') continue;
      const [module, model, extra] = metric === 'openCases' ? ['cases', 'case', {
        status: {
          notIn: ['Closed', 'Resolved']
        }
      }] : metric === 'overdueInvoices' ? ['invoices', 'invoice', {
        status: {
          in: ['Sent', 'Overdue', 'Partially Paid']
        },
        dueDate: {
          lt: new Date()
        }
      }] : ['deals', 'deal', {
        stage: {
          notIn: ['Closed Won', 'Closed Lost']
        },
        updatedAt: {
          lt: new Date(Date.now() - 30 * 86400000)
        }
      }];
      if (!permits(req, module, 'read')) fail('Playbook owner needs ' + module + ' read access');
      values[metric] = await db[model].count({
        where: await reachableWhere(req, module, model, {
          accountId: row.accountId,
          ...extra
        })
      });
    }
    const healthScore = Math.max(0, 100 - row.definition.healthRules.filter(r => values[r.metric] > r.threshold).reduce((n, r) => n + r.penalty, 0)),
      atRisk = healthScore < row.definition.riskThreshold;
    const after = [];
    const result = await db.$transaction(async tx => {
      const claim = await tx.accountPlaybook.updateMany({
        where: {
          id: row.id,
          lastEvaluatedAt: row.lastEvaluatedAt
        },
        data: {
          healthScore,
          atRisk,
          lastEvaluatedAt: new Date(),
          lastError: null,
          ...(atRisk && !row.atRisk && {
            riskEpisode: {
              increment: 1
            }
          })
        }
      });
      if (!claim.count) return {
        skipped: true
      };
      if (atRisk && !row.atRisk) {
        if (!permits(req, 'activities', 'edit')) fail('Activity edit access is required for recovery tasks');
        await createRecord(tx, 'activities', {
          type: 'Task',
          subject: 'Review account risk: ' + row.definition.name,
          accountId: row.accountId,
          assignedId: row.ownerId,
          ownerId: row.ownerId,
          dueDate: new Date(),
          status: 'Pending',
          cadenceKey: 'risk:' + row.id + ':' + (row.riskEpisode + 1)
        }, {
          req,
          userId: row.ownerId,
          after,
          prisma: db,
          managedFields: true
        });
        await tx.notification.create({
          data: {
            userId: row.ownerId,
            title: 'Account needs attention',
            message: 'Health score ' + healthScore + ' in ' + row.definition.name,
            recordModule: 'accounts',
            recordId: row.accountId
          }
        });
      }
      return {
        healthScore,
        atRisk,
        metrics: values
      };
    });
    await runAfter(after);
    return result;
  });
}
async function processDue(db) {
  const rows = await db.accountPlaybook.findMany({
    where: {
      OR: [{
        lastEvaluatedAt: null
      }, {
        lastEvaluatedAt: {
          lt: new Date(Date.now() - 3600000)
        }
      }]
    },
    take: 100
  });
  for (const row of rows) try {
    await evaluate(db, row);
  } catch (e) {
    await db.accountPlaybook.update({
      where: {
        id: row.id
      },
      data: {
        lastEvaluatedAt: new Date(),
        lastError: String(e.message).slice(0, 300)
      }
    });
  }
  return {
    evaluated: rows.length
  };
}
module.exports = {
  metrics,
  validate,
  enroll,
  evaluate,
  processDue
};
