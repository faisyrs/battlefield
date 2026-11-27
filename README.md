# 40K Battlefield

Interactive 44 × 60-inch tabletop with draggable units, formations, model movement, measurement, and Supabase cloud saves.

## Deployment

This repository is intended to deploy as a static Netlify site. Upload the `index.html` from the cloud-enabled battlefield package to the repository root. The Netlify build publish directory is `.`; no build command is required.

## Supabase

Supabase project: `40k-battlefield` (`mvkqwisscspojgsgddgj`). The app uses a publishable client key and email OTP authentication; RLS restricts access to owned games. Add the deployed Netlify URL to Supabase Authentication URL Configuration (Site URL and Redirect URLs).

## Status

Database schema deployed. Netlify Git repository linkage, first site deploy, email authentication, live save/load verification, and MCP API remain to be completed.
