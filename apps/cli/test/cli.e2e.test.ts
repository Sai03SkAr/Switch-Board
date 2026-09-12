/**
 * Spawns the REAL `sw` CLI as a subprocess against a REAL running API server — not a
 * function-call-level test. Skips cleanly if the API isn't reachable.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import pg from "pg";

const execFileAsync = promisify(execFile);
const CLI_PATH = path.resolve(import.meta.dirname, "../src/index.ts");
const API_URL = process.env.SWITCHBOARD_API_URL ?? "http://127.0.0.1:3000";
const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://localhost/switchboard";

const pool = new pg.Pool({ connectionString: DATABASE_URL });
const apiUp = await fetch(`${API_URL}/healthz`).then(() => true).catch(() => false);

async function sw(...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync("npx", ["tsx", CLI_PATH, ...args]);
    return { stdout, stderr, code: 0 };
  } catch (err: any) {
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", code: err.code ?? 1 };
  }
}

let workspaceId: string;

afterAll(async () => {
  await pool.end();
});

describe.skipIf(!apiUp)("CLI — real subprocess against a real running API", () => {
  beforeAll(async () => {
    const { stdout } = await sw("workspace-create", "cli-e2e-test");
    workspaceId = JSON.parse(stdout).workspace_id;
    await sw("wallet", "deposit", "--workspace", workspaceId, "--amount", "1.00");
  });

  afterAll(async () => {
    if (!workspaceId) return;
    const acctIds = (await pool.query("SELECT id FROM accounts WHERE workspace_id = $1", [workspaceId])).rows.map((r) => r.id);
    const txnIds = (await pool.query("SELECT DISTINCT transaction_id FROM ledger_entries WHERE account_id = ANY($1::uuid[])", [acctIds])).rows.map((r) => r.transaction_id);
    if (txnIds.length > 0) {
      await pool.query("DELETE FROM ledger_entries WHERE transaction_id = ANY($1::uuid[])", [txnIds]);
      await pool.query("DELETE FROM transactions WHERE id = ANY($1::uuid[])", [txnIds]);
    }
    await pool.query("DELETE FROM runs WHERE workspace_id = $1", [workspaceId]);
    await pool.query("DELETE FROM budgets WHERE workspace_id = $1", [workspaceId]);
    await pool.query("DELETE FROM holds WHERE account_id = ANY($1::uuid[])", [acctIds]);
    await pool.query("DELETE FROM accounts WHERE id = ANY($1::uuid[])", [acctIds]);
    await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
  });

  it("wallet balance reflects a real deposit", async () => {
    const { stdout } = await sw("wallet", "balance", "--workspace", workspaceId);
    expect(stdout.trim()).toBe("$1.000000");
  });

  it(
    "budget delete actually works — regression test for a real bug: sending " +
      "Content-Type: application/json on a bodyless DELETE made Fastify reject it " +
      "with FST_ERR_CTP_EMPTY_JSON_BODY before the route handler ever ran",
    async () => {
      await sw("budget", "set", "--workspace", workspaceId, "--scope", "call", "--limit", "0.02", "--window", "per_call");
      const { stdout: listed } = await sw("budget", "list", "--workspace", workspaceId);
      const budgetId = listed.trim().split(/\s+/)[0];
      expect(budgetId).toMatch(/^[0-9a-f-]{36}$/);

      const del = await sw("budget", "delete", budgetId);
      expect(del.code).toBe(0);
      expect(del.stdout).toContain("Deleted");

      const { stdout: after } = await sw("budget", "list", "--workspace", workspaceId);
      expect(after.trim()).toBe("");
    }
  );

  it("discover finds a real endpoint via the CLI", async () => {
    const { stdout } = await sw("discover", "weather alerts for a state", "--limit", "1");
    expect(stdout).toContain("nws");
    expect(stdout).toMatch(/endpoint_id: [0-9a-f-]{36}/);
  });

  it("run --dry-run prices without charging, via the CLI end to end", async () => {
    const { stdout: discoverOut } = await sw("discover", "trivia questions", "--limit", "1");
    const endpointId = discoverOut.match(/endpoint_id: ([0-9a-f-]+)/)![1];

    const { stdout: before } = await sw("wallet", "balance", "--workspace", workspaceId);
    const { stdout, code } = await sw("run", endpointId, "--workspace", workspaceId, "--args", '{"amount":5}', "--dry-run");
    expect(code).toBe(0);
    expect(stdout).toContain("Dry run");
    const { stdout: after } = await sw("wallet", "balance", "--workspace", workspaceId);
    expect(after).toBe(before);
  });

  it("a budget-exceeded run exits non-zero with a plain-language message, not a stack trace", async () => {
    await sw("budget", "set", "--workspace", workspaceId, "--scope", "workspace", "--limit", "0.00001", "--window", "total");
    const { stdout: discoverOut } = await sw("discover", "bitcoin price", "--limit", "1");
    const endpointId = discoverOut.match(/endpoint_id: ([0-9a-f-]+)/)![1];

    const result = await sw("run", endpointId, "--workspace", workspaceId, "--args", '{"ids":"bitcoin","vs_currencies":"usd"}');
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/budget exceeded/i);
    expect(result.stderr).toMatch(/nothing was charged/i);
    expect(result.stderr).not.toMatch(/at Object|at Module|node_modules/); // no raw stack trace leaked to the user
  });
});
