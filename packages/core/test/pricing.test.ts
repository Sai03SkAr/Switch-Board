import { describe, it, expect } from "vitest";
import {
  estimateCost,
  amortizeSubscription,
  deriveMaxPossibleMicros,
  UnsupportedPricingModelError,
  type PricingModel,
} from "../src/pricing.js";

/**
 * These three fixtures are the exact three providers spiked on paper in
 * plan/13-normalization-spike.md, with the exact real numbers from that document.
 * If these tests pass, the code implements what the plan says it implements.
 */

describe("PER_CALL — CoinGecko (subscription amortized to per-call, Spike Fix #1)", () => {
  it("derives 258 micros/call from $129/month ÷ 500,000 calls", () => {
    const perCall = amortizeSubscription(129_000_000, 500_000);
    expect(perCall).toBe(258);
  });

  it("estimates a flat per-call cost with no args needed", () => {
    const coinGecko: PricingModel = {
      model: "PER_CALL",
      currency: "USD",
      base_micros: 258,
      max_possible_micros: 258,
      estimator: "static",
    };
    const estimate = estimateCost(coinGecko);
    expect(estimate.estimatedMicros).toBe(258);
    expect(estimate.maxPossibleMicros).toBe(258);
    expect(estimate.isExact).toBe(true);
  });
});

describe("PER_UNIT — ElevenLabs (character-billed, Spike Fix #2)", () => {
  const elevenLabs: PricingModel = {
    model: "PER_UNIT",
    currency: "USD",
    base_micros: 0,
    unit: "character",
    unit_micros: 200, // $6 / 30,000 chars = $0.0002/char
    unit_divisor: 1,
    unit_count_field: "text",
    unit_count_source: "length",
    max_input_units: 5000, // the enforced cap that makes max_possible_micros computable
    max_possible_micros: deriveMaxPossibleMicros(200, 1, 5000),
    estimator: "from_args",
  };

  it("derives max_possible_micros from unit_micros × the enforced input cap", () => {
    expect(elevenLabs.max_possible_micros).toBe(1_000_000); // 200 * 5000
  });

  it("computes an EXACT cost from the input args — not just an estimate", () => {
    const estimate = estimateCost(elevenLabs, { text: "a".repeat(100) });
    expect(estimate.estimatedMicros).toBe(20_000); // 100 chars * 200 micros
    expect(estimate.isExact).toBe(true);
  });

  it("rejects input that exceeds the enforced cap before any hold is taken", () => {
    expect(() => estimateCost(elevenLabs, { text: "a".repeat(5001) })).toThrow(/exceeds the enforced cap/);
  });

  it("falls back to the worst case when no args are supplied (e.g. bare inspect)", () => {
    const estimate = estimateCost(elevenLabs);
    expect(estimate.estimatedMicros).toBe(1_000_000);
    expect(estimate.isExact).toBe(false);
  });
});

describe("TIERED — Google Maps Geocoding shape (argument-size only, Spike Fix #3)", () => {
  const geocoding: PricingModel = {
    model: "TIERED",
    currency: "USD",
    base_micros: 0,
    unit: "request",
    tier_basis: "argument_size",
    tier_field: "monthly_volume_bracket", // in v1, must come from the call's own args
    tiers: [
      { up_to: 10_000, micros: 0 },
      { up_to: 100_000, micros: 5000 },
      { up_to: 500_000, micros: 4000 },
      { up_to: 1_000_000, micros: 3000 },
      { up_to: 5_000_000, micros: 1500 },
      { up_to: null, micros: 380 },
    ],
    max_possible_micros: 5000,
    estimator: "from_args",
  };

  it("selects the correct tier for a given argument value", () => {
    expect(estimateCost(geocoding, { monthly_volume_bracket: 50_000 }).estimatedMicros).toBe(5000);
    expect(estimateCost(geocoding, { monthly_volume_bracket: 200_000 }).estimatedMicros).toBe(4000);
    expect(estimateCost(geocoding, { monthly_volume_bracket: 10_000_000 }).estimatedMicros).toBe(380);
  });

  it("rejects cumulative-monthly-volume tiering — out of v1 scope per the spike", () => {
    const cumulativeVolumeTiered: PricingModel = { ...geocoding, tier_basis: undefined };
    expect(() => estimateCost(cumulativeVolumeTiered, { monthly_volume_bracket: 1 })).toThrow(
      UnsupportedPricingModelError
    );
  });
});

describe("Models not yet spiked against a real provider are explicitly unimplemented", () => {
  it.each(["PER_RESULT", "PER_UNIT_MATRIX"] as const)("%s throws UnsupportedPricingModelError", (model) => {
    const pricing: PricingModel = {
      model,
      currency: "USD",
      base_micros: 0,
      max_possible_micros: 0,
      estimator: "static",
    };
    expect(() => estimateCost(pricing)).toThrow(UnsupportedPricingModelError);
  });
});
