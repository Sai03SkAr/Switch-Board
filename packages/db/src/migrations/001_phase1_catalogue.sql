-- Phase 1 schema: catalogue + discovery only (plan/07-roadmap.md).
-- Ledger, accounts, holds, runs, and budgets are Phase 2/3 — not created here on purpose,
-- so this migration matches what Phase 1 actually needs, not the full plan/05-data-model.md
-- schema ahead of time.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- NOTE: dimension is 256 to match packages/core/src/embeddings.ts's LocalHashEmbedding
-- placeholder (see the warning at the top of that file). Swapping to a real embedding
-- model (Voyage voyage-3 = 1024 dims, OpenAI text-embedding-3-small = 1536 dims) requires
-- an ALTER COLUMN on this table's embedding column and a full re-embed — not a small change,
-- so do it once, deliberately, before Phase 5, not incrementally.

CREATE TABLE providers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  base_url        TEXT NOT NULL,
  auth_type       TEXT NOT NULL,            -- 'bearer' | 'header' | 'query' | 'oauth' | 'none'
  status          TEXT NOT NULL DEFAULT 'active',
  resale_allowed  BOOLEAN NOT NULL,         -- see plan/12-provider-shortlist.md — required, human-reviewed
  resale_note     TEXT,                     -- the evidence/quote backing resale_allowed
  tos_url         TEXT,
  reviewed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE endpoints (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id     UUID NOT NULL REFERENCES providers(id),
  slug            TEXT NOT NULL,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL,
  categories      TEXT[] NOT NULL DEFAULT '{}',
  example_queries TEXT[] NOT NULL DEFAULT '{}',

  input_schema    JSONB NOT NULL,
  output_schema   JSONB,

  pricing         JSONB NOT NULL,           -- see packages/core/src/pricing.ts PricingModel shape
  upstream_path   TEXT NOT NULL,
  upstream_method TEXT NOT NULL,
  timeout_ms      INT NOT NULL DEFAULT 30000,

  status          TEXT NOT NULL DEFAULT 'active',  -- draft|active|deprecated|quarantined
  embedding       VECTOR(256),
  search_tsv      TSVECTOR,                 -- populated by trigger below, not GENERATED —
                                             -- to_tsvector() is STABLE not IMMUTABLE in
                                             -- Postgres (dictionaries can change), which
                                             -- Postgres refuses for a GENERATED column.
                                             -- A trigger is the standard workaround.

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider_id, slug)
);

CREATE FUNCTION endpoints_search_tsv_update() RETURNS trigger AS $$
BEGIN
  NEW.search_tsv := to_tsvector('english',
    coalesce(NEW.name, '') || ' ' ||
    coalesce(NEW.description, '') || ' ' ||
    array_to_string(coalesce(NEW.categories, '{}'), ' ') || ' ' ||
    array_to_string(coalesce(NEW.example_queries, '{}'), ' ')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER endpoints_search_tsv_trigger
  BEFORE INSERT OR UPDATE ON endpoints
  FOR EACH ROW EXECUTE FUNCTION endpoints_search_tsv_update();

CREATE INDEX endpoints_embedding_hnsw ON endpoints USING hnsw (embedding vector_cosine_ops);
CREATE INDEX endpoints_search_tsv_gin ON endpoints USING gin (search_tsv);
CREATE INDEX endpoints_status_idx ON endpoints (status);

CREATE TABLE health_samples (
  id            BIGSERIAL PRIMARY KEY,
  endpoint_id   UUID NOT NULL REFERENCES endpoints(id),
  probed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  ok            BOOLEAN NOT NULL,
  latency_ms    INT,
  status_code   INT,
  error_class   TEXT
);
CREATE INDEX health_samples_endpoint_probed_idx ON health_samples (endpoint_id, probed_at DESC);

-- Rolling 7-day health, feeds the ranker's reliability/latency scores directly.
CREATE VIEW endpoint_health_7d AS
SELECT
  endpoint_id,
  COUNT(*) FILTER (WHERE ok) AS successes,
  COUNT(*) AS samples,
  COALESCE(COUNT(*) FILTER (WHERE ok)::float / NULLIF(COUNT(*), 0), 1.0) AS success_rate_7d,
  COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE ok), 0) AS p95_latency_ms,
  MAX(probed_at) AS last_probed_at
FROM health_samples
WHERE probed_at > now() - INTERVAL '7 days'
GROUP BY endpoint_id;
