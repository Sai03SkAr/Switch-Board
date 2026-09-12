/**
 * The executor: validate → estimate → reserve → call upstream → capture/release.
 * See plan/04-architecture.md "Executor" and plan/06-api-spec.md's failure semantics
 * table — this is what POST /v1/run is built on.
 */
import { createHash } from "node:crypto";
import Ajv from "ajv";
import type pg from "pg";
import { estimateCost, type PricingModel } from "./pricing.js";
import { reserve, capture, release, InsufficientFundsError } from "./ledger.js";
import { substituteTemplate, type UpstreamClient } from "./upstream.js";

const ajv = new Ajv({ allErrors: true });

export class ValidationError extends Error {
  constructor(public readonly details: unknown) {
    super("Request arguments do not match this endpoint's input schema");
    this.name = "ValidationError";
  }
}

export class EndpointNotFoundError extends Error {
  constructor(endpointId: string) {
    super(`No such endpoint: ${endpointId}`);
    this.name = "EndpointNotFoundError";
  }
}

export interface RunParams {
  endpointId: string;
  args: Record<string, unknown>;
  idempotencyKey: string;
  workspaceId: string;
  accountId: string;
  revenueAccountId: string;
  dryRun?: boolean;
}

export interface RunReceipt {
  estimatedMicros: number;
  chargedMicros: number;
  currency: string;
}

export interface RunResult {
  runId: string | null; // null for dry_run — nothing is persisted
  state: "succeeded" | "failed" | "dry_run";
  result?: unknown;
  receipt?: RunReceipt;
  errorClass?: string;
  errorMessage?: string;
  latencyMs?: number;
}

function hashArgs(args: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(args)).digest("hex");
}

export async function run(
  pool: pg.Pool,
  upstreamClient: UpstreamClient,
  params: RunParams
): Promise<RunResult> {
  const endpointRes = await pool.query(
    `SELECT e.id, e.input_schema, e.pricing, e.upstream_path, e.upstream_method, e.timeout_ms,
            p.base_url
     FROM endpoints e JOIN providers p ON p.id = e.provider_id
     WHERE e.id = $1`,
    [params.endpointId]
  );
  if (endpointRes.rows.length === 0) {
    throw new EndpointNotFoundError(params.endpointId);
  }
  const endpoint = endpointRes.rows[0];
  const pricing = endpoint.pricing as PricingModel;

  // Failure semantics (plan/04-architecture.md): invalid args → fail closed, no hold
  // taken, no charge, nothing even persisted to `runs`.
  const validate = ajv.compile(endpoint.input_schema);
  if (!validate(params.args)) {
    throw new ValidationError(validate.errors);
  }

  const estimate = estimateCost(pricing, params.args);

  if (params.dryRun) {
    return {
      runId: null,
      state: "dry_run",
      receipt: { estimatedMicros: estimate.estimatedMicros, chargedMicros: 0, currency: pricing.currency },
    };
  }

  const workspaceRes = await pool.query("SELECT store_payloads FROM workspaces WHERE id = $1", [params.workspaceId]);
  const storePayloads: boolean = workspaceRes.rows[0]?.store_payloads ?? false;
  const argsHash = hashArgs(params.args);

  const runRes = await pool.query<{ id: string }>(
    `INSERT INTO runs (workspace_id, endpoint_id, state, idempotency_key, estimated_micros, args_hash, args)
     VALUES ($1, $2, 'pending', $3, $4, $5, $6)
     RETURNING id`,
    [
      params.workspaceId,
      params.endpointId,
      params.idempotencyKey,
      estimate.maxPossibleMicros,
      argsHash,
      storePayloads ? JSON.stringify(params.args) : null,
    ]
  );
  const runId = runRes.rows[0].id;

  // Bug fixed here: holds.amount_micros has CHECK (amount_micros > 0) — deliberately, a
  // hold should represent real money genuinely at risk, and the schema itself rejects a
  // zero-value one. More than half the seeded catalogue (NWS, Frankfurter, OpenTDB,
  // Census) is genuinely free, so this isn't an edge case; it's the common case. A $0
  // call has nothing to reserve — skip the ledger entirely rather than trying to hold
  // nothing, matching how a $0 line item is handled in real financial systems.
  const isFree = estimate.maxPossibleMicros === 0;
  let holdId: string | null = null;
  if (!isFree) {
    try {
      const hold = await reserve(pool, {
        accountId: params.accountId,
        amountMicros: estimate.maxPossibleMicros,
        idempotencyKey: params.idempotencyKey,
        runId,
      });
      holdId = hold.id;
      await pool.query("UPDATE runs SET hold_id = $1 WHERE id = $2", [holdId, runId]);
    } catch (err) {
      if (err instanceof InsufficientFundsError) {
        await pool.query(
          "UPDATE runs SET state = 'failed', error_class = $1, error_message = $2 WHERE id = $3",
          ["InsufficientFundsError", err.message, runId]
        );
      }
      throw err;
    }
  }

  const url = `${endpoint.base_url}${substituteTemplate(endpoint.upstream_path, params.args)}`;
  const method = endpoint.upstream_method as "GET" | "POST";

  let response;
  try {
    response = await upstreamClient.execute({
      method,
      url,
      body: method === "POST" ? params.args : undefined,
      timeoutMs: endpoint.timeout_ms,
    });
  } catch (err) {
    // Network error / timeout — the failure semantics table's rule applies: release the
    // hold, charge zero, surface the error. This is what closes the Phase 2 acceptance
    // criterion "upstream 500 leaves the balance changed by exactly 0 micro-dollars."
    if (holdId) await release(pool, holdId);
    const errorClass = (err as Error).name || "UpstreamError";
    await pool.query(
      "UPDATE runs SET state = 'failed', error_class = $1, error_message = $2 WHERE id = $3",
      [errorClass, (err as Error).message, runId]
    );
    return { runId, state: "failed", errorClass, errorMessage: (err as Error).message, receipt: { estimatedMicros: estimate.estimatedMicros, chargedMicros: 0, currency: pricing.currency } };
  }

  if (response.status >= 200 && response.status < 300) {
    // None of the seeded endpoints use a from_response estimator yet (see
    // plan/13-normalization-spike.md — only PER_CALL/PER_UNIT/TIERED with from_args or
    // static estimators are onboarded), so actual cost always equals the estimate here.
    // The capture() call still clamps to the reserved max regardless, so this is safe
    // even once a from_response-priced endpoint is added later.
    const chargedMicros = holdId
      ? (
          await capture(pool, {
            holdId,
            actualMicros: estimate.estimatedMicros,
            idempotencyKey: `capture-${params.idempotencyKey}`,
            revenueAccountId: params.revenueAccountId,
          })
        ).chargedMicros
      : 0; // free endpoint — nothing was ever held, so there is nothing to capture
    await pool.query(
      "UPDATE runs SET state = 'succeeded', actual_micros = $1, latency_ms = $2, result = $3 WHERE id = $4",
      [chargedMicros, response.latencyMs, storePayloads ? JSON.stringify(response.body) : null, runId]
    );
    return {
      runId,
      state: "succeeded",
      result: response.body,
      receipt: { estimatedMicros: estimate.estimatedMicros, chargedMicros, currency: pricing.currency },
      latencyMs: response.latencyMs,
    };
  }

  // Non-2xx upstream response — same zero-charge rule as a network failure.
  if (holdId) await release(pool, holdId);
  const errorMessage = `Upstream returned ${response.status}`;
  await pool.query(
    "UPDATE runs SET state = 'failed', error_class = $1, error_message = $2, latency_ms = $3 WHERE id = $4",
    ["UpstreamHttpError", errorMessage, response.latencyMs, runId]
  );
  return {
    runId,
    state: "failed",
    errorClass: "UpstreamHttpError",
    errorMessage,
    receipt: { estimatedMicros: estimate.estimatedMicros, chargedMicros: 0, currency: pricing.currency },
    latencyMs: response.latencyMs,
  };
}
