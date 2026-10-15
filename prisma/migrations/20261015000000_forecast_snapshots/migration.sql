CREATE TABLE "ForecastSnapshot" (
  "id" TEXT NOT NULL, "forecastId" TEXT NOT NULL, "userId" TEXT NOT NULL,
  "period" TEXT NOT NULL, "reason" TEXT NOT NULL, "currency" TEXT NOT NULL,
  "quota" DOUBLE PRECISION NOT NULL, "items" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ForecastSnapshot_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ForecastSnapshot_forecastId_createdAt_idx" ON "ForecastSnapshot"("forecastId", "createdAt");
