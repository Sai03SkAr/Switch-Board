# Architecture

This explains the decisions that would actually come up if someone asked "why did you
build it this way," not a tour of the file tree. For what's built vs. planned, see
[PROGRESS.md](PROGRESS.md). For the original design intent, see [plan/](plan/README.md).

## The shape of the system

```
discover → inspect → run
   │          │         │
   └──────────┴─────────┴──► one REST API (apps/api)
                                    │
                    ┌───────────────┼───────────────┐
                    │               │                │
              packages/core   packages/db      apps/mcp, apps/cli
           (pricing, ranker,   (Postgres         (thin adapters —
            ledger, policy,     schema,           fetch() calls to
            executor)           migrations,       the REST API,
                                 seed data)        no logic of
                                                    their own)
```

Three surfaces (REST, MCP, CLI), one implementation. The MCP server and CLI are
deliberately dumb — they call the same HTTP endpoints a human would with `curl`, they
never touch Postgres or `packages/core` directly. This is a design commitment, not an
accident: it means a bug can only exist in one place, and it's provable — Phase 4's tests
exercise the *real* REST API through the *real* MCP protocol and a *real* spawned CLI
subprocess, not a shortcut that bypasses the boundary.

## The ledger: reserve → capture → release

This is the part of the system actually worth defending in detail, because it's the part
that's wrong in most first attempts.

### The invariant

Money that a call *might* cost is held before the call runs. Money that a call *actually*
cost is captured after it succeeds. A failed call releases the hold and charges nothing.
No code path skips the hold — not even a genuinely free ($0) call, which instead skips
the ledger *entirely* (see "Free calls don't get a $0 hold" below).

### Why a hold, not just "charge on success"

The obvious naive design — check the balance, make the call, deduct on success — has a
race: two concurrent calls can both check the balance, both see enough money, and both
deduct, overspending the account. A hold closes that window: the money is *reserved*
before either call proceeds, so the second one sees a truthfully lower balance.

### Why `SELECT ... FOR UPDATE`, specifically

[`plan/05-data-model.md`](plan/05-data-model.md) said "derive the balance, don't cache a
counter that can drift" — correct, but it doesn't by itself stop two concurrent
transactions from both computing the same "available: $10" and both proceeding. The fix
used here: every ledger operation opens a transaction and takes
`SELECT id FROM accounts WHERE id = $1 FOR UPDATE` **before** computing the balance.
Postgres then blocks any second transaction touching the *same* account until the first
commits or rolls back — so the balance re-computed after the lock is guaranteed still
correct when the hold is inserted a few lines later. Accounts that aren't the same never
block each other; the lock is per-row, not global.

**This was proven, not assumed.** `packages/core/test/ledger.concurrency.test.ts` fires
1,000 genuinely concurrent `reserve()` calls at one account funded for exactly 100 of
them. Before trusting the lock, I removed it and re-ran the test: 109 of 1,000 succeeded
— a real 9% over-commit — reliably, across three separate runs. Restoring the lock fixed
it, exactly 100 succeed every time. That's in [PROGRESS.md](PROGRESS.md)'s Phase 2
section in full, including the numbers.

### Why every transaction sums to exactly zero — no exceptions

Ledger entries are double-entry: a capture debits the user's account and credits a
`revenue` system account by the identical amount. A deposit debits a system
`external_funding` account and credits the user. **This holds even for money entering the
system** — there's no special-cased single-sided deposit entry, on purpose. Once you allow
one exception to "every transaction balances," you've built a system where auditing means
remembering which cases are exceptions. Keeping it absolute means one query —
`SELECT transaction_id, SUM(amount_micros) FROM ledger_entries GROUP BY transaction_id
HAVING SUM(amount_micros) != 0` — should return zero rows, always, and does. This runs as
an implicit check after every test run's cleanup, not just as documentation.

### Free calls don't get a $0 hold

`holds.amount_micros` has `CHECK (amount_micros > 0)`, deliberately — a hold should
represent money genuinely at risk. More than half the seeded catalogue (NWS, Frankfurter,
OpenTDB, Census) is free. The first version of the executor tried to `reserve()` $0 for
every call regardless, and the schema correctly rejected it. The fix: the executor
branches on `estimate.maxPossibleMicros === 0` and skips reserve/capture/release
entirely for a free call — nothing to hold, nothing to settle. This is in
[PROGRESS.md](PROGRESS.md)'s Phase 2 bug list; it's here too because it's a good example
of a schema constraint doing its job by catching a real bug at write-time instead of
letting a meaningless row through.

### Idempotency, and the bug that shaped it

`idempotency_key` is globally unique — not per-account — deliberately: a buggy client
should never be able to reuse *another* workspace's key and, by accident, read or reuse
their hold. But the first version of `reserve()`/`capture()` only checked "does this key
exist," not "does it belong to *this* call" — so a key collision across two different
accounts (or two different holds, for `capture`) would silently return the wrong one's
data. This surfaced as a confusing test failure (stale hardcoded keys colliding across
repeated test runs, not an obviously-related symptom) before it was root-caused. The fix,
`IdempotencyKeyConflictError`, checks ownership unconditionally, first, in both functions.
Full account in [PROGRESS.md](PROGRESS.md).

## The policy engine: why it's a separate layer from the ledger

The ledger answers "is there enough money." The policy engine answers "should this
spend happen at all" — a workspace, key, session, or single call can each carry an
independent budget, checked narrowest-scope-first (`call → session → key → workspace`)
before a hold is ever taken. This is deliberately a *different* question from the
ledger's, because the two protections have to compose: a workspace can have $100 in it
(the ledger says "yes, enough money") while a single session is capped at $0.05 (the
policy engine says "no, not for this loop"). [`plan/03-positioning.md`](plan/03-positioning.md)
names this the project's actual differentiator; it's tested with a literal 10-iteration
retry-loop simulation that hits its cap and stops at exactly the funded amount, not
"roughly" the cap.

**Budget spend is derived, not cached**, for the same reason the ledger's balance is:
`SUM(actual_micros)` over succeeded runs in scope, computed fresh on every check, rather
than a `budget_usage` counter that could silently drift out of sync with reality. This
was a deliberate departure from `plan/05-data-model.md`'s original proposal, made while
building Phase 3, not before — the ledger's own pattern turned out to generalize cleanly.

## Discovery: why Reciprocal Rank Fusion, not a raw-score blend

BM25 full-text search and vector cosine similarity produce numbers on incompatible
scales — `ts_rank_cd` is unbounded and typically 0.01–0.5; cosine similarity is bounded
to [-1, 1]. An early version of this project combined them with `MAX(score)` per
candidate, which meant whichever method happened to produce a numerically bigger raw
number won, for no principled reason — a real bug, not a design choice, caught by
re-reading the SQL rather than by a failing test. Reciprocal Rank Fusion sidesteps the
whole problem: it only uses each method's *rank position* (1st, 2nd, 3rd...), never the
raw score, so nothing needs to be on a comparable scale to combine correctly. `k=60` is
the constant from the original RRF paper, and what Elasticsearch/OpenSearch use for
hybrid search for the same reason.

## What's a placeholder, on purpose

- **Embeddings** (`packages/core/src/embeddings.ts`) are a zero-cost hashed bag-of-words,
  not a real semantic model — captures shared vocabulary, not meaning. Swapping in a real
  model is a one-line change at the call site; the interface was designed for that.
- **REST auth** takes `workspace_id`/`key_id` directly in the request body rather than
  Bearer-token API keys — correctly deferred to Phase 4/5, once a real caller identity is
  what the CLI and MCP server actually need, not before.

Both are documented where they live, not just here — see the warning comments at the top
of each file.
