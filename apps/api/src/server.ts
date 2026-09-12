import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { getPool } from "@switchboard/db";
import {
  LocalHashEmbedding,
  discover,
  estimateCost,
  DEFAULT_WEIGHTS,
  run,
  FetchUpstreamClient,
  deposit,
  getAvailableBalance,
  InsufficientFundsError,
  EndpointNotFoundError,
  ValidationError,
  type PricingModel,
} from "@switchboard/core";

const app = Fastify({ logger: true });
const pool = getPool();
const embedder = new LocalHashEmbedding();
const upstreamClient = new FetchUpstreamClient();

// NOTE ON AUTH — a deliberate Phase 2 simplification, not an oversight: 06-api-spec.md
// envisions Bearer-token API keys mapping to a workspace, but the api_keys table and
// auth flow are Phase 4 (CLI/MCP) concerns, once there's a real caller identity that
// Phase 3's policy engine needs to enforce budgets against. Until then, these endpoints
// take workspace_id directly. Tracked in PROGRESS.md so it isn't mistaken for forgotten.

let revenueAccountIdCache: string | null = null;
async function getRevenueAccountId(): Promise<string> {
  if (!revenueAccountIdCache) {
    const { rows } = await pool.query("SELECT id FROM accounts WHERE kind = 'revenue'");
    revenueAccountIdCache = rows[0].id;
  }
  return revenueAccountIdCache!;
}
let externalFundingAccountIdCache: string | null = null;
async function getExternalFundingAccountId(): Promise<string> {
  if (!externalFundingAccountIdCache) {
    const { rows } = await pool.query("SELECT id FROM accounts WHERE kind = 'external_funding'");
    externalFundingAccountIdCache = rows[0].id;
  }
  return externalFundingAccountIdCache!;
}

async function getUserBalanceAccountId(workspaceId: string): Promise<string | null> {
  const { rows } = await pool.query("SELECT id FROM accounts WHERE workspace_id = $1 AND kind = 'user_balance'", [workspaceId]);
  return rows[0]?.id ?? null;
}

app.addHook("onRequest", async (req, reply) => {
  reply.header("x-request-id", randomUUID());
});

// ---------- POST /v1/discover ----------
app.post<{ Body: { query: string; limit?: number; weights?: typeof DEFAULT_WEIGHTS; args?: Record<string, unknown> } }>(
  "/v1/discover",
  async (req, reply) => {
    const { query, limit, weights, args } = req.body ?? {};
    if (!query || typeof query !== "string") {
      return reply.status(400).send({ error: { code: "INVALID_REQUEST", message: "query is required" } });
    }

    const candidates = await discover(pool, embedder, { query, limit, weights, args });

    return {
      request_id: reply.getHeader("x-request-id"),
      candidates: candidates.map((c) => ({
        endpoint_id: c.endpointId,
        provider: c.providerSlug,
        name: c.name,
        description: c.description,
        estimated_cost_micros: c.estimatedCostMicros,
        estimated_cost_display: c.estimatedCostDisplay,
        max_possible_cost_micros: c.maxPossibleCostMicros,
        pricing_explain: c.pricingExplain,
        health: {
          success_rate_7d: c.health.successRate7d,
          p95_latency_ms: c.health.p95LatencyMs,
          samples: c.health.samples,
        },
        cheapest_viable: c.cheapestViable,
        score: c.score,
        score_breakdown: c.scoreBreakdown,
      })),
      weights_used: weights ?? DEFAULT_WEIGHTS,
    };
  }
);

// ---------- POST /v1/inspect ----------
app.post<{ Body: { endpoint_id: string; args?: Record<string, unknown> } }>(
  "/v1/inspect",
  async (req, reply) => {
    const { endpoint_id, args } = req.body ?? {};
    if (!endpoint_id) {
      return reply.status(400).send({ error: { code: "INVALID_REQUEST", message: "endpoint_id is required" } });
    }

    const { rows } = await pool.query(
      `SELECT e.*, p.slug AS provider_slug, p.name AS provider_name, p.tos_url, p.resale_allowed,
              COALESCE(h.success_rate_7d, 1.0) AS success_rate_7d,
              COALESCE(h.p95_latency_ms, 500) AS p95_latency_ms
       FROM endpoints e
       JOIN providers p ON p.id = e.provider_id
       LEFT JOIN endpoint_health_7d h ON h.endpoint_id = e.id
       WHERE e.id = $1`,
      [endpoint_id]
    );

    if (rows.length === 0) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: "No such endpoint" } });
    }

    const row = rows[0];
    const pricing = row.pricing as PricingModel;

    let estimate;
    try {
      estimate = estimateCost(pricing, args);
    } catch (err) {
      return reply.status(400).send({ error: { code: "INVALID_ARGS", message: (err as Error).message } });
    }

    return {
      endpoint_id: row.id,
      name: row.name,
      description: row.description,
      input_schema: row.input_schema,
      pricing: {
        model: pricing.model,
        estimated_cost_micros: estimate.estimatedMicros,
        estimated_cost_display: `$${(estimate.estimatedMicros / 1_000_000).toFixed(6)}`,
        max_possible_cost_micros: estimate.maxPossibleMicros,
        explain: estimate.explain,
        is_exact: estimate.isExact,
      },
      health: { success_rate_7d: Number(row.success_rate_7d), p95_latency_ms: Number(row.p95_latency_ms) },
      provider: { slug: row.provider_slug, name: row.provider_name, tos_url: row.tos_url, resale_allowed: row.resale_allowed },
    };
  }
);

// ---------- GET /v1/endpoints — the honest, live catalogue count ----------
app.get("/v1/endpoints", async () => {
  const { rows } = await pool.query(
    `SELECT e.id, e.slug, e.name, p.slug AS provider_slug, e.status
     FROM endpoints e JOIN providers p ON p.id = e.provider_id
     ORDER BY p.slug, e.slug`
  );
  return { count: rows.length, endpoints: rows };
});

// ---------- POST /v1/workspaces — provisioning (Phase 2 stand-in; see auth note above) ----------
app.post<{ Body: { name: string } }>("/v1/workspaces", async (req, reply) => {
  const { name } = req.body ?? {};
  if (!name) return reply.status(400).send({ error: { code: "INVALID_REQUEST", message: "name is required" } });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const ws = await client.query("INSERT INTO workspaces (name) VALUES ($1) RETURNING id", [name]);
    const workspaceId = ws.rows[0].id;
    const acct = await client.query(
      "INSERT INTO accounts (workspace_id, kind, currency) VALUES ($1, 'user_balance', 'USD') RETURNING id",
      [workspaceId]
    );
    await client.query("COMMIT");
    return reply.status(201).send({ workspace_id: workspaceId, account_id: acct.rows[0].id });
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
});

// ---------- POST /v1/wallet/deposit — dev/test credit; no real payment processor exists
// yet (BYOK-only per plan/09-risks.md R1 — a managed balance would need one). Documented
// as a stand-in, same as ledger.ts's deposit() itself. ----------
app.post<{ Body: { workspace_id: string; amount_micros: number } }>("/v1/wallet/deposit", async (req, reply) => {
  const { workspace_id, amount_micros } = req.body ?? {};
  if (!workspace_id || !amount_micros || amount_micros <= 0) {
    return reply.status(400).send({ error: { code: "INVALID_REQUEST", message: "workspace_id and a positive amount_micros are required" } });
  }
  const accountId = await getUserBalanceAccountId(workspace_id);
  if (!accountId) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "No such workspace" } });

  const { transactionId } = await deposit(pool, {
    accountId,
    amountMicros: amount_micros,
    externalFundingAccountId: await getExternalFundingAccountId(),
    idempotencyKey: req.headers["idempotency-key"]?.toString() ?? randomUUID(),
  });
  return reply.status(201).send({ transaction_id: transactionId, balance_micros: await getAvailableBalance(pool, accountId) });
});

// ---------- GET /v1/wallet/balance ----------
app.get<{ Querystring: { workspace_id: string } }>("/v1/wallet/balance", async (req, reply) => {
  const { workspace_id } = req.query;
  if (!workspace_id) return reply.status(400).send({ error: { code: "INVALID_REQUEST", message: "workspace_id is required" } });
  const accountId = await getUserBalanceAccountId(workspace_id);
  if (!accountId) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "No such workspace" } });

  const available = await getAvailableBalance(pool, accountId);
  return { available_micros: available, currency: "USD" };
});

// ---------- GET /v1/wallet/activities — itemized ledger for this workspace's account ----------
app.get<{ Querystring: { workspace_id: string } }>("/v1/wallet/activities", async (req, reply) => {
  const { workspace_id } = req.query;
  if (!workspace_id) return reply.status(400).send({ error: { code: "INVALID_REQUEST", message: "workspace_id is required" } });
  const accountId = await getUserBalanceAccountId(workspace_id);
  if (!accountId) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "No such workspace" } });

  const { rows } = await pool.query(
    `SELECT le.id, t.kind, t.created_at, le.amount_micros, t.hold_id
     FROM ledger_entries le JOIN transactions t ON t.id = le.transaction_id
     WHERE le.account_id = $1 ORDER BY le.id DESC LIMIT 100`,
    [accountId]
  );
  return { activities: rows };
});

// ---------- POST /v1/run — the money path ----------
app.post<{
  Body: { endpoint_id: string; args: Record<string, unknown>; workspace_id: string; dry_run?: boolean };
}>("/v1/run", async (req, reply) => {
  const { endpoint_id, args, workspace_id, dry_run } = req.body ?? {};
  if (!endpoint_id || !workspace_id) {
    return reply.status(400).send({ error: { code: "INVALID_REQUEST", message: "endpoint_id and workspace_id are required" } });
  }
  const accountId = await getUserBalanceAccountId(workspace_id);
  if (!accountId) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "No such workspace" } });

  const idempotencyKey = req.headers["idempotency-key"]?.toString();
  if (!idempotencyKey && !dry_run) {
    return reply.status(400).send({ error: { code: "INVALID_REQUEST", message: "Idempotency-Key header is required for non-dry-run calls" } });
  }

  try {
    const result = await run(pool, upstreamClient, {
      endpointId: endpoint_id,
      args: args ?? {},
      idempotencyKey: idempotencyKey ?? randomUUID(),
      workspaceId: workspace_id,
      accountId,
      revenueAccountId: await getRevenueAccountId(),
      dryRun: dry_run,
    });

    return {
      run_id: result.runId,
      state: result.state,
      result: result.result,
      receipt: result.receipt && {
        charged_micros: result.receipt.chargedMicros,
        charged_display: `$${(result.receipt.chargedMicros / 1_000_000).toFixed(6)}`,
        estimated_micros: result.receipt.estimatedMicros,
      },
      error: result.errorClass ? { code: result.errorClass, message: result.errorMessage } : undefined,
      latency_ms: result.latencyMs,
    };
  } catch (err) {
    if (err instanceof EndpointNotFoundError) {
      return reply.status(404).send({ error: { code: "NOT_FOUND", message: err.message } });
    }
    if (err instanceof ValidationError) {
      return reply.status(400).send({ error: { code: "INVALID_ARGS", message: err.message, details: err.details } });
    }
    if (err instanceof InsufficientFundsError) {
      return reply.status(402).send({ error: { code: "INSUFFICIENT_FUNDS", message: err.message } });
    }
    throw err;
  }
});

// ---------- GET /v1/runs ----------
app.get<{ Querystring: { workspace_id: string } }>("/v1/runs", async (req, reply) => {
  const { workspace_id } = req.query;
  if (!workspace_id) return reply.status(400).send({ error: { code: "INVALID_REQUEST", message: "workspace_id is required" } });
  const { rows } = await pool.query(
    "SELECT id, endpoint_id, state, estimated_micros, actual_micros, latency_ms, created_at FROM runs WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 50",
    [workspace_id]
  );
  return { runs: rows };
});

// ---------- GET /v1/runs/{id} ----------
app.get<{ Params: { id: string } }>("/v1/runs/:id", async (req, reply) => {
  const { rows } = await pool.query("SELECT * FROM runs WHERE id = $1", [req.params.id]);
  if (rows.length === 0) return reply.status(404).send({ error: { code: "NOT_FOUND", message: "No such run" } });
  return rows[0];
});

app.get("/healthz", async () => ({ ok: true }));

const port = Number(process.env.PORT ?? 3000);
app.listen({ port, host: "127.0.0.1" }).then(() => {
  app.log.info(`SwitchBoard API listening on http://127.0.0.1:${port}`);
});
