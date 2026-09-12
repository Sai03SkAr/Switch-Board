# 02 — Weaknesses: where Monid is genuinely soft

Sorted by how exploitable each gap is for a one-person competitor. Each is tagged
**[verified]** (documented or independently tested) or **[inferred]** (reasoning from
architecture, not observed).

> ### ✅ Re-verified 8 September 2026 — all public gaps still open
> Every publicly checkable item below was re-confirmed on 8 Sep 2026: legal pages still
> 404, no budget wording anywhere in the docs, catalogue count drifted again to "1700+".
> Full evidence table in **[10-verification-log.md](10-verification-log.md)**.
> Two items (price-blind ranking, dashboard-level caps) need an account to confirm —
> they are marked as unverified there and must not be claimed publicly yet.

> **Dating matters.** The strongest findings come from a hands-on review dated
> **19 August 2026**. Product Hunt commentary suggests a "Monid 2.0" added some budget
> controls. **Re-verify every item below before you build positioning on it** — see the
> verification checklist at the end. A competitor's fixed bug is not a differentiator.

---

## 1. No published privacy, terms, or retention policy — [verified]

As of 19 Aug 2026, `/terms`, `/privacy`, `/legal`, `/privacy-policy` all returned 404.
Meanwhile the `/runs` API **stores both inputs and outputs** of past runs, with no
statement of retention period or training use.

**Why it is severe:** agent traffic carries customer data. No retention statement means
no GDPR/DPDP defensibility, which means no EU or enterprise customer can legally adopt
it for regulated data. This is not a polish issue — it is a market-access blocker.

**Exploitability: very high.** Costs you a weekend of writing and one architectural
decision (default zero-retention). This is the single best wedge in the document.

## 2. No per-key spend caps; one balance per workspace — [verified]

Key management has no per-key budget limit. `/wallet/balance` returns one number for
the whole workspace. In the reviewer's words: one agent stuck in a retry loop drains it
for everything else.

**Why it is severe:** the entire premise is *autonomous* agents spending money. The
failure mode of autonomy is the loop. Shipping autonomous spend without a per-principal
cap is selling a car with no brakes and pointing at the seatbelt.

**Exploitability: very high.** This is the feature people will switch for. Make budget
enforcement the headline, not a settings-page footnote.

## 3. Price-blind ranking — [verified]

Same task, two endpoints: **$0.02376** and **$0.0009** — a 26× spread. The cheap one was
the *vetted* one, and it ranked **third**, below the expensive option. Price was not a
ranking factor.

**Why it is severe:** it quietly inverts the product's own promise. You adopted a router
to control cost, and the router routes you to the expensive option.

**Exploitability: high.** Price-aware ranking is a scoring-function change plus honest
defaults. Cheap to build, easy to demo, immediately legible in a side-by-side.

## 4. Pricing taxonomy is opaque — [verified]

Five live pricing models, two documented. "$60" shown for a TTS endpoint that actually
bills per *million characters*. High-value endpoints ($2.00–$5.50 phone provisioning)
are one `run` call away from an agent that thinks calls cost a tenth of a cent.

**Exploitability: high.** Fix = normalize every pricing model into one estimator and
return **"estimated cost of this exact call, in dollars"** at `inspect` time. Never make
a user do dimensional analysis to find out what a call costs.

## 5. Catalogue concentration and inflated counts — [verified]

56% one provider; top 10 providers = 82%; headline count stated three different ways
(1,300+ / 1,800+ / 1,608 actual).

**Exploitability: medium-high**, but *only* via the counter-move in
[03-positioning.md](03-positioning.md): do not compete on count. Compete on a published,
live, honest count with per-endpoint health. Their inconsistency makes your accuracy a
visible virtue.

## 6. Undocumented ranking internals — [verified]

`scoreBreakdown` objects exist in responses but are not in the official API reference,
so the ranking is auditable by accident rather than by design.

**Exploitability: medium.** Document yours, return it by default, and let users tune the
weights. "You can see and change why it picked that" is a strong developer trust signal.

## 7. No documented rate limiting — [verified]

Nothing published on request throttling.

**Exploitability: medium.** Mostly matters as a reliability story for platform builders.

## 8. Prepaid balance = stranded-funds risk — [inferred]

A prepaid balance with a company that raised $2.1M is a bet on that company surviving.
There is no published refund path. Nothing observed suggests bad faith — this is
structural risk, not an accusation.

**Exploitability: high, and this is where the psychology lives.** Counter with BYOK
mode, a self-hostable core, and an explicit refund/export policy. See
[03-positioning.md](03-positioning.md).

## 9. Reselling and scraping exposure — [inferred]

Much of the catalogue is social-media scraping (TikTok, Instagram, Reddit). That sits on
contested legal ground and on provider ToS that often forbid resale. A dependency on
providers who may themselves be in breach is a supply-chain risk you inherit.

**Exploitability: medium**, and mostly defensive — it is a reason for *you* to curate a
compliance-clean tier rather than clone their catalogue. See [09-risks.md](09-risks.md).

## 10. Non-determinism in production — [inferred]

Runtime tool selection means the same task can pick a different endpoint, at a different
price, on different days. Fine for exploration; frightening for a production pipeline
with a cost budget and a latency SLO.

**Exploitability: high.** Counter with pinning, "deterministic mode", and replayable
runs. Nobody advertises this yet.

---

## What they do well — do not attack these

Attacking a strength makes you look like you have not used the product.

- **Metering accuracy** — micro-dollar exact, no rounding in their favour
- **Zero charge on failed calls** — correct and honest
- **Three-verb API** — genuinely elegant, and context-efficient
- **Discovery latency** — ~0.9s discovery, 3–5s execution
- **Real provider partnerships** — they partner rather than scrape everything themselves
- **MCP-first distribution** — right call

## Verification checklist — run before writing marketing

Re-check each, record the date, and keep the evidence:

- [ ] Do `/terms` and `/privacy` exist now? Is there a stated retention window?
- [ ] Does key management now expose per-key budget caps? (2.0 may have added this)
- [ ] Does `/discover` factor price into ranking? Re-run the 26× spread test
- [ ] Is `scoreBreakdown` documented in the official reference yet?
- [ ] Is a rate-limit policy published?
- [ ] What does `/endpoints` return as a live count, and what does the homepage claim?
- [ ] Is there a published refund or balance-export path?

**Rule: never claim a competitor gap you have not personally re-verified within 30 days,
and cite the date when you claim it.** That discipline is itself the brand.

## Sources

- [Notis: Monid Review](https://www.notis.ai/blog/monid-review/) — 19 Aug 2026, primary source for all [verified] items
- [Monid docs](https://monid.mintlify.app/) · [monid.ai](https://monid.ai/) · [Product Hunt](https://www.producthunt.com/products/monid)
