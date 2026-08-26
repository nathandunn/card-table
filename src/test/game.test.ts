import { test } from "node:test";
import assert from "node:assert/strict";
import { ARCHETYPES } from "@precog/sim-core";
import { newSeat, runTable, splitPot, type Seat, type HandLog } from "../game.js";
import { evaluate5, HandCategory } from "../handEval.js";
import type { Card } from "../game.js";

const c = (r: number, s: number): Card => ({ r, s });

test("splitPot divides evenly across identical hands rather than picking one winner", () => {
  const tieHand = evaluate5([c(11, 0), c(11, 1), c(7, 2), c(5, 3), c(3, 0)]);
  const entries = [
    { item: "seatA", hv: tieHand },
    { item: "seatB", hv: tieHand },
  ];
  const shares = splitPot(100, entries);
  assert.equal(shares.length, 2, "both tied hands should win a share");
  assert.deepEqual(shares.map(s => s.item).sort(), ["seatA", "seatB"]);
  assert.equal(shares[0].amount + shares[1].amount, 100, "full pot must be distributed");
  assert.equal(shares[0].amount, 50);
  assert.equal(shares[1].amount, 50);
});

test("splitPot gives any odd remainder chip deterministically rather than losing it", () => {
  const tieHand = evaluate5([c(9, 0), c(9, 1), c(6, 2), c(4, 3), c(2, 0)]);
  const entries = [
    { item: "seatA", hv: tieHand },
    { item: "seatB", hv: tieHand },
    { item: "seatC", hv: tieHand },
  ];
  const shares = splitPot(101, entries);
  const total = shares.reduce((sum, s) => sum + s.amount, 0);
  assert.equal(total, 101, "full pot must be distributed, no chips lost or created");
  assert.equal(shares[0].amount, 34);
  assert.equal(shares[1].amount, 34);
  assert.equal(shares[2].amount, 33);
});

test("splitPot only pays the strictly better hand, not a tie, when hands differ", () => {
  const strong = evaluate5([c(12, 0), c(12, 1), c(12, 2), c(9, 3), c(9, 0)]); // full house
  const weak = evaluate5([c(11, 0), c(11, 1), c(9, 2), c(7, 3), c(5, 0)]); // pair
  const shares = splitPot(80, [{ item: "strong", hv: strong }, { item: "weak", hv: weak }]);
  assert.equal(shares.length, 1);
  assert.equal(shares[0].item, "strong");
  assert.equal(shares[0].amount, 80);
});

test("evaluate5 sanity: full house beats pair (used above)", () => {
  const fh = evaluate5([c(12, 0), c(12, 1), c(12, 2), c(9, 3), c(9, 0)]);
  const pr = evaluate5([c(11, 0), c(11, 1), c(9, 2), c(7, 3), c(5, 0)]);
  assert.equal(fh.category, HandCategory.FullHouse);
  assert.equal(pr.category, HandCategory.Pair);
});

function buildSeats(): Seat[] {
  return [
    newSeat("s0", "Attacker", ARCHETYPES.attacker),
    newSeat("s1", "Defender", ARCHETYPES.defender),
    newSeat("s2", "Opportunist", ARCHETYPES.opportunist),
    newSeat("s3", "Wildcard", ARCHETYPES.wildcard),
  ];
}

function summarize(seats: Seat[]) {
  return seats.map(s => ({ chips: s.chips, stats: s.stats }));
}

test("a fixed seed reproduces an identical run", () => {
  const seedA = buildSeats();
  const seedB = buildSeats();
  const logA: HandLog = { lines: [] };
  const logB: HandLog = { lines: [] };

  runTable(seedA, 200, 777123, logA);
  runTable(seedB, 200, 777123, logB);

  assert.deepEqual(summarize(seedA), summarize(seedB), "same seed should produce identical chip and stat outcomes");
  assert.deepEqual(logA.lines, logB.lines, "same seed should produce an identical first-hand log");
});

test("different seeds produce different outcomes (sanity check the seed actually matters)", () => {
  const seedA = buildSeats();
  const seedB = buildSeats();
  runTable(seedA, 200, 1, undefined);
  runTable(seedB, 200, 2, undefined);
  assert.notDeepEqual(summarize(seedA), summarize(seedB));
});
