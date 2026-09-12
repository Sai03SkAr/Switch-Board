/**
 * The upstream HTTP boundary — deliberately an interface, not a concrete implementation
 * wired directly into the executor. See PROGRESS.md's Phase 2 design decisions: no real
 * provider credentials exist in this environment (Twilio/SendGrid/CoinGecko all need paid
 * keys nobody has entered), so automated tests run against a mock implementation of this
 * interface, never real paid APIs — that's also just correct practice regardless of
 * credentials: you don't want a test suite that can rack up real charges or fail because
 * a third party is down. `FetchUpstreamClient` is real and works today against the free,
 * no-auth providers (NWS, Frankfurter, OpenTDB, Census) for manual smoke testing.
 */

export interface UpstreamRequest {
  method: "GET" | "POST";
  url: string;
  body?: Record<string, unknown>;
  timeoutMs: number;
}

export interface UpstreamResponse {
  status: number;
  body: unknown;
  latencyMs: number;
}

export class UpstreamTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Upstream call did not respond within ${timeoutMs}ms`);
    this.name = "UpstreamTimeoutError";
  }
}

export interface UpstreamClient {
  execute(req: UpstreamRequest): Promise<UpstreamResponse>;
}

/** Substitutes {field} placeholders in a path/query template from an args object. Values
 * are URI-encoded — templates live in query strings and path segments (see the seeded
 * endpoints in packages/db/src/seed/endpoints.ts), never in a context where encoding
 * would be wrong. */
export function substituteTemplate(template: string, args: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = args[key];
    return value === undefined ? "" : encodeURIComponent(String(value));
  });
}

/**
 * Bug caught live against api.weather.gov, which returns "application/geo+json", not
 * "application/json". A bare `.includes("application/json")` check misses every media
 * type using the standard "+json" structured-syntax suffix (RFC 6839) —
 * application/geo+json, application/ld+json, and so on are all still JSON. Left as a
 * text-parse fallback, this silently returns an unparsed string as `result` instead of
 * an object, which every real API consumer of the receipt would have to notice and work
 * around themselves. Extracted as its own pure function so it has a real regression test
 * (upstream.test.ts) that doesn't depend on network access to catch this again.
 */
export function isJsonContentType(contentType: string): boolean {
  return /\bjson\b/i.test(contentType);
}

export class FetchUpstreamClient implements UpstreamClient {
  async execute(req: UpstreamRequest): Promise<UpstreamResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), req.timeoutMs);
    const start = performance.now();
    try {
      const res = await fetch(req.url, {
        method: req.method,
        headers: req.body ? { "Content-Type": "application/json" } : undefined,
        body: req.body ? JSON.stringify(req.body) : undefined,
        signal: controller.signal,
      });
      const latencyMs = Math.round(performance.now() - start);
      const contentType = res.headers.get("content-type") ?? "";
      const body = isJsonContentType(contentType) ? await res.json() : await res.text();
      return { status: res.status, body, latencyMs };
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new UpstreamTimeoutError(req.timeoutMs);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}
