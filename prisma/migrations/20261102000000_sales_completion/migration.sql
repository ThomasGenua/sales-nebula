-- AlterTable
ALTER TABLE "User" ADD COLUMN     "sessionVersion" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "InvoicePayment" ADD COLUMN     "paymentIntentId" TEXT;

-- AlterTable
ALTER TABLE "PaymentCheckout" ADD COLUMN     "paymentIntentId" TEXT;

-- CreateTable
CREATE TABLE "MailboxSubscription" (
    "accountId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "remoteId" TEXT,
    "stateSecret" TEXT,
    "expiresAt" TIMESTAMP(3),
    "renewAt" TIMESTAMP(3),
    "pendingAt" TIMESTAMP(3),
    "lastNotifiedAt" TIMESTAMP(3),
    "lastRenewedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "retryAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MailboxSubscription_pkey" PRIMARY KEY ("accountId")
);

-- CreateTable
CREATE TABLE "MigrationBatch" (
    "error" TEXT,
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceInstance" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Draft',
    "duplicatePolicy" TEXT NOT NULL DEFAULT 'skip',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MigrationBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MigrationRow" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "data" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Pending',
    "recordId" TEXT,
    "operation" TEXT,
    "before" JSONB,
    "afterVersion" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "MigrationRow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MigrationLink" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceInstance" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,

    CONSTRAINT "MigrationLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeetingJob" (
    "recordingId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'Queued',
    "fileKey" TEXT,
    "contentType" TEXT,
    "segments" JSONB,
    "suggestions" JSONB,
    "baseDealVersion" TIMESTAMP(3),
    "consentAt" TIMESTAMP(3) NOT NULL,
    "processingAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MeetingJob_pkey" PRIMARY KEY ("recordingId")
);

-- CreateTable
CREATE TABLE "EnterpriseIdentity" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EnterpriseIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScimIdentity" (
    "deletedAt" TIMESTAMP(3),
    "userId" TEXT NOT NULL,
    "externalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScimIdentity_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "EnterpriseLoginAttempt" (
    "stateHash" TEXT NOT NULL,
    "browserHash" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "verifier" TEXT NOT NULL,
    "ticketHash" TEXT,
    "identity" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EnterpriseLoginAttempt_pkey" PRIMARY KEY ("stateHash")
);

-- CreateTable
CREATE TABLE "SamlRequest" (
    "id" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SamlRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceAdjustment" (
    "lastError" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "evidenceDueAt" TIMESTAMP(3),
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "paymentId" TEXT,
    "kind" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "providerId" TEXT,
    "reason" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoiceAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MailboxSubscription_remoteId_key" ON "MailboxSubscription"("remoteId");

-- CreateIndex
CREATE INDEX "MailboxSubscription_enabled_renewAt_idx" ON "MailboxSubscription"("enabled", "renewAt");

-- CreateIndex
CREATE INDEX "MigrationBatch_createdById_status_idx" ON "MigrationBatch"("createdById", "status");

-- CreateIndex
CREATE INDEX "MigrationRow_batchId_status_position_idx" ON "MigrationRow"("batchId", "status", "position");

-- CreateIndex
CREATE UNIQUE INDEX "MigrationRow_batchId_module_sourceId_key" ON "MigrationRow"("batchId", "module", "sourceId");

-- CreateIndex
CREATE INDEX "MigrationLink_recordId_idx" ON "MigrationLink"("recordId");

-- CreateIndex
CREATE UNIQUE INDEX "MigrationLink_source_sourceInstance_module_sourceId_key" ON "MigrationLink"("source", "sourceInstance", "module", "sourceId");

-- CreateIndex
CREATE INDEX "MeetingJob_status_createdAt_idx" ON "MeetingJob"("status", "createdAt");

-- CreateIndex
CREATE INDEX "EnterpriseIdentity_userId_idx" ON "EnterpriseIdentity"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "EnterpriseIdentity_provider_userId_key" ON "EnterpriseIdentity"("provider", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "EnterpriseIdentity_provider_subject_key" ON "EnterpriseIdentity"("provider", "subject");

-- CreateIndex
CREATE UNIQUE INDEX "ScimIdentity_externalId_key" ON "ScimIdentity"("externalId");

-- CreateIndex
CREATE INDEX "EnterpriseLoginAttempt_expiresAt_idx" ON "EnterpriseLoginAttempt"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceAdjustment_reference_key" ON "InvoiceAdjustment"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceAdjustment_providerId_key" ON "InvoiceAdjustment"("providerId");

-- CreateIndex
CREATE INDEX "InvoiceAdjustment_invoiceId_kind_idx" ON "InvoiceAdjustment"("invoiceId", "kind");

-- CreateIndex
CREATE INDEX "InvoiceAdjustment_paymentId_idx" ON "InvoiceAdjustment"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "InvoicePayment_paymentIntentId_key" ON "InvoicePayment"("paymentIntentId");

-- AddForeignKey
ALTER TABLE "MigrationRow" ADD CONSTRAINT "MigrationRow_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "MigrationBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnterpriseIdentity" ADD CONSTRAINT "EnterpriseIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScimIdentity" ADD CONSTRAINT "ScimIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
