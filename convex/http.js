import { httpRouter } from 'convex/server';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { httpAction } from './_generated/server';
import { internal } from './_generated/api';
import { createMcpServer } from '../src/tools.js';
import { sha256 } from './lib/sha256.js';
import { randomToken, validRedirectUri } from './oauth.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Session-Id, Mcp-Protocol-Version',
  'Access-Control-Expose-Headers': 'WWW-Authenticate, Mcp-Session-Id',
};
const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS, ...headers } });
const bearer = (req) => {
  const h = req.headers.get('authorization') || '';
  return /^bearer /i.test(h) ? h.slice(7).trim() : '';
};
const unwrap = (err) => {
  throw new Error(err?.data?.message || err?.message || 'Request failed');
};
const site = () => (process.env.CONVEX_SITE_URL || '').replace(/\/$/, '');
const base64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** The page API as seen by one agent token. */
function agentApi(ctx, token) {
  let tool;
  return {
    call: (method, args) => ctx.runMutation(internal.agent.call, { token, method, args: args || {}, tool }).catch(unwrap),
    onTool: (name) => {
      tool = name;
    },
  };
}

const http = httpRouter();
const route = (path, method, fn) => http.route({ path, method, handler: httpAction(fn) });
const preflight = (path) => route(path, 'OPTIONS', async () => new Response(null, { status: 204, headers: { ...CORS, 'Access-Control-Max-Age': '86400' } }));

// ---------------------------------------------------------------------------
// MCP over Streamable HTTP (stateless). Auth: "Authorization: Bearer <agent token>",
// either created in Settings & members → AI agent or issued through OAuth below.
// ---------------------------------------------------------------------------
const unauthorized = () =>
  json(
    401,
    {
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized: connect with OAuth, or send "Authorization: Bearer <agent token>" (Settings & members → AI agent)' },
      id: null,
    },
    { 'WWW-Authenticate': `Bearer resource_metadata="${site()}/.well-known/oauth-protected-resource/mcp"` },
  );

async function authed(ctx, request) {
  const token = bearer(request);
  return token && (await ctx.runQuery(internal.agent.check, { token })) ? token : null;
}

route('/mcp', 'POST', async (ctx, request) => {
  const token = await authed(ctx, request);
  if (!token) return unauthorized();
  const server = createMcpServer(agentApi(ctx, token), { webUrl: process.env.WEB_URL || null });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    const res = await transport.handleRequest(request);
    for (const [k, v] of Object.entries(CORS)) res.headers.set(k, v);
    return res;
  } finally {
    await server.close();
  }
});
for (const method of ['GET', 'DELETE']) {
  route('/mcp', method, async (ctx, request) =>
    (await authed(ctx, request)) ? json(405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }) : unauthorized(),
  );
}
preflight('/mcp');

// Plain JSON endpoint for the local stdio bridge (src/mcp-stdio.js).
route('/agent/rpc', 'POST', async (ctx, request) => {
  const token = bearer(request);
  if (!token) return json(401, { error: 'Agent token required' });
  const { method, args, tool } = await request.json().catch(() => ({}));
  try {
    const result = await ctx.runMutation(internal.agent.call, { token, method: String(method || ''), args: args || {}, tool });
    return json(200, { result });
  } catch (err) {
    return json(err?.data?.status || 500, { error: err?.data?.message || err.message });
  }
});

// ---------------------------------------------------------------------------
// OAuth 2.1 (authorization code + PKCE, dynamic client registration) so apps that
// can't send a fixed header — ChatGPT connectors, claude.ai connectors — can connect.
// ---------------------------------------------------------------------------
const SCOPE = 'pages';
const protectedResource = () => ({
  resource: `${site()}/mcp`,
  authorization_servers: [site()],
  scopes_supported: [SCOPE],
  bearer_methods_supported: ['header'],
  resource_name: 'Notion clone',
});
const authServer = () => ({
  issuer: site(),
  authorization_endpoint: `${site()}/oauth/authorize`,
  token_endpoint: `${site()}/oauth/token`,
  registration_endpoint: `${site()}/oauth/register`,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
  scopes_supported: [SCOPE],
});
for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
  route(path, 'GET', async () => json(200, protectedResource()));
  preflight(path);
}
for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/mcp', '/.well-known/openid-configuration']) {
  route(path, 'GET', async () => json(200, authServer()));
  preflight(path);
}

// RFC 7591 dynamic client registration. Public clients; PKCE protects the code.
route('/oauth/register', 'POST', async (ctx, request) => {
  const body = await request.json().catch(() => null);
  const uris = Array.isArray(body?.redirect_uris) ? body.redirect_uris.map(String) : [];
  if (!uris.length || uris.length > 10 || !uris.every(validRedirectUri)) {
    return json(400, { error: 'invalid_redirect_uri', error_description: 'redirect_uris must be 1–10 https URLs (http only for localhost)' });
  }
  const name = String(body.client_name || 'MCP client').slice(0, 50);
  const clientId = randomToken('ncc_', 18);
  const reg = await ctx.runMutation(internal.oauth.registerClient, { clientId, name, redirectUris: uris });
  if (reg?.error) return json(429, { error: 'temporarily_unavailable', error_description: reg.error });
  return json(201, {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: name,
    redirect_uris: uris,
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  });
});
preflight('/oauth/register');

// Validate the request, then hand the browser to the web app's consent screen.
route('/oauth/authorize', 'GET', async (ctx, request) => {
  const p = new URL(request.url).searchParams;
  const clientId = p.get('client_id') || '';
  const redirectUri = p.get('redirect_uri') || '';
  const check = await ctx.runQuery(internal.oauth.checkClient, { clientId, redirectUri });
  if (!check.valid) return new Response(`Can't connect this app: ${check.reason}`, { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  const back = (error, description) => {
    const u = new URL(redirectUri);
    u.searchParams.set('error', error);
    u.searchParams.set('error_description', description);
    if (p.get('state')) u.searchParams.set('state', p.get('state'));
    return Response.redirect(u.toString(), 302);
  };
  if (p.get('response_type') !== 'code') return back('unsupported_response_type', 'Only response_type=code is supported');
  if (p.get('code_challenge_method') !== 'S256' || !p.get('code_challenge')) return back('invalid_request', 'PKCE with code_challenge_method=S256 is required');
  const web = process.env.WEB_URL;
  if (!web) return new Response('Server not configured: set WEB_URL (the site address) in the Convex environment variables.', { status: 500 });
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, code_challenge: p.get('code_challenge') });
  for (const k of ['state', 'scope']) if (p.get(k)) q.set(k, p.get(k));
  return Response.redirect(`${web.replace(/#.*$/, '')}#/oauth?${q}`, 302);
});

route('/oauth/token', 'POST', async (ctx, request) => {
  const type = request.headers.get('content-type') || '';
  const raw = await request.text();
  const p = type.includes('application/json') ? new URLSearchParams(Object.entries(JSON.parse(raw || '{}')).map(([k, v]) => [k, String(v)])) : new URLSearchParams(raw);
  const err = (error, description, status = 400) => json(status, { error, error_description: description });
  if (p.get('grant_type') !== 'authorization_code') return err('unsupported_grant_type', 'Only authorization_code is supported');
  // client_id from the body, or from HTTP Basic auth (secrets are not issued, so they are not checked)
  let clientId = p.get('client_id') || '';
  const basic = (request.headers.get('authorization') || '').match(/^basic (.+)$/i);
  if (!clientId && basic) clientId = decodeURIComponent(atob(basic[1]).split(':')[0]);
  const code = p.get('code') || '';
  const verifier = p.get('code_verifier') || '';
  if (!clientId || !code || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return err('invalid_request', 'client_id, code and a valid code_verifier are required');
  const verifierChallenge = base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const token = randomToken('nca_');
  const r = await ctx.runMutation(internal.oauth.exchangeCode, {
    codeHash: sha256(code),
    clientId,
    redirectUri: p.get('redirect_uri') || '',
    verifierChallenge,
    tokenHash: sha256(token),
  });
  if (r.error) return err(r.error, r.description);
  return json(200, { access_token: token, token_type: 'Bearer', scope: r.scope || SCOPE });
});
preflight('/oauth/token');

export default http;
