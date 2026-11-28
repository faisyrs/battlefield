# Battlefield MCP

Connector URL (OAuth, works with Claude and ChatGPT): `https://40k-battlefield-table.netlify.app/mcp`

Source: `supabase/functions/battlefield-mcp/` (deployed as Supabase Edge Function `battlefield-mcp`).
The shared rules-light engine lives in `js/engine.js` and is copied next to the function before deploy
(`npm run build:mcp` does this and bundles for the Node test harness).

## Playing against an AI opponent

1. `get_turn_brief(game_id, side)` — one compact call per phase: turn, VP/CP, both armies, objective control, threats, pending proposals.
2. Look up only what you need: `find_targets`, `measure`, `check_visibility`, `objective_control`, `get_datasheet`, `get_applicable_scoring`.
3. Stage everything for the phase in one `propose_changes` call (move, advance, charge, pile_in, location, deploy, damage, remove_models, destroy, effect, score, phase, set).
   Each change is validated in order (allowance, overlaps, terrain, coherency, 3″/8″/6″ placement rules). Hard errors reject the batch; warnings are returned.
4. The player approves or rejects in the app (top-bar Approve/Reject). `get_events_since(game_id, since_revision, wait_seconds=25)` long-polls so the AI sees
   approvals, the player's moves, casualties, phase changes and chat without being told.
5. `send_message` posts to the table chat.

`commit_move` remains for explicit approval in chat. All writes go through RLS as the signed-in player.

## Other tools
`list_games`, `get_battlefield` (full state, large), `get_unit`, `propose_move`, `propose_location`, `propose_deployment`, `create_game`,
`list_maps`, `get_map`, `get_mission_reference`, `get_mission_matchup`, `get_mission_rules`, `list_secondary_missions`, `search_datasheets`, `check_coherency`.

## State model (v2)
Stored in `tabletop_games.state` (JSON). Added by `upgradeState`: `turn {round, active, first, phase}`, `score {ork|da: {primary, secondary, cp, secondaries, history}}`,
`log`, `obstacles` (solid/low terrain polygons). Units gain `wounds` (W per model), per-model `wounds`, `casualties`, `effects` (with expiry),
`locationState: destroyed`, `datasheet`, `keywords`, `oc`, `loadout`.

## Tests
`npm test` — engine unit tests and an MCP handler harness with a stubbed database.
