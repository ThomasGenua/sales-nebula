/**
 * Every call the app makes to Claude goes through here.
 *
 * The model used to be written into each route: two different Sonnet
 * snapshots, one of them (claude-sonnet-4-20250514) deprecated. It is now
 * set in one place, and ANTHROPIC_MODEL overrides it for every call.
 *
 * The routes also posted to the API with fetch() and never looked at the
 * status, so a rejected key, a rate limit or an outage reached the user as a
 * 200 reading "No response". The SDK raises typed errors instead, and they
 * leave here as an AiError carrying an honest HTTP status.
 */
const Anthropic = require('@anthropic-ai/sdk');

const DEFAULT_MODEL = 'claude-opus-5';

// When a model's safety classifiers decline a request, the server-side
// fallback re-runs it on the model Anthropic recommends for that refusal
// category, in the same call. Only these models take the parameter; any
// other ANTHROPIC_MODEL is called without it.
const FALLBACK_MODELS = new Set(['claude-opus-5', 'claude-fable-5', 'claude-fable-5-1']);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

// Thinking counts against max_tokens, so leave room for it. This is a
// ceiling, not a spend: only the tokens generated are billed.
const MAX_TOKENS = 16000;

class AiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'AiError';
    this.status = status;
  }
}

const aiModel = () => process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
const isConfigured = () => Boolean(process.env.ANTHROPIC_API_KEY);

let client = null;
function getClient() {
  // Bounded well under the SDK's ten-minute default: a person is waiting on
  // the other end of each of these requests.
  if (!client) client = new Anthropic({ timeout: 120 * 1000, maxRetries: 2 });
  return client;
}

/**
 * Send one conversation and return the reply's text.
 * @param {{ system?: string, messages: Array<{role: string, content: string}> }} request
 * @returns {Promise<{ text: string, model: string, truncated: boolean }>}
 */
async function complete({ system, messages }) {
  if (!isConfigured()) throw new AiError(503, 'AI is not configured: ANTHROPIC_API_KEY is not set');

  const model = aiModel();
  const params = { model, max_tokens: MAX_TOKENS, messages, ...(system && { system }) };

  let response;
  try {
    response = FALLBACK_MODELS.has(model)
      ? await getClient().beta.messages.create({ ...params, betas: [FALLBACK_BETA], fallbacks: 'default' })
      : await getClient().messages.create(params);
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) throw new AiError(429, 'The AI service is busy; try again shortly');
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
      throw new AiError(502, 'The AI service rejected the configured API key');
    }
    if (err instanceof Anthropic.BadRequestError) throw new AiError(502, `The AI service rejected the request: ${err.message}`);
    if (err instanceof Anthropic.APIError) throw new AiError(502, 'The AI service is unavailable');
    throw err;
  }

  // A decline is an HTTP 200 with no usable content; the whole fallback
  // chain declined if it still reads "refusal" here.
  if (response.stop_reason === 'refusal') throw new AiError(422, 'The AI declined this request');

  // Thinking blocks come first and carry no answer; the reply is the text.
  const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
  return { text, model: response.model, truncated: response.stop_reason === 'max_tokens' };
}

module.exports = { complete, isConfigured, aiModel, AiError, DEFAULT_MODEL };
