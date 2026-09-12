<title>SwitchBoard</title>

# SwitchBoard

An agent-native tool router with a governance-first take on Monid: price-aware ranking,
verified provider terms, and honest pricing math. Full planning set (teardown,
architecture, roadmap) lives in [`plan/`](plan/README.md).

**Status: Phase 1 (catalogue + discovery) implemented and tested against a live
Postgres.** No money moves yet — that's Phase 2 (the ledger).

## What's real right now

- **17 endpoints, 8 providers**, all resale-verified against actual ToS —
  [plan/12-provider-shortlist.md](plan/12-provider-shortlist.md)
- **Hybrid discovery**: Postgres full-text (BM25) ∪ `pgvector` cosine similarity, unioned,
  deduped, ranked
- **Price-aware ranking** with an always-returned `score_breakdown` — the direct fix for
  the price-blind ranking gap documented in [plan/02-weaknesses.md](plan/02-weaknesses.md)
- **Normalized pricing** across `PER_CALL`, `PER_UNIT`, and `TIERED` models, each proven
  against a real provider's real published pricing in
  [plan/13-normalization-spike.md](plan/13-normalization-spike.md)
- 17 passing tests, including a reproduction of Monid's documented 26× ranking inversion

## Quickstart

Requires Node 22+ and a local Postgres with `pgvector` installed
(`brew install postgresql@18 pgvector` on macOS).

```bash
npm install
createdb switchboard
DATABASE_URL="postgresql://localhost/switchboard" npm run db:migrate
DATABASE_URL="postgresql://localhost/switchboard" npm run db:seed
DATABASE_URL="postgresql://localhost/switchboard" npm run dev:api
```

Then, in another terminal:

```bash
curl -X POST http://127.0.0.1:3000/v1/discover \
  -H "Content-Type: application/json" \
  -d '{"query": "convert currency amount from dollars to euros", "limit": 3}'
```

Run the test suite (no database needed — these are pure unit tests):

```bash
npm test
```

## ⚠️ Embeddings are a placeholder

`packages/core/src/embeddings.ts` ships a dependency-free, zero-cost hashed bag-of-words
embedding so discovery works with no API key. It captures shared vocabulary, not semantic
meaning — swap in a real model (Voyage `voyage-3`, OpenAI `text-embedding-3-small`) before
relying on this for actual semantic recall. The interface is designed so that's a one-line
change; see the warning at the top of that file.

## Layout

```
apps/api          Fastify server — POST /v1/discover, POST /v1/inspect, GET /v1/endpoints
packages/core      Pricing estimator, ranker, hybrid discovery, embeddings
packages/db        Postgres schema, migration runner, seed data (real providers)
packages/shared    Money utilities (integer micro-dollars, never floats)
plan/              Full planning set — read plan/README.md first
```

## Next: Phase 2

The ledger — reserve/capture/release, idempotent, tested under concurrency. See
[plan/07-roadmap.md](plan/07-roadmap.md).
