# Switxh Board — Planning Set

A complete plan to build a competitor to [Monid](https://monid.ai/): an agent-native
tool router with a metered wallet. **These are planning documents only. No product
code has been written.**

Project name: **Switxh Board** — **LOCKED** 8 Sep 2026 (re-confirmed same day after a
brief revert to SwitchBoard). Repo/package slug: `switxh-board`. CLI binary: `sw`.
See [11-names.md](11-names.md) for the full decision record, including the
pronunciation trade-off that was weighed and knowingly accepted.

## Read in this order

| # | Document | What it answers |
|---|----------|-----------------|
| 01 | [Teardown](01-teardown.md) | What Monid actually is, verified against its own API and docs |
| 02 | [Weaknesses](02-weaknesses.md) | Where it is genuinely soft — sourced, dated, separated from speculation |
| 03 | [Positioning](03-positioning.md) | How you win, including the trust/psychology strategy |
| 04 | [Architecture](04-architecture.md) | System design, components, request flows |
| 05 | [Data model](05-data-model.md) | Schema, and the double-entry ledger at the core of the product |
| 06 | [API spec](06-api-spec.md) | Your public surface: REST, MCP, CLI |
| 07 | [Roadmap](07-roadmap.md) | Phased build with acceptance criteria per phase |
| 08 | [Requirements](08-requirements.md) | Stack, services, running costs, skills, realistic effort |
| 09 | [Risks](09-risks.md) | Legal, financial, and technical exposure — read before writing code |
| 10 | [Verification log](10-verification-log.md) | Dated evidence for every competitor claim |
| 11 | [Names](11-names.md) | Collision-checked name candidates |
| 12 | [Provider shortlist](12-provider-shortlist.md) | Resale/ToS-verified providers — closes risk R2 |
| 13 | [Normalization spike](13-normalization-spike.md) | 3 real providers vs. the pricing schema, 3 gaps found and fixed |

## The one-paragraph version

Monid solved a real problem and its metering is, by independent test, accurate to the
micro-dollar. Its weaknesses are not in the router — they are in **governance**: no
published privacy or retention policy, no per-key spend caps, price-blind ranking, an
opaque pricing taxonomy, and a catalogue that is 56% one provider. Every one of those
is a trust problem, and trust problems are the cheapest thing for a small competitor to
beat, because fixing them costs engineering discipline rather than capital. Do not try
to out-integrate them. Out-govern them.

## Scope reality check

The **system** is replicable by one person. The **business** is not:

- 1,600+ integrations is business development, not code
- Real money in and revenue-share payouts is Stripe Connect plus compliance
- Their core pitch ("no per-tool signup") depends on *them* holding the subscriptions

Build the system. Scope the catalogue to 15–40 endpoints you have actually verified.
A router with 30 healthy tools, honest pricing, and hard budget caps is a better product
and a better portfolio piece than a broken clone of 1,608.

## Status

- **Track: PORTFOLIO** (decided 8 Sep 2026) — [07-roadmap.md](07-roadmap.md) Phases 5–8
  are cut for a public repo + demo + case study, not a business. ~13.5 weeks part-time.
- **Competitor gaps re-verified 8 Sep 2026** — all public gaps still open. See
  [10-verification-log.md](10-verification-log.md). Next check due 8 Oct 2026.
- **Phase 0 complete as of 12 Sep 2026** — provider shortlist verified
  ([12-provider-shortlist.md](12-provider-shortlist.md)), pricing schema spiked against 3
  real providers with 3 gaps found and fixed ([13-normalization-spike.md](13-normalization-spike.md)).
- **Nothing implemented yet.** Planning is done; Phase 1 (catalogue + discovery) is next.

Two small items remain before Phase 1, both in [12-provider-shortlist.md](12-provider-shortlist.md):
ElevenLabs' resale terms and Open-Meteo's commercial-tier proxying rights need one more
confirmation step. Neither blocks starting Phase 1 with the 8 already-clear providers.
