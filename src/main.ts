import { ARCHETYPES, CORE_TRAITS, type Personality } from "@precog/sim-core";
import { newSeat, runTable, RANKS, SUITS, type Seat, type HandLog, type HandFrame, type FrameKind, type Card, type Act } from "./game.js";
import { sweepTrait, sweepAll, SHAPE_LABEL, setTrait, type TraitKey } from "@precog/agent-forge/dist/sweep.js";
import { evolve } from "@precog/agent-forge/dist/evolve.js";

const TRAITS = [...CORE_TRAITS, "randomness"] as const;
const ARCH = Object.keys(ARCHETYPES);
const clone = (p: Personality): Personality => JSON.parse(JSON.stringify(p));

interface SeatUI {
  getP: () => Personality;
  setP: (p: Personality) => void;
  getName: () => string;
  enabled: () => boolean;
}
const seatUIs: SeatUI[] = [];
const tableEl = document.getElementById("table")!;

function makeSeat(i: number) {
  const wrap = document.createElement("section");
  wrap.className = "seat";
  const head = document.createElement("div"); head.className = "seathead";
  const on = document.createElement("input"); on.type = "checkbox"; on.checked = i < 4;
  const nm = document.createElement("input"); nm.type = "text"; nm.value = `Seat ${i + 1}`; nm.className = "nm";
  head.append(on, nm); wrap.append(head);
  const sel = document.createElement("select");
  for (const k of ARCH) sel.append(new Option(k, k));
  sel.value = ARCH[i % ARCH.length];
  const l1 = document.createElement("label"); l1.textContent = "Personality";
  wrap.append(l1, sel);
  const sl: Record<string, HTMLInputElement> = {}, vv: Record<string, HTMLElement> = {}, lk: Record<string, HTMLElement> = {};
  for (const t of TRAITS) {
    const row = document.createElement("div"); row.className = "trait";
    const n = document.createElement("span"); n.textContent = t.slice(0, 7);
    const inp = document.createElement("input");
    inp.type = "range"; inp.min = "0"; inp.max = "1"; inp.step = "0.05";
    const v = document.createElement("span"); v.className = "v";
    const lock = document.createElement("span"); lock.className = "lockmark";
    row.append(n, inp, v, lock); wrap.append(row); sl[t] = inp; vv[t] = v; lk[t] = lock;
    inp.addEventListener("input", () => { v.textContent = (+inp.value).toFixed(2); lock.textContent = ""; refreshSweepSeatOptions(); });
  }
  const apply = (p: Personality) => {
    for (const t of CORE_TRAITS) { sl[t].value = String(p.traits[t]); vv[t].textContent = p.traits[t].toFixed(2); }
    sl.randomness.value = String(p.randomness); vv.randomness.textContent = p.randomness.toFixed(2);
    for (const t of TRAITS) lk[t].textContent = "";
  };
  apply(clone(ARCHETYPES[sel.value]));
  sel.addEventListener("change", () => apply(clone(ARCHETYPES[sel.value])));
  const sync = () => { wrap.classList.toggle("off", !on.checked); refreshSweepSeatOptions(); };
  on.addEventListener("change", sync);
  nm.addEventListener("input", refreshSweepSeatOptions);
  tableEl.append(wrap);
  (wrap as any)._lockMarks = lk;
  seatUIs.push({
    enabled: () => on.checked,
    getName: () => nm.value || `Seat ${i + 1}`,
    getP: () => {
      const traits: Record<string, number> = {};
      for (const t of CORE_TRAITS) traits[t] = +sl[t].value;
      return { id: sel.value, name: sel.value, archetype: sel.value, traits: traits as Personality["traits"], randomness: +sl.randomness.value };
    },
    setP: (p: Personality) => {
      for (const t of CORE_TRAITS) { sl[t].value = String(p.traits[t]); vv[t].textContent = p.traits[t].toFixed(2); }
      sl.randomness.value = String(p.randomness); vv.randomness.textContent = p.randomness.toFixed(2);
    },
  });
  sync();
}

const out = document.getElementById("out")!;
const outTitle = document.getElementById("outTitle")!;
const handsInput = document.getElementById("hands") as HTMLInputElement;
const sweepSeatSel = document.getElementById("sweepSeat") as HTMLSelectElement;
const sweepTraitSel = document.getElementById("sweepTrait") as HTMLSelectElement;
for (const t of TRAITS) sweepTraitSel.append(new Option(t, t));

function refreshSweepSeatOptions() {
  const prev = sweepSeatSel.value;
  sweepSeatSel.innerHTML = "";
  seatUIs.forEach((s, i) => { if (s.enabled()) sweepSeatSel.append(new Option(s.getName(), String(i))); });
  if ([...sweepSeatSel.options].some(o => o.value === prev)) sweepSeatSel.value = prev;
}
// Seats are built after the sweep controls exist: makeSeat's change handlers call
// refreshSweepSeatOptions, which reads sweepSeatSel.
for (let i = 0; i < 6; i++) makeSeat(i);
refreshSweepSeatOptions();

function buildSeats(): Seat[] {
  return seatUIs.filter(s => s.enabled()).map((s, i) => newSeat(`s${i}`, s.getName(), s.getP()));
}
function lockMarksOf(idx: number) { return (tableEl.children[idx] as any)._lockMarks as Record<string, HTMLElement>; }
const esc = (s: string) => s.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
function shapeArrow(shape: string) {
  return ({ up: "↑", down: "↓", peaked: "▲", valley: "▼", flat: "–" } as Record<string, string>)[shape] ?? "";
}

// ── Animated hand replay ──────────────────────────────────────────
// A hand is deterministic given its seed, so this renders an already-completed
// hand: every beat of the frame log (deal, each street, each betting action,
// showdown) is a frame, and a frame's own progress `t` drives the transient
// effects — cards in flight, chips travelling to the pot, badges, the showdown
// highlight. Nothing is re-simulated, so scrubbing backwards is free.

const VIEW_W = 760, VIEW_H = 470;
const CX = 380, CY = 228;          // table centre — also where cards are dealt from
const RX = 278, RY = 126;          // felt ellipse
const SEAT_RX = 292, SEAT_RY = 178; // ring the seat panels sit on
const SEAT_W = 136, SEAT_H = 84;
const CW = 48, CH = 66, CGAP = 9;  // community card
const HW = 30, HH = 42;            // hole card
const BOARD_Y = CY - 27;
const BOARD_X0 = CX - (5 * CW + 4 * CGAP) / 2;

// Phase windows within one frame, in units of t (0..1).
const T_MOVE0 = 0.08;    // cards / chips leave
const T_MOVE1 = 0.58;    // ... and land
const T_SETTLE = 0.70;   // counters finished tweening
const T_STILL = 0.72;    // the instant shown when paused, stepped or scrubbed
const T_BANNER = 0.50;   // showdown banner fades in

const FRAME_MS: Record<FrameKind, number> = { deal: 1500, street: 800, action: 800, showdown: 2300 };

const FELT = "#12352b", FELT2 = "#0d271f", PANEL = "#17402f", LINE = "#2c5a45";
const INK = "#f0ece0", MUT = "#8fae9d", GOLD = "#d9b45e", POS = "#7ddc9a", NEG = "#e08b7a";
const FACE = "#f4efe2", FACE_INK = "#1d2a22", FACE_RED = "#b8353a";
const MONO = '"IBM Plex Mono",monospace';

const canvas = document.getElementById("handCanvas") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const roundLbl = document.getElementById("roundLbl")!;
const stateLbl = document.getElementById("stateLbl")!;
const playBtn = document.getElementById("playBtn") as HTMLButtonElement;
const stepBtn = document.getElementById("stepBtn") as HTMLButtonElement;
const restartBtn = document.getElementById("restartBtn") as HTMLButtonElement;
const speedSel = document.getElementById("speedSel") as HTMLSelectElement;
const scrub = document.getElementById("scrub") as HTMLInputElement;

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function fitCanvas() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(VIEW_W * dpr);
  canvas.height = Math.round(VIEW_H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
fitCanvas();

let frames: HandFrame[] = [];
let community: Card[] = [];
let idx = 0;
let t = T_STILL;
let playing = false;
let raf: number | null = null;
let lastTs = 0;

// ── small drawing helpers ──
function clamp01(v: number) { return v < 0 ? 0 : v > 1 ? 1 : v; }
/** progress through a window */
function ramp(v: number, from: number, to: number) { return clamp01((v - from) / (to - from)); }
function easeOut(v: number) { return 1 - (1 - v) * (1 - v); }
function easeInOut(v: number) { return v < 0.5 ? 2 * v * v : 1 - 2 * (1 - v) * (1 - v); }
function lerp(a: number, b: number, k: number) { return a + (b - a) * k; }
function rr(x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function fitText(s: string, max: number): string {
  if (ctx.measureText(s).width <= max) return s;
  let r = s;
  while (r.length > 1 && ctx.measureText(r + "…").width > max) r = r.slice(0, -1);
  return r + "…";
}
const sameCard = (a: Card, b: Card) => a.r === b.r && a.s === b.s;

/** Seat panel centre for seat `i` of `n`, evenly spaced round the felt starting at the bottom. */
function seatPos(i: number, n: number): { x: number; y: number } {
  const a = Math.PI / 2 + (i * 2 * Math.PI) / n;
  return { x: CX + Math.cos(a) * SEAT_RX, y: CY + Math.sin(a) * SEAT_RY };
}

function drawCard(x: number, y: number, w: number, h: number, card: Card | null, faceUp: boolean, alpha = 1, glow = 0) {
  const k = w / CW;
  ctx.save();
  ctx.globalAlpha = alpha;
  if (glow > 0) {
    ctx.strokeStyle = GOLD;
    ctx.lineWidth = 2 + glow * 2;
    ctx.globalAlpha = alpha * (0.35 + glow * 0.65);
    rr(x - 3, y - 3, w + 6, h + 6, 6 * k + 3); ctx.stroke();
    ctx.globalAlpha = alpha;
  }
  if (faceUp && card) {
    ctx.fillStyle = FACE;
    rr(x, y, w, h, 5 * k); ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.35)"; ctx.lineWidth = 1;
    rr(x, y, w, h, 5 * k); ctx.stroke();
    const red = card.s === 1 || card.s === 2;
    ctx.fillStyle = red ? FACE_RED : FACE_INK;
    ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    ctx.font = `600 ${Math.max(9, Math.round(15 * k))}px ${MONO}`;
    ctx.fillText(RANKS[card.r], x + 4 * k + 1, y + 15 * k + 3);
    ctx.textAlign = "center";
    ctx.font = `${Math.max(11, Math.round(21 * k))}px ${MONO}`;
    ctx.fillText(SUITS[card.s], x + w / 2, y + h - 8 * k - 2);
  } else {
    ctx.fillStyle = PANEL;
    rr(x, y, w, h, 5 * k); ctx.fill();
    ctx.strokeStyle = LINE; ctx.lineWidth = 1;
    rr(x, y, w, h, 5 * k); ctx.stroke();
    ctx.save();
    rr(x + 3, y + 3, w - 6, h - 6, 3); ctx.clip();
    ctx.strokeStyle = "rgba(217,180,94,0.28)"; ctx.lineWidth = 1;
    for (let d = -h; d < w + h; d += 7) {
      ctx.beginPath(); ctx.moveTo(x + d, y); ctx.lineTo(x + d + h, y + h); ctx.stroke();
    }
    ctx.restore();
  }
  ctx.restore();
}

/** A card mid-flip: horizontal squash, back on the way in, face on the way out. */
function drawFlip(x: number, y: number, w: number, h: number, card: Card, p: number, glow = 0) {
  const sx = Math.max(0.04, Math.abs(1 - 2 * clamp01(p)));
  ctx.save();
  ctx.translate(x + w / 2, 0); ctx.scale(sx, 1); ctx.translate(-(x + w / 2), 0);
  drawCard(x, y, w, h, card, p > 0.5, 1, p > 0.5 ? glow : 0);
  ctx.restore();
}

function drawChip(x: number, y: number, r: number, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = GOLD;
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.45)"; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(x, y, r * 0.62, 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
}

/** A settled pile of chips, height standing in for the amount. */
function drawPile(x: number, y: number, amount: number, alpha = 1) {
  if (amount <= 0) return;
  const n = Math.min(9, Math.max(1, Math.round(amount / 6)));
  for (let i = 0; i < n; i++) drawChip(x, y - i * 3.2, 8, alpha);
}

function drawFelt() {
  ctx.fillStyle = FELT2;
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  const g = ctx.createRadialGradient(CX, CY, 20, CX, CY, RX);
  g.addColorStop(0, "#1a4536");
  g.addColorStop(1, FELT);
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.ellipse(CX, CY, RX, RY, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = LINE; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.ellipse(CX, CY, RX, RY, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = "rgba(217,180,94,0.18)"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.ellipse(CX, CY, RX - 11, RY - 11, 0, 0, Math.PI * 2); ctx.stroke();
}

/** Five community slots; `reveal` are dealt, `flipping` is the index turning over right now. */
function drawBoard(reveal: number, flipFrom: number, p: number) {
  for (let i = 0; i < 5; i++) {
    const x = BOARD_X0 + i * (CW + CGAP);
    if (i >= reveal) {
      ctx.save();
      ctx.strokeStyle = "rgba(143,174,157,0.22)"; ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      rr(x, BOARD_Y, CW, CH, 5); ctx.stroke();
      ctx.restore();
      continue;
    }
    const glow = highlight.length && highlight.some(c => sameCard(c, community[i])) ? highlightK : 0;
    if (i >= flipFrom) {
      const delay = (i - flipFrom) * 0.10;
      drawFlip(x, BOARD_Y, CW, CH, community[i], ramp(p, T_MOVE0 + delay, T_MOVE1 + delay), glow);
    } else {
      drawCard(x, BOARD_Y, CW, CH, community[i], true, 1, glow);
    }
  }
}

function drawPot(amount: number, flying = 0) {
  drawPile(CX, CY - 62, amount * (1 - flying));
  ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
  ctx.fillStyle = MUT;
  ctx.font = `600 10px ${MONO}`;
  ctx.fillText("POT", CX, CY - 96);
  ctx.fillStyle = GOLD;
  ctx.font = `600 20px ${MONO}`;
  ctx.fillText(String(Math.round(amount)), CX, CY - 78);
}

const ACT_LABEL: Record<Act, string> = { check: "CHECK", bet: "BET", call: "CALL", raise: "RAISE", fold: "FOLD", allin: "ALL-IN" };
const HOT = "#ff9d6e";
function actColor(a: Act) { return a === "fold" ? NEG : a === "check" ? MUT : a === "allin" ? HOT : a === "raise" || a === "bet" ? GOLD : POS; }

interface SeatFx { alpha: number; active: number; flash: number; win: number; }

function drawSeat(sx: number, sy: number, name: string, persona: string, chips: number, committed: number,
                  hole: [Card, Card] | null, faceUp: boolean, dealP: [number, number] | null,
                  badge: Act | null, fx: SeatFx) {
  const x = sx - SEAT_W / 2, y = sy - SEAT_H / 2;
  ctx.save();
  ctx.globalAlpha = fx.alpha;

  ctx.fillStyle = PANEL;
  rr(x, y, SEAT_W, SEAT_H, 8); ctx.fill();
  ctx.strokeStyle = fx.win > 0 || fx.active > 0 ? GOLD : LINE;
  ctx.lineWidth = fx.win > 0 ? 1.5 + fx.win * 1.5 : fx.active > 0 ? 1 + fx.active : 1;
  rr(x, y, SEAT_W, SEAT_H, 8); ctx.stroke();
  if (fx.flash > 0) {
    ctx.globalAlpha = fx.alpha * fx.flash * 0.3;
    ctx.fillStyle = GOLD;
    rr(x, y, SEAT_W, SEAT_H, 8); ctx.fill();
    ctx.globalAlpha = fx.alpha;
  }

  ctx.textBaseline = "alphabetic";
  ctx.font = `600 11px ${MONO}`;
  ctx.textAlign = "left"; ctx.fillStyle = INK;
  ctx.fillText(fitText(name, 78), x + 9, y + 17);
  ctx.textAlign = "right"; ctx.fillStyle = GOLD;
  ctx.fillText(String(Math.round(chips)), x + SEAT_W - 9, y + 17);

  // hole cards — in flight during the deal, otherwise seated
  if (hole) {
    for (let j = 0; j < 2; j++) {
      const tx = x + 9 + j * (HW + 4), ty = y + 26;
      if (dealP) {
        const q = easeOut(dealP[j]);
        if (q <= 0) continue;
        const px = lerp(CX - HW / 2, tx, q), py = lerp(CY - HH / 2, ty, q);
        drawCard(px, py, HW, HH, hole[j], false, 0.35 + q * 0.65);
      } else {
        const glow = faceUp && highlight.length && highlight.some(c => sameCard(c, hole[j])) ? highlightK : 0;
        drawCard(tx, ty, HW, HH, hole[j], faceUp, 1, glow);
      }
    }
  }

  if (badge) {
    ctx.font = `600 10px ${MONO}`;
    const bw = 50, bx = x + SEAT_W - bw - 9, by = y + 34;
    ctx.fillStyle = FELT2;
    rr(bx, by, bw, 19, 5); ctx.fill();
    ctx.strokeStyle = actColor(badge); ctx.lineWidth = 1;
    rr(bx, by, bw, 19, 5); ctx.stroke();
    ctx.fillStyle = actColor(badge);
    ctx.textAlign = "center";
    ctx.fillText(ACT_LABEL[badge], bx + bw / 2, by + 13);
  }

  ctx.font = `9px ${MONO}`;
  ctx.fillStyle = MUT;
  ctx.textAlign = "left";
  ctx.fillText(committed > 0 ? `in ${Math.round(committed)}` : "—", x + 9, y + SEAT_H - 7);
  ctx.textAlign = "right";
  ctx.fillText(fitText(persona, 62), x + SEAT_W - 9, y + SEAT_H - 7);
  ctx.restore();
}

/** Chips travelling between a seat and the pot. */
function drawChipRun(from: { x: number; y: number }, to: { x: number; y: number }, amount: number, p: number) {
  if (amount <= 0) return;
  const n = Math.min(6, Math.max(1, Math.round(amount / 5)));
  for (let i = 0; i < n; i++) {
    const q = clamp01(ramp(p, T_MOVE0 + i * 0.05, T_MOVE1 + i * 0.05));
    if (q <= 0 || q >= 1) continue;
    const e = easeInOut(q);
    const arc = Math.sin(Math.PI * e) * 16;
    drawChip(lerp(from.x, to.x, e), lerp(from.y, to.y, e) - arc, 7, 1);
  }
}

// Showdown highlight, shared with the card drawers.
let highlight: Card[] = [];
let highlightK = 0;

function drawIdle() {
  drawFelt();
  drawBoard(0, 99, 1);
  ctx.fillStyle = MUT;
  ctx.font = `13px ${MONO}`;
  ctx.textAlign = "center";
  ctx.fillText("deal a hand to watch it play out", CX, CY + 78);
}

function draw() {
  ctx.clearRect(0, 0, VIEW_W, VIEW_H);
  const f = frames[idx];
  if (!f) { drawIdle(); return; }
  const p = reduceMotion ? T_STILL : t;
  const prev = frames[idx - 1];
  const n = f.seats.length;

  highlight = f.kind === "showdown" ? f.best : [];
  highlightK = highlight.length ? easeOut(ramp(p, 0.40, 0.70)) : 0;

  drawFelt();

  const flipFrom = f.kind === "street" ? (prev?.reveal ?? 0) : 99;
  drawBoard(f.reveal, flipFrom, p);

  // pot counter tweens across the beat; at showdown it empties toward the winners
  const potNow = lerp(f.potBefore, f.potAfter, easeOut(ramp(p, T_MOVE0, T_SETTLE)));
  const paying = f.kind === "showdown" ? easeInOut(clamp01(ramp(p, T_MOVE0, T_MOVE1))) : 0;
  drawPot(f.kind === "showdown" ? f.potBefore : potNow, paying);

  for (let i = 0; i < n; i++) {
    const st = f.seats[i];
    const before = prev?.seats[i];
    const pos = seatPos(i, n);

    const acting = f.kind === "action" && f.seat === i;
    const folding = acting && f.act === "fold";
    const wonHere = f.kind === "showdown" && f.winners.includes(i);

    // a folded seat greys out — on the beat it folds, it fades there
    const alpha = folding ? lerp(1, 0.4, easeOut(ramp(p, 0.15, 0.6)))
      : st.inHand ? 1 : 0.4;
    const fx: SeatFx = {
      alpha,
      active: acting ? 1 - ramp(p, T_SETTLE, 1) : 0,
      flash: acting && (f.act === "raise" || f.act === "bet") ? 1 - ramp(p, T_MOVE0, 0.55) : 0,
      win: wonHere ? easeOut(ramp(p, T_MOVE1, 0.9)) : 0,
    };

    const chipsNow = before ? lerp(before.chips, st.chips, easeOut(ramp(p, T_MOVE0, T_SETTLE))) : st.chips;
    const commNow = before ? lerp(before.committed, st.committed, easeOut(ramp(p, T_MOVE0, T_SETTLE))) : st.committed;

    // during the deal the hole cards fly out from the middle, two per seat, in order
    let dealP: [number, number] | null = null;
    if (f.kind === "deal") {
      const d = (k: number) => ramp(p, 0.05 + (i * 2 + k) * 0.055, 0.45 + (i * 2 + k) * 0.055);
      dealP = [d(0), d(1)];
    }

    const faceUp = f.kind === "showdown" && st.inHand && f.winners.length > 0 && f.handName !== "";
    const badge = acting ? f.act : (!st.inHand ? "fold" as Act : st.inHand && st.chips === 0 && st.committed > 0 ? "allin" as Act : null);

    drawSeat(pos.x, pos.y, st.name, st.persona, f.kind === "deal" ? st.chips : chipsNow,
      f.kind === "deal" ? st.committed : commNow, st.hole,
      faceUp && p > 0.35, dealP, badge, fx);

    if (i === f.button) {
      const bx = lerp(pos.x, CX, 0.30), by = lerp(pos.y, CY, 0.30);
      ctx.save();
      ctx.fillStyle = FACE;
      ctx.beginPath(); ctx.arc(bx, by, 9, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.4)"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(bx, by, 9, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = FACE_INK;
      ctx.font = `600 10px ${MONO}`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("D", bx, by + 0.5);
      ctx.restore();
      ctx.textBaseline = "alphabetic";
    }

    if (acting && f.amount > 0) drawChipRun(pos, { x: CX, y: CY - 62 }, f.amount, p);
    if (wonHere) drawChipRun({ x: CX, y: CY - 62 }, pos, f.payouts[f.winners.indexOf(i)] ?? f.amount / f.winners.length, p);
  }

  // street / round caption under the board
  ctx.textAlign = "center";
  ctx.fillStyle = MUT;
  ctx.font = `600 11px ${MONO}`;
  ctx.fillText(f.label.toUpperCase(), CX, CY + 74);

  if (f.kind === "showdown") {
    const a = ramp(p, T_BANNER, T_BANNER + 0.25);
    if (a > 0) {
      const contestedIdx = f.winners.filter((_, k) => f.contested[k] !== false);
      const namedIdx = contestedIdx.length ? contestedIdx : f.winners;
      const names = namedIdx.map(i => f.seats[i].name).join(" & ");
      const wonAmt = f.winners.reduce((sum, _, k) => (f.contested[k] !== false ? sum + (f.payouts[k] ?? 0) : sum), 0) || f.amount;
      ctx.save();
      ctx.globalAlpha = a * 0.9;
      ctx.fillStyle = "#08170f";
      ctx.fillRect(0, CY + 84, VIEW_W, 46);
      ctx.globalAlpha = a;
      ctx.fillStyle = GOLD;
      ctx.font = '700 22px "Playfair Display",Georgia,serif';
      ctx.textAlign = "center";
      ctx.fillText(f.handName ? `${names} — ${f.handName}` : `${names} takes it`, CX, CY + 108);
      ctx.globalAlpha = a;
      ctx.fillStyle = MUT;
      ctx.font = `11px ${MONO}`;
      ctx.fillText(f.handName ? `wins ${wonAmt}` : `wins ${wonAmt} — everyone folded`, CX, CY + 124);
      ctx.restore();
    }
  }
}

function syncLabels() {
  const f = frames[idx];
  roundLbl.textContent = frames.length ? `beat ${idx + 1} / ${frames.length} · ${f.label}` : "beat 0 / 0";
  if (!f) { stateLbl.textContent = "no hand yet"; return; }
  const cls = f.kind === "showdown" ? "hwin" : f.act === "fold" ? "hfold" : f.kind === "action" ? "hact" : "hmut";
  stateLbl.innerHTML = `<span class="${cls}">${esc(f.note)}</span>`;
  scrub.value = String(idx);
}

function speedMul() { return ({ "1x": 1, "2x": 2, "4x": 4 } as Record<string, number>)[speedSel.value] ?? 1; }

function stopPlaying() {
  playing = false;
  playBtn.textContent = "▶ Play";
  if (raf !== null) { cancelAnimationFrame(raf); raf = null; }
}

function startPlaying() {
  if (!frames.length || playing) return;
  if (idx >= frames.length - 1 && t >= 0.999) { idx = 0; t = 0; }
  playing = true;
  playBtn.textContent = "⏸ Pause";
  lastTs = performance.now();
  raf = requestAnimationFrame(tick);
}

function tick(now: number) {
  const dt = Math.min(80, now - lastTs);
  lastTs = now;
  t += dt / (FRAME_MS[frames[idx].kind] / speedMul());
  while (t >= 1) {
    if (idx >= frames.length - 1) { t = 1; stopPlaying(); break; }
    idx++; t -= 1;
  }
  syncLabels();
  draw();
  if (playing) raf = requestAnimationFrame(tick);
}

function gotoBeat(i: number, at = T_STILL) {
  idx = Math.max(0, Math.min(frames.length - 1, i));
  t = at;
  syncLabels();
  draw();
}

playBtn.addEventListener("click", () => { playing ? stopPlaying() : startPlaying(); });
stepBtn.addEventListener("click", () => { stopPlaying(); gotoBeat(idx + 1); });
restartBtn.addEventListener("click", () => { stopPlaying(); gotoBeat(0, 0); });
speedSel.addEventListener("change", () => { /* picked up on the next frame */ });
scrub.addEventListener("input", () => { stopPlaying(); gotoBeat(+scrub.value); });

function setPlaybackEnabled(on: boolean) {
  for (const b of [playBtn, stepBtn, restartBtn]) b.disabled = !on;
  scrub.disabled = !on;
}
setPlaybackEnabled(false);
drawIdle();
syncLabels();

document.getElementById("btnHand")!.addEventListener("click", () => {
  const seats = buildSeats();
  if (seats.length < 2) { out.textContent = "Enable at least two seats."; return; }
  const log: HandLog = { lines: [] };
  runTable(seats, 1, Date.now() % 2 ** 31, log);

  stopPlaying();
  frames = log.frames ?? [];
  community = log.community ?? [];
  scrub.max = String(Math.max(0, frames.length - 1));
  setPlaybackEnabled(frames.length > 0);
  gotoBeat(0, 0);

  outTitle.textContent = `Single hand — ${seats.length} seats`;
  out.innerHTML = log.lines.map(esc).join("\n");

  if (!reduceMotion) startPlaying();
});
// ── end animated hand replay ──────────────────────────────────────

document.getElementById("btnSim")!.addEventListener("click", () => {
  const seats = buildSeats();
  if (seats.length < 2) { out.textContent = "Enable at least two seats."; return; }
  const n = Math.max(10, Math.min(20000, +handsInput.value || 2000));
  runTable(seats, n, 4242);
  outTitle.textContent = `Simulation — ${n} hands, ${seats.length} seats`;
  const rows = seats.slice().sort((a, b) => b.stats.net - a.stats.net).map(s => {
    const st = s.stats;
    const net = st.net;
    const cls = net > 0 ? "pos" : net < 0 ? "neg" : "";
    return `<tr>
      <td>${esc(s.name)}</td><td class="mut">${s.p.id}</td>
      <td class="${cls}">${net >= 0 ? "+" : ""}${net}</td>
      <td>${s.chips}</td>
      <td>${st.rebuys}</td>
      <td>${st.hands ? (st.won / st.hands * 100).toFixed(1) : "0.0"}%</td>
      <td>${st.hands ? (st.vpip / st.hands * 100).toFixed(1) : "0.0"}%</td>
      <td>${st.hands ? (st.folds / st.hands * 100).toFixed(1) : "0.0"}%</td>
      <td>${st.showdowns ? (st.showdownWins / st.showdowns * 100).toFixed(1) : "—"}%</td>
      <td class="mut">${st.aggr.join("/")}</td>
      <td>${st.bluffs}</td>
      <td>${st.allIns}</td>
    </tr>`;
  }).join("");
  out.innerHTML = `<table class="stats">
    <tr><th>seat</th><th>persona</th><th>net</th><th>chips</th><th>rebuy</th><th>won</th><th>vpip</th><th>fold</th><th>sd win</th><th>aggr p/f/t/r</th><th>bluffs</th><th>all-ins</th></tr>
    ${rows}</table>
    <div class="note">200 buy-in · blinds 2/4, button rotates · busted seats sit a hand out then rebuy 200 · net = chips − every buy-in · vpip = voluntarily put money in pre-flop · aggr = bets+raises per street (pre-flop/flop/turn/river) · bluff = big bet or raise on a read under 0.35</div>`;
});

/** Metric: net chips of the swept seat after N hands, with everyone else fixed. */
function makeEvaluator(seatIdx: number, n: number) {
  const fixed = seatUIs.map(s => s.getP());
  const enabledIdx = seatUIs.map((s, i) => (s.enabled() ? i : -1)).filter(i => i >= 0);
  return (p: Personality): number => {
    const seats = enabledIdx.map((idx, k) => newSeat(`s${k}`, seatUIs[idx].getName(), idx === seatIdx ? p : fixed[idx]));
    runTable(seats, n, 8080);
    const target = seats.find((_, k) => enabledIdx[k] === seatIdx)!;
    return target.stats.net; // chips minus every buy-in, so rebuys count against you
  };
}

document.getElementById("btnSweep")!.addEventListener("click", () => {
  if (!sweepSeatSel.value) { out.textContent = "Enable at least one seat to sweep."; return; }
  const seatIdx = +sweepSeatSel.value;
  const trait = sweepTraitSel.value as TraitKey;
  const base = seatUIs[seatIdx].getP();
  const evaluate = makeEvaluator(seatIdx, 400);
  const r = sweepTrait(base, trait, evaluate, 11);

  outTitle.textContent = `Sweep — ${seatUIs[seatIdx].getName()}'s ${trait}, net chips as it moves 0.0 → 1.0 (400 hands/step)`;
  const rows = r.points.map(p => `<tr><td>${p.value.toFixed(1)}</td><td>${p.metric >= 0 ? "+" : ""}${p.metric.toFixed(0)}</td></tr>`).join("");
  out.innerHTML =
    `<div class="summary">best <b>${r.best.value.toFixed(2)}</b> (${r.best.metric >= 0 ? "+" : ""}${r.best.metric.toFixed(0)} chips) · worst <b>${r.worst.value.toFixed(2)}</b> (${r.worst.metric >= 0 ? "+" : ""}${r.worst.metric.toFixed(0)}) · impact <b>${r.impact.toFixed(0)} chips</b> · ${shapeArrow(r.shape)} ${SHAPE_LABEL[r.shape]}</div>` +
    `<table class="stats"><tr><th>${trait}</th><th>net chips</th></tr>${rows}</table>` +
    `<div class="lockrow"><button id="lockBest">Lock to best (${r.best.value.toFixed(2)})</button><button id="lockWorst" class="ghost">Lock to worst (${r.worst.value.toFixed(2)})</button></div>`;
  document.getElementById("lockBest")!.addEventListener("click", () => applyLock(seatIdx, trait, r.best.value));
  document.getElementById("lockWorst")!.addEventListener("click", () => applyLock(seatIdx, trait, r.worst.value));
});

function applyLock(seatIdx: number, trait: TraitKey, value: number) {
  const p = setTrait(seatUIs[seatIdx].getP(), trait, value);
  seatUIs[seatIdx].setP(p);
  lockMarksOf(seatIdx)[trait].textContent = "🔒";
}

document.getElementById("btnSweepAll")!.addEventListener("click", () => {
  if (!sweepSeatSel.value) { out.textContent = "Enable at least one seat to sweep."; return; }
  const seatIdx = +sweepSeatSel.value;
  const base = seatUIs[seatIdx].getP();
  const evaluate = makeEvaluator(seatIdx, 200);
  const results = sweepAll(base, evaluate, 9);

  outTitle.textContent = `Sweep all — every trait on ${seatUIs[seatIdx].getName()}, ranked by impact (200 hands/step, 9 steps)`;
  const rows = results.map(r =>
    `<tr><td>${r.trait}</td><td>${r.impact.toFixed(0)} chips</td><td>${shapeArrow(r.shape)} ${SHAPE_LABEL[r.shape]}</td><td>${r.best.value.toFixed(2)} (${r.best.metric >= 0 ? "+" : ""}${r.best.metric.toFixed(0)})</td><td><button class="mini" data-trait="${r.trait}" data-value="${r.best.value}">lock best</button></td></tr>`
  ).join("");
  out.innerHTML = `<table class="stats"><tr><th>trait</th><th>impact</th><th>shape</th><th>best</th><th></th></tr>${rows}</table>`;
  out.querySelectorAll<HTMLButtonElement>(".mini").forEach(btn => {
    btn.addEventListener("click", () => applyLock(seatIdx, btn.dataset.trait as TraitKey, +btn.dataset.value!));
  });
});

/** Optimizer stage 2: evolve all 7 traits of one seat at once against the fixed table. */
document.getElementById("btnEvolve")!.addEventListener("click", () => {
  if (!sweepSeatSel.value) { out.textContent = "Enable at least one seat to evolve."; return; }
  const seatIdx = +sweepSeatSel.value;
  const base = seatUIs[seatIdx].getP();
  const POP = 14, GENS = 10, N = 100;
  const evaluate = makeEvaluator(seatIdx, N);
  const chips = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(0)}`;
  const genRows: string[] = [];
  const r = evolve({
    evaluate, base, seed: 9000, popSize: POP, generations: GENS,
    onGeneration: g => genRows.push(`<tr><td>${g.generation}</td><td>${chips(g.bestFitness)}</td><td>${chips(g.meanFitness)}</td></tr>`),
  });

  outTitle.textContent = `Evolve — ${seatUIs[seatIdx].getName()}, pop ${POP} × ${GENS} generations (${r.evaluations} evaluations × ${N} hands = ${r.evaluations * N} hands)`;
  const gene = (t: TraitKey) => t === "randomness" ? r.best.randomness : r.best.traits[t];
  const vector = TRAITS.map(t => `${t} <b>${gene(t).toFixed(2)}</b>`).join(" · ");
  out.innerHTML =
    `<div class="summary">best net chips <b>${chips(r.bestFitness)}</b> · started at ${chips(r.history[0].bestFitness)}</div>` +
    `<table class="stats"><tr><th>gen</th><th>best net</th><th>mean net</th></tr>${genRows.join("")}</table>` +
    `<div class="summary">${vector}</div>` +
    `<div class="lockrow"><button id="applyEvolved">Apply best to ${seatUIs[seatIdx].getName()}</button></div>`;
  document.getElementById("applyEvolved")!.addEventListener("click", () => {
    seatUIs[seatIdx].setP(r.best);
    const marks = lockMarksOf(seatIdx);
    for (const t of TRAITS) marks[t].textContent = "🧬";
  });
});
