# Card Table

A card betting simulator where every seat is an AI personality. Unlike the two-sided
games in [battle-bots](https://github.com/nathandunn/battle-bots) and
[pack-hunt](https://github.com/nathandunn/pack-hunt), this is an **N-player table** —
2 to 6 seats, each with its own agent and trait profile, competing for one pot.

**The game** — simplified stud. Each player antes, gets one hole card plus a shared
community card, then two betting rounds: check / bet / call / raise / fold. Best
hand at showdown takes the pot.

**Where personality bites**
- **aggression** drives bet and raise frequency
- **caution** drives folding weak hands
- **risk** drives calling with marginal holdings and bluffing
- **patience** waits for premium cards instead of playing every hand
- **focus** sharpens hand-strength reads; low focus misjudges holdings
- **randomness** is softmax temperature via sim-core's `utilityDecide` — high values bluff unpredictably

**Statistics output** — per-seat chips won/lost, hands won, VPIP (voluntarily put
money in pot), fold rate, and showdown win rate over N hands.

Built on [`@precog/sim-core`](https://github.com/nathandunn/sim-core).

Live: https://cards.apps.precogsoftwareservices.com

```bash
npm install && npm run build
```
