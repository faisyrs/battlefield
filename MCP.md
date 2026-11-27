# Battlefield MCP endpoint

Deployed Supabase Edge Function:

`https://mvkqwisscspojgsgddgj.supabase.co/functions/v1/battlefield-mcp`

## Protocol

Stateless JSON-RPC 2.0 over HTTP POST, MCP protocol version `2025-03-26`. Supported methods: `initialize`, `ping`, `tools/list`, and `tools/call`. Tools: `list_games`, `get_battlefield`, `get_unit`, `propose_move`, and `commit_move`.

All POST requests require `Authorization: Bearer <Supabase user access JWT>`. Supabase Edge Functions validates the JWT, and RLS restricts game access to the authenticated owner. Do not use the public publishable key as a user bearer token.

The `propose_move` tool stages a proposed state change, leaving the saved game unchanged. The `commit_move` tool requires `approved: true` and uses optimistic revision checking. **The endpoint does not validate Warhammer movement rules or model collision.** A client must present proposals for player approval before committing.

## ChatGPT integration status

The function is deployed, but it has **not** been connected to ChatGPT as a remote MCP connector. Standard ChatGPT MCP connector setup generally requires an OAuth-compatible authorization flow; this endpoint currently accepts Supabase user access JWTs and does not implement OAuth discovery or dynamic client registration. Do not paste session tokens into chat. A secure OAuth bridge is needed for a supported ChatGPT connector.

## Testing

Deployment and function presence were verified. An authenticated end-to-end tool call, unauthorized-access rejection, proposal commit and revision-conflict tests are still pending.

## OAuth bridge (2026-11-26)

OAuth bridge deployed as Supabase Edge Function `battlefield-oauth` with Netlify reverse-proxy paths:

- MCP URL: `https://40k-battlefield-table.netlify.app/mcp`
- OAuth metadata: `https://40k-battlefield-table.netlify.app/.well-known/oauth-authorization-server`
- Resource metadata: `https://40k-battlefield-table.netlify.app/.well-known/oauth-protected-resource/mcp`
- OAuth authorization, token, registration: `/oauth/authorize`, `/oauth/token`, `/oauth/register`

Authorization-code flow uses PKCE S256 and dynamic public-client registration. A consent page uses Supabase email magic-link sign-in. The authorization code is short-lived and consumed atomically. The bridge issues opaque bearer and refresh tokens, storing only token hashes for lookup. Supabase user access/refresh tokens are held in a non-exposed private database schema, accessible only through a service-role-only RPC. The MCP proxy resolves the opaque bearer token and calls the existing Supabase-JWT-protected MCP function.

**Verification status:** Edge Function deployment, database migration, Netlify config commit, and Netlify deploy state were checked. The full browser OAuth round trip and a ChatGPT MCP tool invocation have not been tested yet. No user credentials should be pasted into chat.

**Known limitations:** No explicit revocation UI or automatic cleanup job yet. Client registration accepts HTTPS redirect URIs; consent should be reviewed carefully. OAuth login links must be allowed by Supabase Auth redirect configuration. Movement proposals are not checked against Warhammer game rules.
