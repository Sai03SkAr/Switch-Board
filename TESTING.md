# Testing

71 tests, 10 files. This explains what each *kind* of test proves, not a line-by-line
tour — the point is to make clear which claims in this repo are actually verified versus
merely asserted, and to explain the concurrency and end-to-end tests specifically, since
those are the ones worth understanding rather than skimming.

## Run them

```bash
npm test
```

Most tests are pure unit tests (`pricing.test.ts`, `ranker.test.ts`, `upstream.test.ts`)
and need nothing running. The rest connect to a real local Postgres — and for two files,
a real running API and MCP server — and **skip cleanly if they can't find one**, via a
top-level `await` that checks reachability before any `describe` block is declared (see
"Why top-level await, not `beforeAll`" below). Nothing in this suite mocks the database.

## The standing rule this suite follows

**A regression test isn't trusted until it's been watched to fail.** For every test
below that claims to guard against a specific bug, the bug was reintroduced on purpose
and the test was confirmed to catch it, before being trusted as a real regression guard.
This is slower than writing a test and assuming it's correct, and it's caught real
mistakes in the tests themselves — twice, documented below.

## The concurrency test — the most important one in the project

`packages/core/test/ledger.concurrency.test.ts` fires **1,000 genuinely concurrent**
`reserve()` calls at one account funded for exactly 100 of them ($1.00 balance,
$0.01 per reservation). The pool is configured with `max: 50` connections — well above
node-postgres's default of 10 — specifically so a meaningful number of these 1,000 calls
overlap in time and race for the same row lock. With the default pool size, most calls
would just queue client-side and execute nearly one-at-a-time, which would "pass" even
if the underlying locking were broken.

**What it proves:** exactly 100 succeed, exactly 900 fail with `InsufficientFundsError`,
the database's own numbers agree independently (`SELECT COUNT(*), SUM(amount_micros)
FROM holds WHERE ... AND state = 'active'`), and the account's derived available balance
is exactly zero afterward — not "close to zero."

**How it was verified as a real regression test, not a lucky pass:** the
`SELECT ... FOR UPDATE` lock in `reserve()` was temporarily removed, and the test was
re-run three times. Each time, over-commit actually happened (109/1000 succeeded once —
a real 9% overspend against a balance that should only fund 100). The lock was restored
and the test passes reliably again. See [ARCHITECTURE.md](ARCHITECTURE.md) for why the
lock works the way it does.

## Real-Postgres integration tests

`ledger.test.ts`, `policy.test.ts`, `executor.test.ts`, `discovery.integration.test.ts` —
each connects to a real database, creates real fixture data (workspaces, accounts,
deposits), exercises the real code path, and cleans up after itself. A few of these are
worth calling out specifically:

- **`discovery.integration.test.ts`** deliberately seeds a *poisoned* endpoint — a
  `PER_UNIT` pricing model requiring an argument the test's `discover()` call doesn't
  supply — to prove that one bad catalogue entry can't crash discovery for every other
  candidate. Verified the same way as the concurrency test: the bug (an unguarded
  `estimateCost()` call inside a `.map()`) was reintroduced, confirmed to throw and crash
  the whole request, then the fix (wrapping it in try/catch, dropping the bad candidate)
  was confirmed to resolve it.
- **`policy.test.ts`**'s headline test replays [`plan/03-positioning.md`](plan/03-positioning.md)'s
  demo script literally: an agent retries the same call 10 times against a $774 session
  budget sized for exactly 3 calls at 258 micros each. It asserts exactly 3 succeed,
  exactly 7 are denied by `BudgetExceededError` (not by running out of real money — the
  account is funded with $100), and the balance changes by exactly 774 micros, not a
  penny more or less.
- **`executor.test.ts`** proves the zero-charge-on-failure guarantee with a scripted
  upstream client that returns a 500, and separately proves it again for a genuine
  network-level failure (a thrown error, not just a bad HTTP status) — both leave the
  balance changed by exactly zero.

## End-to-end tests: real protocol clients, real subprocesses

Two files go a level further than calling functions directly.

**`apps/mcp/test/mcp.e2e.test.ts`** uses the actual `@modelcontextprotocol/sdk` `Client`
class over `StreamableHTTPClientTransport`, connected to a real running instance of
`apps/mcp/src/server.ts`, which itself calls the real REST API. This is the same client
library and wire protocol Claude Code uses to talk to any MCP server — it's the strongest
verification available in this environment for "an agent can connect and complete a real
task." One test does a genuine `discover` → `inspect` → `run` round trip that ends in a
real HTTP call to Frankfurter's live currency API. Another proves that hitting a budget
cap returns a normal, successful tool result (`isError` is falsy) with plain-language
text explaining the guardrail — not an MCP protocol-level error, which was the actual bar
that acceptance criterion set.

**`apps/cli/test/cli.e2e.test.ts`** spawns the real `sw` binary as a child process via
`execFile`, not a function call into the CLI's exported code — so it's testing the exact
same argument parsing and process exit codes a user would actually experience. It caught
a real bug this way that a function-level test would have missed entirely: `sw budget
delete` silently failed every time, because the CLI's shared HTTP helper always sent
`Content-Type: application/json` even on a bodyless `DELETE`, and Fastify rejects that
combination outright before the route handler ever runs. `GET` commands never showed the
symptom because Fastify doesn't body-parse GET requests at all.

## Why top-level `await`, not `beforeAll`, for reachability checks

Every real-Postgres test file determines whether its database (and, for two files, its
API/MCP server) is reachable using a **top-level `await`** before any `describe` block is
declared, then gates the whole suite with `describe.skipIf(!available)`. This isn't
stylistic — `describe.skipIf()`'s condition is evaluated synchronously when the test file
is *collected*, before any `beforeAll` hook has a chance to run. An earlier version of
this pattern set an `available` flag inside `beforeAll` and read it in `describe.skipIf`;
the flag was always still `false` at that point, so the entire suite silently skipped
every single run without anyone noticing, because a skipped suite still reports "passed."
Top-level `await` in an ESM test file runs *before* collection finishes, so the flag it
sets is actually the value `skipIf` sees.

## A false alarm worth recording

While preparing this document, the full suite intermittently seemed to leave one
workspace behind in the database after a run — investigated at length, including
reproducing the exact cleanup queries standalone (always succeeded), adding
statement-by-statement debug logging to the actual test files (every statement reported
success, including the final `DELETE`'s own `rowCount`), and checking `rowCount`
specifically in case a `DELETE` was silently matching zero rows (a real possibility in
Postgres — a no-match delete isn't an error). The eventual finding: the leftover row was
a *single* piece of debris from earlier manual debugging in this same session, sitting
under a completely different id than the one each fresh test run was correctly creating
and deleting. Once purged, four consecutive full-suite runs left the database completely
clean every time. Recorded here rather than silently deleted from history, because
"investigated a suspected bug and concluded it wasn't one" is a real, useful outcome —
and because a fix was drafted for the wrong root cause (forcing sequential test-file
execution) before the real cause was found, and deliberately reverted once it was.
