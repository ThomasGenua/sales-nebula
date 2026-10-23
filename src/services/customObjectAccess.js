const { permits } = require('../middleware/auth');
const { isAdmin } = require('../middleware/rowSecurity');
const moduleName = id => 'custom:' + id;
function canAccess(req, id, level = 'read') {
  if (!isAdmin(req.user)) return permits(req, moduleName(id), level);
  const grants = req.isApiKey && Array.isArray(req.apiKeyPermissions) ? req.apiKeyPermissions : [];
  if (!grants.length) return true;
  const grant = grants.find(g => g.module === moduleName(id) || g.module === '*');
  const levels = { none: 0, read: 1, edit: 2, full: 3 };
  return (levels[grant?.level] || 0) >= (levels[level] || 1);
}
const requireAccess = level => (req, res, next) => canAccess(req, req.params.id, level) ? next() : res.status(403).json({ error: 'Insufficient custom-object permissions' });
async function search(db, req, q, limit = 25) {
  const objects = (await db.customObject.findMany({ where: { deletedAt: null } })).filter(o => canAccess(req, o.id));
  const results = [];
  for (const object of objects) {
    const rows = await db.customRecord.findMany({ where: { customObjectId: object.id, deletedAt: null }, orderBy: { createdAt: 'desc' }, take: 1000 });
    for (const row of rows) {
      const label = Object.values(row.data || {}).filter(v => typeof v === 'string' || typeof v === 'number').join(' · ');
      if (label.toLowerCase().includes(q.toLowerCase())) results.push({ id: object.id + '~' + row.id, recordId: row.id, objectId: object.id, objectLabel: object.label, name: label.slice(0, 200), module: 'customRecords' });
      if (results.length >= limit) return results;
    }
  }
  return results;
}
module.exports = { canAccess, requireAccess, moduleName, search };
