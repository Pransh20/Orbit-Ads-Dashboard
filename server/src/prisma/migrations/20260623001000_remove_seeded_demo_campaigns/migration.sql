DELETE FROM "Campaign"
WHERE "name" IN ('Summer Collection Launch', 'Lead Gen — Enterprise')
  AND "facebookCampaignId" IS NULL;
