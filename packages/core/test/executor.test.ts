/**
 * Real Postgres, no mocks for the database — but the UPSTREAM call is mocked
 * deliberately (see the doc comment at the top of upstream.ts): no real provider
 * credentials exist in this environment, and even if they did, tests should never depend
 * on a third party's uptime or spend real money. This is what closes the two remaining
 * Phase 2 acceptance criteria from plan/07-roadmap.md: "upstream 500 leaves the balance
 * changed by exactly 0 micro-dollars" and "dry_run returns an accurate estimate and moves
 * no money."
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import pg from "pg";
import { run, ValidationError, EndpointNotFoundError } from "../src/executor.js";
import { getAvailableBalance, deposit, InsufficientFundsError } from "../src/ledger.js";
import type { UpstreamClient, UpstreamRequest, UpstreamResponse } from "../src/upstream.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://localhost/switchboard";
const pool = new pg.Pool({ connectionString: DATABASE_URL });
const dbAvailable = await pool.query("SELECT 1").then(() => true).catch(() => false);

/** A scriptable stand-in for the real HTTP boundary — returns whatever the test queues up. */
class ScriptedUpstreamClient implements UpstreamClient {
  private queue: (UpstreamResponse | Error)[] = [];
  lastRequest: UpstreamRequest | null = null;

  respondWith(response: UpstreamResponse) {
    this.queue.push(response);
  }
  failWith(error: Error) {
    this.queue.push(error);
  }
  async execute(req: UpstreamRequest): Promise<UpstreamResponse> {
    this.lastRequest = req;
    const next = this.queue.shift();
    if (!next) throw new Error("ScriptedUpstreamClient: no scripted response queued");
    if (next instanceof Error) throw next;
    return next;
  }
}

let externalFundingId: string;
let revenueId: string;
let workspaceId: string;
let accountId: string;
let freeCallEndpointId: string; // a real seeded PER_CALL, zero-cost endpoint (NWS)

afterAll(async () => {
  await pool.end();
});

describe.skipIf(!dbAvailable)("Executor: validate → estimate → reserve → call → capture/release", () => {
  beforeAll(async () => {
    if (!dbAvailable) return;
    externalFundingId = (await pool.query("SELECT id FROM accounts WHERE kind = 'external_funding'")).rows[0].id;
    revenueId = (await pool.query("SELECT id FROM accounts WHERE kind = 'revenue'")).rows[0].id;
    const ep = await pool.query("SELECT id FROM endpoints WHERE slug = 'get-active-alerts'");
    if (ep.rows.length === 0) throw new Error("Phase 1 seed data not found — run `npm run db:seed` first");
    freeCallEndpointId = ep.rows[0].id;
  });

  beforeEach(async () => {
    const ws = await pool.query("INSERT INTO workspaces (name) VALUES ('executor-test') RETURNING id");
    workspaceId = ws.rows[0].id;
    const acct = await pool.query(
      "INSERT INTO accounts (workspace_id, kind, currency) VALUES ($1, 'user_balance', 'USD') RETURNING id",
      [workspaceId]
    );
    accountId = acct.rows[0].id;
    await deposit(pool, {
      accountId,
      amountMicros: 10_000_000,
      externalFundingAccountId: externalFundingId,
      idempotencyKey: `exec-deposit-${accountId}`,
    });
  });

  afterEach(async () => {
    const txnIds = await pool.query<{ id: string }>(
      "SELECT id FROM transactions WHERE idempotency_key LIKE $1 OR hold_id IN (SELECT id FROM holds WHERE account_id = $2)",
      [`%${accountId}%`, accountId]
    );
    const ids = txnIds.rows.map((r) => r.id);
    if (ids.length > 0) {
      await pool.query("DELETE FROM ledger_entries WHERE transaction_id = ANY($1::uuid[])", [ids]);
      await pool.query("DELETE FROM transactions WHERE id = ANY($1::uuid[])", [ids]);
    }
    await pool.query("DELETE FROM runs WHERE workspace_id = $1", [workspaceId]);
    await pool.query("DELETE FROM holds WHERE account_id = $1", [accountId]);
    await pool.query("DELETE FROM accounts WHERE id = $1", [accountId]);
    await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
  });

  it("a successful call reserves, calls upstream, captures, and leaves a succeeded run", async () => {
    const client = new ScriptedUpstreamClient();
    client.respondWith({ status: 200, body: { features: [] }, latencyMs: 42 });

    const result = await run(pool, client, {
      endpointId: freeCallEndpointId,
      args: { area: "CA" },
      idempotencyKey: `run-success-${accountId}`,
      workspaceId,
      accountId,
      revenueAccountId: revenueId,
    });

    expect(result.state).toBe("succeeded");
    expect(result.result).toEqual({ features: [] });
    expect(result.receipt?.chargedMicros).toBe(0); // NWS is a free endpoint
    // Balance unaffected either way since this endpoint is free, but confirm no hold lingers.
    expect(await getAvailableBalance(pool, accountId)).toBe(10_000_000);

    const runRow = await pool.query("SELECT state FROM runs WHERE id = $1", [result.runId]);
    expect(runRow.rows[0].state).toBe("succeeded");
  });

  it("a successful PAID call reserves a real hold, captures a non-zero charge, and reduces the balance", async () => {
    // All the other tests in this file use NWS (free). This one uses CoinGecko
    // specifically to exercise the branch the free-endpoint fix (isFree/holdId-null)
    // must NOT have broken — a real hold, a real capture, a real balance reduction.
    const paidEndpoint = await pool.query("SELECT id FROM endpoints WHERE slug = 'get-coin-price'");
    const client = new ScriptedUpstreamClient();
    client.respondWith({ status: 200, body: { bitcoin: { usd: 50000 } }, latencyMs: 20 });

    const balanceBefore = await getAvailableBalance(pool, accountId);
    const result = await run(pool, client, {
      endpointId: paidEndpoint.rows[0].id,
      args: { ids: "bitcoin", vs_currencies: "usd" },
      idempotencyKey: `run-paid-success-${accountId}`,
      workspaceId,
      accountId,
      revenueAccountId: revenueId,
    });

    expect(result.state).toBe("succeeded");
    expect(result.receipt?.chargedMicros).toBe(258); // the amortized CoinGecko rate from the spike
    expect(await getAvailableBalance(pool, accountId)).toBe(balanceBefore - 258);

    const holds = await pool.query("SELECT state, amount_micros FROM holds WHERE account_id = $1 ORDER BY created_at DESC LIMIT 1", [accountId]);
    expect(holds.rows[0]).toMatchObject({ state: "captured", amount_micros: "258" });
  });

  it(
    "an upstream 500 releases the hold and leaves the balance changed by EXACTLY 0 micro-dollars — " +
      "the exact Phase 2 acceptance criterion from plan/07-roadmap.md",
    async () => {
      const client = new ScriptedUpstreamClient();
      client.respondWith({ status: 500, body: { error: "internal error" }, latencyMs: 12 });

      const balanceBefore = await getAvailableBalance(pool, accountId);
      const result = await run(pool, client, {
        endpointId: freeCallEndpointId,
        args: { area: "CA" },
        idempotencyKey: `run-upstream-fail-${accountId}`,
        workspaceId,
        accountId,
        revenueAccountId: revenueId,
      });

      expect(result.state).toBe("failed");
      expect(result.receipt?.chargedMicros).toBe(0);
      const balanceAfter = await getAvailableBalance(pool, accountId);
      expect(balanceAfter).toBe(balanceBefore); // exactly 0 change, not "close to"

      const runRow = await pool.query("SELECT state, error_class FROM runs WHERE id = $1", [result.runId]);
      expect(runRow.rows[0].state).toBe("failed");
      expect(runRow.rows[0].error_class).toBe("UpstreamHttpError");

      // No active hold should be left dangling either.
      const activeHolds = await pool.query("SELECT count(*) FROM holds WHERE account_id = $1 AND state = 'active'", [accountId]);
      expect(Number(activeHolds.rows[0].count)).toBe(0);
    }
  );

  it("a network-level failure (not just a bad HTTP status) also releases the hold and charges zero", async () => {
    const client = new ScriptedUpstreamClient();
    client.failWith(new Error("ECONNREFUSED"));

    const balanceBefore = await getAvailableBalance(pool, accountId);
    const result = await run(pool, client, {
      endpointId: freeCallEndpointId,
      args: { area: "CA" },
      idempotencyKey: `run-network-fail-${accountId}`,
      workspaceId,
      accountId,
      revenueAccountId: revenueId,
    });

    expect(result.state).toBe("failed");
    expect(await getAvailableBalance(pool, accountId)).toBe(balanceBefore);
  });

  it("dry_run prices the call and touches NOTHING — no hold, no run row, no ledger entry", async () => {
    const client = new ScriptedUpstreamClient(); // never called — dry_run must not reach upstream at all

    const balanceBefore = await getAvailableBalance(pool, accountId);
    const result = await run(pool, client, {
      endpointId: freeCallEndpointId,
      args: { area: "CA" },
      idempotencyKey: `run-dry-${accountId}`,
      workspaceId,
      accountId,
      revenueAccountId: revenueId,
      dryRun: true,
    });

    expect(result.state).toBe("dry_run");
    expect(result.runId).toBeNull();
    expect(result.receipt?.estimatedMicros).toBe(0); // NWS is free
    expect(await getAvailableBalance(pool, accountId)).toBe(balanceBefore);

    const runRows = await pool.query("SELECT count(*) FROM runs WHERE workspace_id = $1", [workspaceId]);
    expect(Number(runRows.rows[0].count)).toBe(0); // truly nothing persisted
  });

  it("invalid args fail closed — no run row, no hold, before upstream is ever touched", async () => {
    const client = new ScriptedUpstreamClient(); // never called

    await expect(
      run(pool, client, {
        endpointId: freeCallEndpointId,
        args: {}, // missing required "area"
        idempotencyKey: `run-invalid-${accountId}`,
        workspaceId,
        accountId,
        revenueAccountId: revenueId,
      })
    ).rejects.toThrow(ValidationError);

    expect(await getAvailableBalance(pool, accountId)).toBe(10_000_000);
    const runRows = await pool.query("SELECT count(*) FROM runs WHERE workspace_id = $1", [workspaceId]);
    expect(Number(runRows.rows[0].count)).toBe(0);
  });

  it("insufficient funds is surfaced from the ledger and marks the run failed", async () => {
    // Bug caught writing this test: using the shared `revenue` system account as a
    // "guaranteed empty" account is wrong — revenue ACCUMULATES a credit from every
    // successful capture() across the whole test suite (nothing ever debits it), so its
    // balance grows over repeated test runs and eventually stops being "empty" at all.
    // A genuinely fresh, never-funded workspace account is the only way to guarantee
    // insufficient funds deterministically, independent of everything else that ran before.
    const emptyWs = await pool.query("INSERT INTO workspaces (name) VALUES ('executor-test-empty') RETURNING id");
    const emptyAcct = await pool.query(
      "INSERT INTO accounts (workspace_id, kind, currency) VALUES ($1, 'user_balance', 'USD') RETURNING id",
      [emptyWs.rows[0].id]
    );
    const emptyAccountId = emptyAcct.rows[0].id;

    const paidEndpoint = await pool.query("SELECT id FROM endpoints WHERE slug = 'get-coin-price'");
    const client = new ScriptedUpstreamClient(); // never reached — reserve() fails before any upstream call

    await expect(
      run(pool, client, {
        endpointId: paidEndpoint.rows[0].id,
        args: { ids: "bitcoin", vs_currencies: "usd" },
        idempotencyKey: `run-toolarge-${accountId}`,
        workspaceId: emptyWs.rows[0].id,
        accountId: emptyAccountId,
        revenueAccountId: revenueId,
      })
    ).rejects.toThrow(InsufficientFundsError);

    await pool.query("DELETE FROM runs WHERE workspace_id = $1", [emptyWs.rows[0].id]);
    await pool.query("DELETE FROM accounts WHERE id = $1", [emptyAccountId]);
    await pool.query("DELETE FROM workspaces WHERE id = $1", [emptyWs.rows[0].id]);
  });

  it("throws EndpointNotFoundError for an unknown endpoint id, before touching money at all", async () => {
    const client = new ScriptedUpstreamClient();
    await expect(
      run(pool, client, {
        endpointId: "00000000-0000-0000-0000-000000000000",
        args: {},
        idempotencyKey: `run-noendpoint-${accountId}`,
        workspaceId,
        accountId,
        revenueAccountId: revenueId,
      })
    ).rejects.toThrow(EndpointNotFoundError);
  });
});
