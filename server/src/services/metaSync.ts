import type { PrismaClient } from "@prisma/client";
import { graphList } from "./metaApi.js";

export type MetaSyncSummary = {
  synced: {
    campaigns: { created: number; updated: number };
    adSets: { created: number; updated: number };
    ads: { created: number; updated: number };
  };
  totalActive: number;
  lastSyncedAt: string;
};

export const isMetaTokenError = (error: any) => [102, 190].includes(Number(error?.code));
export const isMetaRateLimit = (error: any) => [4, 17, 32, 613].includes(Number(error?.code)) || String(error?.message || "").toLowerCase().includes("request limit");
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const accountPath = (adAccountId: string) => `act_${String(adAccountId).replace("act_", "")}`;
const centsToMoney = (value: unknown) => value == null || value === "" ? null : Math.round(Number(value) || 0) / 100;
const campaignStatus = (value: unknown) => String(value || "").toUpperCase() === "ACTIVE" ? "PUBLISHED" : String(value || "").toUpperCase() === "PAUSED" ? "PAUSED" : "DRAFT";
const adStatus = (value: unknown) => String(value || "").toUpperCase() === "ACTIVE" ? "PUBLISHED" : String(value || "").toUpperCase() === "PAUSED" ? "PAUSED" : "DRAFT";
const metaDate = (value: unknown) => {
  const parsed = value ? new Date(String(value)) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
};

async function retryMeta<T>(fn: () => Promise<T>) {
  try {
    return await fn();
  } catch (error) {
    if (!isMetaRateLimit(error)) throw error;
    await wait(2000);
    return fn();
  }
}

function localTargeting(targeting: any) {
  const countries = targeting?.geo_locations?.countries || [];
  const genders = (targeting?.genders || []).map((x: any) => String(x) === "1" ? "1" : String(x) === "2" ? "2" : null).filter(Boolean);
  return {
    ageMin: Number(targeting?.age_min || 18),
    ageMax: Number(targeting?.age_max || 65),
    genders,
    locations: (countries.length ? countries : ["IN"]).map((country: string) => ({ country })),
    interests: (targeting?.interests || []).map((item: any) => ({ id: String(item.id || item.name), name: item.name || String(item.id) })),
    customAudiences: [],
    placements: "AUTOMATIC",
    manualPlacements: [],
    deviceTypes: "ALL",
  };
}

export async function syncMetaAccount(prisma: PrismaClient, input: { userId: string; accessToken: string; adAccountId: string }): Promise<MetaSyncSummary> {
  const user = await prisma.user.findUnique({ where: { id: input.userId }, select: { defaultCurrency: true } });
  const summary: MetaSyncSummary["synced"] = {
    campaigns: { created: 0, updated: 0 },
    adSets: { created: 0, updated: 0 },
    ads: { created: 0, updated: 0 },
  };
  const campaigns = await retryMeta(() => graphList(`${accountPath(input.adAccountId)}/campaigns`, input.accessToken, {
    fields: "id,name,objective,status,effective_status,daily_budget,lifetime_budget,start_time,stop_time,special_ad_categories",
    filtering: JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE", "PAUSED"] }]),
    limit: "50",
  }));

  for (const row of campaigns) {
    const facebookCampaignId = String(row.id);
    const existing = await prisma.campaign.findFirst({ where: { createdById: input.userId, facebookCampaignId } });
    const status = campaignStatus(row.effective_status || row.status) as any;
    const dailyBudget = centsToMoney(row.daily_budget);
    const lifetimeBudget = centsToMoney(row.lifetime_budget);
    const updateData = {
      name: row.name || "Imported Facebook goal",
      status,
      dailyBudget,
      lifetimeBudget,
      startDate: metaDate(row.start_time) || existing?.startDate || new Date(),
      endDate: metaDate(row.stop_time),
      specialAdCategory: row.special_ad_categories?.[0] || existing?.specialAdCategory || "NONE",
    };
    const campaign = existing
      ? await prisma.campaign.update({ where: { id: existing.id }, data: updateData })
      : await prisma.campaign.create({
        data: {
          ...updateData,
          facebookCampaignId,
          objective: row.objective || "TRAFFIC",
          currency: user?.defaultCurrency || "USD",
          aiGenerated: false,
          goalLabel: null,
          createdById: input.userId,
        },
      });
    existing ? summary.campaigns.updated++ : summary.campaigns.created++;

    const adSets = await retryMeta(() => graphList(`${facebookCampaignId}/adsets`, input.accessToken, {
      fields: "id,name,status,effective_status,targeting,optimization_goal,billing_event,bid_strategy,bid_amount,daily_budget,lifetime_budget",
      limit: "50",
    }));
    for (const metaAdSet of adSets) {
      const facebookAdSetId = String(metaAdSet.id);
      const existingSet = await prisma.adSet.findFirst({ where: { campaignId: campaign.id, facebookAdSetId } });
      const setData = {
        name: metaAdSet.name || "Imported audience",
        status: adStatus(metaAdSet.effective_status || metaAdSet.status) as any,
        targeting: localTargeting(metaAdSet.targeting),
        optimizationGoal: metaAdSet.optimization_goal || "LINK_CLICKS",
        billingEvent: metaAdSet.billing_event || "IMPRESSIONS",
        bidStrategy: metaAdSet.bid_strategy || "LOWEST_COST",
        bidAmount: centsToMoney(metaAdSet.bid_amount),
      };
      const adSet = existingSet
        ? await prisma.adSet.update({ where: { id: existingSet.id }, data: setData })
        : await prisma.adSet.create({ data: { ...setData, campaignId: campaign.id, facebookAdSetId } });
      existingSet ? summary.adSets.updated++ : summary.adSets.created++;

      const ads = await retryMeta(() => graphList(`${facebookAdSetId}/ads`, input.accessToken, {
        fields: "id,name,status,effective_status,creative{id,name,title,body,object_url,thumbnail_url,image_url}",
        limit: "50",
      }));
      for (const metaAd of ads) {
        const facebookAdId = String(metaAd.id);
        const existingAd = await prisma.ad.findFirst({ where: { adSetId: adSet.id, facebookAdId } });
        const adData = {
          name: metaAd.name || "Imported ad",
          status: adStatus(metaAd.effective_status || metaAd.status) as any,
          format: "SINGLE_IMAGE" as const,
          primaryText: metaAd.creative?.body || "Imported from Meta Ads Manager",
          headline: metaAd.creative?.title || metaAd.name || "Imported ad",
          description: null,
          callToAction: "LEARN_MORE",
          destinationUrl: metaAd.creative?.object_url || "https://example.com",
        };
        existingAd
          ? await prisma.ad.update({ where: { id: existingAd.id }, data: adData })
          : await prisma.ad.create({ data: { ...adData, adSetId: adSet.id, facebookAdId } });
        existingAd ? summary.ads.updated++ : summary.ads.created++;
      }
    }
  }

  const lastSyncedAt = new Date();
  await prisma.metaConnection.update({ where: { userId: input.userId }, data: { lastSyncedAt } });
  return { synced: summary, totalActive: campaigns.length, lastSyncedAt: lastSyncedAt.toISOString() };
}
