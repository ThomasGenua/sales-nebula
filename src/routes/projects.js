const { Router } = require('express');
const { authenticate, requirePermission } = require('../middleware/auth');
const { auditMiddleware } = require('../middleware/audit');
const { moduleAccess, recordAccess, reachableWhere } = require('../middleware/access');
const { isAdmin } = require('../middleware/rowSecurity');
const { editableFields } = require('../utils/modelFields');
const {
  calculateCriticalPath, wouldCreateCycle, assignWbsCodes,
  rollUpProgress, buildGanttRows, addDays, diffDays,
} = require('../utils/scheduling');

const router = Router();

// The projects permission for every route, read to look and edit to change,
// and a project a route names must be one row security lets the caller see
// (or change). Reads, budgets and hourly rates among them, took a session
// alone, and so did logging time against any project.
router.use(authenticate, moduleAccess('projects'));
router.param('id', recordAccess('projects', 'project'));

/**
 * The live project, when the caller may change it: its owner or manager, or
 * an admin, and for task and time writes (`team: true`) anyone on its team.
 * Otherwise it answers 404 or 403 and returns null. Every write here took
 * any project with projects:edit alone.
 */
async function projectToChange(req, res, projectId, { team = false } = {}) {
  const prisma = req.app.locals.prisma;
  const project = projectId ? await prisma.project.findFirst({ where: { id: String(projectId), deletedAt: null } }) : null;
  if (!project) { res.status(404).json({ error: 'Project not found' }); return null; }
  const me = req.user.id;
  if (isAdmin(req.user) || project.ownerId === me || project.managerId === me) return project;
  if (team && await prisma.projectResource.findFirst({ where: { projectId: project.id, userId: me }, select: { id: true } })) return project;
  res.status(403).json({ error: team ? 'Only the project team can change its tasks and time' : 'Only the project owner or manager can change this project' });
  return null;
}

// What a project update may set. The body went to Prisma whole, so a caller
// could hand the project to anyone (ownerId, managerId) or rewrite its time
// entries through `timeEntries`.
const PROJECT_FIELDS = [
  'name', 'code', 'description', 'status', 'priority', 'health',
  'startDate', 'endDate', 'actualStart', 'actualEnd', 'percentComplete',
  'budget', 'estimatedHours', 'currency', 'accountId', 'dealId', 'contactId',
];

/** Recompute derived project fields from its task set. */
async function recalcProject(prisma, projectId) {
  const [project, tasks, timeEntries] = await Promise.all([
    prisma.project.findUnique({ where: { id: projectId } }),
    prisma.projectTask.findMany({ where: { projectId, deletedAt: null } }),
    prisma.timeEntry.findMany({ where: { projectId, deletedAt: null }, select: { hours: true, hourlyRate: true } }),
  ]);
  if (!project) return null;

  const { projectPercent } = rollUpProgress(tasks);
  const actualHours = timeEntries.reduce((s, t) => s + (t.hours || 0), 0);
  const actualCost = timeEntries.reduce((s, t) => s + (t.hours || 0) * (t.hourlyRate || 0), 0);

  // Health from schedule slip and budget burn
  let health = 'Green';
  const now = new Date();
  if (project.endDate && now > new Date(project.endDate) && projectPercent < 100) health = 'Red';
  else if (project.budget && actualCost > project.budget) health = 'Red';
  else if (project.startDate && project.endDate) {
    const elapsed = diffDays(project.startDate, now);
    const total = diffDays(project.startDate, project.endDate);
    if (total > 0) {
      const expected = Math.min(100, Math.max(0, (elapsed / total) * 100));
      if (projectPercent < expected - 20) health = 'Red';
      else if (projectPercent < expected - 10) health = 'Amber';
    }
    if (project.budget && actualCost > project.budget * 0.9 && health === 'Green') health = 'Amber';
  }

  return prisma.project.update({
    where: { id: projectId },
    data: { percentComplete: projectPercent, actualHours: +actualHours.toFixed(2), actualCost: +actualCost.toFixed(2), health },
  });
}

// ── PROJECTS ──────────────────────────────────────────────────────────

router.get('/', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { page = 1, limit = 50, search, status, health, managerId, accountId, mine, sortBy = 'createdAt', sortDir = 'desc' } = req.query;
    const where = { deletedAt: null };
    if (search) where.OR = [{ name: { contains: search, mode: 'insensitive' } }, { code: { contains: search, mode: 'insensitive' } }, { description: { contains: search, mode: 'insensitive' } }];
    if (status) where.status = status;
    if (health) where.health = health;
    if (managerId) where.managerId = managerId;
    if (accountId) where.accountId = accountId;
    if (mine === 'true') where.OR = [{ managerId: req.user.id }, { ownerId: req.user.id }, { resources: { some: { userId: req.user.id } } }];
    const visible = await reachableWhere(req, 'projects', 'project', where);

    const [data, total] = await Promise.all([
      prisma.project.findMany({
        where: visible, skip: (+page - 1) * +limit, take: +limit,
        orderBy: { [sortBy]: sortDir },
        include: { _count: { select: { tasks: true, milestones: true, resources: true } } },
      }),
      prisma.project.count({ where: visible }),
    ]);
    res.json({ data, total, page: +page, limit: +limit });
  } catch (err) { next(err); }
});

router.get('/:id', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const project = await prisma.project.findFirst({
      where: { id: req.params.id, deletedAt: null },
      include: {
        milestones: { orderBy: { sortOrder: 'asc' } },
        resources: true,
        _count: { select: { tasks: true, timeEntries: true } },
      },
    });
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const tasks = await prisma.projectTask.findMany({ where: { projectId: project.id, deletedAt: null } });
    const byStatus = tasks.reduce((acc, t) => { acc[t.status] = (acc[t.status] || 0) + 1; return acc; }, {});
    const overdue = tasks.filter(t => t.endDate && new Date(t.endDate) < new Date() && t.status !== 'Completed').length;

    res.json({ ...project, taskSummary: { total: tasks.length, byStatus, overdue } });
  } catch (err) { next(err); }
});

router.post('/', authenticate, requirePermission('projects', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, code, description, status, priority, startDate, endDate, budget, estimatedHours, currency, managerId, accountId, dealId, contactId, resources } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    if (startDate && endDate && new Date(endDate) < new Date(startDate)) return res.status(400).json({ error: 'endDate must be after startDate' });

    const project = await prisma.project.create({
      data: {
        name, code, description,
        status: status || 'Draft', priority: priority || 'Medium',
        startDate: startDate ? new Date(startDate) : null,
        endDate: endDate ? new Date(endDate) : null,
        budget: budget != null ? +budget : null,
        estimatedHours: estimatedHours != null ? +estimatedHours : null,
        currency: currency || 'USD',
        managerId: managerId || req.user.id, ownerId: req.user.id,
        accountId, dealId, contactId,
      },
    });

    const team = resources?.length ? resources : [{ userId: req.user.id, role: 'Manager' }];
    for (const r of team) {
      if (!r.userId) continue;
      await prisma.projectResource.create({
        data: { projectId: project.id, userId: r.userId, role: r.role || 'Member', allocationPct: r.allocationPct ?? 100, hourlyRate: r.hourlyRate != null ? +r.hourlyRate : null },
      }).catch(() => {});
    }

    await req.audit({ action: 'create', module: 'projects', recordId: project.id, details: `Project created: ${name}` });
    res.status(201).json(project);
  } catch (err) { next(err); }
});

router.put('/:id', authenticate, requirePermission('projects', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    if (!(await projectToChange(req, res, req.params.id))) return;
    const data = {};
    for (const f of PROJECT_FIELDS) if (req.body[f] !== undefined) data[f] = req.body[f];
    for (const f of ['startDate', 'endDate', 'actualStart', 'actualEnd']) {
      if (data[f]) data[f] = new Date(data[f]);
    }
    if (data.startDate && data.endDate && data.endDate < data.startDate) {
      return res.status(400).json({ error: 'endDate must be after startDate' });
    }
    if (data.status === 'Active' && !data.actualStart) data.actualStart = new Date();
    if (data.status === 'Completed') { data.actualEnd = new Date(); data.percentComplete = 100; }

    const project = await prisma.project.update({ where: { id: req.params.id }, data });
    await req.audit({ action: 'update', module: 'projects', recordId: project.id, details: `Project updated: ${project.name}` });
    res.json(project);
  } catch (err) { next(err); }
});

router.delete('/:id', authenticate, requirePermission('projects', 'full'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    if (!(await projectToChange(req, res, req.params.id))) return;
    const project = await prisma.project.update({ where: { id: req.params.id }, data: { deletedAt: new Date() } });
    await prisma.projectTask.updateMany({ where: { projectId: project.id }, data: { deletedAt: new Date() } });
    await req.audit({ action: 'delete', module: 'projects', recordId: project.id, details: `Project deleted: ${project.name}` });
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// ── TASKS ─────────────────────────────────────────────────────────────

router.get('/:id/tasks', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { status, assignedToId, flat } = req.query;
    const where = { projectId: req.params.id, deletedAt: null };
    if (status) where.status = status;
    if (assignedToId) where.assignedToId = assignedToId;

    const tasks = await prisma.projectTask.findMany({
      where,
      include: { predecessors: true, successors: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });

    const wbs = assignWbsCodes(tasks);
    const enriched = tasks.map(t => ({ ...t, wbsCode: wbs.get(t.id) || t.wbsCode }));
    if (flat === 'true') return res.json(enriched);

    // Nest into a tree
    const byId = new Map(enriched.map(t => [t.id, { ...t, subtasks: [] }]));
    const roots = [];
    for (const t of byId.values()) {
      if (t.parentTaskId && byId.has(t.parentTaskId)) byId.get(t.parentTaskId).subtasks.push(t);
      else roots.push(t);
    }
    res.json(roots);
  } catch (err) { next(err); }
});

router.post('/:id/tasks', authenticate, requirePermission('projects', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const project = await projectToChange(req, res, req.params.id, { team: true });
    if (!project) return;

    const { name, description, status, priority, taskType, startDate, endDate, durationDays, estimatedHours, parentTaskId, assignedToId, milestoneId, sortOrder, dependsOn } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    if (startDate && endDate && new Date(endDate) < new Date(startDate)) return res.status(400).json({ error: 'endDate must be after startDate' });

    if (parentTaskId) {
      const parent = await prisma.projectTask.findFirst({ where: { id: parentTaskId, projectId: project.id, deletedAt: null } });
      if (!parent) return res.status(400).json({ error: 'parentTaskId not found in this project' });
    }

    let order = sortOrder;
    if (order == null) {
      const last = await prisma.projectTask.findFirst({ where: { projectId: project.id, parentTaskId: parentTaskId || null }, orderBy: { sortOrder: 'desc' } });
      order = (last?.sortOrder ?? -1) + 1;
    }

    const task = await prisma.projectTask.create({
      data: {
        projectId: project.id, name, description,
        status: status || 'NotStarted', priority: priority || 'Medium', taskType: taskType || 'Task',
        startDate: startDate ? new Date(startDate) : null,
        endDate: endDate ? new Date(endDate) : null,
        durationDays: durationDays != null ? +durationDays : (startDate && endDate ? diffDays(startDate, endDate) : null),
        estimatedHours: estimatedHours != null ? +estimatedHours : null,
        parentTaskId: parentTaskId || null, assignedToId, milestoneId, sortOrder: order,
      },
    });

    for (const depId of dependsOn || []) {
      const existing = await prisma.taskDependency.findMany({ where: { successor: { projectId: project.id } } });
      if (wouldCreateCycle(existing, depId, task.id)) continue;
      await prisma.taskDependency.create({ data: { predecessorId: depId, successorId: task.id, dependencyType: 'FS', lagDays: 0 } }).catch(() => {});
    }

    await recalcProject(prisma, project.id);
    await req.audit({ action: 'create', module: 'projects', recordId: task.id, details: `Task created: ${name}` });
    res.status(201).json(task);
  } catch (err) { next(err); }
});

router.put('/tasks/:taskId', authenticate, requirePermission('projects', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const existing = await prisma.projectTask.findFirst({ where: { id: req.params.taskId, deletedAt: null } });
    if (!existing) return res.status(404).json({ error: 'Task not found' });
    if (!(await projectToChange(req, res, existing.projectId, { team: true }))) return;

    // The task's own columns: relation keys reached its project (`project:
    // { update: { ownerId } }`) and other tasks' time entries.
    const data = editableFields('projectTask', req.body);
    delete data.projectId;
    for (const f of ['startDate', 'endDate', 'actualStart', 'actualEnd']) {
      if (data[f]) data[f] = new Date(data[f]);
    }
    if (data.startDate && data.endDate && data.endDate < data.startDate) {
      return res.status(400).json({ error: 'endDate must be after startDate' });
    }
    // Reparenting must not create a loop in the hierarchy
    if (data.parentTaskId) {
      let cursor = data.parentTaskId, guard = 0;
      while (cursor && guard++ < 100) {
        if (cursor === existing.id) return res.status(400).json({ error: 'Cannot make a task a descendant of itself' });
        const p = await prisma.projectTask.findUnique({ where: { id: cursor }, select: { parentTaskId: true } });
        cursor = p?.parentTaskId;
      }
    }
    if (data.status === 'InProgress' && !existing.actualStart) data.actualStart = new Date();
    if (data.status === 'Completed') { data.actualEnd = new Date(); data.percentComplete = 100; }
    if (data.startDate && data.endDate) data.durationDays = diffDays(data.startDate, data.endDate);

    const task = await prisma.projectTask.update({ where: { id: existing.id }, data });
    await recalcProject(prisma, task.projectId);
    await req.audit({ action: 'update', module: 'projects', recordId: task.id, details: `Task updated: ${task.name}` });
    res.json(task);
  } catch (err) { next(err); }
});

router.delete('/tasks/:taskId', authenticate, requirePermission('projects', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const task = await prisma.projectTask.findFirst({ where: { id: req.params.taskId, deletedAt: null } });
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (!(await projectToChange(req, res, task.projectId, { team: true }))) return;
    await prisma.projectTask.updateMany({ where: { OR: [{ id: task.id }, { parentTaskId: task.id }] }, data: { deletedAt: new Date() } });
    await prisma.taskDependency.deleteMany({ where: { OR: [{ predecessorId: task.id }, { successorId: task.id }] } });
    await recalcProject(prisma, task.projectId);
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// Drag-and-drop reorder / reparent
router.post('/:id/tasks/reorder', authenticate, requirePermission('projects', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { moves } = req.body;
    if (!Array.isArray(moves)) return res.status(400).json({ error: 'moves array required' });
    const project = await projectToChange(req, res, req.params.id, { team: true });
    if (!project) return;
    let updated = 0;
    for (const m of moves) {
      if (!m.taskId) continue;
      // This project's tasks only; a move named any task in any project.
      const { count } = await prisma.projectTask.updateMany({
        where: { id: String(m.taskId), projectId: project.id },
        data: { sortOrder: m.sortOrder ?? 0, ...(m.parentTaskId !== undefined && { parentTaskId: m.parentTaskId }) },
      }).catch(() => ({ count: 0 }));
      updated += count;
    }
    res.json({ updated });
  } catch (err) { next(err); }
});

// Bulk status change
router.post('/:id/tasks/bulk-status', authenticate, requirePermission('projects', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { taskIds, status } = req.body;
    if (!taskIds?.length || !status) return res.status(400).json({ error: 'taskIds and status required' });
    if (!(await projectToChange(req, res, req.params.id, { team: true }))) return;
    const data = { status };
    if (status === 'Completed') { data.percentComplete = 100; data.actualEnd = new Date(); }
    const result = await prisma.projectTask.updateMany({ where: { id: { in: taskIds }, projectId: req.params.id }, data });
    await recalcProject(prisma, req.params.id);
    res.json({ updated: result.count });
  } catch (err) { next(err); }
});

// ── DEPENDENCIES ──────────────────────────────────────────────────────

router.post('/tasks/:taskId/dependencies', authenticate, requirePermission('projects', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { predecessorId, dependencyType = 'FS', lagDays = 0 } = req.body;
    if (!predecessorId) return res.status(400).json({ error: 'predecessorId required' });
    if (!['FS', 'SS', 'FF', 'SF'].includes(dependencyType)) return res.status(400).json({ error: 'dependencyType must be FS, SS, FF, or SF' });

    const successor = await prisma.projectTask.findFirst({ where: { id: req.params.taskId, deletedAt: null } });
    const predecessor = await prisma.projectTask.findFirst({ where: { id: predecessorId, deletedAt: null } });
    if (!successor || !predecessor) return res.status(404).json({ error: 'Task not found' });
    if (successor.projectId !== predecessor.projectId) return res.status(400).json({ error: 'Tasks must be in the same project' });
    if (!(await projectToChange(req, res, successor.projectId, { team: true }))) return;

    const existing = await prisma.taskDependency.findMany({ where: { successor: { projectId: successor.projectId } } });
    if (wouldCreateCycle(existing, predecessorId, successor.id)) {
      return res.status(409).json({ error: 'That dependency would create a circular reference' });
    }

    const dep = await prisma.taskDependency.create({ data: { predecessorId, successorId: successor.id, dependencyType, lagDays: +lagDays } });
    res.status(201).json(dep);
  } catch (err) { next(err); }
});

router.delete('/dependencies/:depId', authenticate, requirePermission('projects', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const dep = await prisma.taskDependency.findUnique({ where: { id: req.params.depId }, include: { successor: { select: { projectId: true } } } });
    if (!dep) return res.status(404).json({ error: 'Dependency not found' });
    if (!(await projectToChange(req, res, dep.successor.projectId, { team: true }))) return;
    await prisma.taskDependency.delete({ where: { id: dep.id } });
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// ── GANTT AND CRITICAL PATH ───────────────────────────────────────────

router.get('/:id/gantt', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const project = await prisma.project.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const tasks = await prisma.projectTask.findMany({
      where: { projectId: project.id, deletedAt: null },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    const dependencies = await prisma.taskDependency.findMany({ where: { successor: { projectId: project.id } } });

    const cpm = calculateCriticalPath(tasks, dependencies, project.startDate || new Date());
    const wbs = assignWbsCodes(tasks);
    const rows = buildGanttRows(tasks, cpm.schedule, wbs);

    const links = dependencies.map(d => ({ id: d.id, source: d.predecessorId, target: d.successorId, type: d.dependencyType, lagDays: d.lagDays }));
    const milestones = await prisma.projectMilestone.findMany({ where: { projectId: project.id }, orderBy: { dueDate: 'asc' } });

    res.json({
      project: { id: project.id, name: project.name, startDate: project.startDate, endDate: project.endDate, percentComplete: project.percentComplete },
      rows, links, milestones,
      criticalPath: cpm.criticalPath,
      projectDuration: cpm.projectDuration,
      computedFinish: cpm.projectFinish,
      hasCycle: cpm.cycle.length > 0,
      cycleTasks: cpm.cycle,
    });
  } catch (err) { next(err); }
});

// Persist the CPM result back onto the tasks
router.post('/:id/reschedule', authenticate, requirePermission('projects', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const project = await projectToChange(req, res, req.params.id);
    if (!project) return;

    const tasks = await prisma.projectTask.findMany({ where: { projectId: project.id, deletedAt: null } });
    const dependencies = await prisma.taskDependency.findMany({ where: { successor: { projectId: project.id } } });
    const cpm = calculateCriticalPath(tasks, dependencies, req.body.startDate || project.startDate || new Date());
    if (cpm.cycle.length) return res.status(409).json({ error: 'Circular dependency detected', cycleTasks: cpm.cycle });

    const wbs = assignWbsCodes(tasks);
    for (const s of cpm.schedule) {
      await prisma.projectTask.update({
        where: { id: s.taskId },
        data: { startDate: s.earliestStart, endDate: s.earliestFinish, isCriticalPath: s.isCritical, slackDays: s.totalFloat, wbsCode: wbs.get(s.taskId) },
      });
    }
    await prisma.project.update({ where: { id: project.id }, data: { endDate: cpm.projectFinish } });
    await recalcProject(prisma, project.id);

    await req.audit({ action: 'update', module: 'projects', recordId: project.id, details: `Rescheduled: ${cpm.schedule.length} tasks, ${cpm.criticalPath.length} on critical path` });
    res.json({ rescheduled: cpm.schedule.length, criticalPath: cpm.criticalPath, projectFinish: cpm.projectFinish, projectDuration: cpm.projectDuration });
  } catch (err) { next(err); }
});

// ── MILESTONES ────────────────────────────────────────────────────────

router.get('/:id/milestones', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const milestones = await prisma.projectMilestone.findMany({ where: { projectId: req.params.id }, orderBy: [{ sortOrder: 'asc' }, { dueDate: 'asc' }] });
    const now = new Date();
    const enriched = milestones.map(m => ({
      ...m,
      isOverdue: m.dueDate && !m.completedAt && new Date(m.dueDate) < now,
      daysRemaining: m.dueDate && !m.completedAt ? Math.ceil(diffDays(now, m.dueDate)) : null,
    }));
    res.json(enriched);
  } catch (err) { next(err); }
});

router.post('/:id/milestones', authenticate, requirePermission('projects', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, description, dueDate, isBillable, amount, sortOrder } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    if (!(await projectToChange(req, res, req.params.id))) return;
    const milestone = await prisma.projectMilestone.create({
      data: { projectId: req.params.id, name, description, dueDate: dueDate ? new Date(dueDate) : null, isBillable: !!isBillable, amount: amount != null ? +amount : null, sortOrder: sortOrder ?? 0 },
    });
    res.status(201).json(milestone);
  } catch (err) { next(err); }
});

router.post('/milestones/:milestoneId/complete', authenticate, requirePermission('projects', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const found = await prisma.projectMilestone.findUnique({ where: { id: req.params.milestoneId }, select: { id: true, projectId: true } });
    if (!found) return res.status(404).json({ error: 'Milestone not found' });
    if (!(await projectToChange(req, res, found.projectId))) return;
    const milestone = await prisma.projectMilestone.update({
      where: { id: found.id },
      data: { status: 'Completed', completedAt: new Date() },
    });
    await req.audit({ action: 'update', module: 'projects', recordId: milestone.id, details: `Milestone completed: ${milestone.name}` });
    res.json(milestone);
  } catch (err) { next(err); }
});

router.put('/milestones/:milestoneId', authenticate, requirePermission('projects', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const found = await prisma.projectMilestone.findUnique({ where: { id: req.params.milestoneId }, select: { id: true, projectId: true } });
    if (!found) return res.status(404).json({ error: 'Milestone not found' });
    if (!(await projectToChange(req, res, found.projectId))) return;
    // Its own columns; `project: { update: ... }` reached the project itself.
    const data = editableFields('projectMilestone', req.body);
    delete data.projectId;
    if (data.dueDate) data.dueDate = new Date(data.dueDate);
    const milestone = await prisma.projectMilestone.update({ where: { id: found.id }, data });
    res.json(milestone);
  } catch (err) { next(err); }
});

router.delete('/milestones/:milestoneId', authenticate, requirePermission('projects', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const found = await prisma.projectMilestone.findUnique({ where: { id: req.params.milestoneId }, select: { id: true, projectId: true } });
    if (!found) return res.status(404).json({ error: 'Milestone not found' });
    if (!(await projectToChange(req, res, found.projectId))) return;
    await prisma.projectMilestone.delete({ where: { id: found.id } });
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

// ── RESOURCES AND ALLOCATION ──────────────────────────────────────────

router.get('/:id/resources', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const resources = await prisma.projectResource.findMany({ where: { projectId: req.params.id } });
    const enriched = [];
    for (const r of resources) {
      const [assigned, logged] = await Promise.all([
        prisma.projectTask.count({ where: { projectId: req.params.id, assignedToId: r.userId, deletedAt: null, status: { notIn: ['Completed', 'Cancelled'] } } }),
        prisma.timeEntry.aggregate({ where: { projectId: req.params.id, userId: r.userId, deletedAt: null }, _sum: { hours: true } }),
      ]);
      enriched.push({ ...r, openTasks: assigned, hoursLogged: logged._sum.hours || 0 });
    }
    res.json(enriched);
  } catch (err) { next(err); }
});

router.post('/:id/resources', authenticate, requirePermission('projects', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { userId, role, allocationPct, hourlyRate, startDate, endDate } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId required' });
    if (!(await projectToChange(req, res, req.params.id))) return;
    const existing = await prisma.projectResource.findFirst({ where: { projectId: req.params.id, userId } });
    if (existing) return res.status(409).json({ error: 'User is already on this project' });

    const resource = await prisma.projectResource.create({
      data: { projectId: req.params.id, userId, role: role || 'Member', allocationPct: allocationPct ?? 100, hourlyRate: hourlyRate != null ? +hourlyRate : null, startDate: startDate ? new Date(startDate) : null, endDate: endDate ? new Date(endDate) : null },
    });
    res.status(201).json(resource);
  } catch (err) { next(err); }
});

router.delete('/:id/resources/:userId', authenticate, requirePermission('projects', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    if (!(await projectToChange(req, res, req.params.id))) return;
    await prisma.projectResource.deleteMany({ where: { projectId: req.params.id, userId: req.params.userId } });
    res.json({ removed: true });
  } catch (err) { next(err); }
});

// Over-allocation across all active projects
router.get('/reports/allocation', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    // Across the active projects the caller can see.
    const projectWhere = await reachableWhere(req, 'projects', 'project', { status: { in: ['Planning', 'Active'] } });
    const allocations = await prisma.projectResource.findMany({
      where: { project: { is: projectWhere } },
      include: { project: { select: { id: true, name: true, status: true } } },
    });
    const byUser = {};
    for (const a of allocations) {
      if (!byUser[a.userId]) byUser[a.userId] = { userId: a.userId, totalPct: 0, projects: [] };
      byUser[a.userId].totalPct += a.allocationPct || 0;
      byUser[a.userId].projects.push({ projectId: a.projectId, name: a.project?.name, role: a.role, allocationPct: a.allocationPct });
    }
    const rows = Object.values(byUser).map(u => ({ ...u, isOverAllocated: u.totalPct > 100 }));
    rows.sort((a, b) => b.totalPct - a.totalPct);
    res.json({ users: rows, overAllocated: rows.filter(r => r.isOverAllocated).length });
  } catch (err) { next(err); }
});

// ── TIME TRACKING ─────────────────────────────────────────────────────

router.get('/:id/time', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { userId, from, to, billable } = req.query;
    const where = { projectId: req.params.id, deletedAt: null };
    if (userId) where.userId = userId;
    if (billable !== undefined) where.billable = billable === 'true';
    if (from || to) {
      where.entryDate = {};
      if (from) where.entryDate.gte = new Date(from);
      if (to) where.entryDate.lte = new Date(to);
    }
    const entries = await prisma.timeEntry.findMany({ where, orderBy: { entryDate: 'desc' }, take: 500 });
    const totalHours = entries.reduce((s, e) => s + (e.hours || 0), 0);
    const billableHours = entries.filter(e => e.billable).reduce((s, e) => s + (e.hours || 0), 0);
    const amount = entries.filter(e => e.billable).reduce((s, e) => s + (e.hours || 0) * (e.hourlyRate || 0), 0);
    res.json({ entries, totalHours: +totalHours.toFixed(2), billableHours: +billableHours.toFixed(2), billableAmount: +amount.toFixed(2) });
  } catch (err) { next(err); }
});

router.post('/:id/time', authenticate, auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { taskId, entryDate, hours, description, billable } = req.body;
    if (hours == null || +hours <= 0) return res.status(400).json({ error: 'hours must be greater than zero' });
    if (+hours > 24) return res.status(400).json({ error: 'hours cannot exceed 24 for a single entry' });
    // Time goes on a project the caller works on, against one of its own
    // tasks: a task named from another project had its hours rewritten below.
    if (!(await projectToChange(req, res, req.params.id, { team: true }))) return;
    if (taskId && !(await prisma.projectTask.findFirst({ where: { id: String(taskId), projectId: req.params.id, deletedAt: null }, select: { id: true } }))) {
      return res.status(400).json({ error: 'taskId not found in this project' });
    }

    const resource = await prisma.projectResource.findFirst({ where: { projectId: req.params.id, userId: req.user.id } });

    const entry = await prisma.timeEntry.create({
      data: {
        projectId: req.params.id, taskId: taskId || null, userId: req.user.id,
        entryDate: entryDate ? new Date(entryDate) : new Date(),
        hours: +hours, description, billable: billable !== false,
        hourlyRate: resource?.hourlyRate ?? null,
      },
    });

    if (taskId) {
      const agg = await prisma.timeEntry.aggregate({ where: { taskId, deletedAt: null }, _sum: { hours: true } });
      await prisma.projectTask.update({ where: { id: taskId }, data: { actualHours: agg._sum.hours || 0 } });
    }
    await recalcProject(prisma, req.params.id);
    res.status(201).json(entry);
  } catch (err) { next(err); }
});

router.delete('/time/:entryId', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const entry = await prisma.timeEntry.findUnique({ where: { id: req.params.entryId } });
    if (!entry) return res.status(404).json({ error: 'Time entry not found' });
    // req.user.role is the role record, so comparing it to 'admin' never matched.
    if (entry.userId !== req.user.id && !isAdmin(req.user)) return res.status(403).json({ error: 'Not your time entry' });
    if (entry.billed) return res.status(400).json({ error: 'Cannot delete a billed time entry' });
    await prisma.timeEntry.update({ where: { id: entry.id }, data: { deletedAt: new Date() } });
    if (entry.projectId) await recalcProject(prisma, entry.projectId);
    res.json({ deleted: true });
  } catch (err) { next(err); }
});

router.post('/time/approve', authenticate, requirePermission('projects', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { entryIds } = req.body;
    if (!Array.isArray(entryIds) || !entryIds.length) return res.status(400).json({ error: 'entryIds required' });
    // Time on projects the caller owns or manages; this approved any entry.
    const where = { id: { in: entryIds.map(String) } };
    if (!isAdmin(req.user)) where.project = { is: { OR: [{ ownerId: req.user.id }, { managerId: req.user.id }] } };
    const result = await prisma.timeEntry.updateMany({ where, data: { approvedById: req.user.id, approvedAt: new Date() } });
    res.json({ approved: result.count });
  } catch (err) { next(err); }
});

// My timesheet
router.get('/time/my-timesheet', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 7 * 86400000);
    const to = req.query.to ? new Date(req.query.to) : new Date();
    const entries = await prisma.timeEntry.findMany({
      where: { userId: req.user.id, deletedAt: null, entryDate: { gte: from, lte: to } },
      include: { project: { select: { id: true, name: true } }, task: { select: { id: true, name: true } } },
      orderBy: { entryDate: 'desc' },
    });
    const byDate = {};
    for (const e of entries) {
      const k = new Date(e.entryDate).toISOString().slice(0, 10);
      if (!byDate[k]) byDate[k] = { date: k, hours: 0, entries: [] };
      byDate[k].hours += e.hours || 0;
      byDate[k].entries.push(e);
    }
    res.json({ from, to, totalHours: +entries.reduce((s, e) => s + (e.hours || 0), 0).toFixed(2), days: Object.values(byDate).sort((a, b) => b.date.localeCompare(a.date)) });
  } catch (err) { next(err); }
});

// ── TEMPLATES ─────────────────────────────────────────────────────────

router.get('/templates/list', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const templates = await prisma.projectTemplate.findMany({
      where: { deletedAt: null, active: true },
      include: { _count: { select: { taskTemplates: true } } },
      orderBy: { usageCount: 'desc' },
    });
    res.json(templates);
  } catch (err) { next(err); }
});

router.post('/templates', authenticate, requirePermission('projects', 'edit'), async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const { name, description, category, defaultDurationDays, tasks } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });

    const template = await prisma.projectTemplate.create({
      data: { name, description, category, defaultDurationDays: defaultDurationDays != null ? +defaultDurationDays : null, createdById: req.user.id },
    });
    for (const [i, t] of (tasks || []).entries()) {
      await prisma.taskTemplate.create({
        data: {
          projectTemplateId: template.id, name: t.name, description: t.description,
          taskType: t.taskType || 'Task', offsetDays: t.offsetDays ?? 0,
          durationDays: t.durationDays ?? 1, estimatedHours: t.estimatedHours != null ? +t.estimatedHours : null,
          defaultRole: t.defaultRole, sortOrder: t.sortOrder ?? i,
          templateKey: t.templateKey || `t${i}`, parentKey: t.parentKey || null,
          dependsOnKeys: t.dependsOnKeys || null,
        },
      });
    }
    res.status(201).json(template);
  } catch (err) { next(err); }
});

// Save an existing project's structure as a reusable template
router.post('/:id/save-as-template', authenticate, requirePermission('projects', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const project = await prisma.project.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const tasks = await prisma.projectTask.findMany({ where: { projectId: project.id, deletedAt: null }, orderBy: { sortOrder: 'asc' } });
    const deps = await prisma.taskDependency.findMany({ where: { successor: { projectId: project.id } } });
    const anchor = project.startDate ? new Date(project.startDate) : new Date();

    const template = await prisma.projectTemplate.create({
      data: {
        name: req.body.name || `${project.name} Template`,
        description: req.body.description || project.description,
        category: req.body.category, createdById: req.user.id,
        defaultDurationDays: project.startDate && project.endDate ? Math.ceil(diffDays(project.startDate, project.endDate)) : null,
      },
    });

    const keyFor = new Map(tasks.map(t => [t.id, `t_${t.id.slice(0, 8)}`]));
    for (const [i, t] of tasks.entries()) {
      const predKeys = deps.filter(d => d.successorId === t.id).map(d => keyFor.get(d.predecessorId)).filter(Boolean);
      await prisma.taskTemplate.create({
        data: {
          projectTemplateId: template.id, name: t.name, description: t.description,
          taskType: t.taskType,
          offsetDays: t.startDate ? Math.round(diffDays(anchor, t.startDate)) : 0,
          durationDays: t.durationDays ?? 1, estimatedHours: t.estimatedHours,
          sortOrder: t.sortOrder ?? i,
          templateKey: keyFor.get(t.id),
          parentKey: t.parentTaskId ? keyFor.get(t.parentTaskId) : null,
          dependsOnKeys: predKeys.length ? predKeys : null,
        },
      });
    }

    await req.audit({ action: 'create', module: 'projects', recordId: template.id, details: `Template saved from project ${project.name}` });
    res.status(201).json({ template, tasksCaptured: tasks.length });
  } catch (err) { next(err); }
});

// Instantiate a project from a template
router.post('/from-template/:templateId', authenticate, requirePermission('projects', 'edit'), auditMiddleware, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const template = await prisma.projectTemplate.findFirst({
      where: { id: req.params.templateId, deletedAt: null },
      include: { taskTemplates: { orderBy: { sortOrder: 'asc' } } },
    });
    if (!template) return res.status(404).json({ error: 'Template not found' });

    const { name, startDate, accountId, dealId, managerId, budget } = req.body;
    const start = startDate ? new Date(startDate) : new Date();

    const project = await prisma.project.create({
      data: {
        name: name || template.name,
        description: template.description, status: 'Planning',
        startDate: start,
        endDate: template.defaultDurationDays ? addDays(start, template.defaultDurationDays) : null,
        estimatedHours: template.estimatedHours,
        budget: budget != null ? +budget : null,
        managerId: managerId || req.user.id, ownerId: req.user.id,
        accountId, dealId, templateId: template.id,
      },
    });

    // Two passes: create tasks, then wire parents and dependencies by template key
    const idByKey = new Map();
    for (const tt of template.taskTemplates) {
      const taskStart = addDays(start, tt.offsetDays || 0);
      const created = await prisma.projectTask.create({
        data: {
          projectId: project.id, name: tt.name, description: tt.description,
          taskType: tt.taskType || 'Task', status: 'NotStarted',
          startDate: taskStart, endDate: addDays(taskStart, tt.durationDays || 1),
          durationDays: tt.durationDays ?? 1, estimatedHours: tt.estimatedHours,
          sortOrder: tt.sortOrder ?? 0,
        },
      });
      if (tt.templateKey) idByKey.set(tt.templateKey, created.id);
    }

    for (const tt of template.taskTemplates) {
      const taskId = idByKey.get(tt.templateKey);
      if (!taskId) continue;
      if (tt.parentKey && idByKey.has(tt.parentKey)) {
        await prisma.projectTask.update({ where: { id: taskId }, data: { parentTaskId: idByKey.get(tt.parentKey) } });
      }
      for (const depKey of tt.dependsOnKeys || []) {
        const predId = idByKey.get(depKey);
        if (!predId || predId === taskId) continue;
        await prisma.taskDependency.create({ data: { predecessorId: predId, successorId: taskId, dependencyType: 'FS', lagDays: 0 } }).catch(() => {});
      }
    }

    await prisma.projectResource.create({ data: { projectId: project.id, userId: managerId || req.user.id, role: 'Manager' } }).catch(() => {});
    await prisma.projectTemplate.update({ where: { id: template.id }, data: { usageCount: { increment: 1 } } });
    await recalcProject(prisma, project.id);

    await req.audit({ action: 'create', module: 'projects', recordId: project.id, details: `Project created from template ${template.name}` });
    res.status(201).json({ project, tasksCreated: idByKey.size });
  } catch (err) { next(err); }
});

// ── ANALYTICS ─────────────────────────────────────────────────────────

router.get('/:id/burndown', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const project = await prisma.project.findFirst({ where: { id: req.params.id, deletedAt: null } });
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const tasks = await prisma.projectTask.findMany({ where: { projectId: project.id, deletedAt: null } });
    const totalHours = tasks.reduce((s, t) => s + (t.estimatedHours || 0), 0);
    const start = project.startDate ? new Date(project.startDate) : new Date(Math.min(...tasks.map(t => new Date(t.createdAt))));
    const end = project.endDate ? new Date(project.endDate) : new Date();
    const days = Math.max(1, Math.ceil(diffDays(start, end)));

    const entries = await prisma.timeEntry.findMany({ where: { projectId: project.id, deletedAt: null }, select: { entryDate: true, hours: true }, orderBy: { entryDate: 'asc' } });

    const points = [];
    let burned = 0;
    for (let d = 0; d <= days; d++) {
      const day = addDays(start, d);
      const dayKey = day.toISOString().slice(0, 10);
      burned += entries.filter(e => new Date(e.entryDate).toISOString().slice(0, 10) === dayKey).reduce((s, e) => s + (e.hours || 0), 0);
      points.push({
        date: dayKey,
        ideal: +Math.max(0, totalHours - (totalHours / days) * d).toFixed(1),
        actual: day <= new Date() ? +Math.max(0, totalHours - burned).toFixed(1) : null,
      });
    }
    res.json({ projectId: project.id, totalEstimatedHours: totalHours, hoursBurned: +burned.toFixed(1), points });
  } catch (err) { next(err); }
});

router.get('/analytics/portfolio', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    // The projects the caller can see; this totalled every budget.
    const projects = await prisma.project.findMany({
      where: await reachableWhere(req, 'projects', 'project'),
      select: { id: true, name: true, status: true, health: true, percentComplete: true, budget: true, actualCost: true, startDate: true, endDate: true },
    });
    const active = projects.filter(p => ['Planning', 'Active'].includes(p.status));
    const now = new Date();
    const atRisk = active.filter(p => p.health !== 'Green');
    const overdue = active.filter(p => p.endDate && new Date(p.endDate) < now && p.percentComplete < 100);
    const overBudget = projects.filter(p => p.budget && p.actualCost > p.budget);

    const byStatus = projects.reduce((a, p) => { a[p.status] = (a[p.status] || 0) + 1; return a; }, {});
    const byHealth = active.reduce((a, p) => { a[p.health] = (a[p.health] || 0) + 1; return a; }, {});

    res.json({
      totalProjects: projects.length, activeProjects: active.length,
      atRisk: atRisk.length, overdue: overdue.length, overBudget: overBudget.length,
      totalBudget: +projects.reduce((s, p) => s + (p.budget || 0), 0).toFixed(2),
      totalActualCost: +projects.reduce((s, p) => s + (p.actualCost || 0), 0).toFixed(2),
      avgCompletion: active.length ? Math.round(active.reduce((s, p) => s + p.percentComplete, 0) / active.length) : 0,
      byStatus, byHealth,
      watchList: [...atRisk, ...overdue].slice(0, 10),
    });
  } catch (err) { next(err); }
});

// My tasks across all projects
router.get('/tasks/mine', authenticate, async (req, res, next) => {
  try {
    const prisma = req.app.locals.prisma;
    const tasks = await prisma.projectTask.findMany({
      where: { assignedToId: req.user.id, deletedAt: null, status: { notIn: ['Completed', 'Cancelled'] }, project: { deletedAt: null } },
      include: { project: { select: { id: true, name: true } } },
      orderBy: [{ endDate: 'asc' }],
      take: 100,
    });
    const now = new Date();
    res.json({
      count: tasks.length,
      overdue: tasks.filter(t => t.endDate && new Date(t.endDate) < now).length,
      dueThisWeek: tasks.filter(t => t.endDate && new Date(t.endDate) >= now && new Date(t.endDate) <= addDays(now, 7)).length,
      tasks,
    });
  } catch (err) { next(err); }
});

module.exports = router;
