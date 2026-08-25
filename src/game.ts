import { Rng, utilityDecide, type Candidate, type Personality } from "@precog/sim-core";

export const RANKS = ["2","3","4","5","6","7","8","9","10","J","Q","K","A"];
export const SUITS = ["♠","♥","♦","♣"];
export interface Card { r: number; s: number; }
export const cardStr = (c: Card) => `${RANKS[c.r]}${SUITS[c.s]}`;

export type Act = "check" | "bet" | "call" | "raise" | "fold";

export interface Seat {
  id: string; name: string; p: Personality;
  chips: number; hole: Card | null; inHand: boolean; committed: number;
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

/** Hand strength 0..1 — pair with community beats high card; focus adds read accuracy. */
export function strength(hole: Card, community: Card, p: Personality, rng: Rng): number {
  const paired = hole.r === community.r;
  const suited = hole.s === community.s;
  let s = hole.r / 12 * 0.55 + (paired ? 0.4 : 0) + (suited ? 0.05 : 0);
  const blur = (1 - p.traits.focus) * 0.3;
  s += (rng.next() - 0.5) * blur;
  return Math.min(1, Math.max(0, s));
}

export function score(hole: Card, community: Card): number {
  return (hole.r === community.r ? 1000 : 0) + hole.r * 10 + hole.s;
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

export interface HandLog { lines: string[]; }

export function playHand(seats: Seat[], rng: Rng, ante = 2, betSize = 10, log?: HandLog): void {
  const live = seats.filter(x => x.chips > ante);
  if (live.length < 2) return;
  const d = deck(rng);
  let pot = 0;
  for (const x of live) {
    x.inHand = true; x.committed = ante; x.chips -= ante; pot += ante;
    x.hole = d.pop()!; x.stats.hands++;
  }
  const community = d.pop()!;
  log?.lines.push(`community ${cardStr(community)} · ante ${ante} · pot ${pot}`);
  for (const x of live) log?.lines.push(`  ${x.name.padEnd(14)} holds ${cardStr(x.hole!)}`);

  for (let round = 1; round <= 2; round++) {
    let currentBet = 0;
    let raises = 0;
    for (const x of live) {
      if (!x.inHand || x.chips <= 0) continue;
      const contenders = live.filter(y => y.inHand);
      if (contenders.length < 2) break;
      const s = strength(x.hole!, community, x.p, rng);
      const toCall = currentBet - (x.committed - ante);
      const act = utilityDecide(candidates(s, toCall > 0, toCall, x.chips), x.p, rng).action;
      if (act === "fold") { x.inHand = false; x.stats.folds++; }
      else if (act === "call") { const amt = Math.min(toCall, x.chips); x.chips -= amt; x.committed += amt; pot += amt; if (round === 1) x.stats.vpip++; }
      else if (act === "bet" || act === "raise") {
        if (raises >= 3) { const amt = Math.min(toCall, x.chips); x.chips -= amt; x.committed += amt; pot += amt; }
        else { const amt = Math.min(toCall + betSize, x.chips); x.chips -= amt; x.committed += amt; pot += amt; currentBet += betSize; raises++; if (round === 1) x.stats.vpip++; }
      }
      log?.lines.push(`  R${round} ${x.name.padEnd(14)} ${act.padEnd(6)} (strength ${s.toFixed(2)}, pot ${pot})`);
    }
  }

  const contenders = live.filter(x => x.inHand);
  if (contenders.length === 0) return;
  let winner = contenders[0];
  if (contenders.length === 1) {
    log?.lines.push(`${winner.name} takes ${pot} — everyone folded`);
  } else {
    for (const x of contenders) { x.stats.showdowns++; if (score(x.hole!, community) > score(winner.hole!, community)) winner = x; }
    winner.stats.showdownWins++;
    log?.lines.push(`showdown → ${winner.name} wins ${pot} with ${cardStr(winner.hole!)}`);
  }
  winner.chips += pot;
  winner.stats.won++;
  for (const x of live) x.stats.net = x.chips - 200;
}

export function runTable(seats: Seat[], hands: number, seed = 4242, log?: HandLog): void {
  const rng = new Rng(seed);
  for (let i = 0; i < hands; i++) {
    if (seats.filter(x => x.chips > 2).length < 2) break;
    playHand(seats, rng, 2, 10, i === 0 ? log : undefined);
  }
}
