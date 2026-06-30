import fs from "node:fs";
import path from "node:path";

export const API_VERSION = process.env.META_API_VERSION || "v25.0";
const base = `https://graph.facebook.com/${API_VERSION}`;
const DEFAULT_OAUTH_SCOPES = [
  "ads_read",
  "ads_management",
  "business_management",
  "pages_show_list",
  "pages_read_engagement",
];

export function metaOAuthScopes() {
  return (process.env.META_OAUTH_SCOPES || DEFAULT_OAUTH_SCOPES.join(","))
    .split(",")
    .map(scope => scope.trim())
    .filter(Boolean);
}

type MetaResult = { id: string; step: string; reused?: boolean; localId?: string };

async function request(path: string, accessToken: string, body?: Record<string, unknown>) {
  let attempt = 0;
  while (attempt < 4) {
    const form = body ? new URLSearchParams(
      Object.entries({ ...body, access_token: accessToken }).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)])
    ) : undefined;
    const separator = path.includes("?") ? "&" : "?";
    const response = await fetch(`${base}/${path}${body ? "" : `${separator}access_token=${encodeURIComponent(accessToken)}`}`, {
      method: body ? "POST" : "GET",
      body: form,
    });
    const data = await response.json() as any;
    if (response.ok) return data;
    const code = data?.error?.code;
    if ((code === 4 || code === 17 || code === 32) && attempt < 3) {
      await new Promise(r => setTimeout(r, 500 * 2 ** attempt));
      attempt++;
      continue;
    }
    const error = new Error(data?.error?.error_user_msg || data?.error?.message || "Meta API request failed") as Error & { code?: number; details?: any };
    error.code = code;
    error.details = data?.error;
    throw error;
  }
}

export async function graphGet(pathname: string, accessToken: string, params: Record<string, string> = {}) {
  const query = new URLSearchParams(params).toString();
  return request(`${pathname}${query ? `?${query}` : ""}`, accessToken);
}

export async function graphList(pathname: string, accessToken: string, params: Record<string, string> = {}) {
  const items: any[] = [];
  let next: string | undefined = `${base}/${pathname}?${new URLSearchParams({ ...params, access_token: accessToken })}`;
  let pages = 0;
  while (next && pages < 20) {
    const response = await fetch(next);
    const data = await response.json() as any;
    if (!response.ok) {
      const error = new Error(data?.error?.message || "Meta API request failed") as Error & { code?: number };
      error.code = data?.error?.code;
      throw error;
    }
    items.push(...(data.data || []));
    next = data.paging?.next;
    pages++;
  }
  return items;
}

export async function listAccessibleAdAccounts(accessToken: string) {
  const fields = "id,name,currency,account_status,timezone_name,amount_spent,balance";
  const direct = await graphList("me/adaccounts", accessToken, { fields, limit: "100" });
  const byId = new Map(direct.map(account => [account.id, { ...account, accessSource: "direct" }]));
  let businessPermissionGranted = true;
  let businessError: string | null = null;
  try {
    const businesses = await graphList("me/businesses", accessToken, { fields: "id,name", limit: "100" });
    for (const business of businesses) {
      for (const edge of ["owned_ad_accounts", "client_ad_accounts"]) {
        try {
          const accounts = await graphList(`${business.id}/${edge}`, accessToken, { fields, limit: "100" });
          for (const account of accounts) {
            byId.set(account.id, {
              ...account,
              accessSource: edge === "owned_ad_accounts" ? "business-owned" : "business-client",
              business: { id: business.id, name: business.name },
            });
          }
        } catch (error: any) {
          businessError ||= error.message;
        }
      }
    }
  } catch (error: any) {
    businessPermissionGranted = false;
    businessError = error.message;
  }
  return { accounts: [...byId.values()], businessPermissionGranted, businessError };
}

async function uploadAsset(pathname: string, accessToken: string, creative: any) {
  const uploadRoot = process.env.LOCAL_UPLOAD_PATH || path.resolve("uploads");
  const localPath = path.join(uploadRoot, path.basename(creative.fileUrl));
  if (!fs.existsSync(localPath)) throw Object.assign(new Error(`Creative file is missing: ${creative.fileName}`), { step: "creative_upload" });
  for (let attempt = 0; attempt < 4; attempt++) {
    const form = new FormData();
    form.append("access_token", accessToken);
    form.append("source", new Blob([new Uint8Array(fs.readFileSync(localPath))], { type: creative.mimeType }), creative.fileName);
    const response = await fetch(`${base}/${pathname}`, { method: "POST", body: form });
    const data = await response.json() as any;
    if (response.ok) return data;
    const code = data?.error?.code;
    if ([4,17,32].includes(code) && attempt < 3) {
      await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
      continue;
    }
    throw Object.assign(new Error(data?.error?.message || "Meta creative upload failed"), { code, step: "creative_upload" });
  }
}

const objectiveMap: Record<string, string> = {
  AWARENESS: "OUTCOME_AWARENESS", REACH: "OUTCOME_AWARENESS", TRAFFIC: "OUTCOME_TRAFFIC",
  ENGAGEMENT: "OUTCOME_ENGAGEMENT", APP_PROMOTION: "OUTCOME_APP_PROMOTION",
  LEAD_GENERATION: "OUTCOME_LEADS", CONVERSIONS: "OUTCOME_SALES", SALES: "OUTCOME_SALES",
};

const safePublishObjective = (objective: string) => {
  if (["CONVERSIONS", "SALES", "LEAD_GENERATION", "OUTCOME_SALES", "OUTCOME_LEADS"].includes(objective)) return "OUTCOME_TRAFFIC";
  return objectiveMap[objective] || objective;
};

const safeOptimizationGoal = (objective: string, optimizationGoal: string) => {
  if (["AWARENESS", "REACH", "OUTCOME_AWARENESS"].includes(objective) && optimizationGoal === "REACH") return "REACH";
  return "LINK_CLICKS";
};

const safeBidStrategy = (bidStrategy?: string) => {
  if (!bidStrategy || bidStrategy === "LOWEST_COST") return "LOWEST_COST_WITHOUT_CAP";
  if (bidStrategy === "BID_CAP") return "LOWEST_COST_WITH_BID_CAP";
  return bidStrategy;
};

const countryAliases: Record<string, string> = {
  INDIA: "IN",
  "UNITED KINGDOM": "GB",
  UK: "GB",
  "UNITED STATES": "US",
  USA: "US",
};

const countryCode = (value: unknown) => {
  const raw = String(value || "").trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(raw)) return raw;
  return countryAliases[raw];
};

const genderCode = (value: unknown) => {
  const raw = String(value || "").trim().toUpperCase();
  if (raw === "1" || raw === "MEN" || raw === "MALE") return 1;
  if (raw === "2" || raw === "WOMEN" || raw === "FEMALE") return 2;
  return null;
};

function metaTargeting(targeting: any) {
  const countries = (targeting.locations || []).map((item: any) => countryCode(item.country || item)).filter(Boolean);
  const genders = (targeting.genders || []).map(genderCode).filter((value: number | null): value is number => value === 1 || value === 2);
  const interests = (targeting.interests || [])
    .filter((item: any) => item.id && !Number.isNaN(Number(item.id)) && Number(item.id) > 0)
    .map((item: any) => ({ id: String(item.id), name: item.name }))
    .slice(0, 10);
  const result: any = {
    age_min: Math.max(18, Number(targeting.ageMin || 18)),
    age_max: Math.min(65, Number(targeting.ageMax || 65)),
    geo_locations: { countries: countries.length ? countries : ["IN"] },
  };
  if (genders.length) result.genders = genders;
  if (interests.length) result.interests = interests;
  if (targeting.customAudiences?.length) result.custom_audiences = targeting.customAudiences.map((item: any) => ({ id: item.id }));
  if (targeting.deviceTypes === "MOBILE") result.device_platforms = ["mobile"];
  if (targeting.deviceTypes === "DESKTOP") result.device_platforms = ["desktop"];
  return result;
}

export async function publishCampaign(input: any, connection?: { accessToken: string; adAccountId: string; pageId?: string }) {
  if (!connection) throw new Error("A Meta connection is required");
  const campaign = input.facebookCampaignId
    ? { id: input.facebookCampaignId, step: "campaign", reused: true }
    : await request(`act_${connection.adAccountId}/campaigns`, connection.accessToken, {
      name: input.name,
      objective: safePublishObjective(input.objective),
      status: "PAUSED",
      special_ad_categories: input.specialAdCategory && input.specialAdCategory !== "NONE" ? [input.specialAdCategory] : [],
    }) as MetaResult;
  const adSets: MetaResult[] = [];
  const creatives: MetaResult[] = [];
  const ads: MetaResult[] = [];
  for (const adSet of input.adSets) {
    const adSetBody: any = {
      name: adSet.name,
      campaign_id: campaign.id,
      targeting: metaTargeting(adSet.targeting),
      optimization_goal: safeOptimizationGoal(input.objective, adSet.optimizationGoal),
      billing_event: adSet.billingEvent,
      bid_strategy: safeBidStrategy(adSet.bidStrategy),
      status: "PAUSED",
      start_time: input.startDate,
      ...(input.endDate ? { end_time: input.endDate } : {}),
      ...(input.dailyBudget ? { daily_budget: Math.round(Number(input.dailyBudget) * 100) } : {}),
      ...(input.lifetimeBudget ? { lifetime_budget: Math.round(Number(input.lifetimeBudget) * 100) } : {}),
      ...(adSet.bidAmount ? { bid_amount: Math.round(Number(adSet.bidAmount) * 100) } : {}),
    };
    const created = adSet.facebookAdSetId
      ? { id: adSet.facebookAdSetId, reused: true }
      : await request(`act_${connection.adAccountId}/adsets`, connection.accessToken, { ...adSetBody });
    adSets.push({ ...created, step: "adset", localId: adSet.id });
    for (const ad of adSet.ads || []) {
      if (ad.facebookAdId) {
        ads.push({ id: ad.facebookAdId, step: "ad", localId: ad.id, reused: true });
        continue;
      }
      if (ad.format === "COLLECTION") throw Object.assign(new Error("Collection ads require a Meta catalog and are not available until a catalog ID is configured."), { step: "adcreative" });
      const uploaded: Array<{ id: string; kind: "image" | "video"; creative: any }> = [];
      for (const creative of ad.creatives || []) {
        if (creative.metaAssetId) {
          uploaded.push({ id: creative.metaAssetId, kind: creative.type === "VIDEO" ? "video" : "image", creative });
          creatives.push({ id: creative.metaAssetId, step: "creative", localId: creative.id, reused: true });
          continue;
        }
        if (creative.type === "VIDEO") {
          const data = await uploadAsset(`act_${connection.adAccountId}/advideos`, connection.accessToken, creative);
          uploaded.push({ id: data.id, kind: "video", creative });
          creatives.push({ id: data.id, step: "creative", localId: creative.id });
        } else {
          const data = await uploadAsset(`act_${connection.adAccountId}/adimages`, connection.accessToken, creative);
          const image = Object.values(data.images || {})[0] as any;
          if (!image?.hash) throw Object.assign(new Error("Meta did not return an image hash"), { step: "creative_upload" });
          uploaded.push({ id: image.hash, kind: "image", creative });
          creatives.push({ id: image.hash, step: "creative", localId: creative.id });
        }
      }
      if (!uploaded.length) throw Object.assign(new Error(`Ad "${ad.name}" needs at least one uploaded creative before real publishing.`), { step: "creative_validation" });
      const linkData: any = {
        link: ad.destinationUrl,
        message: ad.primaryText,
        name: ad.headline,
        description: ad.description || undefined,
        call_to_action: { type: ad.callToAction, value: { link: ad.destinationUrl } },
      };
      let story: any;
      if (ad.format === "VIDEO") {
        const video = uploaded.find(item => item.kind === "video");
        if (!video) throw Object.assign(new Error(`Ad "${ad.name}" needs an MP4 creative.`), { step: "creative_validation" });
        story = { page_id: ad.pageId || connection.pageId, video_data: { ...linkData, video_id: video.id, title: ad.headline } };
      } else if (ad.format === "CAROUSEL") {
        if (uploaded.length < 2) throw Object.assign(new Error(`Carousel ad "${ad.name}" needs at least two images.`), { step: "creative_validation" });
        story = { page_id: ad.pageId || connection.pageId, link_data: { ...linkData, child_attachments: uploaded.map(item => ({ link: ad.destinationUrl, image_hash: item.id, name: ad.headline, description: ad.description || undefined })) } };
      } else {
        story = { page_id: ad.pageId || connection.pageId, link_data: { ...linkData, image_hash: uploaded[0].id } };
      }
      const adCreative = await request(`act_${connection.adAccountId}/adcreatives`, connection.accessToken, { name: `${ad.name} Creative`, object_story_spec: story });
      const createdAd = await request(`act_${connection.adAccountId}/ads`, connection.accessToken, { name: ad.name, adset_id: created.id, creative: { creative_id: adCreative.id }, status: "PAUSED" });
      ads.push({ id: createdAd.id, step: "ad", localId: ad.id });
    }
  }
  return { campaign: { ...campaign, step: "campaign", localId: input.id }, adSets, creatives, ads };
}

export function metaOAuthUrl(state: string) {
  const appId = process.env.META_APP_ID?.trim();
  const redirectUri = process.env.META_REDIRECT_URI?.trim();
  if (!appId || !/^\d{5,}$/.test(appId)) throw new Error("META_APP_ID is missing or invalid. Add the numeric App ID from Meta for Developers to your .env file.");
  if (!process.env.META_APP_SECRET?.trim()) throw new Error("META_APP_SECRET is missing. Add the App Secret from Meta for Developers to your .env file.");
  if (!redirectUri) throw new Error("META_REDIRECT_URI is missing.");
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri,
    state,
    scope: metaOAuthScopes().join(","),
    response_type: "code",
  });
  return `https://www.facebook.com/${API_VERSION}/dialog/oauth?${params}`;
}

export function metaConfigStatus() {
  const appId = process.env.META_APP_ID?.trim() || "";
  const appSecret = process.env.META_APP_SECRET?.trim() || "";
  const redirectUri = process.env.META_REDIRECT_URI?.trim() || "";
  return {
    ready: /^\d{5,}$/.test(appId) && !!appSecret && !!redirectUri,
    appIdConfigured: /^\d{5,}$/.test(appId),
    appSecretConfigured: !!appSecret,
    redirectUri,
    apiVersion: API_VERSION,
    scopes: metaOAuthScopes(),
  };
}
