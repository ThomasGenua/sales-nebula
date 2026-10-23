const { flowProblem } = require('./flowEngine');
const { resolveModel, evaluateConditions } = require('./workflowEngine');
const { reachableWhere } = require('../middleware/access');
const { permits } = require('../middleware/auth');

async function enqueueDue(prisma, now = new Date()) {
  const flows = await prisma.flowDefinition.findMany({ where: { status: 'Active', type: 'Scheduled', nextRun: { lte: now } }, take: 50 });
  for (const flow of flows) await prisma.$transaction(async db => {
    // Claim and create durable runs atomically, so two workers cannot enqueue
    // the same interval and a restart can resume every committed run.
    const claimed = await db.flowDefinition.updateMany({ where: { id: flow.id, status: 'Active', nextRun: flow.nextRun }, data: { nextRun: new Date(now.getTime() + (flow.scheduleMinutes || 60) * 60000) } });
    if (!claimed.count) return;
    const actor = await db.user.findFirst({ where: { id: flow.createdById, active: true, isPortalUser: false }, include: { role: { include: { permissions: true } } } });
    const req = { user: actor, userId: actor?.id, app: { locals: { prisma: db } } };
    const error = flowProblem(flow);
    if (error || !actor || !(flow.module.startsWith('custom:') ? require('./customObjectAccess').canAccess(req, flow.module.slice(7), 'edit') : permits(req, flow.module, 'edit'))) {
      await db.flowRun.create({ data: { flowId: flow.id, status: 'Failed', error: error || 'Schedule owner lacks module edit permission', log: [], completedAt: now } });
      return;
    }
    const customId = flow.module.startsWith('custom:') && flow.module.slice(7);
    const model = customId ? 'customRecord' : resolveModel(flow.module);
    const source = await db[model].findMany({ where: customId ? { customObjectId: customId, deletedAt: null } : await reachableWhere(req, flow.module, model, {}, 'Edit'), take: 10001 });
    const rows = customId ? source.map(r => ({ ...r.data, id: r.id })) : source;
    if (rows.length > 10000 || rows.filter(r => evaluateConditions(flow.triggerConditions, r)).length > 200) {
      await db.flowRun.create({ data: { flowId: flow.id, status: 'Failed', error: 'Scheduled flow exceeds 10,000 source records or 200 matches; narrow its conditions', log: [], completedAt: now } });
      return;
    }
    for (const record of rows.filter(r => evaluateConditions(flow.triggerConditions, r))) await db.flowRun.create({ data: {
      flowId: flow.id, triggerRecordId: record.id, triggerModule: flow.module, status: 'Running', log: [],
      context: { canvas: flow.canvas, version: flow.version, name: flow.name, userId: actor.id, nodeId: flow.canvas.nodes.find(n => n.type === 'start').id, attempts: 0, oldRecord: null },
    } });
  }, { timeout: 30000 });
  return flows.length;
}
module.exports = { enqueueDue };
