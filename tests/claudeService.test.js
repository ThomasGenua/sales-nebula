/**
 * What services/claude sends to the Messages API. The SDK is replaced here:
 * no request leaves.
 */
jest.mock('@anthropic-ai/sdk', () => {
  class APIError extends Error {}
  const calls = [];
  const state = { reply: null };
  const respond = api => async params => { calls.push({ api, params }); return state.reply; };
  class Anthropic {
    constructor() {
      this.messages = { create: respond('messages') };
      this.beta = { messages: { create: respond('beta') } };
    }
  }
  Object.assign(Anthropic, {
    APIError,
    RateLimitError: class extends APIError {},
    AuthenticationError: class extends APIError {},
    PermissionDeniedError: class extends APIError {},
    BadRequestError: class extends APIError {},
    __calls: calls,
    __state: state,
  });
  return Anthropic;
});

const Anthropic = require('@anthropic-ai/sdk');
const { complete, AiError, DEFAULT_MODEL } = require('../src/services/claude');

const saved = { key: process.env.ANTHROPIC_API_KEY, model: process.env.ANTHROPIC_MODEL };
beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
  delete process.env.ANTHROPIC_MODEL;
  Anthropic.__calls.length = 0;
  Anthropic.__state.reply = { content: [{ type: 'text', text: 'An answer' }], stop_reason: 'end_turn', model: DEFAULT_MODEL };
});
afterAll(() => {
  for (const [name, value] of [['ANTHROPIC_API_KEY', saved.key], ['ANTHROPIC_MODEL', saved.model]]) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

const ask = () => complete({ system: 'Be brief.', messages: [{ role: 'user', content: 'Hello' }] });

test('calls go to Claude Opus 5.5, with the server-side refusal fallback', async () => {
  expect(DEFAULT_MODEL).toBe('claude-opus-5-5');
  expect(await ask()).toMatchObject({ text: 'An answer' });
  const [{ api, params }] = Anthropic.__calls;
  expect(api).toBe('beta');
  expect(params).toMatchObject({ model: 'claude-opus-5-5', betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default', system: 'Be brief.' });
});

test('no thinking setting is sent: Opus 5.5 refuses thinking disabled, and runs adaptive without one', async () => {
  await ask();
  expect(Anthropic.__calls[0].params).not.toHaveProperty('thinking');
  expect(Anthropic.__calls[0].params).not.toHaveProperty('tool_choice');
});

test('a model set in ANTHROPIC_MODEL that takes no fallback is called without one', async () => {
  process.env.ANTHROPIC_MODEL = 'claude-haiku-4-5';
  await ask();
  const [{ api, params }] = Anthropic.__calls;
  expect(api).toBe('messages');
  expect(params.model).toBe('claude-haiku-4-5');
  expect(params).not.toHaveProperty('fallbacks');
});

test('a refusal the fallback could not rescue is a 422, not an empty answer', async () => {
  Anthropic.__state.reply = { content: [], stop_reason: 'refusal', model: DEFAULT_MODEL };
  await expect(ask()).rejects.toMatchObject({ status: 422 });
  await expect(ask()).rejects.toBeInstanceOf(AiError);
});
