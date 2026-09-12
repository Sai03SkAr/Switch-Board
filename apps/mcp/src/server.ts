/**
 * The MCP server — three tools only (discover, inspect, run), per plan/06-api-spec.md's
 * explicit design goal: three tool slots cost almost nothing in an agent's context
 * window, however large the underlying catalogue is. This is a THIN ADAPTER over the
 * REST API built in Phases 1–3 — it calls the same HTTP endpoints a human `curl` would,
 * it does not reimplement any business logic. "MCP is a thin adapter over REST — never a
 * second implementation" (plan/06-api-spec.md).
 *
 * Phase 4 acceptance criterion this file exists to satisfy: "the agent hits a budget cap
 * and reports it in plain language rather than crashing." A 402/409 from the REST layer
 * is NOT surfaced as an MCP protocol error here — it's returned as a normal tool result
 * with human-readable text, so the agent can read it, explain it to the user, and retry
 * intelligently instead of the whole interaction failing opaquely.
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const API_BASE_URL = process.env.SWITCHBOARD_API_URL ?? "http://127.0.0.1:3000";

async function apiRequest(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function text(content: string) {
  return { content: [{ type: "text" as const, text: content }] };
}

const server = new McpServer({ name: "switchboard", version: "0.1.0" });

server.registerTool(
  "discover",
  {
    title: "Discover tools",
    description:
      "Search SwitchBoard's catalogue for a tool that can perform a task, using natural language. " +
      "Returns ranked candidates with estimated cost, health, and WHY each one was chosen (score_breakdown) — " +
      "the cheapest candidate that fits is always marked cheapest_viable.",
    inputSchema: {
      query: z.string().describe("Natural-language description of what you need to do"),
      limit: z.number().int().min(1).max(20).optional().describe("Max candidates to return (default 5)"),
    },
  },
  async ({ query, limit }) => {
    const { status, json } = await apiRequest("POST", "/v1/discover", { query, limit });
    if (status !== 200) return text(`Discovery failed: ${json.error?.message ?? "unknown error"}`);
    if (json.candidates.length === 0) return text(`No matching tools found for "${query}".`);

    const lines = json.candidates.map(
      (c: any, i: number) =>
        `${i + 1}. ${c.name} (${c.provider}) — endpoint_id: ${c.endpoint_id}\n` +
        `   cost: ${c.estimated_cost_display}${c.cheapest_viable ? " (cheapest viable)" : ""}, ` +
        `fit: ${c.score_breakdown.fit.toFixed(2)}, reliability: ${(c.score_breakdown.reliability * 100).toFixed(0)}%\n` +
        `   ${c.description}`
    );
    return text(`Found ${json.candidates.length} candidate(s) for "${query}":\n\n${lines.join("\n\n")}`);
  }
);

server.registerTool(
  "inspect",
  {
    title: "Inspect a tool",
    description:
      "Get the full input schema, exact pricing, and health for one specific endpoint before calling it. " +
      "Always shows the real cost for the arguments you supply, never just a list price.",
    inputSchema: {
      endpoint_id: z.string().describe("The endpoint_id from a discover result"),
      args: z.record(z.unknown()).optional().describe("The arguments you intend to call it with, to get an exact cost"),
    },
  },
  async ({ endpoint_id, args }) => {
    const { status, json } = await apiRequest("POST", "/v1/inspect", { endpoint_id, args });
    if (status === 404) return text(`No such endpoint: ${endpoint_id}`);
    if (status !== 200) return text(`Inspect failed: ${json.error?.message ?? "unknown error"}`);

    return text(
      `${json.name}\n${json.description}\n\n` +
        `Cost: ${json.pricing.estimated_cost_display}${json.pricing.is_exact ? " (exact)" : " (estimate)"} — ${json.pricing.explain}\n` +
        `Health: ${(json.health.success_rate_7d * 100).toFixed(1)}% success rate, ${json.health.p95_latency_ms}ms p95\n` +
        `Input schema: ${JSON.stringify(json.input_schema)}`
    );
  }
);

server.registerTool(
  "run",
  {
    title: "Run a tool",
    description:
      "Execute a tool call. Pay-per-call, and failures cost nothing — this is enforced by the ledger, not just promised. " +
      "If this returns a budget or confirmation message instead of a result, read it: it means a spending guardrail " +
      "stopped the call on purpose, and it will tell you exactly what to do next (e.g. retry with a confirmation_token).",
    inputSchema: {
      endpoint_id: z.string().describe("The endpoint_id from a discover result"),
      args: z.record(z.unknown()).describe("Arguments matching the endpoint's input schema"),
      workspace_id: z.string().describe("Your workspace id"),
      session_id: z.string().optional().describe("Groups related calls under one session budget, if one is configured"),
      dry_run: z.boolean().optional().describe("Price the call without executing it or spending anything"),
      confirmation_token: z.string().optional().describe("Supply this to proceed after a CONFIRMATION_REQUIRED response"),
    },
  },
  async ({ endpoint_id, args, workspace_id, session_id, dry_run, confirmation_token }) => {
    const { status, json } = await apiRequest(
      "POST",
      "/v1/run",
      { endpoint_id, args, workspace_id, session_id, dry_run, confirmation_token },
      dry_run ? {} : { "Idempotency-Key": randomUUID() }
    );

    // The acceptance criterion this branch exists for: a budget cap or confirmation
    // requirement is reported in plain language, not thrown as a crash. The agent reads
    // this exactly like it reads a tool's normal output.
    if (status === 402 && json.error?.code === "BUDGET_EXCEEDED") {
      const d = json.error.details;
      return text(
        `Stopped by a spending guardrail: the ${d.scope} budget (${d.window} window) allows ` +
          `$${(d.limit_micros / 1_000_000).toFixed(6)} total. Already spent $${(d.spent_micros / 1_000_000).toFixed(6)}, ` +
          `and this call would cost $${(d.would_cost_micros / 1_000_000).toFixed(6)} more — over the limit. ` +
          `Nothing was charged. This is working as intended, not an error to retry past.`
      );
    }
    if (status === 402 && json.error?.code === "INSUFFICIENT_FUNDS") {
      return text(`Insufficient balance: ${json.error.message}. Nothing was charged.`);
    }
    if (status === 409 && json.error?.code === "CONFIRMATION_REQUIRED") {
      const d = json.error.details;
      return text(
        `This call costs $${(d.estimated_cost_micros / 1_000_000).toFixed(6)}, above a confirmation threshold. ` +
          `Nothing was charged yet. If you want to proceed, call \`run\` again with the same endpoint_id and args, ` +
          `plus confirmation_token: "${d.confirmation_token}" (valid for ${d.expires_in_s} seconds).`
      );
    }
    if (status === 400) {
      return text(`Invalid request: ${json.error?.message ?? "unknown validation error"}`);
    }
    if (status === 404) {
      return text(`Not found: ${json.error?.message ?? "no such endpoint or workspace"}`);
    }

    if (json.state === "dry_run") {
      return text(`Dry run — would cost ${json.receipt.charged_display === "$0.000000" ? "$" + (json.receipt.estimated_micros / 1_000_000).toFixed(6) : json.receipt.charged_display}. Nothing was charged.`);
    }
    if (json.state === "failed") {
      return text(`Call failed (${json.error?.code}): ${json.error?.message}. Charged $0.00 — failures never cost money.`);
    }
    return text(`Success. Charged ${json.receipt?.charged_display ?? "$0.00"}.\n\nResult: ${JSON.stringify(json.result, null, 2)}`);
  }
);

// Resource, not a tool — checking the balance should never cost one of the three tool
// slots (plan/07-roadmap.md Phase 4's explicit design note).
//
// Bug caught by the e2e test, not by inspection: passing a plain string containing
// "{workspace_id}" to registerResource() registers that EXACT STRING as a literal,
// non-templated URI — the curly-brace placeholder is not interpreted as a variable
// unless you construct a real ResourceTemplate. Every lookup for an actual workspace id
// failed with "resource not found" because the server only knew about the literal,
// unsubstituted template string. Fixed by using ResourceTemplate, whose read callback
// receives the extracted variables directly — no manual URL parsing needed either.
server.registerResource(
  "budget_status",
  new ResourceTemplate("switchboard://budget-status/{workspace_id}", { list: undefined }),
  { title: "Budget status", description: "Current balance and configured budgets for a workspace" },
  async (uri: URL, variables) => {
    const workspaceId = variables.workspace_id as string;
    const [balance, budgets] = await Promise.all([
      apiRequest("GET", `/v1/wallet/balance?workspace_id=${workspaceId}`),
      apiRequest("GET", `/v1/budgets?workspace_id=${workspaceId}`),
    ]);
    return {
      contents: [
        {
          uri: uri.toString(),
          mimeType: "application/json",
          text: JSON.stringify({ balance: balance.json, budgets: budgets.json.budgets }, null, 2),
        },
      ],
    };
  }
);

const httpServer = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/mcp") {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => transport.close());
    await server.connect(transport);
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      let parsed: unknown;
      try {
        parsed = body ? JSON.parse(body) : undefined;
      } catch {
        res.writeHead(400).end("Invalid JSON");
        return;
      }
      await transport.handleRequest(req, res, parsed);
    });
    return;
  }
  res.writeHead(404).end("Not found");
});

const port = Number(process.env.MCP_PORT ?? 3001);
httpServer.listen(port, "127.0.0.1", () => {
  console.log(`SwitchBoard MCP server listening on http://127.0.0.1:${port}/mcp (proxying ${API_BASE_URL})`);
});
