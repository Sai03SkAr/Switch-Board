import { describe, it, expect } from "vitest";
import { substituteTemplate, isJsonContentType, isBlockedUpstreamHost, FetchUpstreamClient, BlockedUpstreamHostError } from "../src/upstream.js";

describe("isJsonContentType — caught live against a real provider, not invented speculatively", () => {
  it("recognizes plain application/json", () => {
    expect(isJsonContentType("application/json")).toBe(true);
    expect(isJsonContentType("application/json; charset=utf-8")).toBe(true);
  });

  it("recognizes structured-syntax +json suffixes (RFC 6839) — the exact bug this test guards", () => {
    // api.weather.gov returns exactly this. Missing it silently returned an unparsed
    // string as a run's `result` instead of a parsed object.
    expect(isJsonContentType("application/geo+json")).toBe(true);
    expect(isJsonContentType("application/ld+json")).toBe(true);
    expect(isJsonContentType("application/vnd.api+json")).toBe(true);
  });

  it("does not falsely match non-JSON content types", () => {
    expect(isJsonContentType("text/html")).toBe(false);
    expect(isJsonContentType("text/plain")).toBe(false);
    expect(isJsonContentType("")).toBe(false);
  });
});

describe("substituteTemplate", () => {
  it("substitutes and URI-encodes path/query placeholders", () => {
    expect(substituteTemplate("/v1/latest?base={base}&symbols={symbols}", { base: "USD", symbols: "EUR" })).toBe(
      "/v1/latest?base=USD&symbols=EUR"
    );
  });

  it("URI-encodes values that need it", () => {
    expect(substituteTemplate("/search?query={query}", { query: "a b&c" })).toBe("/search?query=a%20b%26c");
  });

  it("leaves an unmatched placeholder as an empty string rather than crashing", () => {
    expect(substituteTemplate("/points/{lat},{lon}", { lat: 34.05 })).toBe("/points/34.05,");
  });

  it(
    "URL-encoding means an arg value can NEVER inject a new host into the request — " +
      "the actual SSRF-relevant property this function guarantees, not just an escaping nicety",
    () => {
      const malicious = substituteTemplate("/v1/latest?base={base}", { base: "http://evil.internal/steal" });
      // The malicious value survives only as an inert, encoded STRING inside the query
      // parameter — it can never be parsed as a new scheme+host by any HTTP client.
      expect(malicious).toBe("/v1/latest?base=http%3A%2F%2Fevil.internal%2Fsteal");
      expect(new URL(`https://api.frankfurter.dev${malicious}`).hostname).toBe("api.frankfurter.dev");
    }
  );
});

describe("isBlockedUpstreamHost — SSRF guard (plan/09-risks.md R6)", () => {
  it("blocks loopback, private, and link-local ranges, and localhost", () => {
    expect(isBlockedUpstreamHost("localhost")).toBe(true);
    expect(isBlockedUpstreamHost("127.0.0.1")).toBe(true);
    expect(isBlockedUpstreamHost("10.0.0.5")).toBe(true);
    expect(isBlockedUpstreamHost("172.16.0.1")).toBe(true);
    expect(isBlockedUpstreamHost("192.168.1.1")).toBe(true);
    expect(isBlockedUpstreamHost("169.254.169.254")).toBe(true); // cloud metadata endpoint
    expect(isBlockedUpstreamHost("::1")).toBe(true);
  });

  it("does not block real public API hosts", () => {
    expect(isBlockedUpstreamHost("api.weather.gov")).toBe(false);
    expect(isBlockedUpstreamHost("api.frankfurter.dev")).toBe(false);
    expect(isBlockedUpstreamHost("8.8.8.8")).toBe(false);
  });

  it("does not false-positive on a public IP that merely starts with a blocked octet", () => {
    // 172.32.x.x is PUBLIC — only 172.16.0.0 through 172.31.255.255 is the private
    // range. A naive "starts with 172" check would wrongly block this.
    expect(isBlockedUpstreamHost("172.32.0.1")).toBe(false);
  });
});

describe("FetchUpstreamClient — SSRF guard wired into the real client", () => {
  it("refuses to call a private host by default", async () => {
    const client = new FetchUpstreamClient();
    await expect(client.execute({ method: "GET", url: "http://127.0.0.1:9999/", timeoutMs: 1000 })).rejects.toThrow(
      BlockedUpstreamHostError
    );
  });

  it("allows a private host ONLY when explicitly flagged — the LibreTranslate exception", async () => {
    const client = new FetchUpstreamClient();
    // No server is actually listening on this port — expect a connection error, NOT a
    // BlockedUpstreamHostError. Proves the guard is bypassed for this call, without
    // requiring a real LibreTranslate instance to be running for the test to mean anything.
    await expect(
      client.execute({ method: "GET", url: "http://127.0.0.1:9999/", timeoutMs: 1000, allowLocalTarget: true })
    ).rejects.not.toThrow(BlockedUpstreamHostError);
  });
});
