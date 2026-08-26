import { Rng, utilityDecide, type Candidate, type Personality } from "@precog/sim-core";
import { bestHand, bestFive, compareHandValue, CATEGORY_NAME, type HandValue } from "./handEval.js";
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

export const RANKS = ["2","3","4","5","6","7","8","9","10","J","Q","K","A"];
export const SUITS = ["♠","♥","♦","♣"];
export interface Card { r: number; s: number; }
export const cardStr = (c: Card) => `${RANKS[c.r]}${SUITS[c.s]}`;
export const holeStr = (h: [Card, Card]) => `${cardStr(h[0])} ${cardStr(h[1])}`;

export type Act = "check" | "bet" | "call" | "raise" | "fold";

export interface Seat {
  id: string; name: string; p: Personality;
  chips: number; hole: [Card, Card] | null; inHand: boolean; committed: number;
  stats: { hands: number; won: number; vpip: number; folds: number; showdowns: number; showdownWins: number; net: number };
}

export function newSeat(id: string, name: string, p: Personality, chips = 200): Seat {
  return { id, name, p, chips, hole: null, inHand: true, committed: 0,
    stats: { hands: 0, won: 0, vpip: 0, folds: 0, showdowns: 0, showdownWins: 0, net: 0 } };
}

function deck(rng: Rng): Card[] {
  const d: Card[] = [];
  for (let r = 0; r < 13; r++) for (let s = 0; s < 4; s++) d.push({ r, s });
  for (let i = d.length - 1; i > 0; i--) { const j = rng.int(i + 1); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}

/** Hand strength 0..1 from the real best-5-of-7 evaluation; focus governs how accurately a seat reads it. */
export function strength(hole: [Card, Card], community: Card[], p: Personality, rng: Rng): number {
  const hv = bestHand([...hole, ...community]);
  let s = (hv.category + (hv.tiebreakers[0] ?? 0) / 13) / 9;
  const blur = (1 - p.traits.focus) * 0.3;
  s += (rng.next() - 0.5) * blur;
  return Math.min(1, Math.max(0, s));
}

function candidates(s: number, facingBet: boolean, toCall: number, chips: number): Candidate<Act>[] {
  const c: Candidate<Act>[] = [];
  const pot_odds = toCall > 0 ? Math.min(1, toCall / Math.max(1, chips)) : 0;
  if (facingBet) {
    c.push({ action: "fold", base: 0.55 - s * 0.9 + pot_odds * 0.4, considerations: { caution: 0.9, risk: -0.7, patience: 0.3 } });
    c.push({ action: "call", base: 0.15 + s * 0.7, considerations: { risk: 0.5, caution: 0.2, patience: 0.3 } });
    c.push({ action: "raise", base: -0.25 + s * 1.1, considerations: { aggression: 1.1, risk: 0.7, caution: -0.4 } });
  } else {
    c.push({ action: "check", base: 0.5 - s * 0.5, considerations: { caution: 0.7, patience: 0.6, aggression: -0.5 } });
    c.push({ action: "bet", base: 0.05 + s * 0.9, considerations: { aggression: 1.2, risk: 0.6, caution: -0.3 } });
  }
  return c;
}

/** One seat as it stood at the end of a beat. Snapshots are copies, so scrubbing back is free. */
export interface SeatSnapshot {
  name: string; persona: string; chips: number; committed: number;
  inHand: boolean; hole: [Card, Card] | null;
}

export type FrameKind = "deal" | "street" | "action" | "showdown";

/** One meaningful beat of a hand: the deal, a street reveal, a single betting action, or the showdown.
 *  A hand is deterministic given its seed, so the animation replays this log rather than re-simulating. */
export interface HandFrame {
  kind: FrameKind;
  label: string;            // "deal" | "flop" | "turn" | "river" | "round 1" | "round 2" | "showdown"
  round: number;            // 0 before betting, 1 or 2 for a betting round, 3 at showdown
  seat: number;             // acting (or winning) seat index into `seats`, -1 if none
  act: Act | null;
  strength: number | null;  // the acting seat's read, as it saw it
  amount: number;           // chips moving on this beat
  potBefore: number;
  potAfter: number;
  reveal: number;           // community cards face-up after this beat
  seats: SeatSnapshot[];    // the table after this beat
  note: string;             // one line for the HUD
  winners: number[];        // seat indices taking a share of the pot
  handName: string;         // e.g. "two pair", at showdown
  best: Card[];             // the five cards that won it, for the highlight
}

export interface HandLog { lines: string[]; frames?: HandFrame[]; community?: Card[]; }

export function playHand(seats: Seat[], rng: Rng, ante = 2, betSize = 10, log?: HandLog): void {
  const live = seats.filter(x => x.chips > ante);
  if (live.length < 2) return;
  const d = deck(rng);
  let pot = 0;
  for (const x of live) {
    x.inHand = true; x.committed = ante; x.chips -= ante; pot += ante;
    x.hole = [d.pop()!, d.pop()!]; x.stats.hands++;
  }
  const community = [d.pop()!, d.pop()!, d.pop()!, d.pop()!, d.pop()!];
  log?.lines.push(`community ${community.map(cardStr).join(" ")} · ante ${ante} · pot ${pot}`);
  for (const x of live) log?.lines.push(`  ${x.name.padEnd(14)} holds ${holeStr(x.hole!)}`);

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
    winners: [] as number[], handName: "", best: [] as Card[] };

  if (frames) {
    beat({ ...blank, kind: "deal", label: "deal", round: 0, amount: ante * live.length,
      potBefore: 0, potAfter: pot, reveal: 0,
      note: `${live.length} seats dealt in · ante ${ante} each · pot ${pot}` });
    // Both betting rounds are read against the full board, so the board is laid out first,
    // one street at a time, and the betting follows.
    for (const [label, reveal] of [["flop", 3], ["turn", 4], ["river", 5]] as const) {
      beat({ ...blank, kind: "street", label, round: 0, potBefore: pot, potAfter: pot, reveal,
        note: `${label} — ${community.slice(reveal === 3 ? 0 : reveal - 1, reveal).map(cardStr).join(" ")}` });
    }
  }

  for (let round = 1; round <= 2; round++) {
    let currentBet = 0;
    let raises = 0;
    for (const x of live) {
      if (!x.inHand || x.chips <= 0) continue;
      const contenders = live.filter(y => y.inHand);
      if (contenders.length < 2) break;
      const s = strength(x.hole!, community, x.p, rng);
      const potBefore = pot;
      const toCall = currentBet - (x.committed - ante);
      const act = utilityDecide(candidates(s, toCall > 0, toCall, x.chips), x.p, rng).action;
      if (act === "fold") { x.inHand = false; x.stats.folds++; }
      else if (act === "call") { const amt = Math.min(toCall, x.chips); x.chips -= amt; x.committed += amt; pot += amt; if (round === 1) x.stats.vpip++; }
      else if (act === "bet" || act === "raise") {
        if (raises >= 3) { const amt = Math.min(toCall, x.chips); x.chips -= amt; x.committed += amt; pot += amt; }
        else { const amt = Math.min(toCall + betSize, x.chips); x.chips -= amt; x.committed += amt; pot += amt; currentBet += betSize; raises++; if (round === 1) x.stats.vpip++; }
      }
      log?.lines.push(`  R${round} ${x.name.padEnd(14)} ${act.padEnd(6)} (strength ${s.toFixed(2)}, pot ${pot})`);
      if (frames) {
        const moved = pot - potBefore;
        beat({ ...blank, kind: "action", label: `round ${round}`, round, seat: live.indexOf(x),
          act, strength: s, amount: moved, potBefore, potAfter: pot, reveal: 5,
          note: `${x.name} ${act}${moved > 0 ? ` ${moved}` : ""} · read ${s.toFixed(2)} · pot ${pot}` });
      }
    }
  }

  const contenders = live.filter(x => x.inHand);
  if (contenders.length === 0) return;
  if (contenders.length === 1) {
    const winner = contenders[0];
    winner.chips += pot;
    winner.stats.won++;
    log?.lines.push(`${winner.name} takes ${pot} — everyone folded`);
    if (frames) {
      beat({ ...blank, kind: "showdown", label: "everyone folded", round: 3,
        seat: live.indexOf(winner), winners: [live.indexOf(winner)], amount: pot,
        potBefore: pot, potAfter: 0, reveal: 5,
        note: `${winner.name} takes ${pot} — everyone folded` });
    }
  } else {
    for (const x of contenders) x.stats.showdowns++;
    const entries = contenders.map(x => ({ item: x, hv: bestHand([...x.hole!, ...community]) }));
    const shares = splitPot(pot, entries);
    for (const sh of shares) { sh.item.chips += sh.amount; sh.item.stats.won++; sh.item.stats.showdownWins++; }
    const label = CATEGORY_NAME[shares[0].hv.category];
    if (shares.length === 1) {
      log?.lines.push(`showdown → ${shares[0].item.name} wins ${pot} with ${label} (${holeStr(shares[0].item.hole!)})`);
    } else {
      log?.lines.push(`showdown → split ${pot} between ${shares.map(sh => sh.item.name).join(", ")} — ${label}`);
    }
    if (frames) {
      const names = shares.map(sh => sh.item.name).join(", ");
      beat({ ...blank, kind: "showdown", label: "showdown", round: 3,
        seat: live.indexOf(shares[0].item), winners: shares.map(sh => live.indexOf(sh.item)),
        amount: pot, potBefore: pot, potAfter: 0, reveal: 5,
        handName: label, best: bestFive([...shares[0].item.hole!, ...community]),
        note: shares.length === 1
          ? `${names} wins ${pot} with ${label}`
          : `split ${pot} — ${names}, ${label}` });
    }
  }
  for (const x of live) x.stats.net = x.chips - 200;
}

export function runTable(seats: Seat[], hands: number, seed = 4242, log?: HandLog): void {
  const rng = new Rng(seed);
  for (let i = 0; i < hands; i++) {
    if (seats.filter(x => x.chips > 2).length < 2) break;
    playHand(seats, rng, 2, 10, i === 0 ? log : undefined);
  }
}
