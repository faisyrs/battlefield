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
#hudObj{position:absolute;left:72px;top:72px;z-index:3;background:#226c89;font:600 12px system-ui;padding:5px 8px;border-radius:6px;border:1px solid #5d7786;color:#fff}
#hudLayers{position:absolute;left:8px;top:72px;z-index:3;background:#14242de0;font:600 12px system-ui;padding:5px 8px;border-radius:6px;border:1px solid #5d7786;color:#eef5f8}
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
dialog.hud.full{width:min(100vw,760px);max-width:100vw;max-height:100dvh;height:min(100dvh,980px)}
@media(max-width:700px){dialog.hud.full{width:100vw;height:100dvh;margin:0;border-radius:0;border:0;padding:10px}}
dialog.hud .tabs{display:flex;gap:4px;flex-wrap:wrap;align-items:center;position:sticky;top:-12px;background:#1b2a35;padding:6px 0;z-index:2}
dialog.hud .tabs button.on{background:#226c89;border-color:#9fd3ff}dialog.hud .tabs button.now{box-shadow:inset 0 -3px #ffe080}
dialog.hud h3 .tot,dialog.hud .grp .tot{float:right}
dialog.hud .card{background:#223442;border:1px solid #36505f;border-radius:8px;padding:6px 8px;margin:6px 0}dialog.hud .card.done{opacity:.55}
dialog.hud .cardh{display:flex;gap:6px;align-items:center;margin-bottom:4px}
dialog.hud .cond{display:flex;align-items:center;gap:8px;padding:7px 2px;border-top:1px solid #2e4452;font-size:13px}
dialog.hud .cond.got{background:#1e4a3a55}dialog.hud .cond .vp{min-width:44px;font-weight:700;color:#ffe080;font-size:12px}
dialog.hud .cond .txt{flex:1}dialog.hud .cond .when{font-size:11px;color:#9fb6c3;margin-top:2px}dialog.hud .cond .when.now{color:#ffe080;font-weight:700}dialog.hud .cond.nowc{box-shadow:inset 3px 0 #ffe080}dialog.hud .cond input[type=checkbox]{width:24px;height:24px}
dialog.hud .ctr{display:inline-flex;gap:6px;align-items:center}dialog.hud .ctr button{min-width:34px;padding:6px}dialog.hud .ctr b{min-width:18px;text-align:center}
dialog.hud .totals{position:sticky;bottom:-12px;background:#16242e;padding:8px;margin-top:10px;border-top:1px solid #36505f;font-size:13px}
dialog.hud .sumcard{background:#f2f2f2;color:#111;border-radius:10px;overflow:hidden;margin:10px 0}
dialog.hud .sumh{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-left:6px solid;font-size:16px;background:#fff;color:#111}
dialog.hud .vpb{color:#fff;border-radius:6px;padding:3px 8px;font-weight:700}
dialog.hud table.sum{width:100%;border-collapse:collapse;font-size:13px}
dialog.hud table.sum td,dialog.hud table.sum th{border:0;padding:6px 4px;text-align:center;color:#111}
dialog.hud table.sum td.lbl{text-align:right;padding-right:8px;white-space:nowrap}
dialog.hud table.sum .alt{background:#d7e2ea}dialog.hud table.sum .now{outline:2px solid #e0a800;outline-offset:-2px}
dialog.hud table.sum tr.grp td{background:#c9c9c9;font-weight:800;text-align:left;padding:8px 10px;letter-spacing:.03em}
dialog.hud table.sum td.r,dialog.hud table.sum th.r{cursor:pointer;width:13%}
#chatLog{max-height:45dvh;overflow:auto;font-size:13px;display:flex;flex-direction:column;gap:4px}
#chatLog .ai{color:#ffd9a0}#chatBadge{background:#c8553f;border-radius:8px;padding:0 5px;margin-left:3px;font-size:11px}
`));

/* ---------- DOM ---------- */
const header = document.querySelector("header");
const turnBtn = el("button", { id: "hudTurn", title: "Turn and phase" });
const scoreBtn = el("button", { id: "hudScore", title: "Victory points and CP" });

turnBtn.onclick = () => openLog();
scoreBtn.onclick = () => openSummary();
const phaseBar = el("div", { id: "phaseBar", role: "toolbar", "aria-label": "Phase actions" });
$("bottom-bar").before(phaseBar);
const card = el("div", { id: "unitCard" });
const toastEl = el("div", { id: "hudToast" });
const layersBtn = el("button", { id: "hudLayers", title: "Map layers" }, "Layers");
const objBtn = el("button", { id: "hudObj", title: "Score objectives" }, "Objectives");
objBtn.onclick = () => openObjectives();
$("boardArea").append(card, toastEl, scoreBtn, layersBtn, objBtn);
layersBtn.onclick = () => openLayers();
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
const sheetFor = (u) => E.matchDatasheet(u, sheets);
function applySheets() { for (const u of units) E.applyDatasheet(u, sheetFor(u)); }
const maxRange = (s) => Math.max(0, ...((s?.ranged || []).map((w) => parseFloat(String(w.range).replace(/[^0-9.]/g, "")) || 0)));

/* ---------- overlays ---------- */
let rings = false, losTarget = null, drawObstacle = null;
/* ---------- layers ---------- */
const LAYERS = [
  ["zones", "Deployment zones", true], ["territory", "Territories", false], ["terrain", "Terrain areas", true],
  ["dense", "Dense / light terrain", true], ["objectives", "Objective control", true], ["markers", "Objective markers", false],
  ["joins", "Terrain join marks", false], ["obstacles", "Solid / low terrain", true], ["labels", "Unit names", true],
  ["status", "Wounds & effects", true],
];
let layers = {};
try { layers = JSON.parse(localStorage.getItem("40k-layers") || "{}"); } catch {}
for (const [k, , d] of LAYERS) layers[k] ??= d;
const show = (k) => layers[k] !== false;
const saveLayers = () => { try { localStorage.setItem("40k-layers", JSON.stringify(layers)); } catch {} };

const MAP_STYLE = {
  attacker_territory: ["territory", "#b94b4b18", "#b94b4b88", 1], defender_territory: ["territory", "#4579b518", "#4579b588", 1],
  attacker_deployment: ["zones", "#b94b4b40", "#b94b4b", 1.5], defender_deployment: ["zones", "#4579b540", "#4579b5", 1.5],
  terrain_area: ["terrain", "#8d8d8d40", "#4a4a4a", 2], dense: ["dense", "#43895bcc", "#27633e", 1], light: ["dense", "#d6bd65cc", "#9a8037", 1],
};
const pathRings = (rs, Sx) => { ctx.beginPath(); for (const r of rs) { r.forEach(([x, y], i) => (i ? ctx.lineTo(x * Sx, y * Sx) : ctx.moveTo(x * Sx, y * Sx))); ctx.closePath(); } };
window.drawCatalogMap = function (data) {
  const Sx = 20;
  ctx.fillStyle = "#d8d7ce"; ctx.fillRect(0, 0, 880, 1200);
  // light grid, 1" squares, every 6" darker
  ctx.lineWidth = 1;
  for (let i = 0; i <= 60; i++) { ctx.strokeStyle = i % 6 ? "#c8c7bc" : "#b3b2a6"; ctx.beginPath(); ctx.moveTo(0, i * Sx); ctx.lineTo(880, i * Sx); ctx.stroke(); }
  for (let i = 0; i <= 44; i++) { ctx.strokeStyle = i % 6 ? "#c8c7bc" : "#b3b2a6"; ctx.beginPath(); ctx.moveTo(i * Sx, 0); ctx.lineTo(i * Sx, 1200); ctx.stroke(); }
  try {
    for (const type of Object.keys(MAP_STYLE)) {
      const [layer, fill, stroke, lw] = MAP_STYLE[type];
      if (!show(layer)) continue;
      for (const f of data.features) {
        if (f.feature_type !== type || (type === "terrain_area" && f.geometry.physical_component)) continue;
        pathRings(E.rings(f.geometry), Sx);
        ctx.fillStyle = fill; ctx.fill("evenodd"); ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke();
      }
    }
    if (show("joins")) for (const m of data.map.geometry?.terrain_join_markers || []) {
      if (!m.point) continue;
      ctx.fillStyle = "#fff"; ctx.beginPath(); ctx.arc(m.point[0] * Sx, m.point[1] * Sx, 7, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#222"; ctx.font = "bold 11px system-ui"; ctx.textAlign = "center"; ctx.fillText(m.kind === "separate" ? "×" : "=", m.point[0] * Sx, m.point[1] * Sx + 4);
    }
    const st = gs();
    if (show("obstacles")) for (const o of st.obstacles || []) {
      pathRings([o.polygon], Sx);
      ctx.fillStyle = o.kind === "low" ? "#8a6a3a88" : "#2b2b2bcc"; ctx.strokeStyle = o.kind === "low" ? "#d9b06a" : "#000"; ctx.lineWidth = 2; ctx.fill(); ctx.stroke();
    }
    const objs = objectives();
    if (show("objectives")) {
      const oc = E.objectiveControl(st, objs);
      oc.objectives.forEach((o, k) => {
        const col = o.controller ? SIDE_COLOR[o.controller] : null;
        const rs = objs[k].rings || [Array.from({ length: 24 }, (_, i) => [o.x + 3.79 * Math.cos(i * Math.PI / 12), o.y + 3.79 * Math.sin(i * Math.PI / 12)])];
        pathRings(rs, Sx);
        ctx.fillStyle = col ? col + "38" : "#ffffff00"; ctx.fill("evenodd");
        ctx.strokeStyle = col || "#ffffffcc"; ctx.lineWidth = 3; ctx.setLineDash([9, 5]); ctx.stroke(); ctx.setLineDash([]);
        if (o.oc.ork || o.oc.da) {
          ctx.font = "bold 13px system-ui"; ctx.textAlign = "center"; ctx.lineWidth = 3; ctx.strokeStyle = "#000"; ctx.fillStyle = "#fff";
          const t = o.oc.ork + " : " + o.oc.da;
          ctx.strokeText(t, o.x * Sx, o.y * Sx + 5); ctx.fillText(t, o.x * Sx, o.y * Sx + 5);
        }
      });
    }
    if (show("markers")) for (const o of objs) { ctx.beginPath(); ctx.arc(o.x * Sx, o.y * Sx, 0.787 * Sx, 0, Math.PI * 2); ctx.strokeStyle = "#333"; ctx.lineWidth = 2; ctx.stroke(); }
  } catch (e) { console.warn("map", e); }
};

function openLayers() {
  sheet("Map layers", (b, rebuild) => {
    for (const [k, label] of LAYERS) {
      const cb = el("input", { type: "checkbox" }); cb.checked = show(k);
      cb.onchange = () => { layers[k] = cb.checked; saveLayers(); render(); };
      b.append(el("label", { style: "display:flex;gap:8px;align-items:center;padding:5px 0;font-size:14px" }, cb, label));
    }
    b.append(el("div", { class: "btns", style: "margin-top:8px" },
      btn("Board only", () => { for (const [k] of LAYERS) layers[k] = ["terrain", "dense", "zones"].includes(k); saveLayers(); render(); rebuild(); }),
      btn("Defaults", () => { for (const [k, , d] of LAYERS) layers[k] = d; saveLayers(); render(); rebuild(); })));
  });
}

const FILL = { ork: "#b54b3b", da: "#248f6c" }, DOT = { ork: "#e1a897", da: "#9ad9c5" };
window.drawMarker = function (u, sel) {
  const Sx = 20;
  try {
    const polys = E.modelPolygons(u);
    if (!polys.length) return;
    polys.forEach((poly, i) => {
      pathRings([poly], Sx);
      ctx.fillStyle = FILL[u.side] || "#777"; ctx.fill();
      ctx.strokeStyle = sel ? "#ffdc63" : "#f6f6f6"; ctx.lineWidth = sel ? 2.5 : 1.4; ctx.stroke();
      const c = E.modelCenter(u, u.models[i]);
      if (u.vehicle && E.modelDims(u, u.models[i]).shape === "rectangle") {
        // facing chevron toward the model's front (local -y)
        const a = ((u.angle || 0) * Math.PI) / 180, h = E.modelDims(u, u.models[i]).h / 2, w = E.modelDims(u, u.models[i]).w / 2;
        const P = (lx, ly) => [(c.x + lx * Math.cos(a) - ly * Math.sin(a)) * Sx, (c.y + lx * Math.sin(a) + ly * Math.cos(a)) * Sx];
        ctx.beginPath(); ctx.moveTo(...P(-w * 0.45, -h * 0.4)); ctx.lineTo(...P(0, -h * 0.75)); ctx.lineTo(...P(w * 0.45, -h * 0.4)); ctx.stroke();
      } else {
        const r = Math.max(1.5, (E.modelDims(u, u.models[i]).w / 2) * Sx * 0.27);
        ctx.beginPath(); ctx.arc(c.x * Sx, c.y * Sx, r, 0, Math.PI * 2); ctx.fillStyle = DOT[u.side] || "#ccc"; ctx.fill();
      }
    });
    if (show("status") && u.wounds) for (const m of u.models) {
      if (m.wounds == null || m.wounds >= u.wounds) continue;
      const p = E.modelCenter(u, m);
      ctx.beginPath(); ctx.arc(p.x * Sx, p.y * Sx, 7, 0, Math.PI * 2); ctx.fillStyle = "#d33"; ctx.fill();
      ctx.font = "bold 10px system-ui"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillStyle = "#fff"; ctx.fillText(String(m.wounds), p.x * Sx, p.y * Sx + 0.5); ctx.textBaseline = "alphabetic";
    }
    // Label: centred above the actual footprint of the models.
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const poly of polys) for (const [x, y] of poly) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const cx = ((x0 + x1) / 2) * Sx;
    const lines = [];
    if (show("labels") || sel) lines.push([u.name.length > 24 ? u.name.slice(0, 22) + "…" : u.name, "#fff", "bold 13px system-ui"]);
    if (show("status") && u.effects?.length) lines.push([u.effects.map((e) => e.label.split(/[ /]/)[0]).join(" · "), "#ffe080", "bold 11px system-ui"]);
    let ty = y0 * Sx - 5;
    ctx.textAlign = "center"; ctx.lineWidth = 3; ctx.strokeStyle = "#101820";
    // Nudge the label block up until it clears labels already drawn this frame.
    const widths = lines.map(([t, , font]) => { ctx.font = font; return ctx.measureText(t).width; });
    const w = Math.max(0, ...widths) + 4, h = lines.length * 13;
    const hit = (y) => labelBoxes.some((r) => Math.abs(r.x - cx) * 2 < r.w + w && y - h < r.y && y > r.y - r.h);
    for (let k = 0; k < 6 && lines.length && hit(ty); k++) ty -= 13;
    if (lines.length) labelBoxes.push({ x: cx, y: ty, w, h });
    for (const [t, col, font] of lines.reverse()) { ctx.font = font; ctx.fillStyle = col; ctx.strokeText(t, cx, ty); ctx.fillText(t, cx, ty); ty -= 13; }
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

let labelBoxes = [];
const baseRender = window.render;
window.render = function () { labelBoxes = []; baseRender(); try { updateHud(); } catch (e) { console.warn("hud", e); } };

const baseLoad = window.cloudLoadState;
let gameMapId = null;
window.cloudLoadState = async function (state) {
  gameMapId = state?.map_id || null;
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
    kids.push(btn("Objectives", () => openObjectives()));
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
  if (r.gameOver) { toast("Game over! " + E.SIDES.map((s) => SIDE_SHORT[s] + " " + E.vpTotal(st.score[s])).join(" – "), 10000); openSummary(); return; }
  if (endTurn || r.to.phase === "command") openObjectives({ prompt: endTurn ? "End of " + SIDE_SHORT[r.from.active] + " turn: score end-of-turn conditions." : "Command phase: score command-phase conditions.", side: endTurn ? r.from.active : r.to.active, round: endTurn ? r.from.round : r.to.round });
}

/* ---------- sheets ---------- */
async function mcp(name, args) {
  const r = await fetch(CLOUD_URL + "/functions/v1/battlefield-mcp", { method: "POST", headers: { apikey: CLOUD_KEY, authorization: "Bearer " + cloudSession.access_token, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
  const j = await r.json();
  if (j.error) throw Error(j.error.message);
  return JSON.parse(j.result.content[0].text);
}

/* ---------- objectives & scoring pages ---------- */
let missionData = null;
async function loadMissions() {
  if (missionData) return missionData;
  const [primary, secondary] = await Promise.all([
    cloudRequest("/rest/v1/mission_matrix?edition=eq.11&select=mission_name,disposition,opponent_disposition,scoring,source_url"),
    cloudRequest("/rest/v1/mission_secondary_catalog?edition=eq.11&select=mission_name,fixed_available,scoring,source_url&order=mission_name"),
  ]);
  return (missionData = { primary, secondary });
}
const dispositionOf = (st, side) => (side === "ork" ? st.setup?.orkDisposition : st.setup?.daDisposition);
function primaryFor(st, side) {
  const d = dispositionOf(st, side), o = dispositionOf(st, E.otherSide(side));
  return missionData?.primary.find((m) => m.disposition === d && m.opponent_disposition === o) || null;
}
const conds = (m) => (Array.isArray(m?.scoring) ? m.scoring : m?.scoring?.conditions || []);
const isEob = (c) => /end of battle/i.test(c.timing || "");
// Friendly scoring timing, e.g. "own command phase end; own turn end in round 5".
function timingText(c) {
  const t = String(c.timing || "").trim();
  if (!t) return "Timing not recorded";
  const piece = (x) => {
    x = x.trim().toLowerCase();
    const r = (x.match(/in round (\d)/) || [])[1];
    let out = /end of battle/.test(x) ? "End of battle"
      : /command/.test(x) ? (/start/.test(x) ? "Start" : "End") + " of " + (/either/.test(x) ? "either player's" : /opponent/.test(x) ? "opponent's" : "your") + " Command phase"
      : /turn/.test(x) ? (/start/.test(x) ? "Start" : "End") + " of " + (/either/.test(x) ? "either player's" : /opponent/.test(x) ? "opponent's" : "your") + " turn"
      : /while card active/.test(x) ? "While the card is active"
      : x.charAt(0).toUpperCase() + x.slice(1);
    return r ? out + " (round " + r + ")" : out;
  };
  return t.split(/;/).map(piece).join(" · or ");
}
// Does this condition score at the current moment of the game for this side?
function scoresNow(c, st, side, round) {
  const t = String(c.timing || "").toLowerCase(), cur = st.turn;
  if (round !== cur.round) return false;
  const mine = cur.active === side, own = !/either|opponent/.test(t), opp = /opponent/.test(t);
  const whoOk = /either/.test(t) || (own && mine) || (opp && !mine);
  if (!whoOk) return false;
  const r5turn = /turn end in round 5/.test(t) && round === 5;
  if (/command/.test(t) && !r5turn) return cur.phase === "command";
  if (/turn end|end of turn|r5/.test(t) || r5turn) return cur.phase === "fight";
  if (/end of battle/.test(t)) return round === 5 && cur.phase === "fight";
  return false;
}
let commitTimer = null;
function commitSoon(action = "score") { clearTimeout(commitTimer); commitTimer = setTimeout(async () => { if (saving) return commitSoon(action); await commit(action); }, 700); render(); }

function fullSheet(title, build) {
  const d = sheet(title, build);
  d.classList.add("full");
  return d;
}

function openObjectives(ctx = {}) {
  const st0 = gs();
  let side = ctx.side || st0.turn.active, round = ctx.round || st0.turn.round;
  fullSheet("Objectives", async (b, rebuild) => {
    const st = gs(), sc = st.score[side];
    b.append(el("div", { class: "tabs" },
      E.SIDES.map((x) => btn(SIDE_SHORT[x] + " " + E.vpTotal(st.score[x]), () => { side = x; rebuild(); }, { cls: x === side ? "on" : "" })),
      el("span", { style: "flex:1" }),
      [1, 2, 3, 4, 5].map((r) => btn("R" + r, () => { round = r; rebuild(); }, { cls: (r === round ? "on" : "") + (r === st.turn.round ? " now" : "") }))));
    if (ctx.prompt) b.append(el("p", { class: "muted" }, ctx.prompt));
    try { await loadMissions(); } catch (e) { b.append(el("p", { class: "muted" }, "Sign in to load mission cards (" + e.message + "). Manual adjustments still work.")); }
    const oc = E.objectiveControl(st, objectives());
    const held = oc.objectives.filter((o) => o.controller === side);
    const heldNoHome = held.filter((o) => !(o.kind === "home" && (!o.side || o.side === E.sideRole(st.setup, side)))).length;
    if (oc.objectives.length) b.append(el("p", { class: "muted" }, "Board now: " + E.SIDE_LABEL[side] + " control " + held.length + " objective(s), " + heldNoHome + " excluding home."));
    const rowFor = (kind, mission, c, i) => {
      const key = E.conditionKey(kind, mission, i), cur = sc.sheet?.[round]?.[key]?.n || 0;
      const set = (n) => { E.setCondition(st, side, round, { kind, mission, index: i, vp: c.vp, label: c.condition || c.per, n, eob: isEob(c) }); commitSoon(); rebuild(); };
      const text = (c.condition || (c.per ? "Per " + c.per : "")) + (c.max ? " (max " + c.max + ")" : "");
      const hint = E.isCounter(c) && /objective/i.test(text) ? el("small", { class: "muted" }, " board: " + (/excluding your home/i.test(text) ? heldNoHome : held.length)) : "";
      const ctl = E.isCounter(c)
        ? el("span", { class: "ctr" }, btn("−", () => set(cur - 1), { disabled: !cur }), el("b", {}, cur), btn("+", () => set(cur + 1), { disabled: !!(c.max && (cur + 1) * c.vp > c.max) }))
        : (() => { const cb = el("input", { type: "checkbox" }); cb.checked = !!cur; cb.onchange = () => set(cb.checked ? 1 : 0); return cb; })();
      const now = scoresNow(c, st, side, round);
      return el("div", { class: "cond" + (cur ? " got" : "") + (now ? " nowc" : "") }, el("span", { class: "vp" }, c.vp + (E.isCounter(c) ? "×" : "") + " VP"),
        el("span", { class: "txt" }, text, hint, el("div", { class: "when" + (now ? " now" : "") }, "⏱ " + timingText(c) + (now ? " — score now" : ""))), ctl);
    };
    const subtotal = (kind, mission) => Object.values(sc.sheet?.[round] || {}).filter((e) => e.kind === kind && e.mission === mission).reduce((a, e) => a + e.n * e.vp, 0);
    const pm = primaryFor(st, side);
    b.append(el("h3", {}, "Primary", el("span", { class: "tot" }, sc.primary + "/" + E.CAPS.primary)));
    if (!pm) b.append(el("p", { class: "muted" }, dispositionOf(st, side) ? "No primary card found for " + dispositionOf(st, side) + "." : "Set dispositions in the game setup to load the primary card."));
    else {
      const list = conds(pm).map((c, i) => [c, i]).filter(([c]) => !c.rounds || c.rounds.includes(round));
      b.append(el("div", { class: "card" }, el("div", { class: "cardh" }, el("b", {}, pm.mission_name), el("span", { style: "margin-left:auto" }, "R" + round + ": " + subtotal("primary", pm.mission_name) + " VP")),
        list.length ? list.map(([c, i]) => rowFor("primary", pm.mission_name, c, i)) : el("p", { class: "muted" }, "Nothing scores in round " + round + ".")));
    }
    b.append(el("h3", {}, "Secondary", el("span", { class: "tot" }, sc.secondary + "/" + E.CAPS.secondary)));
    for (const [k, card] of (sc.secondaries || []).entries()) {
      const m = missionData?.secondary.find((x) => x.mission_name === card.name);
      const list = conds(m).map((c, i) => [c, i]).filter(([c]) => !c.mode || c.mode === card.mode);
      b.append(el("div", { class: "card" + (card.done ? " done" : "") },
        el("div", { class: "cardh" }, el("b", {}, card.name), el("small", { class: "muted" }, " " + card.mode), el("span", { style: "margin-left:auto" }, "R" + round + ": " + subtotal("secondary", card.name) + " VP"),
          card.mode === "tactical" ? btn(card.done ? "Done ✓" : "Done?", () => { card.done = !card.done; commitSoon(); rebuild(); }) : "",
          btn("×", () => { sc.secondaries.splice(k, 1); commitSoon(); rebuild(); })),
        list.length ? list.map(([c, i]) => rowFor("secondary", card.name, c, i)) : el("p", { class: "muted" }, m ? "No scoring data for this mode." : "Card not in catalog.")));
    }
    b.append(btn("+ Add secondary", () => pickSecondary(side, () => openObjectives({ side, round }))));
    b.append(el("h3", {}, "Other"));
    const adj = (kind) => sc.sheet?.[round]?.[(kind === "primary" ? "P|" : "S|") + "Adjustment|0"]?.n || 0;
    const setAdj = (kind, n) => { E.setCondition(st, side, round, { kind, mission: "Adjustment", index: 0, vp: 1, n }); commitSoon(); rebuild(); };
    for (const kind of ["primary", "secondary"]) b.append(el("div", { class: "cond" }, el("span", { class: "vp" }, ""), el("span", { class: "txt" }, "Manual " + kind + " adjustment (R" + round + ")"),
      el("span", { class: "ctr" }, btn("−", () => setAdj(kind, adj(kind) - 1), { disabled: !adj(kind) }), el("b", {}, adj(kind)), btn("+", () => setAdj(kind, adj(kind) + 1)))));
    b.append(el("div", { class: "cond" }, el("span", { class: "vp" }, ""), el("span", { class: "txt" }, "Command points"),
      el("span", { class: "ctr" }, btn("−", () => { E.addVP(st, side, "cp", -1, "spent"); commitSoon(); rebuild(); }, { disabled: !sc.cp }), el("b", {}, sc.cp), btn("+", () => { E.addVP(st, side, "cp", 1, "gained"); commitSoon(); rebuild(); }))));
    const pb = el("input", { type: "checkbox" }); pb.checked = !!sc.painted; pb.onchange = () => { E.setPainted(st, side, pb.checked); commitSoon(); rebuild(); };
    b.append(el("div", { class: "cond" }, el("span", { class: "vp" }, "10 VP"), el("span", { class: "txt" }, "Painted battle-ready"), pb));
    b.append(el("div", { class: "totals" }, "Primary " + sc.primary + "/45 · Secondary " + sc.secondary + "/45 · Painted " + (sc.painted ? 10 : 0) + "/10 · ", el("b", {}, E.vpTotal(sc) + " VP"), " ", btn("Round summary", () => openSummary())));
  });
}

function openSummary() {
  fullSheet("Score summary", (b) => {
    const st = gs(), rnow = st.turn.round;
    b.append(el("p", { class: "muted" }, "Columns are battle rounds. Tap a round to edit it."));
    for (const side of E.SIDES) {
      const sm = E.scoreSummary(st, side);
      const head = el("tr", {}, el("th", {}, ""), [1, 2, 3, 4, 5].map((r) => el("th", { class: "r" + (r === rnow ? " now" : ""), onclick: () => openObjectives({ side, round: r }) }, "R" + r)));
      const cell = (v, r) => el("td", { class: "r" + (r + 1 === rnow ? " now" : "") + (r % 2 ? "" : " alt"), onclick: () => openObjectives({ side, round: r + 1 }) }, v == null ? "-" : v);
      const group = (kind, label, total, cap) => [el("tr", { class: "grp" }, el("td", { colspan: 6 }, label, el("span", { class: "tot" }, total + "/" + cap))),
        ...sm.rows.filter((x) => x.kind === kind).map((x) => el("tr", {}, el("td", { class: "lbl" }, x.label), x.cells.map(cell)))];
      b.append(el("div", { class: "sumcard" },
        el("div", { class: "sumh", style: "border-color:" + SIDE_COLOR[side] }, el("b", {}, E.SIDE_LABEL[side]), el("span", { class: "vpb", style: "background:" + SIDE_COLOR[side] }, sm.total + "VP")),
        el("table", { class: "sum" }, head, ...group("primary", "PRIMARY MISSION", sm.primary, sm.caps.primary), ...group("secondary", "SECONDARY MISSIONS", sm.secondary, sm.caps.secondary),
          el("tr", { class: "cp" }, el("td", { class: "lbl" }, "CP Remaining"), sm.cp.map(cell)),
          el("tr", { class: "grp" }, el("td", { colspan: 6 }, "PAINTED BATTLE-READY", el("span", { class: "tot" }, sm.painted + "/10"))))));
    }
  });
}

async function pickSecondary(side, done) {
  let list = [];
  try { list = (await loadMissions()).secondary; } catch {}
  sheet("Add secondary — " + E.SIDE_LABEL[side], (b, _r, d) => {
    if (!list.length) b.append(el("p", { class: "muted" }, "Sign in to load the mission catalog."));
    const have = new Set(gs().score[side].secondaries.map((c) => c.name));
    for (const m of list.filter((x) => !have.has(x.mission_name))) b.append(el("div", { class: "btns", style: "margin:3px 0" }, el("span", { style: "flex:1" }, m.mission_name),
      btn("Tactical", () => add(m.mission_name, "tactical")), m.fixed_available ? btn("Fixed", () => add(m.mission_name, "fixed")) : ""));
    function add(name, mode) { gs().score[side].secondaries.push({ name, mode, done: false }); commitSoon(); d.close(); done?.(); }
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

/* ---------- sign-in / map status ---------- */
const banner = el("div", { id: "hudBanner", style: "position:absolute;left:50%;bottom:52px;transform:translateX(-50%);z-index:3;background:#3b2a12f0;border:1px solid #d9a441;border-radius:8px;padding:6px 10px;font-size:13px;display:none;max-width:92%" });
$("boardArea").append(banner);
let bannerHidden = "";
function updateBanner() {
  let text = "", action = null;
  if (!cloudSession) { text = "Not signed in — showing the offline sample board. Sign in to load your saved game and its map."; action = ["Sign in", () => { $("barMenu").click(); $("cloudEmail")?.scrollIntoView({ block: "center" }); $("cloudEmail")?.focus(); }]; }
  else if (cloudRevision === null) { text = "Signed in. Load a game to see its map."; action = ["Games", () => $("barGames").click()]; }
  else if (!activeCatalogMap && gameMapId) { text = "This game's map didn't load."; action = ["Retry", async () => { try { activeCatalogMap = await fetchCatalogMap(gameMapId); render(); } catch (e) { toast("Map load failed: " + e.message); } }]; }
  if (text && text === bannerHidden) text = "";
  banner.style.display = text ? "block" : "none";
  if (text) { const t = text; banner.replaceChildren(text, " ", action ? btn(action[0], action[1]) : "", " ", btn("×", () => { bannerHidden = t; updateBanner(); })); }
}
setInterval(updateBanner, 1500);

// After sign-in with no game selected, open the most recently played game automatically.
let autoLoaded = false;
setInterval(async () => {
  if (autoLoaded || !cloudSession || cloudRevision !== null) return;
  autoLoaded = true;
  try {
    const games = await refreshGames();
    const id = cloudGameId && games.some((g) => g.id === cloudGameId) ? cloudGameId : games[0]?.id;
    if (id) { await loadGame(id); toast("Loaded " + (games.find((g) => g.id === id)?.name || "game")); }
  } catch (e) { toast("Couldn't open your game: " + e.message, 6000); }
}, 2500);

/* ---------- boot ---------- */
gs();
render();
window.battlefieldHud = { E, gs, commit, openObjectives, openSummary, sheetFor, loadSheets };
