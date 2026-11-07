// OAuth 2.1 authorization server for the MCP endpoint (authorization code + PKCE S256,
// dynamic client registration). The HTTP endpoints live in http.js; the consent screen is
// the web app's #/oauth route. An approved client ends up with an ordinary agent token,
// listed (and revocable) under Settings & members → AI agent.
import { v } from 'convex/values';
import { query, action, internalMutation, internalQuery } from './_generated/server';
import { internal } from './_generated/api';
import { fail, requireUser, requireMember } from './lib/util.js';
import { sha256 } from './lib/sha256.js';

const CODE_TTL = 5 * 60 * 1000;

export const randomToken = (prefix = '', bytes = 24) => {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return prefix + btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** https anywhere, plain http only for local development. */
export function validRedirectUri(uri) {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

async function clientFor(ctx, clientId) {
  return ctx.db
    .query('oauthClients')
    .withIndex('by_clientId', (q) => q.eq('clientId', clientId))
    .unique();
}

export const registerClient = internalMutation({
  args: { clientId: v.string(), name: v.string(), redirectUris: v.array(v.string()) },
  handler: async (ctx, a) => {
    // registration is public (ChatGPT etc. register themselves) but gives no access by itself;
    // cap it so nobody can flood the table
    const recent = await ctx.db.query('oauthClients').order('desc').take(30);
    if (recent.length === 30 && recent[29].createdAt > Date.now() - 3600_000) return { error: 'Too many app registrations; try again later.' };
    await ctx.db.insert('oauthClients', { ...a, createdAt: Date.now() });
    return { ok: true };
  },
});

/** Used by /oauth/authorize before sending the browser to the consent screen. */
export const checkClient = internalQuery({
  args: { clientId: v.string(), redirectUri: v.string() },
  handler: async (ctx, { clientId, redirectUri }) => {
    const c = await clientFor(ctx, clientId);
    if (!c) return { valid: false, reason: 'Unknown client_id. The app must register first.' };
    if (!c.redirectUris.includes(redirectUri)) return { valid: false, reason: 'redirect_uri is not registered for this client.' };
    return { valid: true, name: c.name };
  },
});

/** For the consent screen. Public: reveals only the client's self-chosen name. */
export const clientInfo = query({
  args: { clientId: v.string(), redirectUri: v.string() },
  handler: async (ctx, { clientId, redirectUri }) => {
    const c = await clientFor(ctx, clientId);
    if (!c || !c.redirectUris.includes(redirectUri)) return { valid: false };
    return { valid: true, name: c.name, redirectHost: new URL(redirectUri).host };
  },
});

/** The user clicked Allow: issue a one-time code and return where to send the browser. */
export const approve = action({
  args: {
    session: v.string(),
    workspaceId: v.id('workspaces'),
    clientId: v.string(),
    redirectUri: v.string(),
    codeChallenge: v.string(),
    state: v.optional(v.string()),
    scope: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const code = randomToken('', 32);
    await ctx.runMutation(internal.oauth.insertCode, {
      session: a.session,
      workspaceId: a.workspaceId,
      clientId: a.clientId,
      redirectUri: a.redirectUri,
      codeChallenge: a.codeChallenge,
      scope: a.scope || '',
      codeHash: sha256(code),
    });
    const u = new URL(a.redirectUri);
    u.searchParams.set('code', code);
    if (a.state) u.searchParams.set('state', a.state);
    return { redirect: u.toString() };
  },
});

export const insertCode = internalMutation({
  args: {
    session: v.string(),
    workspaceId: v.id('workspaces'),
    clientId: v.string(),
    redirectUri: v.string(),
    codeChallenge: v.string(),
    scope: v.string(),
    codeHash: v.string(),
  },
  handler: async (ctx, a) => {
    const user = await requireUser(ctx, a.session);
    await requireMember(ctx, a.workspaceId, user._id);
    const c = await clientFor(ctx, a.clientId);
    if (!c || !c.redirectUris.includes(a.redirectUri)) fail(400, 'This app is not registered for that redirect address.');
    if (!/^[A-Za-z0-9_-]{43}$/.test(a.codeChallenge)) fail(400, 'Missing or invalid PKCE code_challenge.');
    await ctx.db.insert('oauthCodes', {
      codeHash: a.codeHash,
      clientId: a.clientId,
      userId: user._id,
      workspaceId: a.workspaceId,
      redirectUri: a.redirectUri,
      codeChallenge: a.codeChallenge,
      scope: a.scope,
      expiresAt: Date.now() + CODE_TTL,
    });
  },
});

/**
 * Token endpoint: trade a code for an agent token. `verifierChallenge` is
 * BASE64URL(SHA-256(code_verifier)), computed by the HTTP handler.
 * Returns { error } (an OAuth error code) or { scope }.
 */
export const exchangeCode = internalMutation({
  args: { codeHash: v.string(), clientId: v.string(), redirectUri: v.string(), verifierChallenge: v.string(), tokenHash: v.string() },
  handler: async (ctx, a) => {
    const code = await ctx.db
      .query('oauthCodes')
      .withIndex('by_codeHash', (q) => q.eq('codeHash', a.codeHash))
      .unique();
    if (!code) return { error: 'invalid_grant', description: 'Unknown or already used code' };
    await ctx.db.delete(code._id); // single use, even if the checks below fail
    if (code.expiresAt < Date.now()) return { error: 'invalid_grant', description: 'Code expired' };
    if (code.clientId !== a.clientId) return { error: 'invalid_grant', description: 'Code was issued to another client' };
    if (code.redirectUri !== a.redirectUri) return { error: 'invalid_grant', description: 'redirect_uri mismatch' };
    if (code.codeChallenge !== a.verifierChallenge) return { error: 'invalid_grant', description: 'PKCE verification failed' };
    const client = await clientFor(ctx, a.clientId);
    await ctx.db.insert('agentTokens', {
      workspaceId: code.workspaceId,
      userId: code.userId,
      name: `${client?.name || 'App'} (connected)`.slice(0, 60),
      tokenHash: a.tokenHash,
      createdAt: Date.now(),
      lastUsedAt: null,
    });
    return { scope: code.scope };
  },
});

/** Hourly: drop expired codes. */
export const cleanup = internalMutation({
  args: {},
  handler: async (ctx) => {
    for (const c of await ctx.db.query('oauthCodes').collect()) if (c.expiresAt < Date.now()) await ctx.db.delete(c._id);
  },
});
