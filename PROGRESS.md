<title>SwitchBoard — Progress</title>

# SwitchBoard — Progress

**Read this file first in any new session.** It's the single source of truth for what's
done, what's in flight, and how to pick this up cold — including in a fresh Claude
account if this one runs out of context. Updated continuously as work happens, not
after the fact. If this file and a commit message ever disagree, trust the latest commit
and treat this file as needing an update.

---

## Right now

**Phase:** 2 (the ledger) — **in progress**, started this session.
**Last verified state:** Phase 1 complete, 25/25 tests passing, live against local Postgres.

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

### 🔨 Phase 2 — The ledger — IN PROGRESS

**Goal (from `plan/07-roadmap.md`):** money moves correctly. `accounts`, `transactions`,
`ledger_entries`, `holds`, idempotent reserve/capture/release, the hold reaper, the
executor, `POST /v1/run`, `GET /v1/runs`, `GET /v1/runs/{id}`, `GET /v1/wallet/balance`,
`GET /v1/wallet/activities`.

**Acceptance criteria that must all pass before Phase 3 starts** (from the roadmap, this
is the one phase explicitly gated — "do not proceed with a ledger you do not trust"):
- [x] 1,000 concurrent reserves against one balance never over-commit — `ledger.concurrency.test.ts`, proven against real Postgres, exactly 100/1000 succeed against a $1.00 balance sized for exactly 100
- [x] Replayed idempotency key executes once and charges once — for both `reserve` and `capture`, including a cross-account/cross-hold conflict guard added after a real bug (see below)
- [ ] Upstream 500 leaves the balance changed by exactly 0 micro-dollars — **needs the executor**, not yet built
- [x] Process killed between reserve and capture → reaper restores full balance — `reapExpiredHolds()`, tested
- [x] Every transaction's ledger entries sum to exactly 0 — enforced by construction (deposit debits external_funding/credits user; capture debits user/credits revenue), independently verified across the whole database after test runs
- [ ] `dry_run` returns an accurate estimate and moves no money — **needs `POST /v1/run`**, not yet built

**Ledger core is DONE and hardened: `packages/core/src/ledger.ts`** —
`reserve`/`capture`/`release`/`reapExpiredHolds`/`deposit`/`getAvailableBalance`. Migrations
`002_phase2_ledger.sql` (workspaces/accounts/transactions/ledger_entries/holds/runs) and
`003_transactions_hold_id.sql` applied to the live local DB. 41/41 tests passing, verified
clean across 5+ consecutive full-suite runs with zero leftover debris and zero unbalanced
transactions.

**Two real bugs found and fixed while building this, worth knowing about specifically:**
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
   header comment in `ledger.test.ts`), root-caused, and fixed properly: both functions now
   check key ownership unconditionally before doing anything else, and there's a dedicated
   regression test for cross-account and cross-hold reuse in `ledger.test.ts`.

**A design decision made concrete while building, not left as prose** (see the doc
comment at the top of `ledger.ts`): `plan/05-data-model.md` said "derive balance, don't
store a counter that can drift" but didn't specify how correctness holds under real
concurrent access. The answer used here: every ledger operation takes
`SELECT ... FOR UPDATE` on the account row before computing the derived balance, so
Postgres serializes concurrent operations on the *same* account while leaving different
accounts fully independent. This is proven, not assumed (see bug #1 above).

**Next step:** the executor — `validate args → estimate cost → reserve → call upstream →
capture/release`, then wire it behind `POST /v1/run`, `GET /v1/runs`, `GET /v1/runs/{id}`,
`GET /v1/wallet/balance`, `GET /v1/wallet/activities`. That's what closes the two
remaining unchecked boxes above.

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

### ⬜ Phase 3 — Policy engine & budgets
Not started. Depends on Phase 2's `accounts`/`holds` tables.

### ⬜ Phase 4 — MCP server & CLI
Not started. Thin adapter over the REST API from Phases 1–3 — should be quick once they exist.

### ⬜ Phase 5 — Make the engineering legible
Not started. CI config, `ARCHITECTURE.md`, `TESTING.md`, seeded demo data, README polish.

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
