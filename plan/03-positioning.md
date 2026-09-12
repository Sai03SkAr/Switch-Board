# 03 — Positioning: how you actually win

## The strategic call

**Do not compete on catalogue size. Compete on governance.**

Monid's moat is provider relationships — 1,608 endpoints and revenue-share deals you
cannot replicate without capital and a BD team. Attack that and you lose, slowly and
expensively.

Their soft flank is everything *around* the router: no privacy policy, no per-key spend
caps, price-blind ranking, an opaque pricing taxonomy, a catalogue 56% concentrated in
one provider. Those are governance failures. Governance costs **engineering discipline,
not money** — which is precisely the resource a solo builder has and a funded startup
racing on integrations does not spend.

> **Positioning statement**
> Switxh Board is the agent tool router you can put in production. Every call is
> price-ranked before it runs, capped before it spends, and auditable after it lands.
> Bring your own keys, or use ours. Self-host the whole thing if you would rather.

## The counter table

Each row is a verified gap → a concrete build → the sentence you say on the homepage.

| Their gap | Your build | Your line |
|---|---|---|
| No privacy/terms/retention policy | Zero-retention by default; payload storage strictly opt-in; policy live at launch | "We do not store your payloads. You can verify that in the schema." |
| One workspace balance, no per-key caps | 4-level budget hierarchy: workspace → key → session → single call | "A looping agent burns its own budget, not your company's." |
| Price-blind ranking (26× spread, cheap option ranked 3rd) | Explicit price weight in scoring; cheapest-viable always surfaced | "The cheapest endpoint that can do the job is always shown first." |
| 5 pricing models, 2 documented; "$60" TTS ambiguity | One normalized estimator; `inspect` returns cost of *this exact call* | "Every endpoint quotes one number: what this call will cost you." |
| $2–$5.50 endpoints one call away | Tiered confirmation above a configurable threshold | "Nothing over your threshold runs without an explicit approval." |
| Catalogue 56% one provider; count stated 3 ways | Small curated catalogue; live count generated from the API; per-endpoint health | "31 endpoints. All tested this morning. Here are the success rates." |
| Undocumented `scoreBreakdown` | Documented, returned by default, weights user-tunable | "You can see why it chose that. You can change how it chooses." |
| Prepaid balance, no refund path | BYOK mode + self-hostable core + published refund/export | "Your keys and your money can leave whenever you want." |
| Non-deterministic selection | Endpoint pinning, deterministic mode, replayable runs | "Pin it once and the pipeline stops surprising you." |

## The trust strategy (the "psychological" part)

You asked how to make people choose you psychologically. Here is the honest answer:
**the durable lever is verifiable trust, not persuasion technique.** Your buyer is a
developer wiring an autonomous agent to a payment method. Their dominant emotion is not
desire — it is **fear of an unbounded loss they will not notice until the invoice**.
Whoever removes that fear most credibly wins the category.

The six levers, in order of power:

### 1. Loss aversion — kill the stranded-funds fear
A prepaid balance with a startup is a bet on its survival. Neutralise it three ways:
BYOK mode (your keys, we only route and meter), a self-hostable open core, and a
published refund + full-export path. **A user who knows they can leave is far more
willing to arrive.** This one decision defuses the strongest objection to the entire
category.

### 2. Control — make the brakes the headline feature
Budget caps, dry-run cost estimates, a kill switch, and per-run hard limits are usually
buried in settings. Put them on the front page. The message is not "we are cheap", it is
**"you cannot be surprised."** Everyone selling autonomous spend is selling the engine.
Sell the brakes and you own the anxiety.

### 3. Transparency as a product surface, not a claim
On every single call, show three numbers: what the provider charged, what you added, and
what going direct would have cost. Anyone can *claim* fair pricing. Almost nobody
*displays* their own margin. Displaying it converts a claim into a verifiable fact — and
verifiable facts survive contact with a skeptical developer.

### 4. Provenance — explain the choice
Return the score breakdown by default: fit, price, reliability, latency, and why this
endpoint beat the runner-up. An agent that shows its reasoning feels supervised rather
than autonomous, and supervised is what people will actually deploy.

### 5. Calibrated honesty — under-claim on purpose
Competitor says 1,300+/1,800+ and returns 1,608. You say **"31 endpoints, all verified,
here is today's health dashboard."** Publishing a smaller honest number against a larger
inconsistent one reframes the entire comparison from *breadth* to *integrity* — a frame
you win, and one they cannot follow you into without admitting the gap. Never inflate a
number you would not want a reviewer to independently count.

### 6. Open core — trust what you can read
Publish the router, ranker, and ledger under a permissive licence. Developers trust code
they can audit and fork more than any assurance. It also makes the self-host promise real
instead of rhetorical, and it turns your smallness from a liability into the reason you
can be inspected.

### The line you do not cross

Everything above works by **making true things visible**. None of it depends on
manufacturing urgency, fake scarcity, confusing pricing, dark-pattern defaults, or
disparaging a competitor with claims you have not re-verified. Beyond the ethics: your
entire strategic position is "we are the trustworthy one." A single dark pattern
detonates the position you spent months building. **The honesty is not a constraint on
the strategy — it is the strategy.**

Related: attacking their genuine strengths (metering accuracy, zero-charge-on-failure,
the three-verb API) signals you have not used the product. Concede them loudly. It makes
your specific criticisms credible.

## Who you are for

Do not target Monid's whole market. Target the segment their gaps lock out:

1. **Platform builders** reselling agent capability to their own users — they *must* have
   per-user spend caps, and today they build that layer themselves. The existence of
   Monid's "proxy" integration mode proves this demand.
2. **EU/regulated teams** — blocked outright today by the missing retention policy.
3. **Production pipeline owners** — need determinism, pinning, and cost predictability.

Segment 1 is the beachhead: they feel the pain hardest, they are technical enough to
evaluate you on architecture, and they carry their own users onto your platform.

## Naming — settled

**Switxh Board.** Locked 8 Sep 2026. Full decision record, including the pronunciation
trade-off, is in [11-names.md](11-names.md).

Short version: the `x` breaks the `tch` digraph, so the spelling doesn't self-resolve to
"switch" on sight — a reader has to already know the word to land on it. That's a real
cost, and it was weighed and accepted anyway: it buys a name nobody else has, in a space
where plain "Switchboard" collides with a $19.2M-funded logistics company and a
collaboration tool. In writing (README, docs, demo title cards) the spelling carries
itself. In speech, say it once as "Switxh Board — like switch" and it sticks.

Keep naming, copy, and visual identity clearly your own regardless. Monid is a real
funded company with a real trademark position. You are building a competitor, not a
reskin.

## The demo that sells it

One screen recording, ninety seconds, no narration needed:

1. Agent is given a task and a **$0.05 budget**
2. `discover` returns 4 candidates with prices and health scores visible
3. Ranker picks the $0.0009 option; breakdown shows *why* it beat the $0.02376 one
4. Call runs; the receipt shows provider cost, your margin, and the direct-purchase price
5. Agent loops on a retry bug and **hits the cap at $0.05 and stops**
6. Dashboard shows the itemized run, replayable

Step 5 is the whole product. Lead with it.
