<title>SwitchBoard — Scope and Business Research</title>

# SwitchBoard — Scope and Business Research

**Researched 12 September 2026.** Two questions: how far can this project be pushed, and
is there a business in it. Everything below is grounded in sources fetched today, not
reasoning from memory — the landscape moved significantly in the last four months and
some of it invalidates assumptions baked into [`plan/`](plan/README.md).

---

## Summary — read this first

Three things are true at once, and they pull in different directions:

1. **What you've built is good and still stands.** Phase 1 works. As a portfolio artifact
   it does its job regardless of anything below.
2. **The original business thesis has been overtaken.** In August 2026 — one month ago —
   AWS shipped, to general availability, the exact differentiation this project was built
   around. Competing on "agent tool router with spending caps" now means competing with
   AWS + Stripe + Coinbase at the infrastructure layer. That is not winnable solo.
3. **A better opening exists, and your architecture transfers into it almost intact.**
   The MCP ecosystem has a genuine, growing, officially-unowned trust problem. The
   official registry explicitly delegates responsibility for it downstream. Your proxy,
   policy engine, health prober, and hard-gate discipline are the right shape for it.

The recommendation is not "throw this away." It's that the *economic* case moved, and if
you ever want this to be more than a portfolio piece, it should follow.

---

# Part 1 — Scope: how far can this go

## What this project actually is, abstracted

Strip the domain language away and SwitchBoard implements four primitives:

| Primitive | Current form |
|---|---|
| **A registry** of callable things with normalized metadata | `endpoints` table + `ToolSpec` |
| **A selection function** over that registry | Hybrid retrieval + weighted ranker |
| **A mediated execution path** with pre-authorization | Executor + reserve/capture (Phase 2) |
| **A policy gate** evaluated before the action | Budget engine (Phase 3) |

Nothing in that list is intrinsically about money, or about paid APIs. That matters more
than it first appears — see the generalization below.

## The scope ladder

Six levels, from what exists to the theoretical maximum. Each is a real step, not a
fantasy extrapolation.

### L0 — Built
Catalogue, hybrid discovery, price-aware ranking, normalized pricing across three models.
17 endpoints, 8 providers, running against live Postgres.

### L1 — The existing roadmap
Ledger (reserve/capture/release), execution proxy, budget hierarchy, MCP server, CLI.
This is [`plan/07-roadmap.md`](plan/07-roadmap.md) Phases 2–4 and needs no rethinking.

### L2 — The generalization: metering isn't about money
**This is the most underrated expansion available.**

`reserve → capture → release` works for *any* consumable resource, not just dollars. The
same ledger that holds $0.05 against a call can hold:

- **Rate budget** — N calls per session, per agent, per tenant
- **Risk budget** — an agent may accumulate only N "risk points" before halting, where
  risky tools cost more points
- **PII exposure budget** — how many records containing personal data an agent may touch
- **Data egress budget** — how much data may leave a trust boundary
- **Capability grants** — a parent agent delegating a bounded capability to a sub-agent

The last one is genuinely underserved. In multi-agent systems an orchestrator spawns
sub-agents, and **hierarchical budget delegation** — parent allocates a sub-budget,
sub-agent cannot exceed it, unspent budget returns to the parent — is exactly a
reserve/capture tree. Almost nobody does this well, and you are three-quarters of the way
to it already. This expands the product's importance without requiring a single new
provider integration.

### L3 — Runtime trust layer for MCP
Rather than routing paid REST APIs, sit between an MCP host and the ~10,000 public MCP
servers as an enforcing gateway. Detailed in Part 3 — this is the recommended direction.

### L4 — Private/internal MCP gateway (enterprise)
The official registry states plainly that it **does not support private servers**, and
recommends organizations "host your own private MCP registry." It publishes an OpenAPI
spec precisely so conforming private registries get host-application support for free.

That is an officially documented, officially unmet need. An enterprise adopting MCP
internally needs a private registry *plus* governance: which teams may call which servers,
cost and risk attribution, audit. No marketplace dynamics, no network effects, no
catalogue race, no payment rails, no regulatory exposure. Each customer is a standalone
deployment.

### L5 — Category maximum: settlement layer for machine-to-machine commerce
The maximal version of the original thesis: the clearing house through which autonomous
agents discover, price, authorize, meter, and settle transactions. Visa-shaped.

**This ceiling is now occupied.** See Part 2. Naming it matters mainly so you can
recognize it is no longer the target.

## Defensible vs not — for a solo builder

The single most important distinction in this document: **the category's ceiling is not
your ceiling.** They are different numbers and conflating them is how solo builders waste
years.

| Defensible solo | Not defensible solo | Why |
|---|---|---|
| Governance, policy, audit depth | Catalogue breadth | Breadth is BD headcount and capital |
| Open source + self-host | Payment rails | Regulatory + capital + now occupied |
| Runtime enforcement correctness | Being the default router | Distribution and network effects |
| Private/internal deployment | Two-sided marketplace | Requires both sides at once |
| Verification discipline as a brand | Provider revenue-share deals | Requires being worth sharing with |

Everything in the left column is won with engineering discipline and time. Everything in
the right column is won with capital, headcount, or existing distribution. **Build only
in the left column.**

---

# Part 2 — What changed underneath this project

All verified today. All of it postdates the planning documents.

## AWS shipped your differentiation, to GA, last month

[Amazon Bedrock AgentCore Payments](https://aws.amazon.com/blogs/machine-learning/amazon-bedrock-agentcore-payments-is-now-generally-available-enabling-agents-to-transact-safely-and-autonomously-at-scale/)
went **generally available around 18 August 2026**, built in partnership with **Coinbase
and Stripe**. What it does:

- Agents "autonomously access and pay for APIs, **MCP servers**, web content, and other agents"
- Wallet authentication → transaction execution → **spending governance** → observability
- "Spending limits are enforced **deterministically at the infrastructure layer**"
- Session-level spending limits, **policy-based spending controls**, and a **full audit trail**
- Every transaction observable through existing AgentCore logs, metrics, and traces

There is a developer article about it titled, without irony,
["The Spending Limit Is the Product."](https://dev.to/aicryptosystems/amazon-bedrock-agentcore-payments-the-spending-limit-is-the-product-obh)

That sentence is, almost word for word, the positioning in
[`plan/03-positioning.md`](plan/03-positioning.md) — "make the brakes the headline
feature." It is now a managed AWS service, GA, integrated with the two largest payment
companies in the space.

**Implication:** the governance-over-agent-payments wedge is closed at the tier that
matters. Not "will close in 12–24 months" — closed, last month.

## The payment rail question is settled

[x402](https://www.crossmint.com/learn/agentic-payments-protocols-compared) (Coinbase):
V2 launched Dec 2025; **Stripe integrated it on Base in Feb 2026**; Cloudflare supports
it. Reported **100M+ payments and ~$24M volume within seven months** of launch. Google's
AP2 has 60+ partners for the authorization layer.

Micropayment rails for agents are no longer a startup-shaped opportunity. They are
infrastructure, owned by Coinbase, Stripe, Google, Cloudflare, and AWS.

## Meanwhile: MCP became the substrate, and it is not safe

The [official MCP Registry](https://modelcontextprotocol.io/registry/about) is live (in
preview), backed by Anthropic, GitHub, Microsoft, and PulseMCP. **~9,652 servers as of
May 2026**; 10,000+ active public servers. Smithery tracked **36,950** by mid-2026.

And the security picture is genuinely alarming — these are published 2026 audit figures:

| Finding | Scale |
|---|---|
| Vulnerable to SSRF | **36.7%** of 7,000+ servers |
| Vulnerable to command injection | **43%** of tested servers |
| File ops prone to path traversal | **82%** across 2,614 implementations |
| Critical vulnerabilities | **33%** of 1,000 scanned |
| Some security finding | **66%** of 1,808 scanned (AgentSeal) |
| Tool poisoning present | **~5.5%** of 1,899 servers (academic study) |
| Systemic flaw disclosed Apr 2026 | est. **200,000 vulnerable instances**, 150M+ package downloads |

OWASP now carries an [MCP Tool Poisoning](https://owasp.org/www-community/attacks/MCP_Tool_Poisoning)
entry. Cloud Security Alliance published research notes on tool poisoning and
auto-execution. Microsoft published a "state of MCP security in 2026" piece.

**Tool poisoning matters architecturally**: the MCP tool *description* field is an
unsanitized attack surface. A malicious server embeds instructions in what looks like help
text, and the agent follows them. This is a runtime attack on the agent's reasoning loop —
a static directory listing cannot stop it. Something in the execution path has to.

## And the registry explicitly refuses to solve it

Direct quotes from the official registry documentation:

> "The MCP Registry is intended to be consumed primarily by **downstream aggregators**."

> "The metadata hosted by the MCP Registry is **deliberately unopinionated**. Downstream
> aggregators can provide **curation** or additional metadata such as community ratings."

> "The MCP Registry **delegates security scanning to**... **Downstream aggregators** [who]
> can implement additional security checks, ratings, or curation."

> "Host applications should consume **other** MCP registries, such as downstream
> marketplaces, via a REST API conforming to the official MCP Registry's OpenAPI spec."

The protocol's own design *invites* a trust and curation layer, publishes a spec for
conforming to it, and disclaims responsibility for building it.

---

# Part 3 — Business analysis

## First, a contradiction in the existing plan

[`plan/09-risks.md`](plan/09-risks.md) R1 recommends **BYOK-only for v1** — users bring
their own provider keys — to eliminate money-transmission exposure. It's the right call
and it's also the strongest trust differentiator.

But **BYOK structurally forecloses per-call margin.** If the user's key pays the provider,
you never touch the transaction and cannot take a cut of it. The planning set recommends
BYOK and describes a routing-fee competitor without reconciling the two.

This was a real problem for the original thesis. It stops being a problem the moment the
product is a governance gateway rather than a payment router — because then per-call
margin was never the model. **The pivot resolves the contradiction rather than deepening
it.** Worth noticing.

## Revenue models, evaluated against *this* project

| Model | Verdict |
|---|---|
| **Per-call markup** (Monid's) | **Dead.** AWS/Stripe/Coinbase own the rail; BYOK forecloses it; money transmission risk; thin margins; both sides want to disintermediate you |
| **Open core** — OSS gateway, paid enterprise features | **Best fit.** No regulatory surface, no capital requirement, developer-led distribution, and the OSS half doubles as the portfolio artifact |
| **Security/risk feed subscription** | **Strong.** Sells into security budgets, which are the least discretionary line item in an enterprise. Recurring by nature |
| **Private registry / internal gateway license** | **Strong.** Officially unmet need (L4), compliance-driven, standalone deployments |
| **Vertical depth** (one domain, curated) | Weak now — the breadth problem it solved is less relevant post-pivot |
| **Consulting / implementation on OSS** | **Realistic first revenue.** This is how most infra OSS actually earns before product revenue exists |

## Open core tiering, concretely

| Tier | Contents | Price shape |
|---|---|---|
| **OSS (free)** | Gateway, policy engine, ranker, ledger, MCP server, CLI, single workspace, self-host | $0 — this is distribution, and the portfolio piece |
| **Team** | Hosted, multi-user, SSO, dashboard, managed risk feed | ~$50–250/mo |
| **Enterprise** | Private registry, audit export, policy-as-code, on-prem, SLA, support | ~$1–5k/mo |

The OSS tier is not a giveaway — for a competitor whose entire position is "you can verify
what we do," publishing the code *is* the position, and it's the one thing a funded
closed-source incumbent structurally cannot copy.

## Who actually pays, in order of reachability

1. **AI platform teams adopting MCP internally** — feel the pain now, technical enough to
   evaluate you on architecture, small budgets but short sales cycles
2. **Security teams at companies adopting agents** — real budget, and the 2026 vulnerability
   numbers do your selling for you
3. **Regulated industries** — largest budgets, longest cycles, need credibility a new
   project lacks initially

Realistic sequence: OSS adoption → (1) → credibility → (2) → eventually (3). Trying to
start at (3) is the classic failure mode.

## Market timing — and this is the part that's genuinely favourable

The payments window **closed**. The trust window is **opening**:

- MCP adoption is compounding (10k public servers, 36k tracked, official registry live)
- Enterprise adoption is the next wave and **cannot proceed without a governance story** —
  no CISO signs off on 10,000 unvetted servers with a 36.7% SSRF rate
- The security problem is getting *worse* as the ecosystem grows, not better
- OWASP, CSA, and Microsoft writing about it means budget lines are being created right now

You are early to the trust layer in a way you are no longer early to the payment layer.

## Competitive map for the trust layer

| Who | Position | Gap you can exploit |
|---|---|---|
| **Smithery** (~36,950 servers) | Largest directory, tiered official/claimed | Directory, not runtime enforcement |
| **Glama** (12,610+) | Quality curation, automated security scans | Scan-time, not call-time; listing not gateway |
| **PulseMCP** (7,600+) | Popularity and trending signals | Signals, not enforcement |
| **Agensi** | Security scans + skills marketplace | Same — scanning as a listing feature |
| **AWS AgentCore** | Payments, spend governance, audit | Payment-centric; not MCP supply-chain safety |

**The pattern:** everyone treats security as a *listing attribute* on a directory. Nobody
occupies the **runtime enforcement point**. A directory tells you a server was risky last
Tuesday. A gateway in the execution path can refuse the poisoned tool description at the
moment of the call, enforce policy per agent, and produce the audit record.

That is a different product shape — and it is exactly the shape SwitchBoard already has
(proxy + policy engine + health prober + hard ingestion gates). The
untrusted-provider-output boundary is already written down as a requirement in
[`plan/09-risks.md`](plan/09-risks.md) R5.

**Do not build another MCP directory.** That race is lost — three players, years of head
start, catalogues 1000× yours. Build the enforcement point instead.

## What transfers if you pivot

Little of the work is wasted, which is why this is worth considering at all:

| Built / planned | Becomes |
|---|---|
| Hybrid discovery + ranker | Discovery over MCP servers, ranked by risk as well as fit |
| `score_breakdown` | Transparent **risk** score with auditable components |
| Health prober | Security prober — continuous re-scanning, quarantine on regression |
| `resale_allowed` hard gate | Security gate — same discipline, different predicate |
| Pricing estimator | Still applies to paid MCP servers and x402-gated resources |
| Ledger reserve/capture | Risk budgets and capability grants (L2), not just dollars |
| Policy engine | The core product — runtime enforcement |
| Verification discipline + dated evidence | Directly saleable as a security posture |

The catalogue seed data is the main casualty, and that was always the cheapest part.

---

# Part 4 — The three viable paths

### Path A — Portfolio, as planned *(current track)*
Finish Phases 2–4, record the demo, publish. The ledger-under-concurrency work is a strong
engineering signal regardless of market conditions.

- **Effort:** ~9 more part-time weeks
- **Probability of achieving its goal:** **high**
- **Ceiling:** a job, credibility, a good GitHub artifact
- **Unaffected by anything in Part 2**

### Path B — Pivot to the MCP trust layer, open source
Reuse the architecture, retarget at MCP supply-chain safety, publish OSS, build in public.

- **Effort:** Phases 2–4 plus ~4–6 weeks retargeting
- **Probability of real users:** **moderate** — the problem is real and acute
- **Probability of revenue:** low-moderate, slow, via consulting then Team tier
- **Ceiling:** a genuine niche infrastructure project; acquisition or funding possible but not likely
- **Best risk-adjusted option if you want this to be more than a portfolio piece**

### Path C — Compete with Monid as originally planned
Paid API routing with a wallet and spending caps.

- **Probability of commercial success:** **very low.** You would be competing with AWS
  (GA, one month ago), Stripe, and Coinbase on their core competency, with no capital,
  no BD, and a regulatory problem they've already solved
- **Not recommended as a business.** Still perfectly fine as a portfolio exercise, which is
  what Path A already is

---

# Part 5 — Decision framework

## The decision is still free to defer

Phases 2–4 — ledger, executor, policy engine, MCP server — are **identical on all three
paths**. Nothing about the next ~9 weeks of work changes based on this decision. Build
them, then decide. Holding an option costs nothing here; that is unusual and worth using.

The fork is at **Phase 5**, exactly where [`plan/07-roadmap.md`](plan/07-roadmap.md)
already places it.

## Signals that would justify switching to Path B

Don't switch on theory. Switch on evidence:

- A stranger opens an issue or PR because they're actually using it
- Anyone asks about private/internal deployment
- Anyone asks whether you can vet or gate MCP servers for them
- An MCP security incident makes the problem acute for a company you can reach
- You get inbound from a security or platform team

Any two of those and Path B is worth committing to. None of them within a few months of
publishing, and Path A was the right call all along.

## Honest probability assessment

For a solo student builder, from where you stand today:

| Outcome | Probability | Notes |
|---|---|---|
| Strong portfolio artifact | **Very high** | Already substantially achieved |
| OSS project with real external users | **Moderate** | Requires publishing and some promotion |
| First revenue (consulting/implementation) | **Low-moderate** | Requires Path B plus visible traction |
| Sustained MRR | **Low** | 12–24 months of consistent work minimum |
| Venture-scale outcome | **Very low** | Not a reason to avoid trying; a reason not to plan around it |

This is not discouragement. The expected value here is dominated by the top two rows, and
both are well within reach. Plan for those; treat the rest as upside.

## If it ever does become a business

- **Entity/payments from India:** Stripe Atlas or a similar US entity for global SaaS
  collection; Razorpay domestically. Holding customer balances triggers RBI PA/PPI scrutiny
  — the BYOK-only decision in [`plan/09-risks.md`](plan/09-risks.md) R1 avoids this entirely
  and should be preserved through any pivot
- **Funding:** the path runs through OSS traction, not a deck. Monid raised $2.1M with a
  working product. Accelerators (YC, Antler) are plausible *after* adoption exists
- **Cost structure:** running lean from India is a genuine multi-year advantage; the $20–45/mo
  infrastructure figure in [`plan/08-requirements.md`](plan/08-requirements.md) holds

---

# Recommendation

**Continue Path A now. Keep Path B open. Drop Path C as a business.**

Concretely:

1. **Build Phases 2–4 as planned.** Track-agnostic, and the ledger is the strongest
   engineering signal in the whole project.
2. **When you reach Phase 5, re-read Part 2 of this document** and check whether the
   switching signals appeared.
3. **Preserve two decisions through any pivot:** BYOK-only (kills regulatory exposure) and
   the hard-gate ingestion discipline (it's the brand, and it transfers directly to
   security gating).
4. **Update [`plan/02-weaknesses.md`](plan/02-weaknesses.md) and
   [`plan/03-positioning.md`](plan/03-positioning.md)** — they currently position against
   gaps that AWS closed in August. Positioning built on a stale competitive read is worse
   than no positioning.
5. **Do not build another MCP directory.** If you pivot, build the runtime enforcement
   point. The directory race is lost; the gateway is open.

The uncomfortable finding is that a well-reasoned plan can be overtaken by a hyperscaler
in a single month, and this one was. The useful finding is that the same architecture,
pointed 30 degrees left, lands in a problem that is growing rather than closing — and that
the protocol's own maintainers have explicitly declined to solve.

---

## Sources

All fetched 12 Sep 2026.

**Agent payments / AWS:**
[AgentCore Payments GA](https://aws.amazon.com/blogs/machine-learning/amazon-bedrock-agentcore-payments-is-now-generally-available-enabling-agents-to-transact-safely-and-autonomously-at-scale/) ·
[AgentCore Payments preview announcement](https://aws.amazon.com/about-aws/whats-new/2026/04/amazon-bedrock-agentcore-payments-preview/) ·
[Coinbase on AgentCore Payments](https://www.coinbase.com/blog/introducing-amazon-bedrock-agentcore-payments-powered-by-x402-and-coinbase) ·
["The Spending Limit Is the Product"](https://dev.to/aicryptosystems/amazon-bedrock-agentcore-payments-the-spending-limit-is-the-product-obh) ·
[Agentic payment protocols compared](https://www.crossmint.com/learn/agentic-payments-protocols-compared) ·
[x402 in financial services (AWS)](https://aws.amazon.com/blogs/industries/x402-and-agentic-commerce-redefining-autonomous-payments-in-financial-services/)

**MCP registry / ecosystem:**
[Official MCP Registry](https://modelcontextprotocol.io/registry/about) ·
[State of MCP registries](https://safedep.io/the-state-of-mcp-registries/) ·
[MCP adoption statistics 2026](https://www.digitalapplied.com/blog/mcp-adoption-statistics-2026-model-context-protocol) ·
[Best MCP registries compared](https://www.truefoundry.com/blog/best-mcp-registries) ·
[Smithery vs Glama vs Agensi](https://www.agensi.io/learn/smithery-vs-glama-vs-agensi-comparison)

**MCP security:**
[OWASP MCP Tool Poisoning](https://owasp.org/www-community/attacks/MCP_Tool_Poisoning) ·
[MCP security statistics 2026](https://www.practical-devsecops.com/mcp-security-statistics-2026-report/) ·
[CSA: tool poisoning and auto-execution](https://labs.cloudsecurityalliance.org/research/csa-research-note-mcp-tool-poisoning-auto-execution-20260701/) ·
[CSA: MCP security crisis](https://labs.cloudsecurityalliance.org/research/csa-research-note-mcp-security-crisis-20260504-csa-styled/) ·
[Microsoft: state of MCP security 2026](https://techcommunity.microsoft.com/blog/microsoft-security-blog/the-state-of-mcp-security-in-2026/4531327) ·
[Invariant Labs: tool poisoning](https://invariantlabs.ai/blog/mcp-security-notification-tool-poisoning-attacks)
