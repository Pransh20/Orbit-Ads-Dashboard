ALTER TABLE "Campaign" ADD COLUMN "aiReasoning" JSONB;

ALTER TABLE "MetaConnection" ADD COLUMN "lastSyncedAt" TIMESTAMP(3);

CREATE TABLE "ActionItem" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'RECOMMENDED',
    "headline" TEXT NOT NULL,
    "bodyText" TEXT NOT NULL,
    "keyMetric" TEXT,
    "keyMetricValue" TEXT,
    "keyMetricVerdict" TEXT,
    "actionLabel" TEXT NOT NULL,
    "actionPayload" JSONB,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dismissedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "ActionItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ActionItem_campaignId_status_idx" ON "ActionItem"("campaignId", "status");
CREATE INDEX "ActionItem_type_generatedAt_idx" ON "ActionItem"("type", "generatedAt");
CREATE INDEX "ActionItem_priority_generatedAt_idx" ON "ActionItem"("priority", "generatedAt");

ALTER TABLE "ActionItem" ADD CONSTRAINT "ActionItem_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
