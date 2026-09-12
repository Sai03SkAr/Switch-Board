# 13 — Normalization spike: 3 real providers against the pricing schema

Directly executes the [07-roadmap.md](07-roadmap.md) Phase 0 spike: take 3 real providers
with genuinely different pricing shapes, express each in the `ToolSpec` pricing schema
from [05-data-model.md](05-data-model.md), and see if it actually fits. **It mostly does —
and it surfaced two real gaps**, documented below rather than papered over. That is the
entire point of doing a spike before Phase 1: find this now, on paper, not after code
depends on it.

Sourced 12 Sep 2026. All prices from published provider pricing pages.

---

## Provider 1 — CoinGecko (paid plan): PER_CALL

Real numbers, [CoinGecko pricing](https://www.coingecko.com/en/api/pricing): Analyst plan,
$129/month for 500,000 calls.

```
$129 / 500,000 calls = $0.000258 / call = 258 micros / call
```

```jsonc
{
  "model": "PER_CALL",
  "currency": "USD",
  "base_micros": 258,
  "unit": null,
  "unit_micros": null,
  "unit_divisor": null,
  "tiers": null,
  "max_possible_micros": 258,
  "estimator": "static"
}
```

**Fits cleanly.** But deriving that `258` surfaced **Gap 1**:

### Gap 1 — most real APIs aren't actually priced "per call"

CoinGecko doesn't sell you a per-call price. It sells a **monthly subscription with an
included quota** ($129 for 500,000 calls). The "$0.000258/call" figure isn't a price
CoinGecko charges — it's one **derived** by dividing plan cost by included volume, an
approximation.

This turned out not to be an edge case — it's the *majority* pattern. Twilio, SendGrid,
most SaaS APIs bill this way. True pay-as-you-go metering (no subscription, price fixed
regardless of volume) is the minority.

**Fix — add an explicit rule to [05-data-model.md](05-data-model.md):**

> `base_micros` for a `PER_CALL` endpoint always means "our actual cost to make this
> call," regardless of how the upstream provider bills. For a subscription+quota
> provider, this is `plan_cost / included_quota`, computed at ingestion time and
> re-derived whenever the plan or quota changes. Never enter the provider's own headline
> number if it's a subscription price, not a per-call price.

Practically: the catalogue ingestion tool needs a small "amortize a subscription plan
into a per-call cost" helper, and a scheduled job to re-check it — a plan renegotiation or
quota change silently invalidates every cached cost estimate otherwise.

---

## Provider 2 — ElevenLabs (text-to-speech): PER_UNIT

Real numbers, [ElevenLabs pricing](https://elevenlabs.io/pricing): Starter plan, $6/month
for 30,000 credits, 1 credit = 1 character for text-to-speech.

```
$6 / 30,000 characters = $0.0002 / character = 200 micros / character
```

```jsonc
{
  "model": "PER_UNIT",
  "currency": "USD",
  "base_micros": 0,
  "unit": "character",
  "unit_micros": 200,
  "unit_divisor": 1,
  "tiers": null,
  "max_possible_micros": 100000,     // see Gap 2 — this number must be DERIVED, not guessed
  "estimator": "from_args"
}
```

**This is the endpoint category [02-weaknesses.md](02-weaknesses.md) called out directly**
— Monid's TTS listing showed "$60" with no unit disclosed, and users had to work out it
meant per-million-characters. Here `unit`, `unit_micros`, and `unit_divisor` say exactly
that, machine-readably. Real proof the fix works, not just a claim.

One genuinely good property: because cost is `characters_in_input × unit_micros` and the
input is known *before* the call, the `from_args` estimate can be **exact**, not a
guess — the estimate and the actual charge are the same number. Worth keeping in mind as
a general rule: whenever cost depends only on the request, not the response, quote it as
a fact, not an estimate.

### Gap 2 — `max_possible_micros` isn't optional for `from_args`, and it isn't obvious

[05-data-model.md](05-data-model.md) calls `max_possible_micros` mandatory — "no endpoint
enters the catalogue without it" — because it's the amount reserved before the call runs.
For `PER_CALL` that's trivial (the price *is* the max). For `from_args` with an
open-ended unit like "character," **there is no upper bound unless one is imposed.**

TTS APIs generally do cap input length per request (a few thousand characters is typical).
That cap is exactly what makes `max_possible_micros` computable:

```
max_possible_micros = unit_micros × endpoint's enforced max unit count
```

**Fix — add this rule to [05-data-model.md](05-data-model.md):**

> For any `from_args` estimator, `max_possible_micros = unit_micros × the endpoint's
> documented maximum input size`. That maximum must be enforced in the endpoint's
> `input_schema` (e.g. a JSON Schema `maxLength`) at ingestion time — not just documented,
> *enforced*, so the executor's schema-validation step rejects an oversized request before
> any hold is taken. **An endpoint with no enforceable input cap cannot be onboarded**,
> because there is no way to bound what it might cost. This is a hard ingestion gate, the
> same way `resale_allowed` is.

This is a real, previously-missing rule — the original schema had the field but not the
method for computing it safely for open-ended inputs.

---

## Provider 3 — Google Maps Geocoding API: TIERED

Real numbers, [Google Maps pricing](https://developers.google.com/maps/billing-and-pricing/pricing):
first 10,000 events/month free, then descending per-1,000 rates down to volume.

```jsonc
{
  "model": "TIERED",
  "currency": "USD",
  "base_micros": 0,
  "unit": "request",
  "tiers": [
    { "up_to": 10000,    "micros": 0 },
    { "up_to": 100000,   "micros": 5000 },
    { "up_to": 500000,   "micros": 4000 },
    { "up_to": 1000000,  "micros": 3000 },
    { "up_to": 5000000,  "micros": 1500 },
    { "up_to": null,     "micros": 380 }
  ],
  "max_possible_micros": 5000,
  "estimator": "from_args"
}
```

> **Google Maps is excluded from the catalogue on legal grounds regardless** — see
> [12-provider-shortlist.md](12-provider-shortlist.md), it explicitly bans resale and
> caching. It's used here purely because its pricing is real, public, and a clean example
> of the `TIERED` shape. Don't onboard it.

The JSON above technically fits the schema. But writing it out surfaced **Gap 3**, the
most important one:

### Gap 3 — "tiered" is ambiguous about *what* it tiers over, and the schema needs to say

There are two completely different things "tiered pricing" can mean:

1. **Tiered by this call's own argument size** — e.g. "requesting 1–10 results costs $X,
   requesting 11–100 costs $Y," known entirely from this call's own arguments
2. **Tiered by cumulative volume over a billing period** — Google's actual model: which
   price bracket *this* call falls into depends on how many calls the **whole workspace**
   already made **this month**, which the current call's arguments say nothing about

The schema as written treats both as the same `tiers` array. They are not. Case 2 means
the cost estimator can't price a call from that call alone — it has to look up a running
usage counter for that workspace+endpoint+billing period first, and even then the answer
can be wrong if other concurrent calls land in the same instant near a tier boundary.
Nothing in [05-data-model.md](05-data-model.md) currently tracks that counter — it isn't
the same thing as `budget_usage` (which tracks *spend*, not *raw call volume per
endpoint*).

**Recommendation — narrow v1 scope rather than build the volume-tracking machinery:**

> Support `TIERED` in v1 for **argument-size tiering only** (case 1). Explicitly exclude
> cumulative-monthly-volume providers (case 2) from the v1 catalogue — not only for the
> ToS reasons in [12-provider-shortlist.md](12-provider-shortlist.md), but because the
> metering model doesn't cleanly support it yet. If a genuinely valuable case-2 provider
> shows up later, it needs its own `provider_usage_counters` table (endpoint_id,
> workspace_id, period_start, call_count) before it can be priced correctly — that's a
> deliberate future phase, not a v1 requirement.

This keeps the schema honest about what it currently does, rather than quietly mispricing
a call the first time a cumulative-volume provider gets ingested.

---

## Verdict

**The schema fits 3 real, structurally different providers** — PER_CALL, PER_UNIT,
TIERED — with real, sourced numbers, no fabrication. That's 3 of the 5 models in
[05-data-model.md](05-data-model.md); `PER_RESULT` and `PER_UNIT_MATRIX` weren't spiked
this round and should be checked against a real provider before either enters the v1
catalogue.

**Three concrete fixes came out of doing this on paper instead of skipping to code:**

| Gap | Fix | Where it lands |
|---|---|---|
| 1. Subscription-billed providers aren't "per call" | Amortize plan cost ÷ quota at ingestion; re-derive on plan changes | Ingestion tooling, Phase 1 |
| 2. `max_possible_micros` unclear for open-ended `from_args` | `= unit_micros × enforced input cap`; cap must be a real JSON Schema constraint | `05-data-model.md` pricing rules |
| 3. "Tiered" conflates two different pricing shapes | v1 supports argument-size tiering only; cumulative-volume tiering deferred | Catalogue scope, `05-data-model.md` |

This is exactly what a spike is for — cheaper to find on paper in Phase 0 than after
Phase 1 code assumes a schema that turns out to have a hole in it.

## Sources

[CoinGecko pricing](https://www.coingecko.com/en/api/pricing) ·
[ElevenLabs pricing](https://elevenlabs.io/pricing) ·
[Google Maps Platform pricing](https://developers.google.com/maps/billing-and-pricing/pricing) ·
all fetched 12 Sep 2026.
