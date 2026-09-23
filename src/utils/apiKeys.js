/**
 * API keys are kept as a SHA-256 of the key, never the key itself.
 *
 * They were stored, and looked up, in plain text: anyone who could read the
 * ApiKey table, a backup or a replica, held every integration's credentials.
 * A key is 32 random bytes, so an unsalted hash is enough to make a stolen
 * table useless. The key is shown once, when it is created.
 */
const crypto = require('crypto');

const hashApiKey = raw => crypto.createHash('sha256').update(String(raw)).digest('hex');

module.exports = { hashApiKey };
