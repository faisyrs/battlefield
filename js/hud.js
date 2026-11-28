// Phase-aware single-screen HUD for the 40K Battlefield table.
// Loaded as a module after the main script; it uses the main script's globals
// (units, selected, render, snap, unit, loadedMetadata, cloud* helpers) and the shared engine.
import * as E from "./engine.js";

const $ = (id) => document.getElementById(id);
const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, "");
    else if (v != null && v !== false) n.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return n;
};
const SIDE_SHORT = { ork: "ORK", da: "DA" };
const SIDE_COLOR = { ork: "#c8553f", da: "#2a9d76" };
const d6 = () => 1 + Math.floor(Math.random() * 6);

/* ---------- state access ---------- */
function gs() {
  loadedMetadata.board ??= { width: 44, height: 60 };
  loadedMetadata.units = units; // live reference; cloudState() overrides with a clone
  return E.upgradeState(loadedMetadata);
}
const selUnit = () => (typeof unit === "function" ? unit() : null);
const features = () => (activeCatalogMap?.features || []);
const objectives = () => E.objectivesFromFeatures(features());
const terrain = () => E.terrainContext(features(), gs().obstacles);
const online = () => !!(cloudSession && cloudGameId && cloudRevision !== null);

/* ---------- styles ---------- */
document.head.append(el("style", {}, `
#hudTurn,#hudScore{font:600 12px system-ui;padding:5px 8px;border-radius:6px;border:1px solid #5d7786;background:#263b49;color:#eef5f8;white-space:nowrap}
#hudTurn .ph{color:#ffe080}#hudScore b{font-size:13px}#hudScore .cp{color:#9fb6c3;font-weight:400}
@media(max-width:640px){#hudTurn,#hudScore{padding:4px 5px;font-size:11px}#unitCard{max-width:72vw}#unitCard .pip{min-width:17px;height:17px;font-size:10px}}
#hudScore{position:absolute;left:8px;top:40px;z-index:3;background:#14242de0}
#phaseBar{flex:0 0 auto;display:flex;gap:4px;align-items:center;padding:4px 6px;background:#16242e;border-top:1px solid #344956;overflow-x:auto;z-index:6}
#phaseBar button{flex:0 0 auto;padding:7px 9px;font-size:12.5px;white-space:nowrap}
#phaseBar .next{margin-left:auto;background:#226c89;font-weight:700;position:sticky;right:0;box-shadow:-8px 0 10px #16242e}
#phaseBar .tag{font:700 11px system-ui;color:#9fb6c3;padding:0 4px;white-space:nowrap}
#unitCard{position:absolute;right:8px;top:8px;z-index:4;max-width:min(300px,62vw);background:#14242df0;border:1px solid #4e6878;border-radius:10px;padding:7px 9px;font-size:12px;box-shadow:0 6px 18px #0008}
#unitCard h3{margin:0;font-size:13px;display:flex;gap:6px;align-items:center}
#unitCard .row{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px;align-items:center}
#unitCard button{padding:4px 7px;font-size:12px}
#unitCard .pip{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:20px;border-radius:10px;background:#3a4d59;font:700 11px system-ui;cursor:pointer;border:1px solid #6f8794}
#unitCard .pip.hurt{background:#8f3b2f}#unitCard .chip{background:#2a4150;border-radius:9px;padding:2px 7px;cursor:pointer}
#unitCard .stats{color:#c8d7e0;font-size:11px}#unitCard.min .body{display:none}
#hudToast{position:absolute;left:50%;bottom:8px;transform:translateX(-50%);z-index:9;background:#0d1a22f0;border:1px solid #557080;border-radius:8px;padding:7px 11px;font-size:13px;max-width:92%;display:none}
dialog.hud{width:min(94vw,560px);max-height:84dvh;overflow:auto;background:#1b2a35;color:#eef5f8;border:1px solid #668397;border-radius:12px;padding:12px}
dialog.hud h2{margin:0 0 8px;font-size:16px}dialog.hud h3{margin:10px 0 5px;font-size:13px;color:#ffe080}
dialog.hud .grid{display:grid;grid-template-columns:auto 1fr auto;gap:5px;align-items:center}
dialog.hud .btns{display:flex;flex-wrap:wrap;gap:5px}dialog.hud table{border-collapse:collapse;font-size:12px;width:100%}
dialog.hud td,dialog.hud th{border-bottom:1px solid #33495a;padding:3px 4px;text-align:left}
dialog.hud .muted{color:#9fb6c3;font-size:12px}
#chatLog{max-height:45dvh;overflow:auto;font-size:13px;display:flex;flex-direction:column;gap:4px}
#chatLog .ai{color:#ffd9a0}#chatBadge{background:#c8553f;border-radius:8px;padding:0 5px;margin-left:3px;font-size:11px}
`));

/* ---------- DOM ---------- */
const header = document.querySelector("header");
const turnBtn = el("button", { id: "hudTurn", title: "Turn and phase" });
const scoreBtn = el("button", { id: "hudScore", title: "Victory points and CP" });

turnBtn.onclick = () => openLog();
scoreBtn.onclick = () => openScore();
const phaseBar = el("div", { id: "phaseBar", role: "toolbar", "aria-label": "Phase actions" });
$("bottom-bar").before(phaseBar);
const card = el("div", { id: "unitCard" });
const toastEl = el("div", { id: "hudToast" });
$("boardArea").append(card, toastEl, scoreBtn);
let toastTimer;
function toast(t, ms = 3500) { toastEl.textContent = t; toastEl.style.display = "block"; clearTimeout(toastTimer); toastTimer = setTimeout(() => (toastEl.style.display = "none"), ms); }

function sheet(title, build) {
  document.querySelector("dialog.hud")?.close();
  const d = el("dialog", { class: "hud" });
  const body = el("div");
  d.append(el("h2", {}, title), body, el("div", { class: "btns", style: "margin-top:10px;justify-content:flex-end" }, el("button", { onclick: () => d.close() }, "Close")));
  d.addEventListener("close", () => d.remove());
  document.body.append(d);
  const rebuild = () => { body.replaceChildren(); build(body, rebuild, d); };
  rebuild();
  d.showModal();
  return d;
}

/* ---------- persistence ---------- */
let saving = false;
async function commit(action = "turn", why = "") {
  render();
  if (!online()) { toast((why ? why + " · " : "") + "Local only (sign in and load a cloud game to sync)."); return; }
  if (saving) return;
  saving = true;
  try {
    const state = cloudState();
    const rev = await cloudRequest("/rest/v1/rpc/tabletop_commit", { method: "POST", body: { p_game: cloudGameId, p_expected_revision: cloudRevision, p_state: state, p_action: action } });
    cloudRevision = Number(rev);
    proposalBaseline = JSON.stringify(state);
    $("cloudGameId").textContent = "Game: " + cloudGameId + " · revision " + cloudRevision;
    if (why) toast(why + " · saved r" + cloudRevision);
  } catch (e) {
    if (/Revision conflict/.test(e.message)) {
      toast("The game changed elsewhere. Reloading the latest version; redo your last action.", 6000);
      const g = await cloudRequest("/rest/v1/tabletop_games?id=eq." + encodeURIComponent(cloudGameId) + "&select=revision,state");
      await cloudLoadState(g[0].state);
      cloudRevision = Number(g[0].revision);
      proposalBaseline = JSON.stringify(cloudState());
    } else toast("Save failed: " + e.message, 6000);
  } finally { saving = false; }
}

/* ---------- datasheets ---------- */
let sheets = null;
async function loadSheets() {
  if (sheets || !cloudSession) return sheets;
  try { sheets = await cloudRequest("/rest/v1/datasheets?edition=eq.11&select=faction,slug,name,base,profiles,ranged,melee,abilities,keywords,leader_of,source_url&limit=1000"); }
  catch { sheets = null; return null; }
  // Filling stats from datasheets must not count as an unsaved local edit.
  const clean = typeof proposalBaseline === "string" && proposalBaseline === JSON.stringify(cloudState());
  applySheets();
  if (clean) proposalBaseline = JSON.stringify(cloudState());
  return sheets;
}
const baseName = (n) => String(n || "").replace(/^(left|right|center|centre)\s+/i, "").replace(/\s*(—.*|×\s*\d+|x\s*\d+|\d+)$/i, "").replace(/^\d+\s+/, "").trim().toLowerCase();
const ALIASES = { ghaz: "ghazghkull thraka", dakkarig: "big mek dakkarig", lion: "lion el’jonson", vengeance: "land speeder vengeance", incursors: "incursor squad", "sammael ravenwing": "sammael", "chaplain ravenwing": "ravenwing chaplain" };
function sheetFor(u) {
  if (!sheets?.length || !u) return null;
  if (u.datasheet) { const s = sheets.find((x) => x.slug === u.datasheet || x.name === u.datasheet); if (s) return s; }
  let n = baseName(u.name); n = ALIASES[n] || n;
  return sheets.find((s) => s.name.toLowerCase() === n) || sheets.find((s) => s.name.toLowerCase().replace(/[’']/g, "") === n.replace(/[’']/g, "")) || sheets.find((s) => n.length > 3 && s.name.toLowerCase().startsWith(n)) || null;
}
function applySheets() {
  for (const u of units) {
    const s = sheetFor(u);
    if (!s) continue;
    u.datasheet ??= s.slug;
    const p = s.profiles?.[0];
    if (p && u.wounds == null && Number(p.W)) { u.wounds = Number(p.W); u.models.forEach((m) => (m.wounds ??= u.wounds)); }
    if (p && u.oc == null && p.OC != null && !isNaN(Number(p.OC))) u.oc = Number(p.OC);
    if (!u.keywords?.length && s.keywords?.length) u.keywords = s.keywords;
  }
}
const maxRange = (s) => Math.max(0, ...((s?.ranged || []).map((w) => parseFloat(String(w.range).replace(/[^0-9.]/g, "")) || 0)));

/* ---------- overlays ---------- */
let rings = false, losTarget = null, drawObstacle = null;
const baseDrawCatalogMap = window.drawCatalogMap;
window.drawCatalogMap = function (data) {
  baseDrawCatalogMap(data);
  try {
    const st = gs(), Sx = 20;
    for (const o of st.obstacles || []) {
      ctx.beginPath();
      o.polygon.forEach(([x, y], i) => (i ? ctx.lineTo(x * Sx, y * Sx) : ctx.moveTo(x * Sx, y * Sx)));
      ctx.closePath();
      ctx.fillStyle = o.kind === "low" ? "#8a6a3a88" : "#2b2b2bcc";
      ctx.strokeStyle = o.kind === "low" ? "#d9b06a" : "#000";
      ctx.lineWidth = 2;
      ctx.fill(); ctx.stroke();
    }
    const oc = E.objectiveControl(st, objectives());
    for (const o of oc.objectives) {
      const r = (E.OBJECTIVE_RANGE + E.OBJECTIVE_MARKER_MM / 25.4 / 2) * Sx;
      ctx.beginPath(); ctx.arc(o.x * Sx, o.y * Sx, r, 0, Math.PI * 2);
      ctx.fillStyle = o.controller ? SIDE_COLOR[o.controller] + "33" : "#ffffff10";
      ctx.strokeStyle = o.controller ? SIDE_COLOR[o.controller] : "#ffffff70";
      ctx.lineWidth = 2; ctx.setLineDash([6, 5]); ctx.fill(); ctx.stroke(); ctx.setLineDash([]);
      if (o.oc.ork || o.oc.da) {
        ctx.font = "bold 15px system-ui"; ctx.textAlign = "center"; ctx.fillStyle = "#fff"; ctx.strokeStyle = "#000"; ctx.lineWidth = 3;
        const t = o.oc.ork + " : " + o.oc.da;
        ctx.strokeText(t, o.x * Sx, o.y * Sx - r - 4); ctx.fillText(t, o.x * Sx, o.y * Sx - r - 4);
      }
    }
  } catch (e) { console.warn("overlay", e); }
};

const baseDrawMarker = window.drawMarker;
window.drawMarker = function (u, sel) {
  baseDrawMarker(u, sel);
  try {
    const Sx = 20;
    if (u.wounds) for (const m of u.models) {
      if (m.wounds == null || m.wounds >= u.wounds) continue;
      const p = E.modelCenter(u, m);
      ctx.beginPath(); ctx.arc(p.x * Sx, p.y * Sx, 7, 0, Math.PI * 2); ctx.fillStyle = "#d33"; ctx.fill();
      ctx.font = "bold 10px system-ui"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = "#fff"; ctx.fillText(String(m.wounds), p.x * Sx, p.y * Sx + 0.5); ctx.textBaseline = "alphabetic";
    }
    if (u.effects?.length) {
      const p = E.modelCenter(u, u.models[0] || { x: 0, y: 0 });
      ctx.font = "bold 11px system-ui"; ctx.textAlign = "left"; ctx.fillStyle = "#ffe080"; ctx.strokeStyle = "#000"; ctx.lineWidth = 3;
      const t = u.effects.map((e) => e.label.split(/[ /]/)[0]).join("·");
      ctx.strokeText(t, p.x * Sx + 10, p.y * Sx + 18); ctx.fillText(t, p.x * Sx + 10, p.y * Sx + 18);
    }
  } catch (e) { console.warn("marker", e); }
};

const baseDrawPending = window.drawPendingProposals;
window.drawPendingProposals = function () {
  if (typeof baseDrawPending === "function") baseDrawPending();
  try {
    const Sx = 20, u = selUnit();
    if (rings && u && E.isOnTable(u)) {
      const s = sheetFor(u), ranges = [...new Set((s?.ranged || []).map((w) => parseFloat(String(w.range).replace(/[^0-9.]/g, ""))).filter((n) => n > 0))].sort((a, b) => a - b);
      const show = ranges.length ? ranges : [E.allowance(u) || 6, 12];
      show.forEach((rg, k) => {
        ctx.strokeStyle = ["#ffe15c", "#ff9f43", "#ff6b6b", "#c56cf0"][k % 4]; ctx.lineWidth = 1.5; ctx.setLineDash([4, 4]);
        for (const poly of E.modelPolygons(u)) {
          const c = poly.reduce((a, p) => [a[0] + p[0] / poly.length, a[1] + p[1] / poly.length], [0, 0]);
          const r = Math.max(...poly.map((p) => Math.hypot(p[0] - c[0], p[1] - c[1])));
          ctx.beginPath(); ctx.arc(c[0] * Sx, c[1] * Sx, (rg + r) * Sx, 0, Math.PI * 2); ctx.stroke();
        }
        ctx.setLineDash([]);
        ctx.font = "bold 13px system-ui"; ctx.fillStyle = ctx.strokeStyle; ctx.fillText(rg + "″", (u.x + rg + 1) * Sx, u.y * Sx - 4 - k * 14);
      });
    }
    if (losTarget && u) {
      const t = units.find((v) => v.id === losTarget);
      if (t && E.isOnTable(t) && E.isOnTable(u)) {
        const vis = E.unitVisibility(terrain(), u, t);
        ctx.strokeStyle = vis.targetModelsVisible ? "#5cff8a" : "#ff5c5c"; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(u.x * Sx, u.y * Sx); ctx.lineTo(t.x * Sx, t.y * Sx); ctx.stroke();
        ctx.font = "bold 16px system-ui"; ctx.fillStyle = ctx.strokeStyle; ctx.textAlign = "center";
        ctx.fillText(vis.distance.toFixed(1) + "″ · " + vis.targetModelsVisible + "/" + vis.targetModelsTotal + " visible" + (vis.targetInCover ? " · cover" : ""), ((u.x + t.x) / 2) * Sx, ((u.y + t.y) / 2) * Sx - 8);
      }
    }
    if (drawObstacle?.points.length) {
      ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.beginPath();
      drawObstacle.points.forEach(([x, y], i) => (i ? ctx.lineTo(x * Sx, y * Sx) : ctx.moveTo(x * Sx, y * Sx)));
      ctx.stroke();
    }
  } catch (e) { console.warn("overlay2", e); }
};

const baseRender = window.render;
window.render = function () { baseRender(); try { updateHud(); } catch (e) { console.warn("hud", e); } };

const baseLoad = window.cloudLoadState;
window.cloudLoadState = async function (state) {
  await baseLoad(state);
  gs();
  if (sheets) applySheets(); else loadSheets().then(() => render());
  losTarget = null;
  render();
};

/* ---------- top bar ---------- */
function updateTop() {
  const st = gs(), t = st.turn;
  turnBtn.replaceChildren("R" + t.round + " · ", el("span", { style: "color:" + SIDE_COLOR[t.active] }, SIDE_SHORT[t.active]), " · ", el("span", { class: "ph" }, t.over ? "Game over" : E.PHASE_LABEL[t.phase]));
  scoreBtn.replaceChildren(...E.SIDES.flatMap((s, i) => [i ? " | " : "", el("span", { style: "color:" + SIDE_COLOR[s] }, SIDE_SHORT[s] + " "), el("b", {}, E.vpTotal(st.score[s])), el("span", { class: "cp" }, " " + st.score[s].cp + "CP")]));
}

/* ---------- phase bar ---------- */
const btn = (label, fn, opts = {}) => el("button", { onclick: fn, class: opts.cls || "", title: opts.title || "", disabled: opts.disabled || false }, label);
function mineSelected() { const u = selUnit(), t = gs().turn; return u && u.side === t.active ? u : null; }

function updatePhaseBar() {
  const st = gs(), t = st.turn, u = selUnit();
  const mine = mineSelected(), onTable = u && E.isOnTable(u);
  const kids = [turnBtn];
  if (t.phase === "command") {
    kids.push(btn("Battle-shock", () => battleShock(u), { disabled: !u || !onTable, title: "Roll 2D6 vs Leadership for the selected unit" }));
    kids.push(btn("Score", openScore));
  }
  if (t.phase === "movement") {
    kids.push(btn("Advance", () => advanceUnit(u), { disabled: !mine || !onTable || E.hasEffect(u, "Advanced") }));
    kids.push(btn("Fall back", () => tag(u, "Fell back"), { disabled: !mine || !onTable }));
    kids.push(btn("Stationary", () => tag(u, "Remained stationary"), { disabled: !mine || !onTable }));
    if (t.round >= 2 || st.units.some((v) => v.side === t.active && v.locationState === "reserves")) kids.push(btn("Reserves", openReserves));
    kids.push(btn("Coherency", () => { const c = E.coherencyAll(st, t.active); toast(c.length ? c.map((x) => x.unit + ": " + x.issues.join("; ")).join(" | ") : "All units in coherency."); }));
  }
  if (t.phase === "shooting") {
    kids.push(btn("Targets", () => openTargets(u), { disabled: !onTable }));
    kids.push(btn(rings ? "Rings ✓" : "Rings", () => { rings = !rings; render(); }, { disabled: !onTable }));
    kids.push(btn("Shot ✓", () => tag(u, "Shot"), { disabled: !mine || !onTable }));
  }
  if (t.phase === "charge") {
    kids.push(btn("Charge 2D6", () => chargeUnit(u), { disabled: !mine || !onTable }));
    kids.push(btn("Targets", () => openTargets(u, 12), { disabled: !onTable }));
  }
  if (t.phase === "fight") {
    kids.push(btn("Pile in 3″", () => pileIn(u, "Pile in"), { disabled: !onTable }));
    kids.push(btn("Consolidate 3″", () => pileIn(u, "Consolidate"), { disabled: !onTable }));
    kids.push(btn("Fought ✓", () => tag(u, "Fought"), { disabled: !onTable }));
  }
  kids.push(btn("Dice", openDice), btn(chatLabel(), openChat), btn("Log", openLog));
  kids.push(btn(t.over ? "Game over" : nextLabel(t) + " ▸", nextPhase, { cls: "next", disabled: !!t.over }));
  phaseBar.replaceChildren(...kids);
}
function nextLabel(t) { const i = E.PHASES.indexOf(t.phase); return i < E.PHASES.length - 1 ? E.PHASE_LABEL[E.PHASES[i + 1]] : "End turn"; }

/* ---------- unit card ---------- */
let cardMin = window.innerWidth < 640;
function updateCard() {
  const u = selUnit();
  if (!u) { card.style.display = "none"; return; }
  card.style.display = "block";
  card.classList.toggle("min", cardMin);
  const s = sheetFor(u), p = s?.profiles?.[0];
  const lost = u.casualties?.length || 0, alive = u.models.length;
  const head = el("h3", {}, el("span", { style: "color:" + SIDE_COLOR[u.side] }, "●"), u.name, el("small", { style: "margin-left:auto;color:#9fb6c3" }, alive + "/" + (alive + lost)), btn(cardMin ? "▸" : "▾", () => { cardMin = !cardMin; updateCard(); }));
  const body = el("div", { class: "body" });
  if (p) body.append(el("div", { class: "stats" }, ["M", "T", "Sv", "W", "Ld", "OC"].map((k) => k + " " + (p[k] ?? "–")).join(" · ") + (p.invuln ? " · " + p.invuln + "++" : "")));
  if (E.isOnTable(u) && gs().obstacles?.length && u.origin) {
    const issues = E.terrainMoveIssues(terrain(), { ...u, x: u.origin.x, y: u.origin.y, angle: u.origin.angle, models: u.models }, u.x, u.y, u.angle);
    if (issues.length) head.append(el("span", { title: issues.join("; "), style: "color:#ff8a65" }, "⚠"));
    if (issues.length) body.append(el("div", { style: "color:#ff8a65" }, issues.join("; ")));
  }
  if (u.locationState !== "deployed") body.append(el("div", { class: "stats" }, "Status: " + u.locationState + (u.needsEmergencyDisembark ? " · emergency disembark!" : "")));
  if (u.wounds && alive <= 20) body.append(el("div", { class: "row" }, u.models.map((m, i) => el("span", { class: "pip" + (m.wounds < u.wounds ? " hurt" : ""), title: "Model " + (i + 1) + ": tap to deal 1 damage", onclick: () => hurt(u, 1, i) }, m.wounds ?? u.wounds))));
  const W = el("input", { type: "number", min: 1, max: 30, value: u.wounds ?? "", style: "width:46px;padding:3px", title: "Wounds per model" });
  W.onchange = () => {
    snap();
    const old = u.wounds, nw = Number(W.value) || null;
    u.wounds = nw;
    if (nw) u.models.forEach((m) => (m.wounds = m.wounds == null || old == null || m.wounds === old ? nw : Math.min(m.wounds, nw)));
    commit("damage", u.name + ": W " + (nw ?? "unknown"));
  };
  body.append(el("div", { class: "row" },
    u.locationState === "destroyed"
      ? btn("Restore unit", () => { snap(); E.restoreUnit(gs(), u); commit("damage", u.name + " restored"); })
      : [btn("−1 W", () => hurt(u, 1)), btn("Damage…", () => openDamage(u)), btn("−Model", () => { snap(); E.removeModelCount(gs(), u, 1); commit("damage", u.name + ": model removed"); }, { disabled: !alive }), btn("+Model", () => { snap(); E.reviveModel(gs(), u); commit("damage", u.name + ": model returned"); }, { disabled: !lost }), btn("Destroy", () => { if (confirm("Destroy " + u.name + "?")) { snap(); E.destroyUnit(gs(), u); commit("damage", u.name + " destroyed"); } })],
    el("label", { class: "stats" }, "W ", W)));
  body.append(el("div", { class: "row" },
    (u.effects || []).map((e) => el("span", { class: "chip", title: "Tap to remove · expires " + (typeof e.expires === "string" ? e.expires.replace(/_/g, " ") : "later"), onclick: () => { snap(); E.removeEffect(gs(), u, e.id); commit("effect"); } }, e.label, " ×")),
    btn("+Effect", () => openEffects(u)), s ? btn("Datasheet", () => openSheet(u, s)) : btn("Link sheet", () => openLink(u))));
  card.replaceChildren(head, body);
}

function updateHud() { updateTop(); updatePhaseBar(); updateCard(); }

/* ---------- actions ---------- */
function tag(u, label) { if (!u) return; snap(); const q = E.QUICK_EFFECTS.find((x) => x.label === label) || { label }; E.addEffect(gs(), u, q); commit("effect", u.name + ": " + label); }
function hurt(u, n, model) { snap(); const r = E.applyWounds(gs(), u, n, { model }); commit("damage", u.name + (r.destroyed ? " destroyed" : r.removed ? ": " + r.removed + " model(s) removed" : ": " + n + " damage")); }
function advanceUnit(u) { if (!u) return; snap(); const r = d6(); u.bonus = r; E.addEffect(gs(), u, { label: "Advanced", expires: "end_of_turn" }); commit("move", u.name + " advances +" + r + "″ (allowance " + E.allowance(u) + "″)"); }
function chargeUnit(u) {
  if (!u) return; snap();
  const r = d6() + d6();
  E.resetOrigin(u); u.bonus = r - Number(u.move || 0);
  E.addEffect(gs(), u, { label: "Charged", expires: "end_of_turn" });
  const near = units.filter((v) => v.side !== u.side && E.isOnTable(v)).map((v) => ({ v, d: E.unitDistance(u, v) })).sort((a, b) => a.d - b.d)[0];
  commit("move", u.name + " charge roll " + r + "″" + (near ? " · nearest enemy " + near.v.name + " " + near.d.toFixed(1) + "″" + (near.d - 1 <= r ? " ✓ reachable" : " ✗ short") : ""));
}
function pileIn(u, label) { if (!u) return; snap(); E.resetOrigin(u); u.bonus = E.PILE_IN - Number(u.move || 0); commit("move", u.name + ": " + label + " up to 3″ (drag the unit)"); }
function battleShock(u) {
  if (!u) return;
  const s = sheetFor(u), ld = parseInt(String(s?.profiles?.[0]?.Ld ?? "").replace("+", "")) || null;
  const a = d6(), b = d6(), r = a + b;
  if (ld == null) { toast("Rolled " + a + "+" + b + " = " + r + ". No Leadership on file; decide pass/fail.", 6000); return; }
  snap();
  if (r >= ld) { E.removeEffect(gs(), u, "Battle-shocked"); commit("effect", u.name + " passes battle-shock (" + r + " vs " + ld + "+)"); }
  else { E.addEffect(gs(), u, E.QUICK_EFFECTS.find((x) => x.label === "Battle-shocked")); commit("effect", u.name + " is battle-shocked (" + r + " vs " + ld + "+)"); }
}
async function nextPhase() {
  const st = gs(), t = st.turn;
  if (t.phase === "movement") {
    const c = E.coherencyAll(st, t.active);
    if (c.length && !confirm("Coherency warnings:\n" + c.map((x) => x.unit + ": " + x.issues.join("; ")).join("\n") + "\n\nConfirm end of phase? (Cancel to go back)")) return;
  }
  const endTurn = t.phase === "fight";
  snap();
  const r = E.advancePhase(st);
  rings = false; losTarget = null;
  await commit("turn", "Now: R" + r.to.round + " " + SIDE_SHORT[r.to.active] + " " + E.PHASE_LABEL[r.to.phase] + (r.expired.length ? " · " + r.expired.length + " effect(s) expired" : ""));
  if (r.gameOver) { toast("Game over! " + E.SIDES.map((s) => SIDE_SHORT[s] + " " + E.vpTotal(st.score[s])).join(" – "), 10000); openScore(); return; }
  if (endTurn || r.to.phase === "command") openScore({ prompt: endTurn ? "End of " + SIDE_SHORT[r.from.active] + " turn: score end-of-turn conditions." : "Command phase: score command-phase conditions.", forSide: endTurn ? r.from.active : r.to.active, phase: endTurn ? "end_of_turn" : "command", round: r.from.round });
}

/* ---------- sheets ---------- */
async function mcp(name, args) {
  const r = await fetch(CLOUD_URL + "/functions/v1/battlefield-mcp", { method: "POST", headers: { apikey: CLOUD_KEY, authorization: "Bearer " + cloudSession.access_token, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  const j = await r.json();
  if (j.error) throw Error(j.error.message);
  return JSON.parse(j.result.content[0].text);
}

function openScore(ctx = {}) {
  sheet("Score", async (b, rebuild) => {
    const st = gs();
    if (ctx.prompt) b.append(el("p", { class: "muted" }, ctx.prompt));
    const oc = E.objectiveControl(st, objectives());
    if (oc.objectives.length) b.append(el("p", { class: "muted" }, "Objectives held: " + E.SIDES.map((s) => SIDE_SHORT[s] + " " + oc.held[s]).join(" · ") + " (" + oc.objectives.length + " total)"));
    for (const s of E.SIDES) {
      const sc = st.score[s];
      b.append(el("h3", { style: "color:" + SIDE_COLOR[s] }, E.SIDE_LABEL[s] + " — " + E.vpTotal(sc) + " VP"));
      const g = el("div", { class: "grid" });
      for (const k of ["primary", "secondary", "cp"]) {
        g.append(el("span", {}, k === "cp" ? "CP" : k[0].toUpperCase() + k.slice(1)), el("b", {}, sc[k]),
          el("span", { class: "btns" }, [-1, 1, ...(k === "cp" ? [] : [3, 5])].map((dlt) => btn((dlt > 0 ? "+" : "") + dlt, () => { E.addVP(st, s, k, dlt, "manual"); commit("score"); rebuild(); }))));
      }
      b.append(g);
      const cards = sc.secondaries || [];
      b.append(el("div", { class: "btns", style: "margin-top:5px" }, cards.map((c, i) => el("span", { class: "chip", style: "background:#2a4150;border-radius:9px;padding:3px 8px" }, (c.done ? "✓ " : "") + c.name + " (" + c.mode[0] + ")", " ", btn(c.done ? "↺" : "✓", () => { c.done = !c.done; commit("score"); rebuild(); }), btn("×", () => { cards.splice(i, 1); commit("score"); rebuild(); }))), btn("+ Secondary", () => pickSecondary(s, rebuild))));
    }
    if (online() && st.setup?.orkDisposition) {
      const forSide = ctx.forSide || st.turn.active;
      const box = el("div", { class: "muted" }, "Loading applicable scoring…");
      b.append(el("h3", {}, "Scoring now for " + E.SIDE_LABEL[forSide]), box);
      try {
        const r = await mcp("get_applicable_scoring", { game_id: cloudGameId, side: forSide, phase: ctx.phase || st.turn.phase, battle_round: ctx.round || st.turn.round, scope: "current_phase", active_turn: "self" });
        box.replaceChildren(...(r.missions.length ? r.missions.flatMap((m) => [el("div", {}, el("b", {}, m.name + " "), el("span", { class: "muted" }, m.type + (m.mode ? " " + m.mode : ""))), ...m.conditions.map((c) => el("div", {}, "• " + (c.vp ? c.vp + " VP " : "") + (c.condition || c.per || JSON.stringify(c)) + (c.max ? " (max " + c.max + ")" : "")))]) : [el("div", {}, "Nothing to score in this phase.")]),
          r.missing.length ? el("div", { class: "muted" }, "No scoring data for: " + r.missing.map((m) => m.name).join(", ")) : "");
      } catch (e) { box.textContent = "Scoring lookup failed: " + e.message; }
    }
  });
}

async function pickSecondary(side, done) {
  let list = [];
  try { list = await cloudRequest("/rest/v1/mission_secondary_catalog?edition=eq.11&select=mission_name,fixed_available&order=mission_name"); } catch {}
  sheet("Add secondary — " + E.SIDE_LABEL[side], (b, _r, d) => {
    if (!list.length) b.append(el("p", { class: "muted" }, "Sign in to load the mission catalog."));
    for (const m of list) b.append(el("div", { class: "btns", style: "margin:3px 0" }, el("span", { style: "flex:1" }, m.mission_name),
      btn("Tactical", () => { add(m.mission_name, "tactical"); }), m.fixed_available ? btn("Fixed", () => add(m.mission_name, "fixed")) : ""));
    function add(name, mode) { const st = gs(); st.score[side].secondaries.push({ name, mode, vp: 0, done: false }); commit("score", name + " added"); d.close(); openScore(); }
  });
}

function openDamage(u) {
  sheet("Damage — " + u.name, (b, _r, d) => {
    b.append(el("p", { class: "muted" }, "Either total wounds (spills over), or failed saves × Damage (no spill-over). Wounded models take damage first."));
    const n = el("input", { type: "number", min: 1, value: 1, style: "width:70px" }), dmg = el("input", { type: "number", min: 1, value: 1, style: "width:70px" });
    b.append(el("div", { class: "btns" }, el("label", {}, "Failed saves / wounds ", n), el("label", {}, " Damage each ", dmg)));
    b.append(el("div", { class: "btns", style: "margin-top:8px" },
      btn("Apply as failed saves", () => { snap(); const r = E.applyWounds(gs(), u, Number(n.value), { damage: Number(dmg.value) }); d.close(); commit("damage", u.name + ": " + r.removed + " removed, " + r.remaining + " left"); }),
      btn("Apply as total wounds", () => { snap(); const r = E.applyWounds(gs(), u, Number(n.value) * Number(dmg.value)); d.close(); commit("damage", u.name + ": " + r.removed + " removed, " + r.remaining + " left"); })));
  });
}

function openEffects(u) {
  sheet("Effects — " + u.name, (b, _r, d) => {
    b.append(el("div", { class: "btns" }, E.QUICK_EFFECTS.map((q) => btn(q.label, () => { snap(); E.addEffect(gs(), u, q); d.close(); commit("effect", u.name + ": " + q.label); }))));
    const label = el("input", { placeholder: "Custom effect, e.g. +1 to wound", style: "flex:1" });
    const exp = el("select", {}, ["end_of_phase", "end_of_turn", "end_of_round", "start_of_your_command", "manual"].map((x) => el("option", { value: x }, x.replace(/_/g, " "))));
    exp.value = "end_of_turn";
    b.append(el("h3", {}, "Custom"), el("div", { class: "btns" }, label, exp, btn("Add", () => { if (!label.value.trim()) return; snap(); E.addEffect(gs(), u, { label: label.value.trim(), expires: exp.value }); d.close(); commit("effect"); })));
  });
}

function openSheet(u, s) {
  sheet(s.name, (b) => {
    const t = (rows, cols) => el("table", {}, el("tr", {}, cols.map((c) => el("th", {}, c))), rows.map((r) => el("tr", {}, cols.map((c) => el("td", {}, c === "kw" ? (r.kw || r.keywords || []).join(", ") : r[c] ?? "")))));
    b.append(t(s.profiles || [], ["name", "M", "T", "Sv", "W", "Ld", "OC", "invuln"]));
    if (s.ranged?.length) b.append(el("h3", {}, "Ranged"), t(s.ranged, ["name", "range", "A", "BS", "S", "AP", "D", "kw"]));
    if (s.melee?.length) b.append(el("h3", {}, "Melee"), t(s.melee, ["name", "A", "WS", "S", "AP", "D", "kw"]));
    if (s.abilities?.length) b.append(el("h3", {}, "Abilities"), ...s.abilities.map((a) => el("div", {}, el("b", {}, a.name), a.summary ? " — " + a.summary : "")));
    b.append(el("p", { class: "muted" }, (s.keywords || []).join(", ")), el("a", { href: s.source_url, target: "_blank", rel: "noopener", style: "color:#9fd3ff" }, "Full rules on Wahapedia ↗"));
  });
}

function openLink(u) {
  sheet("Link datasheet — " + u.name, async (b, _r, d) => {
    await loadSheets();
    if (!sheets?.length) { b.append(el("p", { class: "muted" }, "No datasheets loaded (sign in first).")); return; }
    const q = el("input", { placeholder: "Search", style: "width:100%" });
    const list = el("div");
    const draw = () => list.replaceChildren(...sheets.filter((s) => s.name.toLowerCase().includes(q.value.toLowerCase())).slice(0, 40).map((s) => el("div", { class: "btns", style: "margin:3px 0" }, el("span", { style: "flex:1" }, s.name + " (" + s.faction + ")"), btn("Use", () => { u.datasheet = s.slug; u.wounds = null; u.oc = null; u.keywords = null; applySheets(); d.close(); commit("save", "Linked " + s.name); }))));
    q.oninput = draw; draw();
    b.append(q, list);
  });
}

function openTargets(u, maxD) {
  if (!u) return;
  const ctx = terrain(), s = sheetFor(u);
  const weapons = (s?.ranged || []).map((w) => ({ name: w.name, r: parseFloat(String(w.range).replace(/[^0-9.]/g, "")) || 0 })).filter((w) => w.r);
  const rows = units.filter((v) => v.side !== u.side && E.isOnTable(v)).map((v) => ({ v, d: E.unitDistance(u, v), vis: E.unitVisibility(ctx, u, v) })).filter((x) => !maxD || x.d <= maxD + 1).sort((a, b) => a.d - b.d);
  sheet("Targets for " + u.name, (b, _r, d) => {
    if (!s) b.append(el("p", { class: "muted" }, "No datasheet linked: weapon ranges unknown."));
    b.append(el("table", {}, el("tr", {}, ["Target", "″", "Visible", "In range", ""].map((h) => el("th", {}, h))),
      rows.map(({ v, d: dist, vis }) => el("tr", {}, el("td", {}, v.name), el("td", {}, dist.toFixed(1)), el("td", {}, vis.targetModelsVisible + "/" + vis.targetModelsTotal + (vis.targetInCover ? " cover" : "")),
        el("td", {}, weapons.filter((w) => dist <= w.r + E.EPS).map((w) => w.name).join(", ") || (maxD ? (dist <= 12 ? "charge range" : "") : "—")),
        el("td", {}, btn("Show", () => { losTarget = v.id; rings = false; d.close(); render(); }), btn("Hit", () => { d.close(); openDamage(v); }))))));
    b.append(el("p", { class: "muted" }, "Visibility is a 2D aid: ruin footprints block sight through them. Check true line of sight at the table."));
  });
}

function openReserves() {
  const t = gs().turn;
  const list = units.filter((v) => v.side === t.active && ["reserves", "embarked"].includes(v.locationState));
  sheet("Reserves & transports", (b, _r, d) => {
    if (!list.length) b.append(el("p", { class: "muted" }, "No units in reserves or embarked."));
    for (const v of list) b.append(el("div", { class: "btns", style: "margin:3px 0" }, el("span", { style: "flex:1" }, v.name + " — " + v.locationState + (v.needsEmergencyDisembark ? " (transport destroyed!)" : "")),
      btn("Select", () => { selected = v.id; d.close(); $("barMenu").click(); render(); toast("Use Deploy reserves / Deep strike / Disembark in the drawer, then tap the destination."); })));
  });
}

function openDice() {
  sheet("Dice", (b, rebuild) => {
    const n = el("input", { type: "number", min: 1, max: 60, value: 10, style: "width:60px" }), need = el("input", { type: "number", min: 2, max: 6, value: 4, style: "width:50px" });
    const out = el("div", { style: "font-size:15px;margin-top:8px" });
    const roll = () => { const r = Array.from({ length: Number(n.value) }, d6); const ok = r.filter((x) => x >= Number(need.value)).length; out.textContent = ok + " successes (" + need.value + "+) · sixes " + r.filter((x) => x === 6).length + " · ones " + r.filter((x) => x === 1).length + " · [" + r.sort((a, b) => b - a).join(" ") + "]"; };
    b.append(el("div", { class: "btns" }, el("label", {}, "Dice ", n), el("label", {}, " Need ", need, "+"), btn("Roll", roll), btn("D6", () => (out.textContent = "D6: " + d6())), btn("2D6", () => { const a = d6(), c = d6(); out.textContent = "2D6: " + a + " + " + c + " = " + (a + c); }), btn("D3", () => (out.textContent = "D3: " + Math.ceil(d6() / 2)))), out);
  });
}

function openLog() {
  sheet("Game log", (b) => {
    const st = gs();
    const rows = (st.log || []).slice(-60).reverse();
    if (!rows.length) b.append(el("p", { class: "muted" }, "Nothing logged yet."));
    for (const l of rows) b.append(el("div", { style: "font-size:12px;border-bottom:1px solid #2c4150;padding:2px 0" }, "R" + (l.round ?? "?") + " " + (SIDE_SHORT[l.side] || "") + " " + (E.PHASE_LABEL[l.phase] || "") + " · ", el("b", {}, l.kind), " ", l.name || "", " ", l.label || "", l.amount ? " " + l.amount + " dmg" : "", l.removed ? " −" + l.removed : "", l.destroyed ? " destroyed" : "", l.delta ? " " + (l.delta > 0 ? "+" : "") + l.delta + " " + (l.score || "") : ""));
    const destroyed = units.filter((u) => u.locationState === "destroyed");
    if (destroyed.length) b.append(el("h3", {}, "Destroyed units"), ...destroyed.map((u) => el("div", { class: "btns" }, el("span", { style: "flex:1;color:" + SIDE_COLOR[u.side] }, u.name + " (R" + (u.destroyedRound ?? "?") + ")"), btn("Select", () => { selected = u.id; render(); }))));
    b.append(el("h3", {}, "Terrain obstacles (movement)"), el("div", { class: "btns" },
      btn("Draw solid", () => startObstacle("solid")), btn("Draw low", () => startObstacle("low")),
      btn("Remove last", () => { st.obstacles.pop(); commit("save", "Obstacle removed"); }), el("span", { class: "muted" }, (st.obstacles?.length || 0) + " defined")),
      el("p", { class: "muted" }, "Solid: no model may end on it; only INFANTRY, SWARM, BEASTS, MONSTER, MOBILE (and FLY) cross it. Low: no model may end on it. Ruin footprints from the map block line of sight."));
    b.append(el("h3", {}, "Turn"), el("div", { class: "btns" }, E.PHASES.map((p) => btn(E.PHASE_LABEL[p], () => { E.setPhase(st, { phase: p }); commit("turn", "Phase set to " + E.PHASE_LABEL[p]); })),
      btn("Swap player", () => { E.setPhase(st, { active: E.otherSide(st.turn.active) }); commit("turn"); }),
      btn("Round −", () => { E.setPhase(st, { round: st.turn.round - 1 }); commit("turn"); }), btn("Round +", () => { E.setPhase(st, { round: st.turn.round + 1 }); commit("turn"); }),
      btn("First: " + SIDE_SHORT[st.turn.first], () => { st.turn.first = E.otherSide(st.turn.first); commit("turn"); })));
  });
}

/* ---------- obstacle drawing ---------- */
function startObstacle(kind) {
  document.querySelector("dialog.hud")?.close();
  drawObstacle = { kind, points: [] };
  toast("Tap the outline corners of the " + kind + " terrain. Tap the first point (or the ✓ button) to finish.", 8000);
  phaseBar.prepend(btn("✓ Finish", finishObstacle, { cls: "next" }), btn("✕", () => { drawObstacle = null; render(); }));
}
function finishObstacle() {
  if (!drawObstacle) return;
  if (drawObstacle.points.length >= 3) { gs().obstacles.push({ id: "ob" + Date.now().toString(36), kind: drawObstacle.kind, polygon: drawObstacle.points }); commit("save", drawObstacle.kind + " terrain added"); }
  drawObstacle = null; render();
}
canvas.addEventListener("pointerdown", (e) => {
  if (!drawObstacle) return;
  e.stopImmediatePropagation(); e.preventDefault();
  const p = pt(e), pts = drawObstacle.points;
  if (pts.length >= 3 && Math.hypot(pts[0][0] - p.x, pts[0][1] - p.y) < 0.8) { finishObstacle(); return; }
  pts.push([Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]);
  render();
}, { capture: true });

/* ---------- chat + realtime ---------- */
let chat = [], unread = 0, chatOpen = false, lastChatId = 0;
const chatLabel = () => (unread ? "Chat (" + unread + ")" : "Chat");
async function pullChat() {
  if (!online()) return;
  try {
    const rows = await cloudRequest("/rest/v1/tabletop_messages?game_id=eq." + encodeURIComponent(cloudGameId) + "&id=gt." + lastChatId + "&select=id,author,side,body,created_at&order=id.asc&limit=100");
    if (!rows.length) return;
    chat.push(...rows); lastChatId = rows.at(-1).id;
    const fresh = rows.filter((r) => r.author === "ai");
    if (!chatOpen && fresh.length) { unread += fresh.length; toast("💬 " + fresh.at(-1).body.slice(0, 140), 6000); }
    if (chatOpen) document.querySelector("#chatLog") && drawChat(document.querySelector("#chatLog"));
    updatePhaseBar();
  } catch {}
}
function drawChat(box) { box.replaceChildren(...chat.slice(-80).map((m) => el("div", { class: m.author === "ai" ? "ai" : "" }, el("b", {}, m.author === "ai" ? "AI" : "You", m.side ? " (" + SIDE_SHORT[m.side] + ")" : "", ": "), m.body))); box.scrollTop = 1e9; }
function openChat() {
  unread = 0; chatOpen = true;
  const d = sheet("Table chat", (b) => {
    const log = el("div", { id: "chatLog" }), input = el("input", { placeholder: online() ? "Message the AI opponent…" : "Sign in to chat", style: "flex:1", disabled: !online() });
    const send = async () => { const t = input.value.trim(); if (!t) return; input.value = ""; try { await cloudRequest("/rest/v1/tabletop_messages", { method: "POST", body: { game_id: cloudGameId, author: "player", body: t } }); await pullChat(); } catch (e) { toast("Chat failed: " + e.message); } };
    input.onkeydown = (e) => { if (e.key === "Enter") send(); };
    b.append(log, el("div", { class: "btns", style: "margin-top:8px" }, input, btn("Send", send)), el("p", { class: "muted" }, "The AI reads this with get_events_since and replies with send_message."));
    drawChat(log);
  });
  d.addEventListener("close", () => { chatOpen = false; updatePhaseBar(); });
}

let rtGame = null, rtClient = null;
async function realtime() {
  if (!online() || rtGame === cloudGameId) return;
  try {
    if (!rtClient) {
      const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2.45.4");
      rtClient = createClient(CLOUD_URL, CLOUD_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    }
    rtClient.realtime.setAuth(cloudSession.access_token);
    rtClient.removeAllChannels();
    rtGame = cloudGameId;
    const f = "game_id=eq." + cloudGameId;
    rtClient.channel("game-" + cloudGameId)
      .on("postgres_changes", { event: "*", schema: "public", table: "tabletop_proposals", filter: f }, () => { if (typeof pollProposals === "function") pollProposals(); toast("New proposal from the AI — review the board."); })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "tabletop_games", filter: "id=eq." + cloudGameId }, () => { if (typeof pollProposals === "function") pollProposals(); })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "tabletop_messages", filter: f }, pullChat)
      .subscribe();
  } catch (e) { console.warn("realtime unavailable; polling", e); rtGame = cloudGameId; }
}
setInterval(() => { if (!online()) return; if (rtGame !== cloudGameId) { chat = []; lastChatId = 0; unread = 0; realtime(); } pullChat(); if (!sheets) loadSheets().then(render); if (rtClient && cloudSession?.access_token) rtClient.realtime.setAuth(cloudSession.access_token); }, 6000);

/* ---------- boot ---------- */
gs();
render();
window.battlefieldHud = { E, gs, commit, openScore, sheetFor, loadSheets };
