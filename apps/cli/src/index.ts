#!/usr/bin/env node
/**
 * The CLI — a thin adapter over the same REST API the MCP server calls, per
 * plan/06-api-spec.md. Every command here maps 1:1 to an HTTP call built in Phases 1–3;
 * nothing here reimplements business logic.
 */
import { Command } from "commander";
import { randomUUID } from "node:crypto";

const API_URL = process.env.SWITCHBOARD_API_URL ?? "http://127.0.0.1:3000";

async function api(method: "GET" | "POST" | "DELETE", path: string, body?: unknown, headers?: Record<string, string>) {
  // Bug caught live, not by inspection: sending Content-Type: application/json
  // unconditionally — even with no body, as every DELETE call here does — makes Fastify
  // reject the request outright (FST_ERR_CTP_EMPTY_JSON_BODY, 400) before it ever
  // reaches the route handler. GET commands never showed this because Fastify doesn't
  // body-parse GET requests at all, so the header was silently ignored there; DELETE
  // has no such exemption. Fixed: only set the header when there's an actual body.
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json", ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

function dollarsToMicros(dollars: string | number): number {
  return Math.round(Number(dollars) * 1_000_000);
}
function microsToDollars(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(6)}`;
}
function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}
function printJson(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}

const program = new Command();
program.name("sw").description("SwitchBoard CLI").version("0.1.0");

program
  .command("discover <query>")
  .description("Search the catalogue for a tool that can perform a task")
  .option("--limit <n>", "max candidates to return", "5")
  .action(async (query, opts) => {
    const { status, json } = await api("POST", "/v1/discover", { query, limit: Number(opts.limit) });
    if (status !== 200) fail(json?.error?.message ?? "discover failed");
    for (const c of json.candidates) {
      console.log(`${c.cheapest_viable ? "★" : " "} ${c.name}  (${c.provider})`);
      console.log(`  endpoint_id: ${c.endpoint_id}`);
      console.log(`  cost: ${c.estimated_cost_display}  fit: ${c.score_breakdown.fit.toFixed(2)}  score: ${c.score.toFixed(3)}`);
      console.log(`  ${c.description}\n`);
    }
  });

program
  .command("inspect <endpoint_id>")
  .description("Get the exact schema, price, and health for one endpoint")
  .option("--args <json>", "arguments to price exactly, as a JSON string")
  .action(async (endpointId, opts) => {
    const args = opts.args ? JSON.parse(opts.args) : undefined;
    const { status, json } = await api("POST", "/v1/inspect", { endpoint_id: endpointId, args });
    if (status !== 200) fail(json?.error?.message ?? "inspect failed");
    printJson(json);
  });

program
  .command("run <endpoint_id>")
  .description("Execute a tool call")
  .requiredOption("--workspace <id>", "workspace id")
  .option("--args <json>", "arguments, as a JSON string", "{}")
  .option("--session <id>", "session id, for session-scoped budgets")
  .option("--confirm <token>", "confirmation token from a previous CONFIRMATION_REQUIRED response")
  .option("--dry-run", "price the call without executing it")
  .action(async (endpointId, opts) => {
    const args = JSON.parse(opts.args);
    const { status, json } = await api(
      "POST",
      "/v1/run",
      { endpoint_id: endpointId, args, workspace_id: opts.workspace, session_id: opts.session, confirmation_token: opts.confirm, dry_run: !!opts.dryRun },
      opts.dryRun ? {} : { "Idempotency-Key": randomUUID() }
    );

    if (status === 402 && json?.error?.code === "BUDGET_EXCEEDED") {
      const d = json.error.details;
      fail(
        `${d.scope} budget exceeded (${d.window}): already spent ${microsToDollars(d.spent_micros)}, ` +
          `this call would cost ${microsToDollars(d.would_cost_micros)} more, over the ${microsToDollars(d.limit_micros)} limit. Nothing was charged.`
      );
    }
    if (status === 409 && json?.error?.code === "CONFIRMATION_REQUIRED") {
      const d = json.error.details;
      fail(
        `This call costs ${microsToDollars(d.estimated_cost_micros)}, above your confirmation threshold. Nothing was charged.\n` +
          `Retry with: --confirm ${d.confirmation_token}  (valid ${d.expires_in_s}s)`
      );
    }
    if (status !== 200) fail(json?.error?.message ?? "run failed");

    if (json.state === "dry_run") {
      console.log(`Dry run — nothing charged. Estimated: ${microsToDollars(json.receipt.estimated_micros)}`);
      return;
    }
    if (json.state === "failed") {
      fail(`${json.error?.code}: ${json.error?.message} — charged ${json.receipt?.charged_display ?? "$0.00"}`);
    }
    console.log(`Succeeded — charged ${json.receipt.charged_display}`);
    printJson(json.result);
  });

const runs = program.command("runs").description("Inspect past runs");
runs
  .command("list")
  .requiredOption("--workspace <id>", "workspace id")
  .action(async (opts) => {
    const { status, json } = await api("GET", `/v1/runs?workspace_id=${opts.workspace}`);
    if (status !== 200) fail(json?.error?.message ?? "runs list failed");
    for (const r of json.runs) {
      console.log(`${r.id}  ${r.state.padEnd(10)}  ${microsToDollars(r.actual_micros ?? r.estimated_micros)}  ${r.created_at}`);
    }
  });
runs.command("get <run_id>").action(async (runId) => {
  const { status, json } = await api("GET", `/v1/runs/${runId}`);
  if (status !== 200) fail(json?.error?.message ?? "no such run");
  printJson(json);
});

const budget = program.command("budget").description("Manage spend guardrails");
budget
  .command("set")
  .requiredOption("--workspace <id>", "workspace id")
  .requiredOption("--scope <scope>", "workspace | key | session | call")
  .option("--id <scope_id>", "scope id — required for key/session scopes")
  .requiredOption("--limit <dollars>", "limit, in dollars (e.g. 0.05)")
  .option("--window <window>", "total | daily | monthly | per_call", "total")
  .option("--action <action>", "block | require_confirmation", "block")
  .action(async (opts) => {
    const { status, json } = await api("POST", "/v1/budgets", {
      workspace_id: opts.workspace,
      scope: opts.scope,
      scope_id: opts.id,
      limit_micros: dollarsToMicros(opts.limit),
      window: opts.window,
      action: opts.action,
    });
    if (status !== 201) fail(json?.error?.message ?? "budget set failed");
    console.log(`Budget set: ${opts.scope} ${opts.window} limit ${microsToDollars(json.limit_micros)} (${json.action})`);
  });
budget
  .command("list")
  .requiredOption("--workspace <id>", "workspace id")
  .action(async (opts) => {
    const { status, json } = await api("GET", `/v1/budgets?workspace_id=${opts.workspace}`);
    if (status !== 200) fail(json?.error?.message ?? "budget list failed");
    for (const b of json.budgets) {
      console.log(`${b.id}  ${b.scope.padEnd(10)} ${(b.scope_id ?? "-").padEnd(20)} ${microsToDollars(b.limit_micros).padEnd(14)} ${b.window.padEnd(10)} ${b.action}`);
    }
  });
budget.command("delete <id>").action(async (id) => {
  const { status } = await api("DELETE", `/v1/budgets/${id}`);
  if (status !== 204) fail("could not delete budget");
  console.log("Deleted.");
});

const wallet = program.command("wallet").description("Balance and spend history");
wallet
  .command("balance")
  .requiredOption("--workspace <id>", "workspace id")
  .action(async (opts) => {
    const { status, json } = await api("GET", `/v1/wallet/balance?workspace_id=${opts.workspace}`);
    if (status !== 200) fail(json?.error?.message ?? "balance check failed");
    console.log(microsToDollars(json.available_micros));
  });
wallet
  .command("deposit")
  .requiredOption("--workspace <id>", "workspace id")
  .requiredOption("--amount <dollars>", "amount in dollars")
  .action(async (opts) => {
    const { status, json } = await api("POST", "/v1/wallet/deposit", { workspace_id: opts.workspace, amount_micros: dollarsToMicros(opts.amount) });
    if (status !== 201) fail(json?.error?.message ?? "deposit failed");
    console.log(`New balance: ${microsToDollars(json.balance_micros)}`);
  });
wallet
  .command("export")
  .requiredOption("--workspace <id>", "workspace id")
  .option("--format <fmt>", "csv | json", "csv")
  .action(async (opts) => {
    const { status, json } = await api("GET", `/v1/wallet/activities?workspace_id=${opts.workspace}`);
    if (status !== 200) fail(json?.error?.message ?? "export failed");
    if (opts.format === "json") return printJson(json.activities);
    console.log("id,kind,created_at,amount_micros,amount_display");
    for (const a of json.activities) {
      console.log(`${a.id},${a.kind},${a.created_at},${a.amount_micros},${microsToDollars(a.amount_micros)}`);
    }
  });

program
  .command("workspace-create <name>")
  .description("Provision a new workspace and its balance account")
  .action(async (name) => {
    const { status, json } = await api("POST", "/v1/workspaces", { name });
    if (status !== 201) fail(json?.error?.message ?? "workspace creation failed");
    printJson(json);
  });

program.parseAsync(process.argv);
