const bcrypt = require('bcryptjs');
const { setup, teardown, cleanDatabase } = require('./setup');
const { bootstrapAdmin, validateBootstrap } = require('../src/services/bootstrap');
let prisma;
beforeAll(async () => { ({ prisma } = await setup()); });
afterAll(teardown);
beforeEach(cleanDatabase);
const input = { email: 'Owner@example.com', password: 'My-first-admin-123!' };

test('fresh production bootstrap creates one administrator and roles, with no demo records', async () => {
  expect((await bootstrapAdmin(prisma, input)).created).toBe(true);
  const user = await prisma.user.findUnique({ where: { email: 'owner@example.com' }, include: { role: { include: { permissions: true } } } });
  expect(user.role.name).toBe('Admin');
  expect(user.role.permissions.find(p => p.module === 'users').level).toBe('full');
  expect(await bcrypt.compare(input.password, user.password)).toBe(true);
  expect(await prisma.user.count()).toBe(1);
  expect(await prisma.contact.count()).toBe(0);
  expect(await prisma.deal.count()).toBe(0);
});
test('a restart leaves users and passwords unchanged and needs no bootstrap credentials', async () => {
  await bootstrapAdmin(prisma, input);
  const original = await prisma.user.findFirst();
  expect(await bootstrapAdmin(prisma, {})).toEqual({ created: false });
  expect((await prisma.user.findFirst()).password).toBe(original.password);
});
test('concurrent bootstrap jobs create only one user', async () => {
  const results = await Promise.all([bootstrapAdmin(prisma, input), bootstrapAdmin(prisma, input)]);
  expect(results.filter(r => r.created)).toHaveLength(1);
  expect(await prisma.user.count()).toBe(1);
});
test('weak or absent credentials leave a fresh database empty', async () => {
  await expect(bootstrapAdmin(prisma, {})).rejects.toThrow('INITIAL_ADMIN_EMAIL');
  await expect(bootstrapAdmin(prisma, { ...input, password: 'password' })).rejects.toThrow('INITIAL_ADMIN_PASSWORD');
  expect(await prisma.user.count()).toBe(0);
  expect(await prisma.role.count()).toBe(0);
  expect(() => validateBootstrap({ ...input, password: 'Aa1!' + 'é'.repeat(40) })).toThrow('72 UTF-8 bytes');
});
