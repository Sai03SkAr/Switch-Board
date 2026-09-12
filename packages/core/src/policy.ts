/**
 * The policy engine — plan/03-positioning.md's headline differentiator: a workspace →
 * key → session → call budget hierarchy, versus Monid's single undifferentiated balance
 * (plan/02-weaknesses.md #2). Runs before any hold is taken.
 */
import type pg from "pg";

export type BudgetScope = "workspace" | "key" | "session" | "call";
export type BudgetWindow = "total" | "daily" | "monthly" | "per_call";
export type BudgetAction = "block" | "require_confirmation";

export interface Budget {
  id: string;
  workspaceId: string;
  scope: BudgetScope;
  scopeId: string | null;
  limitMicros: number;
  window: BudgetWindow;
  action: BudgetAction;
}

export type PolicyDecision =
  | { decision: "ALLOW" }
  | { decision: "DENY"; scope: BudgetScope; window: BudgetWindow; limitMicros: number; spentMicros: number; wouldCostMicros: number }
  | { decision: "NEEDS_CONFIRMATION"; confirmationToken: string; limitMicros: number; expiresInSeconds: number };

export interface PolicyContext {
  workspaceId: string;
  keyId?: string | null;
  sessionId?: string | null;
  endpointId: string;
  argsHash: string;
  estimatedMicros: number;
}

const CONFIRMATION_TOKEN_TTL_SECONDS = 300;

function windowStart(window: BudgetWindow): Date | null {
  const now = new Date();
  if (window === "daily") return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (window === "monthly") return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return null; // 'total' and 'per_call' have no window start — total is all-time, per_call needs no history
}

async function getSpentMicros(pool: pg.Pool, budget: Budget): Promise<number> {
  const conditions = ["workspace_id = $1", "state = 'succeeded'"];
  const params: unknown[] = [budget.workspaceId];

  if (budget.scope === "key") {
    conditions.push(`key_id = $${params.length + 1}`);
    params.push(budget.scopeId);
  } else if (budget.scope === "session") {
    conditions.push(`session_id = $${params.length + 1}`);
    params.push(budget.scopeId);
  }

  const start = windowStart(budget.window);
  if (start) {
    conditions.push(`created_at >= $${params.length + 1}`);
    params.push(start);
  }

  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(actual_micros), 0) AS spent FROM runs WHERE ${conditions.join(" AND ")}`,
    params
  );
  return Number(rows[0].spent);
}

async function fetchBudgets(pool: pg.Pool, ctx: PolicyContext, scope: BudgetScope): Promise<Budget[]> {
  const scopeId = scope === "key" ? ctx.keyId : scope === "session" ? ctx.sessionId : null;
  if ((scope === "key" || scope === "session") && !scopeId) return []; // no key/session provided, nothing to check

  const conditions = ["workspace_id = $1", "scope = $2"];
  const params: unknown[] = [ctx.workspaceId, scope];
  if (scopeId) {
    conditions.push(`scope_id = $${params.length + 1}`);
    params.push(scopeId);
  } else {
    conditions.push("scope_id IS NULL");
  }

  const { rows } = await pool.query(
    `SELECT id, workspace_id, scope, scope_id, limit_micros, window_kind, action FROM budgets WHERE ${conditions.join(" AND ")}`,
    params
  );
  return rows.map((r) => ({
    id: r.id,
    workspaceId: r.workspace_id,
    scope: r.scope,
    scopeId: r.scope_id,
    limitMicros: Number(r.limit_micros),
    window: r.window_kind,
    action: r.action,
  }));
}

/**
 * Issues a confirmation token bound to this EXACT call (endpoint + args) — it cannot be
 * reused for a different call, even a cheaper one on the same endpoint.
 */
async function issueConfirmationToken(pool: pg.Pool, ctx: PolicyContext): Promise<string> {
  const { rows } = await pool.query<{ token: string }>(
    `INSERT INTO confirmation_tokens (workspace_id, endpoint_id, args_hash, estimated_micros, expires_at)
     VALUES ($1, $2, $3, $4, now() + ($5 || ' seconds')::interval)
     RETURNING token`,
    [ctx.workspaceId, ctx.endpointId, ctx.argsHash, ctx.estimatedMicros, CONFIRMATION_TOKEN_TTL_SECONDS]
  );
  return rows[0].token;
}

/**
 * Validates and consumes a confirmation token in one atomic step (locks the row so a
 * token can't be raced into double use). Returns true only if the token is unexpired,
 * unused, and bound to this exact workspace/endpoint/args.
 */
export async function consumeConfirmationToken(
  pool: pg.Pool,
  params: { token: string; workspaceId: string; endpointId: string; argsHash: string }
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT workspace_id, endpoint_id, args_hash, expires_at, used_at FROM confirmation_tokens WHERE token = $1 FOR UPDATE`,
      [params.token]
    );
    if (rows.length === 0) {
      await client.query("ROLLBACK");
      return false;
    }
    const row = rows[0];
    const valid =
      row.workspace_id === params.workspaceId &&
      row.endpoint_id === params.endpointId &&
      row.args_hash === params.argsHash &&
      row.used_at === null &&
      new Date(row.expires_at).getTime() > Date.now();

    if (!valid) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query("UPDATE confirmation_tokens SET used_at = now() WHERE token = $1", [params.token]);
    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Evaluate policy for a call BEFORE any hold is taken. Checks 'call' scope (the
 * per-call confirmation threshold) first, then 'session', 'key', 'workspace' in that
 * order — narrowest, most specific scope first, matching plan/04-architecture.md.
 */
export async function evaluatePolicy(pool: pg.Pool, ctx: PolicyContext, confirmationToken?: string): Promise<PolicyDecision> {
  for (const scope of ["call", "session", "key", "workspace"] as const) {
    const budgets = await fetchBudgets(pool, ctx, scope);
    for (const budget of budgets) {
      const spent = budget.window === "per_call" ? 0 : await getSpentMicros(pool, budget);
      const projected = spent + ctx.estimatedMicros;
      if (projected <= budget.limitMicros) continue;

      if (budget.action === "require_confirmation") {
        if (confirmationToken) {
          const valid = await consumeConfirmationToken(pool, {
            token: confirmationToken,
            workspaceId: ctx.workspaceId,
            endpointId: ctx.endpointId,
            argsHash: ctx.argsHash,
          });
          if (valid) continue; // this budget's requirement is satisfied — check the rest
        }
        const token = await issueConfirmationToken(pool, ctx);
        return { decision: "NEEDS_CONFIRMATION", confirmationToken: token, limitMicros: budget.limitMicros, expiresInSeconds: CONFIRMATION_TOKEN_TTL_SECONDS };
      }

      return { decision: "DENY", scope, window: budget.window, limitMicros: budget.limitMicros, spentMicros: spent, wouldCostMicros: ctx.estimatedMicros };
    }
  }
  return { decision: "ALLOW" };
}
