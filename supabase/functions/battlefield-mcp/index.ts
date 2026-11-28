import "jsr:@supabase/functions-js/edge-runtime.d.ts";
// Battlefield MCP server: stateless JSON-RPC 2.0 over HTTP POST (protocol 2025-03-26).
// Auth: Supabase user access JWT (forwarded by the battlefield-oauth bridge). RLS scopes all data.
// All game-changing tools stage proposals; the player approves in the app (or via commit_move).
import * as E from "./engine.js";

const URL_BASE = Deno.env.get("SUPABASE_URL")!;
const PUBLIC_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const DISPOSITIONS = ["Take and Hold", "Purge the Foe", "Disruption", "Reconnaissance", "Priority Assets"];
const SIDE = { type: "string", enum: ["ork", "da"] };
const GAME = { type: "string", description: "Game UUID from list_games" };
const UNIT = { type: "string", description: "Unit id or exact name" };

const INSTRUCTIONS = `40K Battlefield: a tabletop emulator, not a rules engine. Coordinates are inches from the top-left of a 44x60 board.
Efficient opponent loop: (1) get_turn_brief(game_id, side) once per phase; (2) query rules only as needed (get_datasheet, measure, check_visibility, objective_control, get_applicable_scoring);
(3) stage ALL of your changes for the phase in ONE propose_changes call; (4) wait with get_events_since(game_id, since_revision, wait_seconds=25) until the player approves and acts.
Never commit_move unless the player explicitly approves in chat. Damage you suffer from the player's attacks is applied by the player in the app; you may propose damage you inflict.`;

const changeSchema = {
  type: "object",
  required: ["op"],
  properties: {
    op: { type: "string", enum: ["move", "location", "deploy", "advance", "charge", "pile_in", "damage", "remove_models", "destroy", "restore", "effect", "score", "phase", "set"] },
    unit: UNIT,
    x: { type: "number" }, y: { type: "number" }, rotation: { type: "number" },
    models: { type: "array", items: { type: "object" }, description: "deploy/move: per-model offsets [{x,y}] relative to unit centre" },
    action: { type: "string", description: "location: embark|disembark|reserves|deep strike|rapid ingress|deploy reserves; deploy: deploy|reserves|embark" },
    transport_id: { type: "string" },
    roll: { type: "number", description: "advance: D6 result; charge: 2D6 result" },
    wounds: { type: "integer", description: "damage: total wounds, or number of failed saves when damage is given" },
    damage: { type: "integer", description: "damage: D characteristic per failed save (no spill-over)" },
    model: { type: "integer" }, count: { type: "integer" }, indexes: { type: "array", items: { type: "integer" } },
    label: { type: "string" }, expires: { type: "string", enum: ["manual", "end_of_phase", "end_of_turn", "end_of_round", "start_of_your_command"] }, remove: { type: "boolean" }, mods: { type: "object" },
    side: SIDE, kind: { type: "string", enum: ["primary", "secondary", "cp"] }, delta: { type: "number" }, reason: { type: "string" },
    to: { type: "string", description: "phase: 'next' or a phase name" }, round: { type: "integer" }, active: SIDE,
    fields: { type: "object", description: "set: {wounds, oc, keywords, datasheet, loadout, move}" },
    disembark: { type: "number" }, enemy: { type: "number" }, edge: { type: "number" },
  },
};

const tools: any[] = [
  { name: "list_games", description: "List your battlefield games", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "get_turn_brief", description: "ONE compact call per phase: turn, score, CP, both armies (positions, models, wounds, effects), objective control, nearest enemies, deployment/reserve status and phase prompts. Use instead of get_battlefield.", inputSchema: { type: "object", properties: { game_id: GAME, side: { ...SIDE, description: "Your side (perspective for threats)" } }, required: ["game_id"] } },
  { name: "get_events_since", description: "What changed since a revision (moves, casualties, phase, score, chat, proposal results). wait_seconds (max 25) long-polls until something changes, so you don't need to be told the player acted.", inputSchema: { type: "object", properties: { game_id: GAME, since_revision: { type: "integer" }, wait_seconds: { type: "integer", minimum: 0, maximum: 25 } }, required: ["game_id", "since_revision"] } },
  { name: "propose_changes", description: "Stage a batch of changes as ONE atomic proposal for player approval. Each change is validated against the state after the previous ones (movement allowance, overlaps, terrain, coherency, placement distances); warnings are returned, hard errors reject the batch. Ops: move, location, deploy, advance(roll), charge(roll), pile_in, damage, remove_models, destroy, restore, effect, score, phase, set.", inputSchema: { type: "object", properties: { game_id: GAME, changes: { type: "array", minItems: 1, maxItems: 40, items: changeSchema }, note: { type: "string" }, allow_overrun: { type: "boolean", description: "Allow moves beyond allowance (warn instead of reject)" } }, required: ["game_id", "changes"] } },
  { name: "measure", description: "Edge-to-edge distance between two units, and per-model counts within an optional range", inputSchema: { type: "object", properties: { game_id: GAME, from: UNIT, to: UNIT, range: { type: "number" } }, required: ["game_id", "from", "to"] } },
  { name: "check_visibility", description: "2D line-of-sight aid: which attacker models can see target models (ruin footprints and solid terrain block), cover, distance. Optionally restrict to weapon range.", inputSchema: { type: "object", properties: { game_id: GAME, attacker: UNIT, target: UNIT, range: { type: "number" } }, required: ["game_id", "attacker", "target"] } },
  { name: "find_targets", description: "For one of your units: every enemy unit with distance, visible models and whether in range of each of its weapons (needs datasheet). Fast shooting/charge planning.", inputSchema: { type: "object", properties: { game_id: GAME, unit: UNIT, max_distance: { type: "number" } }, required: ["game_id", "unit"] } },
  { name: "objective_control", description: "Objective control (11th): OC of every model whose footprint overlaps the objective terrain area (battle-shocked = 0)", inputSchema: { type: "object", properties: { game_id: GAME }, required: ["game_id"] } },
  { name: "check_coherency", description: "Unit coherency issues (2″ neighbours, 8″ spread), optionally for one side", inputSchema: { type: "object", properties: { game_id: GAME, side: SIDE }, required: ["game_id"] } },
  { name: "get_datasheet", description: "Compact datasheet (profiles, weapons, ability names+summaries, keywords). Look up by name or by a unit in a game.", inputSchema: { type: "object", properties: { name: { type: "string" }, game_id: GAME, unit: UNIT, faction: { type: "string" } } } },
  { name: "search_datasheets", description: "Find datasheets by partial name or keyword", inputSchema: { type: "object", properties: { query: { type: "string" }, faction: { type: "string" } }, required: ["query"] } },
  { name: "send_message", description: "Post a chat message to the game table (shown to the player)", inputSchema: { type: "object", properties: { game_id: GAME, text: { type: "string" }, side: SIDE }, required: ["game_id", "text"] } },
  { name: "get_battlefield", description: "Full saved game state (large). Prefer get_turn_brief. include_map adds terrain/objective geometry.", inputSchema: { type: "object", properties: { game_id: GAME, include_map: { type: "boolean" } }, required: ["game_id"] } },
  { name: "get_unit", description: "Full record for one unit", inputSchema: { type: "object", properties: { game_id: GAME, unit: UNIT }, required: ["game_id", "unit"] } },
  { name: "propose_move", description: "Stage one unit move (prefer propose_changes for several).", inputSchema: { type: "object", properties: { game_id: GAME, unit: UNIT, x: { type: "number" }, y: { type: "number" }, rotation: { type: "number" }, note: { type: "string" } }, required: ["game_id", "unit", "x", "y"] } },
  { name: "propose_location", description: "Stage embark, disembark, reserves, deep strike, rapid ingress or deploy reserves.", inputSchema: { type: "object", properties: { game_id: GAME, unit: UNIT, action: { type: "string", enum: ["embark", "disembark", "reserves", "deep strike", "rapid ingress", "deploy reserves"] }, transport_id: { type: "string" }, x: { type: "number" }, y: { type: "number" }, disembark: { type: "number" }, enemy: { type: "number" }, edge: { type: "number" } }, required: ["game_id", "unit", "action"] } },
  { name: "propose_deployment", description: "Stage initial deployment (deploy/reserves/embark) for an undeployed unit.", inputSchema: { type: "object", properties: { game_id: GAME, unit: UNIT, action: { type: "string", enum: ["deploy", "reserves", "embark"] }, x: { type: "number" }, y: { type: "number" }, rotation: { type: "number" }, models: { type: "array", items: { type: "object" } }, transport_id: { type: "string" } }, required: ["game_id", "unit", "action"] } },
  { name: "commit_move", description: "Commit a staged proposal ONLY after the player explicitly approves in chat.", inputSchema: { type: "object", properties: { proposal_id: { type: "string" }, approved: { type: "boolean" } }, required: ["proposal_id", "approved"] } },
  { name: "create_game", description: "Create a new game on a verified map with undeployed units", inputSchema: { type: "object", properties: { name: { type: "string" }, map_id: { type: "string" }, units: { type: "array", items: { type: "object", required: ["id", "name", "side", "move", "models"] } }, setup: { type: "object" } }, required: ["name", "map_id", "units", "setup"] } },
  { name: "list_maps", description: "List verified battlefield layouts", inputSchema: { type: "object", properties: {} } },
  { name: "get_map", description: "Map geometry: terrain, objectives, deployment zones (inches from top-left)", inputSchema: { type: "object", properties: { map_id: { type: "string" } }, required: ["map_id"] } },
  { name: "get_mission_reference", description: "Edition 11 primary mission matrix and secondary index; optional dispositions filter", inputSchema: { type: "object", properties: { disposition: { type: "string", enum: DISPOSITIONS }, opponent_disposition: { type: "string", enum: DISPOSITIONS } } } },
  { name: "get_mission_matchup", description: "Both players' primary mission names from dispositions", inputSchema: { type: "object", properties: { disposition: { type: "string", enum: DISPOSITIONS }, opponent_disposition: { type: "string", enum: DISPOSITIONS } }, required: ["disposition", "opponent_disposition"] } },
  { name: "get_mission_rules", description: "Scoring and source for a named mission", inputSchema: { type: "object", properties: { name: { type: "string" }, type: { type: "string", enum: ["primary", "secondary"] } }, required: ["name", "type"] } },
  { name: "list_secondary_missions", description: "Secondary names and scoring availability", inputSchema: { type: "object", properties: { mode: { type: "string", enum: ["fixed", "tactical"] } } } },
  { name: "get_applicable_scoring", description: "Scoring conditions relevant now. With game_id, dispositions/round/turn/phase/secondaries are read from the game.", inputSchema: { type: "object", properties: { game_id: GAME, side: SIDE, disposition: { type: "string", enum: DISPOSITIONS }, opponent_disposition: { type: "string", enum: DISPOSITIONS }, active_secondaries: { type: "array", items: { type: "object", properties: { name: { type: "string" }, mode: { type: "string", enum: ["fixed", "tactical"] } } } }, battle_round: { type: "integer" }, active_turn: { type: "string", enum: ["self", "opponent"] }, phase: { type: "string" }, scope: { type: "string", enum: ["current_phase", "remaining_turn", "current_turn", "all_phases"] } } } },
];

const headers = { "Content-Type": "application/json", "MCP-Protocol-Version": "2025-03-26", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization,content-type,mcp-protocol-version,accept", "Access-Control-Allow-Methods": "POST,GET,OPTIONS" };
const j = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers });
const result = (v: unknown) => ({ content: [{ type: "text", text: JSON.stringify(v) }] });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return j({});
  if (req.method === "GET") return j({ name: "40k-battlefield-mcp", status: "ready", version: "0.2.0" });
  if (req.method !== "POST") return j({ error: "Method not allowed" }, 405);
  const auth = req.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) return j({ error: "Bearer user access token required" }, 401);
  const api = async (path: string, init: RequestInit = {}) => {
    const r = await fetch(URL_BASE + "/rest/v1/" + path, { ...init, headers: { apikey: PUBLIC_KEY, authorization: auth, "content-type": "application/json", prefer: "return=representation", ...(init.headers || {}) } });
    const raw = await r.text();
    let data; try { data = JSON.parse(raw); } catch { data = raw; }
    if (!r.ok) throw Error("Database " + r.status + ": " + (typeof data === "object" ? data.message || JSON.stringify(data) : data));
    return data;
  };
  const msg = await req.json().catch(() => null);
  if (!msg || msg.jsonrpc !== "2.0") return j({ jsonrpc: "2.0", id: msg?.id ?? null, error: { code: -32600, message: "Invalid JSON-RPC" } }, 400);
  const reply = (r: unknown) => j({ jsonrpc: "2.0", id: msg.id, result: r });
  const err = (e: unknown) => j({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: String(e instanceof Error ? e.message : e) } });
  if (msg.method?.startsWith("notifications/")) return new Response(null, { status: 202 });
  if (msg.method === "initialize") return reply({ protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "40k-battlefield", version: "0.2.0" }, instructions: INSTRUCTIONS });
  if (msg.method === "ping") return reply({});
  if (msg.method === "tools/list") return reply({ tools });
  if (msg.method !== "tools/call") return err("Unsupported method");
  const name = msg.params?.name, a = msg.params?.arguments || {};

  /* ---------- helpers ---------- */
  const mapCache = new Map<string, any>();
  const getMap = async (mapId: string) => {
    if (!mapId) return null;
    if (mapCache.has(mapId)) return mapCache.get(mapId);
    const key = encodeURIComponent(mapId);
    const maps = await api("battlefield_maps?id=eq." + key + "&select=*");
    if (maps.length !== 1) throw Error("Map not found");
    const features = await api("battlefield_map_features?map_id=eq." + key + "&select=feature_id,feature_type,geometry&limit=2000");
    const m = { map: maps[0], features };
    mapCache.set(mapId, m);
    return m;
  };
  const loadGame = async (id: string) => {
    if (!id) throw Error("game_id required");
    const rows = await api("tabletop_games?id=eq." + encodeURIComponent(id) + "&select=id,name,revision,state,board_width,board_height");
    if (rows.length !== 1) throw Error("Game not found or access denied");
    const g = rows[0];
    g.state.board ??= { width: Number(g.board_width), height: Number(g.board_height) };
    E.upgradeState(g.state);
    // Fill W/OC/keywords from datasheets so damage and objective control are right even before the app has done it.
    if (g.state.units.some((u: any) => u.wounds == null)) {
      const sheets = await allSheets();
      for (const u of g.state.units) E.applyDatasheet(u, E.matchDatasheet(u, sheets));
    }
    return g;
  };
  let sheetRows: any[] | null = null;
  const allSheets = async () => sheetRows ??= await api("datasheets?edition=eq.11&select=faction,slug,name,profiles,keywords&limit=1000").catch(() => []);
  const unitOf = (state: any, ref: any) => { const u = E.findUnit(state, ref); if (!u) throw Error("Unit not found: " + ref); return u; };
  const sheetCache = new Map<string, any>();
  const datasheetFor = async (u: any) => {
    const key = u.datasheet || String(u.name || "").replace(/\s*(\d+|×\s*\d+|x\s*\d+|—.*)$/i, "").trim();
    if (sheetCache.has(key)) return sheetCache.get(key);
    let rows = await api("datasheets?edition=eq.11&slug=eq." + encodeURIComponent(key) + "&limit=1").catch(() => []);
    if (!rows.length) rows = await api("datasheets?edition=eq.11&name=ilike." + encodeURIComponent(key) + "&limit=1").catch(() => []);
    if (!rows.length) rows = await api("datasheets?edition=eq.11&name=ilike." + encodeURIComponent("*" + key.split(" ").slice(0, 2).join(" ") + "*") + "&limit=1").catch(() => []);
    const ds = rows[0] || null;
    sheetCache.set(key, ds);
    return ds;
  };
  const compactSheet = (d: any) => d && ({
    name: d.name, faction: d.faction, base: d.base, source: d.source_url,
    profiles: d.profiles, ranged: d.ranged, melee: d.melee,
    abilities: (d.abilities || []).map((x: any) => x.summary ? x.name + ": " + x.summary : x.name),
    keywords: d.keywords, leader_of: d.leader_of?.length ? d.leader_of : undefined, points: d.points,
  });
  const parseRange = (r: any) => { const n = parseFloat(String(r ?? "").replace(/[^0-9.]/g, "")); return Number.isFinite(n) ? n : null; };
  const terrainFor = async (state: any) => { const m = state.map_id ? await getMap(state.map_id) : null; return { m, ctx: E.terrainContext(m?.features || [], state.obstacles) }; };
  const propose = async (game: any, next: any, note: string) => {
    const p = await api("tabletop_proposals", { method: "POST", body: JSON.stringify({ game_id: game.id, based_on_revision: game.revision, proposed_state: next, note: String(note || "AI proposal").slice(0, 500) }) });
    return p[0];
  };

  /** Apply a list of changes to state (mutates). Returns {warnings, applied}. Throws on hard errors. */
  const applyChanges = async (state: any, changes: any[], opts: any = {}) => {
    const warnings: string[] = [], applied: any[] = [];
    const { m, ctx } = await terrainFor(state);
    const touched = new Set<string>();
    for (const [i, c] of changes.entries()) {
      const where = "#" + (i + 1) + " " + c.op + (c.unit != null ? " " + c.unit : "");
      const fail = (t: string) => { throw Error(where + ": " + t); };
      const u = c.unit != null ? unitOf(state, c.unit) : null;
      switch (c.op) {
        case "move": {
          if (!u) fail("unit required");
          if (u.locationState !== "deployed") fail("unit is off-board; use location");
          if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) fail("x and y required");
          if (!u.origin || u.origin.models?.length !== u.models.length) E.resetOrigin(u);
          const angle = c.rotation ?? u.angle ?? 0;
          for (const t of E.terrainMoveIssues(ctx, u, c.x, c.y, angle)) warnings.push(u.name + ": " + t);
          u.x = c.x; u.y = c.y; u.angle = angle;
          if (Array.isArray(c.models)) { if (c.models.length !== u.models.length) fail("models length mismatch"); u.models.forEach((mm: any, k: number) => { if (Number.isFinite(c.models[k].x)) mm.x = c.models[k].x; if (Number.isFinite(c.models[k].y)) mm.y = c.models[k].y; }); }
          const used = E.measureOrigin(u), allow = E.allowance(u);
          if (used > allow + 1e-6) { const t = u.name + " moves " + used.toFixed(2) + "″ > allowance " + allow.toFixed(2) + "″"; if (opts.allow_overrun) warnings.push(t); else fail(t); }
          if (u.vehicle) u.trail = [[u.origin.x, u.origin.y], [u.x, u.y]];
          const W = Number(state.board.width), H = Number(state.board.height);
          if (E.modelPolygons(u).flat().some(([x, y]: number[]) => x < 0 || x > W || y < 0 || y > H)) fail("model off the battlefield");
          for (const v of state.units) if (v.id !== u.id && E.isOnTable(v)) for (const pa of E.modelPolygons(u)) for (const pb of E.modelPolygons(v)) if (E.polyDistance(pa, pb) < E.EPS) { warnings.push(u.name + " overlaps " + v.name); break; }
          for (const v of state.units) if (v.side !== u.side && E.isOnTable(v) && E.unitDistance(u, v) < 1 && state.turn.phase === "movement") warnings.push(u.name + " ends within 1″ of " + v.name + " (engagement)");
          touched.add(E.rootOf(state, u));
          applied.push({ op: "move", unit: u.name, moved: E.round2(used), allowance: E.round2(allow) });
          break;
        }
        case "advance": if (!u) fail("unit required"); if (!(c.roll >= 1 && c.roll <= 6)) fail("roll 1-6 required"); u.bonus = Number(c.roll); E.addEffect(state, u, { label: "Advanced", expires: "end_of_turn" }); applied.push({ op: "advance", unit: u.name, allowance: E.allowance(u) }); break;
        case "charge": if (!u) fail("unit required"); if (!(c.roll >= 2 && c.roll <= 12)) fail("roll 2-12 required"); u.bonus = Number(c.roll) - Number(u.move || 0); E.resetOrigin(u); E.addEffect(state, u, { label: "Charged", expires: "end_of_turn" }); applied.push({ op: "charge", unit: u.name, allowance: E.allowance(u) }); break;
        case "pile_in": if (!u) fail("unit required"); u.bonus = E.PILE_IN - Number(u.move || 0); E.resetOrigin(u); applied.push({ op: "pile_in", unit: u.name, allowance: E.allowance(u) }); break;
        case "location":
        case "deploy": {
          if (!u) fail("unit required");
          const action = c.action;
          const st = u.locationState;
          if (c.op === "deploy" && st !== "undeployed") fail("unit is not undeployed");
          if (action === "embark") {
            const v = unitOf(state, c.transport_id);
            if (u.vehicle || v.id === u.id || v.side !== u.side || !(v.transport || /gunwagon|battlewagon|trukk|rhino|impulsor|land raider|repulsor|razorback/i.test(v.name))) fail("invalid transport");
            if (c.op === "location" && (st !== "deployed" || v.locationState !== "deployed")) fail("unit and transport must be on the table");
            u.locationState = "embarked"; u.transportId = v.id;
          } else if (action === "reserves") { if (!["deployed", "undeployed"].includes(st)) fail("unit must be on the table or undeployed"); u.locationState = "reserves"; delete u.transportId; }
          else if (["deploy", "disembark", "deep strike", "rapid ingress", "deploy reserves"].includes(action)) {
            const need = action === "deploy" ? "undeployed" : action === "disembark" ? "embarked" : "reserves";
            if (st !== need) fail("unit must be " + need);
            if (!Number.isFinite(c.x) || !Number.isFinite(c.y)) fail("x and y required");
            if (Array.isArray(c.models)) { if (c.models.length !== u.models.length) fail("models length mismatch"); u.models = u.models.map((mm: any, k: number) => ({ ...mm, x: c.models[k].x, y: c.models[k].y })); }
            const p = { x: c.x, y: c.y, angle: c.rotation ?? u.angle ?? 0 };
            if (action === "deploy") {
              const role = E.sideRole(state.setup, u.side), zone = m && role ? E.deploymentZone(m.features, role) : null;
              const w = E.whollyWithin(u, zone, p.x, p.y, p.angle);
              if (w === false) warnings.push(u.name + " is not wholly within the " + role + " deployment zone");
              if (w === null) warnings.push("Deployment zone unavailable; verify manually");
              const e = E.placementError(state, u, p, { action: "deploy", enemy: -1 });
              if (e) warnings.push(u.name + ": " + e);
            } else {
              const e = E.placementError(state, u, p, { action, disembark: c.disembark ?? 3, enemy: c.enemy ?? 8, edge: c.edge ?? 6 });
              if (e) warnings.push(u.name + ": " + e);
            }
            for (const t of E.terrainMoveIssues(ctx, { ...u, keywords: ["INFANTRY"] }, p.x, p.y, p.angle)) if (t.includes("end")) warnings.push(u.name + ": " + t);
            u.x = p.x; u.y = p.y; u.angle = p.angle; u.locationState = "deployed"; u.arrivalMethod = action; delete u.transportId; delete u.needsEmergencyDisembark;
          } else fail("unknown action " + action);
          E.resetOrigin(u);
          applied.push({ op: c.op, unit: u.name, action, status: u.locationState });
          break;
        }
        case "damage": { if (!u) fail("unit required"); const r = E.applyWounds(state, u, c.wounds, { damage: c.damage, model: c.model }); applied.push({ op: "damage", unit: u.name, ...r }); break; }
        case "remove_models": { if (!u) fail("unit required"); const out = Array.isArray(c.indexes) ? E.removeModels(state, u, c.indexes) : E.removeModelCount(state, u, c.count ?? 1); applied.push({ op: "remove_models", unit: u.name, removed: out.length, remaining: u.models.length }); break; }
        case "destroy": if (!u) fail("unit required"); E.destroyUnit(state, u, { by: c.reason }); applied.push({ op: "destroy", unit: u.name }); break;
        case "restore": if (!u) fail("unit required"); E.restoreUnit(state, u); applied.push({ op: "restore", unit: u.name }); break;
        case "effect": if (!u) fail("unit required"); if (!c.label) fail("label required"); if (c.remove) E.removeEffect(state, u, c.label); else E.addEffect(state, u, { label: c.label, expires: c.expires, mods: c.mods, note: c.reason }); applied.push({ op: "effect", unit: u.name, label: c.label, removed: !!c.remove }); break;
        case "score": applied.push({ op: "score", ...E.addVP(state, c.side, c.kind || "primary", c.delta, c.reason) }); break;
        case "phase": { if (c.to === "next" || (!c.to && !c.phase && c.round == null)) { const r = E.advancePhase(state); applied.push({ op: "phase", to: r.to, prompts: r.prompts }); } else { E.setPhase(state, { round: c.round, active: c.active, phase: c.to || c.phase }); applied.push({ op: "phase", to: { ...state.turn } }); } break; }
        case "set": {
          if (!u) fail("unit required");
          const f = c.fields || {};
          for (const k of ["wounds", "oc", "move", "datasheet", "keywords", "loadout"]) if (f[k] !== undefined) u[k] = f[k];
          if (f.wounds) u.models.forEach((mm: any) => { if (mm.wounds == null || mm.wounds > f.wounds) mm.wounds = Number(f.wounds); });
          applied.push({ op: "set", unit: u.name, fields: Object.keys(f) });
          break;
        }
        default: fail("unknown op");
      }
    }
    for (const r of touched) { const u = state.units.find((v: any) => String(v.id) === r); if (u) { const c = E.coherency(state, u); if (!c.ok) warnings.push(u.name + " coherency: " + c.issues.join("; ")); } }
    return { warnings: [...new Set(warnings)], applied };
  };

  const brief = async (game: any, side?: string) => {
    const s = game.state, { m } = await terrainFor(s);
    const objectives = E.objectivesFromFeatures(m?.features || []);
    const oc = objectives.length ? E.objectiveControl(s, objectives) : null;
    const pending = await api("tabletop_proposals?game_id=eq." + game.id + "&status=eq.pending&select=id,note,based_on_revision&order=created_at.asc").catch(() => []);
    const me = side || s.turn.active;
    const army = (sd: string) => s.units.filter((u: any) => u.side === sd && u.locationState !== "destroyed").map((u: any) => E.unitSummary(u));
    return {
      game: game.name, revision: game.revision, map: s.map_id || null, setup: s.setup,
      turn: { ...s.turn, yourTurn: s.turn.active === me }, you: me,
      score: Object.fromEntries(E.SIDES.map((x) => [x, { vp: E.vpTotal(s.score[x]), primary: s.score[x].primary, secondary: s.score[x].secondary, cp: s.score[x].cp, secondaries: s.score[x].secondaries }])),
      prompts: E.phasePrompts(s),
      yours: army(me), enemy: army(E.otherSide(me)),
      destroyed: s.units.filter((u: any) => u.locationState === "destroyed").map((u: any) => u.side + ":" + u.name),
      objectives: oc?.objectives.map((o: any) => ({ id: o.id, kind: o.kind, x: o.x, y: o.y, controller: o.controller, oc: o.oc })),
      threats: E.threatMap(s, me, 2),
      pendingProposals: pending.map((p: any) => ({ id: p.id, note: p.note, stale: Number(p.based_on_revision) !== Number(game.revision) })),
      recent: (s.log || []).slice(-8).map((l: any) => [l.kind, l.name || "", l.label || l.amount || l.delta || ""].filter((x) => x !== "").join(" ")),
    };
  };

  try {
    switch (name) {
      case "list_games": return reply(result(await api("tabletop_games?select=id,name,revision,turn_number,active_side,phase,updated_at&order=updated_at.desc&limit=100")));
      case "get_turn_brief": return reply(result(await brief(await loadGame(a.game_id), a.side)));
      case "get_events_since": {
        const since = Math.floor(Number(a.since_revision) || 0), deadline = Date.now() + Math.min(25, Math.max(0, Number(a.wait_seconds) || 0)) * 1000;
        const gid = encodeURIComponent(String(a.game_id));
        let events: any[] = [], messages: any[] = [], resolved: any[] = [], head: any;
        const since_ts = await api("tabletop_events?game_id=eq." + gid + "&revision=eq." + since + "&select=created_at").then((r: any) => r[0]?.created_at).catch(() => null);
        while (true) {
          head = (await api("tabletop_games?id=eq." + gid + "&select=revision,updated_at"))[0];
          if (!head) throw Error("Game not found or access denied");
          const msgQ = "tabletop_messages?game_id=eq." + gid + "&select=id,author,side,body,created_at&order=id.asc&limit=30" + (since_ts ? "&created_at=gt." + encodeURIComponent(since_ts) : "");
          messages = await api(msgQ).catch(() => []);
          if (Number(head.revision) > since || messages.some((x: any) => x.author !== "ai") || Date.now() >= deadline) break;
          await sleep(2000);
        }
        if (Number(head.revision) > since) {
          const rows = await api("tabletop_events?game_id=eq." + gid + "&revision=gt." + since + "&select=revision,action,created_at,prior_state,next_state&order=revision.asc&limit=20");
          events = rows.map((r: any) => ({ revision: r.revision, action: r.action, at: r.created_at, changes: E.describeChanges(r.prior_state, r.next_state).slice(0, 40) }));
          resolved = await api("tabletop_proposals?game_id=eq." + gid + "&status=neq.pending&based_on_revision=gte." + since + "&select=id,status,note&order=created_at.desc&limit=10").catch(() => []);
        }
        return reply(result({ revision: Number(head.revision), changed: Number(head.revision) > since, events, proposals: resolved, messages: messages.map((x: any) => ({ from: x.author + (x.side ? ":" + x.side : ""), text: x.body, at: x.created_at })) }));
      }
      case "propose_changes": {
        const game = await loadGame(a.game_id);
        if (!Array.isArray(a.changes) || !a.changes.length) throw Error("changes required");
        const next = structuredClone(game.state);
        const r = await applyChanges(next, a.changes, { allow_overrun: !!a.allow_overrun });
        const note = (a.note ? a.note + " · " : "") + r.applied.map((x: any) => x.op + (x.unit ? " " + x.unit : "")).join(", ") + (r.warnings.length ? " · ⚠ " + r.warnings.join("; ") : "");
        const p = await propose(game, next, note);
        return reply(result({ proposal_id: p.id, status: "pending", based_on_revision: game.revision, applied: r.applied, warnings: r.warnings, next: "Player approves in the app. Then call get_events_since(since_revision=" + game.revision + ", wait_seconds=25)." }));
      }
      case "propose_move": case "propose_location": case "propose_deployment": {
        const game = await loadGame(a.game_id);
        const change = name === "propose_move" ? { op: "move", unit: a.unit, x: a.x, y: a.y, rotation: a.rotation } : { op: name === "propose_location" ? "location" : "deploy", ...a };
        const next = structuredClone(game.state);
        const r = await applyChanges(next, [change], { allow_overrun: false });
        const p = await propose(game, next, (a.note || name.replace("propose_", "")) + (r.warnings.length ? " · ⚠ " + r.warnings.join("; ") : ""));
        return reply(result({ proposal_id: p.id, status: "pending", based_on_revision: game.revision, applied: r.applied, warning: r.warnings.join("; ") || undefined }));
      }
      case "measure": {
        const g = await loadGame(a.game_id), f = unitOf(g.state, a.from), t = unitOf(g.state, a.to);
        if (!E.isOnTable(f) || !E.isOnTable(t)) throw Error("Both units must be on the table");
        const r = E.modelsInRange(f, t, a.range);
        return reply(result({ from: f.name, to: t.name, distance: E.round2(E.unitDistance(f, t)), range: a.range ?? null, modelsInRange: r.count, models: r.total <= 12 ? r.models.map((x: any) => x.distance) : undefined }));
      }
      case "check_visibility": {
        const g = await loadGame(a.game_id), { ctx } = await terrainFor(g.state);
        return reply(result(E.unitVisibility(ctx, unitOf(g.state, a.attacker), unitOf(g.state, a.target), { range: a.range })));
      }
      case "find_targets": {
        const g = await loadGame(a.game_id), u = unitOf(g.state, a.unit), { ctx } = await terrainFor(g.state);
        if (!E.isOnTable(u)) throw Error("Unit is not on the table");
        const ds = await datasheetFor(u);
        const weapons = (ds?.ranged || []).map((w: any) => ({ name: w.name, range: parseRange(w.range) })).filter((w: any) => w.range);
        const enemies = g.state.units.filter((v: any) => v.side !== u.side && E.isOnTable(v));
        const out = enemies.map((v: any) => {
          const d = E.unitDistance(u, v);
          if (a.max_distance && d > a.max_distance) return null;
          const vis = E.unitVisibility(ctx, u, v);
          return { id: v.id, name: v.name, distance: E.round2(d), visibleModels: vis.targetModelsVisible + "/" + vis.targetModelsTotal, cover: vis.targetInCover || undefined, inRange: vis.targetModelsVisible ? weapons.filter((w: any) => d <= w.range + E.EPS).map((w: any) => w.name) : [], notVisible: !vis.targetModelsVisible || undefined, chargeable: d <= 12 || undefined };
        }).filter(Boolean).sort((x: any, y: any) => x.distance - y.distance);
        return reply(result({ unit: u.name, datasheet: ds?.name || null, weapons, melee: (ds?.melee || []).map((w: any) => w.name), targets: out }));
      }
      case "objective_control": {
        const g = await loadGame(a.game_id), { m } = await terrainFor(g.state);
        const objs = E.objectivesFromFeatures(m?.features || []);
        if (!objs.length) throw Error("No objectives on this game's map");
        return reply(result(E.objectiveControl(g.state, objs)));
      }
      case "check_coherency": { const g = await loadGame(a.game_id); return reply(result({ issues: E.coherencyAll(g.state, a.side) })); }
      case "get_datasheet": {
        let ds;
        if (a.game_id && a.unit) { const g = await loadGame(a.game_id); ds = await datasheetFor(unitOf(g.state, a.unit)); }
        else if (a.name) ds = await datasheetFor({ name: a.name });
        if (!ds) throw Error("Datasheet not found; try search_datasheets");
        return reply(result(compactSheet(ds)));
      }
      case "search_datasheets": {
        const q = encodeURIComponent("*" + String(a.query).replace(/[*,()]/g, "") + "*");
        const f = a.faction ? "&faction=eq." + encodeURIComponent(a.faction) : "";
        const rows = await api("datasheets?edition=eq.11" + f + "&or=(name.ilike." + q + ",slug.ilike." + q + ")&select=faction,slug,name,keywords&limit=20");
        return reply(result(rows));
      }
      case "send_message": {
        const g = await loadGame(a.game_id);
        await api("tabletop_messages", { method: "POST", body: JSON.stringify({ game_id: g.id, author: "ai", side: a.side || null, body: String(a.text).slice(0, 2000) }) });
        return reply(result({ sent: true }));
      }
      case "get_battlefield": {
        const g = await loadGame(a.game_id);
        const out: any = { id: g.id, name: g.name, revision: g.revision, state: g.state };
        if (a.include_map && g.state.map_id) out.map_catalog = await getMap(g.state.map_id);
        return reply(result(out));
      }
      case "get_unit": { const g = await loadGame(a.game_id); return reply(result({ game_id: g.id, revision: g.revision, unit: unitOf(g.state, a.unit) })); }
      case "commit_move": {
        if (a.approved !== true) throw Error("Explicit approved=true required");
        const rows = await api("tabletop_proposals?id=eq." + encodeURIComponent(String(a.proposal_id)) + "&select=*");
        if (rows.length !== 1 || rows[0].status !== "pending") throw Error("Pending proposal not found");
        const rev = await api("rpc/tabletop_resolve_proposal", { method: "POST", body: JSON.stringify({ p_proposal: rows[0].id, p_approved: true }) });
        return reply(result({ game_id: rows[0].game_id, revision: rev, proposal_id: rows[0].id, committed: true }));
      }
      case "create_game": {
        const catalog = await getMap(String(a.map_id));
        if (catalog.map.status !== "verified") throw Error("Map not verified");
        if (!Array.isArray(a.units) || !a.units.length || new Set(a.units.map((u: any) => String(u.id))).size !== a.units.length) throw Error("Unique unit IDs required");
        const user = await fetch(URL_BASE + "/auth/v1/user", { headers: { apikey: PUBLIC_KEY, authorization: auth } });
        if (!user.ok) throw Error("Authentication failed");
        const owner = await user.json();
        const units = a.units.map((u: any) => {
          if (!["ork", "da"].includes(u.side)) throw Error("Invalid unit " + u.name + ": side must be ork or da");
          if (!Array.isArray(u.models) || !u.models.length) throw Error("Invalid unit " + u.name + ": models required");
          return E.upgradeUnit({ ...u, modelCount: u.models.length, x: 0, y: 0, angle: 0, spent: 0, bonus: 0, trail: [], locationState: "undeployed", transportId: null, models: u.models.map((m: any) => ({ ...m, spent: 0 })) });
        });
        const state = E.upgradeState({ version: 1, board: { width: catalog.map.board_width, height: catalog.map.board_height }, map_id: a.map_id, units, setup: a.setup });
        const rows = await api("tabletop_games", { method: "POST", body: JSON.stringify({ owner_id: owner.id, name: String(a.name), board_width: catalog.map.board_width, board_height: catalog.map.board_height, phase: "deployment", state }) });
        return reply(result({ id: rows[0].id, revision: rows[0].revision, name: rows[0].name }));
      }
      case "list_maps": return reply(result(await api("battlefield_maps?status=eq.verified&select=id,source_page,disposition_a,disposition_b,variant,board_width,board_height&order=source_page")));
      case "get_map": return reply(result(await getMap(String(a.map_id))));
      case "get_mission_reference": {
        const matrix = await api("mission_matrix?edition=eq.11&select=*");
        const secondary = await api("mission_secondary_catalog?edition=eq.11&select=mission_name,fixed_available,source_url&order=mission_name");
        const filtered = a.disposition && a.opponent_disposition ? matrix.filter((m: any) => (m.disposition === a.disposition && m.opponent_disposition === a.opponent_disposition) || (m.disposition === a.opponent_disposition && m.opponent_disposition === a.disposition)) : a.disposition ? matrix.filter((m: any) => m.disposition === a.disposition) : matrix;
        return reply(result({ edition: 11, primary: filtered, secondary }));
      }
      case "get_mission_matchup": case "list_secondary_missions": case "get_mission_rules": case "get_applicable_scoring": {
        let ctxArgs = { ...a };
        if (name === "get_applicable_scoring" && a.game_id) {
          const g = await loadGame(a.game_id), s = g.state, me = a.side || s.turn.active;
          const disp = (sd: string) => sd === "ork" ? s.setup?.orkDisposition : s.setup?.daDisposition;
          ctxArgs = { disposition: disp(me), opponent_disposition: disp(E.otherSide(me)), active_secondaries: s.score[me].secondaries.filter((c: any) => !c.done).map((c: any) => ({ name: c.name, mode: c.mode })), battle_round: s.turn.round, active_turn: s.turn.active === me ? "self" : "opponent", phase: s.turn.phase, scope: a.scope || "remaining_turn", ...Object.fromEntries(Object.entries(a).filter(([k, v]) => v !== undefined && !["game_id", "side"].includes(k))) };
        }
        return reply(result(await scoring(name, ctxArgs, api)));
      }
      default: throw Error("Unknown tool: " + name);
    }
  } catch (e) { return err(e); }
});

async function scoring(name: string, a: any, api: any) {
  const primary = await api("mission_matrix?edition=eq.11&select=*");
  const secondary = await api("mission_secondary_catalog?edition=eq.11&select=*");
  const find = (rows: any[], n: string) => rows.find((r) => r.mission_name.toLowerCase() === String(n).trim().toLowerCase());
  const summary = (r: any) => ({ name: r.mission_name, source_url: r.source_url, scoring_available: r.scoring != null });
  const own = primary.find((r: any) => r.disposition === a.disposition && r.opponent_disposition === a.opponent_disposition);
  const opponent = primary.find((r: any) => r.disposition === a.opponent_disposition && r.opponent_disposition === a.disposition);
  if (name === "get_mission_matchup") { if (!own || !opponent) throw Error("Unknown disposition matchup"); return { self: summary(own), opponent: summary(opponent) }; }
  if (name === "list_secondary_missions") return secondary.filter((r: any) => a.mode !== "fixed" || r.fixed_available).map((r: any) => ({ ...summary(r), fixed_available: r.fixed_available }));
  if (name === "get_mission_rules") { const r = find(a.type === "primary" ? primary : secondary, a.name); if (!r) throw Error("Unknown mission"); return { ...r, scoring_status: r.scoring == null ? "missing" : "imported" }; }
  if (!own || !opponent) throw Error("Unknown disposition matchup (set dispositions in game setup or pass them)");
  const phases = ["command", "movement", "shooting", "charge", "fight", "end_of_turn"];
  a.scope ??= "remaining_turn"; a.active_secondaries ??= [];
  if (!phases.includes(a.phase) || !["self", "opponent"].includes(a.active_turn) || !Number.isInteger(a.battle_round) || a.battle_round < 1 || a.battle_round > 5) throw Error("Invalid scoring context");
  const missing: any[] = [], uncertain: any[] = [], missions: any[] = [];
  const add = (r: any, type: string, mode?: string) => {
    if (!r.scoring) { missing.push({ ...summary(r), type, mode }); return; }
    const rules = Array.isArray(r.scoring) ? r.scoring : r.scoring.conditions || [];
    const conditions: any[] = []; let previousTiming: string | null = null;
    for (const c of rules) {
      let timing = String(c.timing || "").toLowerCase();
      if (timing.includes("same as preceding")) timing = previousTiming || ""; else previousTiming = timing;
      if (mode && c.mode && c.mode !== mode) continue;
      if (c.rounds && !c.rounds.includes(a.battle_round)) continue;
      if (a.scope !== "all_phases" && a.active_turn === "opponent" && timing.includes("own ")) continue;
      const phase = timing === "end of battle" ? "end_of_turn" : timing.includes("command") ? (a.battle_round === 5 && timing.includes("round 5") ? "end_of_turn" : "command") : timing.includes("turn end") || timing.includes("end of turn") || timing.includes("while card active") ? "end_of_turn" : null;
      if (!phase) { uncertain.push({ mission: r.mission_name, reason: "Unmapped timing", condition: c }); conditions.push(c); continue; }
      if (a.scope === "current_phase" && phase !== a.phase) continue;
      if (a.scope === "remaining_turn" && phases.indexOf(phase) < phases.indexOf(a.phase)) continue;
      conditions.push({ ...c, evaluation_phase: phase, requires_battle_end: timing === "end of battle" || undefined });
    }
    if (conditions.length || r.scoring.action || r.scoring.special_rule) missions.push({ ...summary(r), type, mode, conditions, action: r.scoring.action || undefined, special_rule: r.scoring.special_rule || undefined, exceptions: Array.isArray(r.scoring) ? undefined : r.scoring.draw_exception });
  };
  add(own, "primary");
  for (const card of a.active_secondaries) { const r = find(secondary, card.name); if (!r) { missing.push({ name: card.name, type: "secondary", reason: "Unknown card" }); continue; } add(r, "secondary", card.mode); }
  return { edition: 11, scope: a.scope, round: a.battle_round, phase: a.phase, primary_mission: own.mission_name, missions, missing, uncertain, complete: !missing.length && !uncertain.length, coverage_note: "Only imported scoring records are evaluated." };
}
