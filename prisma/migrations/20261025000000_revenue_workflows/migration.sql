-- AlterTable
ALTER TABLE "Activity" ADD COLUMN     "cadenceKey" TEXT;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'USD',
ADD COLUMN     "lastReminderError" TEXT,
ADD COLUMN     "nextReminderAt" TIMESTAMP(3),
ADD COLUMN     "remindersEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "remindersOwnerId" TEXT;

-- AlterTable
ALTER TABLE "FormulaField" ADD COLUMN     "rollup" JSONB;

-- AlterTable
ALTER TABLE "EmailSequenceEnrollment" ADD COLUMN     "convertedAt" TIMESTAMP(3),
ADD COLUMN     "lastOutcome" TEXT,
ADD COLUMN     "stepSnapshot" JSONB;

-- CreateTable
CREATE TABLE "InvoicePayment" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoicePayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentCheckout" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "invoiceVersion" TIMESTAMP(3) NOT NULL,
    "sessionId" TEXT,
    "url" TEXT,
    "status" TEXT NOT NULL DEFAULT 'Pending',
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentCheckout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealRoom" (
    "id" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DealRoom_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DealRoomItem" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "url" TEXT,
    "dueDate" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "author" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DealRoomItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SignatureRequest" (
    "requestKey" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "quoteVersion" TIMESTAMP(3) NOT NULL,
    "envelopeId" TEXT,
    "signerName" TEXT NOT NULL,
    "signerEmail" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Pending',
    "error" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SignatureRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignDelivery" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "recipientKey" TEXT NOT NULL,
    "contactId" TEXT,
    "leadId" TEXT,
    "email" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),
    "error" TEXT,
    "messageId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SuccessPlaybook" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "milestones" JSONB NOT NULL,
    "healthRules" JSONB NOT NULL,
    "riskThreshold" INTEGER NOT NULL DEFAULT 50,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SuccessPlaybook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountPlaybook" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "playbookId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "definition" JSONB NOT NULL,
    "healthScore" INTEGER NOT NULL DEFAULT 100,
    "riskEpisode" INTEGER NOT NULL DEFAULT 0,
    "atRisk" BOOLEAN NOT NULL DEFAULT false,
    "lastEvaluatedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountPlaybook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlaybookMilestone" (
    "id" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "activityId" TEXT,

    CONSTRAINT "PlaybookMilestone_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InvoicePayment_reference_key" ON "InvoicePayment"("reference");

-- CreateIndex
CREATE INDEX "InvoicePayment_invoiceId_idx" ON "InvoicePayment"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentCheckout_sessionId_key" ON "PaymentCheckout"("sessionId");

-- CreateIndex
CREATE INDEX "PaymentCheckout_invoiceId_idx" ON "PaymentCheckout"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "DealRoom_tokenHash_key" ON "DealRoom"("tokenHash");

-- CreateIndex
CREATE INDEX "DealRoom_dealId_idx" ON "DealRoom"("dealId");

-- CreateIndex
CREATE INDEX "DealRoomItem_roomId_createdAt_idx" ON "DealRoomItem"("roomId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SignatureRequest_requestKey_key" ON "SignatureRequest"("requestKey");

-- CreateIndex
CREATE UNIQUE INDEX "SignatureRequest_envelopeId_key" ON "SignatureRequest"("envelopeId");

-- CreateIndex
CREATE INDEX "SignatureRequest_roomId_idx" ON "SignatureRequest"("roomId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignDelivery_messageId_key" ON "CampaignDelivery"("messageId");

-- CreateIndex
CREATE INDEX "CampaignDelivery_status_nextAttemptAt_idx" ON "CampaignDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignDelivery_campaignId_recipientKey_key" ON "CampaignDelivery"("campaignId", "recipientKey");

-- CreateIndex
CREATE UNIQUE INDEX "AccountPlaybook_accountId_playbookId_key" ON "AccountPlaybook"("accountId", "playbookId");

-- CreateIndex
CREATE UNIQUE INDEX "PlaybookMilestone_activityId_key" ON "PlaybookMilestone"("activityId");

-- CreateIndex
CREATE INDEX "PlaybookMilestone_enrollmentId_idx" ON "PlaybookMilestone"("enrollmentId");

-- CreateIndex
CREATE UNIQUE INDEX "Activity_cadenceKey_key" ON "Activity"("cadenceKey");


-- Preserve existing invoices in the organization's prior billing currency.
UPDATE "Invoice" SET "currency" = COALESCE((SELECT "code" FROM "Currency" WHERE "isDefault" = true LIMIT 1), 'USD');
-- Historical Paid invoices have a ledger opening balance, not a new collection.
INSERT INTO "InvoicePayment" ("id", "invoiceId", "amountMinor", "currency", "provider", "reference", "createdAt")
SELECT 'legacy-' || "id", "id", ROUND("total" * 100)::integer, "currency", 'legacy', 'legacy:' || "id", COALESCE("paidDate", "updatedAt") FROM "Invoice" WHERE "status" = 'Paid' AND "total" > 0 AND "total" <= 21474836.47;
