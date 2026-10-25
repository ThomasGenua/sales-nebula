const {
  context,
  secureClient
} = require('./fieldSecurity');
const {
  permits
} = require('../middleware/auth');
async function asActor(raw, userId, module, run) {
  const user = await raw.user.findFirst({
    where: {
      id: userId,
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
  const db = secureClient(raw),
    req = {
      user,
      userId: user?.id,
      app: {
        locals: {
          prisma: db
        }
      }
    };
  if (!user || !permits(req, module, 'edit')) throw Object.assign(new Error('Owner no longer has ' + module + ' edit access'), {
    status: 403
  });
  return context.run({
    req,
    policyDb: raw
  }, () => run(db, req));
}
module.exports = {
  asActor
};
