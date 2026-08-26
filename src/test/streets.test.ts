import { test } from "node:test";
import assert from "node:assert/strict";
import { ARCHETYPES, Rng } from "@precog/sim-core";
import { newSeat, playHand, TABLE, STREETS, type Seat, type HandLog, type HandFrame } from "../game.js";

function buildSeats(n = 4): Seat[] {
  const arch = Object.values(ARCHETYPES);
  return Array.from({ length: n }, (_, i) => newSeat(`s${i}`, `Seat${i}`, arch[i % arch.length]));
}

function dealOne(seed: number, n = 4, button = 0): { seats: Seat[]; frames: HandFrame[] } {
  const seats = buildSeats(n);
  const log: HandLog = { lines: [] };
  playHand(seats, new Rng(seed), button, TABLE, log);
  return { seats, frames: log.frames ?? [] };
}

test("frame log follows the four-street rhythm: bet frames BETWEEN street reveals", () => {
  // find a seeded hand that reaches showdown so all four streets appear
  let frames: HandFrame[] = [];
  for (let seed = 1; seed < 200; seed++) {
    const r = dealOne(seed);
    const last = r.frames[r.frames.length - 1];
    if (last?.kind === "showdown" && last.handName !== "") { frames = r.frames; break; }
  }
  assert.ok(frames.length > 0, "no showdown hand found in 200 seeds");

  assert.equal(frames[0].kind, "deal");
  assert.equal(frames[0].reveal, 0, "nothing is face-up at the deal");
  assert.equal(frames[frames.length - 1].kind, "showdown");

  // streets appear in order flop → turn → river, revealing 3 → 4 → 5
  const streets = frames.filter(f => f.kind === "street");
  assert.deepEqual(streets.map(f => f.label), ["flop", "turn", "river"]);
  assert.deepEqual(streets.map(f => f.reveal), [3, 4, 5]);

  // pre-flop betting happens with ZERO cards revealed, before the flop frame
  const flopIdx = frames.findIndex(f => f.label === "flop");
  const preflopActs = frames.filter(f => f.kind === "action" && f.round === 0);
  assert.ok(preflopActs.length > 0, "there is a pre-flop betting round");
  for (const f of preflopActs) {
    assert.equal(f.reveal, 0, "pre-flop actions bet on hole cards only");
    assert.ok(frames.indexOf(f) < flopIdx, "pre-flop actions come before the flop reveal");
  }

  // every action frame bets only on the cards revealed so far, and reveal never regresses
  let seen = 0;
  for (const f of frames) {
    assert.ok(f.reveal >= seen, "reveal must never regress");
    seen = f.reveal;
    if (f.kind === "action") {
      assert.equal(f.reveal, [0, 3, 4, 5][f.round], `street ${f.round} action must see exactly its board`);
      assert.ok(f.strength !== null, "every action carries the seat's read");
    }
  }
});

test("reads swing street to street inside a real hand", () => {
  // across many seeded hands, some seat's read must move by a lot between its own actions
  let maxSwing = 0;
  for (let seed = 1; seed < 60; seed++) {
    const { frames } = dealOne(seed);
    const bySeat = new Map<number, number[]>();
    for (const f of frames) if (f.kind === "action" && f.strength !== null) {
      (bySeat.get(f.seat) ?? bySeat.set(f.seat, []).get(f.seat)!).push(f.strength);
    }
    for (const reads of bySeat.values()) {
      if (reads.length >= 2) maxSwing = Math.max(maxSwing, Math.max(...reads) - Math.min(...reads));
    }
  }
  assert.ok(maxSwing > 0.25, `confidence should genuinely swing between streets (max swing ${maxSwing.toFixed(2)})`);
});

test("blinds sit where the button says: 4-handed and heads-up", () => {
  // 4-handed, button on seat 0: seat 1 posts sb, seat 2 posts bb
  const a = dealOne(11, 4, 0);
  const deal = a.frames[0];
  assert.equal(deal.button, 0);
  assert.equal(deal.seats[1].committed, TABLE.smallBlind);
  assert.equal(deal.seats[2].committed, TABLE.bigBlind);
  assert.equal(deal.seats[0].committed, 0);
  assert.equal(deal.seats[3].committed, 0);

  // button on seat 2: seat 3 posts sb, seat 0 posts bb (wraps)
  const b = dealOne(11, 4, 2);
  assert.equal(b.frames[0].button, 2);
  assert.equal(b.frames[0].seats[3].committed, TABLE.smallBlind);
  assert.equal(b.frames[0].seats[0].committed, TABLE.bigBlind);

  // heads-up: the button posts the small blind
  const h = dealOne(11, 2, 0);
  assert.equal(h.frames[0].seats[0].committed, TABLE.smallBlind);
  assert.equal(h.frames[0].seats[1].committed, TABLE.bigBlind);

  // the button advances hand to hand when driven like runTable drives it
  // (fresh stacks per hand so a bust cannot shrink the live ring mid-check)
  const rng = new Rng(7);
  const buttons: number[] = [];
  for (let h2 = 0; h2 < 4; h2++) {
    const seats = buildSeats(4);
    const log: HandLog = { lines: [] };
    playHand(seats, rng, h2, TABLE, log);
    buttons.push(log.frames![0].button);
  }
  assert.deepEqual(buttons, [0, 1, 2, 3], "button rotates every hand");
  // and with a shrunken ring the button still lands on a live seat (modulo wrap)
  const seats = buildSeats(3);
  const log: HandLog = { lines: [] };
  playHand(seats, rng, 4, TABLE, log);
  assert.equal(log.frames![0].button, 4 % 3, "button wraps around the live seats");
});

test("betting order: first pre-flop actor is left of the big blind, post-flop starts left of the button", () => {
  const { frames } = dealOne(11, 4, 0);
  const firstPre = frames.find(f => f.kind === "action" && f.round === 0)!;
  assert.equal(firstPre.seat, 3, "under the gun (seat left of bb) opens pre-flop");

  const flopIdx = frames.findIndex(f => f.label === "flop" && f.kind === "street");
  if (flopIdx >= 0) {
    const firstFlop = frames.find((f, i) => i > flopIdx && f.kind === "action");
    if (firstFlop) {
      const board = frames[flopIdx].seats;
      // expected: first in-hand seat with chips, scanning 1, 2, 3, 0 from the button
      const orderIdx = [1, 2, 3, 0];
      const expected = orderIdx.find(i => board[i].inHand && board[i].chips > 0);
      assert.equal(firstFlop.seat, expected, "small-blind side opens post-flop betting");
    }
  }
});

test("all-in hands resolve exactly: pot in equals pot out, and the runout still reveals streets", () => {
  // hunt for a hand containing an all-in that reaches showdown
  let found = false;
  for (let seed = 1; seed < 500 && !found; seed++) {
    const seats = buildSeats(4);
    const before = seats.reduce((s, x) => s + x.chips, 0);
    const log: HandLog = { lines: [] };
    playHand(seats, new Rng(seed), seed % 4, TABLE, log);
    const frames = log.frames!;
    const allin = frames.find(f => f.act === "allin");
    const last = frames[frames.length - 1];
    if (!allin || last.kind !== "showdown" || last.handName === "") continue;
    found = true;
    const after = seats.reduce((s, x) => s + x.chips, 0);
    assert.equal(after, before, "all-in hand conserves chips exactly");
    assert.equal(last.reveal, 5, "a showdown always runs the board out");
    assert.equal(last.payouts.reduce((s, v) => s + v, 0), last.amount, "showdown frame pays out the whole pot");
    assert.equal(last.winners.length, last.payouts.length);
    assert.equal(last.winners.length, last.contested.length);
  }
  assert.ok(found, "no all-in showdown found in 500 seeds");
});

test("street labels and stats agree with STREETS", () => {
  assert.deepEqual([...STREETS], ["pre-flop", "flop", "turn", "river"]);
  const { seats } = dealOne(3);
  for (const s of seats) assert.equal(s.stats.aggr.length, 4);
});
