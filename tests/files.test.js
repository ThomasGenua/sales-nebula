/**
 * Attachments and data exports.
 *
 * No attachment upload ever succeeded — every write named columns the model
 * does not have — yet multer had already saved the file, and the uploads
 * directory was served publicly with the browser's own content type. An HTML
 * file from a request that answered 500 therefore ran as script on this
 * origin, where the session tokens live. Data exports were written to the same
 * public folder as export_<module>_<Date.now()>.csv, and any authenticated user
 * could request one for any module.
 */

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const {
  setup, teardown, cleanDatabase,
  createTestRole, createTestUser, createTestContact, authHeader,
} = require('./setup');
const { invalidateOrgWideDefaultCache } = require('../src/middleware/rowSecurity');

let app, prisma, admin, repA, repB, viewer;

beforeAll(async () => { ({ prisma, app } = await setup()); });
afterAll(async () => { await teardown(); });

beforeEach(async () => {
  await cleanDatabase();
  invalidateOrgWideDefaultCache();
  const adminRole = await createTestRole('Admin');
  const repRole = await createTestRole('Sales Rep', [
    { module: 'contacts', level: 'full' }, { module: 'deals', level: 'full' },
  ]);
  const noContacts = await createTestRole('Support', [{ module: 'cases', level: 'full' }]);
  admin = await createTestUser({ email: 'files-admin@test.com', roleId: adminRole.id });
  repA = await createTestUser({ email: 'files-a@test.com', roleId: repRole.id });
  repB = await createTestUser({ email: 'files-b@test.com', roleId: repRole.id });
  viewer = await createTestUser({ email: 'files-support@test.com', roleId: noContacts.id });
});

const upload = (token, module, id, name, body, type = 'text/plain') =>
  request(app).post(`/api/attachments/${module}/${id}`).set(authHeader(token))
    .attach('file', Buffer.from(body), { filename: name, contentType: type });

describe('Attachments', () => {
  it('uploads, lists and downloads a file, which never once worked', async () => {
    const contact = await createTestContact({ ownerId: repA.user.id });

    const up = await upload(repA.token, 'contacts', contact.id, 'notes.txt', 'meeting notes');
    expect(up.status).toBe(201);
    expect(up.body.fileName).toBe('notes.txt');
    expect(up.body.downloadUrl).toMatch(/^\/api\/attachments\/download\//);

    const list = await request(app).get(`/api/attachments/contacts/${contact.id}`).set(authHeader(repA.token));
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);

    const dl = await request(app).get(up.body.downloadUrl).set(authHeader(repA.token))
      .buffer(true).parse((res, cb) => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
    expect(dl.status).toBe(200);
    expect(dl.headers['content-disposition']).toMatch(/attachment/);
    expect(dl.body.toString()).toBe('meeting notes');
  });

  it('serves an uploaded HTML file as a download, never as a page', async () => {
    const contact = await createTestContact({ ownerId: repA.user.id });
    const up = await upload(repA.token, 'contacts', contact.id, 'evil.html',
      '<script>localStorage.getItem("sn_token")</script>', 'text/html');
    expect(up.status).toBe(201);

    const dl = await request(app).get(up.body.downloadUrl).set(authHeader(repA.token));
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toMatch(/application\/octet-stream/);
    expect(dl.headers['content-disposition']).toMatch(/attachment/);
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
  });

  it('does not serve the uploads directory at all', async () => {
    const contact = await createTestContact({ ownerId: repA.user.id });
    await upload(repA.token, 'contacts', contact.id, 'a.txt', 'x');
    const stored = await prisma.attachment.findFirst();
    const res = await request(app).get(`/uploads/${stored.url}`);
    expect(res.status).not.toBe(200);
  });

  it('refuses a download without a session', async () => {
    const contact = await createTestContact({ ownerId: repA.user.id });
    const up = await upload(repA.token, 'contacts', contact.id, 'a.txt', 'x');
    expect((await request(app).get(up.body.downloadUrl)).status).toBe(401);
  });

  it('hides a file on a record the caller cannot see', async () => {
    await prisma.orgWideDefault.create({ data: { module: 'contacts', internalAccess: 'Private', externalAccess: 'Private' } });
    invalidateOrgWideDefaultCache();
    const contact = await createTestContact({ ownerId: repA.user.id });
    const up = await upload(repA.token, 'contacts', contact.id, 'secret.txt', 'private');
    expect(up.status).toBe(201);

    expect((await request(app).get(up.body.downloadUrl).set(authHeader(repB.token))).status).toBe(404);
    expect((await request(app).get(`/api/attachments/contacts/${contact.id}`).set(authHeader(repB.token))).status).toBe(404);
    expect((await upload(repB.token, 'contacts', contact.id, 'x.txt', 'x')).status).toBe(404);
  });

  it('lets only the uploader or an administrator delete a file', async () => {
    const contact = await createTestContact({ ownerId: repA.user.id });
    const up = await upload(repA.token, 'contacts', contact.id, 'a.txt', 'x');

    expect((await request(app).delete(`/api/attachments/${up.body.id}`).set(authHeader(repB.token))).status).toBe(403);
    expect((await request(app).delete(`/api/attachments/${up.body.id}`).set(authHeader(admin.token))).status).toBe(200);
  });

  it('refuses a file on a record that does not exist, and keeps nothing on disk', async () => {
    const before = fs.existsSync(path.resolve(process.env.UPLOAD_DIR || './uploads'))
      ? fs.readdirSync(path.resolve(process.env.UPLOAD_DIR || './uploads')).length : 0;
    const res = await upload(repA.token, 'contacts', '00000000-0000-0000-0000-000000000000', 'a.txt', 'x');
    expect(res.status).toBe(404);
    await new Promise(r => setTimeout(r, 100));
    const after = fs.existsSync(path.resolve(process.env.UPLOAD_DIR || './uploads'))
      ? fs.readdirSync(path.resolve(process.env.UPLOAD_DIR || './uploads')).length : 0;
    expect(after).toBe(before);
  });

  it('strips path components from a hostile file name', async () => {
    const contact = await createTestContact({ ownerId: repA.user.id });
    const up = await upload(repA.token, 'contacts', contact.id, '../../etc/passwd', 'x');
    expect(up.status).toBe(201);
    expect(up.body.fileName).toBe('passwd');
    const stored = await prisma.attachment.findUnique({ where: { id: up.body.id } });
    expect(stored.url).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('Data exports', () => {
  beforeEach(async () => {
    await createTestContact({ ownerId: repA.user.id, email: `a${Date.now()}@x.com` });
    await createTestContact({ ownerId: repB.user.id, email: `b${Date.now()}@x.com` });
  });

  it('exports, which used to crash on an omitted field list', async () => {
    const res = await request(app).post('/api/data-export').set(authHeader(admin.token)).send({ module: 'contacts', format: 'csv' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
    expect(res.body.recordCount).toBe(2);
    expect(res.body.fileUrl).toMatch(/^\/api\/data-export\/.+\/download$/);
  });

  it('serves the file only through the authenticated, owner-checked route', async () => {
    const res = await request(app).post('/api/data-export').set(authHeader(admin.token)).send({ module: 'contacts', format: 'csv' });
    const mine = await request(app).get(res.body.fileUrl).set(authHeader(admin.token));
    expect(mine.status).toBe(200);
    expect(mine.text).toMatch(/email/);

    expect((await request(app).get(res.body.fileUrl)).status).toBe(401);
    expect((await request(app).get(res.body.fileUrl).set(authHeader(repA.token))).status).toBe(404);

    const stored = await prisma.dataExport.findUnique({ where: { id: res.body.id } });
    expect(stored.fileUrl).toMatch(/^[0-9a-f-]{36}\.csv$/);
    expect(stored.fileUrl).not.toMatch(/contacts|\d{13}/);
  });

  it('refuses an export of a module the caller cannot read', async () => {
    const res = await request(app).post('/api/data-export').set(authHeader(viewer.token)).send({ module: 'contacts' });
    expect(res.status).toBe(403);
  });

  it('exports only the rows the caller can see', async () => {
    await prisma.orgWideDefault.create({ data: { module: 'contacts', internalAccess: 'Private', externalAccess: 'Private' } });
    invalidateOrgWideDefaultCache();
    const res = await request(app).post('/api/data-export').set(authHeader(repA.token)).send({ module: 'contacts', format: 'json' });
    expect(res.status).toBe(200);
    expect(res.body.recordCount).toBe(1);
  });

  it('ignores filters that are not plain equality on real columns', async () => {
    const res = await request(app).post('/api/data-export').set(authHeader(admin.token))
      .send({ module: 'contacts', format: 'json', filters: { email: { contains: '@' }, bogusColumn: 1 } });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('completed');
  });
});
