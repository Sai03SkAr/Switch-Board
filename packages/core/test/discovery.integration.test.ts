/**
 * Integration test against a REAL local Postgres — no mocking the database, per
 * plan/08-requirements.md's own testing standard ("real Postgres in tests, never mocks").
 * Skips gracefully if DATABASE_URL / a local Postgres isn't reachable, so `npm test`
 * still runs clean in an environment with no database (e.g. a fresh clone before
 * `npm run db:migrate`) — but on this machine, right now, it actually connects and runs.
 */
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import pg from "pg";
import { discover, LocalHashEmbedding } from "../src/index.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://localhost/switchboard";

// Bug caught while writing this test, fixed here: describe.skipIf(condition) evaluates
// `condition` synchronously at collection time, BEFORE any beforeAll hook has a chance to
// run — so setting a `dbAvailable` flag inside beforeAll and reading it in skipIf always
// sees the flag's initial value. The fix is a top-level `await` (this is an ESM test file,
// vitest supports it) to determine reachability before the describe block is even declared.
const pool = new pg.Pool({ connectionString: DATABASE_URL });
const dbAvailable = await pool
  .query("SELECT 1")
  .then(() => true)
  .catch(() => false);

afterAll(async () => {
  await pool.end();
});

describe.skipIf(!dbAvailable)("discover() against a live Postgres", () => {
  const embedder = new LocalHashEmbedding();
  let poisonProviderId: string;
  let poisonEndpointId: string;

  beforeAll(async () => {
    if (!dbAvailable) return;

    // A deliberately "poisoned" PER_UNIT endpoint that requires an arg ("secret_field")
    // no caller of this test will ever supply — the exact failure mode of the bug this
    // test exists to catch. Cleaned up in afterAll regardless of pass/fail.
    const providerRes = await pool.query(
      `INSERT INTO providers (slug, name, base_url, auth_type, resale_allowed, resale_note, tos_url)
       VALUES ('test-poison-provider', 'Test Poison Provider', 'http://localhost', 'none', true, 'test fixture', 'http://localhost')
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`
    );
    poisonProviderId = providerRes.rows[0].id;

    const embedding = await embedder.embed("poison test endpoint currency conversion money");
    const endpointRes = await pool.query(
      `INSERT INTO endpoints
         (provider_id, slug, name, description, categories, example_queries, input_schema, pricing, upstream_path, upstream_method, embedding)
       VALUES ($1, 'poison-endpoint', 'Poison test endpoint', 'A per-unit endpoint requiring an arg this test never supplies, to prove one bad candidate cannot crash discover() for everyone else.',
               '{test}', '{currency conversion money test}',
               '{"type":"object"}',
               $2, '/test', 'GET', $3)
       ON CONFLICT (provider_id, slug) DO UPDATE SET pricing = EXCLUDED.pricing, embedding = EXCLUDED.embedding
       RETURNING id`,
      [
        poisonProviderId,
        JSON.stringify({
          model: "PER_UNIT",
          currency: "USD",
          base_micros: 0,
          unit: "character",
          unit_micros: 100,
          unit_divisor: 1,
          unit_count_field: "secret_field", // deliberately never supplied by discover() callers below
          unit_count_source: "length",
          max_input_units: 100,
          max_possible_micros: 10_000,
          estimator: "from_args",
        }),
        `[${embedding.join(",")}]`,
      ]
    );
    poisonEndpointId = endpointRes.rows[0].id;
  });

  afterAll(async () => {
    if (!dbAvailable) return;
    await pool.query("DELETE FROM endpoints WHERE id = $1", [poisonEndpointId]);
    await pool.query("DELETE FROM providers WHERE id = $1", [poisonProviderId]);
  });

  it(
    "does not throw when a retrieved candidate's pricing requires an arg that wasn't supplied — the fixed crash bug",
    async () => {
      // "currency conversion" is chosen to semantically/lexically match BOTH the poison
      // endpoint (via its description/example_queries) AND real seeded endpoints like
      // Frankfurter's convert-amount, so the poison candidate is actually retrieved into
      // the pool alongside healthy ones — this only proves the fix if the poison endpoint
      // genuinely surfaces as a candidate, not if it happens to be filtered out upstream.
      //
      // `args` here deliberately targets a DIFFERENT candidate (Frankfurter's convert-
      // amount shape: amount/from/to) and does NOT include the poison endpoint's
      // required "secret_field" — this is the actual bug scenario: a caller's args are
      // shaped for the candidate they meant, and estimateCost only throws for PER_UNIT
      // when args is truthy but missing the field (it doesn't throw when args is
      // omitted entirely) — so args must be non-empty here or this test wouldn't be
      // exercising the crash path at all.
      const results = await discover(pool, embedder, {
        query: "currency conversion money test",
        limit: 10,
        args: { amount: 100, from: "USD", to: "EUR" },
      });
      expect(results.length).toBeGreaterThan(0);
      // The poisoned endpoint itself must be silently excluded (its estimateCost throws),
      // while everything else still comes back — that's the whole point of the fix.
      expect(results.some((r) => r.endpointId === poisonEndpointId)).toBe(false);
    }
  );

  it("still returns the normal, healthy candidates when no poison endpoint is anywhere near the query", async () => {
    const results = await discover(pool, embedder, { query: "weather alerts for a state", limit: 5 });
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.providerSlug === "nws")).toBe(true);
  });
});
