# Contributing

Read [ARCHITECTURE.md](ARCHITECTURE.md) and [TESTING.md](TESTING.md) first — they explain
the decisions worth knowing before touching the ledger or policy engine specifically.
[PROGRESS.md](PROGRESS.md) has the current state of every phase.

## Before you start

```bash
npm install
createdb switchboard
DATABASE_URL="postgresql://localhost/switchboard" npm run db:migrate
DATABASE_URL="postgresql://localhost/switchboard" npm run db:seed
DATABASE_URL="postgresql://localhost/switchboard" npm test
```

All tests should pass before you make a change, and before you open a PR.

## The rules that actually matter here

These aren't style preferences — they're the reason the ledger is trustworthy at all.
Violating them will get a PR asked to change, not merged as-is:

1. **Money is integer micro-dollars. Never float, never `NUMERIC` arithmetic in
   application code.** See [`packages/shared/src/money.ts`](packages/shared/src/money.ts).
2. **Never write to a balance directly.** All money movement goes through
   `reserve`/`capture`/`release`/`deposit` in
   [`packages/core/src/ledger.ts`](packages/core/src/ledger.ts). If you find yourself
   writing a raw `INSERT INTO ledger_entries` outside that file, stop — that's exactly
   how the invariants in [ARCHITECTURE.md](ARCHITECTURE.md) get silently broken.
3. **Every transaction's entries must sum to exactly zero.** No exceptions, including
   money entering the system (see `deposit()`'s use of the `external_funding` account).
4. **Real Postgres in tests, never mocks**, for anything touching the database. See the
   pattern in `packages/core/test/ledger.test.ts`: a top-level `await` to check
   reachability, `describe.skipIf` on that, real fixtures, real cleanup.
5. **A regression test isn't proven until you've watched it fail.** Before trusting a new
   test that guards against a bug, temporarily reintroduce the bug and confirm the test
   actually catches it. [TESTING.md](TESTING.md) has several worked examples.
6. **Verify before you claim.** If a change touches something you can run — a migration,
   an endpoint, a CLI command — actually run it and paste the real output in the PR
   description, not "should work."

## Adding a catalogue endpoint

Every provider needs a resale check before it's onboarded — see
[`plan/12-provider-shortlist.md`](plan/12-provider-shortlist.md) for the standard and the
existing examples. Concretely, before adding an endpoint to
[`packages/db/src/seed/endpoints.ts`](packages/db/src/seed/endpoints.ts):

1. Read the provider's actual terms of service. Quote the specific clause that permits
   (or doesn't permit) reselling/proxying access. "Free tier" and "resale-permitted" are
   unrelated axes — don't assume one implies the other.
2. Add the provider to
   [`packages/db/src/seed/providers.ts`](packages/db/src/seed/providers.ts) with
   `resale_allowed` and a `resale_note` containing that quote.
3. Express its pricing in the `PricingModel` shape from
   [`packages/core/src/pricing.ts`](packages/core/src/pricing.ts). Run it through
   `validatePricingModel()` — it's a hard gate for a reason; see the doc comment above
   that function for the bug it exists to catch.
4. Add real, working `input_schema`, `example_queries`, and `categories` — these
   directly affect discovery quality for that endpoint and every other one it competes
   against in ranking.

## Pull requests

- One logical change per PR. A bug fix doesn't need a drive-by refactor riding along.
- If you found a bug while building something else, say so explicitly and explain how you
  verified the fix (see rule 5 above) — that context is worth more than the diff alone.
- Update [PROGRESS.md](PROGRESS.md) if your change affects which phase-acceptance
  criteria are met.

## License

Apache-2.0 — see [LICENSE](LICENSE). By contributing, you agree your contribution is
licensed under the same terms.
