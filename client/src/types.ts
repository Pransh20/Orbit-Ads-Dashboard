export type CampaignStatus = "DRAFT" | "READY" | "PUBLISHED" | "PAUSED" | "ARCHIVED";

export type Creative = {
  id?: string;
  type: "IMAGE" | "VIDEO";
  fileName: string;
  fileUrl: string;
  mimeType: string;
  fileSize: number;
  thumbnailUrl?: string | null;
  position: number;
  metaAssetId?: string | null;
  uploadedAt?: string;
  ad?: any;
};

export type Ad = {
  id?: string;
  name: string;
  status: string;
  format: "SINGLE_IMAGE" | "CAROUSEL" | "VIDEO" | "COLLECTION";
  primaryText: string;
  headline: string;
  description: string;
  callToAction: string;
  destinationUrl: string;
  pageId?: string;
  instagramId?: string;
  facebookAdId?: string | null;
  creatives: Creative[];
};

export type AdSet = {
  id?: string;
  name: string;
  audienceLabel?: string | null;
  audienceReasoning?: string | null;
  status: string;
  targeting: {
    ageMin: number;
    ageMax: number;
    genders: string[];
    locations: Array<{ country: string; city?: string; region?: string }>;
    interests: Array<{ id: string; name: string }>;
    customAudiences: Array<{ id: string; name: string }>;
    placements: "AUTOMATIC" | "MANUAL";
    manualPlacements?: string[];
    deviceTypes: "ALL" | "MOBILE" | "DESKTOP";
  };
  optimizationGoal: string;
  billingEvent: string;
  bidStrategy: string;
  bidAmount: number | null;
  facebookAdSetId?: string | null;
  ads: Ad[];
  _count?: { ads: number };
};

export type Campaign = {
  id: string;
  name: string;
  objective: string;
  goalLabel?: string | null;
  businessDescription?: string | null;
  websiteUrl?: string | null;
  brandName?: string | null;
  parentCampaignId?: string | null;
  relaunchReason?: string | null;
  aiGenerated?: boolean;
  status: CampaignStatus;
  dailyBudget: number | null;
  lifetimeBudget: number | null;
  currency: string;
  startDate: string;
  endDate: string | null;
  specialAdCategory: string;
  facebookCampaignId?: string | null;
  publishState?: any;
  createdAt: string;
  updatedAt: string;
  createdBy?: { id: string; name: string; email: string };
  _count?: { adSets: number };
  adSets: AdSet[];
};

export type User = {
  id: string;
  name: string;
  email: string;
  defaultCurrency: string;
  timezone: string;
  createdAt: string;
  metaConnection: null | { adAccountId: string; pageId: string; connectedAt: string; expiresAt: string };
};
