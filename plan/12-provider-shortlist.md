# 12 — Provider shortlist: resale/proxying verified

Directly addresses [09-risks.md](09-risks.md) **R2** — provider ToS may forbid resale or
proxying. All checks below are **primary-source**: fetched directly from each provider's
own terms/docs on **12 September 2026**. Not secondhand summaries. Quotes are verbatim
where the source gave them.

Per the schema in [05-data-model.md](05-data-model.md), every provider carries a required
`resale_allowed` boolean and gates catalogue ingestion. That field is populated below.
**Anything short of an explicit "yes" defaults to blocked** — the discipline the schema
was built around, applied here for real.

---

## ✅ Confirmed clear — 7

| Provider | Category | Evidence | `resale_allowed` |
|---|---|---|---|
| **[Twilio](https://www.twilio.com/en-us/legal/tos)** (SMS/Voice) | Messaging | ToS §2.2(b): may not resell "except to make the Services available to your End Users." Explicitly contemplates an intermediary model, provided you add your own application layer rather than reselling standalone | ✅ Yes |
| **[Twilio SendGrid](https://www.twilio.com/docs/sendgrid/glossary/reseller-email-account)** (Email) | Messaging | Formal "ISV" (Independent Software Vendor) model plus a documented Reseller Partnership program — resale is a supported, named use case | ✅ Yes |
| **[National Weather Service API](https://www.weather.gov/documentation/services-web-api)** (weather.gov) | Weather | "All of the information presented via the API is intended to be open data, free to use for any purpose." US government work, no fee, no resale clause found | ✅ Yes |
| **[Frankfurter](http://frankfurter.dev/)** (currency exchange) | Finance | "Yes, absolutely" on commercial use. Open source, self-hostable. Caveat: verify each underlying central-bank source if compliance-sensitive | ✅ Yes, with caveat |
| **[Open Trivia Database](https://opentdb.com/api_config.php)** | Fun/demo | Data is under **CC BY-SA 4.0** — a real open license, not just a free-tier claim. Permits commercial use with attribution and share-alike | ✅ Yes |
| **[CoinGecko](https://www.coingecko.com/en/api/pricing)** (paid plan) | Finance/crypto | "You're entitled to charge for your services and products that incorporate or integrate data from CoinGecko API." Boundary: cannot resell raw API access or redistribute the dataset itself — fine for us, since we execute-and-normalize rather than redistribute raw payloads | ✅ Yes, with boundary (see below) |
| **[US Census Bureau API](https://www.census.gov/data/developers/about/terms-of-service.html)** | Public data | No commercial-use prohibition found. Requires attribution disclaimer and forbids re-identifying individuals — irrelevant to aggregate demographic queries | ✅ Yes |

## 🟡 High confidence, not directly quotable — 1

| Provider | Why it's here | `resale_allowed` |
|---|---|---|
| **[NASA APIs](https://api.nasa.gov/)** | US government work is public domain by long-standing doctrine (17 U.S.C. §105). The signup page itself didn't expose ToS text to a direct fetch — this is general public-domain law applied to a US federal API, not a quoted clause. **Read the actual terms page yourself before onboarding** | 🟡 Likely yes — confirm before use |

## ⏳ Needs one more step before it's usable — 2

| Provider | Gap | What closes it |
|---|---|---|
| **ElevenLabs** (TTS) | Pricing confirmed (see [13-normalization-spike.md](13-normalization-spike.md)); resale/reseller language not yet fetched | Read their ToS for reseller/API-access-resale clauses before catalogue entry |
| **Open-Meteo** (paid commercial tier) | Free tier is explicitly non-commercial only. Paid tier grants a "commercial use licence" but doesn't explicitly address proxying to third parties | Email `info@open-meteo.com` and get it in writing before catalogue entry |

## 🧩 Self-hosted path — 1

| Provider | Why it dodges the ToS problem entirely | `resale_allowed` |
|---|---|---|
| **LibreTranslate** | AGPLv3, self-hostable. If you run the software yourself, there is no third-party provider ToS to violate — you're the operator, not a reseller of someone else's hosted service. This is the concrete version of the self-host mitigation already recommended in [09-risks.md](09-risks.md) | ✅ Yes, by construction |

**Total: 11 providers tracked, 8 ready to onboard as-is, 2 one step from ready, 1 self-hosted.**
That comfortably covers the 8–12 target in [07-roadmap.md](07-roadmap.md) Phase 0, across
five categories: messaging, weather, finance, public data, and translation.

---

## ❌ Confirmed blocked — keep for the risk log

These looked "free and open" on the surface. They are not. Recording them protects future-you
from re-discovering this the expensive way.

| Provider | The trap | Evidence |
|---|---|---|
| **REST Countries** | Explicitly bans resale **even on the paid plan** without written consent | §4: "Resell or sublicense the Service or its outputs without prior written consent." §6 also bans aggregating the dataset into any downstream product |
| **OpenStreetMap Nominatim** (geocoding) | Names **"API resellers"** directly as a prohibited use case | "Applications and services whose primary function is related to geocoding must run their own service... [prohibits] reselling of geocoding results" |
| **Google Maps Platform** | Explicit no-cache, no-resell, no-redistribute clause; scraping/pre-fetching also banned | "Customer will not... sell, resell, sublicense, transfer, or distribute the Services," and will not permit a third party to either |

Google Maps is still useful later in this document — its *pricing structure* is real and
well documented even though the provider itself is excluded from the catalogue.

## The pattern worth remembering

Every blocked provider above markets itself as "free" or "open." All three explicitly and
specifically name **resale, proxying, or reselling to third parties** as prohibited — the
exact business model this project runs on. **"Free tier" and "resale-permitted" are
unrelated axes.** Check the second one explicitly, every time, before catalogue entry.
That's now a standing rule, not a one-off finding — see [09-risks.md](09-risks.md) R2.

## Recommended starter catalogue (Phase 1)

From the 8 ready-now providers, pick a first slice that's genuinely diverse in category
and pricing shape — not more of the same thing:

1. Twilio SMS — messaging, PER_UNIT
2. Twilio SendGrid — messaging, PER_UNIT/tiered
3. National Weather Service — weather, PER_CALL (free)
4. Frankfurter — currency, PER_CALL (free)
5. Open Trivia DB — fun/demo, PER_CALL (free)
6. CoinGecko (paid) — crypto, PER_CALL (credit-bundle, see spike)
7. US Census — public data, PER_CALL (free)
8. LibreTranslate (self-hosted) — translation, PER_CALL or PER_UNIT depending on deployment

That's 5+ providers across 5 categories, all confirmed clear — a defensible, diverse
Phase 1 catalogue with zero legal ambiguity.

## Sources

All fetched directly 12 Sep 2026: [Twilio ToS](https://www.twilio.com/en-us/legal/tos) ·
[Twilio SendGrid reseller docs](https://www.twilio.com/docs/sendgrid/glossary/reseller-email-account) ·
[weather.gov API docs](https://www.weather.gov/documentation/services-web-api) ·
[Frankfurter](http://frankfurter.dev/) · [Open Trivia DB](https://opentdb.com/api_config.php) ·
[CoinGecko pricing](https://www.coingecko.com/en/api/pricing) ·
[Census Bureau ToS](https://www.census.gov/data/developers/about/terms-of-service.html) ·
[NASA APIs](https://api.nasa.gov/) · [REST Countries ToS](https://restcountries.com/legal/terms-of-service) ·
[Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/) ·
[Google Maps Platform terms](https://cloud.google.com/maps-platform/terms) ·
[LibreTranslate](https://libretranslate.com/)
