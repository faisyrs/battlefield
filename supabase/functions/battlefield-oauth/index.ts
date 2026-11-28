import "jsr:@supabase/functions-js/edge-runtime.d.ts";
// OAuth 2.1 bridge for the Battlefield MCP server (PKCE S256, dynamic public-client registration).
// Opaque bearer/refresh tokens are issued to MCP clients (Claude, ChatGPT, ...); Supabase user
// sessions stay server-side in a private schema reachable only through a service-role RPC.
const S = Deno.env.get("SUPABASE_URL")!, K = Deno.env.get("SUPABASE_ANON_KEY")!, A = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const HOST = "https://40k-battlefield-table.netlify.app";
const bytes = new TextEncoder();
const b64 = (a: Uint8Array) => btoa(String.fromCharCode(...a)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.encode(s)));
const hash = async (s: string) => Array.from(await digest(s)).map((x) => x.toString(16).padStart(2, "0")).join("");
const rand = () => b64(crypto.getRandomValues(new Uint8Array(32)));
const J = (v: any, status = 200, headers: any = {}) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
const E = (v: string, status = 400) => J({ error: v }, status);
async function db(table: string, method = "GET", data?: any, query = "") {
  const p = new URLSearchParams(query.startsWith("?") ? query.slice(1) : query);
  const field = table.includes("clients") ? "client_id" : table.includes("refresh_tokens") ? "refresh_hash" : "token_hash";
  const op = table === "rpc/consume_code" ? "codes_consume" : table.split(".").pop() + "_" + (method === "POST" ? "insert" : method === "DELETE" ? "delete" : "get");
  const payload = table === "rpc/consume_code" ? { code_hash: data.p_hash } : method === "GET" || method === "DELETE" ? { [field]: (p.get(field) || "").replace("eq.", "") } : data;
  const res = await fetch(S + "/rest/v1/rpc/battlefield_oauth_db", { method: "POST", headers: { "apikey": A, "authorization": "Bearer " + A, "content-type": "application/json" }, body: JSON.stringify({ op, payload }) });
  const body = await res.json();
  if (!res.ok) throw Error("OAuth storage error");
  return body;
}
async function getUser(t: string) {
  const r = await fetch(S + "/auth/v1/user", { headers: { "apikey": K, "authorization": "Bearer " + t } });
  if (!r.ok) throw Error("Sign in expired");
  return await r.json();
}
const metadata = { issuer: HOST, authorization_endpoint: HOST + "/oauth/authorize", token_endpoint: HOST + "/oauth/token", registration_endpoint: HOST + "/oauth/register", response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], scopes_supported: ["battlefield"] };
const resource = { resource: HOST + "/mcp", authorization_servers: [HOST], scopes_supported: ["battlefield"], bearer_methods_supported: ["header"] };
const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize Battlefield</title><style>body{font:16px system-ui;max-width:550px;margin:5vh auto;padding:20px;background:#15191e;color:#eee}input,button{font:inherit;padding:12px;margin:6px 0;width:100%;box-sizing:border-box}</style></head><body><h2>Connect your AI assistant to Battlefield</h2><p>Sign in with the email used for your saved battlefield.</p><input id="email" type="email" placeholder="Email"><button id="send">Send sign-in link</button><p id="msg"></p><section id="consent" hidden><p>Allow this assistant to read your saved games and propose or commit changes?</p><button id="approve">Authorize</button></section><script>const s=';
const script = ';const msg=document.getElementById("msg"),h=new URLSearchParams(location.hash.slice(1));let access=h.get("access_token"),refresh=h.get("refresh_token");const consent=document.getElementById("consent");function signedIn(a,r){access=a;refresh=r;history.replaceState(null,"",location.pathname+location.search);consent.hidden=false;msg.textContent="Signed in. Review access and authorize."}async function reuseSession(){if(access){signedIn(access,refresh);return;}let session;try{session=JSON.parse(localStorage.getItem("40k-cloud-session")||"null")}catch{}if(!session?.access_token||!session?.refresh_token)return;try{let u=await fetch(s.base+"/auth/v1/user",{headers:{apikey:s.key,authorization:"Bearer "+session.access_token}});if(u.ok){signedIn(session.access_token,session.refresh_token);return;}const r=await fetch(s.base+"/auth/v1/token?grant_type=refresh_token",{method:"POST",headers:{apikey:s.key,"content-type":"application/json"},body:JSON.stringify({refresh_token:session.refresh_token})});if(!r.ok)return;const fresh=await r.json();if(!fresh.access_token||!fresh.refresh_token)return;localStorage.setItem("40k-cloud-session",JSON.stringify(fresh));signedIn(fresh.access_token,fresh.refresh_token)}catch(e){msg.textContent="Existing session could not be reused. Sign in again when email sending is available."}}reuseSession();document.getElementById("send").onclick=async()=>{const email=document.getElementById("email").value.trim();if(!email)return;const r=await fetch(s.base+"/auth/v1/otp?redirect_to="+encodeURIComponent(location.href.split("#")[0]),{method:"POST",headers:{"apikey":s.key,"content-type":"application/json"},body:JSON.stringify({email,create_user:false,options:{email_redirect_to:location.href.split("#")[0]}})});msg.textContent=r.ok?"Check your email for a new sign-in link.":"Sign-in failed: "+await r.text()};document.getElementById("approve").onclick=async()=>{const r=await fetch(location.origin+"/oauth/consent",{method:"POST",headers:{"content-type":"application/json","authorization":"Bearer "+access},body:JSON.stringify({...s.params,refresh_token:refresh})});const d=await r.json();if(r.ok&&d.redirect)location.assign(d.redirect);else msg.textContent=d.error||"Authorization failed"};</script></body></html>';
Deno.serve(async (req) => {
  try {
    const u = new URL(req.url), p = u.searchParams.get("route") || u.pathname.split("/").pop() || "";
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization,content-type", "access-control-allow-methods": "POST,OPTIONS" } });
    if (p === "metadata") return J(metadata);
    if (p === "resource") return J(resource);
    if (p === "register" && req.method === "POST") {
      const a = await req.json(), uris = a.redirect_uris;
      if (!Array.isArray(uris) || !uris.length || uris.length > 5 || uris.some((x: any) => typeof x !== "string" || x.length > 2048 || !x.startsWith("https://"))) return E("invalid_redirect_uri");
      const id = rand(); await db("battlefield_auth.clients", "POST", { client_id: id, redirect_uris: uris });
      return J({ client_id: id, redirect_uris: uris, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }, 201);
    }
    if (p === "authorize" && req.method === "GET") {
      const q = u.searchParams, id = q.get("client_id") || "", uri = q.get("redirect_uri") || "";
      const c = await db("battlefield_auth.clients", "GET", undefined, "?client_id=eq." + encodeURIComponent(id) + "&select=redirect_uris");
      if (!c.length || !c[0].redirect_uris.includes(uri)) return E("invalid_client");
      if (q.get("response_type") !== "code" || q.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(q.get("code_challenge") || "")) return E("invalid_request");
      const params = Object.fromEntries(["client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "response_type", "scope"].map((k) => [k, q.get(k) || ""]));
      return new Response(html + JSON.stringify({ base: S, key: K, params }).replace(/</g, "\\u003c") + script, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src " + S + " " + HOST + "; frame-ancestors 'none'; base-uri 'none'" } });
    }
    if (p === "consent" && req.method === "POST") {
      const token = (req.headers.get("authorization") || "").replace(/^Bearer /, "");
      await getUser(token);
      const a = await req.json(), c = await db("battlefield_auth.clients", "GET", undefined, "?client_id=eq." + encodeURIComponent(a.client_id) + "&select=redirect_uris");
      if (!c.length || !c[0].redirect_uris.includes(a.redirect_uri) || a.response_type !== "code" || a.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(a.code_challenge || "")) return E("invalid_request");
      if (typeof a.refresh_token !== "string" || !a.refresh_token) return E("invalid_request");
      const code = rand();
      await db("battlefield_auth.codes", "POST", { code_hash: await hash(code), client_id: a.client_id, redirect_uri: a.redirect_uri, challenge: a.code_challenge, user_access_token: token, user_refresh_token: a.refresh_token, expires_at: new Date(Date.now() + 120000).toISOString() });
      const dest = new URL(a.redirect_uri); dest.searchParams.set("code", code); if (a.state) dest.searchParams.set("state", a.state);
      return J({ redirect: dest.toString() });
    }
    if (p === "token" && req.method === "POST") {
      const a = Object.fromEntries((await req.formData()).entries());
      if (a.grant_type === "authorization_code") {
        if (typeof a.code !== "string" || typeof a.client_id !== "string" || typeof a.redirect_uri !== "string" || typeof a.code_verifier !== "string") return E("invalid_request");
        const rows = await db("rpc/consume_code", "POST", { p_hash: await hash(a.code) });
        if (!rows?.length) return E("invalid_grant");
        const c = rows[0];
        if (c.client_id !== a.client_id || c.redirect_uri !== a.redirect_uri || b64(await digest(a.code_verifier)) !== c.challenge) return E("invalid_grant");
        await getUser(c.user_access_token);
        const access = rand(), refresh = rand();
        await db("battlefield_auth.tokens", "POST", { token_hash: await hash(access), client_id: c.client_id, user_access_token: c.user_access_token, user_refresh_token: c.user_refresh_token, expires_at: new Date(Date.now() + 3300000).toISOString() });
        await db("battlefield_auth.refresh_tokens", "POST", { refresh_hash: await hash(refresh), client_id: c.client_id, user_refresh_token: c.user_refresh_token, expires_at: new Date(Date.now() + 2592000000).toISOString() });
        return J({ access_token: access, token_type: "Bearer", expires_in: 3300, refresh_token: refresh, scope: "battlefield" });
      }
      if (a.grant_type === "refresh_token") {
        if (typeof a.refresh_token !== "string" || typeof a.client_id !== "string") return E("invalid_request");
        const rows = await db("battlefield_auth.refresh_tokens", "GET", undefined, "?refresh_hash=eq." + await hash(a.refresh_token) + "&select=*");
        if (!rows.length || rows[0].client_id !== a.client_id || Date.parse(rows[0].expires_at) < Date.now()) return E("invalid_grant");
        const r = await fetch(S + "/auth/v1/token?grant_type=refresh_token", { method: "POST", headers: { "apikey": K, "content-type": "application/json" }, body: JSON.stringify({ refresh_token: rows[0].user_refresh_token }) });
        if (!r.ok) return E("invalid_grant"); const session = await r.json();
        await db("battlefield_auth.refresh_tokens", "DELETE", undefined, "?refresh_hash=eq." + await hash(a.refresh_token));
        const access = rand(), refresh = rand();
        await db("battlefield_auth.tokens", "POST", { token_hash: await hash(access), client_id: a.client_id, user_access_token: session.access_token, user_refresh_token: session.refresh_token, expires_at: new Date(Date.now() + 3300000).toISOString() });
        await db("battlefield_auth.refresh_tokens", "POST", { refresh_hash: await hash(refresh), client_id: a.client_id, user_refresh_token: session.refresh_token, expires_at: new Date(Date.now() + 2592000000).toISOString() });
        return J({ access_token: access, token_type: "Bearer", expires_in: 3300, refresh_token: refresh, scope: "battlefield" });
      }
      return E("unsupported_grant_type");
    }
    if (p === "mcp" && req.method === "POST") {
      const bearer = (req.headers.get("authorization") || "").match(/^Bearer (.+)$/i)?.[1];
      const unauthorized = () => J({ error: "Unauthorized" }, 401, { "www-authenticate": 'Bearer resource_metadata="' + HOST + '/.well-known/oauth-protected-resource/mcp"' });
      if (!bearer) return unauthorized();
      const rows = await db("battlefield_auth.tokens", "GET", undefined, "?token_hash=eq." + await hash(bearer) + "&select=user_access_token,expires_at");
      if (!rows.length || Date.parse(rows[0].expires_at) < Date.now()) return unauthorized();
      const r = await fetch(S + "/functions/v1/battlefield-mcp", { method: "POST", headers: { "apikey": K, "authorization": "Bearer " + rows[0].user_access_token, "content-type": "application/json", "accept": "application/json, text/event-stream" }, body: await req.text() });
      return new Response(r.body, { status: r.status, headers: { "content-type": r.headers.get("content-type") || "application/json", "cache-control": "no-store" } });
    }
    return E("not_found", 404);
  } catch (e) { return E("server_error", 500); }
});
