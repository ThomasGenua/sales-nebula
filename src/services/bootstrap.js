const bcrypt = require('bcryptjs');

// The same module grants as a demo install, without demo accounts or records.
const MODULES = ['contacts', 'leads', 'deals', 'accounts', 'activities', 'emails', 'cases', 'documents', 'campaigns', 'products', 'quotes', 'invoices', 'workflows', 'users', 'roles', 'settings', 'admin', 'reports', 'forecasts', 'territories', 'knowledge', 'chatter', 'formulas', 'approvals', 'assets', 'contracts', 'entitlements', 'fieldService', 'orders', 'partners', 'personAccounts', 'projects', 'subscriptions', 'surveys'];

function validateBootstrap({ email, password }) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ''))) throw new Error('Set INITIAL_ADMIN_EMAIL to a valid email address for the first administrator.');
  if (typeof password !== 'string' || password.length < 12 || Buffer.byteLength(password, 'utf8') > 72
    || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password) || !/[^A-Za-z0-9]/.test(password)) {
    throw new Error('Set INITIAL_ADMIN_PASSWORD to 12 or more characters (at most 72 UTF-8 bytes), including uppercase, lowercase, a number and a special character.');
  }
}

async function bootstrapAdmin(prisma, input) {
  // Existing installations never have their users, passwords or roles rewritten.
  if (await prisma.user.count()) return { created: false };
  validateBootstrap(input);
  const password = await bcrypt.hash(input.password, 12);
  return prisma.$transaction(async tx => {
    // Two deployment jobs must not both create a first administrator.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(7544001)`;
    if (await tx.user.count()) return { created: false };
    const levels = {
      Admin: () => 'full',
      Manager: module => ['users', 'roles', 'settings', 'admin'].includes(module) ? 'read' : 'full',
      'Sales Rep': module => ['users', 'roles', 'settings'].includes(module) ? 'none' : ['products', 'invoices', 'workflows', 'admin'].includes(module) ? 'read' : 'edit',
      'Read Only': () => 'read',
    };
    for (const [name, level] of Object.entries(levels)) {
      await tx.role.upsert({
        where: { name }, update: {},
        create: { name, permissions: { create: MODULES.map(module => ({ module, level: level(module) })) } },
      });
    }
    const role = await tx.role.findUnique({ where: { name: 'Admin' } });
    // A pre-existing Admin role might have incomplete grants, even with no users.
    for (const module of MODULES) await tx.permission.upsert({
      where: { roleId_module: { roleId: role.id, module } },
      update: { level: 'full' }, create: { roleId: role.id, module, level: 'full' },
    });
    const user = await tx.user.create({ data: {
      email: input.email.trim().toLowerCase(), password, firstName: input.firstName?.trim() || 'Administrator',
      lastName: input.lastName?.trim() || '', roleId: role.id, active: true,
    } });
    return { created: true, userId: user.id };
  }, { timeout: 30000 });
}

module.exports = { bootstrapAdmin, validateBootstrap };
