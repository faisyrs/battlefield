# 40K Battlefield

Interactive 44 × 60-inch tabletop with draggable units, formations, model movement, measurement, and Supabase cloud saves.

## Deployment

This repository is intended to deploy as a static Netlify site. Upload the `index.html` from the cloud-enabled battlefield package to the repository root. The Netlify build publish directory is `.`; no build command is required.

## Supabase

Supabase project: `40k-battlefield` (`mvkqwisscspojgsgddgj`). The app uses a publishable client key and email OTP authentication; RLS restricts access to owned games. Add the deployed Netlify URL to Supabase Authentication URL Configuration (Site URL and Redirect URLs).

## Playing

Single-screen, phase-aware table. The bar above the toolbar shows the turn (tap for log, phase and terrain tools), the actions for the current phase and **Next ▸**.
The score overlay (top left) opens VP/CP, secondaries and the scoring that applies right now. Tap a unit for its card: wounds per model, damage, casualties,
destroy/restore, effects and the datasheet. Objectives show who controls them (OC totals); Rings shows weapon ranges; Targets lists enemies with distance,
visibility and weapons in range.

## Development

- `js/engine.js` — shared rules-light engine (browser + MCP)
- `js/hud.js` — phase-aware UI layered on the original table in `index.html`
- `supabase/functions/*` — MCP server and OAuth bridge (see `MCP.md`)
- `npm test` — unit and MCP harness tests
