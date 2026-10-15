const { workflowProblem, evaluateConditions, resolveModel, runActions } = require('./workflowEngine');
const { modelHasField } = require('../utils/modelFields');

function flowProblem(flow) {
  if (!['RecordTriggered', 'AutoLaunched'].includes(flow.type)) return 'Choose RecordTriggered or AutoLaunched';
  if (!['contacts', 'leads', 'accounts', 'deals', 'cases', 'activities'].includes(flow.module)) return 'Choose a supported CRM module';
  if (flow.type === 'RecordTriggered' && !['create', 'update'].includes(flow.triggerType)) return 'Choose create or update';
  const { nodes, edges } = flow.canvas || {};
  if (!Array.isArray(nodes) || !nodes.length || nodes.length > 100 || !Array.isArray(edges)) return 'Use 1–100 flow nodes';
  const ids = new Set(nodes.map(n => n.id));
  if (ids.size !== nodes.length || nodes.some(n => typeof n.id !== 'string' || !n.id)) return 'Node IDs must be unique';
  if (nodes.filter(n => n.type === 'start').length !== 1) return 'Use exactly one start node';
  if (edges.some(e => !ids.has(e.source) || !ids.has(e.target))) return 'Each connection must join existing nodes';
  for (const n of nodes) {
    const config = n.config || {};
    const outgoing = edges.filter(e => e.source === n.id);
    if (!['start', 'decision', 'action', 'wait', 'end'].includes(n.type)) return `Unsupported node type: ${n.type}`;
    if (n.type === 'end' && outgoing.length) return 'End nodes cannot have outgoing connections';
    if (!['end', 'decision'].includes(n.type) && outgoing.length !== 1) return 'Each step needs exactly one next step';
    if (n.type === 'decision' && (outgoing.length !== 2 || !outgoing.some(e => e.condition === 'true') || !outgoing.some(e => e.condition === 'false'))) return 'Decisions need true and false connections';
    if (n.type === 'wait' && (!Number.isInteger(config.minutes) || config.minutes < 1 || config.minutes > 525600)) return 'Wait must be 1–525600 minutes';
    if (n.type === 'decision') {
      const problem = workflowProblem({ module: flow.module, conditions: config.conditions });
      if (problem || !Array.isArray(config.conditions) || !config.conditions.length) return problem || 'Add decision conditions';
    }
    if (n.type === 'action') {
      // Database actions and checkpoints commit together. External delivery
      // belongs to the mail outbox, not to a retried transaction.
      if (!['updateField', 'createActivity', 'createNotification'].includes(config.action?.type)) return 'Choose a field update, activity or notification';
      const problem = workflowProblem({ module: flow.module, actions: [config.action] });
      if (problem) return problem;
    }
  }
  // No cycles: a flow may wait for time, but cannot run an unbounded loop.
  const visiting = new Set(), visited = new Set();
  function cycle(id) {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const edge of edges.filter(e => e.source === id)) if (cycle(edge.target)) return true;
    visiting.delete(id); visited.add(id); return false;
  }
  const start = nodes.find(n => n.type === 'start');
  if (cycle(start.id)) return 'Flow connections cannot contain cycles';
  if (visited.size !== nodes.length) return 'Every step must be reachable from Start';
  return workflowProblem({ module: flow.module, conditions: flow.triggerConditions });
}

async function startFlow(db, flow, record, userId, oldRecord = null) {
  const problem = flowProblem(flow);
  if (problem) throw Object.assign(new Error(problem), { status: 400 });
  const run = await db.flowRun.create({ data: {
    flowId: flow.id, triggerRecordId: record.id, triggerModule: flow.module,
    context: { canvas: flow.canvas, version: flow.version, name: flow.name, userId,
      nodeId: flow.canvas.nodes.find(n => n.type === 'start').id, attempts: 0, oldRecord },
    log: [],
  } });
  return resumeFlow(db, run.id);
}

async function resumeFlow(prisma, runId, retry = false, now = new Date()) {
  for (let step = 0; step < 101; step++) {
    let finished;
    const after = [];
    try {
      finished = await prisma.$transaction(async db => {
        await db.$queryRaw`SELECT id FROM "FlowRun" WHERE id = ${runId} FOR UPDATE`;
        const run = await db.flowRun.findUnique({ where: { id: runId } });
        if (!run || run.status === 'Completed' || (run.status === 'Failed' && !retry)) return true;
        const context = { ...run.context };
        if (run.status === 'Paused' && new Date(context.resumeAt) > now) return true;
        const model = resolveModel(run.triggerModule);
        const record = await db[model].findFirst({ where: { id: run.triggerRecordId, ...(modelHasField(model, 'deletedAt') && { deletedAt: null }) } });
        if (!record) throw new Error('Trigger record is no longer available');
        const actor = await db.user.findFirst({ where: { id: context.userId, active: true, isPortalUser: false }, select: { id: true } });
        if (!actor) throw new Error('Flow actor is no longer active');
        const node = context.canvas.nodes.find(n => n.id === context.nodeId);
        if (!node) throw new Error('Stored flow step is missing');
        const log = [...(run.log || [])];
        let branch;
        if (node.type === 'decision') branch = String(evaluateConditions(node.config.conditions, record, context.oldRecord));
        if (node.type === 'action') {
          if (node.config.action.type === 'updateField') {
            const { field, value } = node.config.action.config;
            await require('./recordWrites').updateRecord(db, run.triggerModule, record, { [field]: value }, { userId: context.userId, source: 'flow ' + run.flowId, skipWorkflows: true, after, prisma });
          } else await runActions(db, { name: context.name, actions: [node.config.action] }, { moduleName: run.triggerModule, modelName: model, record, userId: context.userId });
        }
        if (node.type === 'action') await require('./searchIndexing').enqueueIndex(db, run.triggerModule, record.id);
        log.push({ nodeId: node.id, type: node.type, at: now.toISOString(), ...(branch && { branch }) });
        const next = context.canvas.edges.find(e => e.source === node.id && (!branch || e.condition === branch));
        context.nodeId = next?.target || null;
        context.attempts = 0;
        const status = node.type === 'end' ? 'Completed' : node.type === 'wait' ? 'Paused' : 'Running';
        if (node.type === 'wait') context.resumeAt = new Date(now.getTime() + node.config.minutes * 60000).toISOString();
        else delete context.resumeAt;
        await db.flowRun.update({ where: { id: runId }, data: { status, context, log, error: null, ...(status === 'Completed' && { completedAt: now }) } });
        return status !== 'Running';
      }, { timeout: 30000 });
    } catch (err) {
      // The action and checkpoint rolled back together, so retrying this step
      // cannot repeat a committed notification or activity.
      await prisma.$transaction(async db => {
        await db.$queryRaw`SELECT id FROM "FlowRun" WHERE id = ${runId} FOR UPDATE`;
        const run = await db.flowRun.findUnique({ where: { id: runId } });
        if (!run || run.status === 'Completed') return;
        const attempts = (run.context?.attempts || 0) + 1;
        await db.flowRun.update({ where: { id: runId }, data: { status: attempts < 3 ? 'Paused' : 'Failed',
          context: { ...run.context, attempts, resumeAt: new Date(now.getTime() + attempts * 60000).toISOString() }, error: String(err.message).slice(0, 400) } });
      });
      break;
    }
    await require('./recordWrites').runAfter(after);
    if (finished) break;
  }
  return prisma.flowRun.findUnique({ where: { id: runId } });
}

async function triggerFlows(db, { module, trigger, record, oldRecord, userId }) {
  const flows = await db.flowDefinition.findMany({ where: { module, type: 'RecordTriggered', status: 'Active', triggerType: trigger } });
  for (const flow of flows) {
    if (!evaluateConditions(flow.triggerConditions, record, oldRecord)) continue;
    try { await startFlow(db, flow, record, flow.createdById, oldRecord); }
    catch (err) {
      await db.flowRun.create({ data: { flowId: flow.id, triggerRecordId: record.id, triggerModule: module, status: 'Failed', error: String(err.message).slice(0, 400), log: [], completedAt: new Date() } });
    }
  }
}

async function resumeDueFlows(db) {
  const runs = await db.flowRun.findMany({ where: { OR: [{ status: 'Running' }, { status: 'Paused', context: { path: ['resumeAt'], lte: new Date().toISOString() } }] }, orderBy: { startedAt: 'asc' }, take: 200 });
  for (const run of runs) await resumeFlow(db, run.id);
  return { checked: runs.length };
}

module.exports = { flowProblem, startFlow, resumeFlow, triggerFlows, resumeDueFlows };
