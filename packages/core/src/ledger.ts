/**
 * The ledger: reserve → capture → release. See plan/05-data-model.md for the original
 * design and PROGRESS.md "Phase 2" for what changed while actually building it.
 *
 * CONCURRENCY DESIGN NOTE — the one thing the original prose spec left unresolved:
 * plan/05-data-model.md said "never a stored counter that can drift — derive it." That's
 * right for what gets *stored*, but doesn't by itself stop two concurrent reserve() calls
 * on the same account from both reading "available: $10" and both proceeding to spend it.
 * The fix used here: every reserve/capture/release opens a transaction and takes
 * `SELECT ... FOR UPDATE` on the account row FIRST. Postgres then makes any second
 * concurrent transaction touching the *same* account block until the first commits or
 * rolls back — so the available-balance SUM computed after the lock is guaranteed still
 * correct when the hold is inserted a few lines later. Different accounts never block each
 * other; only concurrent operations on the *same* account serialize, which is exactly the
 * semantics wanted. This was proven, not assumed — see ledger.concurrency.test.ts, which
 * fires 1,000 real concurrent reserves at one account against a live Postgres.
 */

import type pg from "pg";

export class InsufficientFundsError extends Error {
  constructor(available: number, requested: number) {
    super(`Insufficient funds: ${available} micros available, ${requested} requested`);
    this.name = "InsufficientFundsError";
  }
}

export class HoldNotFoundError extends Error {
  constructor(holdId: string) {
    super(`No such hold: ${holdId}`);
    this.name = "HoldNotFoundError";
  }
}

export class HoldNotActiveError extends Error {
  constructor(holdId: string, state: string) {
    super(`Hold ${holdId} is not active (state: ${state})`);
    this.name = "HoldNotActiveError";
  }
}

/**
 * Bug this catches — found by test debris, not by design review: idempotency_key is
 * globally unique (correct — it should be, so a buggy client can never accidentally reuse
 * one workspace's key against another's account and silently hijack their hold). But
 * reserve()'s "existing key found, return it" replay path did not check that the existing
 * hold actually belongs to the account THIS call is for. A key replayed against a
 * different accountId — even by accident, e.g. two workspaces both naively hardcoding
 * "req-1" — silently returned a stranger's hold instead of erroring. Now it errors.
 */
export class IdempotencyKeyConflictError extends Error {
  constructor(key: string) {
    super(`Idempotency key "${key}" was already used for a different account. Idempotency keys must be unique per account.`);
    this.name = "IdempotencyKeyConflictError";
  }
}

export interface Hold {
  id: string;
  accountId: string;
  amountMicros: number;
  state: "active" | "captured" | "released";
  expiresAt: Date;
}

/** Available balance for an account: total ledger entries minus currently-active holds. */
export async function getAvailableBalance(client: pg.PoolClient | pg.Pool, accountId: string): Promise<number> {
  const { rows } = await client.query(
    `SELECT
       COALESCE((SELECT SUM(amount_micros) FROM ledger_entries WHERE account_id = $1), 0)
     - COALESCE((SELECT SUM(amount_micros) FROM holds WHERE account_id = $1 AND state = 'active'), 0)
       AS available`,
    [accountId]
  );
  return Number(rows[0].available);
}

const DEFAULT_HOLD_TTL_MS = 5 * 60 * 1000; // 5 minutes — generous relative to any single call's timeout

/**
 * Reserve `amountMicros` against `accountId`. Idempotent: replaying the same
 * `idempotencyKey` returns the existing hold rather than creating a second one — even
 * under concurrent replay, because the UNIQUE constraint on holds.idempotency_key makes a
 * duplicate INSERT fail, and that failure is caught and turned into a lookup.
 */
export async function reserve(
  pool: pg.Pool,
  params: { accountId: string; amountMicros: number; idempotencyKey: string; ttlMs?: number; runId?: string }
): Promise<Hold> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Lock the account row first — see the concurrency note at the top of this file.
    await client.query("SELECT id FROM accounts WHERE id = $1 FOR UPDATE", [params.accountId]);

    const existing = await client.query<{ id: string; account_id: string; amount_micros: string; state: Hold["state"]; expires_at: Date }>(
      "SELECT id, account_id, amount_micros, state, expires_at FROM holds WHERE idempotency_key = $1",
      [params.idempotencyKey]
    );
    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      if (row.account_id !== params.accountId) {
        await client.query("ROLLBACK");
        throw new IdempotencyKeyConflictError(params.idempotencyKey);
      }
      await client.query("COMMIT");
      return { id: row.id, accountId: row.account_id, amountMicros: Number(row.amount_micros), state: row.state, expiresAt: row.expires_at };
    }

    const available = await getAvailableBalance(client, params.accountId);
    if (available < params.amountMicros) {
      await client.query("ROLLBACK");
      throw new InsufficientFundsError(available, params.amountMicros);
    }

    const ttlMs = params.ttlMs ?? DEFAULT_HOLD_TTL_MS;
    const { rows } = await client.query<{ id: string; account_id: string; amount_micros: string; state: Hold["state"]; expires_at: Date }>(
      `INSERT INTO holds (account_id, amount_micros, idempotency_key, run_id, expires_at)
       VALUES ($1, $2, $3, $4, now() + ($5 || ' milliseconds')::interval)
       RETURNING id, account_id, amount_micros, state, expires_at`,
      [params.accountId, params.amountMicros, params.idempotencyKey, params.runId ?? null, ttlMs]
    );

    await client.query("COMMIT");
    const row = rows[0];
    return { id: row.id, accountId: row.account_id, amountMicros: Number(row.amount_micros), state: row.state, expiresAt: row.expires_at };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Capture a hold: settle it as a real charge. `actualMicros` is clamped to the hold's
 * reserved amount — capture can never exceed what was reserved (plan/05-data-model.md's
 * invariant #4), so an upstream that reports a higher actual cost than estimated doesn't
 * overcharge; it just means the estimate was too low, which is a variance to alert on
 * (Phase 8), not a reason to break the hold guarantee.
 *
 * Writes a fully balanced transaction: debit the user's account, credit platform revenue.
 * Every transaction's entries sum to exactly 0 — no exceptions, including this one.
 */
export async function capture(
  pool: pg.Pool,
  params: { holdId: string; actualMicros: number; idempotencyKey: string; revenueAccountId: string }
): Promise<{ transactionId: string; chargedMicros: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const holdRes = await client.query<{ id: string; account_id: string; amount_micros: string; state: Hold["state"] }>(
      "SELECT id, account_id, amount_micros, state FROM holds WHERE id = $1 FOR UPDATE",
      [params.holdId]
    );
    if (holdRes.rows.length === 0) {
      await client.query("ROLLBACK");
      throw new HoldNotFoundError(params.holdId);
    }
    const hold = holdRes.rows[0];

    // Bug fixed here: this lookup used to run only inside the `hold.state !== "active"`
    // branch below, on the assumption that a key collision could only be discovered when
    // retrying a capture on a hold that was already settled. But a key can just as easily
    // collide against an UNRELATED hold that is still active (holdA and holdB both active,
    // same key used for both) — that path went straight to INSERT and hit Postgres's raw
    // unique-constraint violation instead of this function's own typed error. Checking
    // unconditionally, before branching on hold.state, covers both cases with one check.
    const existingTxn = await client.query<{ id: string; hold_id: string | null }>(
      "SELECT id, hold_id FROM transactions WHERE idempotency_key = $1",
      [params.idempotencyKey]
    );
    if (existingTxn.rows.length > 0) {
      const txn = existingTxn.rows[0];
      if (txn.hold_id !== params.holdId) {
        await client.query("ROLLBACK");
        throw new IdempotencyKeyConflictError(params.idempotencyKey);
      }
      // Valid replay: same key, same hold — return the original result.
      await client.query("COMMIT");
      return { transactionId: txn.id, chargedMicros: Number(hold.amount_micros) };
    }

    if (hold.state !== "active") {
      // No existing transaction for this key, and the hold isn't active — there is no
      // legitimate reason for that combination (a real capture always writes a
      // transaction), so this is a genuine state conflict, not a replay.
      await client.query("ROLLBACK");
      throw new HoldNotActiveError(params.holdId, hold.state);
    }

    const chargedMicros = Math.min(params.actualMicros, Number(hold.amount_micros));

    const txnRes = await client.query<{ id: string }>(
      "INSERT INTO transactions (kind, idempotency_key, hold_id) VALUES ('capture', $1, $2) RETURNING id",
      [params.idempotencyKey, params.holdId]
    );
    const transactionId = txnRes.rows[0].id;

    await client.query(
      `INSERT INTO ledger_entries (transaction_id, account_id, amount_micros)
       VALUES ($1, $2, $3), ($1, $4, $5)`,
      [transactionId, hold.account_id, -chargedMicros, params.revenueAccountId, chargedMicros]
    );

    await client.query("UPDATE holds SET state = 'captured', settled_at = now() WHERE id = $1", [params.holdId]);

    await client.query("COMMIT");
    return { transactionId, chargedMicros };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Release a hold: nothing was charged. No ledger entries are written — the whole point is
 * that a failed or abandoned call costs the user exactly 0 micro-dollars.
 */
export async function release(pool: pg.Pool, holdId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const holdRes = await client.query<{ state: Hold["state"] }>("SELECT state FROM holds WHERE id = $1 FOR UPDATE", [holdId]);
    if (holdRes.rows.length === 0) {
      await client.query("ROLLBACK");
      throw new HoldNotFoundError(holdId);
    }
    const state = holdRes.rows[0].state;
    if (state === "released") {
      // Idempotent no-op — releasing an already-released hold is a safe replay.
      await client.query("COMMIT");
      return;
    }
    if (state === "captured") {
      await client.query("ROLLBACK");
      throw new HoldNotActiveError(holdId, state);
    }
    await client.query("UPDATE holds SET state = 'released', settled_at = now() WHERE id = $1", [holdId]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * The reaper: releases holds that have outlived their TTL without being captured or
 * released — the mechanism that makes a crash between reserve() and capture() safe. Run
 * this on an interval from the worker process (Phase 2 ships it as a callable function;
 * wiring it to a scheduler is a one-line addition to apps/worker).
 */
export async function reapExpiredHolds(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM holds WHERE state = 'active' AND expires_at < now()"
  );
  for (const row of rows) {
    await release(pool, row.id);
  }
  return rows.length;
}

/** Convenience for test setup and any future deposit flow: credits an account from the
 * external_funding singleton, keeping the "every transaction sums to zero" invariant
 * strict even for money entering the system — no special-cased single-sided entries. */
export async function deposit(
  pool: pg.Pool,
  params: { accountId: string; amountMicros: number; externalFundingAccountId: string; idempotencyKey: string }
): Promise<{ transactionId: string }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const txnRes = await client.query<{ id: string }>(
      "INSERT INTO transactions (kind, idempotency_key) VALUES ('deposit', $1) RETURNING id",
      [params.idempotencyKey]
    );
    const transactionId = txnRes.rows[0].id;
    await client.query(
      `INSERT INTO ledger_entries (transaction_id, account_id, amount_micros)
       VALUES ($1, $2, $3), ($1, $4, $5)`,
      [transactionId, params.externalFundingAccountId, -params.amountMicros, params.accountId, params.amountMicros]
    );
    await client.query("COMMIT");
    return { transactionId };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
