# 09 — Risks

Read this before Phase 1. Two items here can end the project outright, and both are
cheap to handle early and expensive to handle late.

> Not legal advice. Where it says *get advice*, get advice from a qualified professional
> in your jurisdiction.

---

## Critical

### R1 — Holding prepaid balances may be a regulated activity

You would take money from users, hold it, and pay providers out of it. Depending on
jurisdiction and structure, that can touch money-transmission, payment-aggregator, or
prepaid-instrument rules. India (RBI PA/PPI guidance), the EU (PSD2/EMI), and US state
money-transmitter laws all have regimes here.

**Mitigations, cheapest first:**
1. **Do not hold money at all in v1.** Ship **BYOK-only**: users bring their own provider
   keys; you route, rank, meter, and cap. You never touch their funds. This removes the
   entire regulatory surface and is *already* your strongest differentiator
   ([03-positioning.md](03-positioning.md) lever 1).
2. If you later add a managed balance, use Stripe as merchant of record and treat credits
   as prepaid access to *your own* service, not stored value.
3. Get advice before accepting the first real deposit.

**Recommendation: build v1 BYOK-only.** It is faster, safer, and better positioned. Add
managed balance in v2 only if users ask.

### R2 — Provider ToS may forbid resale or proxying

Reselling API access is prohibited by many providers' terms. Monid's catalogue leans on
social-media scraping (TikTok, Instagram, Reddit) which sits on contested legal ground
and frequently violates platform terms — and a dependency on a provider who is
themselves in breach is a risk you inherit.

**Mitigations:**
- `providers.resale_allowed` is a **required, human-reviewed field**. If it is false,
  the endpoint cannot be published. Enforce it in the ingestion gate, not by convention.
- BYOK mode largely dissolves this: the user is calling with their own key under their
  own agreement, and you are a client library with a router in it.
- Start with boring, licensed, resale-friendly data. Avoid scraping endpoints entirely
  in v1.
- Keep `tos_url` and `reviewed_at` per provider so the record shows diligence.

---

## High

### R3 — A ledger bug that loses or double-charges money
A single visible mis-charge destroys a brand whose entire position is trustworthiness.

**Mitigations:** the full test list in [05-data-model.md](05-data-model.md); real
Postgres in tests, never mocks; integer micro-dollars only; append-only entries;
daily reconciliation job asserting `sum(entries) = 0` per transaction and that derived
balances match; alert on any variance.

### R4 — Runaway spend during your own development
Ironic and entirely possible: a test loop burns real provider credits.

**Mitigations:** build the budget engine (Phase 3) *before* pointing tests at paid
providers; hard per-day cap on the dev environment; use free tiers in CI; a global kill
switch.

### R5 — Prompt injection through provider responses
You return third-party content straight into an agent's context. A malicious response can
carry instructions the agent may follow.

**Mitigations:** wrap all provider output in a clearly delimited envelope marked as
untrusted data; never let provider content influence routing, budgets, or auth; document
the boundary for integrators. This is a real and current attack class — treat it as a
feature requirement, not a footnote.

### R6 — SSRF and credential leakage in the proxy
You make outbound HTTP to configured URLs with secrets attached.

**Mitigations:** upstream URLs come only from the reviewed catalogue, never from user
input; deny private IP ranges and metadata endpoints; per-provider egress allowlist;
secrets in a vault, never in logs; redact headers in traces.

---

## Medium

### R7 — Monid closes the gaps before you launch
2.0 reportedly added budget controls. Your differentiators may erode.

**Mitigations:** Phase 0 re-verification; compete on the structural things they cannot
easily copy — open core, self-host, BYOK, zero retention. A funded company racing on
integrations will not open-source its router.

### R8 — Catalogue rot
Endpoints break silently; a stale catalogue is worse than a small one.

**Mitigations:** the health prober is Phase 1, not optional; auto-quarantine endpoints
below a success threshold; publish health openly so decay is visible and self-correcting.

### R9 — Nobody wants it
The honest one. The market may be small, or Monid may simply be good enough.

**Mitigations:** talk to five platform builders before Phase 2; treat the beachhead
segment in [03-positioning.md](03-positioning.md) as a hypothesis to test, not a fact.
Even if the business fails, Phases 0–4 are a strong portfolio artifact — a correct
double-entry ledger under concurrency is a credible engineering signal on its own.

### R10 — Scope creep toward catalogue size
The pull to chase 1,608 endpoints will be strong. It is the one fight you cannot win.

**Mitigation:** hard cap at 40 endpoints until Phase 8. Write it down. It is in
[07-roadmap.md](07-roadmap.md) as a sequencing rule for exactly this reason.

---

## Open questions to resolve in Phase 0

- [ ] BYOK-only for v1, or managed balance too? *(Recommendation: BYOK-only — see R1)*
- [ ] Licence: Apache-2.0 (adoption) or AGPL (protection against a hosted clone)?
- [ ] Which 8–12 providers, and does each permit resale in writing?
- [ ] Jurisdiction of incorporation, if this becomes a business at all
- [ ] Is this a business, a portfolio piece, or an academic submission? The answer
      changes Phases 5–8 substantially and should be decided before Phase 1
- [ ] Final name, and is it clear of Monid's trademark position?
