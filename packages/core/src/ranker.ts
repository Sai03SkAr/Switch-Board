/**
 * Discovery ranker — see plan/04-architecture.md.
 *
 * This is the direct fix for the price-blind ranking gap in plan/02-weaknesses.md #3:
 * an independent review found Monid's discovery ranked a $0.02376 endpoint above the
 * $0.0009 vetted one for the same task — price was not a ranking factor at all.
 * Price is a first-class, weighted, always-returned factor here.
 */

export interface RankWeights {
  fit: number;
  price: number;
  reliability: number;
  latency: number;
  freshness: number;
}

export const DEFAULT_WEIGHTS: RankWeights = {
  fit: 0.45,
  price: 0.25,
  reliability: 0.2,
  latency: 0.05,
  freshness: 0.05,
};

export interface RankCandidateInput {
  endpointId: string;
  semanticFit: number; // 0..1, from hybrid retrieval
  estimatedCostMicros: number;
  successRate7d: number; // 0..1
  p95LatencyMs: number;
  daysSinceLastVerified: number;
}

export interface ScoreBreakdown {
  fit: number;
  price: number;
  reliability: number;
  latency: number;
  freshness: number;
  weights_used: RankWeights;
}

export interface RankedCandidate {
  endpointId: string;
  score: number;
  scoreBreakdown: ScoreBreakdown;
  cheapestViable: boolean;
}

/** Cheaper = higher score. Normalized against the cheapest and priciest candidate in the set. */
function priceScore(costMicros: number, minCost: number, maxCost: number): number {
  if (maxCost === minCost) return 1;
  return 1 - (costMicros - minCost) / (maxCost - minCost);
}

/** Faster = higher score. 100ms is treated as effectively instant; 5000ms+ as effectively 0. */
function latencyScore(p95Ms: number): number {
  const clamped = Math.min(Math.max(p95Ms, 100), 5000);
  return 1 - (clamped - 100) / (5000 - 100);
}

/** Recently verified = higher score. Decays to 0 over 30 days. */
function freshnessScore(daysSinceVerified: number): number {
  return Math.max(0, 1 - daysSinceVerified / 30);
}

export function rankCandidates(
  candidates: RankCandidateInput[],
  weights: RankWeights = DEFAULT_WEIGHTS
): RankedCandidate[] {
  if (candidates.length === 0) return [];

  const costs = candidates.map((c) => c.estimatedCostMicros);
  const minCost = Math.min(...costs);
  const maxCost = Math.max(...costs);

  const scored = candidates.map((c): RankedCandidate => {
    const breakdown: ScoreBreakdown = {
      fit: c.semanticFit,
      price: priceScore(c.estimatedCostMicros, minCost, maxCost),
      reliability: c.successRate7d,
      latency: latencyScore(c.p95LatencyMs),
      freshness: freshnessScore(c.daysSinceLastVerified),
      weights_used: weights,
    };
    const score =
      breakdown.fit * weights.fit +
      breakdown.price * weights.price +
      breakdown.reliability * weights.reliability +
      breakdown.latency * weights.latency +
      breakdown.freshness * weights.freshness;

    return {
      endpointId: c.endpointId,
      score,
      scoreBreakdown: breakdown,
      cheapestViable: c.estimatedCostMicros === minCost,
    };
  });

  return scored.sort((a, b) => b.score - a.score);
}
