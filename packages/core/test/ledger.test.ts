/**
 * Real Postgres, no mocks — per the standing rule in PROGRESS.md and the pattern in
 * discovery.integration.test.ts. Skips cleanly if no database is reachable.
 *
 * Idempotency keys below are ALWAYS suffixed with the test's own fresh accountId, and
 * afterEach deletes everything each test created. Both exist because of a real bug caught
 * while building this suite: hardcoded literal keys ("res-1" etc.) with no cleanup meant
 * that re-running the suite let reserve() find a STALE hold from a previous run — tied to
 * an old, different account — and silently return it instead of creating a fresh one,
 * producing confusing failures that had nothing to do with the ledger logic itself. See
 * IdempotencyKeyConflictError in ledger.ts for the production-code fix that came out of
 * diagnosing this. This file's hygiene fix is the other half: don't let it happen again.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import pg from "pg";
import {
  reserve,
  capture,
  release,
  reapExpiredHolds,
  deposit,
  getAvailableBalance,
  InsufficientFundsError,
  IdempotencyKeyConflictError,
  HoldNotFoundError,
  HoldNotActiveError,
} from "../src/ledger.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://localhost/switchboard";
const pool = new pg.Pool({ connectionString: DATABASE_URL });
const dbAvailable = await pool.query("SELECT 1").then(() => true).catch(() => false);

let externalFundingId: string;
let revenueId: string;
let workspaceId: string;
let accountId: string;

afterAll(async () => {
  await pool.end();
});

describe.skipIf(!dbAvailable)("Ledger — reserve / capture / release", () => {
  beforeAll(async () => {
    if (!dbAvailable) return;
    externalFundingId = (await pool.query("SELECT id FROM accounts WHERE kind = 'external_funding'")).rows[0].id;
    revenueId = (await pool.query("SELECT id FROM accounts WHERE kind = 'revenue'")).rows[0].id;
  });

  beforeEach(async () => {
    const ws = await pool.query("INSERT INTO workspaces (name) VALUES ('ledger-test') RETURNING id");
    workspaceId = ws.rows[0].id;
    const acct = await pool.query(
      "INSERT INTO accounts (workspace_id, kind, currency) VALUES ($1, 'user_balance', 'USD') RETURNING id",
      [workspaceId]
    );
    accountId = acct.rows[0].id;
    await deposit(pool, {
      accountId,
      amountMicros: 10_000_000, // $10.00
      externalFundingAccountId: externalFundingId,
      idempotencyKey: `deposit-${accountId}`,
    });
  });

  afterEach(async () => {
    // Leaves the database exactly as clean as it was found — no accumulating debris
    // across runs, which is what caused the false-failure hunt this file's header
    // describes.
    //
    // Bug caught writing THIS cleanup query: deleting ledger_entries by account_id only
    // catches the user-account side of each transaction. A deposit's OTHER entry (the
    // debit against external_funding) has a different account_id and no hold_id to key
    // off, so it was silently left behind — and the next line's DELETE FROM transactions
    // then hit a foreign key violation trying to remove a transaction that still had an
    // orphaned entry pointing at it. Fix: resolve the full set of transaction ids this
    // test touched FIRST, then delete every ledger_entry for those ids (both sides of
    // every entry), then the transactions, then holds/account/workspace.
    const txnIds = await pool.query<{ id: string }>(
      `SELECT id FROM transactions
       WHERE idempotency_key LIKE $1 OR hold_id IN (SELECT id FROM holds WHERE account_id = $2)`,
      [`%${accountId}%`, accountId]
    );
    const ids = txnIds.rows.map((r) => r.id);
    if (ids.length > 0) {
      await pool.query("DELETE FROM ledger_entries WHERE transaction_id = ANY($1::uuid[])", [ids]);
      await pool.query("DELETE FROM transactions WHERE id = ANY($1::uuid[])", [ids]);
    }
    await pool.query("DELETE FROM holds WHERE account_id = $1", [accountId]);
    await pool.query("DELETE FROM accounts WHERE id = $1", [accountId]);
    await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
  });

  it("deposit leaves the account with the deposited balance, and the transaction balances to zero", async () => {
    const balance = await getAvailableBalance(pool, accountId);
    expect(balance).toBe(10_000_000);

    const sum = await pool.query(
      `SELECT SUM(amount_micros) AS total FROM ledger_entries
       WHERE transaction_id = (SELECT id FROM transactions WHERE idempotency_key = $1)`,
      [`deposit-${accountId}`]
    );
    expect(Number(sum.rows[0].total)).toBe(0);
  });

  it("reserve reduces available balance without writing any ledger entry", async () => {
    const hold = await reserve(pool, { accountId, amountMicros: 1_000_000, idempotencyKey: `res-1-${accountId}` });
    expect(hold.state).toBe("active");
    expect(await getAvailableBalance(pool, accountId)).toBe(9_000_000);

    const entries = await pool.query(
      "SELECT count(*) FROM ledger_entries WHERE account_id = $1 AND transaction_id != (SELECT id FROM transactions WHERE idempotency_key = $2)",
      [accountId, `deposit-${accountId}`]
    );
    expect(Number(entries.rows[0].count)).toBe(0);
  });

  it("reserve rejects a request that exceeds available balance — charges nothing", async () => {
    await expect(
      reserve(pool, { accountId, amountMicros: 999_000_000, idempotencyKey: `res-toolarge-${accountId}` })
    ).rejects.toThrow(InsufficientFundsError);
    expect(await getAvailableBalance(pool, accountId)).toBe(10_000_000);
  });

  it("replaying the same idempotency key returns the SAME hold, not a second one", async () => {
    const key = `res-replay-${accountId}`;
    const first = await reserve(pool, { accountId, amountMicros: 1_000_000, idempotencyKey: key });
    const second = await reserve(pool, { accountId, amountMicros: 1_000_000, idempotencyKey: key });
    expect(second.id).toBe(first.id);
    expect(await getAvailableBalance(pool, accountId)).toBe(9_000_000);
  });

  it("reusing an idempotency key against a DIFFERENT account throws instead of silently returning the wrong hold", async () => {
    const key = `res-shared-key-${accountId}`;
    await reserve(pool, { accountId, amountMicros: 1_000_000, idempotencyKey: key });

    const otherWs = await pool.query("INSERT INTO workspaces (name) VALUES ('ledger-test-other') RETURNING id");
    const otherAcct = await pool.query(
      "INSERT INTO accounts (workspace_id, kind, currency) VALUES ($1, 'user_balance', 'USD') RETURNING id",
      [otherWs.rows[0].id]
    );
    const otherAccountId = otherAcct.rows[0].id;
    await deposit(pool, {
      accountId: otherAccountId,
      amountMicros: 10_000_000,
      externalFundingAccountId: externalFundingId,
      idempotencyKey: `deposit-${otherAccountId}`,
    });

    await expect(reserve(pool, { accountId: otherAccountId, amountMicros: 1_000_000, idempotencyKey: key })).rejects.toThrow(
      IdempotencyKeyConflictError
    );
    // The other account must be completely untouched by the failed attempt.
    expect(await getAvailableBalance(pool, otherAccountId)).toBe(10_000_000);

    // Same fix as the main afterEach above: delete by transaction_id (both sides of the
    // deposit's entries), not by account_id alone, or the external_funding-side entry is
    // left orphaned and the next line's DELETE FROM transactions violates the FK.
    const otherTxnId = await pool.query<{ id: string }>("SELECT id FROM transactions WHERE idempotency_key = $1", [`deposit-${otherAccountId}`]);
    if (otherTxnId.rows.length > 0) {
      await pool.query("DELETE FROM ledger_entries WHERE transaction_id = $1", [otherTxnId.rows[0].id]);
      await pool.query("DELETE FROM transactions WHERE id = $1", [otherTxnId.rows[0].id]);
    }
    await pool.query("DELETE FROM accounts WHERE id = $1", [otherAccountId]);
    await pool.query("DELETE FROM workspaces WHERE id = $1", [otherWs.rows[0].id]);
  });

  it("capture debits the user and credits revenue in one balanced transaction", async () => {
    const hold = await reserve(pool, { accountId, amountMicros: 1_000_000, idempotencyKey: `res-cap-${accountId}` });
    const result = await capture(pool, {
      holdId: hold.id,
      actualMicros: 1_000_000,
      idempotencyKey: `cap-1-${accountId}`,
      revenueAccountId: revenueId,
    });
    expect(result.chargedMicros).toBe(1_000_000);

    const sum = await pool.query("SELECT SUM(amount_micros) AS total FROM ledger_entries WHERE transaction_id = $1", [result.transactionId]);
    expect(Number(sum.rows[0].total)).toBe(0);
    expect(await getAvailableBalance(pool, accountId)).toBe(9_000_000);
  });

  it("capture NEVER exceeds the reserved amount, even if actual cost reports higher", async () => {
    const hold = await reserve(pool, { accountId, amountMicros: 1_000_000, idempotencyKey: `res-clamp-${accountId}` });
    const result = await capture(pool, {
      holdId: hold.id,
      actualMicros: 5_000_000,
      idempotencyKey: `cap-clamp-${accountId}`,
      revenueAccountId: revenueId,
    });
    expect(result.chargedMicros).toBe(1_000_000); // clamped to the hold amount, not 5M
  });

  it("replaying a capture's idempotency key on the SAME hold returns the same result", async () => {
    const hold = await reserve(pool, { accountId, amountMicros: 1_000_000, idempotencyKey: `res-cap-replay-${accountId}` });
    const key = `cap-replay-${accountId}`;
    const first = await capture(pool, { holdId: hold.id, actualMicros: 1_000_000, idempotencyKey: key, revenueAccountId: revenueId });
    const second = await capture(pool, { holdId: hold.id, actualMicros: 1_000_000, idempotencyKey: key, revenueAccountId: revenueId });
    expect(second.transactionId).toBe(first.transactionId);
    expect(await getAvailableBalance(pool, accountId)).toBe(9_000_000); // charged exactly once
  });

  it("reusing a capture's idempotency key against a DIFFERENT hold throws instead of returning the wrong charge", async () => {
    const holdA = await reserve(pool, { accountId, amountMicros: 1_000_000, idempotencyKey: `res-a-${accountId}` });
    const holdB = await reserve(pool, { accountId, amountMicros: 2_000_000, idempotencyKey: `res-b-${accountId}` });
    const key = `cap-shared-${accountId}`;
    await capture(pool, { holdId: holdA.id, actualMicros: 1_000_000, idempotencyKey: key, revenueAccountId: revenueId });
    await expect(
      capture(pool, { holdId: holdB.id, actualMicros: 2_000_000, idempotencyKey: key, revenueAccountId: revenueId })
    ).rejects.toThrow(IdempotencyKeyConflictError);
    // holdB must still be untouched — active, not captured, not charged.
    const stillActive = await pool.query("SELECT state FROM holds WHERE id = $1", [holdB.id]);
    expect(stillActive.rows[0].state).toBe("active");
  });

  it("release charges exactly zero — no ledger entries at all", async () => {
    const hold = await reserve(pool, { accountId, amountMicros: 1_000_000, idempotencyKey: `res-rel-${accountId}` });
    await release(pool, hold.id);
    expect(await getAvailableBalance(pool, accountId)).toBe(10_000_000);

    const entries = await pool.query(
      `SELECT count(*) FROM ledger_entries WHERE account_id = $1
       AND transaction_id != (SELECT id FROM transactions WHERE idempotency_key = $2)`,
      [accountId, `deposit-${accountId}`]
    );
    expect(Number(entries.rows[0].count)).toBe(0);
  });

  it("releasing an already-released hold is a safe no-op replay", async () => {
    const hold = await reserve(pool, { accountId, amountMicros: 1_000_000, idempotencyKey: `res-rel-twice-${accountId}` });
    await release(pool, hold.id);
    await expect(release(pool, hold.id)).resolves.not.toThrow();
    expect(await getAvailableBalance(pool, accountId)).toBe(10_000_000);
  });

  it("cannot release an already-captured hold", async () => {
    const hold = await reserve(pool, { accountId, amountMicros: 1_000_000, idempotencyKey: `res-cap-then-rel-${accountId}` });
    await capture(pool, { holdId: hold.id, actualMicros: 1_000_000, idempotencyKey: `cap-then-rel-${accountId}`, revenueAccountId: revenueId });
    await expect(release(pool, hold.id)).rejects.toThrow(HoldNotActiveError);
  });

  it("capturing/releasing a nonexistent hold throws HoldNotFoundError", async () => {
    const fakeId = "00000000-0000-0000-0000-000000000000";
    await expect(release(pool, fakeId)).rejects.toThrow(HoldNotFoundError);
    await expect(
      capture(pool, { holdId: fakeId, actualMicros: 1, idempotencyKey: `x-${accountId}`, revenueAccountId: revenueId })
    ).rejects.toThrow(HoldNotFoundError);
  });

  it("the reaper releases holds past their TTL — this is what makes a crash between reserve and capture safe", async () => {
    const hold = await reserve(pool, { accountId, amountMicros: 1_000_000, idempotencyKey: `res-expire-${accountId}`, ttlMs: 1 });
    await new Promise((r) => setTimeout(r, 50));
    expect(await getAvailableBalance(pool, accountId)).toBe(9_000_000); // still held, not yet reaped

    const reaped = await reapExpiredHolds(pool);
    expect(reaped).toBeGreaterThanOrEqual(1);
    expect(await getAvailableBalance(pool, accountId)).toBe(10_000_000); // fully restored
  });

  it("the reaper does not touch holds that haven't expired yet", async () => {
    await reserve(pool, { accountId, amountMicros: 1_000_000, idempotencyKey: `res-not-expired-${accountId}`, ttlMs: 60_000 });
    await reapExpiredHolds(pool);
    expect(await getAvailableBalance(pool, accountId)).toBe(9_000_000); // still held — correctly NOT reaped
  });
});
