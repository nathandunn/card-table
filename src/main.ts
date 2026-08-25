import { ARCHETYPES, CORE_TRAITS, type Personality } from "@precog/sim-core";
import { newSeat, runTable, type Seat, type HandLog } from "./game.js";

const TRAITS = [...CORE_TRAITS, "randomness"] as const;
const ARCH = Object.keys(ARCHETYPES);
const clone = (p: Personality): Personality => JSON.parse(JSON.stringify(p));

interface SeatUI { getP: () => Personality; getName: () => string; enabled: () => boolean; }
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
  const sl: Record<string, HTMLInputElement> = {}, vv: Record<string, HTMLElement> = {};
  for (const t of TRAITS) {
    const row = document.createElement("div"); row.className = "trait";
    const n = document.createElement("span"); n.textContent = t.slice(0, 7);
    const inp = document.createElement("input");
    inp.type = "range"; inp.min = "0"; inp.max = "1"; inp.step = "0.05";
    const v = document.createElement("span"); v.className = "v";
    row.append(n, inp, v); wrap.append(row); sl[t] = inp; vv[t] = v;
    inp.addEventListener("input", () => { v.textContent = (+inp.value).toFixed(2); });
  }
  const apply = (p: Personality) => {
    for (const t of CORE_TRAITS) { sl[t].value = String(p.traits[t]); vv[t].textContent = p.traits[t].toFixed(2); }
    sl.randomness.value = String(p.randomness); vv.randomness.textContent = p.randomness.toFixed(2);
  };
  apply(clone(ARCHETYPES[sel.value]));
  sel.addEventListener("change", () => apply(clone(ARCHETYPES[sel.value])));
  const sync = () => wrap.classList.toggle("off", !on.checked);
  on.addEventListener("change", sync); sync();
  tableEl.append(wrap);
  seatUIs.push({
    enabled: () => on.checked,
    getName: () => nm.value || `Seat ${i + 1}`,
    getP: () => {
      const traits: Record<string, number> = {};
      for (const t of CORE_TRAITS) traits[t] = +sl[t].value;
      return { id: sel.value, name: sel.value, archetype: sel.value, traits: traits as Personality["traits"], randomness: +sl.randomness.value };
    },
  });
}
for (let i = 0; i < 6; i++) makeSeat(i);

const out = document.getElementById("out")!;
const outTitle = document.getElementById("outTitle")!;
const handsInput = document.getElementById("hands") as HTMLInputElement;

function buildSeats(): Seat[] {
  return seatUIs.filter(s => s.enabled()).map((s, i) => newSeat(`s${i}`, s.getName(), s.getP()));
}
const esc = (s: string) => s.replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));

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
