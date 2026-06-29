import type { Campaign } from "./types";

export class ApiError extends Error {
  status: number;
  details: any;
  constructor(message: string, status: number, details?: any) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: "include",
    ...options,
    headers: options.body instanceof FormData ? options.headers : { "Content-Type": "application/json", ...options.headers },
  });
  if (response.status === 204) return undefined as T;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(data.message || "Request failed", response.status, data);
  return data;
}

export const campaignInclude = (campaign: any): Campaign => ({
  ...campaign,
  dailyBudget: campaign.dailyBudget == null ? null : Number(campaign.dailyBudget),
  lifetimeBudget: campaign.lifetimeBudget == null ? null : Number(campaign.lifetimeBudget),
  adSets: (campaign.adSets || []).map((adSet: any) => ({
    ...adSet,
    bidAmount: adSet.bidAmount == null ? null : Number(adSet.bidAmount),
    ads: adSet.ads || [],
  })),
});
