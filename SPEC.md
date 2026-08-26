# Card Table — SPEC v0.3

Status: agreed 2026-08-26, from a feedback session. Supersedes v0.2.
Cross-cutting requirements (league, legibility, lab, style):
see `hub-orchestrator/specs/2026-08-26-suite-v0.3.md`.

## Verdict
**Iterate, deeply.** Hand evaluation is real now, but the betting doesn't
feel like poker. Three structural changes fix that.

## 1. Real street betting

Today all five community cards are dealt up front and two betting rounds run
against the full board — the replay reveals streets, but the betting ignores
them. Replace with real Hold'em rhythm: **four betting rounds** — pre-flop,
flop, turn, river — each bet **only on the cards revealed so far.**

Consequence for the AI: `strength()` must evaluate partial hands (2 cards,
then 5/6/7 visible) so a seat's confidence genuinely grows or collapses
street by street. This feeds the live thinking readout directly — you watch
a seat's read swing on the turn card.

## 2. Blinds + rebuy

Replace the every-seat ante with **rotating small/big blinds** (fold-forever
is no longer free). **Busted seats rebuy** after sitting out a hand or two,
so the table never dies — required for an endless league.

## 3. Personality-scaled betting, up to all-in

Fixed bet 10 / max 3 raises goes away. Bet size scales with hand confidence
AND personality — aggressive/risky seats overbet and shove, cautious seats
min-bet — up to **true all-in**. Stack pressure becomes visible personality,
and all-in showdowns become the league's marquee moments.

**Bluffing is emergent, and should be made explicit in tuning:** a
high-risk / high-aggression seat sizing up on a weak read IS a bluff; the
post-match story card should call it out ("Ripper bluffed 4 pots, got
caught once").

## Keep from v0.2
- Real Texas Hold'em hand evaluation (`handEval.ts`) — unchanged.
- The animated hand replay — extended to the four-street rhythm (bet
  frames between reveals instead of after the full board).
- Per-seat stats; add per-street aggression and bluff counts.
- Sweep/evolve/simulate (now in the Lab section).
- N-seat support (2–6) in the Lab; the league/tank picks its own table size.

## Out of scope
- Side pots done fully correctly for multi-way all-ins may be simplified
  (single main pot + capped winnings) if the full treatment fights the
  deterministic frame log — flag the choice in the implementation.
- Tournament structures beyond the suite league.
- Human seats.
