/**
 * The explicit Phase 2 acceptance criterion from plan/07-roadmap.md: "1,000 concurrent
 * reserves against one balance never over-commit." This is the single most important
 * test in the project — the ledger's entire reason to exist is that this holds under
 * real concurrent load, not just in a single-threaded unit test.
 *
 * Pool `max` is raised well above node-postgres's default of 10 so a meaningful number of
 * transactions genuinely overlap in time and race for the SAME row lock — with the
 * default pool size, most of the 1,000 calls would just queue client-side and execute
 * near-sequentially, which would "pass" even if the row-locking logic were broken. This
 * only proves anything if real concurrent contention is created.
 */
import { describe, it, expect, afterAll } from "vitest";
import pg from "pg";
import { reserve, deposit, getAvailableBalance, InsufficientFundsError } from "../src/ledger.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://localhost/switchboard";
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 50 });
const dbAvailable = await pool.query("SELECT 1").then(() => true).catch(() => false);

afterAll(async () => {
  await pool.end();
});

describe.skipIf(!dbAvailable)("Ledger under real concurrency", () => {
  it(
    "1,000 concurrent reserves against one balance never over-commit",
    async () => {
      const externalFundingId = (await pool.query("SELECT id FROM accounts WHERE kind = 'external_funding'")).rows[0].id;
      const ws = await pool.query("INSERT INTO workspaces (name) VALUES ('concurrency-test') RETURNING id");
      const workspaceId = ws.rows[0].id;
      const acct = await pool.query(
        "INSERT INTO accounts (workspace_id, kind, currency) VALUES ($1, 'user_balance', 'USD') RETURNING id",
        [workspaceId]
      );
      const accountId = acct.rows[0].id;

      const FUNDED_MICROS = 1_000_000; // $1.00
      const PER_RESERVE_MICROS = 10_000; // $0.01
      const CONCURRENT_ATTEMPTS = 1000;
      const EXPECTED_SUCCESSES = FUNDED_MICROS / PER_RESERVE_MICROS; // exactly 100

      await deposit(pool, {
        accountId,
        amountMicros: FUNDED_MICROS,
        externalFundingAccountId: externalFundingId,
        idempotencyKey: `concurrency-deposit-${accountId}`,
      });

      // Fire all 1,000 truly concurrently — every promise starts before any of them
      // resolve. Each gets its OWN idempotency key, so this tests reserve()'s balance
      // check under contention, not its idempotency-replay path (that's covered
      // separately in ledger.test.ts).
      const attempts = Array.from({ length: CONCURRENT_ATTEMPTS }, (_, i) =>
        reserve(pool, { accountId, amountMicros: PER_RESERVE_MICROS, idempotencyKey: `concurrency-${accountId}-${i}` })
          .then(() => ({ ok: true as const }))
          .catch((err) => {
            if (err instanceof InsufficientFundsError) return { ok: false as const };
            throw err; // any OTHER error is a real bug, not an expected rejection — must not be swallowed
          })
      );

      const results = await Promise.all(attempts);
      const successes = results.filter((r) => r.ok).length;
      const failures = results.filter((r) => !r.ok).length;

      // The core assertion: exactly as many succeeded as the funded balance allows —
      // not more (over-commit, the bug this test exists to catch), and not fewer either
      // (which would mean correct requests were wrongly rejected).
      expect(successes).toBe(EXPECTED_SUCCESSES);
      expect(failures).toBe(CONCURRENT_ATTEMPTS - EXPECTED_SUCCESSES);

      // Cross-check independently via the database's own numbers, not just the promise
      // results — if these two ever disagreed, that itself would be a serious bug.
      const activeHolds = await pool.query(
        "SELECT COUNT(*) AS n, SUM(amount_micros) AS total FROM holds WHERE account_id = $1 AND state = 'active'",
        [accountId]
      );
      expect(Number(activeHolds.rows[0].n)).toBe(EXPECTED_SUCCESSES);
      expect(Number(activeHolds.rows[0].total)).toBe(FUNDED_MICROS);

      // Available balance must be exactly zero — every last micro-dollar accounted for,
      // nothing over-reserved, nothing under-reserved.
      expect(await getAvailableBalance(pool, accountId)).toBe(0);

      // Clean up — leaving debris behind is exactly the kind of thing that caused a
      // confusing, unrelated test failure elsewhere in this project (see ledger.test.ts's
      // header comment). Delete by transaction_id, both sides of every entry — deleting
      // ledger_entries by account_id alone misses the external_funding side of the
      // deposit and leaves an orphaned row that blocks deleting its parent transaction.
      const txnIds = await pool.query<{ id: string }>(
        "SELECT id FROM transactions WHERE idempotency_key = $1 OR idempotency_key LIKE $2",
        [`concurrency-deposit-${accountId}`, `concurrency-${accountId}-%`]
      );
      const ids = txnIds.rows.map((r) => r.id);
      if (ids.length > 0) {
        await pool.query("DELETE FROM ledger_entries WHERE transaction_id = ANY($1::uuid[])", [ids]);
        await pool.query("DELETE FROM transactions WHERE id = ANY($1::uuid[])", [ids]);
      }
      await pool.query("DELETE FROM holds WHERE account_id = $1", [accountId]);
      await pool.query("DELETE FROM accounts WHERE id = $1", [accountId]);
      await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
    },
    30_000 // real concurrent DB work; default 5s test timeout is too tight for 1,000 transactions
  );
});
