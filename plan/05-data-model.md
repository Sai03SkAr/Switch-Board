# 05 — Data model and the ledger

Postgres throughout. `pgvector` for embeddings. This is a **specification**, not
migration code — schema is written as DDL because that is the clearest way to state it.

## Money representation

```
All amounts are BIGINT micro-dollars.  1_000_000 = $1.00
```

Never `float`. Never `double`. Never do money arithmetic outside the ledger module.
Store the currency code even if you only ever support USD — retrofitting currency is
miserable.

## Core tables

### Tenancy and auth

```sql
CREATE TABLE workspaces (
  id              UUID PRIMARY KEY,
  name            TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- privacy posture: the differentiator from 02-weaknesses #1
  store_payloads  BOOLEAN NOT NULL DEFAULT false,
  payload_ttl_days INT,                     -- NULL = do not store
  rank_weights    JSONB                     -- per-workspace ranking override
);

CREATE TABLE api_keys (
  id              UUID PRIMARY KEY,
  workspace_id    UUID NOT NULL REFERENCES workspaces(id),
  name            TEXT NOT NULL,
  key_hash        TEXT NOT NULL UNIQUE,     -- store the hash, never the key
  key_prefix      TEXT NOT NULL,            -- for display: "sw_live_a1b2..."
  mode            TEXT NOT NULL,            -- 'managed' | 'byok'
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at      TIMESTAMPTZ
);
```

### Catalogue

```sql
CREATE TABLE providers (
  id              UUID PRIMARY KEY,
  slug            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  base_url        TEXT NOT NULL,
  auth_type       TEXT NOT NULL,            -- 'bearer' | 'header' | 'query' | 'oauth'
  status          TEXT NOT NULL DEFAULT 'active',
  resale_allowed  BOOLEAN NOT NULL,         -- see 09-risks.md; block ingestion if false
  tos_url         TEXT,
  reviewed_at     TIMESTAMPTZ
);

CREATE TABLE endpoints (
  id              UUID PRIMARY KEY,
  provider_id     UUID NOT NULL REFERENCES providers(id),
  slug            TEXT NOT NULL,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL,
  categories      TEXT[] NOT NULL DEFAULT '{}',
  example_queries TEXT[] NOT NULL DEFAULT '{}',   -- boosts discovery recall

  input_schema    JSONB NOT NULL,           -- JSON Schema; validated before any spend
  output_schema   JSONB,

  pricing         JSONB NOT NULL,           -- normalized; see below
  upstream_path   TEXT NOT NULL,
  upstream_method TEXT NOT NULL,
  timeout_ms      INT NOT NULL DEFAULT 30000,

  status          TEXT NOT NULL DEFAULT 'draft',  -- draft|active|deprecated|quarantined
  embedding       VECTOR(1536),
  search_tsv      TSVECTOR,
  UNIQUE (provider_id, slug)
);

CREATE INDEX ON endpoints USING hnsw (embedding vector_cosine_ops);
CREATE INDEX ON endpoints USING gin (search_tsv);
```

### The normalized pricing model

This directly fixes [02-weaknesses.md](02-weaknesses.md) #4. One shape covers all five
of Monid's variants, and every one must produce a dollar figure for a *specific* call.

```jsonc
{
  "model": "PER_CALL",            // PER_CALL | PER_RESULT | PER_UNIT | TIERED | MATRIX
  "currency": "USD",
  "base_micros": 900,             // $0.0009
  "unit": null,                   // e.g. "character" | "result" | "minute"
  "unit_micros": null,
  "unit_divisor": null,           // e.g. 1000000 for per-million-characters
  "tiers": null,                  // [{ "up_to": 1000, "micros": 900 }, ...]
  "max_possible_micros": 900,     // REQUIRED: the reserve amount
  "estimator": "static"           // static | from_args | from_response
}
```

**Rules:**
- `max_possible_micros` is mandatory. It is what gets reserved. No endpoint enters the
  catalogue without it — this is what prevents the $5.50 surprise.
- Human-readable price strings are **generated** from this object, never hand-written.
  That is how you avoid "$60" meaning per-million-characters.
- `estimator: from_response` means actual cost is known only after the call; reserve
  `max_possible_micros` and capture the real figure.

### Pricing model rules — refined by the Phase 0 spike (12 Sep 2026)

Three rules added after spiking 3 real providers against this schema. Full derivation in
[13-normalization-spike.md](13-normalization-spike.md).

1. **`base_micros` always means "our actual cost per call," never the provider's
   headline number.** Most real APIs bill via a monthly subscription with an included
   quota, not true pay-as-you-go. For those, `base_micros = plan_cost / included_quota`,
   computed at ingestion and re-derived whenever the plan changes.
2. **For a `from_args` estimator, `max_possible_micros = unit_micros × the endpoint's
   enforced maximum input size`** — and that maximum must be a real constraint in
   `input_schema` (e.g. `maxLength`), checked by the executor's validation step, not just
   written in a description. An endpoint with no enforceable input cap cannot be
   onboarded — there is no way to bound the hold.
3. **`TIERED` in v1 means tiered by this call's own argument size, not by cumulative
   monthly volume.** Cumulative-volume tiering (the common SaaS pattern: price depends on
   how much the whole workspace already used this billing period) needs a
   `provider_usage_counters` table this schema does not yet have. Providers priced that
   way are out of scope for v1's catalogue — not just for the ToS reasons in
   [12-provider-shortlist.md](12-provider-shortlist.md), but because the metering model
   doesn't support it correctly yet.

### Health telemetry

```sql
CREATE TABLE health_samples (
  id            BIGSERIAL PRIMARY KEY,
  endpoint_id   UUID NOT NULL REFERENCES endpoints(id),
  probed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  ok            BOOLEAN NOT NULL,
  latency_ms    INT,
  status_code   INT,
  error_class   TEXT
);
CREATE INDEX ON health_samples (endpoint_id, probed_at DESC);
```

Roll up into a materialized view for `success_rate_7d` and `p95_latency_7d`. Feeds both
the ranker and the public status page.

---

## The ledger

### Invariants — enforce these in tests

1. **Every transaction balances**: `SUM(amount_micros) = 0` across its entries.
2. **Entries are immutable.** Corrections are new compensating entries, never `UPDATE`.
3. **A hold is captured or released exactly once.** Enforced by DB constraint.
4. **`captured <= held`.** Never charge more than was reserved.
5. **Available balance** = `deposits - captures - active_holds`. Never a stored counter
   that can drift — derive it, then cache it if profiling demands.
6. **Failure charges zero.** No exceptions, no partial fees.

### Schema

```sql
CREATE TABLE accounts (
  id            UUID PRIMARY KEY,
  workspace_id  UUID REFERENCES workspaces(id),
  kind          TEXT NOT NULL,   -- 'user_balance'|'revenue'|'provider_payable'|'promo'
  currency      CHAR(3) NOT NULL DEFAULT 'USD',
  UNIQUE (workspace_id, kind, currency)
);

CREATE TABLE transactions (
  id              UUID PRIMARY KEY,
  kind            TEXT NOT NULL,        -- 'deposit'|'capture'|'refund'|'adjustment'
  idempotency_key TEXT NOT NULL UNIQUE, -- the anti-double-charge guarantee
  run_id          UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata        JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE ledger_entries (
  id              BIGSERIAL PRIMARY KEY,
  transaction_id  UUID NOT NULL REFERENCES transactions(id),
  account_id      UUID NOT NULL REFERENCES accounts(id),
  amount_micros   BIGINT NOT NULL,   -- signed; debits negative, credits positive
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ON ledger_entries (account_id, id);

CREATE TABLE holds (
  id              UUID PRIMARY KEY,
  account_id      UUID NOT NULL REFERENCES accounts(id),
  amount_micros   BIGINT NOT NULL CHECK (amount_micros > 0),
  state           TEXT NOT NULL DEFAULT 'active',  -- active|captured|released
  run_id          UUID,
  idempotency_key TEXT NOT NULL UNIQUE,
  expires_at      TIMESTAMPTZ NOT NULL,   -- reaper releases past this
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at      TIMESTAMPTZ,
  CHECK ((state = 'active') = (settled_at IS NULL))
);
CREATE INDEX ON holds (state, expires_at);
```

### Operations

```
reserve(account, amount, idem_key, ttl) -> hold_id
    Fails with INSUFFICIENT_FUNDS if available_balance < amount.
    Replaying idem_key returns the existing hold. Never creates a second.

capture(hold_id, actual_micros, idem_key)
    Requires actual <= hold.amount. Writes a balanced transaction:
      user_balance      -actual
      provider_payable  +provider_cost
      revenue           +(actual - provider_cost)
    Marks hold 'captured'. Releases the unused remainder implicitly.

release(hold_id)
    Marks hold 'released'. Writes NO ledger entries — nothing was ever charged.
```

**The reaper**: a worker that releases `active` holds past `expires_at`. This is what
makes a crash between reserve and capture safe. Without it, a process that dies
mid-flight strands a user's funds forever. Set TTL to `timeout_ms * 2 + slack`.

### Deriving balance

```sql
-- available balance for an account
SELECT
  COALESCE((SELECT SUM(amount_micros) FROM ledger_entries WHERE account_id = $1), 0)
- COALESCE((SELECT SUM(amount_micros) FROM holds
            WHERE account_id = $1 AND state = 'active'), 0) AS available_micros;
```

---

## Budgets — the differentiator

Four scopes. A call must pass **all** applicable ones.

```sql
CREATE TABLE budgets (
  id            UUID PRIMARY KEY,
  workspace_id  UUID NOT NULL REFERENCES workspaces(id),
  scope         TEXT NOT NULL,     -- 'workspace'|'key'|'session'|'call'
  scope_id      TEXT,              -- api_key id, session id, or NULL
  limit_micros  BIGINT NOT NULL,
  window        TEXT NOT NULL,     -- 'total'|'daily'|'monthly'|'per_call'
  action        TEXT NOT NULL DEFAULT 'block',  -- 'block'|'require_confirmation'
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, scope, scope_id, window)
);

CREATE TABLE budget_usage (
  budget_id     UUID NOT NULL REFERENCES budgets(id),
  window_start  DATE NOT NULL,
  spent_micros  BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (budget_id, window_start)
);
```

`scope='call'` with `action='require_confirmation'` is the guard against the
$2.00–$5.50 surprise. Default it to something small (say $0.10) for new workspaces —
a safe default is itself a trust signal.

## Runs

```sql
CREATE TABLE runs (
  id                UUID PRIMARY KEY,
  workspace_id      UUID NOT NULL REFERENCES workspaces(id),
  api_key_id        UUID REFERENCES api_keys(id),
  session_id        TEXT,
  endpoint_id       UUID NOT NULL REFERENCES endpoints(id),
  state             TEXT NOT NULL,   -- pending|running|succeeded|failed|stopped
  idempotency_key   TEXT NOT NULL UNIQUE,

  estimated_micros  BIGINT NOT NULL,
  actual_micros     BIGINT,
  provider_micros   BIGINT,
  fee_micros        BIGINT,
  direct_price_micros BIGINT,        -- for the transparency receipt

  args_hash         TEXT NOT NULL,   -- always stored
  args              JSONB,           -- ONLY if workspace.store_payloads
  result            JSONB,           -- ONLY if workspace.store_payloads
  purge_after       TIMESTAMPTZ,     -- enforced by a purge worker

  latency_ms        INT,
  error_class       TEXT,
  score_breakdown   JSONB,           -- why this endpoint was chosen
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Storing `args_hash` unconditionally but `args` conditionally is what lets you offer
replay and debugging **without** retaining customer payloads — the concrete mechanism
behind the privacy claim in [03-positioning.md](03-positioning.md).

## Test suite you must write before shipping money

Non-negotiable. These are the tests that make the product trustworthy:

- Concurrent `reserve` on the same balance never over-commits (run it 1000× parallel)
- Replayed idempotency key charges exactly once
- Upstream 500 → balance unchanged, to the micro-dollar
- Crash between reserve and capture → reaper restores full balance
- `actual > reserved` → capture clamps and raises a variance alert
- Sum of all `ledger_entries.amount_micros` per transaction is always 0
- Budget at each of the 4 scopes blocks correctly, and reports which one tripped
- A retry loop hits the session cap and stops (the headline demo, as a test)
