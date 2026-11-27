export default async function handler(req) {
  if(req.method!=="GET") return new Response("Method not allowed",{status:405});
  const u=new URL(req.url);
  const upstream=new URL("https://mvkqwisscspojgsgddgj.supabase.co/functions/v1/battlefield-oauth/authorize");
  upstream.search=u.search;
  const r=await fetch(upstream.toString(),{headers:{"accept":"text/html"}});
  const body=await r.text();
  return new Response(body,{status:r.status,headers:{"content-type":r.ok?"text/html; charset=utf-8":"application/json; charset=utf-8","cache-control":"no-store","x-content-type-options":"nosniff","content-security-policy":"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src https://mvkqwisscspojgsgddgj.supabase.co https://40k-battlefield-table.netlify.app; frame-ancestors 'none'; base-uri 'none'"}});
}
export const config={path:"/oauth/authorize"};
