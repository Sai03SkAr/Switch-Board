/**
 * Real providers from plan/12-provider-shortlist.md, resale-verified 12 Sep 2026.
 * Every resale_note is the actual evidence recorded in that document — not paraphrased
 * here separately, so the two can't drift out of sync.
 */

export interface SeedProvider {
  slug: string;
  name: string;
  base_url: string;
  auth_type: "bearer" | "header" | "query" | "oauth" | "none";
  resale_allowed: boolean;
  resale_note: string;
  tos_url: string;
}

export const SEED_PROVIDERS: SeedProvider[] = [
  {
    slug: "nws",
    name: "National Weather Service",
    base_url: "https://api.weather.gov",
    auth_type: "none",
    resale_allowed: true,
    resale_note:
      "\"All of the information presented via the API is intended to be open data, free to use for any purpose.\" US government work, no fee, no resale clause found.",
    tos_url: "https://www.weather.gov/documentation/services-web-api",
  },
  {
    slug: "frankfurter",
    name: "Frankfurter",
    base_url: "https://api.frankfurter.dev",
    auth_type: "none",
    resale_allowed: true,
    resale_note:
      "\"Yes, absolutely\" on commercial use. Open source, self-hostable. Caveat: verify underlying central-bank sources if compliance-sensitive.",
    tos_url: "http://frankfurter.dev/",
  },
  {
    slug: "opentdb",
    name: "Open Trivia Database",
    base_url: "https://opentdb.com",
    auth_type: "none",
    resale_allowed: true,
    resale_note: "Data under CC BY-SA 4.0 — permits commercial use with attribution and share-alike.",
    tos_url: "https://opentdb.com/api_config.php",
  },
  {
    slug: "coingecko",
    name: "CoinGecko",
    base_url: "https://pro-api.coingecko.com",
    auth_type: "header",
    resale_allowed: true,
    resale_note:
      "\"You're entitled to charge for your services and products that incorporate or integrate data from CoinGecko API.\" Boundary: cannot resell raw API access or redistribute the dataset itself — fine here, since we execute-and-normalize rather than redistribute raw payloads.",
    tos_url: "https://www.coingecko.com/en/api/pricing",
  },
  {
    slug: "census",
    name: "US Census Bureau",
    base_url: "https://api.census.gov/data",
    auth_type: "query",
    resale_allowed: true,
    resale_note:
      "No commercial-use prohibition found. Requires an attribution disclaimer and forbids re-identifying individuals — irrelevant to aggregate demographic queries.",
    tos_url: "https://www.census.gov/data/developers/about/terms-of-service.html",
  },
  {
    slug: "twilio",
    name: "Twilio",
    base_url: "https://api.twilio.com",
    auth_type: "bearer",
    resale_allowed: true,
    resale_note:
      "ToS §2.2(b): may not resell \"except to make the Services available to your End Users.\" Explicitly contemplates an intermediary model.",
    tos_url: "https://www.twilio.com/en-us/legal/tos",
  },
  {
    slug: "sendgrid",
    name: "Twilio SendGrid",
    base_url: "https://api.sendgrid.com",
    auth_type: "bearer",
    resale_allowed: true,
    resale_note:
      "Formal \"ISV\" (Independent Software Vendor) model plus a documented Reseller Partnership program — resale is a named, supported use case.",
    tos_url: "https://www.twilio.com/docs/sendgrid/glossary/reseller-email-account",
  },
  {
    slug: "libretranslate",
    name: "LibreTranslate (self-hosted)",
    base_url: "http://localhost:5000",
    auth_type: "none",
    resale_allowed: true,
    resale_note:
      "AGPLv3, self-hostable. Running it yourself means there is no third-party provider ToS to violate — you're the operator, not a reseller of someone else's hosted service.",
    tos_url: "https://libretranslate.com/",
  },
];
