/**
 * Critical Path Method (CPM) scheduling for project tasks.
 *
 * Forward pass computes earliest start/finish, backward pass computes
 * latest start/finish, and total float. Tasks with zero float are on
 * the critical path.
 *
 * Dependency types: FS (finish-to-start), SS (start-to-start),
 * FF (finish-to-finish), SF (start-to-finish), each with optional lag.
 */

const MS_PER_DAY = 86400000;

function addDays(date, days) {
  return new Date(new Date(date).getTime() + days * MS_PER_DAY);
}

function diffDays(a, b) {
  return (new Date(b) - new Date(a)) / MS_PER_DAY;
}

/**
 * Topologically sort tasks by dependency. Returns { order, cycle }.
 * If a cycle exists, order is partial and cycle lists the stuck ids.
 */
function topoSort(tasks, dependencies) {
  const ids = tasks.map(t => t.id);
  const idSet = new Set(ids);
  const indegree = new Map(ids.map(id => [id, 0]));
  const adjacency = new Map(ids.map(id => [id, []]));

  for (const dep of dependencies) {
    if (!idSet.has(dep.predecessorId) || !idSet.has(dep.successorId)) continue;
    adjacency.get(dep.predecessorId).push(dep.successorId);
    indegree.set(dep.successorId, indegree.get(dep.successorId) + 1);
  }

  const queue = ids.filter(id => indegree.get(id) === 0);
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const next of adjacency.get(id)) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }

  const cycle = order.length === ids.length ? [] : ids.filter(id => !order.includes(id));
  return { order, cycle };
}

/**
 * Run CPM over a task set.
 * Returns per-task schedule plus the project critical path.
 */
function calculateCriticalPath(tasks, dependencies, projectStart) {
  if (!tasks.length) return { schedule: [], criticalPath: [], projectDuration: 0, cycle: [] };

  const start = projectStart ? new Date(projectStart) : new Date();
  const byId = new Map(tasks.map(t => [t.id, t]));
  const { order, cycle } = topoSort(tasks, dependencies);

  // If dependencies are cyclic, fall back to declared dates only
  if (cycle.length) {
    return {
      schedule: tasks.map(t => ({
        taskId: t.id, name: t.name,
        earliestStart: t.startDate ? new Date(t.startDate) : start,
        earliestFinish: t.endDate ? new Date(t.endDate) : addDays(start, t.durationDays || 1),
        latestStart: null, latestFinish: null, totalFloat: null, isCritical: false,
      })),
      criticalPath: [], projectDuration: 0, cycle,
    };
  }

  const predecessorsOf = new Map(tasks.map(t => [t.id, []]));
  const successorsOf = new Map(tasks.map(t => [t.id, []]));
  for (const dep of dependencies) {
    if (!byId.has(dep.predecessorId) || !byId.has(dep.successorId)) continue;
    predecessorsOf.get(dep.successorId).push(dep);
    successorsOf.get(dep.predecessorId).push(dep);
  }

  const durationOf = t => {
    if (t.durationDays != null) return Math.max(0, t.durationDays);
    if (t.startDate && t.endDate) return Math.max(0, diffDays(t.startDate, t.endDate));
    return 1;
  };

  // Forward pass
  const es = new Map(), ef = new Map();
  for (const id of order) {
    const task = byId.get(id);
    const dur = durationOf(task);
    const preds = predecessorsOf.get(id);

    let earliestStart = task.startDate && !preds.length ? new Date(task.startDate) : start;
    for (const dep of preds) {
      const pStart = es.get(dep.predecessorId);
      const pFinish = ef.get(dep.predecessorId);
      const lag = dep.lagDays || 0;
      let candidate;
      switch (dep.dependencyType) {
        case 'SS': candidate = addDays(pStart, lag); break;
        case 'FF': candidate = addDays(pFinish, lag - dur); break;
        case 'SF': candidate = addDays(pStart, lag - dur); break;
        case 'FS':
        default: candidate = addDays(pFinish, lag); break;
      }
      if (candidate > earliestStart) earliestStart = candidate;
    }
    es.set(id, earliestStart);
    ef.set(id, addDays(earliestStart, dur));
  }

  const projectFinish = new Date(Math.max(...order.map(id => ef.get(id).getTime())));

  // Backward pass
  const ls = new Map(), lf = new Map();
  for (const id of [...order].reverse()) {
    const task = byId.get(id);
    const dur = durationOf(task);
    const succs = successorsOf.get(id);

    // Nothing finishes after the project does. Only tasks without successors
    // started from projectFinish, so a long task whose SS/SF successor ends
    // early got float it did not have and dropped off the critical path.
    let latestFinish = new Date(projectFinish);
    for (const dep of succs) {
      const sStart = ls.get(dep.successorId);
      const sFinish = lf.get(dep.successorId);
      const lag = dep.lagDays || 0;
      let candidate;
      switch (dep.dependencyType) {
        case 'SS': candidate = addDays(addDays(sStart, -lag), dur); break;
        case 'FF': candidate = addDays(sFinish, -lag); break;
        // Start-to-finish ties this start to the successor's finish, not its start.
        case 'SF': candidate = addDays(addDays(sFinish, -lag), dur); break;
        case 'FS':
        default: candidate = addDays(sStart, -lag); break;
      }
      if (candidate < latestFinish) latestFinish = candidate;
    }
    lf.set(id, latestFinish);
    ls.set(id, addDays(latestFinish, -dur));
  }

  const schedule = tasks.map(t => {
    const totalFloat = +diffDays(es.get(t.id), ls.get(t.id)).toFixed(2);
    return {
      taskId: t.id, name: t.name, durationDays: durationOf(t),
      earliestStart: es.get(t.id), earliestFinish: ef.get(t.id),
      latestStart: ls.get(t.id), latestFinish: lf.get(t.id),
      totalFloat, isCritical: Math.abs(totalFloat) < 0.01,
    };
  });

  const criticalPath = order.filter(id => {
    const s = schedule.find(x => x.taskId === id);
    return s && s.isCritical;
  });

  return {
    schedule, criticalPath,
    projectStart: start, projectFinish,
    projectDuration: +diffDays(start, projectFinish).toFixed(1),
    cycle: [],
  };
}

/** Detect whether adding a dependency would create a cycle. */
function wouldCreateCycle(dependencies, predecessorId, successorId) {
  if (predecessorId === successorId) return true;
  const adjacency = new Map();
  for (const d of dependencies) {
    if (!adjacency.has(d.predecessorId)) adjacency.set(d.predecessorId, []);
    adjacency.get(d.predecessorId).push(d.successorId);
  }
  // Walk forward from the proposed successor; reaching the predecessor means a cycle
  const seen = new Set();
  const stack = [successorId];
  while (stack.length) {
    const node = stack.pop();
    if (node === predecessorId) return true;
    if (seen.has(node)) continue;
    seen.add(node);
    stack.push(...(adjacency.get(node) || []));
  }
  return false;
}

/** Assign hierarchical WBS codes (1, 1.1, 1.1.1) by parent and sortOrder. */
function assignWbsCodes(tasks) {
  const children = new Map();
  for (const t of tasks) {
    const key = t.parentTaskId || '__root__';
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(t);
  }
  for (const list of children.values()) {
    list.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || String(a.name).localeCompare(String(b.name)));
  }

  const codes = new Map();
  const walk = (parentKey, prefix) => {
    const list = children.get(parentKey) || [];
    list.forEach((task, i) => {
      const code = prefix ? `${prefix}.${i + 1}` : String(i + 1);
      codes.set(task.id, code);
      walk(task.id, code);
    });
  };
  walk('__root__', '');
  return codes;
}

/**
 * Roll percentComplete up through the task tree, weighting each task by
 * its estimated hours (falling back to duration, then to equal weight).
 */
function rollUpProgress(tasks) {
  const children = new Map();
  for (const t of tasks) {
    const key = t.parentTaskId || '__root__';
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(t);
  }

  const computed = new Map();
  const visiting = new Set();
  const weightOf = t => t.estimatedHours || t.durationDays || 1;
  const ownPercent = task => (task.status === 'Completed' ? 100 : (task.percentComplete || 0));

  const resolve = (task) => {
    if (computed.has(task.id)) return computed.get(task.id);
    // A parent loop (a task moved under itself or its own child) recursed
    // until the stack overflowed; met again on its own path, it counts alone.
    if (visiting.has(task.id)) return ownPercent(task);
    const kids = children.get(task.id) || [];
    if (!kids.length) {
      const pct = ownPercent(task);
      computed.set(task.id, pct);
      return pct;
    }
    let weighted = 0, totalWeight = 0;
    visiting.add(task.id);
    for (const kid of kids) {
      const w = weightOf(kid);
      weighted += resolve(kid) * w;
      totalWeight += w;
    }
    visiting.delete(task.id);
    const pct = totalWeight ? Math.round(weighted / totalWeight) : 0;
    computed.set(task.id, pct);
    return pct;
  };

  for (const t of tasks) resolve(t);

  const roots = children.get('__root__') || [];
  let weighted = 0, totalWeight = 0;
  for (const r of roots) {
    const w = weightOf(r);
    weighted += computed.get(r.id) * w;
    totalWeight += w;
  }

  return {
    taskProgress: computed,
    projectPercent: totalWeight ? Math.round(weighted / totalWeight) : 0,
  };
}

/** Build Gantt-ready rows with indent level and computed bar geometry. */
function buildGanttRows(tasks, schedule, wbsCodes) {
  const scheduleById = new Map((schedule || []).map(s => [s.taskId, s]));
  const byParent = new Map();
  for (const t of tasks) {
    const key = t.parentTaskId || '__root__';
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(t);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  }

  const rows = [];
  const walk = (parentKey, level) => {
    for (const t of byParent.get(parentKey) || []) {
      const s = scheduleById.get(t.id);
      rows.push({
        id: t.id, name: t.name, level,
        wbs: wbsCodes?.get(t.id) || t.wbsCode || null,
        taskType: t.taskType, status: t.status,
        assignedToId: t.assignedToId,
        percentComplete: t.percentComplete || 0,
        start: s?.earliestStart || t.startDate,
        end: s?.earliestFinish || t.endDate,
        durationDays: s?.durationDays ?? t.durationDays,
        totalFloat: s?.totalFloat ?? null,
        isCritical: s?.isCritical ?? false,
        hasChildren: (byParent.get(t.id) || []).length > 0,
      });
      walk(t.id, level + 1);
    }
  };
  walk('__root__', 0);
  return rows;
}

module.exports = {
  calculateCriticalPath, topoSort, wouldCreateCycle,
  assignWbsCodes, rollUpProgress, buildGanttRows,
  addDays, diffDays,
};
