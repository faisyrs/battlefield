// Runs the bundled MCP edge function in Node with a stubbed Deno runtime and PostgREST.
// Build first: npm run build:mcp
import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const inf = (id, side, x, y, n, extra = {}) => ({ id, name: extra.name || "U" + id, side, x, y, angle: 0, move: 6, bonus: 0, baseSize: 32, locationState: "deployed", models: Array.from({ length: n }, (_, i) => ({ x: (i % 5) * 1.4, y: Math.floor(i / 5) * 1.4 })), ...extra });
const db = {
  game: { id: "g1", name: "Test", revision: 5, board_width: 44, board_height: 60, state: { version: 1, board: { width: 44, height: 60 }, map_id: "m1", setup: { orkSide: "attacker", daSide: "defender", orkDisposition: "Take and Hold", daDisposition: "Purge the Foe" }, units: [inf(1, "ork", 10, 30, 10, { name: "Boyz", wounds: 1 }), inf(2, "da", 30, 30, 5, { name: "Intercessors", wounds: 2 }), inf(3, "ork", 5, 50, 1, { name: "Trukk", vehicle: true, diam: 4, transport: true, models: [{ x: 0, y: 0 }] }), inf(4, "ork", 0, 0, 5, { name: "Nobz", locationState: "reserves", wounds: 3 })] } },
  features: [
    { feature_id: "o1", feature_type: "central_objective", geometry: { type: "Point", coordinates: [20, 30] } },
    { feature_id: "r1", feature_type: "terrain_area", geometry: { type: "Polygon", coordinates: [[[18, 20], [22, 20], [22, 26], [18, 26], [18, 20]]] } },
    { feature_id: "z1", feature_type: "attacker_deployment", geometry: { type: "Polygon", coordinates: [[[0, 0], [14, 0], [14, 60], [0, 60], [0, 0]]] } },
  ],
  proposals: [], messages: [], events: [],
  datasheets: [{ edition: 11, faction: "orks", slug: "Boyz", name: "Boyz", ranged: [{ name: "Slugga", range: '12"' }], melee: [{ name: "Choppa" }], abilities: [{ name: "Waaagh!", summary: "x" }], keywords: ["INFANTRY"] }],
};
let handler;
globalThis.Deno = { env: { get: (k) => ({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_ANON_KEY: "anon" })[k] }, serve: (h) => { handler = h; } };
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url), p = u.pathname.replace("/rest/v1/", ""), q = u.searchParams, body = init.body ? JSON.parse(init.body) : null;
  const ok = (v, s = 200) => new Response(JSON.stringify(v), { status: s, headers: { "content-type": "application/json" } });
  if (p === "tabletop_games") return ok(q.get("select")?.startsWith("revision") ? [{ revision: db.game.revision }] : [structuredClone(db.game)]);
  if (p === "battlefield_maps") return ok([{ id: "m1", status: "verified", board_width: 44, board_height: 60 }]);
  if (p === "battlefield_map_features") return ok(db.features);
  if (p === "tabletop_proposals" && init.method === "POST") { const r = { id: "p" + (db.proposals.length + 1), status: "pending", ...body }; db.proposals.push(r); return ok([r], 201); }
  if (p === "tabletop_proposals") return ok(db.proposals.filter((x) => (q.get("status") === "eq.pending" ? x.status === "pending" : x.status !== "pending")));
  if (p === "tabletop_messages" && init.method === "POST") { db.messages.push(body); return ok([body], 201); }
  if (p === "tabletop_messages") return ok(db.messages);
  if (p === "tabletop_events") return ok(db.events);
  if (p === "datasheets") return ok(db.datasheets.filter((d) => (q.get("slug") || "").includes(d.slug) || (q.get("name") || "").toLowerCase().includes(d.name.toLowerCase())));
  return ok({ message: "unhandled " + p }, 404);
};
await import(pathToFileURL("/tmp/mcp.js").href);
let id = 0;
const call = async (name, args) => {
  const r = await handler(new Request("https://x/fn", { method: "POST", headers: { authorization: "Bearer t" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }) }));
  const j = await r.json();
  if (j.error) return { error: j.error.message };
  return JSON.parse(j.result.content[0].text);
};

test("initialize advertises opponent instructions; tools/list has new tools", async () => {
  const r = await (await handler(new Request("https://x", { method: "POST", headers: { authorization: "Bearer t" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) }))).json();
  assert.match(r.result.instructions, /get_turn_brief/);
  const t = await (await handler(new Request("https://x", { method: "POST", headers: { authorization: "Bearer t" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) }))).json();
  for (const n of ["get_turn_brief", "get_events_since", "propose_changes", "find_targets", "objective_control"]) assert.ok(t.result.tools.some((x) => x.name === n), n);
});

test("turn brief is compact and complete", async () => {
  const b = await call("get_turn_brief", { game_id: "g1", side: "da" });
  assert.equal(b.turn.phase, "command");
  assert.equal(b.yours[0].name, "Intercessors");
  assert.ok("controller" in b.objectives[0]);
  assert.ok(b.threats[0].nearest[0].d > 10);
  assert.ok(JSON.stringify(b).length < 4000, "brief size " + JSON.stringify(b).length);
});

test("batch proposal: phase, advance + move, damage, score; overrun rejected", async () => {
  const bad = await call("propose_changes", { game_id: "g1", changes: [{ op: "move", unit: "Boyz", x: 25, y: 30 }] });
  assert.match(bad.error, /allowance/);
  const r = await call("propose_changes", { game_id: "g1", note: "Waaagh", changes: [
    { op: "phase", to: "movement" }, { op: "advance", unit: "Boyz", roll: 4 }, { op: "move", unit: "Boyz", x: 19, y: 30 },
    { op: "damage", unit: "Intercessors", wounds: 3 }, { op: "score", side: "ork", kind: "primary", delta: 5, reason: "test" },
    { op: "location", unit: "Nobz", action: "deep strike", x: 33, y: 30 },
  ] });
  assert.equal(r.error, undefined, r.error);
  const st = db.proposals.at(-1).proposed_state;
  assert.equal(st.turn.phase, "movement");
  assert.equal(st.units[0].x, 19);
  assert.equal(st.units[1].models.length, 4);
  assert.equal(st.score.ork.primary, 5);
  assert.ok(r.warnings.some((w) => w.includes("Too close")), JSON.stringify(r.warnings));
});

test("measure, visibility, targets, objectives, coherency, datasheet, chat", async () => {
  const m = await call("measure", { game_id: "g1", from: "Boyz", to: "Intercessors", range: 18 });
  assert.ok(m.distance > 10 && m.distance < 20);
  const v = await call("check_visibility", { game_id: "g1", attacker: 1, target: 2 });
  assert.ok(v.targetModelsVisible >= 1);
  const t = await call("find_targets", { game_id: "g1", unit: "Boyz" });
  assert.equal(t.datasheet, "Boyz");
  assert.equal(t.targets[0].name, "Intercessors");
  const o = await call("objective_control", { game_id: "g1" });
  assert.equal(o.objectives.length, 1);
  const c = await call("check_coherency", { game_id: "g1" });
  assert.ok(Array.isArray(c.issues));
  const d = await call("get_datasheet", { game_id: "g1", unit: "Boyz" });
  assert.deepEqual(d.keywords, ["INFANTRY"]);
  assert.deepEqual(await call("send_message", { game_id: "g1", text: "Your move" }), { sent: true });
  const e = await call("get_events_since", { game_id: "g1", since_revision: 5, wait_seconds: 0 });
  assert.equal(e.changed, false);
});
