# 01 — Teardown: what Monid actually is

Everything here is from Monid's own site, its public docs (`monid.ai/docs/llms.txt`),
and an independent hands-on review. Where a fact is inferred rather than documented, it
says so.

## One sentence

A router that lets an AI agent find a paid API at runtime, call it, and pay per call
from a single prepaid balance — instead of you signing up for, subscribing to, and
hardcoding each provider.

## The core abstraction: three verbs

This is the design insight worth stealing outright. It is very good.

| Verb | Meaning |
|------|---------|
| `discover` | Natural-language search over the catalogue → ranked candidate endpoints |
| `inspect` | Full schema, parameters, and pricing for one endpoint |
| `run` | Execute it, meter it, return normalized results |

Why it matters: it costs **three tool slots** in the agent's context window, and those
three slots expose an unbounded catalogue. Compare with registering 200 MCP tools
directly, which bloats the prompt and degrades selection accuracy. This is the single
most important architectural idea in the product, and it is not proprietary.

## Documented API surface

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/auth/whoami` | GET | Identity behind current API key or OAuth token |
| `/auth/workspaces` | GET | Workspaces the token can access |
| `/discover` | POST | Natural-language endpoint search |
| `/inspect` | POST | Full detail for one endpoint |
| `/run` | POST | Execute an endpoint |
| `/runs` | GET | List historical runs for a workspace |
| `/runs/{id}` | GET | Status and results of one run |
| `/runs/{id}/stop` | POST | Stop a running run |
| `/wallet/balance` | GET | Current balance |
| `/wallet/activities` | GET | Wallet transaction list |

CLI mirrors it: `discover`, `inspect`, `run`, `runs list/get/stop`,
`keys list/add/activate/remove`.

## Integration modes

1. **Direct** — server-to-server, single master API key
2. **OAuth 2.0** — end users own their own accounts and balances
3. **Proxy** — self-hosted control layer in front of Monid
4. **MCP** — remote streamable-HTTP server (Claude, Codex, OpenCode)
5. **Skill** — one-line install for Claude Code, Cursor, etc.

The proxy mode is a tell: it exists because platform builders needed to add controls
Monid does not provide. See [02-weaknesses.md](02-weaknesses.md).

## Money model

- Prepaid workspace balance, pay-per-successful-call
- Headline routing fee around **$0.0013/call**, plus the underlying tool price
- **Failed calls are charged zero** — independently verified
- Metering verified accurate to six decimal places ($0.024660 debit matched two calls)
- `x402` protocol supported for crypto/USDC payment as an alternative rail
- Providers list tools and take a revenue share

Credit where due: **the metering is genuinely excellent.** An independent reviewer found
no rounding that favoured the platform. Match this bar or do not ship.

## Catalogue composition (the part the marketing hides)

Independently measured, August 2026:

- API returned **1,608** endpoints (homepage said "1,300+", meta description "1,800+")
- **56%** of all endpoints came from a single provider, TikHub
- Top 5 providers = **76%** of the catalogue; top 10 = **82%**
- Heavy concentration in Chinese short-video platforms and DeFi/on-chain analytics

So the real catalogue is far narrower than the headline. If a user's work does not touch
those two domains, most of the number is decoration. This is the crack in the moat.

## Five pricing models, two documented

The live system uses `PER_CALL`, `PER_RESULT`, `PER_UNIT_MATRIX`, `TIERED`, and
`PER_UNIT`. The docs describe two. A text-to-speech endpoint displays "$60" without
stating it means per *million characters*. Phone-provisioning endpoints at $2.00–$5.50
sit behind the same one-shot `run` call as a $0.0009 lookup.

## What to steal, what to reject

**Steal:** the three-verb surface; three-tool-slot context efficiency; zero-charge on
failure; micro-dollar precision; MCP-first distribution; `scoreBreakdown` in discovery
responses.

**Reject:** breadth-as-marketing; price-blind ranking; a single undifferentiated
balance; undocumented pricing taxonomy; shipping without legal pages.

## Sources

- [monid.ai](https://monid.ai/)
- [Monid docs](https://monid.mintlify.app/) and `monid.ai/docs/llms.txt`
- [Notis: Monid Review, tested on real work](https://www.notis.ai/blog/monid-review/) — 19 Aug 2026
- [Dealroom: Monid raises $2.1M](https://dealroom.co/news/148133-monid-raises-2-1m-to-let-ai-agents-buy-tools-on-demand/)
- [Product Hunt](https://www.producthunt.com/products/monid)
