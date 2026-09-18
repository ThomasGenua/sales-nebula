-- Consent capture wrote to three columns that were never created, so every
-- write to /api/consent failed. Add them rather than drop the behaviour: who
-- recorded a consent and over which channel is exactly what an auditor asks
-- for, and a withdrawn record needs to be retractable without being lost.

ALTER TABLE "ConsentRecord" ADD COLUMN IF NOT EXISTS "channel" TEXT;
ALTER TABLE "ConsentRecord" ADD COLUMN IF NOT EXISTS "recordedById" TEXT;
ALTER TABLE "ConsentRecord" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);

-- Erasure requests were previously logged as consent rows with a made-up
-- type, which made them impossible to query and impossible to close out.
CREATE TABLE IF NOT EXISTS "DataSubjectRequest" (
    "id" TEXT NOT NULL,
    "requestType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "subjectType" TEXT NOT NULL,
    "contactId" TEXT,
    "leadId" TEXT,
    "personAccountId" TEXT,
    "email" TEXT,
    "strategy" TEXT,
    "requestedById" TEXT,
    "processedById" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "notes" TEXT,
    "error" TEXT,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DataSubjectRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "DataSubjectRequest_status_idx" ON "DataSubjectRequest"("status");
CREATE INDEX IF NOT EXISTS "DataSubjectRequest_requestType_idx" ON "DataSubjectRequest"("requestType");
CREATE INDEX IF NOT EXISTS "DataSubjectRequest_email_idx" ON "DataSubjectRequest"("email");
CREATE INDEX IF NOT EXISTS "DataSubjectRequest_contactId_idx" ON "DataSubjectRequest"("contactId");
