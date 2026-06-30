-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN "goalLabel" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "businessDescription" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "websiteUrl" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "brandName" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "parentCampaignId" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "relaunchReason" TEXT;
ALTER TABLE "Campaign" ADD COLUMN "aiGenerated" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "AdSet" ADD COLUMN "audienceLabel" TEXT;
ALTER TABLE "AdSet" ADD COLUMN "audienceReasoning" TEXT;

-- CreateTable
CREATE TABLE "PerformanceSnapshot" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dateRange" TEXT NOT NULL,
    "impressions" INTEGER,
    "reach" INTEGER,
    "clicks" INTEGER,
    "ctr" DOUBLE PRECISION,
    "spend" DOUBLE PRECISION,
    "cpm" DOUBLE PRECISION,
    "cpc" DOUBLE PRECISION,
    "frequency" DOUBLE PRECISION,
    "aiVerdict" TEXT,
    "aiSummary" TEXT,
    "rawMetaJson" JSONB,

    CONSTRAINT "PerformanceSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Campaign_parentCampaignId_idx" ON "Campaign"("parentCampaignId");

-- CreateIndex
CREATE INDEX "PerformanceSnapshot_campaignId_fetchedAt_idx" ON "PerformanceSnapshot"("campaignId", "fetchedAt");

-- AddForeignKey
ALTER TABLE "PerformanceSnapshot" ADD CONSTRAINT "PerformanceSnapshot_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
