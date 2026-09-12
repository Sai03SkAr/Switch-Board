import { describe, it, expect } from "vitest";
import { substituteTemplate, isJsonContentType } from "../src/upstream.js";

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
});
