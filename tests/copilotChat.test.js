/**
 * Copilot conversations (POST /api/copilot/chat): what is sent to the model,
 * and what is kept when nothing can answer.
 *
 * The history sent was a thread's oldest 50 messages, so past 50 the question
 * just asked was not among them and the model answered an old one. And with
 * no model configured the question was saved, in a new thread if need be,
 * before the 503. The model client is replaced here: no request leaves.
 */
jest.mock('../src/services/claude', () => {
  const actual = jest.requireActual('../src/services/claude');
  const isConfigured = jest.fn(() => true);
  // As the real one does, it refuses with a 503 when no model is configured.
  const complete = jest.fn(async () => {
    if (!isConfigured()) throw new actual.AiError(503, 'AI is not configured: ANTHROPIC_API_KEY is not set');
    return { text: 'A reply', model: 'test-model', truncated: false };
  });
  return { ...actual, isConfigured, complete };
});

const request = require('supertest');
const { complete, isConfigured } = require('../src/services/claude');
const { setup, teardown, cleanDatabase, createTestUser, authHeader } = require('./setup');

let app, prisma, user, token;

beforeAll(async () => { ({ prisma, app } = await setup()); });
afterAll(async () => { await teardown(); });
beforeEach(async () => {
  await cleanDatabase();
  ({ user, token } = await createTestUser({ email: 'copilot@test.com' }));
  complete.mockClear();
  isConfigured.mockReturnValue(true);
});

const chat = body => request(app).post('/api/copilot/chat').set(authHeader(token)).send(body);

/** A thread of `count` messages, user and assistant in turn, a second apart. */
async function threadWith(count, contentOf = i => `message ${i}`) {
  const thread = await prisma.copilotThread.create({ data: { userId: user.id, title: 'Long thread' } });
  const start = Date.now() - count * 1000 - 60000;
  for (let i = 0; i < count; i++) {
    await prisma.copilotMessage.create({
      data: { threadId: thread.id, role: i % 2 === 0 ? 'user' : 'assistant', content: contentOf(i), createdAt: new Date(start + i * 1000) },
    });
  }
  return thread;
}

const sentMessages = () => complete.mock.calls[0][0].messages;

describe('POST /api/copilot/chat', () => {
  test('a long thread sends its newest messages, ending with the question just asked', async () => {
    const thread = await threadWith(60);
    const res = await chat({ threadId: thread.id, message: 'And the newest question?' });
    expect(res.status).toBe(200);

    const sent = sentMessages();
    expect(sent.length).toBeLessThanOrEqual(50);
    expect(sent[sent.length - 1]).toEqual({ role: 'user', content: 'And the newest question?' });
    expect(sent.map(m => m.content)).not.toContain('message 0');
    expect(sent.map(m => m.content)).toContain('message 59');
  });

  test('the history starts with a question, as the API requires, even where the window starts on a reply', async () => {
    // 50 stored + the new one: the newest 50 start on message 1, a reply.
    const thread = await threadWith(50);
    await chat({ threadId: thread.id, message: 'Next question' });
    const sent = sentMessages();
    expect(sent[0].role).toBe('user');
    expect(sent[sent.length - 1]).toEqual({ role: 'user', content: 'Next question' });
  });

  test('an empty reply stored in the thread is not sent back', async () => {
    const thread = await threadWith(4, i => (i === 1 ? '' : `message ${i}`));
    await chat({ threadId: thread.id, message: 'Another question' });
    expect(sentMessages().every(m => m.content !== '')).toBe(true);
  });

  test('a short thread is sent whole, in order', async () => {
    const thread = await threadWith(3);
    await chat({ threadId: thread.id, message: 'Fourth' });
    expect(sentMessages().map(m => m.content)).toEqual(['message 0', 'message 1', 'message 2', 'Fourth']);
  });

  test('with no model configured it answers 503 and saves nothing', async () => {
    isConfigured.mockReturnValue(false);
    const res = await chat({ message: 'Is anyone there?' });
    expect(res.status).toBe(503);
    expect(complete).not.toHaveBeenCalled();
    expect(await prisma.copilotThread.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.copilotMessage.count()).toBe(0);
  });

  test('with no model configured, an existing thread gets no unanswered question', async () => {
    const thread = await threadWith(2);
    isConfigured.mockReturnValue(false);
    const res = await chat({ threadId: thread.id, message: 'Still there?' });
    expect(res.status).toBe(503);
    expect(await prisma.copilotMessage.count({ where: { threadId: thread.id } })).toBe(2);
  });

  test('the reply is saved to the thread', async () => {
    const res = await chat({ message: 'First question' });
    expect(res.status).toBe(200);
    const messages = await prisma.copilotMessage.findMany({ where: { threadId: res.body.threadId }, orderBy: { createdAt: 'asc' } });
    expect(messages.map(m => [m.role, m.content])).toEqual([['user', 'First question'], ['assistant', 'A reply']]);
  });
});
