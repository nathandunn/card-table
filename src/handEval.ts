import type { Card } from "./game.js";

/** Hand categories, low to high. */
export enum HandCategory {
  HighCard = 0,
  Pair = 1,
  TwoPair = 2,
  Trips = 3,
  Straight = 4,
  Flush = 5,
  FullHouse = 6,
  Quads = 7,
  StraightFlush = 8,
}

export const CATEGORY_NAME: Record<HandCategory, string> = {
  [HandCategory.HighCard]: "high card",
  [HandCategory.Pair]: "pair",
  [HandCategory.TwoPair]: "two pair",
  [HandCategory.Trips]: "three of a kind",
  [HandCategory.Straight]: "straight",
  [HandCategory.Flush]: "flush",
  [HandCategory.FullHouse]: "full house",
  [HandCategory.Quads]: "four of a kind",
  [HandCategory.StraightFlush]: "straight flush",
};

/** A ranked 5-card hand: category plus tiebreak ranks in descending significance. */
export interface HandValue { category: HandCategory; tiebreakers: number[]; }

/** -1 if a < b, 0 if equal (tie/split), 1 if a > b. */
export function compareHandValue(a: HandValue, b: HandValue): number {
  if (a.category !== b.category) return a.category > b.category ? 1 : -1;
  const n = Math.max(a.tiebreakers.length, b.tiebreakers.length);
  for (let i = 0; i < n; i++) {
    const x = a.tiebreakers[i] ?? -1;
    const y = b.tiebreakers[i] ?? -1;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** High card of a straight given 5 distinct ascending ranks (0..12), or null. Wheel A-2-3-4-5 counts, high card 5 (rank 3). */
function straightHigh(ranksAsc: number[]): number | null {
  if (ranksAsc.length !== 5) return null;
  if (ranksAsc[4] - ranksAsc[0] === 4) return ranksAsc[4];
  if (ranksAsc[0] === 0 && ranksAsc[1] === 1 && ranksAsc[2] === 2 && ranksAsc[3] === 3 && ranksAsc[4] === 12) return 3;
  return null;
}

/** Evaluate exactly 5 cards into a ranked hand value. */
export function evaluate5(cards: Card[]): HandValue {
  const ranks = cards.map(c => c.r);
  const suits = cards.map(c => c.s);
  const isFlush = suits.every(s => s === suits[0]);

  const distinctRanksAsc = [...new Set(ranks)].sort((a, b) => a - b);
  const straightHighVal = distinctRanksAsc.length === 5 ? straightHigh(distinctRanksAsc) : null;

  if (isFlush && straightHighVal !== null) {
    return { category: HandCategory.StraightFlush, tiebreakers: [straightHighVal] };
  }

  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => (b[1] - a[1]) || (b[0] - a[0]));

  if (groups[0][1] === 4) {
    const kicker = groups[1][0];
    return { category: HandCategory.Quads, tiebreakers: [groups[0][0], kicker] };
  }
  if (groups[0][1] === 3 && groups[1]?.[1] === 2) {
    return { category: HandCategory.FullHouse, tiebreakers: [groups[0][0], groups[1][0]] };
  }
  if (isFlush) {
    return { category: HandCategory.Flush, tiebreakers: [...ranks].sort((a, b) => b - a) };
  }
  if (straightHighVal !== null) {
    return { category: HandCategory.Straight, tiebreakers: [straightHighVal] };
  }
  if (groups[0][1] === 3) {
    const kickers = groups.slice(1).map(g => g[0]).sort((a, b) => b - a);
    return { category: HandCategory.Trips, tiebreakers: [groups[0][0], ...kickers] };
  }
  if (groups[0][1] === 2 && groups[1]?.[1] === 2) {
    const [hi, lo] = [groups[0][0], groups[1][0]].sort((a, b) => b - a);
    const kicker = groups[2][0];
    return { category: HandCategory.TwoPair, tiebreakers: [hi, lo, kicker] };
  }
  if (groups[0][1] === 2) {
    const kickers = groups.slice(1).map(g => g[0]).sort((a, b) => b - a);
    return { category: HandCategory.Pair, tiebreakers: [groups[0][0], ...kickers] };
  }
  return { category: HandCategory.HighCard, tiebreakers: [...ranks].sort((a, b) => b - a) };
}

function combinations5(cards: Card[]): Card[][] {
  const out: Card[][] = [];
  const n = cards.length;
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let c = b + 1; c < n; c++)
        for (let d = c + 1; d < n; d++)
          for (let e = d + 1; e < n; e++)
            out.push([cards[a], cards[b], cards[c], cards[d], cards[e]]);
  return out;
}

/** Best 5-card hand out of any number of cards (7 for hold'em: 2 hole + 5 community). */
export function bestHand(cards: Card[]): HandValue {
  if (cards.length === 5) return evaluate5(cards);
  let best = evaluate5(cards.slice(0, 5));
  for (const five of combinations5(cards)) {
    const v = evaluate5(five);
    if (compareHandValue(v, best) > 0) best = v;
  }
  return best;
}
