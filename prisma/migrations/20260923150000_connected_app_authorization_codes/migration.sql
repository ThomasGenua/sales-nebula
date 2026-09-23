-- Connected-app OAuth gets a real authorization step (see src/services/oauth.js).
--
-- Client secrets and OAuth tokens were stored as themselves, so anyone who
-- could read these tables, a backup or a replica held working credentials.
-- Only a SHA-256 of each is kept from now on, in the same columns; the
-- secrets are all 32 random bytes, so an unsalted hash is enough.
UPDATE "ConnectedApp" SET "clientSecret" = encode(sha256(convert_to("clientSecret", 'UTF8')), 'hex');

-- Tokens the old endpoint minted without anyone's consent keep their rows,
-- hashed like the rest. They can no longer be used: no refresh token is
-- honoured without a refreshExpiresAt, which none of them has.
UPDATE "OAuthToken" SET
  "accessToken" = encode(sha256(convert_to("accessToken", 'UTF8')), 'hex'),
  "refreshToken" = CASE WHEN "refreshToken" IS NULL THEN NULL
                        ELSE encode(sha256(convert_to("refreshToken", 'UTF8')), 'hex') END;

-- AlterTable
ALTER TABLE "OAuthToken" ADD COLUMN     "refreshExpiresAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "OAuthAuthorizationCode" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "appId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "codeChallenge" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthAuthorizationCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OAuthAuthorizationCode_codeHash_key" ON "OAuthAuthorizationCode"("codeHash");

-- CreateIndex
CREATE INDEX "OAuthAuthorizationCode_appId_idx" ON "OAuthAuthorizationCode"("appId");

-- CreateIndex
CREATE INDEX "OAuthAuthorizationCode_userId_idx" ON "OAuthAuthorizationCode"("userId");
