import type { PricingModel } from "@switchboard/core";
import { amortizeSubscription } from "@switchboard/core";

/**
 * 17 real endpoints across the 8 providers confirmed clear in
 * plan/12-provider-shortlist.md — comfortably past the "15+ endpoints, 5+ providers"
 * acceptance bar in plan/07-roadmap.md Phase 1.
 *
 * Pricing sourced 12 Sep 2026 (see inline notes for anything not independently
 * confirmed this session — flagged rather than presented as fact, same standard as
 * the rest of this planning set).
 */

export interface SeedEndpoint {
  provider_slug: string;
  slug: string;
  name: string;
  description: string;
  categories: string[];
  example_queries: string[];
  input_schema: object;
  output_schema?: object;
  pricing: PricingModel;
  upstream_path: string;
  upstream_method: "GET" | "POST";
}

const FREE: Omit<PricingModel, "model" | "estimator"> = {
  currency: "USD",
  base_micros: 0,
  max_possible_micros: 0,
};

export const SEED_ENDPOINTS: SeedEndpoint[] = [
  // ---------- National Weather Service (free, public domain) ----------
  {
    provider_slug: "nws",
    slug: "get-active-alerts",
    name: "Active weather alerts by area",
    description: "Get currently active weather alerts and warnings for a US state or territory.",
    categories: ["weather", "alerts", "government"],
    example_queries: ["active weather alerts for a state", "is there a tornado warning right now"],
    input_schema: { type: "object", properties: { area: { type: "string", maxLength: 2 } }, required: ["area"] },
    pricing: { ...FREE, model: "PER_CALL", estimator: "static" },
    upstream_path: "/alerts/active?area={area}",
    upstream_method: "GET",
  },
  {
    provider_slug: "nws",
    slug: "get-point-metadata",
    name: "Grid point metadata for a location",
    description: "Get the forecast grid, office, and forecast URLs for a latitude/longitude point.",
    categories: ["weather", "geocoding", "government"],
    example_queries: ["weather forecast for coordinates", "what NWS office covers this location"],
    input_schema: {
      type: "object",
      properties: { lat: { type: "number" }, lon: { type: "number" } },
      required: ["lat", "lon"],
    },
    pricing: { ...FREE, model: "PER_CALL", estimator: "static" },
    upstream_path: "/points/{lat},{lon}",
    upstream_method: "GET",
  },
  {
    provider_slug: "nws",
    slug: "get-latest-observation",
    name: "Latest station observation",
    description: "Get the most recent weather observation (temperature, wind, etc.) from a specific station.",
    categories: ["weather", "government"],
    example_queries: ["current temperature at a weather station", "latest wind speed reading"],
    input_schema: { type: "object", properties: { stationId: { type: "string" } }, required: ["stationId"] },
    pricing: { ...FREE, model: "PER_CALL", estimator: "static" },
    upstream_path: "/stations/{stationId}/observations/latest",
    upstream_method: "GET",
  },

  // ---------- Frankfurter (free, open source) ----------
  {
    provider_slug: "frankfurter",
    slug: "get-latest-rates",
    name: "Latest exchange rates",
    description: "Get the latest foreign exchange rates for a base currency against one or more target currencies.",
    categories: ["currency", "finance"],
    example_queries: ["current exchange rate USD to EUR", "latest currency rates"],
    input_schema: {
      type: "object",
      properties: { base: { type: "string", minLength: 3, maxLength: 3 }, symbols: { type: "string" } },
      required: ["base"],
    },
    pricing: { ...FREE, model: "PER_CALL", estimator: "static" },
    upstream_path: "/v1/latest?base={base}&symbols={symbols}",
    upstream_method: "GET",
  },
  {
    provider_slug: "frankfurter",
    slug: "convert-amount",
    name: "Convert a currency amount",
    description: "Convert a specific amount from one currency to another using the latest exchange rate.",
    categories: ["currency", "finance"],
    example_queries: ["convert 100 dollars to euros", "how much is 50 GBP in JPY"],
    input_schema: {
      type: "object",
      properties: {
        amount: { type: "number" },
        from: { type: "string", minLength: 3, maxLength: 3 },
        to: { type: "string", minLength: 3, maxLength: 3 },
      },
      required: ["amount", "from", "to"],
    },
    pricing: { ...FREE, model: "PER_CALL", estimator: "static" },
    upstream_path: "/v1/latest?amount={amount}&from={from}&to={to}",
    upstream_method: "GET",
  },
  {
    provider_slug: "frankfurter",
    slug: "get-historical-rate",
    name: "Historical exchange rate",
    description: "Get the exchange rate for a base currency on a specific historical date.",
    categories: ["currency", "finance"],
    example_queries: ["exchange rate on a specific date", "historical USD to GBP rate"],
    input_schema: {
      type: "object",
      properties: { date: { type: "string", format: "date" }, base: { type: "string" }, symbols: { type: "string" } },
      required: ["date", "base"],
    },
    pricing: { ...FREE, model: "PER_CALL", estimator: "static" },
    upstream_path: "/v1/{date}?base={base}&symbols={symbols}",
    upstream_method: "GET",
  },

  // ---------- Open Trivia Database (free, CC BY-SA 4.0) ----------
  {
    provider_slug: "opentdb",
    slug: "get-trivia-questions",
    name: "Get trivia questions",
    description: "Fetch a batch of trivia questions, optionally filtered by category and difficulty.",
    categories: ["fun", "demo", "trivia"],
    example_queries: ["give me some trivia questions", "generate a quiz"],
    input_schema: {
      type: "object",
      properties: {
        amount: { type: "integer", minimum: 1, maximum: 50 },
        category: { type: "integer" },
        difficulty: { type: "string", enum: ["easy", "medium", "hard"] },
      },
      required: ["amount"],
    },
    pricing: { ...FREE, model: "PER_CALL", estimator: "static" },
    upstream_path: "/api.php?amount={amount}&category={category}&difficulty={difficulty}",
    upstream_method: "GET",
  },

  // ---------- CoinGecko (paid Analyst plan, amortized) ----------
  {
    provider_slug: "coingecko",
    slug: "get-coin-price",
    name: "Get current coin price",
    description: "Get the current price of one or more cryptocurrencies in one or more fiat currencies.",
    categories: ["crypto", "finance"],
    example_queries: ["current bitcoin price", "how much is ethereum worth in USD"],
    input_schema: {
      type: "object",
      properties: { ids: { type: "string" }, vs_currencies: { type: "string" } },
      required: ["ids", "vs_currencies"],
    },
    // $129/month Analyst plan / 500,000 included calls — see 13-normalization-spike.md
    pricing: {
      currency: "USD",
      base_micros: amortizeSubscription(129_000_000, 500_000),
      max_possible_micros: amortizeSubscription(129_000_000, 500_000),
      model: "PER_CALL",
      estimator: "static",
    },
    upstream_path: "/api/v3/simple/price?ids={ids}&vs_currencies={vs_currencies}",
    upstream_method: "GET",
  },
  {
    provider_slug: "coingecko",
    slug: "get-coin-market-chart",
    name: "Get coin market chart",
    description: "Get historical market data (price, market cap, volume) for a coin over a number of days.",
    categories: ["crypto", "finance"],
    example_queries: ["bitcoin price history", "30 day ethereum chart data"],
    input_schema: {
      type: "object",
      properties: { id: { type: "string" }, vs_currency: { type: "string" }, days: { type: "integer" } },
      required: ["id", "vs_currency", "days"],
    },
    pricing: {
      currency: "USD",
      base_micros: amortizeSubscription(129_000_000, 500_000),
      max_possible_micros: amortizeSubscription(129_000_000, 500_000),
      model: "PER_CALL",
      estimator: "static",
    },
    upstream_path: "/api/v3/coins/{id}/market_chart?vs_currency={vs_currency}&days={days}",
    upstream_method: "GET",
  },
  {
    provider_slug: "coingecko",
    slug: "search-coins",
    name: "Search coins, exchanges, categories",
    description: "Search CoinGecko's database for coins, exchanges, and categories matching a query string.",
    categories: ["crypto", "finance", "search"],
    example_queries: ["find a cryptocurrency by name", "search for a coin ticker"],
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    pricing: {
      currency: "USD",
      base_micros: amortizeSubscription(129_000_000, 500_000),
      max_possible_micros: amortizeSubscription(129_000_000, 500_000),
      model: "PER_CALL",
      estimator: "static",
    },
    upstream_path: "/api/v3/search?query={query}",
    upstream_method: "GET",
  },
  {
    provider_slug: "coingecko",
    slug: "get-trending-coins",
    name: "Get trending coins",
    description: "Get the top trending cryptocurrencies on CoinGecko in the last 24 hours, based on search activity.",
    categories: ["crypto", "finance"],
    example_queries: ["what crypto is trending right now", "top searched coins today"],
    input_schema: { type: "object", properties: {} },
    pricing: {
      currency: "USD",
      base_micros: amortizeSubscription(129_000_000, 500_000),
      max_possible_micros: amortizeSubscription(129_000_000, 500_000),
      model: "PER_CALL",
      estimator: "static",
    },
    upstream_path: "/api/v3/search/trending",
    upstream_method: "GET",
  },

  // ---------- US Census Bureau (free, public data) ----------
  {
    provider_slug: "census",
    slug: "get-population-by-state",
    name: "Get population estimate by state",
    description: "Get the total population estimate for every US state from the American Community Survey.",
    categories: ["demographics", "government", "public-data"],
    example_queries: ["population of a US state", "how many people live in California"],
    input_schema: { type: "object", properties: { year: { type: "integer" } }, required: ["year"] },
    pricing: { ...FREE, model: "PER_CALL", estimator: "static" },
    upstream_path: "/{year}/acs/acs1?get=NAME,B01001_001E&for=state:*",
    upstream_method: "GET",
  },
  {
    provider_slug: "census",
    slug: "get-population-estimate",
    name: "Get annual population estimate",
    description: "Get the Population Estimates Program's annual population figure for every US state.",
    categories: ["demographics", "government", "public-data"],
    example_queries: ["latest population estimate by state", "annual state population figures"],
    input_schema: { type: "object", properties: { year: { type: "integer" } }, required: ["year"] },
    pricing: { ...FREE, model: "PER_CALL", estimator: "static" },
    upstream_path: "/{year}/pep/population?get=NAME,POP&for=state:*",
    upstream_method: "GET",
  },

  // ---------- Twilio (PER_CALL, base rate — carrier fees add ~$0.0035-0.0045, see note) ----------
  {
    provider_slug: "twilio",
    slug: "send-sms",
    name: "Send an SMS message",
    description: "Send a text message to a phone number.",
    categories: ["messaging", "sms"],
    example_queries: ["send a text message", "notify someone by SMS"],
    input_schema: {
      type: "object",
      properties: { to: { type: "string" }, from: { type: "string" }, body: { type: "string", maxLength: 1600 } },
      required: ["to", "from", "body"],
    },
    // $0.0083 base rate for a US SMS (Twilio's own published figure, 12 Sep 2026).
    // Carrier fees (~$0.0035-0.0045) are real but variable by carrier — not included here;
    // flag before going live with real money.
    pricing: { currency: "USD", base_micros: 8300, max_possible_micros: 8300, model: "PER_CALL", estimator: "static" },
    upstream_path: "/2010-04-01/Accounts/{AccountSid}/Messages.json",
    upstream_method: "POST",
  },

  // ---------- SendGrid (PER_CALL, amortized — see note on source ambiguity) ----------
  {
    provider_slug: "sendgrid",
    slug: "send-email",
    name: "Send a transactional email",
    description: "Send a single transactional email to one or more recipients.",
    categories: ["messaging", "email"],
    example_queries: ["send an email", "notify a user by email"],
    input_schema: {
      type: "object",
      properties: { to: { type: "string" }, from: { type: "string" }, subject: { type: "string" }, body: { type: "string" } },
      required: ["to", "from", "subject", "body"],
    },
    // Sourced 12 Sep 2026: secondary sources disagree on whether the $19.95/mo Essentials
    // tier includes 50,000 or 100,000 emails — used the more commonly cited 50,000 figure.
    // VERIFY against sendgrid.com's live pricing page before this leaves the demo catalogue.
    pricing: {
      currency: "USD",
      base_micros: amortizeSubscription(19_950_000, 50_000),
      max_possible_micros: amortizeSubscription(19_950_000, 50_000),
      model: "PER_CALL",
      estimator: "static",
    },
    upstream_path: "/v3/mail/send",
    upstream_method: "POST",
  },

  // ---------- LibreTranslate (self-hosted, no marginal per-call cost beyond infra) ----------
  {
    provider_slug: "libretranslate",
    slug: "translate-text",
    name: "Translate text",
    description: "Translate a string of text from one language to another.",
    categories: ["translation", "language"],
    example_queries: ["translate this to Spanish", "what does this say in French"],
    input_schema: {
      type: "object",
      properties: {
        q: { type: "string", maxLength: 5000 },
        source: { type: "string" },
        target: { type: "string" },
      },
      required: ["q", "source", "target"],
    },
    pricing: { ...FREE, model: "PER_CALL", estimator: "static" },
    upstream_path: "/translate",
    upstream_method: "POST",
  },
  {
    provider_slug: "libretranslate",
    slug: "detect-language",
    name: "Detect language",
    description: "Detect the language a piece of text is written in.",
    categories: ["translation", "language"],
    example_queries: ["what language is this text", "detect language of a sentence"],
    input_schema: { type: "object", properties: { q: { type: "string", maxLength: 5000 } }, required: ["q"] },
    pricing: { ...FREE, model: "PER_CALL", estimator: "static" },
    upstream_path: "/detect",
    upstream_method: "POST",
  },
];
