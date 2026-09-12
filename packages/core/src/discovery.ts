/**
 * Hybrid discovery: BM25 (Postgres full-text) ∪ vector kNN (pgvector), deduped, ranked.
 * See plan/04-architecture.md "Discovery".
 */

import type pg from "pg";
import { estimateCost, type PricingModel } from "./pricing.js";
import { rankCandidates, DEFAULT_WEIGHTS, type RankWeights, type RankedCandidate } from "./ranker.js";
import type { EmbeddingProvider } from "./embeddings.js";

export interface DiscoverOptions {
  query: string;
  limit?: number;
  weights?: RankWeights;
  args?: Record<string, unknown>; // optional, sharpens cost estimates for TIERED/PER_UNIT
}

export interface DiscoverCandidate {
  endpointId: string;
  providerSlug: string;
  name: string;
  description: string;
  estimatedCostMicros: number;
  estimatedCostDisplay: string;
  maxPossibleCostMicros: number;
  pricingExplain: string;
  health: { successRate7d: number; p95LatencyMs: number; samples: number };
  cheapestViable: boolean;
  score: number;
  scoreBreakdown: RankedCandidate["scoreBreakdown"];
}

const RETRIEVAL_POOL_SIZE = 50;

export async function discover(
  pool: pg.Pool,
  embedder: EmbeddingProvider,
  opts: DiscoverOptions
): Promise<DiscoverCandidate[]> {
  const limit = opts.limit ?? 5;
  const queryEmbedding = await embedder.embed(opts.query);
  const vectorLiteral = `[${queryEmbedding.join(",")}]`;

  // BM25 ∪ vector kNN, combined via Reciprocal Rank Fusion (RRF), not raw-score MAX.
  //
  // Bug fixed here: ts_rank_cd (BM25) is unbounded and typically ~0.01–0.5; vector
  // similarity (1 - cosine_distance) is bounded to [-1, 1]. Combining those two numbers
  // with MAX(fit), as an earlier version of this function did, silently let whichever
  // retrieval method happened to produce a numerically larger raw score win — a
  // meaningless comparison across incompatible scales, decided before any normalization
  // ran. RRF sidesteps the whole problem: it only uses each method's RANK ORDER (1st,
  // 2nd, 3rd...), never the raw score, so nothing needs to be on a comparable scale.
  // score(d) = Σ 1/(k + rank), k=60 is the standard constant from the original RRF paper
  // and what Elasticsearch/OpenSearch use for hybrid search for this exact reason.
  const RRF_K = 60;
  const { rows } = await pool.query(
    `
    WITH bm25 AS (
      SELECT e.id, ROW_NUMBER() OVER (ORDER BY ts_rank_cd(e.search_tsv, plainto_tsquery('english', $1)) DESC) AS rank
      FROM endpoints e
      WHERE e.status = 'active' AND e.search_tsv @@ plainto_tsquery('english', $1)
      LIMIT $2
    ),
    vector AS (
      SELECT e.id, ROW_NUMBER() OVER (ORDER BY e.embedding <=> $3::vector ASC) AS rank
      FROM endpoints e
      WHERE e.status = 'active'
      LIMIT $2
    ),
    pool AS (
      SELECT id, SUM(1.0 / ($4 + rank)) AS fit
      FROM (SELECT * FROM bm25 UNION ALL SELECT * FROM vector) u
      GROUP BY id
    )
    SELECT
      e.id, e.slug, e.name, e.description, e.pricing,
      p.slug AS provider_slug,
      pool.fit,
      COALESCE(h.success_rate_7d, 1.0) AS success_rate_7d,
      COALESCE(h.p95_latency_ms, 500) AS p95_latency_ms,
      COALESCE(h.samples, 0) AS samples,
      COALESCE(EXTRACT(DAY FROM now() - h.last_probed_at), 30) AS days_since_verified
    FROM pool
    JOIN endpoints e ON e.id = pool.id
    JOIN providers p ON p.id = e.provider_id
    LEFT JOIN endpoint_health_7d h ON h.endpoint_id = e.id
    `,
    [opts.query, RETRIEVAL_POOL_SIZE, vectorLiteral, RRF_K]
  );

  // RRF scores are already on one consistent scale (unlike the old MAX-of-raw-scores),
  // so min-max normalizing them across this query's candidate set is now a principled
  // operation rather than papering over an upstream scale mismatch.
  const fits = rows.map((r) => Number(r.fit));
  const minFit = Math.min(...fits, 0);
  const maxFit = Math.max(...fits, 1e-9);
  const normalizeFit = (f: number) => (maxFit === minFit ? 1 : (f - minFit) / (maxFit - minFit));

  // Bug fixed here: estimateCost() can throw — e.g. a PER_UNIT/TIERED endpoint whose
  // required arg the caller didn't supply (they were probably targeting a *different*
  // candidate). That used to be unguarded inside this map, so one incompatible candidate
  // threw and took the ENTIRE /v1/discover request down with it. Now it's caught and that
  // one candidate is dropped from ranking instead — everything else still returns.
  const priced = rows.flatMap((r) => {
    const pricing = r.pricing as PricingModel;
    try {
      const estimate = estimateCost(pricing, opts.args);
      return [{ row: r, pricing, estimate }];
    } catch {
      return [];
    }
  });

  const ranked = rankCandidates(
    priced.map(({ row, estimate }) => ({
      endpointId: row.id,
      semanticFit: normalizeFit(Number(row.fit)),
      estimatedCostMicros: estimate.estimatedMicros,
      successRate7d: Number(row.success_rate_7d),
      p95LatencyMs: Number(row.p95_latency_ms),
      daysSinceLastVerified: Number(row.days_since_verified),
    })),
    opts.weights ?? DEFAULT_WEIGHTS
  );

  const byId = new Map(priced.map((p) => [p.row.id, p]));

  return ranked.slice(0, limit).map((r): DiscoverCandidate => {
    const { row, pricing, estimate } = byId.get(r.endpointId)!;
    return {
      endpointId: row.id,
      providerSlug: row.provider_slug,
      name: row.name,
      description: row.description,
      estimatedCostMicros: estimate.estimatedMicros,
      estimatedCostDisplay: microsDisplay(estimate.estimatedMicros),
      maxPossibleCostMicros: estimate.maxPossibleMicros,
      pricingExplain: estimate.explain,
      health: {
        successRate7d: Number(row.success_rate_7d),
        p95LatencyMs: Number(row.p95_latency_ms),
        samples: Number(row.samples),
      },
      cheapestViable: r.cheapestViable,
      score: r.score,
      scoreBreakdown: r.scoreBreakdown,
    };
  });
}

function microsDisplay(micros: number): string {
  const dollars = micros / 1_000_000;
  const decimals = Math.abs(dollars) < 0.01 && dollars !== 0 ? 6 : 2;
  return `$${dollars.toFixed(decimals)}`;
}
