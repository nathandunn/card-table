import { ARCHETYPES, CORE_TRAITS, type Personality } from "@precog/sim-core";
import { newSeat, runTable, type Seat, type HandLog } from "./game.js";
import { sweepTrait, sweepAll, SHAPE_LABEL, setTrait, type TraitKey } from "@precog/agent-forge/dist/sweep.js";

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
for (let i = 0; i < 6; i++) makeSeat(i);

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
refreshSweepSeatOptions();

function buildSeats(): Seat[] {
  return seatUIs.filter(s => s.enabled()).map((s, i) => newSeat(`s${i}`, s.getName(), s.getP()));
}
function lockMarksOf(idx: number) { return (tableEl.children[idx] as any)._lockMarks as Record<string, HTMLElement>; }
const esc = (s: string) => s.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));
function shapeArrow(shape: string) {
  return ({ up: "↑", down: "↓", peaked: "▲", valley: "▼", flat: "–" } as Record<string, string>)[shape] ?? "";
}

document.getElementById("btnHand")!.addEventListener("click", () => {
  const seats = buildSeats();
  if (seats.length < 2) { out.textContent = "Enable at least two seats."; return; }
  const log: HandLog = { lines: [] };
  runTable(seats, 1, Date.now() % 2 ** 31, log);
  outTitle.textContent = `Single hand — ${seats.length} seats`;
  out.innerHTML = log.lines.map(esc).join("\n");
});

document.getElementById("btnSim")!.addEventListener("click", () => {
  const seats = buildSeats();
  if (seats.length < 2) { out.textContent = "Enable at least two seats."; return; }
  const n = Math.max(10, Math.min(20000, +handsInput.value || 2000));
  runTable(seats, n, 4242);
  outTitle.textContent = `Simulation — ${n} hands, ${seats.length} seats`;
  const rows = seats.slice().sort((a, b) => b.chips - a.chips).map(s => {
    const st = s.stats;
    const net = s.chips - 200;
    const cls = net > 0 ? "pos" : net < 0 ? "neg" : "";
    return `<tr>
      <td>${esc(s.name)}</td><td class="mut">${s.p.id}</td>
      <td class="${cls}">${net >= 0 ? "+" : ""}${net}</td>
      <td>${s.chips}</td>
      <td>${st.hands ? (st.won / st.hands * 100).toFixed(1) : "0.0"}%</td>
      <td>${st.hands ? (st.vpip / st.hands * 100).toFixed(1) : "0.0"}%</td>
      <td>${st.hands ? (st.folds / st.hands * 100).toFixed(1) : "0.0"}%</td>
      <td>${st.showdowns ? (st.showdownWins / st.showdowns * 100).toFixed(1) : "—"}%</td>
    </tr>`;
  }).join("");
  out.innerHTML = `<table class="stats">
    <tr><th>seat</th><th>persona</th><th>net</th><th>chips</th><th>won</th><th>vpip</th><th>fold</th><th>sd win</th></tr>
    ${rows}</table>
    <div class="note">each seat starts at 200 chips · ante 2 · bet 10 · vpip = voluntarily put money in pot</div>`;
});

/** Metric: net chips of the swept seat after N hands, with everyone else fixed. */
function makeEvaluator(seatIdx: number, n: number) {
  const fixed = seatUIs.map(s => s.getP());
  const enabledIdx = seatUIs.map((s, i) => (s.enabled() ? i : -1)).filter(i => i >= 0);
  return (p: Personality): number => {
    const seats = enabledIdx.map((idx, k) => newSeat(`s${k}`, seatUIs[idx].getName(), idx === seatIdx ? p : fixed[idx]));
    runTable(seats, n, 8080);
    const target = seats.find((_, k) => enabledIdx[k] === seatIdx)!;
    return target.chips - 200;
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
