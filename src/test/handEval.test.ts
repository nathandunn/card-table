import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluate5, bestHand, compareHandValue, HandCategory, type HandValue } from "../handEval.js";
import type { Card } from "../game.js";

const c = (r: number, s: number): Card => ({ r, s });
const [TWO, THREE, FOUR, FIVE, SIX, SEVEN, EIGHT, NINE, TEN, JACK, QUEEN, KING, ACE] =
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

test("each hand category ranks above the one below it", () => {
  const inOrder: { name: string; category: HandCategory; cards: Card[] }[] = [
    { name: "high card", category: HandCategory.HighCard, cards: [c(ACE, 0), c(KING, 1), c(QUEEN, 2), c(JACK, 3), c(NINE, 0)] },
    { name: "pair", category: HandCategory.Pair, cards: [c(KING, 0), c(KING, 1), c(NINE, 2), c(SEVEN, 3), c(FIVE, 0)] },
    { name: "two pair", category: HandCategory.TwoPair, cards: [c(KING, 0), c(KING, 1), c(NINE, 2), c(NINE, 3), c(SEVEN, 0)] },
    { name: "trips", category: HandCategory.Trips, cards: [c(KING, 0), c(KING, 1), c(KING, 2), c(NINE, 3), c(SEVEN, 0)] },
    { name: "straight", category: HandCategory.Straight, cards: [c(FIVE, 0), c(SIX, 1), c(SEVEN, 2), c(EIGHT, 3), c(NINE, 0)] },
    { name: "flush", category: HandCategory.Flush, cards: [c(ACE, 0), c(QUEEN, 0), c(EIGHT, 0), c(FIVE, 0), c(THREE, 0)] },
    { name: "full house", category: HandCategory.FullHouse, cards: [c(KING, 0), c(KING, 1), c(KING, 2), c(NINE, 3), c(NINE, 0)] },
    { name: "quads", category: HandCategory.Quads, cards: [c(KING, 0), c(KING, 1), c(KING, 2), c(KING, 3), c(NINE, 0)] },
    { name: "straight flush", category: HandCategory.StraightFlush, cards: [c(FIVE, 0), c(SIX, 0), c(SEVEN, 0), c(EIGHT, 0), c(NINE, 0)] },
  ];

  const values = inOrder.map(x => ({ name: x.name, hv: evaluate5(x.cards) }));
  for (const [i, v] of values.entries()) {
    assert.equal(v.hv.category, inOrder[i].category, `${v.name} should evaluate to category ${inOrder[i].category}`);
  }
  for (let i = 1; i < values.length; i++) {
    assert.equal(
      compareHandValue(values[i].hv, values[i - 1].hv), 1,
      `${values[i].name} should rank above ${values[i - 1].name}`
    );
    assert.equal(
      compareHandValue(values[i - 1].hv, values[i].hv), -1,
      `${values[i - 1].name} should rank below ${values[i].name}`
    );
  }
});

test("kicker comparisons resolve correctly within the same category", () => {
  const pairHighKicker = evaluate5([c(ACE, 0), c(ACE, 1), c(NINE, 2), c(SEVEN, 3), c(FIVE, 0)]);
  const pairLowKicker = evaluate5([c(ACE, 0), c(ACE, 1), c(NINE, 2), c(SEVEN, 3), c(THREE, 0)]);
  assert.equal(compareHandValue(pairHighKicker, pairLowKicker), 1, "AA976 should beat AA974");

  const twoPairHighKicker = evaluate5([c(KING, 0), c(KING, 1), c(TWO, 2), c(TWO, 3), c(ACE, 0)]);
  const twoPairLowKicker = evaluate5([c(KING, 0), c(KING, 1), c(TWO, 2), c(TWO, 3), c(QUEEN, 0)]);
  assert.equal(compareHandValue(twoPairHighKicker, twoPairLowKicker), 1, "KK22A should beat KK22Q");

  const fullHouseHigherPair = evaluate5([c(KING, 0), c(KING, 1), c(KING, 2), c(THREE, 3), c(THREE, 0)]);
  const fullHouseLowerPair = evaluate5([c(KING, 0), c(KING, 1), c(KING, 2), c(TWO, 3), c(TWO, 0)]);
  assert.equal(compareHandValue(fullHouseHigherPair, fullHouseLowerPair), 1, "KKK33 should beat KKK22 (pair kicker matters in full house)");

  const flushHigh = evaluate5([c(ACE, 0), c(QUEEN, 0), c(JACK, 0), c(NINE, 0), c(THREE, 0)]);
  const flushLow = evaluate5([c(ACE, 0), c(QUEEN, 0), c(JACK, 0), c(NINE, 0), c(TWO, 0)]);
  assert.equal(compareHandValue(flushHigh, flushLow), 1, "flush with higher 5th card should win");

  const highCardHigh = evaluate5([c(ACE, 0), c(KING, 1), c(QUEEN, 2), c(JACK, 3), c(NINE, 0)]);
  const highCardLow = evaluate5([c(ACE, 0), c(KING, 1), c(QUEEN, 2), c(JACK, 3), c(EIGHT, 0)]);
  assert.equal(compareHandValue(highCardHigh, highCardLow), 1, "AKQJ9 should beat AKQJ8");
});

test("wheel straight A-2-3-4-5 is valid and ranks as five-high", () => {
  const wheel = evaluate5([c(ACE, 0), c(TWO, 1), c(THREE, 2), c(FOUR, 3), c(FIVE, 0)]);
  assert.equal(wheel.category, HandCategory.Straight);
  assert.equal(wheel.tiebreakers[0], FIVE, "wheel straight should rank as five-high, not ace-high");

  const sixHigh = evaluate5([c(TWO, 0), c(THREE, 1), c(FOUR, 2), c(FIVE, 3), c(SIX, 0)]);
  assert.equal(compareHandValue(sixHigh, wheel), 1, "6-high straight should beat the wheel");

  const wheelFlush = evaluate5([c(ACE, 0), c(TWO, 0), c(THREE, 0), c(FOUR, 0), c(FIVE, 0)]);
  assert.equal(wheelFlush.category, HandCategory.StraightFlush, "suited wheel is a straight flush");
  assert.equal(wheelFlush.tiebreakers[0], FIVE);

  const nonStraight = evaluate5([c(ACE, 0), c(TWO, 1), c(THREE, 2), c(FOUR, 3), c(SIX, 0)]);
  assert.notEqual(nonStraight.category, HandCategory.Straight, "A-2-3-4-6 is not a straight");
});

test("bestHand picks the best 5-of-7 (2 hole + 5 community)", () => {
  const hole: Card[] = [c(ACE, 0), c(ACE, 1)];
  const community: Card[] = [c(ACE, 2), c(KING, 0), c(KING, 1), c(NINE, 2), c(THREE, 3)];
  const hv = bestHand([...hole, ...community]);
  assert.equal(hv.category, HandCategory.FullHouse);
  assert.deepEqual(hv.tiebreakers, [ACE, KING]);
});

test("identical hands compare equal (tie / split)", () => {
  const a = evaluate5([c(KING, 0), c(KING, 1), c(NINE, 2), c(SEVEN, 3), c(FIVE, 0)]);
  const b = evaluate5([c(KING, 2), c(KING, 3), c(NINE, 0), c(SEVEN, 1), c(FIVE, 2)]);
  assert.equal(compareHandValue(a, b), 0);
});
