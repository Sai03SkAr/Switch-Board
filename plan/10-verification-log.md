# 10 — Verification log

Dated evidence for every competitor claim. **Never state a gap in public without a dated
entry here.** This file is the discipline that makes the positioning defensible.

---

## Run 1 — 8 September 2026

Method: direct HTTP status checks, homepage fetch, and full read of the public docs index
(`monid.ai/docs/llms.txt`). All unauthenticated.

### Result: every public gap is still open

| # | Claim | Status | Evidence |
|---|---|---|---|
| 1 | No legal / privacy / terms pages | **CONFIRMED OPEN** | `/terms` **404**, `/privacy` **404**, `/legal` **404**, `/privacy-policy` **404**. Homepage links only `support@monid.ai` and socials |
| 2 | No documented retention policy | **CONFIRMED OPEN** | Word "retention" absent from the entire docs index. `/runs` still stores inputs and outputs |
| 3 | No per-key budget caps | **CONFIRMED OPEN (public surface)** | Key commands remain `keys list/add/activate/remove` — **no budget flag**. The word "budget" does not appear anywhere in the docs |
| 4 | Single workspace balance is the only ceiling | **CONFIRMED OPEN** | Homepage still sells it as a feature: "Your agent has one balance to use all the tools" |
| 5 | No documented rate limits | **CONFIRMED OPEN** | No rate-limit page in the docs index |
| 6 | Spend controls not advertised | **CONFIRMED OPEN** | Homepage markets "$0.0013 per call" and "$1 in free credit" with no mention of caps, limits, or safeguards |
| 7 | Inconsistent catalogue count | **CONFIRMED OPEN, and drifted again** | Homepage now claims **"1700+ tools / 55+ providers"**. In Aug 2026: homepage "1,300+", meta "1,800+", API returned **1,608**. Three weeks, another number |

### Not verifiable without an account

Be scrupulous about these — do **not** claim them publicly on current evidence:

| Claim | Why unverified | How to close it |
|---|---|---|
| Price-blind ranking (the 26× inversion) | Needs an API key to re-run `/discover` | Sign up, spend the $1 free credit, re-run the exact test |
| Per-key caps absent *in the dashboard* | Only the public docs and CLI were checked; an undocumented dashboard control could exist | Sign up and inspect key settings |
| `scoreBreakdown` still undocumented | Needs the authenticated API reference | Sign up and read the reference |

> **Honest framing for #3 and per-key caps:** what is proven is that *the documented
> surface has no budget capability*. If you say more than that in public, say it as
> "as documented, as of 8 Sep 2026" — and go get an account so you can say it flatly.

### What this means for the plan

The "Monid 2.0 closed the budget gap" worry from Phase 0 did **not** materialise on the
public surface. Three weeks after the independent review, nothing observable has changed.
Positioning in [03-positioning.md](03-positioning.md) stands as written.

The strongest, most defensible claim remains **#1 — four 404s on legal pages.** It is
binary, trivially reproducible by anyone including a skeptical reader, and it hard-blocks
EU and enterprise adoption. Lead with it. It costs you one weekend to beat.

### Next verification due

**8 October 2026**, or immediately before any public launch, whichever is sooner.
Re-run the table above and add a Run 2 section. Do not edit Run 1 — append.

## Sources
- Direct HTTP checks against `monid.ai`, 8 Sep 2026
- [monid.ai](https://monid.ai/) homepage, 8 Sep 2026
- [Monid docs index](https://monid.ai/docs/llms.txt), 8 Sep 2026
- Baseline: [Notis review](https://www.notis.ai/blog/monid-review/), 19 Aug 2026

---

## Ready-to-run: the account-gated tests (not yet executed)

Two claims from [02-weaknesses.md](02-weaknesses.md) still need a Monid account to
confirm — creating third-party accounts isn't something Claude does even on request, so
this is queued for whenever it's convenient. Five minutes, their own $1 free credit, no
card required per their docs.

**Test A — price-blind ranking (the 26× inversion):**
1. Sign up at [monid.ai](https://monid.ai/)
2. Call `POST /discover` with a query for a task where you expect multiple candidate
   endpoints at different prices — e.g. `"get current exchange rate"` or
   `"get current weather for a city"`
3. Check the response: does the **cheapest** viable candidate rank **first**? Or does a
   pricier option outrank a cheaper one for the same task?
4. Save the raw JSON response

**Test B — per-key spend caps:**
1. In the dashboard, go to API key management / settings
2. Look for a per-key budget limit, spend cap, or usage ceiling field
3. Note whether one exists, and if so, what it lets you configure
4. Screenshot the key settings page

**When this gets run:** paste the raw `/discover` JSON and the settings screenshot into a
conversation, and both claims in [02-weaknesses.md](02-weaknesses.md) get updated from
"unverified" to a dated, evidenced verdict — same standard as everything else in this log.
