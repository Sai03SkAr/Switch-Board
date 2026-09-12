import { describe, it, expect } from "vitest";
import { rankCandidates, DEFAULT_WEIGHTS, type RankCandidateInput } from "../src/ranker.js";

describe("The Monid inversion test — plan/07-roadmap.md Phase 1 acceptance criterion", () => {
  /**
   * plan/02-weaknesses.md #3: an independent review found Monid ranked a $0.02376
   * endpoint above the $0.0009 "vetted" one for the same task — a ~26× price spread,
   * with price not factored into ranking at all. Fixture below reproduces that exact
   * scenario (labeled as a test fixture, not a real onboarded provider pair — see
   * plan/13-normalization-spike.md for why real-provider pairs at an exact 25× spread
   * aren't the honest way to prove this) and asserts SwitchBoard's ranker gets it right.
   */
  const expensiveButEqualFit: RankCandidateInput = {
    endpointId: "expensive-endpoint",
    semanticFit: 0.95, // slightly higher fit, to make this a genuinely hard case
    estimatedCostMicros: 23_760, // $0.02376
    successRate7d: 0.98,
    p95LatencyMs: 400,
    daysSinceLastVerified: 1,
  };
  const cheapVetted: RankCandidateInput = {
    endpointId: "cheap-vetted-endpoint",
    semanticFit: 0.94, // near-identical fit — the whole point is price should decide
    estimatedCostMicros: 900, // $0.0009 — a 26.4× cheaper option
    successRate7d: 0.998,
    p95LatencyMs: 410,
    daysSinceLastVerified: 1,
  };

  it("ranks the cheaper, equally-fit candidate first", () => {
    const ranked = rankCandidates([expensiveButEqualFit, cheapVetted]);
    expect(ranked[0].endpointId).toBe("cheap-vetted-endpoint");
  });

  it("marks the cheapest candidate as cheapest_viable", () => {
    const ranked = rankCandidates([expensiveButEqualFit, cheapVetted]);
    const cheap = ranked.find((r) => r.endpointId === "cheap-vetted-endpoint")!;
    const pricey = ranked.find((r) => r.endpointId === "expensive-endpoint")!;
    expect(cheap.cheapestViable).toBe(true);
    expect(pricey.cheapestViable).toBe(false);
  });

  it("always returns an auditable score_breakdown with the weights used", () => {
    const ranked = rankCandidates([expensiveButEqualFit, cheapVetted]);
    for (const r of ranked) {
      expect(r.scoreBreakdown).toMatchObject({
        fit: expect.any(Number),
        price: expect.any(Number),
        reliability: expect.any(Number),
        latency: expect.any(Number),
        freshness: expect.any(Number),
        weights_used: DEFAULT_WEIGHTS,
      });
    }
  });

  it("would have inverted like Monid's if price weight were zero — proves the fix is load-bearing", () => {
    const priceBlindWeights = { fit: 0.7, price: 0, reliability: 0.2, latency: 0.05, freshness: 0.05 };
    const ranked = rankCandidates([expensiveButEqualFit, cheapVetted], priceBlindWeights);
    // With price zeroed out, the slightly-higher-fit expensive option wins — reproducing
    // the exact failure mode this ranker exists to prevent.
    expect(ranked[0].endpointId).toBe("expensive-endpoint");
  });
});

describe("Ranker general behavior", () => {
  it("returns an empty array for no candidates", () => {
    expect(rankCandidates([])).toEqual([]);
  });

  it("sorts strictly by descending score", () => {
    const candidates: RankCandidateInput[] = [
      { endpointId: "a", semanticFit: 0.5, estimatedCostMicros: 1000, successRate7d: 0.9, p95LatencyMs: 500, daysSinceLastVerified: 5 },
      { endpointId: "b", semanticFit: 0.9, estimatedCostMicros: 1000, successRate7d: 0.9, p95LatencyMs: 500, daysSinceLastVerified: 5 },
      { endpointId: "c", semanticFit: 0.7, estimatedCostMicros: 1000, successRate7d: 0.9, p95LatencyMs: 500, daysSinceLastVerified: 5 },
    ];
    const ranked = rankCandidates(candidates);
    const scores = ranked.map((r) => r.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(ranked[0].endpointId).toBe("b");
  });

  it("gives every candidate cheapest_viable=true when all cost the same", () => {
    const candidates: RankCandidateInput[] = [
      { endpointId: "a", semanticFit: 0.5, estimatedCostMicros: 500, successRate7d: 0.9, p95LatencyMs: 500, daysSinceLastVerified: 5 },
      { endpointId: "b", semanticFit: 0.6, estimatedCostMicros: 500, successRate7d: 0.9, p95LatencyMs: 500, daysSinceLastVerified: 5 },
    ];
    const ranked = rankCandidates(candidates);
    expect(ranked.every((r) => r.cheapestViable)).toBe(true);
  });
});
