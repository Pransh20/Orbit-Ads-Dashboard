import crypto from "node:crypto";
import type { PrismaClient } from "@prisma/client";

const OPENAI_URL = "https://api.openai.com/v1/responses";
const MODEL = process.env.OPENAI_MODEL || "gpt-4o";
const CACHE_TTL_MS = 10 * 60 * 1000;
const SETTINGS_ID = "default";
const SYSTEM_PROMPT = "You are an expert Facebook Ads media buyer with 10+ years of experience managing high-budget campaigns across e-commerce, lead generation, and brand awareness. You give concise, specific, actionable suggestions tailored to the campaign objective and target audience. You know Meta's ad policies and best practices for copy length, creative specs, and audience targeting. Always respond in valid JSON only, no markdown.";

type CacheEntry = { expiresAt: number; value: unknown };
const cache = new Map<string, CacheEntry>();

const suggestionSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    suggestions: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          value: { type: "string" },
          reasoning: { type: "string" },
          confidence: { type: "string", enum: ["HIGH", "MEDIUM", "LOW"] },
        },
        required: ["value", "reasoning", "confidence"],
      },
    },
    tip: { type: ["string", "null"] },
  },
  required: ["suggestions", "tip"],
};

const creativeBriefSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    format: { type: "string", enum: ["SINGLE_IMAGE", "VIDEO", "CAROUSEL"] },
    formatReason: { type: "string" },
    visualConcepts: {
      type: "array",
      minItems: 3,
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          concept: { type: "string" },
          emotion: { type: "string" },
          colorSuggestion: { type: "string" },
          textOverlay: { type: ["string", "null"] },
        },
        required: ["concept", "emotion", "colorSuggestion", "textOverlay"],
      },
    },
    doList: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 6 },
    dontList: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 6 },
    specReminder: { type: "string" },
  },
  required: ["format", "formatReason", "visualConcepts", "doList", "dontList", "specReminder"],
};

const campaignReviewSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    score: { type: "integer", minimum: 0, maximum: 100 },
    verdict: { type: "string", enum: ["READY", "NEEDS_WORK", "CRITICAL_ISSUES"] },
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          field: { type: "string" },
          severity: { type: "string", enum: ["WARNING", "ERROR"] },
          message: { type: "string" },
          suggestion: { type: "string" },
        },
        required: ["field", "severity", "message", "suggestion"],
      },
    },
    strengths: { type: "array", items: { type: "string" } },
    estimatedPerformance: {
      type: "object",
      additionalProperties: false,
      properties: {
        expectedCTR: { type: "string" },
        audienceSizeEstimate: { type: "string" },
        budgetAssessment: { type: "string" },
      },
      required: ["expectedCTR", "audienceSizeEstimate", "budgetAssessment"],
    },
  },
  required: ["score", "verdict", "issues", "strengths", "estimatedPerformance"],
};

const goalIntakeSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    campaignName: { type: "string" },
    adSetName: { type: "string" },
    adName: { type: "string" },
    primaryText: { type: "string" },
    headline: { type: "string" },
    description: { type: "string" },
    callToAction: { type: "string" },
    targeting: {
      type: "object",
      additionalProperties: false,
      properties: {
        ageMin: { type: "integer" },
        ageMax: { type: "integer" },
        genders: { type: "array", items: { type: "string" } },
        locations: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: { country: { type: "string" }, city: { type: ["string", "null"] }, region: { type: ["string", "null"] } },
            required: ["country", "city", "region"],
          },
        },
        interests: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: { name: { type: "string" } },
            required: ["name"],
          },
        },
        placements: { type: "string", enum: ["AUTOMATIC", "MANUAL"] },
      },
      required: ["ageMin", "ageMax", "genders", "locations", "interests", "placements"],
    },
    dailyBudget: { type: "number" },
    currency: { type: "string" },
    objective: { type: "string" },
    reasoning: {
      type: "object",
      additionalProperties: false,
      properties: {
        targeting: { type: "string" },
        budget: { type: "string" },
        copy: { type: "string" },
      },
      required: ["targeting", "budget", "copy"],
    },
  },
  required: ["campaignName", "adSetName", "adName", "primaryText", "headline", "description", "callToAction", "targeting", "dailyBudget", "currency", "objective", "reasoning"],
};

const adAnalysisSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdict: { type: "string", enum: ["DOING_WELL", "NEEDS_WORK", "NOT_WORKING"] },
    verdictHeadline: { type: "string" },
    summary: { type: "string" },
    improvements: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          what: { type: "string" },
          why: { type: "string" },
          newValue: { type: "string" },
          field: { type: "string" },
          confidence: { type: "string", enum: ["HIGH", "MEDIUM"] },
        },
        required: ["what", "why", "newValue", "field", "confidence"],
      },
    },
    encouragement: { type: "string" },
  },
  required: ["verdict", "verdictHeadline", "summary", "improvements", "encouragement"],
};

function hashRequest(endpoint: string, body: unknown) {
  return crypto.createHash("sha256").update(`${endpoint}:${JSON.stringify(body)}`).digest("hex");
}

function sameCalendarMonth(a: Date, b: Date) {
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth();
}

async function currentSettings(prisma: PrismaClient) {
  const now = new Date();
  let settings = await prisma.aiSettings.upsert({
    where: { id: SETTINGS_ID },
    create: { id: SETTINGS_ID },
    update: {},
  });
  if (!sameCalendarMonth(settings.lastResetAt, now)) {
    settings = await prisma.aiSettings.update({
      where: { id: SETTINGS_ID },
      data: { tokensUsedThisMonth: 0, lastResetAt: now },
    });
  }
  return settings;
}

export async function aiStatus(prisma: PrismaClient) {
  const settings = await currentSettings(prisma);
  const configured = Boolean(process.env.OPENAI_API_KEY);
  const percentUsed = settings.monthlyTokenBudget > 0
    ? Math.min(100, Math.round(settings.tokensUsedThisMonth / settings.monthlyTokenBudget * 100))
    : 100;
  return {
    configured,
    enabled: configured && settings.tokensUsedThisMonth < settings.monthlyTokenBudget,
    model: MODEL,
    monthlyTokenBudget: settings.monthlyTokenBudget,
    tokensUsedThisMonth: settings.tokensUsedThisMonth,
    percentUsed,
    warning: percentUsed >= 80,
    exhausted: settings.tokensUsedThisMonth >= settings.monthlyTokenBudget,
    resetsAt: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 1)).toISOString(),
  };
}

export async function updateAiBudget(prisma: PrismaClient, monthlyTokenBudget: number) {
  if (!Number.isInteger(monthlyTokenBudget) || monthlyTokenBudget < 1) {
    throw Object.assign(new Error("Monthly AI token budget must be a positive whole number"), { status: 422 });
  }
  await currentSettings(prisma);
  await prisma.aiSettings.update({ where: { id: SETTINGS_ID }, data: { monthlyTokenBudget } });
  return aiStatus(prisma);
}

function readOutputText(data: any) {
  if (typeof data.output_text === "string") return data.output_text;
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.type === "refusal") throw new Error(content.refusal || "The AI request was refused");
      if (content.type === "output_text" && typeof content.text === "string") return content.text;
    }
  }
  throw new Error("OpenAI returned no structured output");
}

async function structuredCall(
  prisma: PrismaClient,
  userId: string,
  endpoint: string,
  body: unknown,
  schemaName: string,
  schema: Record<string, unknown>,
  task: string,
  systemPrompt = SYSTEM_PROMPT,
) {
  if (!process.env.OPENAI_API_KEY) {
    throw Object.assign(new Error("AI features are not configured"), { status: 503 });
  }
  const requestHash = hashRequest(endpoint, body);
  const cached = cache.get(requestHash);
  if (cached && cached.expiresAt > Date.now()) return { data: cached.value, cached: true };
  if (cached) cache.delete(requestHash);

  const settings = await currentSettings(prisma);
  if (settings.tokensUsedThisMonth >= settings.monthlyTokenBudget) {
    throw Object.assign(new Error("The monthly AI token budget has been reached. AI features will return next calendar month or after the budget is increased."), { status: 429, code: "AI_BUDGET_EXHAUSTED" });
  }

  const response = await fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.7,
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `${task}\n\nCampaign data:\n${JSON.stringify(body)}` },
      ],
      text: {
        format: {
          type: "json_schema",
          name: schemaName,
          strict: true,
          schema,
        },
      },
    }),
  });
  const raw = await response.json() as any;
  if (!response.ok) {
    throw Object.assign(new Error(raw?.error?.message || "OpenAI request failed"), { status: response.status === 429 ? 429 : 502 });
  }
  const parsed = JSON.parse(readOutputText(raw));
  const inputTokens = Number(raw.usage?.input_tokens || 0);
  const outputTokens = Number(raw.usage?.output_tokens || 0);
  const tokensUsed = Number(raw.usage?.total_tokens || inputTokens + outputTokens);
  const inputRate = Number(process.env.OPENAI_INPUT_COST_PER_1M || 0);
  const outputRate = Number(process.env.OPENAI_OUTPUT_COST_PER_1M || 0);
  const costUsd = inputTokens / 1_000_000 * inputRate + outputTokens / 1_000_000 * outputRate;

  await prisma.$transaction([
    prisma.aiUsageLog.create({ data: { userId, endpoint, requestHash, tokensUsed, costUsd } }),
    prisma.aiSettings.update({ where: { id: SETTINGS_ID }, data: { tokensUsedThisMonth: { increment: tokensUsed } } }),
  ]);
  cache.set(requestHash, { value: parsed, expiresAt: Date.now() + CACHE_TTL_MS });
  return { data: parsed, cached: false };
}

export function suggest(prisma: PrismaClient, userId: string, body: unknown) {
  return structuredCall(
    prisma, userId, "suggest", body, "campaign_suggestions", suggestionSchema,
    "Return exactly three directly usable suggestions for the requested field. Keep values concise. Each one-sentence reasoning must explicitly relate to the supplied campaign objective, audience, product, or current form state. For destinationUrl, return practical URL structures with UTM parameters. For interests, return comma-separated interest names. For ageRange, return a numeric range such as 25-44. For country, return a two-letter country code. For gender return ALL, MEN, or WOMEN. For objective, placements, devices, optimizationGoal, CTA, format, specialAdCategory, and bidStrategy, return valid uppercase option values used by the supplied Meta-style form. For budget, return one practical numeric amount in the campaign currency.",
  );
}

export function creativeBrief(prisma: PrismaClient, userId: string, body: unknown) {
  return structuredCall(
    prisma, userId, "creative-brief", body, "creative_brief", creativeBriefSchema,
    "Create a practical creative brief for this campaign. Return exactly three distinct visual concepts and choose the strongest format for the objective, audience, and message.",
  );
}

export function reviewCampaign(prisma: PrismaClient, userId: string, body: unknown) {
  return structuredCall(
    prisma, userId, "review-campaign", body, "campaign_review", campaignReviewSchema,
    "Audit this campaign before it is saved. Check objective alignment, audience, budget, placements, copy clarity, destination URLs, creative format, and likely Meta policy risks. Estimates must be conservative ranges and clearly treated as estimates.",
  );
}

export function goalIntake(prisma: PrismaClient, userId: string, body: unknown) {
  return structuredCall(
    prisma, userId, "goal-intake", body, "goal_intake", goalIntakeSchema,
    "Generate a complete, ready-to-publish Facebook ad setup for the chosen goal and business. Fill every field with specific realistic values. Never use placeholder text.",
    "You are an expert Facebook advertiser generating a complete, ready-to-publish ad setup for a first-time advertiser. Fill in every field with specific, realistic, high-quality values based on the business description. Make the ad copy compelling and natural. Never use placeholder text. Always respond in valid JSON only, no markdown.",
  );
}

export function analyseAd(prisma: PrismaClient, userId: string, body: unknown) {
  return structuredCall(
    prisma, userId, "analyse-ad", body, "ad_analysis", adAnalysisSchema,
    "Analyse this advertising object at the requested level and return practical improvements. Use the supplied metrics and current data only. Keep the advice specific and plain.",
    "You are a friendly, plain-English advertising coach helping a small business owner or first-time advertiser understand how their Facebook ad is performing and how to improve it. You never use marketing jargon. Explain everything as if the user is 15 years old and intelligent but has no ad experience. Be specific, honest, and encouraging. Always respond in valid JSON only.",
  );
}
