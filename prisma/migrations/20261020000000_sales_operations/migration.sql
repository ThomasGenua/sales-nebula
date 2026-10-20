ALTER TABLE "Deal" ADD COLUMN "qualification" JSONB,
 ADD COLUMN "nextStep" TEXT,
 ADD COLUMN "nextStepDate" TIMESTAMP(3),
 ADD COLUMN "renewalContractId" TEXT;
CREATE UNIQUE INDEX "Deal_renewalContractId_key" ON "Deal"("renewalContractId");
CREATE TABLE "ConfigurationRevision" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "label" TEXT NOT NULL,
 "before" JSONB NOT NULL,
 "after" JSONB NOT NULL,
 "createdById" TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
