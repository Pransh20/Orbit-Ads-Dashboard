export type CampaignStatus = "DRAFT" | "READY" | "PUBLISHED" | "PAUSED" | "ARCHIVED";

export interface Campaign {
  id: string;
  name: string;
  objective: string;
  status: CampaignStatus;
  budgetType: "DAILY" | "LIFETIME";
  budget: number;
  currency: string;
  startDate: string;
  endDate?: string;
  adSets: number;
  ads: number;
  updatedAt: string;
  owner: string;
}

export const campaigns: Campaign[] = [
  { id: "cmp_1", name: "Summer Collection Launch", objective: "SALES", status: "PUBLISHED", budgetType: "DAILY", budget: 240, currency: "USD", startDate: "Jun 18, 2026", endDate: "Jul 18, 2026", adSets: 3, ads: 8, updatedAt: "12 min ago", owner: "Maya Chen" },
  { id: "cmp_2", name: "Brand Awareness — DACH", objective: "AWARENESS", status: "READY", budgetType: "LIFETIME", budget: 8500, currency: "EUR", startDate: "Jun 24, 2026", endDate: "Jul 12, 2026", adSets: 2, ads: 4, updatedAt: "2 hours ago", owner: "Leo Martin" },
  { id: "cmp_3", name: "Retargeting · Product Viewers", objective: "CONVERSIONS", status: "PAUSED", budgetType: "DAILY", budget: 120, currency: "USD", startDate: "Jun 02, 2026", adSets: 4, ads: 12, updatedAt: "Yesterday", owner: "Maya Chen" },
  { id: "cmp_4", name: "Lead Gen — Enterprise", objective: "LEAD_GENERATION", status: "DRAFT", budgetType: "DAILY", budget: 80, currency: "USD", startDate: "Jun 28, 2026", adSets: 1, ads: 2, updatedAt: "Jun 20", owner: "Iris Wong" },
  { id: "cmp_5", name: "Spring Sale 2026", objective: "TRAFFIC", status: "ARCHIVED", budgetType: "LIFETIME", budget: 12000, currency: "USD", startDate: "Mar 01, 2026", endDate: "Apr 01, 2026", adSets: 5, ads: 18, updatedAt: "Apr 04", owner: "Leo Martin" },
];

export const chartData = [
  { day: "Jun 16", spend: 178, reach: 12400 },
  { day: "Jun 17", spend: 206, reach: 15100 },
  { day: "Jun 18", spend: 192, reach: 14300 },
  { day: "Jun 19", spend: 244, reach: 18200 },
  { day: "Jun 20", spend: 228, reach: 16900 },
  { day: "Jun 21", spend: 267, reach: 20100 },
  { day: "Jun 22", spend: 251, reach: 19400 },
];

export const creativeItems = [
  { id: 1, type: "IMAGE", title: "Linen shirt — sand", campaign: "Summer Collection Launch", used: 3, color: "#d6c2a8", shape: "shirt" },
  { id: 2, type: "VIDEO", title: "Summer film 15s", campaign: "Summer Collection Launch", used: 2, color: "#768b75", shape: "landscape" },
  { id: 3, type: "IMAGE", title: "Workspace hero", campaign: "Lead Gen — Enterprise", used: 1, color: "#9faab7", shape: "desk" },
  { id: 4, type: "IMAGE", title: "Leather tote — rust", campaign: "Retargeting · Product Viewers", used: 4, color: "#a5674e", shape: "bag" },
  { id: 5, type: "VIDEO", title: "Customer story — Nora", campaign: "Brand Awareness — DACH", used: 1, color: "#c99179", shape: "portrait" },
  { id: 6, type: "IMAGE", title: "Ceramic collection", campaign: "Brand Awareness — DACH", used: 2, color: "#b6aaa0", shape: "vase" },
];
