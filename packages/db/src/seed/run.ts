import { LocalHashEmbedding } from "@switchboard/core";
import { getPool, closePool } from "../client.js";
import { SEED_PROVIDERS } from "./providers.js";
import { SEED_ENDPOINTS } from "./endpoints.js";

function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

async function main() {
  const pool = getPool();
  const embedder = new LocalHashEmbedding();

  const providerIdBySlug = new Map<string, string>();

  for (const p of SEED_PROVIDERS) {
    const res = await pool.query(
      `INSERT INTO providers (slug, name, base_url, auth_type, resale_allowed, resale_note, tos_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (slug) DO UPDATE SET
         name = EXCLUDED.name, base_url = EXCLUDED.base_url, auth_type = EXCLUDED.auth_type,
         resale_allowed = EXCLUDED.resale_allowed, resale_note = EXCLUDED.resale_note,
         tos_url = EXCLUDED.tos_url
       RETURNING id`,
      [p.slug, p.name, p.base_url, p.auth_type, p.resale_allowed, p.resale_note, p.tos_url]
    );
    providerIdBySlug.set(p.slug, res.rows[0].id);
    console.log(`provider  ${p.slug}`);
  }

  for (const e of SEED_ENDPOINTS) {
    const providerId = providerIdBySlug.get(e.provider_slug);
    if (!providerId) throw new Error(`Unknown provider_slug: ${e.provider_slug}`);

    const embeddingText = [e.name, e.description, ...e.categories, ...e.example_queries].join(" ");
    const embedding = await embedder.embed(embeddingText);

    await pool.query(
      `INSERT INTO endpoints
         (provider_id, slug, name, description, categories, example_queries,
          input_schema, pricing, upstream_path, upstream_method, embedding)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (provider_id, slug) DO UPDATE SET
         name = EXCLUDED.name, description = EXCLUDED.description, categories = EXCLUDED.categories,
         example_queries = EXCLUDED.example_queries, input_schema = EXCLUDED.input_schema,
         pricing = EXCLUDED.pricing, upstream_path = EXCLUDED.upstream_path,
         upstream_method = EXCLUDED.upstream_method, embedding = EXCLUDED.embedding`,
      [
        providerId,
        e.slug,
        e.name,
        e.description,
        e.categories,
        e.example_queries,
        JSON.stringify(e.input_schema),
        JSON.stringify(e.pricing),
        e.upstream_path,
        e.upstream_method,
        toVectorLiteral(embedding),
      ]
    );
    console.log(`endpoint  ${e.provider_slug}/${e.slug}`);
  }

  const counts = await pool.query(
    "SELECT (SELECT count(*) FROM providers) AS providers, (SELECT count(*) FROM endpoints) AS endpoints"
  );
  console.log(`\nSeeded ${counts.rows[0].providers} providers, ${counts.rows[0].endpoints} endpoints.`);
  await closePool();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
