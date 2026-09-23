-- API keys were stored, and looked up, as the keys themselves. Keep only a
-- SHA-256 of each, in the same column (the schema now calls it keyHash): the
-- API hashes the presented key and looks that up, so existing keys keep
-- working. Every key the API issued starts with "sn_"; a hash is 64 hex
-- characters and never does, so running this twice changes nothing.
UPDATE "ApiKey"
SET "key" = encode(sha256(convert_to("key", 'UTF8')), 'hex')
WHERE "key" LIKE 'sn\_%';
