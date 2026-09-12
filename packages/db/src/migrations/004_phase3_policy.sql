-- Phase 3: the policy engine and budget hierarchy. This is the project's headline
-- differentiator per plan/03-positioning.md — a workspace/key/session/call budget
-- hierarchy is the direct fix for the "one balance, no per-key caps" gap documented in
-- plan/02-weaknesses.md #2.
--
-- api_keys is deliberately minimal here — just enough structure to be a budget scope.
-- Real key generation, hashing, and Bearer-token HTTP auth are Phase 4 (CLI/MCP) work,
-- once there's a real caller identity to wire it to. See PROGRESS.md's Phase 2 note on
-- the same pattern (workspace_id accepted directly in REST bodies for now).

CREATE TABLE api_keys (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id),
  name         TEXT NOT NULL,
  revoked_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Budgets are looked up by scope + window. Column is named `window_kind`, not `window` —
-- WINDOW is a reserved word in Postgres (window functions), and quoting it forever in
-- every query is worse than just not using the reserved name. Spend for a window is
-- DERIVED from `runs` directly (SUM of actual_micros for succeeded runs in scope, within
-- the window), the same "derive it, don't cache a counter that can drift" principle the
-- ledger itself uses — see ledger.ts's doc comment. This deliberately diverges from the
-- plan/05-data-model.md's original `budget_usage` cache-table proposal: a derived SUM
-- avoids an entire class of "did every code path correctly increment the cache" bugs,
-- and at this project's scale there is no performance reason yet to accept that risk.
CREATE TABLE budgets (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id),
  scope         TEXT NOT NULL CHECK (scope IN ('workspace', 'key', 'session', 'call')),
  scope_id      TEXT, -- api_keys.id for 'key', a caller-supplied session token for 'session', NULL for 'workspace'/'call'
  limit_micros  BIGINT NOT NULL CHECK (limit_micros >= 0),
  window_kind        TEXT NOT NULL CHECK (window_kind IN ('total', 'daily', 'monthly', 'per_call')),
  action        TEXT NOT NULL DEFAULT 'block' CHECK (action IN ('block', 'require_confirmation')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, scope, scope_id, window_kind)
);

-- Confirmation tokens for the NEEDS_CONFIRMATION flow (plan/06-api-spec.md's 409
-- response): a call priced above a 'require_confirmation' budget's threshold gets a
-- short-lived token instead of executing immediately; replaying the call WITH that token
-- lets it through once. Postgres-backed rather than in-memory, so it survives a process
-- restart and is testable the same way everything else in this project is.
CREATE TABLE confirmation_tokens (
  token           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL REFERENCES workspaces(id),
  endpoint_id     UUID NOT NULL REFERENCES endpoints(id),
  args_hash       TEXT NOT NULL, -- binds the token to the EXACT call it was issued for
  estimated_micros BIGINT NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  used_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX confirmation_tokens_cleanup_idx ON confirmation_tokens (expires_at) WHERE used_at IS NULL;

-- Needed so session- and key-scoped budgets can compute spend by querying runs directly.
ALTER TABLE runs ADD COLUMN session_id TEXT;
ALTER TABLE runs ADD COLUMN key_id UUID REFERENCES api_keys(id);
CREATE INDEX runs_session_idx ON runs (workspace_id, session_id) WHERE session_id IS NOT NULL;
CREATE INDEX runs_key_idx ON runs (key_id) WHERE key_id IS NOT NULL;
