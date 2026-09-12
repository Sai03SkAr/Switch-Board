import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { getPool } from "@switchboard/db";
import { LocalHashEmbedding, discover, estimateCost, DEFAULT_WEIGHTS, type PricingModel } from "@switchboard/core";

const app = Fastify({ logger: true });
const pool = getPool();
const embedder = new LocalHashEmbedding();

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

app.get("/healthz", async () => ({ ok: true }));

const port = Number(process.env.PORT ?? 3000);
app.listen({ port, host: "127.0.0.1" }).then(() => {
  app.log.info(`SwitchBoard API listening on http://127.0.0.1:${port}`);
});
