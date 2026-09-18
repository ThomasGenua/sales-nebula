-- A Microsoft Graph mailbox authenticates with OAuth and has no host or
-- password, so those two columns stop being mandatory, and the account gains
-- somewhere to keep its provider and its encrypted token material.

ALTER TABLE "InboundEmailAccount" ALTER COLUMN "host" DROP NOT NULL;
ALTER TABLE "InboundEmailAccount" ALTER COLUMN "password" DROP NOT NULL;

ALTER TABLE "InboundEmailAccount" ADD COLUMN IF NOT EXISTS "provider" TEXT NOT NULL DEFAULT 'imap';
ALTER TABLE "InboundEmailAccount" ADD COLUMN IF NOT EXISTS "mailboxAddress" TEXT;
ALTER TABLE "InboundEmailAccount" ADD COLUMN IF NOT EXISTS "tenantId" TEXT;
ALTER TABLE "InboundEmailAccount" ADD COLUMN IF NOT EXISTS "oauthRefreshToken" TEXT;
ALTER TABLE "InboundEmailAccount" ADD COLUMN IF NOT EXISTS "oauthAccessToken" TEXT;
ALTER TABLE "InboundEmailAccount" ADD COLUMN IF NOT EXISTS "oauthExpiresAt" TIMESTAMP(3);
ALTER TABLE "InboundEmailAccount" ADD COLUMN IF NOT EXISTS "lastSyncAt" TIMESTAMP(3);

-- A stored message keeps the provider's own id so a reply can be threaded
-- back onto the original conversation.
ALTER TABLE "InboundEmailMessage" ADD COLUMN IF NOT EXISTS "externalId" TEXT;
ALTER TABLE "InboundEmailMessage" ADD COLUMN IF NOT EXISTS "repliedAt" TIMESTAMP(3);

-- The ingestion pipeline recorded whether a message was an auto-reply, but
-- there was no column to put it in.
ALTER TABLE "InboundEmailMessage" ADD COLUMN IF NOT EXISTS "isAutomated" BOOLEAN NOT NULL DEFAULT false;
