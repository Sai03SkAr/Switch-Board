---
name: Catalogue endpoint submission
about: Propose a new provider/endpoint for the catalogue
labels: catalogue
---

**Provider name and base URL**

**Resale/proxying check** — see [CONTRIBUTING.md](../../CONTRIBUTING.md) and
[plan/12-provider-shortlist.md](../../plan/12-provider-shortlist.md) for the standard.

Quote the specific clause in the provider's terms of service that permits reselling or
proxying access to third parties:

> (quote here)

Link to the terms:

**Pricing**

What does this endpoint actually cost, and how did you derive `base_micros` /
`max_possible_micros`? If the provider bills via subscription+quota, show the
amortization math (see `amortizeSubscription()` in
[`packages/core/src/pricing.ts`](../../packages/core/src/pricing.ts)).

**Endpoint details**

- Method + path:
- Real example request and response (not documentation — an actual call you made):
