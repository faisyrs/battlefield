// 40K Battlefield shared engine. Pure functions, no DOM, no network.
// Used by the browser (index.html, js/hud.js) and the MCP edge function (Deno).
// Coordinates are inches from the board's top-left corner. Angles in degrees.

export const ENGINE_VERSION = 2;
export const PHASES = ["command", "movement", "shooting", "charge", "fight"];
export const PHASE_LABEL = { command: "Command", movement: "Movement", shooting: "Shooting", charge: "Charge", fight: "Fight" };
export const SIDES = ["ork", "da"];
export const SIDE_LABEL = { ork: "Orks", da: "Dark Angels" };
export const OBJECTIVE_RANGE = 3; // inches, measured from the marker edge
export const OBJECTIVE_MARKER_MM = 40;
export const PILE_IN = 3;
export const EPS = 0.005;
// Keywords that may move through solid terrain geometry.
export const CROSS_SOLID = ["INFANTRY", "SWARM", "BEAST", "BEASTS", "MONSTER", "MOBILE"];

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const other = (side) => (side === "ork" ? "da" : "ork");
export { other as otherSide };

/* ---------- geometry ---------- */

export function modelDims(u, m = {}) {
  const w = (m.widthMm || u.widthMm || (u.vehicle ? (u.diam || 2) * 25.4 : u.baseSize || 32)) / 25.4;
  const h = (m.lengthMm || u.lengthMm || (u.vehicle ? (u.diam || 2) * 0.7 * 25.4 : u.baseSize || 32)) / 25.4;
  const shape = m.shape || u.shape || (u.vehicle ? "rectangle" : "circle");
  return { w, h, shape };
}

export function modelCenter(u, m, x = u.x, y = u.y, angle = u.angle ?? 0) {
  const a = (Number(angle) * Math.PI) / 180;
  return { x: x + m.x * Math.cos(a) - m.y * Math.sin(a), y: y + m.x * Math.sin(a) + m.y * Math.cos(a) };
}

export function modelPolygon(u, m, x = u.x, y = u.y, angle = u.angle ?? 0, segments = 32) {
  const a = (Number(angle) * Math.PI) / 180, c = Math.cos(a), d = Math.sin(a);
  const { w, h, shape } = modelDims(u, m), hw = w / 2, hh = h / 2;
  const local = shape === "rectangle"
    ? [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]]
    : Array.from({ length: segments }, (_, i) => [hw * Math.cos((i * 2 * Math.PI) / segments), hh * Math.sin((i * 2 * Math.PI) / segments)]);
  return local.map(([px, py]) => [x + (px + m.x) * c - (py + m.y) * d, y + (px + m.x) * d + (py + m.y) * c]);
}

export function modelPolygons(u, x = u.x, y = u.y, angle = u.angle ?? 0) {
  return (u.models || []).map((m) => modelPolygon(u, m, x, y, angle));
}

export function pointSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = clamp(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1), 0, 1);
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

export function insidePoly(p, poly) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) hit = !hit;
  }
  return hit;
}

export function pointPoly(p, poly) {
  return insidePoly(p, poly) ? 0 : Math.min(...poly.map((a, i) => pointSegment(p, a, poly[(i + 1) % poly.length])));
}

const cross = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
export function segmentsIntersect(p, q, r, s) {
  const d1 = cross(p, q, r), d2 = cross(p, q, s), d3 = cross(r, s, p), d4 = cross(r, s, q);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

export function polyDistance(a, b) {
  for (let i = 0; i < a.length; i++)
    for (let j = 0; j < b.length; j++)
      if (segmentsIntersect(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])) return 0;
  if (insidePoly(a[0], b) || insidePoly(b[0], a)) return 0;
  return Math.min(...a.map((p) => pointPoly(p, b)), ...b.map((p) => pointPoly(p, a)));
}

export function segmentPolyIntersects(p, q, poly) {
  if (insidePoly(p, poly) || insidePoly(q, poly)) return true;
  for (let i = 0; i < poly.length; i++) if (segmentsIntersect(p, q, poly[i], poly[(i + 1) % poly.length])) return true;
  return false;
}

/** Rings of a GeoJSON-like Polygon or MultiPolygon (outer rings only). */
export function rings(geometry) {
  if (!geometry?.coordinates) return [];
  if (geometry.type === "Polygon") return [geometry.coordinates[0]];
  if (geometry.type === "MultiPolygon") return geometry.coordinates.map((p) => p[0]);
  return [];
}

/* ---------- state model v2 ---------- */

export const isOnTable = (u) => (u.locationState ?? "deployed") === "deployed";
export const isDestroyed = (u) => u.locationState === "destroyed";
export const unitKeywords = (u) => (u.keywords || []).map((k) => String(k).toUpperCase());

export function defaultTurn(setup = {}) {
  // Attacker goes first unless setup says otherwise.
  const first = setup.firstSide || (setup.orkSide === "attacker" ? "ork" : setup.daSide === "attacker" ? "da" : "ork");
  return { round: 1, active: first, first, phase: "command", started: false };
}

export function upgradeState(state) {
  const s = state || {};
  s.units ??= [];
  s.turn ??= defaultTurn(s.setup);
  if (!PHASES.includes(s.turn.phase)) s.turn.phase = "command";
  s.score ??= {};
  for (const side of SIDES) {
    s.score[side] ??= {};
    const sc = s.score[side];
    sc.primary ??= 0;
    sc.secondary ??= 0;
    sc.cp ??= 0;
    sc.secondaries ??= []; // [{name, mode:'fixed'|'tactical', vp, done}]
    sc.history ??= []; // [{round, phase, kind, delta, reason}]
  }
  s.log ??= [];
  s.obstacles ??= []; // [{id, kind:'solid'|'low', polygon:[[x,y]...], label}]
  for (const u of s.units) upgradeUnit(u);
  s.engine = ENGINE_VERSION;
  return s;
}

export function upgradeUnit(u) {
  u.locationState ??= "deployed";
  u.models ??= [];
  u.casualties ??= [];
  u.effects ??= [];
  if (u.wounds === undefined) u.wounds = null; // characteristic W per model, null = unknown
  for (const m of u.models) {
    if (u.wounds && m.wounds == null) m.wounds = Number(u.wounds);
  }
  return u;
}

export const vpTotal = (sc) => Number(sc.primary || 0) + Number(sc.secondary || 0);

export function findUnit(state, ref) {
  const units = state.units || [];
  return units.find((u) => String(u.id) === String(ref)) || units.find((u) => String(u.name || "").toLowerCase() === String(ref ?? "").toLowerCase());
}

/** All units in the same attached group as u (leader + bodyguard). */
export function attachedGroup(state, u) {
  const root = rootOf(state, u);
  return state.units.filter((v) => rootOf(state, v) === root && v.locationState === u.locationState);
}
export function rootOf(state, u) {
  let cur = u;
  const seen = new Set();
  while (cur.attachedTo != null && !seen.has(String(cur.id))) {
    seen.add(String(cur.id));
    const p = state.units.find((v) => String(v.id) === String(cur.attachedTo));
    if (!p) break;
    cur = p;
  }
  return String(cur.id);
}

/* ---------- movement origins ---------- */

export function resetOrigin(u) {
  u.origin = { x: u.x, y: u.y, angle: u.angle ?? 0, models: (u.models || []).map((m) => modelCenter(u, m)) };
  u.spent = 0;
  u.trail = [];
  delete u.lastMove;
  (u.models || []).forEach((m) => { m.spent = 0; delete m.lastMove; });
}

export function measureOrigin(u) {
  if (!u.origin || !Array.isArray(u.origin.models) || u.origin.models.length !== (u.models || []).length) resetOrigin(u);
  u.models.forEach((m, i) => {
    const p = modelCenter(u, m), o = u.origin.models[i];
    m.spent = Math.hypot(p.x - o.x, p.y - o.y);
  });
  u.spent = Math.max(0, ...u.models.map((m) => m.spent));
  return u.spent;
}

export const allowance = (u) => Math.max(0, Number(u.move || 0) + Number(u.bonus || 0));

/* ---------- casualties and wounds ---------- */

function log(state, entry) {
  state.log ??= [];
  state.log.push({ round: state.turn?.round, side: state.turn?.active, phase: state.turn?.phase, at: entry.at || null, ...entry });
  if (state.log.length > 300) state.log.splice(0, state.log.length - 300);
}

/**
 * Apply wounds to a unit. Damage is allocated to already-wounded models first,
 * then to the lowest-index model (players can override with explicit indexes).
 * Returns {removed, remaining, destroyed}.
 */
export function applyWounds(state, u, amount, opts = {}) {
  upgradeUnit(u);
  let left = Math.max(0, Math.floor(Number(amount) || 0));
  const removed = [];
  const W = Number(opts.wounds ?? u.wounds ?? 1) || 1;
  u.models.forEach((m) => { if (m.wounds == null) m.wounds = W; });
  const perShot = opts.damage ? Math.max(1, Math.floor(opts.damage)) : null;
  const pick = () => {
    if (Number.isInteger(opts.model) && u.models[opts.model]) return opts.model;
    const wounded = u.models.findIndex((m) => m.wounds < W);
    return wounded >= 0 ? wounded : u.models.length - 1;
  };
  if (perShot) {
    // amount = number of failed saves, each dealing perShot damage; excess is lost.
    for (let k = 0; k < left && u.models.length; k++) {
      const i = pick(), m = u.models[i];
      m.wounds -= perShot;
      if (m.wounds <= 0) removed.push(...removeModels(state, u, [i], { silent: true }));
    }
  } else {
    while (left > 0 && u.models.length) {
      const i = pick(), m = u.models[i], take = Math.min(left, m.wounds);
      m.wounds -= take;
      left -= take;
      if (m.wounds <= 0) removed.push(...removeModels(state, u, [i], { silent: true }));
    }
  }
  const destroyed = !u.models.length;
  if (destroyed) destroyUnit(state, u, { silent: true });
  log(state, { kind: "damage", unit: u.id, name: u.name, amount: Number(amount), damage: perShot, removed: removed.length, destroyed });
  return { removed: removed.length, remaining: u.models.length, destroyed };
}

export function healModel(u, index, amount = 1) {
  const m = u.models[index];
  if (!m) throw Error("Model not found");
  const W = Number(u.wounds || 1);
  m.wounds = Math.min(W, (m.wounds ?? W) + amount);
  return m.wounds;
}

/** Remove models by index (casualties). Keeps the removed models for revive/undo. */
export function removeModels(state, u, indexes, opts = {}) {
  upgradeUnit(u);
  const sorted = [...new Set(indexes.map(Number))].filter((i) => i >= 0 && i < u.models.length).sort((a, b) => b - a);
  const out = [];
  for (const i of sorted) {
    const [m] = u.models.splice(i, 1);
    if (u.origin?.models) u.origin.models.splice(i, 1);
    u.casualties.push({ ...m, removedRound: state.turn?.round, removedPhase: state.turn?.phase });
    out.push(m);
  }
  u.modelCount = u.models.length;
  if (!opts.silent) {
    log(state, { kind: "casualties", unit: u.id, name: u.name, removed: out.length });
    if (!u.models.length) destroyUnit(state, u, { silent: true });
  }
  return out;
}

export function removeModelCount(state, u, count) {
  // Remove from the back of the unit (furthest from the leader), the usual player choice.
  const n = Math.min(u.models.length, Math.max(0, Math.floor(count)));
  return removeModels(state, u, Array.from({ length: n }, (_, k) => u.models.length - 1 - k));
}

export function reviveModel(state, u) {
  const m = u.casualties?.pop();
  if (!m) throw Error("No casualties to return");
  delete m.removedRound; delete m.removedPhase;
  m.wounds = Number(u.wounds || m.wounds || 1);
  u.models.push(m);
  u.modelCount = u.models.length;
  if (u.locationState === "destroyed") u.locationState = u.destroyedFrom || "deployed";
  if (u.origin?.models) u.origin.models.push(modelCenter(u, m));
  log(state, { kind: "revive", unit: u.id, name: u.name });
  return m;
}

export function destroyUnit(state, u, opts = {}) {
  if (u.locationState !== "destroyed") u.destroyedFrom = u.locationState;
  // Destroying a transport destroys nothing else automatically; embarked units are flagged for emergency disembark.
  for (const v of state.units) if (String(v.transportId) === String(u.id) && v.locationState === "embarked") v.needsEmergencyDisembark = true;
  u.casualties ??= [];
  u.casualties.push(...u.models.map((m) => ({ ...m, removedRound: state.turn?.round, removedPhase: state.turn?.phase })));
  u.models = [];
  u.modelCount = 0;
  u.locationState = "destroyed";
  u.destroyedRound = state.turn?.round;
  u.destroyedBy = opts.by || null;
  // Leaders attached to a destroyed bodyguard become their own unit.
  for (const v of state.units) if (String(v.attachedTo) === String(u.id)) delete v.attachedTo;
  if (!opts.silent) log(state, { kind: "destroyed", unit: u.id, name: u.name });
  return u;
}

export function restoreUnit(state, u) {
  if (u.locationState !== "destroyed") return u;
  u.models = (u.casualties || []).map((m) => ({ ...m, wounds: Number(u.wounds || m.wounds || 1) }));
  u.models.forEach((m) => { delete m.removedRound; delete m.removedPhase; });
  u.casualties = [];
  u.modelCount = u.models.length;
  u.locationState = u.destroyedFrom || "deployed";
  delete u.destroyedRound;
  resetOrigin(u);
  log(state, { kind: "restored", unit: u.id, name: u.name });
  return u;
}

/* ---------- effects ---------- */
// Effect: {id, label, kind:'buff'|'debuff'|'status', mods:{oc?, move?, hit?, wound?, save?, ...},
//          expires:'manual'|'end_of_phase'|'end_of_turn'|'end_of_round'|'start_of_your_command'|{round, phase, side}, from}

export const QUICK_EFFECTS = [
  { label: "Advanced", kind: "status", expires: "end_of_turn" },
  { label: "Fell back", kind: "status", expires: "end_of_turn" },
  { label: "Remained stationary", kind: "status", expires: "end_of_turn" },
  { label: "Battle-shocked", kind: "debuff", mods: { oc: 0 }, expires: "start_of_your_command" },
  { label: "Charged", kind: "status", expires: "end_of_turn" },
  { label: "Fights first", kind: "buff", expires: "end_of_turn" },
  { label: "Shot", kind: "status", expires: "end_of_phase" },
  { label: "Fought", kind: "status", expires: "end_of_phase" },
  { label: "Stealth / -1 to hit", kind: "buff", mods: { hit: -1 }, expires: "end_of_phase" },
  { label: "Cover +1 save", kind: "buff", mods: { save: 1 }, expires: "end_of_phase" },
];

let effectSeq = 0;
export function addEffect(state, u, effect) {
  upgradeUnit(u);
  const e = {
    id: effect.id || "e" + Date.now().toString(36) + (effectSeq++).toString(36),
    label: String(effect.label || "Effect").slice(0, 60),
    kind: effect.kind || "status",
    mods: effect.mods || undefined,
    expires: effect.expires || "end_of_turn",
    side: u.side,
    round: state.turn?.round,
    phase: state.turn?.phase,
    owner: state.turn?.active,
    note: effect.note ? String(effect.note).slice(0, 200) : undefined,
  };
  u.effects = u.effects.filter((x) => x.label !== e.label);
  u.effects.push(e);
  log(state, { kind: "effect", unit: u.id, name: u.name, label: e.label });
  return e;
}

export function removeEffect(state, u, idOrLabel) {
  const before = u.effects?.length || 0;
  u.effects = (u.effects || []).filter((e) => e.id !== idOrLabel && e.label !== idOrLabel);
  return before - u.effects.length;
}

export const hasEffect = (u, label) => (u.effects || []).some((e) => e.label.toLowerCase() === String(label).toLowerCase());

function expireEffects(state, moment) {
  // moment: {type:'phase_end'|'turn_end'|'round_end'|'command_start', side, round, phase}
  const expired = [];
  for (const u of state.units) {
    u.effects = (u.effects || []).filter((e) => {
      const x = e.expires;
      let gone = false;
      if (x === "end_of_phase") gone = moment.type === "phase_end" || moment.type === "turn_end";
      else if (x === "end_of_turn") gone = moment.type === "turn_end";
      else if (x === "end_of_round") gone = moment.type === "round_end";
      else if (x === "start_of_your_command") gone = moment.type === "command_start" && moment.side === u.side;
      else if (x && typeof x === "object") gone = (moment.round > x.round) || (moment.round === x.round && x.phase && PHASES.indexOf(moment.phase) > PHASES.indexOf(x.phase) && (!x.side || x.side === moment.side));
      if (gone) expired.push({ unit: u.name, label: e.label });
      return !gone;
    });
  }
  return expired;
}

/* ---------- turn structure ---------- */

/** Advance to the next phase. Ends turns and rounds automatically. Returns a summary. */
export function advancePhase(state, opts = {}) {
  upgradeState(state);
  const t = state.turn;
  const from = { round: t.round, active: t.active, phase: t.phase };
  const expired = [];
  const i = PHASES.indexOf(t.phase);
  expired.push(...expireEffects(state, { type: "phase_end", side: t.active, round: t.round, phase: t.phase }));
  let turnEnded = false, roundEnded = false, gameOver = false;
  if (i < PHASES.length - 1) {
    t.phase = PHASES[i + 1];
  } else {
    turnEnded = true;
    expired.push(...expireEffects(state, { type: "turn_end", side: t.active, round: t.round, phase: t.phase }));
    if (t.active === t.first) {
      t.active = other(t.active);
    } else {
      roundEnded = true;
      expired.push(...expireEffects(state, { type: "round_end", side: t.active, round: t.round }));
      if (t.round >= (opts.maxRounds || 5)) gameOver = true;
      else { t.round += 1; t.active = t.first; }
    }
    t.phase = "command";
  }
  if (gameOver) { t.over = true; t.phase = "fight"; }
  if (t.phase === "command" && !gameOver) {
    expired.push(...expireEffects(state, { type: "command_start", side: t.active, round: t.round }));
    if (opts.autoCP !== false) for (const s of SIDES) state.score[s].cp = Number(state.score[s].cp || 0) + 1;
  }
  // Each phase starts with fresh movement origins; modifiers (advance, charge) clear.
  for (const u of state.units) { u.bonus = 0; if (u.locationState === "deployed") resetOrigin(u); }
  t.started = true;
  log(state, { kind: "phase", from, to: { round: t.round, active: t.active, phase: t.phase }, expired: expired.length });
  return { from, to: { ...t }, turnEnded, roundEnded, gameOver, expired, prompts: phasePrompts(state) };
}

export function setPhase(state, { round, active, phase }) {
  upgradeState(state);
  if (round != null) state.turn.round = clamp(Math.floor(round), 1, 5);
  if (active && SIDES.includes(active)) state.turn.active = active;
  if (phase && PHASES.includes(phase)) state.turn.phase = phase;
  for (const u of state.units) { u.bonus = 0; if (u.locationState === "deployed") resetOrigin(u); }
  log(state, { kind: "phase_set", to: { ...state.turn } });
  return state.turn;
}

/** Contextual reminders for the current phase (used by UI and MCP). */
export function phasePrompts(state) {
  const t = state.turn, p = [];
  const mine = state.units.filter((u) => u.side === t.active);
  if (t.phase === "command") {
    p.push("Gain CP (applied automatically).");
    if (mine.some((u) => hasEffect(u, "Battle-shocked") || belowHalf(u))) p.push("Battle-shock tests for units below half strength.");
    p.push("Score command-phase primary/secondary conditions.");
  }
  if (t.phase === "movement") {
    if (t.round >= 2 && mine.some((u) => u.locationState === "reserves")) p.push("Reserves may arrive at the end of this phase.");
    if (mine.some((u) => u.needsEmergencyDisembark)) p.push("Emergency disembark pending.");
  }
  if (t.phase === "shooting") p.push("Select targets; check range and visibility.");
  if (t.phase === "charge") p.push("Declare charges and roll 2D6.");
  if (t.phase === "fight") p.push("Pile in 3″, fight, consolidate 3″. End of turn scoring next.");
  if (t.phase === "fight") p.push("End-of-turn scoring happens when you end this phase.");
  return p;
}

export function belowHalf(u) {
  const start = (u.models?.length || 0) + (u.casualties?.length || 0);
  return start > 1 ? u.models.length * 2 < start : u.models.length === 1 && u.wounds && u.models[0].wounds * 2 < u.wounds;
}

/* ---------- scoring ---------- */

export function addVP(state, side, kind, delta, reason) {
  upgradeState(state);
  if (!SIDES.includes(side)) throw Error("Unknown side");
  if (!["primary", "secondary", "cp"].includes(kind)) throw Error("kind must be primary, secondary or cp");
  const sc = state.score[side];
  sc[kind] = Math.max(0, Number(sc[kind] || 0) + Number(delta || 0));
  if (kind === "primary") sc.primary = Math.min(sc.primary, 50);
  if (kind === "secondary") sc.secondary = Math.min(sc.secondary, 40);
  sc.history.push({ round: state.turn.round, phase: state.turn.phase, kind, delta: Number(delta), reason: reason ? String(reason).slice(0, 120) : undefined });
  if (sc.history.length > 200) sc.history.shift();
  log(state, { kind: "score", side, score: kind, delta: Number(delta), reason });
  return { side, primary: sc.primary, secondary: sc.secondary, cp: sc.cp, total: vpTotal(sc) };
}

export function setSecondaries(state, side, cards) {
  upgradeState(state);
  state.score[side].secondaries = (cards || []).slice(0, 6).map((c) => ({ name: String(c.name), mode: c.mode === "fixed" ? "fixed" : "tactical", vp: Number(c.vp || 0), done: !!c.done }));
  return state.score[side].secondaries;
}

/* ---------- distances, range, visibility ---------- */

export function unitDistance(a, b) {
  const pa = modelPolygons(a), pb = modelPolygons(b);
  let best = Infinity;
  for (const x of pa) for (const y of pb) best = Math.min(best, polyDistance(x, y));
  return best;
}

/** Per-model ranges from attacker models to the nearest target model (edge to edge). */
export function modelsInRange(attacker, target, range) {
  const pa = modelPolygons(attacker), pt = modelPolygons(target);
  const out = pa.map((poly, i) => {
    let best = Infinity, idx = -1;
    pt.forEach((q, j) => { const d = polyDistance(poly, q); if (d < best) { best = d; idx = j; } });
    return { model: i, distance: round2(best), nearestTarget: idx, inRange: range == null ? undefined : best <= range + EPS };
  });
  return { count: range == null ? undefined : out.filter((m) => m.inRange).length, total: out.length, models: out };
}

export const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Terrain context for line-of-sight checks.
 * features: map feature rows [{feature_type, geometry}], obstacles: state.obstacles.
 */
export function terrainContext(features = [], obstacles = []) {
  const ruins = [], dense = [], light = [], solid = [], low = [];
  for (const f of features) {
    const rs = rings(f.geometry);
    if (f.feature_type === "terrain_area") ruins.push(...rs);
    else if (f.feature_type === "dense") dense.push(...rs);
    else if (f.feature_type === "light") light.push(...rs);
    else if (f.feature_type === "solid") solid.push(...rs);
    else if (f.feature_type === "low") low.push(...rs);
  }
  for (const o of obstacles || []) {
    if (!Array.isArray(o.polygon) || o.polygon.length < 3) continue;
    (o.kind === "low" ? low : solid).push(o.polygon);
  }
  return { ruins, dense, light, solid, low };
}

function polyBounds(poly) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of poly) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { x0, y0, x1, y1 };
}
const center = (poly) => { const b = polyBounds(poly); return [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2]; };

/**
 * Simplified 2D visibility between two models: sample 9 sight lines between footprints.
 * Blocked by solid geometry; terrain-area footprints (ruins) block lines that pass
 * through them unless the observer or target is within that footprint (tabletop shorthand).
 * Dense/light features mark the target as obscured/in cover. This is an aid, not a ruling.
 */
export function modelVisibility(ctx, a, b, opts = {}) {
  const ap = sample(a), bp = sample(b);
  const inside = (poly, fp) => fp.some((p) => insidePoly(p, poly));
  let clear = 0, total = 0;
  const blockers = new Set();
  for (const p of ap) for (const q of bp) {
    total++;
    let blocked = false;
    for (const s of ctx.solid) if (segmentPolyIntersects(p, q, s)) { blocked = true; blockers.add("solid"); break; }
    if (!blocked && !opts.towering) for (const r of ctx.ruins) {
      if (inside(r, a) || inside(r, b)) continue;
      if (segmentPolyIntersects(p, q, r)) { blocked = true; blockers.add("ruin"); break; }
    }
    if (!blocked) clear++;
  }
  const cover = ctx.light.some((r) => inside(r, b)) || ctx.ruins.some((r) => inside(r, b));
  const dense = ctx.dense.some((r) => inside(r, b));
  return { visible: clear > 0, fully: clear === total, fraction: round2(clear / total), cover, dense, blockers: [...blockers] };
}
function sample(poly) {
  const c = center(poly);
  const step = Math.max(1, Math.floor(poly.length / 4));
  const pts = [c];
  for (let i = 0; i < poly.length; i += step) pts.push([c[0] + (poly[i][0] - c[0]) * 0.9, c[1] + (poly[i][1] - c[1]) * 0.9]);
  return pts.slice(0, 5);
}

/** Visibility + range summary of attacker unit vs target unit. */
export function unitVisibility(ctx, attacker, target, opts = {}) {
  const pa = modelPolygons(attacker), pt = modelPolygons(target);
  const towering = unitKeywords(attacker).includes("TOWERING") || unitKeywords(target).includes("TOWERING");
  const visibleModels = [], range = opts.range;
  let anyCover = false, allDense = pt.length > 0;
  pa.forEach((poly, i) => {
    let seen = 0, near = Infinity;
    pt.forEach((q) => {
      const v = modelVisibility(ctx, poly, q, { towering });
      const d = polyDistance(poly, q);
      if (v.visible && (range == null || d <= range + EPS)) seen++;
      if (v.visible) near = Math.min(near, d);
      if (v.cover) anyCover = true;
      if (!v.dense) allDense = false;
    });
    visibleModels.push({ model: i, seesTargets: seen, nearestVisible: near === Infinity ? null : round2(near) });
  });
  const seeing = visibleModels.filter((m) => m.seesTargets > 0).length;
  const targetVisible = pt.map((q) => pa.some((p) => modelVisibility(ctx, p, q, { towering }).visible));
  return {
    attacker: attacker.name, target: target.name, range: range ?? null,
    distance: round2(unitDistance(attacker, target)),
    attackersEligible: seeing, attackersTotal: pa.length,
    targetModelsVisible: targetVisible.filter(Boolean).length, targetModelsTotal: pt.length,
    targetInCover: anyCover, targetObscuredByDense: allDense,
    note: "2D approximation. Ruin footprints block sight through them; verify height and windows at the table.",
  };
}

/* ---------- objectives ---------- */

export function objectivesFromFeatures(features = []) {
  return features
    .filter((f) => /objective$/.test(f.feature_type) && f.geometry?.type === "Point")
    .map((f, i) => ({ id: f.feature_id || f.feature_type + "-" + i, kind: f.feature_type.replace("_objective", ""), side: f.geometry.side || null, x: f.geometry.coordinates[0], y: f.geometry.coordinates[1] }));
}

export function unitOC(u, opts = {}) {
  if (hasEffect(u, "Battle-shocked")) return 0;
  const mod = (u.effects || []).find((e) => e.mods && e.mods.oc != null);
  if (mod) return Number(mod.mods.oc);
  if (u.oc != null) return Number(u.oc);
  if (opts.datasheetOC != null) return Number(opts.datasheetOC);
  return u.vehicle ? 2 : 1;
}

/** Objective control: sums OC of models whose footprint is within range of the marker. */
export function objectiveControl(state, objectives, opts = {}) {
  const reach = (opts.range ?? OBJECTIVE_RANGE) + OBJECTIVE_MARKER_MM / 25.4 / 2;
  const prev = state.objectiveHolds || {};
  const result = objectives.map((o) => {
    const oc = { ork: 0, da: 0 }, contributors = [];
    for (const u of state.units) {
      if (!isOnTable(u)) continue;
      const per = unitOC(u, opts);
      const n = modelPolygons(u).filter((poly) => pointPoly([o.x, o.y], poly) <= reach + EPS).length;
      if (n) { oc[u.side] += n * per; contributors.push({ unit: u.name, side: u.side, models: n, oc: n * per }); }
    }
    let controller = oc.ork > oc.da ? "ork" : oc.da > oc.ork ? "da" : null;
    // Sticky control (e.g. "remains under your control") can be set by marking the objective.
    if (!controller && prev[o.id]?.sticky && oc.ork === 0 && oc.da === 0) controller = prev[o.id].side;
    return { id: o.id, kind: o.kind, x: round2(o.x), y: round2(o.y), oc, controller, contributors };
  });
  return { objectives: result, held: { ork: result.filter((r) => r.controller === "ork").length, da: result.filter((r) => r.controller === "da").length } };
}

/* ---------- coherency ---------- */

export function coherency(state, u) {
  const group = attachedGroup(state, u).filter(isOnTable);
  const polys = group.flatMap((v) => modelPolygons(v).map((poly, i) => ({ poly, label: v.name + " #" + (i + 1) })));
  const n = polys.length;
  if (n < 2) return { ok: true, issues: [] };
  const need = n >= 7 ? 2 : 1; // 6+ model units need two neighbours within 2″ (10th-edition style)
  const near = Array(n).fill(0);
  const issues = [];
  let worst = 0;
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++) {
      const d = polyDistance(polys[i].poly, polys[j].poly);
      if (d <= 2 + EPS) { near[i]++; near[j]++; }
      worst = Math.max(worst, d);
    }
  const isolated = polys.filter((_, i) => near[i] < need).map((p) => p.label);
  if (isolated.length) issues.push("Needs " + need + " neighbour(s) within 2″: " + isolated.join(", "));
  if (worst > 8 + EPS) issues.push("Models more than 8″ apart (max " + worst.toFixed(2) + "″)");
  return { ok: !issues.length, issues, maxSeparation: round2(worst) };
}

export function coherencyAll(state, side) {
  const seen = new Set(), out = [];
  for (const u of state.units) {
    if (!isOnTable(u) || (side && u.side !== side)) continue;
    const r = rootOf(state, u);
    if (seen.has(r)) continue;
    seen.add(r);
    const c = coherency(state, u);
    if (!c.ok) out.push({ unit: u.name, ...c });
  }
  return out;
}

/* ---------- terrain movement validation ---------- */

export function canCrossSolid(u) {
  const k = unitKeywords(u);
  if (k.some((x) => CROSS_SOLID.includes(x))) return true;
  if (k.includes("FLY")) return true;
  // Without datasheet keywords, assume non-vehicles are infantry-like.
  if (!k.length) return !u.vehicle;
  return false;
}

/** Validate a straight move of unit u to (x,y,angle) against terrain obstacles. */
export function terrainMoveIssues(ctx, u, x, y, angle = u.angle ?? 0) {
  const issues = [];
  const after = modelPolygons(u, x, y, angle);
  for (const poly of after) {
    for (const s of ctx.solid) if (polyDistance(poly, s) < EPS) { issues.push("Model would end on solid terrain"); break; }
    for (const s of ctx.low) if (polyDistance(poly, s) < EPS) { issues.push("Model would end on low terrain"); break; }
  }
  if (!canCrossSolid(u)) {
    const from = (u.models || []).map((m) => modelCenter(u, m));
    const to = (u.models || []).map((m) => modelCenter(u, m, x, y, angle));
    for (let i = 0; i < from.length; i++)
      for (const s of ctx.solid)
        if (segmentPolyIntersects([from[i].x, from[i].y], [to[i].x, to[i].y], s)) { issues.push("Path crosses solid terrain (unit cannot move through)"); i = from.length; break; }
  }
  return [...new Set(issues)];
}

/* ---------- deployment zones ---------- */

export function deploymentZone(features, role) {
  const f = features.find((x) => x.feature_type === role + "_deployment");
  return f ? rings(f.geometry)[0] : null;
}

/** Unit wholly within its deployment zone? role = 'attacker'|'defender'. */
export function whollyWithin(u, zone, x = u.x, y = u.y, angle = u.angle ?? 0) {
  if (!zone) return null;
  return modelPolygons(u, x, y, angle).every((poly) => poly.every((p) => insidePoly(p, zone) || pointPoly(p, zone) < 0.02));
}

export function sideRole(setup, side) {
  return (side === "ork" ? setup?.orkSide : setup?.daSide) || null;
}

/* ---------- placement checks (moved from the MCP) ---------- */

export function placementError(state, u, p, rule) {
  const W = Number(state.board?.width || 44), H = Number(state.board?.height || 60);
  const polys = modelPolygons(u, p.x, p.y, p.angle ?? u.angle ?? 0), points = polys.flat();
  if (points.some(([x, y]) => x < -EPS || x > W + EPS || y < -EPS || y > H + EPS)) return "All models must be on the battlefield.";
  const units = state.units;
  if (rule.action === "disembark") {
    const carrier = units.find((v) => String(v.id) === String(u.transportId) && v.locationState === "deployed");
    if (!carrier) return "Transport is not deployed.";
    const hull = modelPolygons(carrier);
    if (points.some((q) => Math.min(...hull.map((h) => pointPoly(q, h))) > rule.disembark + 1e-6)) return "Entire unit must be within " + rule.disembark + "″ of transport.";
  } else {
    if (rule.action === "deploy reserves" && ![(q) => q[0], (q) => W - q[0], (q) => q[1], (q) => H - q[1]].some((f) => points.every((q) => f(q) <= rule.edge + 1e-6)))
      return "Entire unit must be wholly within " + rule.edge + "″ of one battlefield edge.";
    for (const v of units.filter((v) => v.side !== u.side && v.locationState === "deployed"))
      for (const a of polys) for (const b of modelPolygons(v)) if (polyDistance(a, b) <= rule.enemy + EPS) return "Too close to " + v.name + " (must be more than " + rule.enemy + "″).";
  }
  for (const v of units.filter((v) => v.id !== u.id && v.locationState === "deployed"))
    for (const a of polys) for (const b of modelPolygons(v)) if (polyDistance(a, b) < EPS) return "Models overlap " + v.name + ".";
  return null;
}

/* ---------- compact summaries (for MCP / AI opponents) ---------- */

export function unitSummary(u, opts = {}) {
  const alive = u.models?.length || 0, lost = u.casualties?.length || 0;
  const s = {
    id: u.id, name: u.name, side: u.side, status: u.locationState,
    models: alive + "/" + (alive + lost),
  };
  if (u.locationState === "deployed") { s.x = round2(u.x); s.y = round2(u.y); if (u.vehicle && u.angle) s.angle = round2(u.angle); }
  if (u.wounds) {
    const hurt = (u.models || []).map((m) => m.wounds).filter((w) => w < u.wounds);
    s.W = u.wounds;
    if (hurt.length) s.wounded = hurt;
  }
  s.move = round2(allowance(u));
  if (u.spent) s.moved = round2(u.spent);
  if (u.attachedTo != null) s.attachedTo = u.attachedTo;
  if (u.transportId != null && u.locationState === "embarked") s.in = u.transportId;
  if (u.effects?.length) s.effects = u.effects.map((e) => e.label);
  if (u.datasheet) s.datasheet = u.datasheet;
  if (opts.loadout && u.loadout?.length) s.loadout = u.loadout;
  if (u.needsEmergencyDisembark) s.emergencyDisembark = true;
  return s;
}

/** Nearest enemy units for each friendly unit (edge-to-edge). */
export function threatMap(state, side, limit = 3) {
  const mine = state.units.filter((u) => u.side === side && isOnTable(u));
  const theirs = state.units.filter((u) => u.side !== side && isOnTable(u));
  return mine.map((u) => ({
    id: u.id, name: u.name,
    nearest: theirs.map((v) => ({ id: v.id, name: v.name, d: round2(unitDistance(u, v)) })).sort((a, b) => a.d - b.d).slice(0, limit),
  }));
}

/* ---------- diffs between states (events feed) ---------- */

export function describeChanges(prev, next) {
  const out = [];
  if (!prev || !next) return out;
  const pt = prev.turn || {}, nt = next.turn || {};
  if (pt.round !== nt.round || pt.active !== nt.active || pt.phase !== nt.phase)
    out.push({ type: "phase", text: "Round " + nt.round + " · " + (SIDE_LABEL[nt.active] || nt.active) + " · " + (PHASE_LABEL[nt.phase] || nt.phase) });
  for (const s of SIDES) {
    const a = prev.score?.[s] || {}, b = next.score?.[s] || {};
    for (const k of ["primary", "secondary", "cp"]) if (Number(a[k] || 0) !== Number(b[k] || 0)) out.push({ type: "score", side: s, kind: k, from: Number(a[k] || 0), to: Number(b[k] || 0) });
  }
  const pu = new Map((prev.units || []).map((u) => [String(u.id), u]));
  for (const u of next.units || []) {
    const o = pu.get(String(u.id));
    if (!o) { out.push({ type: "added", unit: u.name }); continue; }
    if (o.locationState !== u.locationState) out.push({ type: "location", unit: u.name, id: u.id, from: o.locationState, to: u.locationState });
    else if (u.locationState === "deployed" && (Math.abs(o.x - u.x) > 0.01 || Math.abs(o.y - u.y) > 0.01 || (o.angle || 0) !== (u.angle || 0)))
      out.push({ type: "moved", unit: u.name, id: u.id, from: [round2(o.x), round2(o.y)], to: [round2(u.x), round2(u.y)], distance: round2(Math.hypot(o.x - u.x, o.y - u.y)) });
    const om = o.models?.length || 0, nm = u.models?.length || 0;
    if (om !== nm) out.push({ type: "models", unit: u.name, id: u.id, from: om, to: nm });
    const ow = (o.models || []).reduce((s, m) => s + (m.wounds || 0), 0), nw = (u.models || []).reduce((s, m) => s + (m.wounds || 0), 0);
    if (om === nm && ow !== nw) out.push({ type: "wounds", unit: u.name, id: u.id, from: ow, to: nw });
    const oe = (o.effects || []).map((e) => e.label).sort().join("|"), ne = (u.effects || []).map((e) => e.label).sort().join("|");
    if (oe !== ne) out.push({ type: "effects", unit: u.name, id: u.id, effects: (u.effects || []).map((e) => e.label) });
  }
  return out;
}
