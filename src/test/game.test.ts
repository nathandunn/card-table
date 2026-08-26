import { test } from "node:test";
import assert from "node:assert/strict";
import { ARCHETYPES, Rng, type Personality } from "@precog/sim-core";
import { newSeat, playHand, runTable, splitPot, settlePots, TABLE, type Seat, type HandLog } from "../game.js";
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

// ── side-pot settlement ───────────────────────────────────────────

const fullHouse = evaluate5([c(12, 0), c(12, 1), c(12, 2), c(9, 3), c(9, 0)]);
const twoPair = evaluate5([c(11, 0), c(11, 1), c(9, 2), c(9, 3), c(5, 0)]);
const pair = evaluate5([c(10, 0), c(10, 1), c(8, 2), c(6, 3), c(4, 0)]);

test("settlePots: short all-in winner takes only the main pot, side pot goes to second-best", () => {
  // A is all-in for 30 with the best hand; B and C fought on for 50 each.
  const payouts = settlePots([
    { item: "A", committed: 30, hv: fullHouse },
    { item: "B", committed: 50, hv: twoPair },
    { item: "C", committed: 50, hv: pair },
  ], 130);
  const byItem = new Map(payouts.map(p => [p.item, p]));
  assert.equal(byItem.get("A")!.amount, 90, "A wins 3 × 30 main pot only");
  assert.equal(byItem.get("B")!.amount, 40, "B wins the 2 × 20 side pot");
  assert.equal(byItem.get("C"), undefined, "C wins nothing");
  assert.ok(byItem.get("A")!.contested && byItem.get("B")!.contested);
  assert.equal(payouts.reduce((s, p) => s + p.amount, 0), 130, "every chip paid out");
});

test("settlePots: uncalled overbet flows back to the bettor, flagged uncontested", () => {
  // B raised to 80, A (all-in earlier for 50) is the only caller; C folded after 10.
  const payouts = settlePots([
    { item: "A", committed: 50, hv: pair },
    { item: "B", committed: 80, hv: fullHouse },
    { item: "C", committed: 10, hv: null }, // folded: dead money
  ], 140);
  const byItem = new Map(payouts.map(p => [p.item, p]));
  assert.equal(byItem.get("B")!.amount, 140, "B wins the contested 110 and gets 30 back");
  assert.equal(byItem.get("A"), undefined);
  // B's total mixes a contested layer and a refund layer — contested must be true overall
  assert.ok(byItem.get("B")!.contested);
  const refundOnly = settlePots([
    { item: "A", committed: 50, hv: fullHouse },
    { item: "B", committed: 80, hv: pair },
  ], 130);
  const m = new Map(refundOnly.map(p => [p.item, p]));
  assert.equal(m.get("A")!.amount, 100, "A wins the contested 2 × 50");
  assert.equal(m.get("B")!.amount, 30, "B gets the uncalled 30 back");
  assert.equal(m.get("B")!.contested, false, "a refund is not a win");
});

test("settlePots: tie in the main pot splits it, side pot still goes to its only contender", () => {
  const payouts = settlePots([
    { item: "A", committed: 30, hv: fullHouse },
    { item: "B", committed: 60, hv: fullHouse },
    { item: "C", committed: 60, hv: pair },
  ], 150);
  const byItem = new Map(payouts.map(p => [p.item, p]));
  // main pot 90 splits 45/45 between A and B; side pot 60 contested by B and C → B
  assert.equal(byItem.get("A")!.amount, 45);
  assert.equal(byItem.get("B")!.amount, 105);
  assert.equal(payouts.reduce((s, p) => s + p.amount, 0), 150);
});

// ── partial-board strength ────────────────────────────────────────

import { strength, preflopStrength } from "../game.js";

function sharpP(): Personality {
  const p: Personality = JSON.parse(JSON.stringify(ARCHETYPES.attacker));
  p.traits.focus = 1; // no read noise
  return p;
}

test("a made flush on the flop reads stronger than a busted draw on the river", () => {
  const p = sharpP();
  const flopFlush = strength(
    [c(12, 0), c(9, 0)], [c(5, 0), c(7, 0), c(2, 0)], p, new Rng(1));
  const bustedRiver = strength(
    [c(12, 0), c(9, 0)], [c(5, 0), c(7, 0), c(2, 1), c(3, 2), c(8, 3)], p, new Rng(1));
  assert.ok(flopFlush > 0.75, `made flush should read strong, got ${flopFlush}`);
  assert.ok(bustedRiver < 0.35, `busted draw should read weak, got ${bustedRiver}`);
  assert.ok(flopFlush > bustedRiver + 0.3, "flush on the flop must dwarf the busted river read");
});

test("pre-flop reads: premium pairs above trash, draws add hope on the flop", () => {
  assert.ok(preflopStrength([c(12, 0), c(12, 1)]) > 0.5, "aces read strong pre-flop");
  assert.ok(preflopStrength([c(12, 0), c(12, 1)]) > preflopStrength([c(0, 0), c(0, 1)]), "aces beat deuces");
  assert.ok(preflopStrength([c(5, 0), c(0, 1)]) < 0.15, "7-2 offsuit reads like trash");
  assert.ok(preflopStrength([c(12, 0), c(11, 0)]) > preflopStrength([c(12, 0), c(11, 1)]), "suitedness helps");

  const p = sharpP();
  // same high-card hand, one with four to a flush on the flop, one rainbow
  const withDraw = strength([c(12, 0), c(9, 0)], [c(5, 0), c(7, 0), c(2, 1)], p, new Rng(1));
  const noDraw = strength([c(12, 0), c(9, 2)], [c(5, 0), c(7, 1), c(2, 3)], p, new Rng(1));
  assert.ok(withDraw > noDraw, "a live flush draw should lift the read");
});

test("a seat's read genuinely swings street to street", () => {
  const p = sharpP();
  const hole: [Card, Card] = [c(12, 0), c(11, 1)]; // AK offsuit
  const pre = strength(hole, [], p, new Rng(1));
  const whiffFlop = strength(hole, [c(2, 2), c(5, 3), c(7, 2)], p, new Rng(1));
  const hitFlop = strength(hole, [c(12, 2), c(5, 3), c(7, 2)], p, new Rng(1));
  assert.ok(whiffFlop < pre, "whiffing the flop should collapse the read");
  assert.ok(hitFlop > pre, "flopping top pair should lift the read");
});

// ── table sessions ────────────────────────────────────────────────

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
  assert.deepEqual(logA.frames, logB.frames, "same seed should produce an identical first-hand frame log");
});

test("different seeds produce different outcomes (sanity check the seed actually matters)", () => {
  const seedA = buildSeats();
  const seedB = buildSeats();
  runTable(seedA, 200, 1, undefined);
  runTable(seedB, 200, 2, undefined);
  assert.notDeepEqual(summarize(seedA), summarize(seedB));
});

test("chip conservation: thousands of hands create and destroy nothing (4 seats)", () => {
  const seats = buildSeats();
  const rng = new Rng(31337);
  for (let h = 0; h < 4000; h++) {
    playHand(seats, rng, h);
    const total = seats.reduce((s, x) => s + x.chips, 0);
    const rebuys = seats.reduce((s, x) => s + x.stats.rebuys, 0);
    assert.equal(total, 4 * TABLE.startChips + rebuys * TABLE.startChips,
      `hand ${h}: chips must equal buy-ins (total ${total}, rebuys ${rebuys})`);
    for (const x of seats) {
      assert.ok(x.chips >= 0, `hand ${h}: ${x.name} went negative (${x.chips})`);
      assert.ok(Number.isInteger(x.chips), `hand ${h}: fractional chips at ${x.name}`);
    }
  }
});

test("chip conservation holds heads-up and 6-handed too", () => {
  for (const [names, seed] of [[2, 99], [6, 424242]] as const) {
    const seats = Array.from({ length: names }, (_, i) =>
      newSeat(`s${i}`, `S${i}`, Object.values(ARCHETYPES)[i % Object.keys(ARCHETYPES).length]));
    const rng = new Rng(seed);
    for (let h = 0; h < 2000; h++) {
      playHand(seats, rng, h);
      const total = seats.reduce((s, x) => s + x.chips, 0);
      const rebuys = seats.reduce((s, x) => s + x.stats.rebuys, 0);
      assert.equal(total, names * TABLE.startChips + rebuys * TABLE.startChips, `hand ${h} (${names} seats)`);
    }
  }
});

test("the table never dies: rebuys keep everyone playing over a long session", () => {
  const seats = buildSeats();
  runTable(seats, 5000, 4242);
  const before = seats.map(s => s.stats.hands);
  runTable(seats, 50, 5150); // keep playing — every seat should still be in rotation
  for (let i = 0; i < seats.length; i++) {
    assert.ok(seats[i].stats.hands >= before[i], `${seats[i].name} stopped being dealt in`);
  }
  const dealt = seats.filter((s, i) => s.stats.hands > before[i]);
  assert.ok(dealt.length >= 2, "at least two seats still get hands at the tail of a long session");
});

test("long sessions actually exercise the new machinery: all-ins, bluffs, per-street aggression", () => {
  const seats = buildSeats();
  runTable(seats, 3000, 777);
  const sum = (f: (s: Seat) => number) => seats.reduce((a, s) => a + f(s), 0);
  assert.ok(sum(s => s.stats.allIns) > 0, "all-ins should occur");
  assert.ok(sum(s => s.stats.bluffs) > 0, "bluffs should occur");
  assert.ok(sum(s => s.stats.rebuys) > 0, "rebuys should occur over 3000 hands");
  for (let street = 0; street < 4; street++) {
    assert.ok(sum(s => s.stats.aggr[street]) > 0, `aggression should be recorded on street ${street}`);
  }
  // an aggressive archetype should out-aggress a defensive one
  const aggro = seats[0].stats.aggr.reduce((a, b) => a + b, 0) / seats[0].stats.hands;
  const nitty = seats[1].stats.aggr.reduce((a, b) => a + b, 0) / seats[1].stats.hands;
  assert.ok(aggro > nitty, `attacker (${aggro.toFixed(2)}/hand) should bet+raise more than defender (${nitty.toFixed(2)}/hand)`);
  // net must account for rebuys: chips minus everything bought in
  for (const s of seats) {
    assert.equal(s.stats.net, s.chips - TABLE.startChips * (1 + s.stats.rebuys));
  }
});

test("a busted seat sits out, then returns with a fresh stack and a counted rebuy", () => {
  const seats = [
    newSeat("s0", "A", ARCHETYPES.attacker),
    newSeat("s1", "B", ARCHETYPES.defender),
    newSeat("s2", "C", ARCHETYPES.opportunist),
  ];
  // engineer a bust exactly as the engine records one
  seats[1].chips = 0;
  seats[1].out = TABLE.sitOutHands;
  const rng = new Rng(5);

  playHand(seats, rng, 0); // sit-out hand: not dealt in
  assert.equal(seats[1].chips, 0);
  assert.equal(seats[1].stats.hands, 0, "a seat sitting out is not dealt in");

  playHand(seats, rng, 1); // rebuy hand: back with a fresh stack
  assert.equal(seats[1].stats.rebuys, 1, "the rebuy is counted");
  assert.equal(seats[1].stats.hands, 1, "the seat is dealt straight back in");
  assert.ok(seats[1].chips + seats[1].committed >= 0, "seat is live again");
  const total = seats.reduce((s, x) => s + x.chips, 0);
  const rebuys = seats.reduce((s, x) => s + x.stats.rebuys, 0);
  // note seats[1] started at 0 chips (a forced bust), so its original 200 is not on the table
  assert.equal(total, 2 * TABLE.startChips + rebuys * TABLE.startChips);
});
