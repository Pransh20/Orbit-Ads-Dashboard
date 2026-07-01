import type { PrismaClient } from "@prisma/client";
import { benchmarkFor, getVerdict } from "../constants/benchmarks.js";
import { graphList } from "./metaApi.js";
import { isMetaRateLimit } from "./metaSync.js";

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const priorityRank: Record<string, number> = { URGENT: 0, RECOMMENDED: 1, OPTIONAL: 2 };
const money = (value: number, currency = "USD") => new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(value);
const leadTypes = ["lead", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead", "leadgen_grouped"];
const purchaseTypes = ["purchase", "omni_purchase", "offsite_conversion.fb_pixel_purchase"];
const engagementTypes = ["post_reaction", "comment", "post", "like"];
const accountPath = (adAccountId: string) => `act_${String(adAccountId).replace("act_", "")}`;
const centsToMoney = (value: unknown) => value == null || value === "" ? null : Math.round(Number(value) || 0) / 100;
const metaDate = (value: unknown) => {
  const parsed = value ? new Date(String(value)) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
};

function actionValue(row: any, matchers: string[]) {
  return (row.actions || []).reduce((total: number, item: any) => matchers.some(type => String(item.action_type || "").includes(type)) ? total + Number(item.value || 0) : total, 0);
}

function daysRunning(startDate?: Date | string | null) {
  const start = startDate ? new Date(startDate) : new Date();
  return Math.max(1, Math.round((Date.now() - start.getTime()) / 86_400_000));
}

async function retryOnce<T>(fn: () => Promise<T>) {
  try {
    return await fn();
  } catch (error) {
    if (!isMetaRateLimit(error)) throw error;
    await wait(2000);
    return fn();
  }
}

async function syncRunningCampaignsOnly(prisma: PrismaClient, input: { userId: string; accessToken: string; adAccountId: string }) {
  const user = await prisma.user.findUnique({ where: { id: input.userId }, select: { defaultCurrency: true } });
  const summary = { campaigns: { created: 0, updated: 0 }, adSets: { created: 0, updated: 0 }, ads: { created: 0, updated: 0 } };
  const rows = await retryOnce(() => graphList(`${accountPath(input.adAccountId)}/campaigns`, input.accessToken, {
    fields: "id,name,objective,status,effective_status,daily_budget,lifetime_budget,start_time,stop_time,special_ad_categories",
    filtering: JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE"] }]),
    limit: "100",
  }));
  const campaignIds: string[] = [];
  for (const row of rows) {
    const facebookCampaignId = String(row.id);
    const existing = await prisma.campaign.findFirst({ where: { createdById: input.userId, facebookCampaignId } });
    const data = {
      name: row.name || "Running Facebook goal",
      status: "PUBLISHED" as const,
      dailyBudget: centsToMoney(row.daily_budget),
      lifetimeBudget: centsToMoney(row.lifetime_budget),
      startDate: metaDate(row.start_time) || existing?.startDate || new Date(),
      endDate: metaDate(row.stop_time),
      specialAdCategory: row.special_ad_categories?.[0] || existing?.specialAdCategory || "NONE",
    };
    const campaign = existing
      ? await prisma.campaign.update({ where: { id: existing.id }, data })
      : await prisma.campaign.create({
        data: {
          ...data,
          facebookCampaignId,
          objective: row.objective || "TRAFFIC",
          currency: user?.defaultCurrency || "USD",
          aiGenerated: false,
          goalLabel: null,
          createdById: input.userId,
        },
      });
    campaignIds.push(campaign.id);
    existing ? summary.campaigns.updated++ : summary.campaigns.created++;
  }
  const lastSyncedAt = new Date();
  await prisma.metaConnection.update({ where: { userId: input.userId }, data: { lastSyncedAt } });
  return { sync: { synced: summary, totalActive: rows.length, lastSyncedAt: lastSyncedAt.toISOString() }, campaignIds };
}

async function aiJson<T>(prompt: string, fallback: T): Promise<T> {
  if (!process.env.OPENAI_API_KEY) return fallback;
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-4o",
        temperature: 0.7,
        input: [
          { role: "system", content: "You are a practical Facebook ads coach. Respond only with valid JSON." },
          { role: "user", content: prompt },
        ],
      }),
    });
    const data = await response.json() as any;
    if (!response.ok) throw new Error(data?.error?.message || "OpenAI request failed");
    const text = data.output_text || data.output?.flatMap((x: any) => x.content || []).find((x: any) => x.type === "output_text")?.text || "";
    return JSON.parse(text) as T;
  } catch (error) {
    console.error("Recommendation AI rule skipped", error);
    return fallback;
  }
}

function baseAction(campaign: any, type: string, priority: string, data: Record<string, unknown>) {
  return {
    campaignId: campaign.id,
    type,
    priority,
    headline: String(data.headline),
    bodyText: String(data.bodyText),
    keyMetric: data.keyMetric ? String(data.keyMetric) : null,
    keyMetricValue: data.keyMetricValue ? String(data.keyMetricValue) : null,
    keyMetricVerdict: data.keyMetricVerdict ? String(data.keyMetricVerdict) : null,
    actionLabel: String(data.actionLabel),
    actionPayload: data.actionPayload as any,
    status: "PENDING",
  };
}

function costPerResult(campaign: any, row: any) {
  const spend = Number(row.spend || 0);
  if (["CONVERSIONS", "SALES", "OUTCOME_SALES"].includes(campaign.objective)) {
    const purchases = actionValue(row, purchaseTypes);
    return { value: purchases ? spend / purchases : 0, sentence: purchases ? `Each sale cost you approximately ${money(spend / purchases, campaign.currency)}` : "Meta did not return a sale count yet" };
  }
  if (["LEAD_GENERATION", "OUTCOME_LEADS"].includes(campaign.objective)) {
    const leads = actionValue(row, leadTypes);
    return { value: leads ? spend / leads : 0, sentence: leads ? `Each contact form fill cost ${money(spend / leads, campaign.currency)}` : "Meta did not return lead counts yet" };
  }
  if (campaign.objective === "REACH" || campaign.objective === "OUTCOME_AWARENESS") {
    const reach = Number(row.reach || 0);
    return { value: reach ? spend / (reach / 1000) : 0, sentence: reach ? `You paid ${money(spend / (reach / 1000), campaign.currency)} to reach 1,000 people` : "Reach is still too low to calculate cost per 1,000 people" };
  }
  if (campaign.objective === "ENGAGEMENT" || campaign.objective === "OUTCOME_ENGAGEMENT") {
    const actions = actionValue(row, engagementTypes);
    return { value: actions ? spend / actions : 0, sentence: actions ? `Each engagement cost approximately ${money(spend / actions, campaign.currency)}` : "Meta did not return engagement counts yet" };
  }
  const clicks = Number(row.clicks || 0);
  return { value: clicks ? spend / clicks : 0, sentence: clicks ? `Each website visit cost approximately ${money(spend / clicks, campaign.currency)}` : "Meta did not return click counts yet" };
}

async function campaignActions(prisma: PrismaClient, campaign: any, row: any) {
  const b = benchmarkFor(campaign.objective);
  const actions: any[] = [];
  const firstAdSet = campaign.adSets?.[0];
  const firstAd = firstAdSet?.ads?.[0];
  const spend = Number(row.spend || 0);
  const ctr = Number(row.ctr || 0);
  const cpc = Number(row.cpc || 0);
  const frequency = Number(row.frequency || 0);
  const impressions = Number(row.impressions || 0);
  const dailyBudget = Number(campaign.dailyBudget || 0);
  const running = daysRunning(campaign.startDate);
  const push = (item: any) => { if (actions.length < 3) actions.push(item); };

  if (dailyBudget && spend > dailyBudget * 3 && ctr < b.ctr.poor && impressions > 1000) {
    push(baseAction(campaign, "PAUSE_ALERT", "URGENT", {
      headline: "This ad is spending money without results",
      bodyText: `You've spent ${money(spend, campaign.currency)} and only ${ctr.toFixed(2)}% of people are clicking — well below the ${b.ctr.average}% average. Pausing now will stop further spend while you fix it.`,
      keyMetric: "People who clicked",
      keyMetricValue: `${ctr.toFixed(2)}%`,
      keyMetricVerdict: "POOR",
      actionLabel: "Pause this ad",
      actionPayload: { action: "PAUSE", campaignId: campaign.id },
    }));
  }
  if (actions.length >= 3) return actions;

  if (spend >= b.minSpendForAnalysis && ctr >= b.ctr.good && getVerdict("cpc", cpc, campaign.objective) !== "POOR" && running >= 2) {
    const newBudget = Math.round((dailyBudget || spend / 7) * 1.3 * 100) / 100;
    push(baseAction(campaign, "SCALE_BUDGET", "RECOMMENDED", {
      headline: "Your ad is working well — reach more people",
      bodyText: `Your ad has a ${ctr.toFixed(2)}% click rate, which is above average for your goal. Increasing your daily budget by 30% could get you proportionally more results without losing performance.`,
      keyMetric: "% who clicked",
      keyMetricValue: `${ctr.toFixed(2)}%`,
      keyMetricVerdict: "GOOD",
      actionLabel: "Increase budget by 30%",
      actionPayload: { action: "INCREASE_BUDGET", campaignId: campaign.id, currentBudget: dailyBudget, newBudget },
    }));
  }
  if (actions.length >= 3) return actions;

  if (spend >= b.minSpendForAnalysis && ctr < b.ctr.average && ctr >= b.ctr.poor && running >= 3 && firstAd) {
    const fix = await aiJson(
      `An ad with objective ${campaign.objective} has been running for ${running} days. CTR is ${ctr.toFixed(2)}% (average for this goal is ${b.ctr.average}%). The current ad headline is: '${firstAd.headline}'. The current primary text is: '${firstAd.primaryText}'. In one plain sentence, tell the user what is likely causing low clicks and what specific change to the copy would help. Do not use marketing jargon. Respond in JSON: { "suggestion": string, "newHeadline": string, "newPrimaryText": string }`,
      { suggestion: "People are seeing the ad, but the opening message could be clearer about the benefit. Try making the headline more specific and the first sentence more direct.", newHeadline: firstAd.headline, newPrimaryText: firstAd.primaryText },
    );
    push(baseAction(campaign, "FIX_PERFORMANCE", "RECOMMENDED", {
      headline: "Your ad is getting seen but not many are clicking",
      bodyText: fix.suggestion,
      keyMetric: "% who clicked",
      keyMetricValue: `${ctr.toFixed(2)}%`,
      keyMetricVerdict: "AVERAGE",
      actionLabel: "Try this new message",
      actionPayload: { action: "RELAUNCH_WITH_COPY", campaignId: campaign.id, newHeadline: fix.newHeadline, newPrimaryText: fix.newPrimaryText },
    }));
  }
  if (actions.length >= 3) return actions;

  if (frequency >= b.frequencyWarning && running >= 3 && spend >= b.minSpendForAnalysis) {
    push(baseAction(campaign, "REFRESH_CREATIVE", "RECOMMENDED", {
      headline: "People are seeing your ad too often",
      bodyText: `Each person has seen your ad an average of ${frequency.toFixed(2)} times. When people see the same ad too many times, they start ignoring it. Uploading a new image or changing the message will reset this.`,
      keyMetric: "Average times each person saw it",
      keyMetricValue: `${frequency.toFixed(2)}×`,
      keyMetricVerdict: "POOR",
      actionLabel: "Refresh this ad",
      actionPayload: { action: "OPEN_REFRESH_FLOW", campaignId: campaign.id },
    }));
  }
  if (actions.length >= 3) return actions;

  const recentAudience = await prisma.actionItem.findFirst({ where: { campaignId: campaign.id, type: "NEW_AUDIENCE", generatedAt: { gte: new Date(Date.now() - 7 * 86_400_000) } } });
  if (!recentAudience && running >= 7 && spend >= b.minSpendForAnalysis * 3 && getVerdict("ctr", ctr, campaign.objective) !== "POOR") {
    const suggestion = await aiJson(
      `An ad for the objective ${campaign.objective} has been running for ${running} days targeting: ${JSON.stringify(firstAdSet?.targeting || {})}. The CTR is ${ctr.toFixed(2)}%. Suggest ONE new audience variation to test alongside this one. Describe it in plain English as the user would understand it — not in Meta jargon. Respond in JSON: { "audienceDescription": string, "reasoning": string, "suggestedAgeMin": number, "suggestedAgeMax": number, "suggestedInterests": string[] }`,
      { audienceDescription: "Try a nearby broad audience with one clear interest", reasoning: "This keeps enough room for Meta to learn while testing a different buying signal.", suggestedAgeMin: 25, suggestedAgeMax: 54, suggestedInterests: [] as string[] },
    );
    push(baseAction(campaign, "NEW_AUDIENCE", "OPTIONAL", {
      headline: "Try showing this ad to a different group of people",
      bodyText: `${suggestion.audienceDescription} — ${suggestion.reasoning}`,
      keyMetric: "Days running",
      keyMetricValue: `${running} days`,
      keyMetricVerdict: "GOOD",
      actionLabel: "Create this audience",
      actionPayload: { action: "CREATE_ADSET", campaignId: campaign.id, ...suggestion },
    }));
  }
  if (actions.length >= 3) return actions;

  if (running >= 7 && running % 7 === 0) {
    const cpr = costPerResult(campaign, row);
    const fullySpending = dailyBudget > 0 && spend >= dailyBudget * Math.min(running, 7) * 0.95;
    const underSpending = dailyBudget > 0 && spend < dailyBudget * Math.min(running, 7) * 0.7;
    const budgetAssessment = getVerdict("ctr", ctr, campaign.objective) === "GOOD" && fullySpending
      ? "it's fully spending — consider increasing it to grow faster"
      : underSpending ? "your ad isn't spending its full budget, which may mean the audience is too narrow" : "this looks right-sized for your current results";
    push(baseAction(campaign, "BUDGET_REVIEW", "OPTIONAL", {
      headline: "Your weekly budget summary",
      bodyText: `In the last 7 days you spent ${money(spend, campaign.currency)} and reached ${Number(row.reach || 0).toLocaleString()} people. ${cpr.sentence}. Your daily budget is ${money(dailyBudget, campaign.currency)} — ${budgetAssessment}.`,
      keyMetric: "Total spent",
      keyMetricValue: money(spend, campaign.currency),
      keyMetricVerdict: null,
      actionLabel: "See full results",
      actionPayload: { action: "VIEW_DETAIL", campaignId: campaign.id },
    }));
  }
  if (actions.length >= 3) return actions;

  const recentTest = await prisma.actionItem.findFirst({ where: { campaignId: campaign.id, type: "AB_TEST", generatedAt: { gte: new Date(Date.now() - 14 * 86_400_000) } } });
  if (!recentTest && firstAd && running >= 5 && spend >= b.minSpendForAnalysis * 2) {
    const variant = await aiJson(
      `An ad has been running for ${running} days with CTR of ${ctr.toFixed(2)}%. The current headline is '${firstAd.headline}' and primary text is '${firstAd.primaryText}'. Generate a second version with a completely different angle — if the current ad is practical/benefit-focused, make the new one emotional or curiosity-driven, and vice versa. Respond in JSON: { "alternativeHeadline": string, "alternativePrimaryText": string, "angleName": string }`,
      { alternativeHeadline: firstAd.headline, alternativePrimaryText: firstAd.primaryText, angleName: "different-angle" },
    );
    push(baseAction(campaign, "AB_TEST", "OPTIONAL", {
      headline: "Test a different message angle",
      bodyText: `Try running a ${variant.angleName} version alongside it — after 5 days we'll show you which one people respond to more.`,
      keyMetric: "Days running",
      keyMetricValue: `${running} days`,
      keyMetricVerdict: null,
      actionLabel: "Launch the test",
      actionPayload: { action: "CREATE_AB_VARIANT", campaignId: campaign.id, ...variant },
    }));
  }
  return actions;
}

export async function generateRecommendations(prisma: PrismaClient, input: { userId: string; accessToken: string; adAccountId: string }) {
  const { sync, campaignIds } = await syncRunningCampaignsOnly(prisma, input);
  const syncedFromMeta = {
    created: sync.synced.campaigns.created + sync.synced.adSets.created + sync.synced.ads.created,
    updated: sync.synced.campaigns.updated + sync.synced.adSets.updated + sync.synced.ads.updated,
  };
  if (!campaignIds.length) {
    await prisma.actionItem.deleteMany({ where: { status: "PENDING", campaign: { createdById: input.userId } } });
    return {
      actions: [],
      analysed: 0,
      skipped: 0,
      syncedFromMeta,
      generatedAt: new Date().toISOString(),
    };
  }
  const insightRows = await retryOnce(() => graphList(`${accountPath(input.adAccountId)}/insights`, input.accessToken, {
    fields: "campaign_id,campaign_name,impressions,reach,clicks,ctr,spend,cpm,cpc,frequency,actions,action_values",
    date_preset: "last_7d",
    level: "campaign",
    limit: "500",
  }));
  const insightByCampaignId = new Map(insightRows.map((row: any) => [String(row.campaign_id), row]));
  const campaigns = await prisma.campaign.findMany({
    where: { createdById: input.userId, id: { in: campaignIds }, facebookCampaignId: { not: null }, status: "PUBLISHED" },
    include: { adSets: { include: { ads: true } } },
  });
  const generated: any[] = [];
  const analysedIds: string[] = [];
  let skipped = 0;

  for (const campaign of campaigns) {
    try {
      const row = insightByCampaignId.get(String(campaign.facebookCampaignId));
      if (!row || Number(row.spend || 0) <= 0) {
        skipped++;
        continue;
      }
      await prisma.performanceSnapshot.create({
        data: {
          campaignId: campaign.id,
          dateRange: "last_7_days",
          impressions: row.impressions ? Number(row.impressions) : null,
          reach: row.reach ? Number(row.reach) : null,
          clicks: row.clicks ? Number(row.clicks) : null,
          ctr: row.ctr ? Number(row.ctr) : null,
          spend: row.spend ? Number(row.spend) : null,
          cpm: row.cpm ? Number(row.cpm) : null,
          cpc: row.cpc ? Number(row.cpc) : null,
          frequency: row.frequency ? Number(row.frequency) : null,
          rawMetaJson: row,
        },
      });
      analysedIds.push(campaign.id);
      generated.push(...await campaignActions(prisma, campaign, row));
    } catch (error) {
      console.error("Skipping recommendation campaign", campaign.id, error);
      skipped++;
    }
  }

  await prisma.actionItem.deleteMany({ where: { status: "PENDING", campaign: { createdById: input.userId } } });
  const actions = generated.length
    ? await prisma.actionItem.createManyAndReturn({ data: generated })
    : [];
  const ordered = [...actions].sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority] || b.generatedAt.getTime() - a.generatedAt.getTime());
  return {
    actions: ordered,
    analysed: analysedIds.length,
    skipped,
    syncedFromMeta,
    generatedAt: new Date().toISOString(),
  };
}
