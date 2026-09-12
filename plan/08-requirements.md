# 08 — Requirements: stack, services, cost, skills

## Recommended stack

| Layer | Choice | Why |
|---|---|---|
| Language | **TypeScript / Node 22+** | Best-maintained MCP SDK; one language across API, MCP, CLI |
| Framework | Fastify (or Hono) | Fast, schema-first, JSON Schema validation built in |
| Database | **Postgres 16 + pgvector** | Relational + vector + full-text in one engine. Do not add a second store |
| Cache/locks | Redis | Rate limits, idempotency, distributed locks |
| Validation | Zod + `ajv` | Zod for your API, `ajv` for provider JSON Schemas |
| Embeddings | Voyage `voyage-3` or OpenAI `text-embedding-3-small` | Catalogue is small; cost is negligible |
| MCP | `@modelcontextprotocol/sdk` | Streamable HTTP transport |
| Migrations | Drizzle or node-pg-migrate | Plain SQL you can read |
| Tests | Vitest + Testcontainers | Real Postgres in tests — the ledger cannot be mocked |
| Observability | OpenTelemetry → Grafana Cloud free tier | Traces across the run path |
| Hosting | Fly.io or Railway | One process + one worker + managed Postgres |
| Payments (later) | Stripe | Deposits only at first. See [09-risks.md](09-risks.md) |

**Python alternative:** FastAPI + SQLAlchemy + pgvector is equally viable if you are
stronger in Python. The MCP SDK is good there too. Pick the one you write faster in —
the architecture does not care. Do not split languages across services.

## Explicitly not needed

Skip these; they are how side projects die:

- Kubernetes, microservices, a service mesh
- A separate vector database (Pinecone, Weaviate) — pgvector handles thousands of rows
- Kafka or a message bus — one worker with a Postgres job table is plenty
- A frontend framework before Phase 5 — the CLI is your UI until then
- Multi-region anything

## External services and running cost

| Service | Purpose | Cost |
|---|---|---|
| Fly.io / Railway | API + worker | $5–15/mo |
| Managed Postgres | Primary store | $0–20/mo (free tiers exist) |
| Redis | Limits, locks | $0–10/mo |
| Embeddings API | ~40 endpoints, re-embedded rarely | <$1 one-time |
| Domain | | ~$12/yr |
| Grafana Cloud | Traces | Free tier |
| Provider free tiers | Catalogue | $0 if chosen well |
| **Total** | | **~$20–45/month** |

The whole thing runs on a hobby budget, provided you pick free-tier providers in
Phase 0. Budget an extra ~$20 for deliberately burning real provider credits during
ledger testing — you need at least a few real paid calls to trust the metering.

## Provider selection criteria (Phase 0)

Rank candidates by:

1. **`resale_allowed`** — the ToS permits proxying/reselling. Non-negotiable; see
   [09-risks.md](09-risks.md)
2. Generous free tier
3. Stable OpenAPI spec (cheap ingestion)
4. Predictable pricing (prefer per-call over per-unit for your first few)
5. Boring and legal — weather, geocoding, currency, public data, LLM inference

**Deliberately avoid at first:** social-media scraping endpoints. They are Monid's
volume, and they carry ToS and legal exposure you do not want as a solo operator.
Avoiding them is also on-strategy: it is exactly the compliance-clean positioning from
[03-positioning.md](03-positioning.md).

Aim for a mix: at least one per-call biller, one per-unit biller, and one that only
reveals cost in the response. If your pricing model handles all three, it handles
everything.

## Skills you need

| Skill | Depth | Where it bites |
|---|---|---|
| Backend API design | Solid | Everything |
| Postgres — transactions, isolation, constraints | **Deep** | The ledger. This is the real prerequisite |
| Concurrency and idempotency reasoning | **Deep** | Reserve/capture under parallel load |
| Vector + full-text search | Working | Phase 1 |
| HTTP client discipline — timeouts, retries, breakers | Solid | Phase 2 |
| MCP protocol | Working | Phase 4, learnable in a day |
| Basic frontend | Light | Phase 5 dashboard |
| Security basics — secrets, SSRF, injection | Solid | Phase 8 |

**If one thing on this list is worth studying before you start, it is Postgres
transaction isolation.** Read up on `SERIALIZABLE` vs `READ COMMITTED` and
`SELECT ... FOR UPDATE`. The ledger's correctness rests entirely on getting that right,
and it is the one part where "it seems to work" is not evidence of anything.

## Repo layout

```
switxh-board/
├── apps/
│   ├── api/          # Fastify REST
│   ├── mcp/          # MCP adapter over the API
│   ├── worker/       # health prober, hold reaper, purge, ingestion
│   └── cli/
├── packages/
│   ├── core/         # ledger, policy, ranker, estimator  ← the open core
│   ├── db/           # schema + migrations
│   └── shared/       # types, money utils, envelope
├── catalogue/        # ToolSpec definitions, reviewed and version-controlled
├── docs/
└── docker-compose.yml
```

Keeping `catalogue/` as reviewed files in git — rather than rows typed into a database —
makes curation auditable and lets contributors submit endpoints by pull request. That is
the open-core catalogue story, and it costs nothing to set up this way from the start.

## Definition of done for v1

- [ ] 15+ verified endpoints across 5+ providers
- [ ] Every ledger test in [05-data-model.md](05-data-model.md) passing
- [ ] Budget caps enforced at all four scopes
- [ ] MCP server working in Claude Code
- [ ] Public status page with real health data
- [ ] Terms, privacy, retention, and refund pages live
- [ ] `docker compose up` works for a stranger
- [ ] The 90-second demo recorded
