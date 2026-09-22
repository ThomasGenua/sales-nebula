-- 161 columns across the models that the routes already write, and in most
-- cases read back, but that no migration ever created — so every one of those
-- writes failed with an unknown-argument error and the route answered 500.
-- Found by scripts/check-prisma-fields.js; types inferred from the values the
-- code writes, then each checked by hand against the model's existing columns
-- so a route that used the wrong name for a column that already exists was
-- corrected instead of given a duplicate. Every column is nullable or has a
-- default, so existing rows are untouched.
--
-- CaseComment.authorId becomes optional: a reply a customer sends by email
-- has no internal author (authorEmail records who wrote it). The foreign key
-- keeps ON DELETE RESTRICT.

-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "createdById" TEXT;

-- AlterTable
ALTER TABLE "Activity" ADD COLUMN     "result" TEXT;

-- AlterTable
ALTER TABLE "AiAgent" ADD COLUMN     "examples" JSONB,
ADD COLUMN     "lastRunAt" TIMESTAMP(3),
ADD COLUMN     "lastTrainedAt" TIMESTAMP(3),
ADD COLUMN     "runCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "systemPrompt" TEXT,
ADD COLUMN     "tools" JSONB,
ADD COLUMN     "trainingData" JSONB;

-- AlterTable
ALTER TABLE "AiAgentRun" ADD COLUMN     "context" JSONB,
ADD COLUMN     "triggeredById" TEXT;

-- AlterTable
ALTER TABLE "AppListing" ADD COLUMN     "features" JSONB;

-- AlterTable
ALTER TABLE "Appointment" ADD COLUMN     "assignedToId" TEXT,
ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "type" TEXT;

-- AlterTable
ALTER TABLE "ApprovalRequest" ADD COLUMN     "comments" TEXT,
ADD COLUMN     "completedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Asset" ADD COLUMN     "decommissionDate" TIMESTAMP(3),
ADD COLUMN     "decommissionReason" TEXT,
ADD COLUMN     "warrantyEndDate" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "CallRecording" ADD COLUMN     "analysis" JSONB,
ADD COLUMN     "participants" JSONB,
ADD COLUMN     "status" TEXT,
ADD COLUMN     "title" TEXT;

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "createdById" TEXT;

-- AlterTable
ALTER TABLE "Case" ADD COLUMN     "assetId" TEXT,
ADD COLUMN     "entitlementId" TEXT,
ADD COLUMN     "escalatedAt" TIMESTAMP(3),
ADD COLUMN     "escalationReason" TEXT,
ADD COLUMN     "isEscalated" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "satisfactionComment" TEXT,
ADD COLUMN     "satisfactionRating" INTEGER,
ADD COLUMN     "slaBreached" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "slaDueAt" TIMESTAMP(3),
ADD COLUMN     "slaStatus" TEXT;

-- AlterTable
ALTER TABLE "CaseComment" ALTER COLUMN "authorId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "ConnectedApp" ADD COLUMN     "apiTokenHash" TEXT,
ADD COLUMN     "revokedAt" TIMESTAMP(3),
ADD COLUMN     "revokedById" TEXT,
ADD COLUMN     "secretRotatedAt" TIMESTAMP(3),
ADD COLUMN     "tokenRefreshedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "mergedIntoId" TEXT;

-- AlterTable
ALTER TABLE "Contract" ADD COLUMN     "activatedAt" TIMESTAMP(3),
ADD COLUMN     "activatedById" TEXT,
ADD COLUMN     "name" TEXT,
ADD COLUMN     "parentContractId" TEXT,
ADD COLUMN     "terminationDate" TIMESTAMP(3),
ADD COLUMN     "terminationReason" TEXT,
ADD COLUMN     "version" INTEGER;

-- AlterTable
ALTER TABLE "ContractMilestone" ADD COLUMN     "description" TEXT;

-- AlterTable
ALTER TABLE "CustomCode" ADD COLUMN     "schedule" TEXT,
ADD COLUMN     "scheduleEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "triggerEvent" TEXT,
ADD COLUMN     "version" INTEGER;

-- AlterTable
ALTER TABLE "CustomComponent" ADD COLUMN     "targetModules" JSONB,
ADD COLUMN     "version" TEXT;

-- AlterTable
ALTER TABLE "CustomFieldValue" ADD COLUMN     "module" TEXT;

-- AlterTable
ALTER TABLE "Deal" ADD COLUMN     "partnerId" TEXT;

-- AlterTable
ALTER TABLE "DealCompetitor" ADD COLUMN     "position" INTEGER;

-- AlterTable
ALTER TABLE "Deployment" ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "components" JSONB,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "name" TEXT,
ADD COLUMN     "sourceEnvironmentId" TEXT;

-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "accessLevel" TEXT,
ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "downloadCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "isTemplate" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sharedWith" JSONB;

-- AlterTable
ALTER TABLE "EmailSuppression" ADD COLUMN     "addedById" TEXT;

-- AlterTable
ALTER TABLE "Entitlement" ADD COLUMN     "createdById" TEXT;

-- AlterTable
ALTER TABLE "EntitlementProcess" ADD COLUMN     "description" TEXT;

-- AlterTable
ALTER TABLE "Environment" ADD COLUMN     "url" TEXT;

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "ownerId" TEXT,
ADD COLUMN     "recurrenceParentId" TEXT,
ADD COLUMN     "reminderAt" TIMESTAMP(3),
ADD COLUMN     "reminderMinutes" INTEGER;

-- AlterTable
ALTER TABLE "EventAttendee" ADD COLUMN     "respondedAt" TIMESTAMP(3),
ADD COLUMN     "userId" TEXT;

-- AlterTable
ALTER TABLE "FlowDefinition" ADD COLUMN     "publishedAt" TIMESTAMP(3),
ADD COLUMN     "publishedById" TEXT;

-- AlterTable
ALTER TABLE "FlowElement" ADD COLUMN     "nextElementId" TEXT,
ADD COLUMN     "order" INTEGER;

-- AlterTable
ALTER TABLE "InboundRoutingRule" ADD COLUMN     "setStatus" TEXT;

-- AlterTable
ALTER TABLE "InstalledApp" ADD COLUMN     "version" TEXT;

-- AlterTable
ALTER TABLE "Integration" ADD COLUMN     "description" TEXT,
ADD COLUMN     "nextSyncAt" TIMESTAMP(3),
ADD COLUMN     "syncEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "IntegrationFieldMapping" ADD COLUMN     "direction" TEXT;

-- AlterTable
ALTER TABLE "KnowledgeArticle" ADD COLUMN     "publishedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Macro" ADD COLUMN     "category" TEXT,
ADD COLUMN     "executionCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastExecutedAt" TIMESTAMP(3),
ADD COLUMN     "scheduleCron" TEXT,
ADD COLUMN     "scheduleModule" TEXT,
ADD COLUMN     "scheduleTargetQuery" TEXT,
ADD COLUMN     "scheduled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "MobileDevice" ADD COLUMN     "deviceName" TEXT;

-- AlterTable
ALTER TABLE "MonitoringAlertRule" ADD COLUMN     "action" TEXT,
ADD COLUMN     "createdById" TEXT;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "carrier" TEXT,
ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "dealId" TEXT,
ADD COLUMN     "fulfilledAt" TIMESTAMP(3),
ADD COLUMN     "fulfillmentNotes" TEXT,
ADD COLUMN     "name" TEXT,
ADD COLUMN     "shippedDate" TIMESTAMP(3),
ADD COLUMN     "trackingNumber" TEXT;

-- AlterTable
ALTER TABLE "PersonAccount" ADD COLUMN     "convertedAccountId" TEXT,
ADD COLUMN     "convertedContactId" TEXT,
ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "householdId" TEXT,
ADD COLUMN     "status" TEXT;

-- AlterTable
ALTER TABLE "PortalConfig" ADD COLUMN     "customCss" TEXT,
ADD COLUMN     "footerText" TEXT,
ADD COLUMN     "headerText" TEXT,
ADD COLUMN     "logo" TEXT,
ADD COLUMN     "primaryColor" TEXT;

-- AlterTable
ALTER TABLE "PortalUser" ADD COLUMN     "firstName" TEXT,
ADD COLUMN     "language" TEXT,
ADD COLUMN     "lastName" TEXT,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "timezone" TEXT;

-- AlterTable
ALTER TABLE "ProspectList" ADD COLUMN     "isDynamic" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Quote" ADD COLUMN     "discountReason" TEXT,
ADD COLUMN     "orderId" TEXT,
ADD COLUMN     "submittedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "RevenueSchedule" ADD COLUMN     "contractId" TEXT,
ADD COLUMN     "method" TEXT,
ADD COLUMN     "periods" INTEGER;

-- AlterTable
ALTER TABLE "SalesPath" ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "name" TEXT;

-- AlterTable
ALTER TABLE "SalesPathStage" ADD COLUMN     "keyActions" JSONB,
ADD COLUMN     "successCriteria" JSONB;

-- AlterTable
ALTER TABLE "SavedView" ADD COLUMN     "lastViewedAt" TIMESTAMP(3),
ADD COLUMN     "sharedWith" JSONB,
ADD COLUMN     "sharedWithTeams" JSONB,
ADD COLUMN     "viewCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "visibility" TEXT;

-- AlterTable
ALTER TABLE "ScheduledExport" ADD COLUMN     "nextRunAt" TIMESTAMP(3),
ADD COLUMN     "recipients" JSONB;

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "changeEffectiveDate" TIMESTAMP(3),
ADD COLUMN     "renewalCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Survey" ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "publishedAt" TIMESTAMP(3),
ADD COLUMN     "responseCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "SyncLog" ADD COLUMN     "triggeredById" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "contactId" TEXT,
ADD COLUMN     "isPortalUser" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "WorkOrder" ADD COLUMN     "assetId" TEXT,
ADD COLUMN     "assignedToId" TEXT,
ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "customerSignature" TEXT,
ADD COLUMN     "dispatchedAt" TIMESTAMP(3),
ADD COLUMN     "laborHours" INTEGER,
ADD COLUMN     "partsUsed" JSONB,
ADD COLUMN     "resolution" TEXT,
ADD COLUMN     "schedulingNotes" TEXT;

-- CreateIndex
CREATE INDEX "Case_assetId_idx" ON "Case"("assetId");

-- CreateIndex
CREATE INDEX "Case_entitlementId_idx" ON "Case"("entitlementId");

-- CreateIndex
CREATE INDEX "WorkOrder_assetId_idx" ON "WorkOrder"("assetId");

