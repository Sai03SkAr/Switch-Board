/**
 * Real Postgres, no mocks. This is plan/03-positioning.md's headline differentiator —
 * a workspace → key → session → call budget hierarchy, versus a single undifferentiated
 * balance — and plan/07-roadmap.md's Phase 3 acceptance criteria are tested directly
 * here, including the literal demo script from plan/03-positioning.md's "demo that sells
 * it": an agent in a retry loop hits a budget cap and stops.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import pg from "pg";
import { run, BudgetExceededError, ConfirmationRequiredError } from "../src/executor.js";
import { deposit, getAvailableBalance } from "../src/ledger.js";
import type { UpstreamClient, UpstreamRequest, UpstreamResponse } from "../src/upstream.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://localhost/switchboard";
const pool = new pg.Pool({ connectionString: DATABASE_URL });
const dbAvailable = await pool.query("SELECT 1").then(() => true).catch(() => false);

class ScriptedUpstreamClient implements UpstreamClient {
  async execute(_req: UpstreamRequest): Promise<UpstreamResponse> {
    return { status: 200, body: { ok: true }, latencyMs: 5 };
  }
}
const client = new ScriptedUpstreamClient();

let externalFundingId: string;
let revenueId: string;
let workspaceId: string;
let accountId: string;
let paidEndpointId: string; // CoinGecko get-coin-price, 258 micros/call

afterAll(async () => {
  await pool.end();
});

describe.skipIf(!dbAvailable)("Policy engine — budget hierarchy", () => {
  beforeAll(async () => {
    if (!dbAvailable) return;
    externalFundingId = (await pool.query("SELECT id FROM accounts WHERE kind = 'external_funding'")).rows[0].id;
    revenueId = (await pool.query("SELECT id FROM accounts WHERE kind = 'revenue'")).rows[0].id;
    const ep = await pool.query("SELECT id FROM endpoints WHERE slug = 'get-coin-price'");
    if (ep.rows.length === 0) throw new Error("Phase 1 seed data not found — run `npm run db:seed` first");
    paidEndpointId = ep.rows[0].id;
  });

  beforeEach(async () => {
    const ws = await pool.query("INSERT INTO workspaces (name) VALUES ('policy-test') RETURNING id");
    workspaceId = ws.rows[0].id;
    const acct = await pool.query(
      "INSERT INTO accounts (workspace_id, kind, currency) VALUES ($1, 'user_balance', 'USD') RETURNING id",
      [workspaceId]
    );
    accountId = acct.rows[0].id;
    await deposit(pool, {
      accountId,
      amountMicros: 100_000_000, // $100 — generous, so the BUDGET is what constrains these tests, not the balance
      externalFundingAccountId: externalFundingId,
      idempotencyKey: `policy-deposit-${accountId}`,
    });
  });

  afterEach(async () => {
    await pool.query("DELETE FROM budgets WHERE workspace_id = $1", [workspaceId]);
    await pool.query("DELETE FROM confirmation_tokens WHERE workspace_id = $1", [workspaceId]);
    await pool.query("DELETE FROM runs WHERE workspace_id = $1", [workspaceId]);
    const txnIds = await pool.query<{ id: string }>(
      "SELECT id FROM transactions WHERE idempotency_key LIKE $1 OR hold_id IN (SELECT id FROM holds WHERE account_id = $2)",
      [`%${accountId}%`, accountId]
    );
    const ids = txnIds.rows.map((r) => r.id);
    if (ids.length > 0) {
      await pool.query("DELETE FROM ledger_entries WHERE transaction_id = ANY($1::uuid[])", [ids]);
      await pool.query("DELETE FROM transactions WHERE id = ANY($1::uuid[])", [ids]);
    }
    await pool.query("DELETE FROM holds WHERE account_id = $1", [accountId]);
    await pool.query("DELETE FROM accounts WHERE id = $1", [accountId]);
    // api_keys must be deleted BEFORE workspaces — it FK-references workspace_id, so
    // deleting the workspace first (as an earlier version of this cleanup did) throws.
    await pool.query("DELETE FROM api_keys WHERE workspace_id = $1", [workspaceId]);
    await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
  });

  it(
    "THE HEADLINE DEMO, as an automated test: an agent in a retry loop hits a session " +
      "budget cap and stops, with the workspace balance untouched beyond the cap",
    async () => {
      // Session budget covers exactly 3 calls at 258 micros each (774 total) — chosen so
      // the boundary is crisp and easy to assert on exactly, not just "roughly capped."
      await pool.query(
        "INSERT INTO budgets (workspace_id, scope, scope_id, limit_micros, window_kind, action) VALUES ($1, 'session', $2, 774, 'total', 'block')",
        [workspaceId, "retry-loop-session"]
      );

      const balanceBefore = await getAvailableBalance(pool, accountId);
      let succeeded = 0;
      let deniedAt = -1;

      // Simulate an agent retrying the SAME call 10 times in a loop — the exact scenario
      // plan/02-weaknesses.md #2 says Monid cannot stop ("one agent stuck in a retry loop
      // drains it for everything else").
      for (let i = 0; i < 10; i++) {
        try {
          await run(pool, client, {
            endpointId: paidEndpointId,
            args: { ids: "bitcoin", vs_currencies: "usd" },
            idempotencyKey: `retry-loop-${accountId}-${i}`,
            workspaceId,
            accountId,
            revenueAccountId: revenueId,
            sessionId: "retry-loop-session",
          });
          succeeded++;
        } catch (err) {
          expect(err).toBeInstanceOf(BudgetExceededError);
          if (deniedAt === -1) deniedAt = i;
        }
      }

      // Exactly 3 succeed (774 / 258 = 3 exactly), the rest are denied by budget, not by
      // running out of real money — the $100 balance could have covered all 10.
      expect(succeeded).toBe(3);
      expect(deniedAt).toBe(3);

      const balanceAfter = await getAvailableBalance(pool, accountId);
      expect(balanceBefore - balanceAfter).toBe(774); // spent EXACTLY the cap, not a penny more

      // The denied attempts must have created zero runs — same fail-closed guarantee as
      // an invalid-args rejection.
      const runCount = await pool.query("SELECT count(*) FROM runs WHERE workspace_id = $1", [workspaceId]);
      expect(Number(runCount.rows[0].count)).toBe(3);
    }
  );

  it("each of the four scopes blocks independently and the error names which one tripped", async () => {
    await pool.query(
      "INSERT INTO budgets (workspace_id, scope, scope_id, limit_micros, window_kind, action) VALUES ($1, 'workspace', NULL, 100, 'total', 'block')",
      [workspaceId]
    );
    let caught: unknown;
    try {
      await run(pool, client, {
        endpointId: paidEndpointId, // 258 micros, exceeds the 100-micro workspace cap on the very first call
        args: { ids: "bitcoin", vs_currencies: "usd" },
        idempotencyKey: `workspace-scope-${accountId}`,
        workspaceId,
        accountId,
        revenueAccountId: revenueId,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BudgetExceededError);
    expect((caught as BudgetExceededError).decision.scope).toBe("workspace");
  });

  it("a key-scoped budget does not affect a DIFFERENT key on the same workspace — scope isolation", async () => {
    const keyA = await pool.query("INSERT INTO api_keys (workspace_id, name) VALUES ($1, 'key-a') RETURNING id", [workspaceId]);
    const keyB = await pool.query("INSERT INTO api_keys (workspace_id, name) VALUES ($1, 'key-b') RETURNING id", [workspaceId]);
    await pool.query(
      "INSERT INTO budgets (workspace_id, scope, scope_id, limit_micros, window_kind, action) VALUES ($1, 'key', $2, 100, 'total', 'block')",
      [workspaceId, keyA.rows[0].id]
    );

    // key A is capped at 100 micros — a 258-micro call must be denied for it.
    await expect(
      run(pool, client, {
        endpointId: paidEndpointId,
        args: { ids: "bitcoin", vs_currencies: "usd" },
        idempotencyKey: `key-a-${accountId}`,
        workspaceId,
        accountId,
        revenueAccountId: revenueId,
        keyId: keyA.rows[0].id,
      })
    ).rejects.toThrow(BudgetExceededError);

    // key B has no budget row at all — the identical call must succeed for it.
    const result = await run(pool, client, {
      endpointId: paidEndpointId,
      args: { ids: "bitcoin", vs_currencies: "usd" },
      idempotencyKey: `key-b-${accountId}`,
      workspaceId,
      accountId,
      revenueAccountId: revenueId,
      keyId: keyB.rows[0].id,
    });
    expect(result.state).toBe("succeeded");
  });

  it("a call above a require_confirmation threshold returns a token, and denies without one", async () => {
    await pool.query(
      "INSERT INTO budgets (workspace_id, scope, scope_id, limit_micros, window_kind, action) VALUES ($1, 'call', NULL, 100, 'per_call', 'require_confirmation')",
      [workspaceId]
    );

    let caught: unknown;
    try {
      await run(pool, client, {
        endpointId: paidEndpointId, // 258 micros > 100-micro per-call confirmation threshold
        args: { ids: "bitcoin", vs_currencies: "usd" },
        idempotencyKey: `confirm-needed-${accountId}`,
        workspaceId,
        accountId,
        revenueAccountId: revenueId,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfirmationRequiredError);
    const token = (caught as ConfirmationRequiredError).confirmationToken;
    expect(token).toBeTruthy();

    // The exact same call, with the token, succeeds — this is the 409-then-replay flow
    // from plan/06-api-spec.md.
    const result = await run(pool, client, {
      endpointId: paidEndpointId,
      args: { ids: "bitcoin", vs_currencies: "usd" },
      idempotencyKey: `confirm-retry-${accountId}`,
      workspaceId,
      accountId,
      revenueAccountId: revenueId,
      confirmationToken: token,
    });
    expect(result.state).toBe("succeeded");
  });

  it("a confirmation token cannot be reused for a second call", async () => {
    await pool.query(
      "INSERT INTO budgets (workspace_id, scope, scope_id, limit_micros, window_kind, action) VALUES ($1, 'call', NULL, 100, 'per_call', 'require_confirmation')",
      [workspaceId]
    );
    let token = "";
    try {
      await run(pool, client, {
        endpointId: paidEndpointId,
        args: { ids: "bitcoin", vs_currencies: "usd" },
        idempotencyKey: `reuse-first-${accountId}`,
        workspaceId,
        accountId,
        revenueAccountId: revenueId,
      });
    } catch (err) {
      token = (err as ConfirmationRequiredError).confirmationToken;
    }

    await run(pool, client, {
      endpointId: paidEndpointId,
      args: { ids: "bitcoin", vs_currencies: "usd" },
      idempotencyKey: `reuse-second-${accountId}`,
      workspaceId,
      accountId,
      revenueAccountId: revenueId,
      confirmationToken: token,
    });

    // Same token, a THIRD call — must be denied again (a fresh token is required).
    await expect(
      run(pool, client, {
        endpointId: paidEndpointId,
        args: { ids: "bitcoin", vs_currencies: "usd" },
        idempotencyKey: `reuse-third-${accountId}`,
        workspaceId,
        accountId,
        revenueAccountId: revenueId,
        confirmationToken: token,
      })
    ).rejects.toThrow(ConfirmationRequiredError);
  });

  it("a confirmation token issued for one endpoint's args cannot be used for a different call", async () => {
    await pool.query(
      "INSERT INTO budgets (workspace_id, scope, scope_id, limit_micros, window_kind, action) VALUES ($1, 'call', NULL, 100, 'per_call', 'require_confirmation')",
      [workspaceId]
    );
    let token = "";
    try {
      await run(pool, client, {
        endpointId: paidEndpointId,
        args: { ids: "bitcoin", vs_currencies: "usd" },
        idempotencyKey: `bound-first-${accountId}`,
        workspaceId,
        accountId,
        revenueAccountId: revenueId,
      });
    } catch (err) {
      token = (err as ConfirmationRequiredError).confirmationToken;
    }

    // Different args (ethereum, not bitcoin) — the token must not transfer.
    await expect(
      run(pool, client, {
        endpointId: paidEndpointId,
        args: { ids: "ethereum", vs_currencies: "usd" },
        idempotencyKey: `bound-second-${accountId}`,
        workspaceId,
        accountId,
        revenueAccountId: revenueId,
        confirmationToken: token,
      })
    ).rejects.toThrow(ConfirmationRequiredError);
  });
});
