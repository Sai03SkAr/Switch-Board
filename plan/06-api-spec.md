# 06 — API specification

Three surfaces over one core: **REST**, **MCP**, **CLI**. The MCP server is a thin
adapter over REST — never a second implementation.

Base: `https://api.<yourdomain>/v1`
Auth: `Authorization: Bearer sw_live_...` or OAuth 2.0 bearer token.
Every mutating call requires `Idempotency-Key`.

## Conventions

- All money fields are integer **micro-dollars**, suffixed `_micros`, plus a
  human-readable `_display` string generated from the same source.
- Every response carries `request_id`.
- Errors: `{ "error": { "code": "...", "message": "...", "details": {...} } }`

---

## `POST /v1/discover`

Natural-language search. **Moves no money.**

```jsonc
// request
{
  "query": "get the current weather for a city",
  "limit": 5,
  "max_price_micros": 5000,        // optional hard filter
  "categories": ["weather"],       // optional
  "weights": {                     // optional per-call override
    "fit": 0.45, "price": 0.25, "reliability": 0.20,
    "latency": 0.05, "freshness": 0.05
  }
}
```

```jsonc
// response
{
  "request_id": "req_...",
  "candidates": [
    {
      "endpoint_id": "ep_...",
      "provider": "open-meteo",
      "name": "Current weather by coordinates",
      "description": "...",
      "estimated_cost_micros": 900,
      "estimated_cost_display": "$0.000900",
      "max_possible_cost_micros": 900,
      "pricing_explain": "Flat $0.0009 per call.",
      "health": { "success_rate_7d": 0.998, "p95_latency_ms": 410, "samples": 2016 },
      "cheapest_viable": true,
      "score": 0.91,
      "score_breakdown": {
        "fit": 0.94, "price": 1.00, "reliability": 0.998,
        "latency": 0.82, "freshness": 1.00,
        "weights_used": { "fit": 0.45, "price": 0.25, "...": "..." }
      }
    }
  ],
  "weights_used": { "...": "..." }
}
```

Two things Monid does not do, both cheap: `cheapest_viable` is always marked, and
`score_breakdown` is always returned and documented.

## `POST /v1/inspect`

```jsonc
// request
{ "endpoint_id": "ep_...", "args": { "city": "Panaji" } }   // args optional
```

```jsonc
// response
{
  "endpoint_id": "ep_...",
  "input_schema": { "...": "JSON Schema" },
  "output_schema": { "...": "..." },
  "pricing": {
    "model": "PER_CALL",
    "estimated_cost_micros": 900,          // for THESE args if supplied
    "max_possible_cost_micros": 900,
    "explain": "Flat $0.0009 per call. No per-unit component.",
    "direct_price_display": "$0.0009 + $49/mo provider subscription"
  },
  "requires_confirmation": false,
  "health": { "...": "..." },
  "provider": { "slug": "open-meteo", "tos_url": "...", "resale_allowed": true }
}
```

`explain` is a generated sentence, never hand-written. This is the fix for "$60" meaning
per-million-characters.

## `POST /v1/run`

The money path. `Idempotency-Key` **required**.

```jsonc
// request
{
  "endpoint_id": "ep_...",
  "args": { "city": "Panaji" },
  "session_id": "sess_agent_run_42",     // scopes the session budget
  "max_cost_micros": 2000,               // caller's own ceiling
  "confirmation_token": null,            // required if over threshold
  "dry_run": false                       // true = price it, do not execute
}
```

```jsonc
// 200 response
{
  "run_id": "run_...",
  "state": "succeeded",
  "result": { "...": "normalized provider payload" },
  "receipt": {
    "provider_cost_micros": 700,
    "fee_micros": 200,
    "total_micros": 900,
    "total_display": "$0.000900",
    "direct_price_micros": 900,
    "direct_note": "Going direct also requires a $49/mo plan.",
    "balance_after_micros": 4991200
  },
  "budget": {
    "session":   { "spent_micros": 3600, "limit_micros": 50000 },
    "key":       { "spent_micros": 128400, "limit_micros": 1000000 },
    "workspace": { "spent_micros": 128400, "limit_micros": null }
  },
  "latency_ms": 412,
  "endpoint_id": "ep_..."
}
```

The `receipt` block is the transparency lever from
[03-positioning.md](03-positioning.md). It costs almost nothing at design time and is
painful to retrofit — build it in Phase 2.

### Error responses that matter

```jsonc
// 402 — budget exceeded (note: says WHICH scope tripped)
{ "error": {
    "code": "BUDGET_EXCEEDED",
    "message": "Session budget exhausted.",
    "details": { "scope": "session", "limit_micros": 50000,
                 "spent_micros": 50000, "would_cost_micros": 900 }
} }

// 409 — needs confirmation
{ "error": {
    "code": "CONFIRMATION_REQUIRED",
    "message": "This call costs $5.50, above your $0.10 per-call threshold.",
    "details": { "estimated_cost_micros": 5500000,
                 "threshold_micros": 100000,
                 "confirmation_token": "cnf_...", "expires_in_s": 300 }
} }

// 502 — upstream failed. NOTHING WAS CHARGED.
{ "error": {
    "code": "UPSTREAM_ERROR",
    "message": "Provider returned 503 after 3 attempts.",
    "details": { "charged_micros": 0, "provider_status": 503 }
} }
```

Putting `charged_micros: 0` in the error body is a small thing that visibly reassures.

## Runs

```
GET  /v1/runs?session_id=&endpoint_id=&state=&from=&to=&cursor=
GET  /v1/runs/{id}
POST /v1/runs/{id}/stop
POST /v1/runs/{id}/replay        // re-executes from args_hash if payloads retained
```

## Wallet and budgets

```
GET  /v1/wallet/balance
     -> { available_micros, held_micros, currency, updated_at }

GET  /v1/wallet/activities?cursor=
     -> itemized ledger: deposits, captures, refunds, each linked to a run_id

GET  /v1/budgets
POST /v1/budgets
     { scope: "key"|"session"|"workspace"|"call",
       scope_id, limit_micros, window, action }
DELETE /v1/budgets/{id}

GET  /v1/wallet/export?format=csv        // the "you can leave" promise, made real
```

## Auth and admin

```
GET  /v1/auth/whoami
GET  /v1/auth/workspaces
GET  /v1/keys        POST /v1/keys        DELETE /v1/keys/{id}
GET  /v1/endpoints?cursor=               // live catalogue; powers the honest count
GET  /v1/status                          // public per-endpoint health
```

`GET /v1/endpoints` returning the count that the homepage displays — generated, not
typed — is the mechanism behind the calibrated-honesty play.

---

## MCP server

Streamable HTTP. Exposes exactly **three tools** to preserve context efficiency:

| Tool | Maps to |
|---|---|
| `discover` | `POST /v1/discover` |
| `inspect` | `POST /v1/inspect` |
| `run` | `POST /v1/run` |

Design notes:
- Keep descriptions short. These three descriptions are the entire prompt cost.
- `run` must surface `CONFIRMATION_REQUIRED` as readable text so the agent can relay it
  to the human rather than silently failing.
- Include the budget block in `run` output so the agent can *see itself* running out of
  money and stop gracefully. Agents reason better when the constraint is visible.
- Ship a `budget_status` resource (not a tool) so checking the balance costs no slot.

## CLI

```
sw discover "current weather for a city" --limit 5
sw inspect ep_abc --args '{"city":"Panaji"}'
sw run ep_abc --args '{"city":"Panaji"}' --max-cost 0.002 --session demo
sw run ep_abc --args '{...}' --dry-run          # price it, do not execute
sw runs list --session demo
sw runs get run_xyz
sw budget set --scope session --id demo --limit 0.05
sw wallet balance
sw wallet export --format csv > spend.csv
sw keys add --name laptop --mode byok
```

`--dry-run` and `budget set` are the two commands to put in the README's first ten lines.
