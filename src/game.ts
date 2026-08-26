import { Rng, utilityDecide, type Candidate, type Personality } from "@precog/sim-core";
import { runBatch } from "@precog/agent-forge/dist/batch.js";
import { bestHand, bestFive, compareHandValue, CATEGORY_NAME, HandCategory, type HandValue } from "./handEval.js";
export { bestHand, bestFive, compareHandValue, CATEGORY_NAME, type HandValue };

export interface PotShare<T> { item: T; amount: number; hv: HandValue; }

/** Award a pot to the best-hand entries, splitting evenly on ties. Any remainder chip (pot not
 *  divisible by winner count) goes to the earliest winners in entry order, so results stay deterministic. */
export function splitPot<T>(pot: number, entries: { item: T; hv: HandValue }[]): PotShare<T>[] {
  let best = entries[0].hv;
  for (const e of entries) if (compareHandValue(e.hv, best) > 0) best = e.hv;
  const winners = entries.filter(e => compareHandValue(e.hv, best) === 0);
  const share = Math.floor(pot / winners.length);
  let remainder = pot - share * winners.length;
  return winners.map(w => {
    const amount = share + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder--;
    return { item: w.item, amount, hv: w.hv };
  });
}

// ── Side pots ─────────────────────────────────────────────────────
// SPEC v0.3 allowed a simplified single-pot-plus-cap; the FULL layered
// treatment is implemented instead, because it settles in one deterministic
// pass at showdown and fits a single showdown frame (per-winner payouts)
// without touching the rng stream. Every chip in `pot` is paid out by
// construction: the last layer sweeps whatever remains, so no hand can
// create or destroy chips.

export interface PotEntry<T> { item: T; committed: number; hv: HandValue | null; } // hv null = folded (dead money)
export interface PotPayout<T> { item: T; amount: number; contested: boolean; }

/** Layered showdown settlement. Entries are every seat that put chips in this hand
 *  (folded seats included — their chips are dead money in the layers they reach).
 *  A layer contested by one seat only is an uncalled bet flowing back (contested: false). */
export function settlePots<T>(entries: PotEntry<T>[], pot: number): PotPayout<T>[] {
  const contenders = entries.filter(e => e.hv !== null);
  if (contenders.length === 0) return [];
  const levels = [...new Set(contenders.map(e => e.committed))].sort((a, b) => a - b);
  const acc = new Map<T, PotPayout<T>>();
  let prev = 0;
  let remaining = pot;
  for (let li = 0; li < levels.length; li++) {
    const level = levels[li];
    let layer = 0;
    for (const e of entries) layer += Math.max(0, Math.min(e.committed, level) - prev);
    if (li === levels.length - 1) layer = remaining; // sweep the rest: exact conservation
    layer = Math.min(layer, remaining);
    remaining -= layer;
    prev = level;
    if (layer <= 0) continue;
    const eligible = contenders.filter(e => e.committed >= level);
    const contested = eligible.length >= 2;
    for (const sh of splitPot(layer, eligible.map(e => ({ item: e, hv: e.hv! })))) {
      const cur = acc.get(sh.item.item) ?? { item: sh.item.item, amount: 0, contested: false };
      cur.amount += sh.amount;
      cur.contested = cur.contested || contested;
      acc.set(sh.item.item, cur);
    }
  }
  return entries.filter(e => acc.has(e.item)).map(e => acc.get(e.item)!);
}

export const RANKS = ["2","3","4","5","6","7","8","9","10","J","Q","K","A"];
export const SUITS = ["♠","♥","♦","♣"];
export interface Card { r: number; s: number; }
export const cardStr = (c: Card) => `${RANKS[c.r]}${SUITS[c.s]}`;
export const holeStr = (h: [Card, Card]) => `${cardStr(h[0])} ${cardStr(h[1])}`;

/** "allin" never comes out of the decision engine — it is the display form a
 *  bet/call/raise takes when it consumes the seat's whole stack. */
export type Act = "check" | "bet" | "call" | "raise" | "fold" | "allin";

export interface TableConfig { smallBlind: number; bigBlind: number; startChips: number; sitOutHands: number; }
export const TABLE: TableConfig = { smallBlind: 2, bigBlind: 4, startChips: 200, sitOutHands: 2 };

export const STREETS = ["pre-flop", "flop", "turn", "river"] as const;

export interface SeatStats {
  hands: number; won: number; vpip: number; folds: number;
  showdowns: number; showdownWins: number; net: number;
  rebuys: number; bluffs: number; allIns: number;
  /** bets + raises per street: [pre-flop, flop, turn, river] */
  aggr: [number, number, number, number];
}

export interface Seat {
  id: string; name: string; p: Personality;
  chips: number; hole: [Card, Card] | null; inHand: boolean; committed: number;
  /** hands left to sit out after busting; 0 = seated */
  out: number;
  stats: SeatStats;
}

export function newSeat(id: string, name: string, p: Personality, chips = TABLE.startChips): Seat {
  return { id, name, p, chips, hole: null, inHand: true, committed: 0, out: 0,
    stats: { hands: 0, won: 0, vpip: 0, folds: 0, showdowns: 0, showdownWins: 0, net: 0,
      rebuys: 0, bluffs: 0, allIns: 0, aggr: [0, 0, 0, 0] } };
}

function deck(rng: Rng): Card[] {
  const d: Card[] = [];
  for (let r = 0; r < 13; r++) for (let s = 0; s < 4; s++) d.push({ r, s });
  for (let i = d.length - 1; i > 0; i--) { const j = rng.int(i + 1); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}

// ── Hand strength on partial information ─────────────────────────
// Made hands map through a category curve; before the river a live flush or
// straight draw adds hope; pre-flop is a hole-card heuristic. Focus governs
// how accurately a seat reads all of it, exactly as before — one rng draw
// of personality noise per read.

const CAT_BASE = [0.05, 0.28, 0.50, 0.62, 0.72, 0.80, 0.88, 0.94, 0.97];
const CAT_SPAN = [0.20, 0.18, 0.10, 0.08, 0.06, 0.06, 0.05, 0.03, 0.02];

/** Pre-flop read from the two hole cards alone: pairs 0.30–0.55, big cards,
 *  suitedness and connectedness nudging unpaired hands up to ~0.4. */
export function preflopStrength(hole: [Card, Card]): number {
  const hi = Math.max(hole[0].r, hole[1].r), lo = Math.min(hole[0].r, hole[1].r);
  if (hi === lo) return 0.30 + (hi / 12) * 0.25;
  let s = (hi / 12) * 0.20 + (lo / 12) * 0.10;
  if (hole[0].s === hole[1].s) s += 0.05;
  const gap = hi - lo;
  if (gap === 1) s += 0.04; else if (gap === 2) s += 0.02;
  return s;
}

/** Extra hope from a live draw (flop/turn only): four to a flush, four to a straight. */
function drawBonus(cards: Card[], made: HandCategory): number {
  let bonus = 0;
  if (made < HandCategory.Flush) {
    const suits = [0, 0, 0, 0];
    for (const c of cards) suits[c.s]++;
    if (Math.max(...suits) === 4) bonus += 0.10;
  }
  if (made < HandCategory.Straight) {
    const ranks = [...new Set(cards.map(c => c.r))].sort((a, b) => a - b);
    if (ranks.includes(12)) ranks.unshift(-1); // ace also plays low
    for (let i = 0; i + 3 < ranks.length; i++) {
      if (ranks[i + 3] - ranks[i] <= 4) { bonus += 0.06; break; }
    }
  }
  return bonus;
}

/** Hand strength 0..1 on the cards revealed SO FAR (0, 3, 4 or 5 community cards);
 *  focus governs how accurately a seat reads it. */
export function strength(hole: [Card, Card], community: Card[], p: Personality, rng: Rng): number {
  let s: number;
  if (community.length === 0) {
    s = preflopStrength(hole);
  } else {
    const cards = [...hole, ...community];
    const hv = bestHand(cards);
    s = CAT_BASE[hv.category] + CAT_SPAN[hv.category] * ((hv.tiebreakers[0] ?? 0) / 12);
    if (community.length < 5) s += drawBonus(cards, hv.category);
  }
  const blur = (1 - p.traits.focus) * 0.3;
  s += (rng.next() - 0.5) * blur;
  return Math.min(1, Math.max(0, s));
}

function candidates(s: number, toCall: number, pot: number, chips: number, invested: number): Candidate<Act>[] {
  const c: Candidate<Act>[] = [];
  if (toCall > 0) {
    const price = toCall / Math.max(1, pot + toCall);      // pot odds: how expensive is the call
    const pressure = toCall / Math.max(1, chips + toCall); // stack pressure: how much of me it takes
    c.push({ action: "fold", base: 0.42 - s * 1.1 + price * 0.55 + pressure * 0.55, considerations: { caution: 0.8, risk: -0.6, patience: 0.25 } });
    c.push({ action: "call", base: 0.25 + s * 0.75 - price * 0.7 - pressure * 0.3, considerations: { risk: 0.35, caution: 0.25, patience: 0.3 } });
    c.push({ action: "raise", base: -0.42 + s * 1.35 - pressure * 0.5 - invested * 1.6, considerations: { aggression: 0.6, risk: 0.45, caution: -0.45 } });
  } else {
    c.push({ action: "check", base: 0.5 - s * 0.45, considerations: { caution: 0.7, patience: 0.6, aggression: -0.45 } });
    c.push({ action: "bet", base: -0.12 + s * 1.2 - invested * 0.6, considerations: { aggression: 0.6, risk: 0.4, caution: -0.35 } });
  }
  return c;
}

/** How much beyond the call this seat wants to raise: confidence × temperament, up to all-in.
 *  Aggressive/risky seats overbet and jam; cautious seats scrape the minimum. Deterministic
 *  given the (already personality-noised) read, so it costs no rng draws. */
export function raiseSize(s: number, p: Personality, pot: number, chips: number, toCall: number, bigBlind: number): number {
  const t = p.traits;
  const spare = chips - toCall;                              // what is left to raise with
  if (spare <= 0) return 0;                                  // calling is already all-in
  const shove = s * (t.aggression * 0.55 + t.risk * 0.6);
  if (shove >= 0.85) return spare;                           // a monster in hot-blooded hands: jam
  const temper = Math.max(0.15, 0.25 + t.aggression * 0.6 + t.risk * 0.45 - t.caution * 0.45);
  let amt = Math.round(Math.max(bigBlind, (pot + toCall) * (0.2 + s * 0.7) * temper));
  if (amt >= spare * 0.9) return spare;                      // close enough to the stack: jam
  return Math.min(amt, spare);
}

/** A large bet or raise on a weak read IS a bluff — the emergent thing, made countable. */
const BLUFF_READ = 0.35;
export function isBluff(s: number, moved: number, potBefore: number, bigBlind: number): boolean {
  return s < BLUFF_READ && moved >= Math.max(bigBlind * 3, potBefore * 0.75);
}

/** One seat as it stood at the end of a beat. Snapshots are copies, so scrubbing back is free. */
export interface SeatSnapshot {
  name: string; persona: string; chips: number; committed: number;
  inHand: boolean; hole: [Card, Card] | null;
}

export type FrameKind = "deal" | "street" | "action" | "showdown";

/** One meaningful beat of a hand: the deal (blinds posted), a street reveal, a single betting
 *  action, or the showdown. A hand is deterministic given its seed, so the animation replays
 *  this log rather than re-simulating. */
export interface HandFrame {
  kind: FrameKind;
  label: string;            // "deal" | "pre-flop" | "flop" | "turn" | "river" | "showdown" | "everyone folded"
  round: number;            // 0..3 = street index (deal counts as pre-flop), 4 = showdown
  seat: number;             // acting (or headline-winning) seat index into `seats`, -1 if none
  act: Act | null;          // "allin" when the action consumed the stack
  strength: number | null;  // the acting seat's read, as it saw it
  amount: number;           // chips moving on this beat
  potBefore: number;
  potAfter: number;
  reveal: number;           // community cards face-up after this beat (0, 3, 4, 5)
  button: number;           // dealer button seat index, constant across the hand
  seats: SeatSnapshot[];    // the table after this beat
  note: string;             // one line for the HUD
  winners: number[];        // seat indices taking chips from the pot (side-pot refunds included)
  payouts: number[];        // chips each winner takes, parallel to `winners`
  contested: boolean[];     // parallel to `winners`: false = uncalled chips flowing back
  handName: string;         // e.g. "two pair", at showdown
  best: Card[];             // the five cards that won it, for the highlight
}

export interface HandLog { lines: string[]; frames?: HandFrame[]; community?: Card[]; }

export function playHand(seats: Seat[], rng: Rng, button = 0, cfg: TableConfig = TABLE, log?: HandLog): void {
  // ── rebuy tick: busted seats sit out, then buy back in ──
  for (const x of seats) {
    if (x.chips <= 0 && x.out > 0) {
      x.out--;
      if (x.out === 0) { x.chips = cfg.startChips; x.stats.rebuys++; }
    }
  }
  const live = seats.filter(x => x.chips > 0);
  if (live.length < 2) return;
  const n = live.length;
  const btnIdx = ((button % n) + n) % n;
  const order = live.slice(btnIdx).concat(live.slice(0, btnIdx)); // order[0] = button
  const sbSeat = order[n === 2 ? 0 : 1];                          // heads-up: button posts the small blind
  const bbSeat = order[n === 2 ? 1 : 2];

  const d = deck(rng);
  let pot = 0;
  for (const x of live) { x.inHand = true; x.committed = 0; x.hole = [d.pop()!, d.pop()!]; x.stats.hands++; }
  const community = [d.pop()!, d.pop()!, d.pop()!, d.pop()!, d.pop()!];

  // Chips a seat has put in during the CURRENT betting round only (x.committed accumulates
  // for the whole hand and drives the side-pot layers). toCall is measured round-scoped.
  const roundCommitted = new Map<Seat, number>();
  for (const x of live) roundCommitted.set(x, 0);
  const put = (x: Seat, amt: number): number => {
    const a = Math.min(amt, x.chips);
    x.chips -= a; x.committed += a; pot += a;
    roundCommitted.set(x, (roundCommitted.get(x) ?? 0) + a);
    return a;
  };
  const sbPaid = put(sbSeat, cfg.smallBlind);
  const bbPaid = put(bbSeat, cfg.bigBlind);

  log?.lines.push(`button ${order[0].name} · blinds ${cfg.smallBlind}/${cfg.bigBlind} · ${n} seats · pot ${pot}`);
  for (const x of live) log?.lines.push(`  ${x.name.padEnd(14)} holds ${holeStr(x.hole!)} (${x.chips} behind)`);

  // ── frame log ──────────────────────────────────────────────────
  // Purely a recording of what already happened: it reads state, never the rng, so the
  // deterministic stream the sweeps and batch simulations depend on is untouched.
  const frames = log ? (log.frames ??= []) : null;
  if (log) log.community = community;
  const snapshot = (): SeatSnapshot[] => live.map(x => ({
    name: x.name, persona: x.p.id, chips: x.chips, committed: x.committed,
    inHand: x.inHand, hole: x.hole ? [x.hole[0], x.hole[1]] as [Card, Card] : null,
  }));
  const beat = (f: Omit<HandFrame, "seats">) => { frames!.push({ ...f, seats: snapshot() }); };
  const blank = { seat: -1, act: null as Act | null, strength: null as number | null, amount: 0,
    button: live.indexOf(order[0]), winners: [] as number[], payouts: [] as number[],
    contested: [] as boolean[], handName: "", best: [] as Card[] };

  if (frames) {
    beat({ ...blank, kind: "deal", label: "deal", round: 0, amount: sbPaid + bbPaid,
      potBefore: 0, potAfter: pot, reveal: 0,
      note: `${n} dealt in · ${sbSeat.name} posts sb ${sbPaid} · ${bbSeat.name} posts bb ${bbPaid} · pot ${pot}` });
  }

  // ── four betting rounds, each on the cards revealed so far ─────
  const inHand = () => order.filter(y => y.inHand);
  const canAct = () => order.filter(y => y.inHand && y.chips > 0);
  const vpipped = new Set<Seat>();
  let reveal = 0;
  let handOver = false;

  for (let street = 0; street < 4 && !handOver; street++) {
    if (street > 0) {
      const prevReveal = reveal;
      reveal = street + 2; // 3, 4, 5
      log?.lines.push(`${STREETS[street]} — ${community.slice(0, reveal).map(cardStr).join(" ")} · pot ${pot}`);
      if (frames) {
        beat({ ...blank, kind: "street", label: STREETS[street], round: street,
          potBefore: pot, potAfter: pot, reveal,
          note: `${STREETS[street]} — ${community.slice(prevReveal, reveal).map(cardStr).join(" ")}` });
      }
    }

    let currentBet = 0;
    for (const x of live) roundCommitted.set(x, 0);
    if (street === 0) {
      roundCommitted.set(sbSeat, sbPaid);
      roundCommitted.set(bbSeat, bbPaid);
      currentBet = cfg.bigBlind; // even a short all-in blind sets the full price
    }

    const players = canAct();
    // all-in run-out: nobody left who can bet — just keep revealing streets
    if (players.length === 0) continue;
    if (players.length === 1 && currentBet - (roundCommitted.get(players[0]) ?? 0) <= 0) continue;

    const needAct = new Set(players);
    let ptr = street === 0 ? (n === 2 ? 0 : 3 % n) : 1; // pre-flop: after the bb; post-flop: after the button
    let guard = 0;

    while (needAct.size > 0 && guard++ < 2000) {
      const x = order[ptr % n]; ptr++;
      if (!needAct.has(x)) continue;
      needAct.delete(x);
      if (inHand().length < 2) break;
      const rc = roundCommitted.get(x) ?? 0;
      const toCall = Math.min(Math.max(0, currentBet - rc), x.chips);
      // nothing owed and nobody able to respond: betting is moot, skip the beat
      if (toCall === 0 && !order.some(y => y !== x && y.inHand && y.chips > 0)) continue;

      const s = strength(x.hole!, community.slice(0, reveal), x.p, rng);
      const potBefore = pot;
      let act = utilityDecide(candidates(s, toCall, pot, x.chips, x.committed / Math.max(1, x.committed + x.chips)), x.p, rng).action;
      let moved = 0;

      if (act === "fold") { x.inHand = false; x.stats.folds++; }
      else if (act === "check") { /* stand pat */ }
      else if (act === "call") { moved = put(x, toCall); }
      else { // bet or raise, personality-sized, up to all-in
        const extra = raiseSize(s, x.p, pot, x.chips, toCall, cfg.bigBlind);
        if (extra <= 0) { act = "call"; moved = put(x, toCall); }
        else {
          moved = put(x, toCall + extra);
          const level = roundCommitted.get(x)!;
          if (level > currentBet) {
            currentBet = level;
            for (const y of order) if (y !== x && y.inHand && y.chips > 0) needAct.add(y);
          }
          x.stats.aggr[street]++;
          if (isBluff(s, moved, potBefore, cfg.bigBlind)) x.stats.bluffs++;
        }
      }

      const wentAllIn = moved > 0 && x.chips === 0;
      if (wentAllIn) x.stats.allIns++;
      if (street === 0 && moved > 0 && !vpipped.has(x)) { vpipped.add(x); x.stats.vpip++; }

      log?.lines.push(`  ${STREETS[street].padEnd(8)} ${x.name.padEnd(14)} ${act.padEnd(6)}${moved > 0 ? String(moved).padStart(4) : "    "}${wentAllIn ? " ALL-IN" : ""} (read ${s.toFixed(2)}, pot ${pot})`);
      if (frames) {
        const shownAct: Act = wentAllIn && act !== "fold" ? "allin" : act;
        beat({ ...blank, kind: "action", label: STREETS[street], round: street, seat: live.indexOf(x),
          act: shownAct, strength: s, amount: moved, potBefore, potAfter: pot, reveal,
          note: `${x.name} ${shownAct === "allin" ? "goes ALL-IN" : act}${moved > 0 ? ` ${moved}` : ""} · read ${s.toFixed(2)} · pot ${pot}` });
      }
    }
    if (inHand().length < 2) handOver = true;
  }

  // ── award the pot ──────────────────────────────────────────────
  const contenders = live.filter(x => x.inHand);
  if (contenders.length === 1) {
    const winner = contenders[0];
    winner.chips += pot;
    winner.stats.won++;
    log?.lines.push(`${winner.name} takes ${pot} — everyone folded`);
    if (frames) {
      beat({ ...blank, kind: "showdown", label: "everyone folded", round: 4,
        seat: live.indexOf(winner), winners: [live.indexOf(winner)], payouts: [pot], contested: [true],
        amount: pot, potBefore: pot, potAfter: 0, reveal,
        note: `${winner.name} takes ${pot} — everyone folded` });
    }
  } else if (contenders.length > 1) {
    for (const x of contenders) x.stats.showdowns++;
    const hv = new Map(contenders.map(x => [x, bestHand([...x.hole!, ...community])]));
    const payouts = settlePots(live.map(x => ({ item: x, committed: x.committed, hv: hv.get(x) ?? null })), pot);
    for (const po of payouts) {
      po.item.chips += po.amount;
      if (po.contested && po.amount > 0) { po.item.stats.won++; po.item.stats.showdownWins++; }
    }
    let bestSeat = contenders[0];
    for (const x of contenders) if (compareHandValue(hv.get(x)!, hv.get(bestSeat)!) > 0) bestSeat = x;
    const label = CATEGORY_NAME[hv.get(bestSeat)!.category];
    const heroes = payouts.filter(po => po.contested && po.amount > 0);
    log?.lines.push(heroes.length === 1
      ? `showdown → ${heroes[0].item.name} wins ${heroes[0].item === bestSeat ? pot : heroes[0].amount} with ${label} (${holeStr(heroes[0].item.hole!)})`
      : `showdown → ${heroes.map(po => `${po.item.name} ${po.amount}`).join(", ")} — best ${label}`);
    for (const po of payouts) if (!po.contested) log?.lines.push(`  ${po.item.name} takes back ${po.amount} uncalled`);
    if (frames) {
      const paid = payouts.filter(po => po.amount > 0);
      beat({ ...blank, kind: "showdown", label: "showdown", round: 4,
        seat: live.indexOf(bestSeat),
        winners: paid.map(po => live.indexOf(po.item)),
        payouts: paid.map(po => po.amount),
        contested: paid.map(po => po.contested),
        amount: pot, potBefore: pot, potAfter: 0, reveal,
        handName: label, best: bestFive([...bestSeat.hole!, ...community]),
        note: heroes.length === 1
          ? `${heroes[0].item.name} wins with ${label}`
          : `showdown — ${heroes.map(po => po.item.name).join(", ")} split · best ${label}` });
    }
  }

  // busted seats start their sit-out; net = chips minus everything bought in
  for (const x of live) if (x.chips <= 0) x.out = cfg.sitOutHands;
  for (const x of seats) x.stats.net = x.chips - cfg.startChips * (1 + x.stats.rebuys);
}

export function runTable(seats: Seat[], hands: number, seed = 4242, log?: HandLog): void {
  // One table session shares a single RNG stream across all hands (the per-hand seed
  // is unused), and the dealer button advances one seat every hand.
  runBatch<{ rng: Rng; btn: number }>({
    trials: hands,
    seedBase: seed,
    init: () => ({ rng: new Rng(seed), btn: 0 }),
    runTrial: (st, _seed, i) => { playHand(seats, st.rng, st.btn++, TABLE, i === 0 ? log : undefined); },
  });
}
