/**
 * Normalized pricing model — see plan/05-data-model.md and the three fixes recorded in
 * plan/13-normalization-spike.md after spiking this schema against 3 real providers.
 *
 * Concrete fields added here beyond the prose spec, so the fixes are executable:
 *   - unit_count_field / unit_count_source: which arg to measure, and how (Gap 2)
 *   - max_input_units: the enforced cap that makes max_possible_micros computable (Gap 2)
 *   - tier_basis / tier_field: v1 only supports tiering by this call's own args (Gap 3)
 */

export type PricingModelKind = "PER_CALL" | "PER_UNIT" | "TIERED" | "PER_RESULT" | "PER_UNIT_MATRIX";
export type Estimator = "static" | "from_args" | "from_response";

export interface Tier {
  up_to: number | null; // null = open-ended top tier
  micros: number;
}

export interface PricingModel {
  model: PricingModelKind;
  currency: string;
  base_micros: number;
  unit?: string | null;
  unit_micros?: number | null;
  unit_divisor?: number | null;
  unit_count_field?: string | null;
  unit_count_source?: "length" | "value" | null;
  max_input_units?: number | null;
  tier_basis?: "argument_size" | null;
  tier_field?: string | null;
  tiers?: Tier[] | null;
  max_possible_micros: number;
  estimator: Estimator;
}

export interface CostEstimate {
  estimatedMicros: number;
  maxPossibleMicros: number;
  explain: string;
  isExact: boolean; // true when estimate === actual charge, given these args (Gap 2 insight)
}

export class UnsupportedPricingModelError extends Error {
  constructor(model: PricingModelKind) {
    super(
      `Pricing model ${model} was not spiked against a real provider (see 13-normalization-spike.md) ` +
        `and is not implemented. Do not onboard an endpoint using it until it is.`
    );
    this.name = "UnsupportedPricingModelError";
  }
}

/**
 * Spike Fix #1: base_micros must already be the derived per-call cost (e.g. plan_cost /
 * included_quota for a subscription+quota provider). This helper makes that derivation
 * explicit and auditable at ingestion time rather than hand-typed.
 */
export function amortizeSubscription(planCostMicros: number, includedCallsPerPeriod: number): number {
  if (includedCallsPerPeriod <= 0) {
    throw new Error("includedCallsPerPeriod must be positive");
  }
  return Math.round(planCostMicros / includedCallsPerPeriod);
}

/**
 * Spike Fix #2: for a from_args unit biller, max_possible_micros must be derived from an
 * actually-enforced input cap, not guessed. This is what the ingestion pipeline should
 * call, and the result is what must also appear as a JSON Schema maxLength/maximum on the
 * endpoint's input_schema.
 */
export function deriveMaxPossibleMicros(unitMicros: number, unitDivisor: number, maxInputUnits: number): number {
  return Math.round((unitMicros * maxInputUnits) / unitDivisor);
}

export class PricingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PricingValidationError";
  }
}

/**
 * Bug this catches: max_possible_micros is a bare number on the schema with nothing
 * enforcing that it's actually consistent with the rest of the pricing object. It is the
 * amount the ledger reserves before a call runs (Phase 2) — if it silently drifts below
 * the true worst case (e.g. someone edits `tiers` or `unit_micros` later and forgets to
 * recompute it), the hold under-reserves and a call can cost more than what was held
 * against the balance. This must run on every endpoint before it enters the catalogue.
 */
export function validatePricingModel(pricing: PricingModel): void {
  if (pricing.max_possible_micros < 0) {
    throw new PricingValidationError("max_possible_micros cannot be negative");
  }

  switch (pricing.model) {
    case "PER_CALL": {
      if (pricing.max_possible_micros !== pricing.base_micros) {
        throw new PricingValidationError(
          `PER_CALL max_possible_micros (${pricing.max_possible_micros}) must equal base_micros (${pricing.base_micros}) — there is no variable component.`
        );
      }
      break;
    }

    case "PER_UNIT": {
      if (pricing.unit_micros == null) {
        throw new PricingValidationError("PER_UNIT pricing requires unit_micros");
      }
      if (pricing.max_input_units == null) {
        // This is Gap 2 from 13-normalization-spike.md, enforced: an open-ended per-unit
        // biller cannot be onboarded because there is no way to bound the hold.
        throw new PricingValidationError(
          "PER_UNIT pricing requires max_input_units — an endpoint with no enforceable input cap cannot be onboarded (see 13-normalization-spike.md Gap 2)."
        );
      }
      const divisor = pricing.unit_divisor ?? 1;
      const expected = pricing.base_micros + deriveMaxPossibleMicros(pricing.unit_micros, divisor, pricing.max_input_units);
      if (pricing.max_possible_micros !== expected) {
        throw new PricingValidationError(
          `PER_UNIT max_possible_micros (${pricing.max_possible_micros}) doesn't match base_micros + unit_micros × max_input_units / divisor (${expected}). Recompute it with deriveMaxPossibleMicros() rather than hand-entering it.`
        );
      }
      break;
    }

    case "TIERED": {
      if (!pricing.tiers || pricing.tiers.length === 0) {
        throw new PricingValidationError("TIERED pricing requires a non-empty tiers array");
      }
      const worstTier = Math.max(...pricing.tiers.map((t) => t.micros));
      const expected = pricing.base_micros + worstTier;
      if (pricing.max_possible_micros !== expected) {
        throw new PricingValidationError(
          `TIERED max_possible_micros (${pricing.max_possible_micros}) doesn't match base_micros + the priciest tier (${expected}). If you edited \`tiers\`, max_possible_micros must be recomputed too.`
        );
      }
      break;
    }

    case "PER_RESULT":
    case "PER_UNIT_MATRIX":
      // Not implemented yet (see estimateCost) — nothing to validate until they are.
      break;
  }
}

function countUnits(pricing: PricingModel, args: Record<string, unknown>): number {
  const field = pricing.unit_count_field;
  if (!field) {
    throw new Error(`PER_UNIT pricing requires unit_count_field (unit: ${pricing.unit})`);
  }
  const value = args[field];
  if (value === undefined) {
    throw new Error(`Missing required arg "${field}" needed to price this call`);
  }
  if (pricing.unit_count_source === "length") {
    return String(value).length;
  }
  const n = Number(value);
  if (Number.isNaN(n)) {
    throw new Error(`Arg "${field}" must be numeric to compute unit count`);
  }
  return n;
}

function selectTier(tiers: Tier[], tierValue: number): Tier {
  for (const tier of tiers) {
    if (tier.up_to === null || tierValue <= tier.up_to) {
      return tier;
    }
  }
  // Should not happen if the top tier has up_to: null, but fail safe to the priciest tier.
  return tiers[tiers.length - 1];
}

/**
 * Estimate the cost of a call. When `args` is omitted, returns the worst-case
 * (max_possible_micros) — used for `inspect` without arguments and for computing the
 * ledger hold amount before the exact estimate is known.
 */
export function estimateCost(pricing: PricingModel, args?: Record<string, unknown>): CostEstimate {
  switch (pricing.model) {
    case "PER_CALL": {
      return {
        estimatedMicros: pricing.base_micros,
        maxPossibleMicros: pricing.max_possible_micros,
        explain: `Flat ${pricing.base_micros} micros per call.`,
        isExact: true,
      };
    }

    case "PER_UNIT": {
      if (!pricing.unit || pricing.unit_micros == null) {
        throw new Error("PER_UNIT pricing requires unit and unit_micros");
      }
      const divisor = pricing.unit_divisor ?? 1;
      if (!args) {
        return {
          estimatedMicros: pricing.max_possible_micros,
          maxPossibleMicros: pricing.max_possible_micros,
          explain: `${pricing.base_micros} micros base + ${pricing.unit_micros} micros per ${pricing.unit} ` +
            `(divisor ${divisor}). No args supplied — showing worst case.`,
          isExact: false,
        };
      }
      const units = countUnits(pricing, args);
      if (pricing.max_input_units != null && units > pricing.max_input_units) {
        throw new Error(
          `Input exceeds the enforced cap of ${pricing.max_input_units} ${pricing.unit}(s) for this endpoint`
        );
      }
      const estimated = pricing.base_micros + Math.round((units * pricing.unit_micros) / divisor);
      return {
        estimatedMicros: estimated,
        maxPossibleMicros: pricing.max_possible_micros,
        explain: `${pricing.base_micros} micros base + ${units} ${pricing.unit}(s) × ${pricing.unit_micros} micros / ${divisor}.`,
        // Exact because cost depends only on the request, never the response (Gap 2 insight).
        isExact: pricing.estimator === "from_args",
      };
    }

    case "TIERED": {
      if (pricing.tier_basis !== "argument_size") {
        throw new UnsupportedPricingModelError(pricing.model);
      }
      if (!pricing.tiers || pricing.tiers.length === 0 || !pricing.tier_field) {
        throw new Error("TIERED pricing requires tiers and tier_field");
      }
      if (!args) {
        const worst = pricing.tiers.reduce((max, t) => Math.max(max, t.micros), 0);
        return {
          estimatedMicros: worst + pricing.base_micros,
          maxPossibleMicros: pricing.max_possible_micros,
          explain: `Tiered by this call's own "${pricing.tier_field}". No args supplied — showing worst tier.`,
          isExact: false,
        };
      }
      const raw = args[pricing.tier_field];
      const tierValue = Number(raw ?? 0);
      const tier = selectTier(pricing.tiers, tierValue);
      return {
        estimatedMicros: pricing.base_micros + tier.micros,
        maxPossibleMicros: pricing.max_possible_micros,
        explain: `"${pricing.tier_field}" = ${tierValue} → tier priced at ${tier.micros} micros.`,
        isExact: true,
      };
    }

    case "PER_RESULT":
    case "PER_UNIT_MATRIX":
      throw new UnsupportedPricingModelError(pricing.model);

    default: {
      const _exhaustive: never = pricing.model;
      throw new Error(`Unknown pricing model: ${_exhaustive}`);
    }
  }
}
