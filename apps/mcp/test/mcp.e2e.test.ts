/**
 * A REAL MCP client speaking the actual protocol to a REAL running instance of this
 * server (which itself calls the REAL REST API, which itself uses the REAL local
 * Postgres). No layer here is mocked. This is the strongest verification available in
 * this environment for the Phase 4 acceptance criterion "Claude Code connects and
 * completes a real task end to end" — this test uses the identical client library and
 * wire protocol Claude Code itself uses to talk to any MCP server, exercising discover →
 * inspect → run exactly as an agent would, including hitting a real budget cap and
 * getting back plain language instead of a crash.
 *
 * Requires both apps/api and this server to be reachable — set SWITCHBOARD_API_URL /
 * MCP_URL, or rely on the defaults (127.0.0.1:3000 / 127.0.0.1:3001). Skips cleanly if
 * neither is running, matching every other integration test in this project.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import pg from "pg";

const API_URL = process.env.SWITCHBOARD_API_URL ?? "http://127.0.0.1:3000";
const MCP_URL = process.env.MCP_URL ?? "http://127.0.0.1:3001/mcp";
const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://localhost/switchboard";

const pool = new pg.Pool({ connectionString: DATABASE_URL });

async function isUp(url: string): Promise<boolean> {
  try {
    await fetch(url);
    return true;
  } catch {
    return false;
  }
}

const [apiUp, mcpUp, dbUp] = await Promise.all([
  isUp(`${API_URL}/healthz`),
  fetch(MCP_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
    .then(() => true)
    .catch(() => false),
  pool.query("SELECT 1").then(() => true).catch(() => false),
]);
const allUp = apiUp && mcpUp && dbUp;

let workspaceId: string;

afterAll(async () => {
  await pool.end();
});

describe.skipIf(!allUp)("MCP server — real protocol client against a real running server", () => {
  let client: Client;

  beforeAll(async () => {
    if (!allUp) return;

    // Real workspace, real deposit, via the real REST API — not a DB shortcut.
    const wsRes = await fetch(`${API_URL}/v1/workspaces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "mcp-e2e-test" }),
    }).then((r) => r.json());
    workspaceId = wsRes.workspace_id;
    await fetch(`${API_URL}/v1/wallet/deposit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_id: workspaceId, amount_micros: 5_000_000 }),
    });

    client = new Client({ name: "test-client", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
    await client.connect(transport);
  });

  afterAll(async () => {
    if (!allUp || !workspaceId) return;
    await client.close();
    const acctIds = (await pool.query("SELECT id FROM accounts WHERE workspace_id = $1", [workspaceId])).rows.map((r) => r.id);
    const txnIds = (await pool.query("SELECT DISTINCT transaction_id FROM ledger_entries WHERE account_id = ANY($1::uuid[])", [acctIds])).rows.map((r) => r.transaction_id);
    await pool.query("DELETE FROM runs WHERE workspace_id = $1", [workspaceId]);
    if (txnIds.length > 0) {
      await pool.query("DELETE FROM ledger_entries WHERE transaction_id = ANY($1::uuid[])", [txnIds]);
      await pool.query("DELETE FROM transactions WHERE id = ANY($1::uuid[])", [txnIds]);
    }
    await pool.query("DELETE FROM holds WHERE account_id = ANY($1::uuid[])", [acctIds]);
    await pool.query("DELETE FROM budgets WHERE workspace_id = $1", [workspaceId]);
    await pool.query("DELETE FROM accounts WHERE id = ANY($1::uuid[])", [acctIds]);
    await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
  });

  it("exposes EXACTLY three tools — the context-efficiency design goal from plan/06-api-spec.md", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["discover", "inspect", "run"]);
  });

  it(
    "an agent can discover a tool, see WHY it was chosen, inspect its exact price, and run it — " +
      "the real, live protocol round trip",
    async () => {
      const discoverResult = await client.callTool({
        name: "discover",
        arguments: { query: "convert currency amount from dollars to euros", limit: 3 },
      });
      const discoverText = (discoverResult.content as any)[0].text as string;
      expect(discoverText).toContain("Convert a currency amount"); // Frankfurter's real endpoint, correctly surfaced
      expect(discoverText).toMatch(/fit: \d\.\d\d/); // the score_breakdown is visible, not hidden

      const endpointIdMatch = discoverText.match(/endpoint_id: ([a-f0-9-]+)/);
      expect(endpointIdMatch).not.toBeNull();
      const endpointId = endpointIdMatch![1];

      const inspectResult = await client.callTool({
        name: "inspect",
        arguments: { endpoint_id: endpointId, args: { amount: 100, from: "USD", to: "EUR" } },
      });
      const inspectText = (inspectResult.content as any)[0].text as string;
      expect(inspectText).toContain("Cost:"); // real pricing, not a placeholder

      const runResult = await client.callTool({
        name: "run",
        arguments: { endpoint_id: endpointId, args: { amount: 100, from: "USD", to: "EUR" }, workspace_id: workspaceId },
      });
      const runText = (runResult.content as any)[0].text as string;
      // This is a REAL call to the live Frankfurter API through the whole stack —
      // discover -> inspect -> run -> executor -> real HTTP -> real ledger.
      expect(runText).toContain("Success");
      expect(runText).toMatch(/"EUR":\s*[\d.]+/); // a real, current exchange rate came back
    }
  );

  it(
    "the agent hits a budget cap and gets PLAIN LANGUAGE back, not a crash — " +
      "the exact Phase 4 acceptance criterion from plan/07-roadmap.md",
    async () => {
      await fetch(`${API_URL}/v1/budgets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: workspaceId, scope: "workspace", limit_micros: 10, window: "total", action: "block" }),
      });

      const coinResult = await fetch(`${API_URL}/v1/discover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "bitcoin price", limit: 1 }),
      }).then((r) => r.json());
      const paidEndpointId = coinResult.candidates[0].endpoint_id;

      // Calling the MCP tool must NOT throw an MCP protocol error — it must return a
      // normal, successful tool result whose TEXT explains the guardrail in plain
      // language. That distinction is the entire point of this test.
      const result = await client.callTool({
        name: "run",
        arguments: { endpoint_id: paidEndpointId, args: { ids: "bitcoin", vs_currencies: "usd" }, workspace_id: workspaceId },
      });
      expect(result.isError).toBeFalsy(); // NOT surfaced as a protocol-level error
      const resultText = (result.content as any)[0].text as string;
      expect(resultText).toMatch(/spending guardrail/i);
      expect(resultText).toMatch(/workspace budget/i);
      expect(resultText).toMatch(/nothing was charged/i);

      await fetch(`${API_URL}/v1/budgets`, { method: "GET" }); // (no-op, just exercising the endpoint exists)
      await pool.query("DELETE FROM budgets WHERE workspace_id = $1", [workspaceId]);
    }
  );

  it("dry_run through the MCP tool prices the call without spending anything", async () => {
    const balanceBefore = await fetch(`${API_URL}/v1/wallet/balance?workspace_id=${workspaceId}`).then((r) => r.json());
    const discoverResult = await client.callTool({ name: "discover", arguments: { query: "trivia questions", limit: 1 } });
    const endpointId = (discoverResult.content as any)[0].text.match(/endpoint_id: ([a-f0-9-]+)/)[1];

    const result = await client.callTool({
      name: "run",
      arguments: { endpoint_id: endpointId, args: { amount: 5 }, workspace_id: workspaceId, dry_run: true },
    });
    const resultText = (result.content as any)[0].text as string;
    expect(resultText).toMatch(/dry run/i);
    expect(resultText).toMatch(/nothing was charged/i);

    const balanceAfter = await fetch(`${API_URL}/v1/wallet/balance?workspace_id=${workspaceId}`).then((r) => r.json());
    expect(balanceAfter.available_micros).toBe(balanceBefore.available_micros);
  });

  it("reads the budget_status resource without spending a tool slot", async () => {
    // budget_status is a ResourceTemplate with no `list` callback — deliberately, since
    // there's no way to enumerate every workspace id that might exist — so it correctly
    // does NOT appear in listResources() (a bug I initially assumed when the test first
    // failed here; it turned out to be a wrong assertion, not a server bug). Templates
    // are discoverable via listResourceTemplates() instead.
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.some((r) => r.name === "budget_status")).toBe(true);

    const result = await client.readResource({ uri: `switchboard://budget-status/${workspaceId}` });
    const parsed = JSON.parse((result.contents[0] as any).text);
    expect(parsed.balance).toHaveProperty("available_micros");
    expect(Array.isArray(parsed.budgets)).toBe(true);
  });
});
