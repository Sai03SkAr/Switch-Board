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
  /** Set only for a provider explicitly reviewed and flagged
   * `providers.allow_local_target = true` (e.g. self-hosted LibreTranslate). Everything
   * else is blocked by default — see isBlockedUpstreamHost's doc comment. */
  allowLocalTarget?: boolean;
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

export class BlockedUpstreamHostError extends Error {
  constructor(hostname: string) {
    super(`Refusing to call ${hostname}: private, loopback, or link-local addresses are never a valid upstream target`);
    this.name = "BlockedUpstreamHostError";
  }
}

/**
 * SSRF guard (plan/09-risks.md R6): "upstream URLs come only from the reviewed
 * catalogue, never from user input; deny private IP ranges and metadata endpoints."
 *
 * Worth being precise about what this does and doesn't cover. The realistic threat model
 * here is a mistaken or malicious catalogue row (a `providers.base_url` pointing at an
 * internal service, added by ingestion tooling that doesn't validate it) — NOT a caller
 * injecting a new host via `run` arguments, because `substituteTemplate()` already
 * URL-encodes every argument value. A value like "http://evil.com" supplied as an arg
 * becomes the literal encoded string "http%3A%2F%2Fevil.com" wherever it lands in a path
 * or query placeholder — it can never introduce a new scheme or host into the URL, only
 * this file's own `base_url` + `upstream_path` concatenation can do that, and both come
 * from the reviewed catalogue. See upstream.test.ts for a test proving this directly.
 *
 * What this check catches: literal loopback (127.0.0.0/8, ::1), private ranges
 * (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16), link-local (169.254.0.0/16 — this is
 * where cloud metadata endpoints like 169.254.169.254 live), and the "localhost" name.
 * What it does NOT catch: DNS rebinding (a hostname that resolves to a public IP at
 * check-time but a private one at connect-time). Closing that fully needs a resolving
 * HTTP agent that re-checks the IP on every connection, not a pre-flight string check —
 * out of scope for this project's current threat model (a reviewed, human-curated
 * catalogue), but worth knowing if this ever proxies arbitrary/unreviewed hosts.
 */
export function isBlockedUpstreamHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "0.0.0.0") return true;

  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 127) return true; // loopback
    if (a === 10) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    return false;
  }
  if (h === "::1" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return true; // IPv6 loopback/link-local/unique-local
  return false;
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
    const hostname = new URL(req.url).hostname;
    if (!req.allowLocalTarget && isBlockedUpstreamHost(hostname)) {
      throw new BlockedUpstreamHostError(hostname);
    }

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
