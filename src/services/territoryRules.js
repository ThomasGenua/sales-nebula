const { evaluate } = require('./recordRules');

const matches = (territory, account) => territory.active && !territory.deletedAt &&
  territory.rules.length > 0 && territory.rules.every(rule => evaluate(rule, account));

async function applyTerritories(db, account, territoryId) {
  const territories = await db.territory.findMany({ ...(territoryId && { where: { id: territoryId } }), include: { rules: { where: { active: true } } } });
  for (const territory of territories) {
    if (matches(territory, account)) {
      await db.territoryAccount.upsert({
        where: { territoryId_accountId: { territoryId: territory.id, accountId: account.id } },
        create: { territoryId: territory.id, accountId: account.id, assignedBy: 'rule' }, update: {},
      });
    } else {
      // Never remove a manually assigned account when its attributes change.
      await db.territoryAccount.deleteMany({ where: { territoryId: territory.id, accountId: account.id, assignedBy: 'rule' } });
    }
  }
}

module.exports = { matches, applyTerritories };
