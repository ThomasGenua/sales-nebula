-- AlterTable
ALTER TABLE "SignatureRequest" ADD COLUMN     "statusChangedAt" TIMESTAMP(3),
ADD COLUMN     "statusReason" TEXT;

-- CreateTable
CREATE TABLE "UserOnboarding" (
    "userId" TEXT NOT NULL,
    "pipelineReadyAt" TIMESTAMP(3),
    "firstImportAt" TIMESTAMP(3),
    "firstDealAt" TIMESTAMP(3),
    "firstQuoteAt" TIMESTAMP(3),
    "dismissedAt" TIMESTAMP(3),
    "analyticsOptOut" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserOnboarding_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "UserUsageDay" (
    "userId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserUsageDay_pkey" PRIMARY KEY ("userId","day")
);

-- CreateTable
CREATE TABLE "OAuthLoginAttempt" (
    "stateHash" TEXT NOT NULL,
    "browserHash" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "verifier" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OAuthLoginAttempt_pkey" PRIMARY KEY ("stateHash")
);

-- CreateTable
CREATE TABLE "SignatureEvent" (
    "id" TEXT NOT NULL,
    "envelopeId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SignatureEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "UserUsageDay_createdAt_idx" ON "UserUsageDay"("createdAt");

-- CreateIndex
CREATE INDEX "OAuthLoginAttempt_expiresAt_idx" ON "OAuthLoginAttempt"("expiresAt");

-- CreateIndex
CREATE INDEX "SignatureEvent_envelopeId_idx" ON "SignatureEvent"("envelopeId");

-- AddForeignKey
ALTER TABLE "UserOnboarding" ADD CONSTRAINT "UserOnboarding_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserUsageDay" ADD CONSTRAINT "UserUsageDay_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
