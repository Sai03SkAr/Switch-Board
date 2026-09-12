# SwitchBoard — Progress

**Read this file first in any new session.** It's the single source of truth for what's
done, what's in flight, and how to pick this up cold — including in a fresh Claude
account if this one runs out of context. Updated continuously as work happens, not
after the fact. If this file and a commit message ever disagree, trust the latest commit
and treat this file as needing an update.

---

## Right now

**Phase:** 5 (make it legible) — **mostly complete**, one item genuinely unverified (see
below). Moving to Phase 6 (the demo) next.
**Last verified state:** 71/71 tests passing (61 when the API/MCP servers aren't running
— the other 10 skip cleanly rather than fail, which is correct). Database left
completely clean after every run, confirmed across many consecutive runs.

**⚠️ One thing genuinely not verified: `docker compose up`.** No Docker is available in
the environment this was built in (confirmed: `docker`/`docker-compose` both absent).
`Dockerfile` and `docker-compose.yml` were written carefully against the exact commands
already verified locally (`npm ci`, `db:migrate`, `db:seed`, `dev:api` all proven to work
against a real Postgres), but the compose file itself has never actually been run. **This
needs a real check on a machine with Docker before the self-host promise in
`plan/03-positioning.md`/`plan/09-risks.md` can be claimed as true**, not just plausible.
If something's wrong, the most likely spot is the `migrate` service's
`depends_on: condition: service_completed_successfully` — that's the part of the compose
file with the least precedent to check against.

## How to resume in a fresh session

```bash
cd "/Users/saisalelkar/Desktop/Switxh Board"
git log --oneline -10                          # see exactly what landed
DATABASE_URL="postgresql://localhost/switchboard" npm test   # confirm current state is green
psql switchboard -c "\dt"                      # see what tables actually exist right now
```

Then read this file's **Phase-by-phase status** section below, find the first phase not
marked ✅, and continue from its "Next step" line. The plan for *what* each phase should
contain lives in [`plan/07-roadmap.md`](plan/07-roadmap.md) — this file tracks *whether
it's actually been built*, which is a different question.

**Repo:** [Sai03SkAr/Switch-Board](https://github.com/Sai03SkAr/Switch-Board), branch `main`.
Everything is pushed after every meaningful chunk — nothing valuable is sitting
uncommitted.

## Non-negotiable standing rules (apply to every phase)

These came from real mistakes caught earlier in the project — don't relitigate them:

1. **Never claim something works without running it.** Phase 1 shipped a bug (`to_tsvector`
   can't back a `GENERATED` column) and two more (RRF vs `MAX`, unguarded `estimateCost`)
   that were only caught by actually executing code against the real local Postgres. Every
   phase below must end with a live run against `switchboard` DB, not just green unit tests.
2. **Money is integer micro-dollars. Never float.** See `packages/shared/src/money.ts`.
3. **Real Postgres in tests, never mocks**, for anything touching the database — see
   `packages/core/test/discovery.integration.test.ts` for the pattern (top-level `await`
   to check reachability, `describe.skipIf` on that, real INSERT/DELETE fixtures with
   cleanup in `afterAll`).
4. **A regression test isn't proven until you've watched it fail.** Before trusting a new
   test, temporarily revert the fix it's guarding and confirm the test actually catches
   the regression, the way `discovery.integration.test.ts`'s crash-bug test was verified.
5. **BYOK-only. No managed balance, ever, without re-reading `plan/09-risks.md` R1 first**
   — holding user funds is a regulatory line this project deliberately doesn't cross.
6. **Provider ingestion gates are hard gates, not warnings**: `resale_allowed` and
   `validatePricingModel()` both throw/block rather than warn. Keep that discipline for
   every new gate this phase introduces.

---

## Phase-by-phase status

### ✅ Phase 0 — Provider verification & pricing spike
Done 8–12 Sep 2026. See `plan/12-provider-shortlist.md`, `plan/13-normalization-spike.md`.

### ✅ Phase 1 — Catalogue & discovery
Done 12 Sep 2026, hardened same day (3 real bugs found and fixed by re-reading the code).
17 endpoints/8 providers live in Postgres. `POST /v1/discover`, `POST /v1/inspect`,
`GET /v1/endpoints` all working. 25 tests passing.

### ✅ Phase 2 — The ledger — COMPLETE

**Goal (from `plan/07-roadmap.md`):** money moves correctly. `accounts`, `transactions`,
`ledger_entries`, `holds`, idempotent reserve/capture/release, the hold reaper, the
executor, `POST /v1/run`, `GET /v1/runs`, `GET /v1/runs/{id}`, `GET /v1/wallet/balance`,
`GET /v1/wallet/activities`. **All built, all tested, all verified live.**

**All 6 acceptance criteria met** (from the roadmap, this is the one phase explicitly
gated — "do not proceed with a ledger you do not trust"):
- [x] 1,000 concurrent reserves against one balance never over-commit — `ledger.concurrency.test.ts`, proven against real Postgres, exactly 100/1000 succeed against a $1.00 balance sized for exactly 100
- [x] Replayed idempotency key executes once and charges once — for both `reserve` and `capture`, including a cross-account/cross-hold conflict guard added after a real bug (see below)
- [x] Upstream 500 leaves the balance changed by exactly 0 micro-dollars — `executor.test.ts`, proven with a scripted upstream client
- [x] Process killed between reserve and capture → reaper restores full balance — `reapExpiredHolds()`, tested
- [x] Every transaction's ledger entries sum to exactly 0 — enforced by construction, independently verified across the whole database after every test run
- [x] `dry_run` returns an accurate estimate and moves no money — `executor.test.ts`, proven: zero hold, zero run row, zero balance change

**What exists:**
- `packages/core/src/ledger.ts` — `reserve`/`capture`/`release`/`reapExpiredHolds`/`deposit`/`getAvailableBalance`
- `packages/core/src/executor.ts` — `run()`: validate → estimate → reserve → call upstream → capture/release, with JSON-Schema validation via ajv
- `packages/core/src/upstream.ts` — `UpstreamClient` interface, `FetchUpstreamClient` (real HTTP), `substituteTemplate`
- Migrations `002_phase2_ledger.sql`, `003_transactions_hold_id.sql`, applied to the live local DB
- REST: `POST /v1/workspaces`, `POST /v1/wallet/deposit`, `GET /v1/wallet/balance`, `GET /v1/wallet/activities`, `POST /v1/run`, `GET /v1/runs`, `GET /v1/runs/{id}`
- **55/55 tests passing**, verified stable across many consecutive full-suite runs, database always left completely clean afterward (only the 2 system accounts, zero debris, zero unbalanced transactions)
- **Manually verified end-to-end against the live running API**, including two genuinely real calls out to the internet: `api.weather.gov` (a real, dated weather alert for Santa Barbara County) and `api.frankfurter.dev` (a real, dated $100→€86.27 conversion) — not just mocked tests

**Four real bugs found and fixed while building this — worth knowing about specifically:**
1. **The concurrency lock is genuinely load-bearing, not decorative** — proven by
   temporarily removing `SELECT ... FOR UPDATE` from `reserve()` and watching the 1,000-
   concurrent test fail reliably (109/1000 succeeded against a balance sized for 100 — a
   real 9% over-commit), then confirming the fix resolves it. Restored immediately after.
2. **`IdempotencyKeyConflictError`** — `idempotency_key` is globally unique by design (a
   buggy client should never be able to reuse another workspace's key and hijack their
   hold), but the original `reserve()`/`capture()` replay-lookup didn't check that a found
   key actually belonged to the account/hold the current call was for. A key reused
   across two different accounts (or two different holds, in `capture`'s case) would have
   silently returned the WRONG hold's data instead of erroring. Found via a confusing test
   failure (stale hardcoded idempotency keys colliding across repeated test runs — see the
   header comment in `ledger.test.ts`), root-caused, and fixed: both functions now check
   key ownership unconditionally before doing anything else.
3. **Free ($0) endpoints broke `reserve()` entirely** — `holds.amount_micros CHECK (>0)`
   is deliberate (a hold should represent real money at risk), but the executor tried to
   reserve $0 for every free call anyway. More than half the seeded catalogue is
   genuinely free, so this wasn't an edge case — it was the majority path. Fixed: the
   executor skips reserve/capture/release entirely when a call's max cost is exactly 0.
4. **`FetchUpstreamClient` silently mis-parsed real responses** — caught live, not in a
   unit test: `api.weather.gov` returns `application/geo+json`, and a bare
   `.includes("application/json")` check missed the standard RFC 6839 `+json`
   structured-syntax suffix, silently falling back to returning an unparsed string
   instead of a parsed object. Fixed with `isJsonContentType()`, extracted as its own
   pure, unit-tested function specifically so this class of bug has a regression test
   that doesn't depend on hitting the real network again to catch it.

**A design decision made concrete while building, not left as prose** (see the doc
comment at the top of `ledger.ts`): `plan/05-data-model.md` said "derive balance, don't
store a counter that can drift" but didn't specify how correctness holds under real
concurrent access. The answer used here: every ledger operation takes
`SELECT ... FOR UPDATE` on the account row before computing the derived balance, so
Postgres serializes concurrent operations on the *same* account while leaving different
accounts fully independent. This is proven, not assumed (see bug #1 above).

**Known simplification, tracked on purpose, not forgotten:** these REST endpoints accept
`workspace_id` directly in the request rather than Bearer-token API-key auth —
`plan/06-api-spec.md` envisions the latter, but the `api_keys` table and auth flow are a
Phase 4 (CLI/MCP) concern, once Phase 3's policy engine actually needs a real caller
identity to enforce budgets against. Revisit when Phase 4 starts.

**Next step:** Phase 3 — the policy engine and budget hierarchy (workspace → key →
session → call), built on top of the `accounts`/`holds` this phase created.

**Design decisions locked in before writing code:**
- Concurrency safety via a single atomic `UPDATE accounts SET ... WHERE available >= $amount`
  pattern (not read-then-write, not app-level locks) — see the schema section below for why.
- Upstream calls in the executor go through an `HttpClient` interface so tests can swap in
  a local mock server instead of hitting real paid providers. Free providers (NWS,
  Frankfurter, OpenTDB, Census) *can* be called for real in a manual smoke test since they
  cost nothing and need no key — but the automated suite uses a mock, so CI never depends
  on third-party uptime.
- No real provider credentials exist in this environment (Twilio/SendGrid/CoinGecko all
  need paid keys nobody has entered). The executor will be built key-ready but Phase 2
  testing exercises it against the mock server, not live paid calls.

### ✅ Phase 3 — Policy engine & budgets — COMPLETE

**Goal (from `plan/07-roadmap.md`):** the project's headline differentiator — a
workspace → key → session → call budget hierarchy, versus a single undifferentiated
balance (the exact gap in `plan/02-weaknesses.md` #2). **All built, tested, verified live.**

**All 4 acceptance criteria met:**
- [x] **The headline demo, as an automated test**: an agent in a retry loop hits a
      session budget cap and stops, workspace balance untouched beyond the cap —
      `policy.test.ts`, a real 10-iteration retry loop against a $774-capped session,
      exactly 3 calls succeed, balance drops by exactly 774 micros, not a penny more
- [x] Each of the 4 scopes blocks independently and reports which one tripped — proven
      both in unit tests and live over HTTP (`BUDGET_EXCEEDED` names `scope`, `window`,
      `limit_micros`, `spent_micros`, `would_cost_micros` exactly)
- [x] A call above a confirmation threshold returns 409 with a token, succeeds on
      replay — proven live: real HTTP 409, real token, real successful replay, and a
      reused token correctly denied with a **fresh** token issued
- [x] `dry_run` returns an accurate estimate and moves no money — already covered in
      Phase 2's executor tests, unaffected by this phase's changes

**What exists:**
- Migration `004_phase3_policy.sql` — `api_keys` (minimal — see the auth note below),
  `budgets`, `confirmation_tokens`, plus `session_id`/`key_id` columns added to `runs`
- `packages/core/src/policy.ts` — `evaluatePolicy()` (call → session → key → workspace
  order, narrowest first), `consumeConfirmationToken()` (atomic, race-safe single-use)
- Wired into `packages/core/src/executor.ts`'s `run()`: policy runs before any hold is
  taken, using the same conservative `maxPossibleMicros` figure the ledger reserves
  against — a budget check looser than the actual hold would be internally inconsistent
- REST: `GET/POST /v1/budgets`, `DELETE /v1/budgets/:id`, and `/v1/run` now accepts
  `session_id`/`key_id`/`confirmation_token` and returns `402 BUDGET_EXCEEDED` /
  `409 CONFIRMATION_REQUIRED` with the exact detail shape from `plan/06-api-spec.md`
- **61/61 tests passing** (6 new in `policy.test.ts`), stable across many consecutive runs
- **Manually verified end-to-end over live HTTP**: 409+token, single-use enforcement (a
  reused token is denied and issued a fresh one, not silently accepted), 402 with full
  scope detail, and — notably — a real call to CoinGecko's live API that genuinely failed
  with a 401 (no paid credentials exist in this environment, expected) still correctly
  charged **zero**, proving Phase 2's zero-charge-on-failure guarantee holds against a
  real upstream failure, not just a scripted mock

**Deliberate scope decision, not a gap:** `budgets` spend is DERIVED by querying `runs`
directly (`SUM(actual_micros)` for succeeded runs in scope+window) rather than
maintaining a `budget_usage` cache table as `plan/05-data-model.md` originally proposed.
Same principle the ledger itself uses (see `ledger.ts`'s doc comment) — a derived sum
avoids an entire class of "did every code path correctly increment the cache" bugs, and
there is no performance reason yet to accept that risk at this project's scale.

**Not built this phase, deliberately deferred (small, not acceptance-critical):**
allow/deny lists per key, and rate limiting — both listed in the roadmap's Phase 3
deliverables but not required by any of the 4 acceptance criteria. Worth adding before
Phase 8 if time allows; noted here so they aren't mistaken for forgotten rather than
deferred.

**Known simplification carried over from Phase 2, unchanged:** REST endpoints still take
`workspace_id`/`key_id`/`session_id` directly in the request rather than Bearer-token
auth — still correctly deferred to Phase 4, where a real caller identity is what the CLI
and MCP server actually need to wire up.

**Next step:** Phase 4 — the MCP server (three tools: `discover`, `inspect`, `run`) and
the CLI, both as thin adapters over the REST API this and the previous two phases built.

### ✅ Phase 4 — MCP server & CLI — COMPLETE

**Goal (from `plan/07-roadmap.md`):** exactly three MCP tools (`discover`, `inspect`,
`run`) plus a `budget_status` resource, a CLI covering the same surface, install docs for
Claude Code/Cursor. **All built, all verified against real running processes.**

**All 3 acceptance criteria met:**
- [x] "Claude Code connects and completes a real task end to end" — verified with the
      **real `@modelcontextprotocol/sdk` client**, not a mock: `Client` +
      `StreamableHTTPClientTransport` connected to a real running instance of this
      server, which itself called the real REST API, which called the real local
      Postgres and, for one test, the real live Frankfurter API — genuine discover →
      inspect → run round trip, `apps/mcp/test/mcp.e2e.test.ts`
- [x] "The agent visibly chooses between candidates and explains why" — `discover`'s
      tool output includes `score_breakdown` (fit/reliability) and marks
      `cheapest_viable`, in plain text, not buried in a JSON blob the agent has to parse
- [x] "The agent hits a budget cap and reports it in plain language rather than
      crashing" — proven at the protocol level: a 402 `BUDGET_EXCEEDED` from the REST
      layer is caught inside the `run` tool and returned as a **normal, successful**
      tool result (`isError` is falsy) whose text explains the guardrail — verified this
      is NOT surfaced as an MCP protocol-level error, which was the actual bar this
      criterion set

**What exists:**
- `apps/mcp/src/server.ts` — `McpServer` with exactly 3 tools, each calling the REST API
  via `fetch()` (a thin adapter, not a second implementation of any business logic), plus
  a `budget_status` `ResourceTemplate` resource so checking a balance costs no tool slot
- `apps/cli/src/index.ts` — `sw discover/inspect/run/runs/budget/wallet/workspace-create`,
  same thin-adapter principle, using `commander`
- README updated with real `claude mcp add --transport http` install instructions —
  **verified against the actual installed Claude Code CLI's own `--help` output**, not
  asserted from memory
- **71/71 tests passing** (5 new MCP protocol tests, 5 new CLI subprocess tests)

**Two real bugs found and fixed while building this:**
1. **The `budget_status` resource silently never worked** — passing a plain string
   containing `"{workspace_id}"` to `registerResource()` registers that exact string as
   a literal, non-templated URI; the MCP SDK only treats `{param}` as a real variable
   when you construct an actual `ResourceTemplate`. Every lookup failed with "resource
   not found" until fixed — caught by the e2e test, not by inspection.
2. **`sw budget delete` silently failed on every call** — the CLI's shared `api()`
   helper always sent `Content-Type: application/json`, even for a bodyless `DELETE`.
   Fastify rejects that combination outright (`FST_ERR_CTP_EMPTY_JSON_BODY`, 400)
   before the route handler ever runs. `GET` commands never showed the bug because
   Fastify doesn't body-parse GET requests at all. Root-caused by reproducing with
   `curl` using the exact same headers the CLI sent, fixed by only setting the header
   when a body is actually present, and locked in with a dedicated regression test
   (`apps/cli/test/cli.e2e.test.ts`) that spawns the real `sw` binary as a subprocess.

**How to run both servers for manual testing:**
```bash
DATABASE_URL="postgresql://localhost/switchboard" npm run dev:api   # terminal 1, port 3000
npx tsx apps/mcp/src/server.ts                                       # terminal 2, port 3001
```

### 🔶 Phase 5 — Make the engineering legible — MOSTLY COMPLETE

**Goal (from `plan/07-roadmap.md`):** CI, `ARCHITECTURE.md`, `TESTING.md`, seeded demo
data (already existed from Phase 1), self-host `docker compose up`, README polish.

**Done:**
- `.github/workflows/ci.yml` — Postgres service using `pgvector/pgvector:pg16` (the
  plain `postgres` image doesn't have the extension compiled in), runs migrate → seed →
  full test suite → boots both the API and MCP servers via `wait-on` → runs the e2e
  suites against them for real. **Not yet verified as an actual passing GitHub Actions
  run** — no `gh` CLI or token available in this environment to check. Its *logic* was
  validated as rigorously as possible without GitHub itself: ran the exact same sequence
  (fresh `createdb`, migrate, seed, full suite) against a genuinely empty local database
  to confirm all 4 migrations apply cleanly in order from zero — they'd only ever been
  applied incrementally to the same dev DB before, which is a real gap this closed.
  **Check the Actions tab after this push.**
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — the decisions worth defending in an interview:
  why `SELECT ... FOR UPDATE`, why every transaction sums to exactly zero with no
  exceptions, why free calls skip the ledger entirely, why RRF instead of a raw-score
  blend, why the policy engine derives spend instead of caching it. Each tied back to the
  real bug that shaped it, not written as if the design were obvious from the start.
- [`TESTING.md`](TESTING.md) — explains the concurrency test and how it was verified
  (temporarily broken, confirmed to fail, restored), the e2e tests and what real bugs
  they caught, and — deliberately included rather than quietly omitted — a false-alarm
  investigation into apparent test-cleanup debris that turned out to be leftover
  manual-debugging residue, not a real bug, including the wrong fix that was drafted and
  reverted before the real cause was found.
- `Dockerfile` + `docker-compose.yml` + `.dockerignore` — see the ⚠️ at the top of this
  file. Written, not verified.
- README updated: status line now mentions Phase 5, links `ARCHITECTURE.md`/`TESTING.md`,
  adds a self-host section (flagged with the same ⚠️ as above), "Next" points to Phase 6.

**Not done, and being explicit about why:** a demo GIF in the README's first screen —
that's Phase 6's job once there's something to record, and putting a placeholder in now
would be worse than waiting.

### ⬜ Phase 6 — The demo
Not started. **Flag for the user now:** I can write a demo *script* (exact commands, exact
expected output) and a text/GIF-storyboard, but I cannot record an actual screen-capture
video — that needs a human at a terminal. This will be called out explicitly again when
this phase is reached, not left implicit.

### ⬜ Phase 7 — Open source polish
Not started. License choice, `CONTRIBUTING.md`, issue templates.

### ⬜ Phase 8 — Hardening worth showing
Not started. Load-test numbers published in README, OpenTelemetry traces, SSRF guards,
the prompt-injection boundary from `plan/09-risks.md` R5.

---

## Known limitations, carried forward on purpose (not bugs)

- **Embeddings are a placeholder** — `LocalHashEmbedding`, zero-cost, hashed bag-of-words.
  Documented in `packages/core/src/embeddings.ts` and the README. Swap for Voyage/OpenAI
  before Phase 8 if semantic quality needs to be real, not just plumbing-correct.
- **ElevenLabs and Open-Meteo** are one confirmation step from catalogue-ready (resale ToS
  and commercial-proxying rights respectively) — see `plan/12-provider-shortlist.md`. Not
  onboarded until that step happens; correctly excluded, not forgotten.
- **The Monid account verification tests** (price-blind ranking, per-key caps) are queued
  in `plan/10-verification-log.md`, ready to run in 5 minutes whenever an account exists.
  Not something this session will do — account creation is off-limits regardless of who asks.
- **`plan/02-weaknesses.md` and `plan/03-positioning.md` are stale as of `research.md`
  (12 Sep 2026)** — they position against a competitive gap (agent spending controls) that
  AWS closed to GA a month ago. Not yet rewritten. Low priority unless the project pivots
  per `research.md`'s recommendation; flagging so it isn't forgotten.

## What will need you, specifically, at some point

Kept in one place so nothing surprises you later:
- **Recording the actual demo video** (Phase 6) — I can script it precisely, not perform it
- **Any real paid-provider credentials** (Twilio, SendGrid, CoinGecko paid tier) if you
  ever want live (not mocked) execution against them
- **The Monid account verification** — queued and ready, 5 minutes, whenever you want it
- **A decision on the pivot in `research.md`** — not blocking, but it's yours to make, not mine
