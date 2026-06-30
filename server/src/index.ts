import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { requireAuth, type AuthedRequest } from "./middleware/auth.js";
import { API_VERSION, graphGet, graphList, listAccessibleAdAccounts, metaConfigStatus, metaOAuthUrl, publishCampaign } from "./services/metaApi.js";
import { aiStatus, analyseAd, creativeBrief, goalIntake, reviewCampaign, suggest, updateAiBudget } from "./services/aiSuggestions.js";
import { deleteStoredFile, fileRecord, upload } from "./services/storage.js";

const prisma = new PrismaClient();
const app = express();
const idParam = (value: string | string[]) => Array.isArray(value) ? value[0] : value;
const META_CACHE_TTL_MS = 5 * 60 * 1000;
const publishingEnabled = () => String(process.env.PUBLISHING_ENABLED || "false").toLowerCase() === "true";
const metaCache = new Map<string, { expiresAt: number; value: unknown }>();
const metaCacheGet = <T>(key: string) => {
  const cached = metaCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    metaCache.delete(key);
    return null;
  }
  return cached.value as T;
};
const metaCacheSet = (key: string, value: unknown, ttl = META_CACHE_TTL_MS) => {
  metaCache.set(key, { value, expiresAt: Date.now() + ttl });
  return value;
};
const isMetaRateLimit = (error: any) => [4, 17, 32, 613].includes(Number(error?.code)) || String(error?.message || "").toLowerCase().includes("request limit");
const metaErrorPayload = (error: any) => isMetaRateLimit(error)
  ? { message: "Facebook is temporarily rate limiting this connection. Wait a few minutes, then refresh. We have reduced dashboard requests and cached reads to avoid this happening as often.", code: error.code, rateLimited: true }
  : { message: error.message, code: error.code, reconnectRequired: [102,190].includes(error.code) };
const tokenKey = crypto.createHash("sha256").update(process.env.TOKEN_ENCRYPTION_KEY || process.env.JWT_SECRET || "development-secret").digest();
const encryptToken = (value: string) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", tokenKey, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `enc:v1:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${encrypted.toString("base64url")}`;
};
const decryptToken = (value: string) => {
  if (!value.startsWith("enc:v1:")) return value;
  const [, , iv, tag, encrypted] = value.split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", tokenKey, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
};
app.use(cors({ origin: process.env.CLIENT_URL || "http://localhost:5173", credentials: true }));
app.use(express.json({ limit: "10mb" }));
app.use(cookieParser());
app.use("/uploads", express.static(process.env.LOCAL_UPLOAD_PATH || path.resolve("uploads")));

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "orbit-api" }));

app.post("/api/auth/login", async (req, res) => {
  const user = await prisma.user.findUnique({ where: { email: req.body.email } });
  if (!user || !await bcrypt.compare(req.body.password, user.passwordHash)) return res.status(401).json({ message: "Invalid email or password" });
  const token = jwt.sign({ sub: user.id }, process.env.JWT_SECRET || "development-secret", { expiresIn: "7d" });
  res.cookie("orbit_token", token, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 604_800_000 });
  res.json({ user: { id: user.id, email: user.email, name: user.name } });
});
app.post("/api/auth/logout", (_req, res) => { res.clearCookie("orbit_token"); res.status(204).end(); });
app.get("/api/auth/me", requireAuth, async (req: AuthedRequest, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.userId }, select: { id: true, name: true, email: true, defaultCurrency: true, timezone: true, createdAt: true, metaConnection: { select: { adAccountId: true, pageId: true, connectedAt: true, expiresAt: true } } } });
  res.json(user);
});
app.put("/api/auth/profile", requireAuth, async (req: AuthedRequest, res) => {
  const { name, email, defaultCurrency, timezone, currentPassword, newPassword } = req.body;
  const user = await prisma.user.findUnique({ where: { id: req.userId } });
  if (!user) return res.status(404).json({ message: "User not found" });
  const data: any = {};
  if (name?.trim()) data.name = name.trim();
  if (email?.trim()) data.email = email.trim().toLowerCase();
  if (defaultCurrency) data.defaultCurrency = defaultCurrency;
  if (timezone) data.timezone = timezone;
  if (newPassword) {
    if (!currentPassword || !await bcrypt.compare(currentPassword, user.passwordHash)) return res.status(422).json({ message: "Current password is incorrect" });
    if (String(newPassword).length < 8) return res.status(422).json({ message: "New password must be at least 8 characters" });
    data.passwordHash = await bcrypt.hash(newPassword, 12);
  }
  const updated = await prisma.user.update({ where: { id: user.id }, data, select: { id: true, name: true, email: true, defaultCurrency: true, timezone: true } });
  res.json(updated);
});

app.get("/api/ai/status", requireAuth, async (_req: AuthedRequest, res) => {
  res.json(await aiStatus(prisma));
});
app.put("/api/ai/settings", requireAuth, async (req: AuthedRequest, res) => {
  try {
    res.json(await updateAiBudget(prisma, Number(req.body.monthlyTokenBudget)));
  } catch (error: any) {
    res.status(error.status || 500).json({ message: error.message });
  }
});
app.post("/api/ai/suggest", requireAuth, async (req: AuthedRequest, res) => {
  const allowed = ["primaryText","headline","description","cta","targeting","interests","placements","campaignName","adSetName","bidStrategy","creativeIdeas","destinationUrl","objective","budget","country","gender","ageRange","devices","optimizationGoal","adName","format","specialAdCategory"];
  if (!allowed.includes(req.body.requestFor)) return res.status(422).json({ message: "Unsupported AI suggestion field" });
  try {
    const result = await suggest(prisma, req.userId!, req.body);
    res.json({ ...(result.data as object), cached: result.cached });
  } catch (error: any) {
    res.status(error.status || 500).json({ message: error.message, code: error.code });
  }
});
app.post("/api/ai/creative-brief", requireAuth, async (req: AuthedRequest, res) => {
  try {
    const result = await creativeBrief(prisma, req.userId!, req.body);
    res.json({ ...(result.data as object), cached: result.cached });
  } catch (error: any) {
    res.status(error.status || 500).json({ message: error.message, code: error.code });
  }
});
app.post("/api/ai/review-campaign", requireAuth, async (req: AuthedRequest, res) => {
  try {
    const result = await reviewCampaign(prisma, req.userId!, req.body);
    res.json({ ...(result.data as object), cached: result.cached });
  } catch (error: any) {
    res.status(error.status || 500).json({ message: error.message, code: error.code });
  }
});
app.post("/api/ai/goal-intake", requireAuth, async (req: AuthedRequest, res) => {
  try {
    const result = await goalIntake(prisma, req.userId!, req.body);
    res.json({ ...(result.data as object), cached: result.cached });
  } catch (error: any) {
    res.status(error.status || 500).json({ message: error.message, code: error.code });
  }
});
app.post("/api/ai/analyse-ad", requireAuth, async (req: AuthedRequest, res) => {
  if (!["goal", "audience", "ad"].includes(req.body.level)) return res.status(422).json({ message: "Choose whether to improve the goal, audience, or ad" });
  try {
    const result = await analyseAd(prisma, req.userId!, req.body);
    res.json({ ...(result.data as object), cached: result.cached });
  } catch (error: any) {
    res.status(error.status || 500).json({ message: error.message, code: error.code });
  }
});

app.get("/api/campaigns", requireAuth, async (req: AuthedRequest, res) => {
  const { status, search, from, to } = req.query;
  const rows = await prisma.campaign.findMany({
    where: {
      createdById: req.userId,
      ...(status ? { status: status as any } : {}),
      ...(search ? { name: { contains: String(search), mode: "insensitive" } } : {}),
      ...(from || to ? { startDate: { ...(from ? { gte: new Date(String(from)) } : {}), ...(to ? { lte: new Date(String(to)) } : {}) } } : {}),
    },
    include: { _count: { select: { adSets: true } }, adSets: { select: { _count: { select: { ads: true } } } } },
    orderBy: { updatedAt: "desc" },
  });
  res.json(rows);
});
app.post("/api/campaigns", requireAuth, async (req: AuthedRequest, res) => {
  const { adSets = [], ...campaign } = req.body;
  const created = await prisma.campaign.create({
    data: {
      ...campaign, createdById: req.userId!,
      startDate: new Date(campaign.startDate),
      endDate: campaign.endDate ? new Date(campaign.endDate) : null,
      adSets: { create: adSets.map(({ ads = [], ...adSet }: any) => ({ ...adSet, ads: { create: ads.map(({ creatives = [], ...ad }: any) => ({ ...ad, creatives: { create: creatives } })) } })) },
    },
    include: { adSets: { include: { ads: { include: { creatives: true } } } } },
  });
  res.status(201).json(created);
});
app.get("/api/campaigns/:id", requireAuth, async (req: AuthedRequest, res) => {
  const row = await prisma.campaign.findFirst({ where: { id: idParam(req.params.id), createdById: req.userId }, include: { adSets: { include: { ads: { include: { creatives: true } } } }, createdBy: { select: { id: true, name: true, email: true } } } });
  row ? res.json(row) : res.status(404).json({ message: "Campaign not found" });
});
app.put("/api/campaigns/:id", requireAuth, async (req: AuthedRequest, res) => {
  const campaignId = idParam(req.params.id);
  const owned = await prisma.campaign.findFirst({ where: { id: campaignId, createdById: req.userId } });
  if (!owned) return res.status(404).json({ message: "Campaign not found" });
  const { adSets, ...input } = req.body;
  const allowed = ["name","objective","goalLabel","businessDescription","websiteUrl","brandName","parentCampaignId","relaunchReason","aiGenerated","status","dailyBudget","lifetimeBudget","currency","startDate","endDate","specialAdCategory"];
  const data: any = Object.fromEntries(Object.entries(input).filter(([key]) => allowed.includes(key)));
  if (data.startDate) data.startDate = new Date(data.startDate as string);
  if ("endDate" in data) data.endDate = data.endDate ? new Date(data.endDate as string) : null;
  const updated = await prisma.$transaction(async tx => {
    if (Array.isArray(adSets)) {
      const keepSetIds = adSets.map((item: any) => item.id).filter(Boolean);
      await tx.adSet.deleteMany({ where: { campaignId, ...(keepSetIds.length ? { id: { notIn: keepSetIds } } : {}) } });
      for (const inputSet of adSets) {
        const { ads = [], id: inputSetId, campaignId: _campaignId, createdAt: _createdAt, updatedAt: _updatedAt, _count: _setCount, ...setData } = inputSet;
        const savedSet = inputSetId
          ? await tx.adSet.update({ where: { id: inputSetId }, data: setData })
          : await tx.adSet.create({ data: { ...setData, campaignId } });
        const keepAdIds = ads.map((item: any) => item.id).filter(Boolean);
        await tx.ad.deleteMany({ where: { adSetId: savedSet.id, ...(keepAdIds.length ? { id: { notIn: keepAdIds } } : {}) } });
        for (const inputAd of ads) {
          const { creatives = [], id: inputAdId, adSetId: _adSetId, createdAt: _adCreatedAt, updatedAt: _adUpdatedAt, ...adData } = inputAd;
          const savedAd = inputAdId
            ? await tx.ad.update({ where: { id: inputAdId }, data: adData })
            : await tx.ad.create({ data: { ...adData, adSetId: savedSet.id } });
          const usableCreatives = creatives.filter((creative: any) => creative.fileUrl);
          const keepCreativeIds = usableCreatives.map((item: any) => item.id).filter(Boolean);
          await tx.creative.deleteMany({ where: { adId: savedAd.id, ...(keepCreativeIds.length ? { id: { notIn: keepCreativeIds } } : {}) } });
          for (const inputCreative of usableCreatives) {
            const { id: creativeId, adId: _creativeAdId, uploadedAt: _uploadedAt, ad: _creativeAd, ...creativeData } = inputCreative;
            if (creativeId) await tx.creative.update({ where: { id: creativeId }, data: creativeData });
            else await tx.creative.create({ data: { ...creativeData, adId: savedAd.id } });
          }
        }
      }
    }
    return tx.campaign.update({ where: { id: campaignId }, data, include: { adSets: { include: { ads: { include: { creatives: true } } } } } });
  });
  res.json(updated);
});
app.delete("/api/campaigns/:id", requireAuth, async (req: AuthedRequest, res) => {
  const result = await prisma.campaign.deleteMany({ where: { id: idParam(req.params.id), createdById: req.userId } });
  if (!result.count) return res.status(404).json({ message: "Campaign not found" });
  res.status(204).end();
});
app.patch("/api/campaigns/:id/status", requireAuth, async (req: AuthedRequest, res) => {
  const allowed = ["DRAFT","READY","PUBLISHED","PAUSED","ARCHIVED"];
  if (!allowed.includes(req.body.status)) return res.status(422).json({ message: "Invalid campaign status" });
  const owned = await prisma.campaign.findFirst({ where: { id: idParam(req.params.id), createdById: req.userId } });
  if (!owned) return res.status(404).json({ message: "Campaign not found" });
  res.json(await prisma.campaign.update({ where: { id: owned.id }, data: { status: req.body.status } }));
});
app.post("/api/campaigns/:id/publish", requireAuth, async (req: AuthedRequest, res) => {
  if (!publishingEnabled()) return res.status(403).json({ message: "Publishing is disabled on this server. Set PUBLISHING_ENABLED=true only when you are ready to create PAUSED Meta ads." });
  const campaign = await prisma.campaign.findFirst({
    where: { id: idParam(req.params.id), createdById: req.userId },
    include: { adSets: { include: { ads: { include: { creatives: true } } } } },
  });
  if (!campaign) return res.status(404).json({ message: "Campaign not found" });
  const connection = await prisma.metaConnection.findUnique({ where: { userId: req.userId } });
  if (!connection) return res.status(422).json({ message: "Connect Meta before publishing." });
  if (!connection.adAccountId) return res.status(422).json({ message: "Choose a Meta ad account before publishing." });
  if (!connection.pageId && campaign.adSets.some(adSet => adSet.ads.some(ad => !ad.pageId))) return res.status(422).json({ message: "Choose a default Facebook Page in Meta connection, or set a Page on every ad." });
  if (!campaign.adSets.length) return res.status(422).json({ message: "Add at least one audience/ad set before publishing." });
  const ads = campaign.adSets.flatMap(adSet => adSet.ads);
  if (!ads.length) return res.status(422).json({ message: "Add at least one ad before publishing." });
  const missingCreative = ads.find(ad => !ad.facebookAdId && !ad.creatives.length);
  if (missingCreative) return res.status(422).json({ message: `Ad "${missingCreative.name}" needs an uploaded creative before publishing.` });
  try {
    const result = await publishCampaign(campaign, {
      accessToken: decryptToken(connection.accessToken),
      adAccountId: connection.adAccountId,
      pageId: connection.pageId || undefined,
    });
    const updated = await prisma.$transaction(async tx => {
      await tx.campaign.update({
        where: { id: campaign.id },
        data: { facebookCampaignId: result.campaign.id, status: "PAUSED", publishState: { ...result, mode: "PAUSED", publishedAt: new Date().toISOString() } },
      });
      for (const adSet of result.adSets) if (adSet.localId) await tx.adSet.update({ where: { id: adSet.localId }, data: { facebookAdSetId: adSet.id, status: "PAUSED" } });
      for (const ad of result.ads) if (ad.localId) await tx.ad.update({ where: { id: ad.localId }, data: { facebookAdId: ad.id, status: "PAUSED" } });
      for (const creative of result.creatives) if (creative.localId) await tx.creative.update({ where: { id: creative.localId }, data: { metaAssetId: creative.id } });
      return tx.campaign.findUnique({ where: { id: campaign.id }, include: { adSets: { include: { ads: { include: { creatives: true } } } }, createdBy: { select: { id: true, name: true, email: true } } } });
    });
    metaCache.clear();
    res.json({ campaign: updated, publish: { ...result, mode: "PAUSED" } });
  } catch (error: any) {
    res.status(502).json({ message: error.message || "Meta publishing failed", step: error.step, code: error.code, meta: error.details });
  }
});
app.get("/api/campaigns/:id/stats", requireAuth, async (req: AuthedRequest, res) => {
  const campaign = await prisma.campaign.findFirst({ where: { id: idParam(req.params.id), createdById: req.userId } });
  if (!campaign) return res.status(404).json({ message: "Campaign not found" });
  if (!campaign.facebookCampaignId) return res.status(422).json({ message: "This local campaign is not linked to a Meta campaign." });
  const connection = await prisma.metaConnection.findUnique({ where: { userId: req.userId } });
  if (!connection) return res.status(422).json({ message: "Meta is not connected" });
  const params = new URLSearchParams({
    fields: "impressions,reach,clicks,ctr,spend,cpm,cpc,purchase_roas",
    date_preset: String(req.query.range || "last_7d"),
    time_increment: "1",
    access_token: decryptToken(connection.accessToken),
  });
  const response = await fetch(`https://graph.facebook.com/${API_VERSION}/${campaign.facebookCampaignId}/insights?${params}`);
  const result = await response.json() as any;
  if (!response.ok) return res.status(502).json({ message: result.error?.message || "Unable to fetch Meta insights", reconnectRequired: [102,190].includes(result.error?.code) });
  const series = result.data || [];
  const sum = (key: string) => series.reduce((total: number, row: any) => total + Number(row[key] || 0), 0);
  const impressions = sum("impressions");
  const clicks = sum("clicks");
  const spend = sum("spend");
  res.json({
    impressions, reach: sum("reach"), clicks, spend,
    ctr: impressions ? clicks / impressions * 100 : 0,
    cpm: impressions ? spend / impressions * 1000 : 0,
    cpc: clicks ? spend / clicks : 0,
    roas: Number(series.at(-1)?.purchase_roas?.[0]?.value || 0),
    series: series.map((row: any) => ({ date: row.date_start, spend: Number(row.spend || 0), reach: Number(row.reach || 0) })),
  });
});
app.get("/api/meta/status", requireAuth, async (req: AuthedRequest, res) => {
  const connection = await prisma.metaConnection.findUnique({
    where: { userId: req.userId },
    select: { adAccountId: true, pageId: true, connectedAt: true, expiresAt: true },
  });
  res.json({ connected: !!connection, publishingEnabled: publishingEnabled(), config: metaConfigStatus(), connection });
});

app.post("/api/campaigns/:id/adsets", requireAuth, async (req, res) => res.status(201).json(await prisma.adSet.create({ data: { ...req.body, campaignId: idParam(req.params.id) } })));
app.put("/api/adsets/:id", requireAuth, async (req, res) => res.json(await prisma.adSet.update({ where: { id: idParam(req.params.id) }, data: req.body })));
app.delete("/api/adsets/:id", requireAuth, async (req, res) => { await prisma.adSet.delete({ where: { id: idParam(req.params.id) } }); res.status(204).end(); });
app.post("/api/adsets/:id/ads", requireAuth, async (req, res) => res.status(201).json(await prisma.ad.create({ data: { ...req.body, adSetId: idParam(req.params.id) } })));
app.get("/api/ads", requireAuth, async (req: AuthedRequest, res) => {
  res.json(await prisma.ad.findMany({
    where: { adSet: { campaign: { createdById: req.userId } } },
    select: { id: true, name: true, adSet: { select: { campaign: { select: { id: true, name: true } } } } },
    orderBy: { updatedAt: "desc" },
  }));
});
app.put("/api/ads/:id", requireAuth, async (req, res) => res.json(await prisma.ad.update({ where: { id: idParam(req.params.id) }, data: req.body })));
app.delete("/api/ads/:id", requireAuth, async (req, res) => { await prisma.ad.delete({ where: { id: idParam(req.params.id) } }); res.status(204).end(); });

app.post("/api/creatives/upload", requireAuth, upload.single("file"), async (req, res) => {
  if (!req.file || !req.body.adId) return res.status(422).json({ message: "A file and adId are required" });
  const record = fileRecord(req.file);
  if (record.type === "IMAGE" && req.file.size > 30 * 1024 * 1024) return res.status(422).json({ message: "Images must be no larger than 30MB" });
  res.status(201).json(await prisma.creative.create({ data: { ...record, type: record.type as any, adId: req.body.adId, position: Number(req.body.position || 0) } }));
});
app.get("/api/creatives", requireAuth, async (req: AuthedRequest, res) => {
  res.json(await prisma.creative.findMany({ where: { ad: { adSet: { campaign: { createdById: req.userId } } } }, include: { ad: { select: { id: true, name: true, adSet: { select: { campaign: { select: { id: true, name: true } } } } } } }, orderBy: { uploadedAt: "desc" } }));
});
app.delete("/api/creatives/:id", requireAuth, async (req: AuthedRequest, res) => {
  const creative = await prisma.creative.findFirst({ where: { id: idParam(req.params.id), ad: { adSet: { campaign: { createdById: req.userId } } } } });
  if (!creative) return res.status(404).json({ message: "Creative not found" });
  await prisma.creative.delete({ where: { id: creative.id } });
  deleteStoredFile(creative.fileUrl);
  res.status(204).end();
});

app.get("/api/meta/connect", requireAuth, (req: AuthedRequest, res) => {
  try {
    const state = jwt.sign({ sub: req.userId, nonce: crypto.randomUUID() }, process.env.JWT_SECRET || "development-secret", { expiresIn: "10m" });
    res.redirect(metaOAuthUrl(state));
  } catch (error: any) {
    res.redirect(`${process.env.CLIENT_URL || "http://localhost:5173"}/settings/meta-connection?error=${encodeURIComponent(error.message)}`);
  }
});
app.get("/api/meta/callback", async (req, res) => {
  if (!req.query.code || !req.query.state) return res.status(400).send("Missing OAuth code or state");
  try {
    const payload = jwt.verify(String(req.query.state), process.env.JWT_SECRET || "development-secret") as { sub: string };
    const params = new URLSearchParams({
      client_id: process.env.META_APP_ID || "",
      client_secret: process.env.META_APP_SECRET || "",
      redirect_uri: process.env.META_REDIRECT_URI || "",
      code: String(req.query.code),
    });
    const tokenResponse = await fetch(`https://graph.facebook.com/${API_VERSION}/oauth/access_token?${params}`);
    const tokenData = await tokenResponse.json() as { access_token?: string; expires_in?: number; error?: { message: string } };
    if (!tokenResponse.ok || !tokenData.access_token) throw new Error(tokenData.error?.message || "Meta token exchange failed");
    const [accountResult, pages] = await Promise.all([
      listAccessibleAdAccounts(tokenData.access_token),
      graphList("me/accounts", tokenData.access_token, { fields: "id,name", limit: "100" }),
    ]);
    const accounts = accountResult.accounts;
    const account = accounts[0];
    const page = pages[0];
    if (!account) throw new Error("No eligible Meta ad account was found for this Facebook user.");
    await prisma.metaConnection.upsert({
      where: { userId: payload.sub },
      update: {
        accessToken: encryptToken(tokenData.access_token),
        adAccountId: String(account.id).replace("act_", ""),
        pageId: page?.id || "",
        connectedAt: new Date(),
        expiresAt: new Date(Date.now() + (tokenData.expires_in || 5_184_000) * 1000),
      },
      create: {
        userId: payload.sub,
        accessToken: encryptToken(tokenData.access_token),
        adAccountId: String(account.id).replace("act_", ""),
        pageId: page?.id || "",
        expiresAt: new Date(Date.now() + (tokenData.expires_in || 5_184_000) * 1000),
      },
    });
    res.redirect(`${process.env.CLIENT_URL || "http://localhost:5173"}/settings/meta-connection?connected=1`);
  } catch (error: any) {
    res.redirect(`${process.env.CLIENT_URL || "http://localhost:5173"}/settings/meta-connection?error=${encodeURIComponent(error.message)}`);
  }
});
app.delete("/api/meta/disconnect", requireAuth, async (req: AuthedRequest, res) => { await prisma.metaConnection.deleteMany({ where: { userId: req.userId } }); res.status(204).end(); });
app.put("/api/meta/defaults", requireAuth, async (req: AuthedRequest, res) => {
  const { adAccountId, pageId } = req.body;
  if (!adAccountId) return res.status(422).json({ message: "Choose an ad account" });
  const connection = await prisma.metaConnection.findUnique({ where: { userId: req.userId } });
  if (!connection) return res.status(404).json({ message: "Meta is not connected" });
  res.json(await prisma.metaConnection.update({
    where: { userId: req.userId },
    data: { adAccountId: String(adAccountId).replace("act_", ""), pageId: String(pageId || "") },
    select: { adAccountId: true, pageId: true, connectedAt: true, expiresAt: true },
  }));
});
app.get("/api/meta/ad-accounts", requireAuth, async (req: AuthedRequest, res) => {
  const connection = await prisma.metaConnection.findUnique({ where: { userId: req.userId } });
  if (!connection) return res.json([]);
  const cacheKey = `meta:accounts:${req.userId}:${connection.connectedAt.getTime()}`;
  const cached = metaCacheGet(cacheKey);
  if (cached) return res.json(cached);
  try {
    const data = await listAccessibleAdAccounts(decryptToken(connection.accessToken));
    res.json(metaCacheSet(cacheKey, data, 10 * 60 * 1000));
  } catch (error: any) {
    res.status(isMetaRateLimit(error) ? 429 : 502).json(metaErrorPayload(error));
  }
});
app.get("/api/meta/pages", requireAuth, async (req: AuthedRequest, res) => {
  const connection = await prisma.metaConnection.findUnique({ where: { userId: req.userId } });
  if (!connection) return res.json([]);
  try {
    res.json(await graphList("me/accounts", decryptToken(connection.accessToken), { fields: "id,name,picture", limit: "100" }));
  } catch (error: any) {
    res.status(502).json({ message: error.message, reconnectRequired: [102,190].includes(error.code) });
  }
});
app.get("/api/meta/campaigns", requireAuth, async (req: AuthedRequest, res) => {
  const connection = await prisma.metaConnection.findUnique({ where: { userId: req.userId } });
  if (!connection) return res.status(422).json({ message: "Connect Meta before loading campaigns" });
  const requested = String(req.query.adAccountId || connection.adAccountId).replace("act_", "");
  const accessToken = decryptToken(connection.accessToken);
  const range = String(req.query.range || "last_7d");
  const includeInsights = req.query.includeInsights === "1";
  const cacheKey = `meta:campaigns:${req.userId}:${requested}:${range}:${includeInsights}`;
  const cached = metaCacheGet(cacheKey);
  if (cached) return res.json(cached);
  try {
    const rows = await graphList(`act_${requested}/campaigns`, accessToken, {
      fields: "id,name,objective,status,effective_status,daily_budget,lifetime_budget,budget_remaining,buying_type,start_time,stop_time,created_time,updated_time,special_ad_categories",
      limit: "100",
    });
    if (!includeInsights) return res.json(metaCacheSet(cacheKey, rows));
    let insightByCampaign = new Map<string, any>();
    let insightError: string | null = null;
    try {
      const insightRows = await graphList(`act_${requested}/insights`, accessToken, {
        fields: "campaign_id,campaign_name,impressions,reach,clicks,inline_link_clicks,ctr,spend,cpm,cpc,frequency,actions,unique_actions,action_values,cost_per_action_type",
        date_preset: range,
        level: "campaign",
        limit: "500",
      });
      insightByCampaign = new Map(insightRows.map((item: any) => [String(item.campaign_id), item]));
    } catch (error: any) {
      if (!isMetaRateLimit(error)) throw error;
      insightError = metaErrorPayload(error).message;
    }
    const enriched = rows.map((row: any) => ({ ...row, insights: insightByCampaign.has(String(row.id)) ? [insightByCampaign.get(String(row.id))] : [], ...(insightError ? { insightError } : {}) }));
    res.json(metaCacheSet(cacheKey, enriched));
  } catch (error: any) {
    res.status(isMetaRateLimit(error) ? 429 : 502).json(metaErrorPayload(error));
  }
});
app.get("/api/meta/campaigns/:id/detail", requireAuth, async (req: AuthedRequest, res) => {
  const connection = await prisma.metaConnection.findUnique({ where: { userId: req.userId } });
  if (!connection) return res.status(422).json({ message: "Connect Meta before loading campaign details" });
  const requested = String(req.query.adAccountId || connection.adAccountId).replace("act_", "");
  const campaignId = idParam(req.params.id);
  const accessToken = decryptToken(connection.accessToken);
  const range = String(req.query.range || "last_7d");
  const cacheKey = `meta:campaign-detail:${req.userId}:${requested}:${campaignId}:${range}`;
  const cached = metaCacheGet(cacheKey);
  if (cached) return res.json(cached);
  try {
    const [account, campaign, adSets, ads, insights, adInsights] = await Promise.all([
      graphGet(`act_${requested}`, accessToken, {
        fields: "id,name,currency,account_status,timezone_name",
      }),
      graphGet(campaignId, accessToken, {
        fields: "id,account_id,name,objective,status,effective_status,daily_budget,lifetime_budget,budget_remaining,buying_type,start_time,stop_time,created_time,updated_time,special_ad_categories",
      }),
      graphList(`${campaignId}/adsets`, accessToken, {
        fields: "id,name,status,effective_status,daily_budget,lifetime_budget,bid_amount,bid_strategy,optimization_goal,billing_event,start_time,end_time,targeting,created_time,updated_time",
        limit: "100",
      }),
      graphList(`${campaignId}/ads`, accessToken, {
        fields: "id,name,status,effective_status,adset_id,created_time,updated_time,creative{id,name,thumbnail_url,image_url,object_type}",
        limit: "100",
      }),
      graphList(`${campaignId}/insights`, accessToken, {
        fields: "date_start,date_stop,impressions,reach,clicks,inline_link_clicks,ctr,spend,cpm,cpc,frequency,actions,unique_actions,action_values,cost_per_action_type",
        date_preset: range,
        time_increment: "1",
        level: "campaign",
        limit: "100",
      }),
      graphList(`${campaignId}/insights`, accessToken, {
        fields: "ad_id,ad_name,adset_id,adset_name,impressions,reach,clicks,inline_link_clicks,ctr,spend,cpm,cpc,frequency,actions,unique_actions,action_values,cost_per_action_type,video_play_actions,video_p25_watched_actions,video_p50_watched_actions,video_p75_watched_actions,video_p95_watched_actions,video_p100_watched_actions",
        date_preset: range,
        level: "ad",
        limit: "500",
      }),
    ]);

    if (String(campaign.account_id).replace("act_", "") !== requested) {
      return res.status(403).json({ message: "This campaign does not belong to the selected Meta ad account" });
    }
    res.json(metaCacheSet(cacheKey, { account, campaign, adSets, ads, insights, adInsights }));
  } catch (error: any) {
    res.status(isMetaRateLimit(error) ? 429 : 502).json(metaErrorPayload(error));
  }
});
app.get("/api/meta/account-insights", requireAuth, async (req: AuthedRequest, res) => {
  const connection = await prisma.metaConnection.findUnique({ where: { userId: req.userId } });
  if (!connection) return res.status(422).json({ message: "Connect Meta before loading insights" });
  const requested = String(req.query.adAccountId || connection.adAccountId).replace("act_", "");
  try {
    const rows = await graphList(`act_${requested}/insights`, decryptToken(connection.accessToken), {
      fields: "spend,reach,impressions,clicks,ctr,cpm,cpc",
      date_preset: String(req.query.range || "last_7d"),
      level: "account",
      time_increment: "1",
      limit: "100",
    });
    res.json(rows);
  } catch (error: any) {
    res.status(502).json({ message: error.message, reconnectRequired: [102,190].includes(error.code) });
  }
});

if (process.env.NODE_ENV === "production") {
  const clientDist = [
    process.env.CLIENT_DIST_PATH,
    path.resolve("client/dist"),
    path.resolve("../client/dist"),
  ].filter((candidate): candidate is string => Boolean(candidate)).find(candidate => fs.existsSync(candidate));
  if (clientDist) {
    app.use(express.static(clientDist));
    app.get("*", (_req, res) => res.sendFile(path.join(clientDist, "index.html")));
  }
}

app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(error);
  res.status(error.status || 500).json({ message: error.message || "Unexpected server error" });
});

const port = Number(process.env.PORT || 4000);
app.listen(port, () => console.log(`Orbit API listening on http://localhost:${port}`));
