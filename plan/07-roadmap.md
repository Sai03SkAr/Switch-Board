# 07 — Implementation roadmap

Nine phases. Each has a **deliverable**, **acceptance criteria**, and an **estimate** in
part-time weeks (~12–15 focused hours/week). Full-time, divide by roughly three.

**Do not start Phase N+1 until Phase N's acceptance criteria pass.** The ledger phases
in particular punish anyone who moves on early.

> ### 🎯 Track: PORTFOLIO
> Decided 8 Sep 2026. **Phases 0–4 are identical on every track** — they are the product.
> Phases 5–8 below are cut for a portfolio artifact: the deliverable is a public repo, a
> demo, and a written case study, not a business. What changes if you later go commercial
> is noted at the end.

---

## Phase 0 — Verify and spike · 1 week

Before building anything, kill the assumptions that would invalidate the plan.

**Deliverable:** a decision memo, not code.

- [ ] Re-run every item in the verification checklist in [02-weaknesses.md](02-weaknesses.md).
      Record dates. Gaps that Monid 2.0 already closed are not your positioning.
- [ ] Pick **8–12 candidate providers** with generous free tiers and *resale-permitting*
      terms. Read the actual ToS. Record `resale_allowed` per provider.
- [ ] Spike: normalize 3 different providers into one `ToolSpec`. If three cannot be
      unified cleanly, the abstraction is wrong and everything downstream shifts.
- [ ] Confirm the pricing model in [05-data-model.md](05-data-model.md) expresses all
      three spiked providers, including at least one per-unit biller.

**Acceptance:** three providers expressed in one schema, with correct cost estimates for
a specific set of arguments, on paper.

**Do not skip this.** Phase 0 is the cheapest place to discover the plan is wrong.

---

## Phase 1 — Catalogue and discovery · 2 weeks

**Deliverable:** `discover` and `inspect` working over a real, small catalogue.

- Postgres schema for `providers`, `endpoints`, `health_samples`
- Ingestion adapter + normalizer + the human review gate
- Embeddings pipeline; `pgvector` HNSW index; `tsvector` index
- Hybrid retrieval (BM25 ∪ vector), dedupe, top-50
- Ranker with the weighted formula, returning `score_breakdown`
- Cost estimator for all five pricing models
- `POST /v1/discover`, `POST /v1/inspect`

**Acceptance:**
- [ ] 15+ endpoints from 5+ providers, all reviewed and `active`
- [ ] Discovery p95 under 1s
- [ ] **The Monid inversion test passes:** seed two endpoints for the same task at a
      ~25× price spread; the cheaper one ranks first, and `cheapest_viable` marks it
- [ ] `inspect` returns a correct dollar estimate for supplied args on a per-unit biller

---

## Phase 2 — Ledger and execution · 3 weeks

The hard one. Budget the most time here and resist the urge to rush it.

**Deliverable:** money moves correctly.

- `accounts`, `transactions`, `ledger_entries`, `holds` + all constraints
- `reserve` / `capture` / `release`, all idempotent
- The hold reaper worker
- Executor: schema validation → estimate → reserve → upstream → capture/release
- Secret vault for provider keys
- Timeouts, bounded retries, per-provider circuit breaker
- Normalized response envelope **including the `receipt` block**
- `POST /v1/run`, `GET /v1/runs`, `GET /v1/runs/{id}`
- `GET /v1/wallet/balance`, `GET /v1/wallet/activities`

**Acceptance — the full test list in [05-data-model.md](05-data-model.md) passes**, and
specifically:
- [ ] 1,000 concurrent reserves against one balance never over-commit
- [ ] Replayed idempotency key executes once and charges once
- [ ] Upstream 500 leaves the balance changed by exactly 0 micro-dollars
- [ ] Process killed between reserve and capture → reaper restores full balance
- [ ] Every transaction's entries sum to zero

> If any of these fail, stop. Do not proceed to Phase 3 with a ledger you do not trust.

---

## Phase 3 — Policy engine and budgets · 2 weeks

**Your headline differentiator.** ([02-weaknesses.md](02-weaknesses.md) #2)

- `budgets`, `budget_usage`; four scopes; daily/monthly/total windows
- Pre-flight evaluation ordering; `ALLOW` / `DENY` / `NEEDS_CONFIRMATION`
- Confirmation tokens with TTL
- Per-call threshold, defaulted conservatively for new workspaces
- Allow/deny lists per key
- Rate limiting
- `dry_run` on `/v1/run`
- Budget CRUD endpoints; budget block in every run response

**Acceptance:**
- [ ] **The headline demo works as an automated test:** an agent in a retry loop hits a
      $0.05 session cap and stops, with the workspace balance untouched beyond $0.05
- [ ] Each of the four scopes blocks independently and reports which one tripped
- [ ] A $5.50 endpoint returns 409 with a confirmation token, and succeeds on replay
- [ ] `dry_run` returns an accurate estimate and moves no money

---

## Phase 4 — MCP server and CLI · 1 week

**Deliverable:** the thing you can actually show people.

- MCP server (streamable HTTP), exactly three tools
- `budget_status` as an MCP resource
- Confirmation errors rendered as agent-readable text
- CLI covering all commands in [06-api-spec.md](06-api-spec.md)
- One-line install docs for Claude Code and Cursor

**Acceptance:**
- [ ] Claude Code connects and completes a real task end to end
- [ ] The agent visibly *chooses* between candidates and explains why
- [ ] The agent hits a budget cap and reports it in plain language rather than crashing

---

## Phase 5 — Make the engineering legible · 1.5 weeks

On a portfolio track, **your reviewer is an engineer reading GitHub for four minutes.**
Optimise for that, not for end users. This phase is about making quality visible.

- `README.md` that opens with the problem, the demo GIF, and a 60-second quickstart
- `ARCHITECTURE.md` — the reserve/capture/release model, and *why* double-entry
- **CI on every push**, badge in the README, ledger tests running in CI against real
  Postgres via Testcontainers
- `docker compose up` works from a clean clone
- Seeded demo data so a stranger runs a real call in under five minutes
- A `TESTING.md` that explains the concurrency tests and what each one proves

**Acceptance:**
- [ ] Someone who has never seen the repo runs a metered call within 5 minutes
- [ ] CI badge is green and the ledger suite visibly runs in it
- [ ] `ARCHITECTURE.md` explains one non-obvious decision well enough to defend in an interview

**Cut from the business track:** terms/privacy/refund pages, Stripe, a public status page
for real users, BYOK key-management UI. You are not taking anyone's money or data.

## Phase 6 — The demo · 1 week

The single highest-leverage artifact. Most projects die unwatched because there is
nothing to watch.

- The 90-second recording from [03-positioning.md](03-positioning.md), ending on the
  agent hitting the budget cap and stopping
- A GIF of just the cap moment for the README's first screen
- A small dashboard **only if** it makes the video better — CLI output is perfectly
  respectable and faster to build
- Written case study: the problem, the 26× ranking inversion you fix, the ledger design,
  what you would do differently

**Acceptance:**
- [ ] The video is under 100 seconds and needs no narration to be understood
- [ ] The cap moment is visible in the first 15 seconds of the GIF

## Phase 7 — Open source polish · 1 week

On this track the repo *is* the product.

- Licence (Apache-2.0 — favours adoption; AGPL's protection is moot without a business)
- `CONTRIBUTING.md` and a catalogue-submission guide
- Issue templates, a clean commit history, semantic version tags
- Self-host quickstart tested by someone who is not you

**Acceptance:**
- [ ] A stranger follows the README on a clean machine and makes a real call

## Phase 8 — Hardening worth showing · 1 week

Do the hardening that *demonstrates judgment*; skip the hardening that only matters in
production.

**Do:**
- Load-test the ledger under concurrency and **publish the numbers in the README**
- OpenTelemetry traces across the run path (screenshot one in the case study)
- Security pass: key hashing, SSRF guards on upstream URLs, the untrusted-provider-output
  boundary from [09-risks.md](09-risks.md) R5

**Skip on this track:** backup/restore drills, alerting and on-call, multi-region,
error budgets, SOC-2-shaped anything.

**Acceptance:**
- [ ] README states measured throughput and p95 under concurrent load
- [ ] The prompt-injection boundary is documented and tested

---

## Totals — portfolio track

| Track | Part-time weeks |
|---|---|
| Phases 0–4 (working, demoable product) | ~9 |
| Phases 5–8 (legible, open, demonstrated) | ~4.5 |
| **Total** | **~13.5 weeks part-time** (~4–5 weeks full-time) |

Down from ~16 weeks on the business track, because legal, payments, and production ops
all drop out.

**If time is short, the honest minimum is Phases 0–4 plus Phase 6.** A working router
with a correct ledger and a 90-second video that shows an agent hitting a spending cap is
a stronger portfolio piece than a half-finished business.

## What a portfolio reviewer actually rewards

Build toward these, in order:

1. **A correct double-entry ledger under concurrency.** Rare in a personal project and
   an unusually credible signal — most candidates have never handled money safely
2. **Tests that prove it** — the crash-between-reserve-and-capture test is the one to
   point at in an interview
3. **A decision you can defend** — why hybrid retrieval, why reserve-then-capture, why
   integer micro-dollars
4. **Evidence of judgment about scope** — the 40-endpoint cap and the BYOK-only call are
   both good answers to "what did you deliberately not build?"

Notably, all four are things you get from Phases 0–4. The catalogue size, the polish, and
the landing page are worth far less than any of them.

## If this becomes a business later

Re-add from the business track: legal pages and retention policy (Phase 5), Stripe and
managed balances (revisit [09-risks.md](09-risks.md) R1 first — BYOK-only is what keeps
you out of money-transmission scope), a real status page, backups with a tested restore,
alerting. Budget roughly 4 extra weeks, and get advice before accepting a single deposit.

## Sequencing rules

1. Ledger before features. Everything downstream assumes it is correct.
2. `receipt` and `score_breakdown` in the envelope from the start — retrofitting response
   shapes breaks every client.
3. Zero-retention is an architectural decision in Phase 2, not a settings toggle later.
4. Do not expand the catalogue past 40 endpoints. Breadth is their game, not yours.
5. Record the demo before you feel ready. It will expose the gaps worth fixing.
