-- Phase 2: the ledger. Money moves correctly, or nothing else in this project matters.
-- See plan/05-data-model.md for the original design and PROGRESS.md for what changed
-- while actually building it — concurrency correctness needed one concrete mechanism the
-- prose spec didn't pin down, and it's documented below rather than left implicit.

CREATE TABLE workspaces (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL,
  store_payloads   BOOLEAN NOT NULL DEFAULT false,
  payload_ttl_days INT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 'user_balance' = one per workspace. 'revenue' and 'external_funding' are singleton
-- system accounts (workspace_id NULL) — see the note on deposits below for why
-- external_funding exists: every transaction, including a deposit, must sum to exactly
-- zero, with no special-cased exceptions. That's the strict reading of the invariant in
-- plan/05-data-model.md, and Phase 2 keeps it strict rather than carving out an exception.
CREATE TABLE accounts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID REFERENCES workspaces(id),
  kind          TEXT NOT NULL CHECK (kind IN ('user_balance', 'revenue', 'external_funding')),
  currency      CHAR(3) NOT NULL DEFAULT 'USD',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, kind, currency)
);

-- The UNIQUE constraint above does NOT make 'revenue'/'external_funding' true singletons:
-- Postgres treats NULL <> NULL for uniqueness purposes, so two rows with
-- workspace_id=NULL would NOT violate it. A second 'revenue' account is a real
-- accounting bug (funds could be summed against the wrong one). This partial index is
-- what actually enforces "at most one of each system account, ever."
CREATE UNIQUE INDEX accounts_system_singleton_idx ON accounts (kind, currency) WHERE workspace_id IS NULL;

CREATE TABLE transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            TEXT NOT NULL CHECK (kind IN ('deposit', 'capture', 'refund', 'adjustment')),
  idempotency_key TEXT NOT NULL UNIQUE,
  run_id          UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata        JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE ledger_entries (
  id              BIGSERIAL PRIMARY KEY,
  transaction_id  UUID NOT NULL REFERENCES transactions(id),
  account_id      UUID NOT NULL REFERENCES accounts(id),
  amount_micros   BIGINT NOT NULL, -- signed; debits negative, credits positive
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entries_account_idx ON ledger_entries (account_id, id);
CREATE INDEX ledger_entries_transaction_idx ON ledger_entries (transaction_id);

CREATE TABLE holds (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts(id),
  amount_micros   BIGINT NOT NULL CHECK (amount_micros > 0),
  state           TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'captured', 'released')),
  run_id          UUID,
  idempotency_key TEXT NOT NULL UNIQUE,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at      TIMESTAMPTZ,
  CHECK ((state = 'active') = (settled_at IS NULL))
);
CREATE INDEX holds_account_idx ON holds (account_id);
CREATE INDEX holds_reaper_idx ON holds (state, expires_at) WHERE state = 'active';

CREATE TABLE runs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        UUID NOT NULL REFERENCES workspaces(id),
  endpoint_id         UUID NOT NULL REFERENCES endpoints(id),
  hold_id             UUID REFERENCES holds(id),
  state               TEXT NOT NULL CHECK (state IN ('pending', 'succeeded', 'failed', 'stopped')),
  idempotency_key     TEXT NOT NULL UNIQUE,
  estimated_micros    BIGINT NOT NULL,
  actual_micros       BIGINT,
  args_hash           TEXT NOT NULL,
  args                JSONB, -- only populated if workspaces.store_payloads is true
  result              JSONB, -- only populated if workspaces.store_payloads is true
  latency_ms          INT,
  error_class         TEXT,
  error_message       TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX runs_workspace_idx ON runs (workspace_id, created_at DESC);

-- Two singleton system accounts. Bootstrapped once here rather than lazily in app code,
-- so their ids are stable and every environment has exactly one of each.
INSERT INTO accounts (workspace_id, kind, currency) VALUES (NULL, 'revenue', 'USD');
INSERT INTO accounts (workspace_id, kind, currency) VALUES (NULL, 'external_funding', 'USD');
