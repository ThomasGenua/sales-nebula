ALTER TABLE "SignupRequest" ADD COLUMN "utmMedium" TEXT;
ALTER TABLE "SignupRequest" ADD COLUMN "marketingVisitId" TEXT;

CREATE TABLE "MarketingVisit" (
  "id" TEXT NOT NULL,
  "page" TEXT NOT NULL,
  "device" TEXT NOT NULL,
  "utmSource" TEXT,
  "utmMedium" TEXT,
  "utmCampaign" TEXT,
  "demoStartedAt" TIMESTAMP(3),
  "tourCompletedAt" TIMESTAMP(3),
  "formStartedAt" TIMESTAMP(3),
  "lcpMs" DOUBLE PRECISION,
  "inpMs" DOUBLE PRECISION,
  "cls" DOUBLE PRECISION,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MarketingVisit_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "MarketingVisit_createdAt_idx" ON "MarketingVisit"("createdAt");
