const {
  permits
} = require('../middleware/auth');
const {
  reachableWhere
} = require('../middleware/access');
const {
  createRecord
} = require('./recordWrites');
const {
  context,
  secureClient
} = require('./fieldSecurity');
const OUTCOMES = ['connected', 'no_answer', 'interested', 'not_interested', 'completed', 'converted'];
function validateSteps(steps) {
  if (!Array.isArray(steps)) return 'Steps must be an array';
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (!s || typeof s !== 'object' || Array.isArray(s)) return 'Invalid cadence step';
    if (s.branches != null && (typeof s.branches !== 'object' || Array.isArray(s.branches))) return 'Branches must be an object';
    if (!['email', 'call', 'linkedin', 'task'].includes(s?.type || 'email')) return 'Unknown cadence step type';
    for (const [outcome, target] of Object.entries(s.branches || {})) {
      if (!OUTCOMES.includes(outcome) && outcome !== 'replied') return 'Unknown branch outcome';
      if (target !== 'end' && (!Number.isInteger(target) || target <= i || target >= steps.length)) return 'Branches must point to a later step or end';
    }
  }
  return null;
}
async function actor(raw, enrollment, run) {
  const user = await raw.user.findFirst({
    where: {
      id: enrollment.enrolledById,
      active: true,
      isPortalUser: false
    },
    include: {
      role: {
        include: {
          permissions: true
        }
      }
    }
  });
  if (!user) throw new Error('Cadence owner is unavailable');
  const db = secureClient(raw),
    req = {
      user,
      userId: user.id,
      app: {
        locals: {
          prisma: db
        }
      }
    };
  const module = enrollment.contactId ? 'contacts' : 'leads',
    model = enrollment.contactId ? 'contact' : 'lead';
  return context.run({
    req,
    policyDb: raw
  }, async () => {
    if (!permits(req, 'emails', 'edit') || !permits(req, module, 'read') || !(await db[model].findFirst({
      where: await reachableWhere(req, module, model, {
        id: enrollment.contactId || enrollment.leadId
      })
    }))) throw new Error('Cadence owner no longer has access to the recipient');
    return run(db, req);
  });
}
async function manualStep(raw, enrollment, step) {
  return actor(raw, enrollment, async (db, req) => {
    if (!permits(req, 'activities', 'edit')) throw new Error('Cadence owner needs activity edit access');
    const cadenceKey = enrollment.id + ':' + enrollment.currentStep;
    let activity = await db.activity.findUnique({
      where: {
        cadenceKey
      }
    });
    if (!activity) {
      try {
        activity = (await createRecord(db, 'activities', {
          cadenceKey,
          type: step.type === 'call' ? 'Call' : 'Task',
          subject: step.subject || step.type + ' follow-up',
          description: step.body || '',
          contactId: enrollment.contactId,
          leadId: enrollment.leadId,
          assignedId: req.userId,
          ownerId: req.userId,
          dueDate: new Date(),
          status: 'Pending'
        }, {
          req,
          userId: req.userId,
          managedFields: true
        })).record;
      } catch (e) {
        if (e.code !== 'P2002') throw e;
        activity = await db.activity.findUnique({
          where: {
            cadenceKey
          }
        });
      }
    }
    if (!(await db.activity.findFirst({
      where: await reachableWhere(req, 'activities', 'activity', {
        id: activity.id
      }, 'Edit')
    }))) throw new Error('Cadence task is no longer accessible');
    if (activity.deletedAt) throw new Error('Cadence task was deleted; restore it before continuing');
    if (activity.status !== 'Completed') return null;
    const outcome = activity.result || 'completed';
    if (!OUTCOMES.includes(outcome)) throw new Error('Set the activity result to a supported cadence outcome');
    return outcome;
  });
}
module.exports = {
  OUTCOMES,
  validateSteps,
  actor,
  manualStep
};
