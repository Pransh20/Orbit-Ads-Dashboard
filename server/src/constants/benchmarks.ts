export const BENCHMARKS = {
  CONVERSIONS: { ctr: { poor: 0.5, average: 1.2, good: 2.5 }, cpc: { poor: 3.0, average: 1.5, good: 0.8 }, cpm: { poor: 20, average: 12, good: 7 }, frequencyWarning: 3.0, frequencyDanger: 5.0, minSpendForAnalysis: 10 },
  TRAFFIC: { ctr: { poor: 0.8, average: 2.1, good: 4.0 }, cpc: { poor: 1.5, average: 0.8, good: 0.3 }, cpm: { poor: 15, average: 8, good: 4 }, frequencyWarning: 3.0, frequencyDanger: 5.0, minSpendForAnalysis: 10 },
  LEAD_GENERATION: { ctr: { poor: 0.6, average: 1.8, good: 3.5 }, cpc: { poor: 5.0, average: 2.5, good: 1.0 }, cpm: { poor: 25, average: 15, good: 8 }, frequencyWarning: 3.0, frequencyDanger: 5.0, minSpendForAnalysis: 15 },
  REACH: { ctr: { poor: 0.3, average: 0.8, good: 1.5 }, cpc: { poor: 2.0, average: 1.0, good: 0.5 }, cpm: { poor: 10, average: 5, good: 2 }, frequencyWarning: 4.0, frequencyDanger: 7.0, minSpendForAnalysis: 5 },
  ENGAGEMENT: { ctr: { poor: 0.5, average: 1.5, good: 3.0 }, cpc: { poor: 1.0, average: 0.5, good: 0.2 }, cpm: { poor: 12, average: 6, good: 3 }, frequencyWarning: 4.0, frequencyDanger: 6.0, minSpendForAnalysis: 5 },
  APP_PROMOTION: { ctr: { poor: 0.4, average: 1.0, good: 2.0 }, cpc: { poor: 4.0, average: 2.0, good: 0.8 }, cpm: { poor: 18, average: 10, good: 5 }, frequencyWarning: 3.0, frequencyDanger: 5.0, minSpendForAnalysis: 20 },
  DEFAULT: { ctr: { poor: 0.5, average: 1.2, good: 2.5 }, cpc: { poor: 3.0, average: 1.5, good: 0.8 }, cpm: { poor: 20, average: 12, good: 7 }, frequencyWarning: 3.0, frequencyDanger: 5.0, minSpendForAnalysis: 10 },
} as const;

export type BenchmarkObjective = keyof typeof BENCHMARKS;
export type Verdict = "GOOD" | "AVERAGE" | "POOR";

export function benchmarkFor(objective?: string) {
  const key = String(objective || "DEFAULT").replace(/^OUTCOME_/, "").replace("SALES", "CONVERSIONS") as BenchmarkObjective;
  return BENCHMARKS[key] ?? BENCHMARKS.DEFAULT;
}

export function getVerdict(metric: "ctr" | "cpc" | "cpm", value: number, objective: string): Verdict {
  const thresholds = benchmarkFor(objective)[metric];
  if (metric === "ctr") {
    if (value >= thresholds.good) return "GOOD";
    if (value >= thresholds.average) return "AVERAGE";
    return "POOR";
  }
  if (value <= thresholds.good) return "GOOD";
  if (value <= thresholds.average) return "AVERAGE";
  return "POOR";
}
