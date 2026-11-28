import { test } from "node:test";
import assert from "node:assert/strict";
import * as E from "../js/engine.js";

const inf = (id, side, x, y, n = 5, extra = {}) => ({
  id, name: "U" + id, side, x, y, angle: 0, move: 6, bonus: 0, baseSize: 32, locationState: "deployed",
  models: Array.from({ length: n }, (_, i) => ({ x: i * 1.4, y: 0 })), ...extra,
});
const game = (units, extra = {}) => E.upgradeState({ board: { width: 44, height: 60 }, setup: { orkSide: "attacker", daSide: "defender" }, units, ...extra });

test("upgradeState adds turn, score and unit fields without touching positions", () => {
  const s = game([inf(1, "ork", 10, 10)]);
  assert.deepEqual(s.turn, { round: 1, active: "ork", first: "ork", phase: "command", started: false });
  assert.equal(s.score.da.primary, 0);
  assert.equal(s.units[0].x, 10);
  assert.deepEqual(s.units[0].effects, []);
  E.upgradeState(s); // idempotent
  assert.equal(s.units[0].models.length, 5);
});

test("phase cycle: 5 phases per turn, second player then next round, CP each command phase", () => {
  const s = game([inf(1, "ork", 10, 10)]);
  const seen = [];
  for (let i = 0; i < 10; i++) { const r = E.advancePhase(s); seen.push(r.to.round + r.to.active + r.to.phase); }
  assert.equal(seen[3], "1orkfight");
  assert.equal(seen[4], "1dacommand");
  assert.equal(seen[9], "2orkcommand");
  assert.equal(s.score.ork.cp, 2);
  assert.equal(s.score.da.cp, 2);
});

test("game ends after round 5", () => {
  const s = game([]);
  let r;
  for (let i = 0; i < 50; i++) { r = E.advancePhase(s); if (r.gameOver) break; }
  assert.ok(r.gameOver);
  assert.equal(s.turn.round, 5);
  assert.ok(s.turn.over);
});

test("phase change resets movement origins and bonus", () => {
  const u = inf(1, "ork", 10, 10, 1);
  const s = game([u]);
  E.resetOrigin(u);
  u.bonus = 4; u.x = 15; E.measureOrigin(u);
  assert.equal(E.round2(u.spent), 5);
  E.advancePhase(s);
  assert.equal(u.bonus, 0);
  assert.equal(u.spent, 0);
  assert.equal(u.origin.x, 15);
});

test("effects expire at the right moment", () => {
  const ork = inf(1, "ork", 10, 10), da = inf(2, "da", 30, 30);
  const s = game([ork, da]);
  s.turn.phase = "movement";
  E.addEffect(s, ork, { label: "Advanced", expires: "end_of_turn" });
  E.addEffect(s, ork, { label: "Shot", expires: "end_of_phase" });
  E.addEffect(s, da, { label: "Battle-shocked", expires: "start_of_your_command" });
  E.advancePhase(s); // -> shooting
  assert.ok(E.hasEffect(ork, "Advanced"));
  assert.ok(!E.hasEffect(ork, "Shot"));
  E.advancePhase(s); E.advancePhase(s); E.advancePhase(s); // -> da command
  assert.ok(!E.hasEffect(ork, "Advanced"));
  assert.ok(!E.hasEffect(da, "Battle-shocked"));
});

test("wounds: damage spills across models, wounded model first, destroys unit at zero", () => {
  const u = inf(1, "ork", 10, 10, 3, { wounds: 2 });
  const s = game([u]);
  let r = E.applyWounds(s, u, 1);
  assert.equal(r.removed, 0);
  r = E.applyWounds(s, u, 2); // finishes wounded model, wounds next
  assert.equal(r.removed, 1);
  assert.equal(u.models.length, 2);
  assert.ok(u.models.some((m) => m.wounds === 1));
  r = E.applyWounds(s, u, 10);
  assert.ok(r.destroyed);
  assert.equal(u.locationState, "destroyed");
  assert.equal(u.casualties.length, 3);
  E.restoreUnit(s, u);
  assert.equal(u.models.length, 3);
  assert.equal(u.locationState, "deployed");
});

test("per-failed-save damage does not spill over", () => {
  const u = inf(1, "da", 10, 10, 3, { wounds: 3 });
  const s = game([u]);
  const r = E.applyWounds(s, u, 3, { damage: 2 }); // D2 x3 on 3W models: 3->1, 1->dead (excess lost), 3->1
  assert.equal(r.removed, 1);
  assert.deepEqual(u.models.map((m) => m.wounds), [3, 1]);
});

test("removing models and reviving", () => {
  const u = inf(1, "ork", 10, 10, 10);
  const s = game([u]);
  E.resetOrigin(u);
  E.removeModelCount(s, u, 3);
  assert.equal(u.models.length, 7);
  assert.equal(u.origin.models.length, 7);
  E.reviveModel(s, u);
  assert.equal(u.models.length, 8);
  assert.ok(E.belowHalf({ models: [1, 2], casualties: [1, 2, 3] }));
});

test("destroying a bodyguard detaches leaders and flags embarked units", () => {
  const body = inf(1, "da", 10, 10), lead = inf(2, "da", 12, 10, 1, { attachedTo: 1 });
  const tr = inf(3, "da", 20, 20, 1, { vehicle: true, diam: 3 }), pass = inf(4, "da", 0, 0, 5, { locationState: "embarked", transportId: 3 });
  const s = game([body, lead, tr, pass]);
  E.destroyUnit(s, body);
  assert.equal(lead.attachedTo, undefined);
  E.destroyUnit(s, tr);
  assert.ok(pass.needsEmergencyDisembark);
});

test("distances are edge to edge and range counts models", () => {
  const a = inf(1, "ork", 10, 10, 1), b = inf(2, "da", 20, 10, 1); // 32mm bases ≈ 1.26″
  const d = E.unitDistance(a, b);
  assert.ok(Math.abs(d - (10 - 32 / 25.4)) < 0.05, "distance " + d);
  const r = E.modelsInRange(a, b, 9);
  assert.equal(r.count, 1);
  assert.equal(E.modelsInRange(a, b, 8).count, 0);
});

test("objective control sums OC within 3″ + marker radius, battle-shock zeroes OC", () => {
  const a = inf(1, "ork", 10, 10, 3), b = inf(2, "da", 14.5, 10, 1);
  const s = game([a, b]);
  const objs = [{ id: "o1", kind: "central", x: 12, y: 10 }];
  let r = E.objectiveControl(s, objs);
  assert.equal(r.objectives[0].oc.ork, 3);
  assert.equal(r.objectives[0].oc.da, 1);
  assert.equal(r.objectives[0].controller, "ork");
  E.addEffect(s, a, { label: "Battle-shocked", mods: { oc: 0 } });
  r = E.objectiveControl(s, objs);
  assert.equal(r.objectives[0].controller, "da");
});

test("coherency: isolated model and 8″ spread are reported", () => {
  const u = inf(1, "ork", 10, 10, 3);
  u.models[2].x = 12;
  const s = game([u]);
  const c = E.coherency(s, u);
  assert.equal(c.ok, false);
  assert.ok(c.issues.join().includes("8″"));
  const ok = inf(2, "ork", 20, 20, 5);
  assert.ok(E.coherency(game([ok]), ok).ok);
});

test("terrain: solid blocks vehicles, not infantry; nobody ends on low/solid", () => {
  const wall = [[15, 0], [16, 0], [16, 20], [15, 20]];
  const ctx = E.terrainContext([], [{ kind: "solid", polygon: wall }, { kind: "low", polygon: [[30, 30], [32, 30], [32, 32], [30, 32]] }]);
  const tank = inf(1, "ork", 10, 10, 1, { vehicle: true, diam: 3, models: [{ x: 0, y: 0 }] });
  const boy = inf(2, "ork", 10, 12, 1, { keywords: ["INFANTRY"] });
  assert.ok(E.terrainMoveIssues(ctx, tank, 20, 10).some((x) => x.includes("Path crosses")));
  assert.deepEqual(E.terrainMoveIssues(ctx, boy, 20, 12), []);
  assert.ok(E.terrainMoveIssues(ctx, boy, 15.5, 12).some((x) => x.includes("solid")));
  assert.ok(E.terrainMoveIssues(ctx, boy, 31, 31).some((x) => x.includes("low")));
});

test("visibility: ruin footprint between units blocks; standing inside does not", () => {
  const ruin = { feature_type: "terrain_area", geometry: { type: "Polygon", coordinates: [[[18, 5], [22, 5], [22, 15], [18, 15], [18, 5]]] } };
  const ctx = E.terrainContext([ruin]);
  const a = inf(1, "ork", 10, 10, 1), b = inf(2, "da", 30, 10, 1);
  assert.equal(E.unitVisibility(ctx, a, b).targetModelsVisible, 0);
  b.x = 20; // target inside the ruin
  const v = E.unitVisibility(ctx, a, b);
  assert.equal(v.targetModelsVisible, 1);
  assert.ok(v.targetInCover);
  const clear = inf(3, "da", 30, 30, 1);
  assert.equal(E.unitVisibility(ctx, a, clear).targetModelsVisible, 1);
});

test("deployment: wholly within zone", () => {
  const zone = [[0, 0], [14, 0], [14, 60], [0, 60]];
  const u = inf(1, "ork", 5, 30, 3);
  assert.equal(E.whollyWithin(u, zone), true);
  assert.equal(E.whollyWithin(u, zone, 13.5, 30), false);
});

test("placement rules: disembark 3″, enemy 8″, reserves within 6″ of an edge", () => {
  const tr = inf(1, "ork", 20, 30, 1, { vehicle: true, diam: 4, models: [{ x: 0, y: 0 }] });
  const boyz = inf(2, "ork", 0, 0, 5, { locationState: "embarked", transportId: 1 });
  const enemy = inf(3, "da", 40, 30, 1);
  const s = game([tr, boyz, enemy]);
  assert.equal(E.placementError(s, boyz, { x: 17.2, y: 33.5 }, { action: "disembark", disembark: 3 }), null);
  assert.match(E.placementError(s, boyz, { x: 20, y: 40 }, { action: "disembark", disembark: 3 }), /within 3/);
  boyz.locationState = "reserves";
  assert.match(E.placementError(s, boyz, { x: 33, y: 30 }, { action: "deep strike", enemy: 8 }), /Too close/);
  assert.match(E.placementError(s, boyz, { x: 20, y: 50 }, { action: "deploy reserves", enemy: 8, edge: 6 }), /6″/);
  assert.equal(E.placementError(s, boyz, { x: 20, y: 57 }, { action: "deploy reserves", enemy: 8, edge: 6 }), null);
});

test("describeChanges reports moves, casualties, phase and score", () => {
  const a = game([inf(1, "ork", 10, 10, 3, { wounds: 1 })]);
  const b = structuredClone(a);
  b.units[0].x = 14;
  E.applyWounds(b, b.units[0], 1);
  E.advancePhase(b);
  E.addVP(b, "ork", "primary", 5, "held 2");
  const kinds = E.describeChanges(a, b).map((c) => c.type);
  for (const k of ["phase", "score", "moved", "models"]) assert.ok(kinds.includes(k), k);
});

test("VP caps and history", () => {
  const s = game([]);
  E.addVP(s, "da", "primary", 60);
  assert.equal(s.score.da.primary, 50);
  E.addVP(s, "da", "secondary", 5, "Assassination");
  assert.equal(E.vpTotal(s.score.da), 55);
  assert.equal(s.score.da.history.length, 2);
});

test("datasheet matching handles numbering, sides and aliases", () => {
  const sheets = [{ slug: "Gunwagon", name: "Gunwagon", profiles: [{ W: "16", OC: "5" }], keywords: ["VEHICLE"] }, { slug: "Ghazghkull-Thraka", name: "Ghazghkull Thraka", profiles: [{ W: "16", OC: "4" }] }, { slug: "Boyz", name: "Boyz", profiles: [{ W: "1", OC: "2" }] }, { slug: "Wazbom", name: "Wazbom Blastajet", profiles: [{ W: "12", OC: "-" }] }];
  assert.equal(E.matchDatasheet({ name: "Left Gunwagon" }, sheets).slug, "Gunwagon");
  assert.equal(E.matchDatasheet({ name: "Gunwagon 2" }, sheets).slug, "Gunwagon");
  assert.equal(E.matchDatasheet({ name: "Ghaz" }, sheets).slug, "Ghazghkull-Thraka");
  assert.equal(E.matchDatasheet({ name: "20 Boyz" }, sheets).slug, "Boyz");
  const u = { name: "Gunwagon 1", models: [{}], wounds: null };
  E.applyDatasheet(u, E.matchDatasheet(u, sheets));
  assert.equal(u.wounds, 16); assert.equal(u.models[0].wounds, 16); assert.equal(u.oc, 5);
  const j = { name: "Wazbom Blastajet", models: [{}], wounds: null };
  E.applyDatasheet(j, E.matchDatasheet(j, sheets));
  assert.equal(j.oc, undefined);
});
