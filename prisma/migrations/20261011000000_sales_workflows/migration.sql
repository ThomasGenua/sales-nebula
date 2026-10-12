-- AlterTable
ALTER TABLE "EmailSequence" ADD COLUMN     "sendingWindow" JSONB,
ADD COLUMN     "stopOnReply" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "EmailSequenceEnrollment" ADD COLUMN     "recipientEmail" TEXT;

-- AlterTable
ALTER TABLE "InboundEmailAccount" ADD COLUMN     "calendarCursor" TEXT,
ADD COLUMN     "calendarEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "calendarError" TEXT,
ADD COLUMN     "calendarLastSyncedAt" TIMESTAMP(3),
ADD COLUMN     "calendarWindowEnd" TIMESTAMP(3),
ADD COLUMN     "oauthScopes" TEXT,
ADD COLUMN     "oauthStateCalendar" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "StudioFieldValue" (
    "id" TEXT NOT NULL,
    "uniqueKey" TEXT,
    "fieldId" TEXT NOT NULL,
    "module" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StudioFieldValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteShare" (
    "id" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "quoteVersion" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "acceptedName" TEXT,
    "acceptedEmail" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuoteShare_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutlookEventLink" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "remoteId" TEXT NOT NULL,
    "remoteVersion" TEXT,
    "localHash" TEXT NOT NULL,
    "conflict" BOOLEAN NOT NULL DEFAULT false,
    "remoteOrganizer" BOOLEAN NOT NULL DEFAULT false,
    "remoteRecurring" BOOLEAN NOT NULL DEFAULT false,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutlookEventLink_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StudioFieldValue_uniqueKey_key" ON "StudioFieldValue"("uniqueKey");

-- CreateIndex
CREATE INDEX "StudioFieldValue_module_recordId_idx" ON "StudioFieldValue"("module", "recordId");

-- CreateIndex
CREATE UNIQUE INDEX "StudioFieldValue_fieldId_recordId_key" ON "StudioFieldValue"("fieldId", "recordId");

-- CreateIndex
CREATE UNIQUE INDEX "QuoteShare_tokenHash_key" ON "QuoteShare"("tokenHash");

-- CreateIndex
CREATE INDEX "QuoteShare_quoteId_idx" ON "QuoteShare"("quoteId");

-- CreateIndex
CREATE UNIQUE INDEX "OutlookEventLink_eventId_key" ON "OutlookEventLink"("eventId");

-- CreateIndex
CREATE INDEX "OutlookEventLink_accountId_idx" ON "OutlookEventLink"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "OutlookEventLink_accountId_remoteId_key" ON "OutlookEventLink"("accountId", "remoteId");

-- AddForeignKey
ALTER TABLE "StudioFieldValue" ADD CONSTRAINT "StudioFieldValue_fieldId_fkey" FOREIGN KEY ("fieldId") REFERENCES "CustomFieldDef"("id") ON DELETE CASCADE ON UPDATE CASCADE;
