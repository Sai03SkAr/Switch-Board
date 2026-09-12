# 11 — Names

## ✅ DECIDED (final): **Switxh Board**

Locked 8 Sep 2026, reverted to **SwitchBoard** the same day, then locked back to
**Switxh Board** — final. This is the project name. What follows is the full reasoning,
including the trade-off knowingly accepted, kept so the decision doesn't need re-litigating.

| Field | Value |
|---|---|
| Display name | **Switxh Board** |
| Repo / package slug | `switxh-board` |
| CLI binary | `sw` |
| Docs usage | Locked across the planning set |

### The trade-off, stated plainly

The `x` replaces the `c` in "switch". That breaks the `tch` digraph — `tch` normally
spells one sound, /tʃ/, as a unit — leaving `t` + `xh` behind, and `xh` isn't a real
English spelling pattern. Read cold, it doesn't resolve to "switch" on its own; a reader
has to already know the intended word to land on it. That's a genuine cost, not a
stylistic quirk, and it was weighed against the alternative before deciding.

**Why it was accepted anyway:** plain "Switchboard" collides with two established
products — a logistics-telematics company with $19.2M raised across 7 rounds, and a
separate remote-collaboration tool. On a portfolio project the collision itself is a
minor cost (nobody confuses an agent tool router with fleet telematics), but the name
still needed to be distinctive enough to search cleanly and to be memorably yours. Between
"same pronunciation, shares a name with two other companies" and "distinctive spelling,
costs one explanation the first time it's said out loud," the second was chosen.

**Mitigate the cost in practice:** say it once, explicitly, the first time it's spoken in
a demo, README, or conversation — "Switxh Board, like switch" — and it never needs
repeating after that. In writing it never comes up at all; the spelling just sits there
and does its job as a distinctive mark.

### The metaphor still holds

A switchboard operator connects a caller to the right line and meters the call — exactly
this architecture: discovery routes the request, the ledger meters it. The respelling
changes how the name is read, not what it means.

---

## Full back-and-forth, for the record

1. **SwitchBoard** proposed as the working name throughout early planning — flagged as
   not collision-checked
2. **Collision check (8 Sep 2026):** plain "Switchboard" is taken twice over — a
   $19.2M-funded logistics/telematics company, and a remote-collaboration product
3. **Switxh Board** adopted to dodge the collision via a distinctive respelling
4. **Reverted to SwitchBoard** the same day, after establishing that `tch` → `txh` breaks
   the digraph and the pronunciation genuinely doesn't hold — "Switxh" reads as
   /swɪt.ks.h/, not /swɪtʃ/, and collapses back to "switch" only because the reader
   already knows what it's supposed to say
5. **Other respellings evaluated** for whether they preserve pronunciation:
   - **Swytch** — phonetically perfect (the Lyft/Tumblr move), but taken twice over:
     [Swytch Bike](https://www.swytchbike.com/about-swytch/) (100k+ riders) and
     [Logitech Swytch](https://www.logitech.com/en-us/products/video-conferencing/room-solutions/swytch.html)
   - **Swich** — drops the redundant `t`; `ch` alone already spells /tʃ/. Reads cleanly.
     No collision found
   - **Swhich** — reads as "s" + "which"; since "wh" is /w/ for most English speakers,
     it resolves to /swɪtʃ/, same as "switch". Visually noisier (readers see "which"
     first). No collision found
6. **Switxh Board locked back in, final** — the collision-dodge was judged worth more
   than the pronunciation cost, made with full knowledge of that cost

---

## Decision record — candidates considered

Collision-checked 8 Sep 2026.

### Cut for real collisions

| Name | Why it was out |
|---|---|
| **Tollgate** | [tollgatepay.com](https://tollgatepay.com/) already gates APIs behind USDC micropayments — the exact adjacent space. Fatal |
| **Patchbay** | [patchbay.cc](https://patchbay.cc/) is a public-API **discovery** platform with 3,100+ APIs — literally half this product. Fatal |
| **Obol** | Obol Studio (AI financial reporting) and Obol Network (Ethereum staking infra), both established in adjacent fintech |
| **Scrip** | Scrip AI exists as a writing assistant. Survivable, but no longer distinctive |
| **Swytch** | Phonetically ideal, but taken twice over (see above) |
| **Switchboard** *(plain)* | Crowded — see above. This is the collision Switxh Board exists to dodge |

### Clean but not chosen

| Name | Angle |
|---|---|
| **Purser** | Ship's officer who holds the money *and* issues the stores. No collision found — the strongest fallback if the Switxh spelling ever becomes a real problem (e.g. this goes commercial and the pronunciation friction shows up in sales calls) |
| **Swich** | Same collision-dodge as Switxh, without the pronunciation cost. The runner-up if the trade-off ever stops feeling worth it |
| **Swhich** | Same dodge, pronunciation holds via "which", but visually noisier |
| **Bursar** | College funds officer. Clean, slightly academic |
| **Quartermaster** | Issues supplies, logs every requisition. Apt; four syllables |
| **Ante** / **Chit** | Prepaid-balance and per-call flavoured, respectively. Both very short |
| **Factor** | Historically a commercial agent transacting on your behalf — precise, but badly overloaded |

> **If Switxh Board's pronunciation friction ever becomes a real problem** — recurring
> confusion in demos, a mispronunciation that sticks the wrong way — the ordered fallback
> is **Swich** (same dodge, no cost) before reaching for **Purser** (different name
> entirely, but zero collision and zero pronunciation issue).

## Before you buy a domain

The name is locked; these are the mechanical checks left:

1. `switxhboard.com` / `switxh.dev` / `switxh.sh` availability
2. npm and PyPI: `switxh-board`, `switxh`
3. GitHub org or username availability
4. A trademark search in your jurisdiction, if this ever becomes a business
5. Grab the matching handle wherever you will post the demo
