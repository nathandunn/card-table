# Card Table — SPEC v0.2

Status: agreed 2026-08-25.

## Verdict
Iterate, with one substantive rules change.

## Change — real poker hand evaluation
v0.1 used a placeholder: one hole card plus one shared community card, pair
beats high card. This made `focus` and `risk` blur a very crude number, so
trait configuration had less meaning than it should.

v0.2 uses real hand ranking:
- Two hole cards per seat, five community cards (flop / turn / river)
- Full ranking: high card, pair, two pair, trips, straight, flush, full house,
  quads, straight flush
- Hand strength estimation becomes a genuine read, so `focus` meaningfully
  sharpens or blurs it and `risk` meaningfully governs marginal calls

## Add — animated hand
- Cards dealt to each seat
- Chips pushed to pot on bet / call / raise
- Per-seat action indicator (fold greys the seat, raise flashes)
- Community cards revealed street by street
- Showdown: hands revealed, winning hand named and highlighted
- Playback controls: play / pause / step / speed

## Add — sweep upgrades
Same four as the other simulators, adapted to N seats:
1. Sweep any seat, not a fixed one
2. Per-sweep summary: best value, net chip delta, shape of effect
3. Sweep all traits, ranked by impact on that seat's net result
4. Lock to best / worst and continue

## Keep
Six configurable seats, enable/disable per seat, custom names, archetype
presets, per-seat statistics table (net, chips, win rate, VPIP, fold rate,
showdown win rate).

## Audience
Public demo. The stats table is the substance here; animation is for
legibility of individual hands.
