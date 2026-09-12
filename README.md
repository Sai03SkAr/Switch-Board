# SwitchBoard

An agent-native tool router with a governance-first take on Monid: price-aware ranking,
verified provider terms, a real double-entry ledger, and a budget hierarchy an agent
can't spend past. Full planning set (teardown, architecture, roadmap) lives in
[`plan/`](plan/README.md); a living account of what's actually built, phase by phase,
lives in [`PROGRESS.md`](PROGRESS.md).

**Status: Phases 1–4 complete, Phase 5 mostly complete** — catalogue, discovery, ledger,
policy engine, MCP server, and CLI are all real, tested, and verified against a live
Postgres. [ARCHITECTURE.md](ARCHITECTURE.md) explains the decisions worth defending;
[TESTING.md](TESTING.md) explains what the tests actually prove. Read
[PROGRESS.md](PROGRESS.md) for exactly what's built, including real bugs found and fixed
by actually running the code rather than trusting it because tests were green.

## What's real right now

- **17 endpoints, 8 providers**, all resale-verified against actual ToS —
  [plan/12-provider-shortlist.md](plan/12-provider-shortlist.md)
- **Hybrid discovery**: Postgres full-text (BM25) ∪ `pgvector` cosine similarity,
  combined via Reciprocal Rank Fusion, price-aware ranking with an always-returned
  `score_breakdown` — the direct fix for the ranking gap in
  [plan/02-weaknesses.md](plan/02-weaknesses.md)
- **A real double-entry ledger** — reserve/capture/release, proven under a genuine
  1,000-concurrent-request stress test against live Postgres (exactly 100/1,000 succeed
  against a balance sized for 100, every time), idempotent, every transaction's entries
  sum to exactly zero, verified independently after every test run. Measured throughput:
  **~588 full reserve+capture cycles/sec** against a local Postgres instance with a
  50-connection pool — see [TESTING.md](TESTING.md) for how this was measured
- **A workspace → key → session → call budget hierarchy** — the project's headline
  differentiator over a single undifferentiated balance
  ([plan/03-positioning.md](plan/03-positioning.md)) — with a confirmation-token flow for
  calls above a threshold, tested with a real 10-iteration agent retry loop that hits its
  cap and stops at exactly the right dollar amount
- **An MCP server** exposing exactly three tools (`discover`, `inspect`, `run`) plus a
  `budget_status` resource, verified with a real MCP protocol client — not a mock — doing
  a genuine discover → inspect → run round trip against a live upstream API
- **A CLI** (`sw`) covering discovery, running tools, budgets, and wallet management,
  each command a thin call to the same REST API the MCP server uses
- **71 passing tests**, including two live calls to the real internet
  (`api.weather.gov`, `api.frankfurter.dev`) and a reproduction of Monid's documented 26×
  ranking inversion

## Quickstart

Requires Node 22+ and a local Postgres with `pgvector` installed
(`brew install postgresql@18 pgvector` on macOS).

```bash
npm install
createdb switchboard
DATABASE_URL="postgresql://localhost/switchboard" npm run db:migrate
DATABASE_URL="postgresql://localhost/switchboard" npm run db:seed
DATABASE_URL="postgresql://localhost/switchboard" npm run dev:api      # terminal 1
npx tsx apps/mcp/src/server.ts                                          # terminal 2 (optional — MCP)
```

Then, in another terminal, try the REST API directly:

```bash
curl -X POST http://127.0.0.1:3000/v1/discover \
  -H "Content-Type: application/json" \
  -d '{"query": "convert currency amount from dollars to euros", "limit": 3}'
```

Or the CLI:

```bash
npx tsx apps/cli/src/index.ts discover "convert currency amount"
npx tsx apps/cli/src/index.ts workspace-create my-workspace
npx tsx apps/cli/src/index.ts wallet deposit --workspace <id> --amount 5.00
npx tsx apps/cli/src/index.ts budget set --workspace <id> --scope session --id demo --limit 0.05
npx tsx apps/cli/src/index.ts run <endpoint_id> --workspace <id> --args '{"amount":100,"from":"USD","to":"EUR"}'
```

### Connecting to Claude Code or Cursor (MCP)

With the API and MCP server both running (above), add SwitchBoard as a remote MCP server
pointed at `http://127.0.0.1:3001/mcp` — in Claude Code:

```bash
claude mcp add --transport http switchboard http://127.0.0.1:3001/mcp
```

In Cursor, add the same URL under Settings → MCP → Add Server (type: `http`). Once
connected, the agent has exactly three tools — `discover`, `inspect`, `run` — regardless
of how large the underlying catalogue grows, by design
([plan/06-api-spec.md](plan/06-api-spec.md)).

Run the test suite. Most tests are pure unit tests and need no database; several
integration tests connect to a real local Postgres (and, for the MCP/CLI suites, a real
running API + MCP server) if they can find one, and skip cleanly if they can't:

```bash
npm test
```

## Self-hosting (Docker)

```bash
docker compose up
```

⚠️ **Written, not verified** — no Docker was available in the environment this was built
in. Check [PROGRESS.md](PROGRESS.md)'s Phase 5 section before relying on this.

## ⚠️ Embeddings are a placeholder

`packages/core/src/embeddings.ts` ships a dependency-free, zero-cost hashed bag-of-words
embedding so discovery works with no API key. It captures shared vocabulary, not semantic
meaning — swap in a real model (Voyage `voyage-3`, OpenAI `text-embedding-3-small`) before
relying on this for actual semantic recall. The interface is designed so that's a one-line
change; see the warning at the top of that file.

## Layout

```
apps/api           Fastify REST server — discover/inspect/run/wallet/budgets/runs
apps/mcp           MCP server (streamable HTTP) — 3 tools, thin adapter over apps/api
apps/cli           `sw` — thin CLI adapter over the same REST API
packages/core       Pricing, ranker, discovery, ledger, policy engine, executor
packages/db         Postgres schema, migrations, seed data (real providers)
packages/shared     Money utilities (integer micro-dollars, never floats)
plan/               Full planning set — read plan/README.md first
PROGRESS.md         Phase-by-phase build log — what's real, what's next, real bugs found
ARCHITECTURE.md     The decisions worth defending, and the bugs that shaped them
TESTING.md          What each test proves, including the concurrency and e2e tests
SECURITY.md         The SSRF guard and the prompt-injection boundary — what's enforced,
                    what isn't, and why
CONTRIBUTING.md     Ledger/policy rules that actually matter, catalogue submission guide
```

## Next: Phase 6

The demo — see [plan/07-roadmap.md](plan/07-roadmap.md) and [PROGRESS.md](PROGRESS.md)
for exactly where things stand, including the one thing from Phase 5
(`docker compose up`) that's written but not yet verified.
