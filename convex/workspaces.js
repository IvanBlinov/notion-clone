import { v } from 'convex/values';
import { query, mutation, action, internalMutation } from './_generated/server';
import { internal } from './_generated/api';
import { DAY, fail, normEmail, validEmail, publicUser, requireUser, requireMember, requireOwner, membership, createWorkspaceWithSeed, loadWorkspace, inviteSignup } from './lib/util.js';
import { sha256 } from './lib/sha256.js';

const INVITE_DAYS = 7;
const randomToken = (prefix = '') => {
  const bytes = crypto.getRandomValues(new Uint8Array(24)); // actions have real randomness
  return prefix + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

// ---------- workspaces ----------
export const create = mutation({
  args: { session: v.string(), name: v.string() },
  handler: async (ctx, { session, name }) => {
    const user = await requireUser(ctx, session);
    const id = await createWorkspaceWithSeed(ctx, user._id, name.trim() || `${user.name}'s Workspace`);
    return { id, name: (await ctx.db.get(id)).name, role: 'owner' };
  },
});

export const rename = mutation({
  args: { session: v.string(), workspaceId: v.id('workspaces'), name: v.string() },
  handler: async (ctx, { session, workspaceId, name }) => {
    const user = await requireUser(ctx, session);
    await requireOwner(ctx, workspaceId, user._id);
    const n = name.trim().slice(0, 80);
    if (!n) fail(400, 'Name is required');
    await ctx.db.patch(workspaceId, { name: n });
    return { id: workspaceId, name: n };
  },
});

/** Live info for the open workspace (agent activity indicator). */
export const info = query({
  args: { session: v.string(), workspaceId: v.id('workspaces') },
  handler: async (ctx, { session, workspaceId }) => {
    const user = await requireUser(ctx, session);
    const { ws, role } = await requireMember(ctx, workspaceId, user._id);
    return { name: ws.name, role, agent: { lastAt: ws.lastAgentAt ? new Date(ws.lastAgentAt).toISOString() : null, lastTool: ws.lastAgentTool || null } };
  },
});

/** Which of my workspaces contains this page (to open links a teammate sent). */
export const locate = query({
  args: { session: v.string(), pid: v.string() },
  handler: async (ctx, { session, pid }) => {
    const user = await requireUser(ctx, session);
    const ms = await ctx.db
      .query('members')
      .withIndex('by_user', (q) => q.eq('userId', user._id))
      .collect();
    for (const m of ms) {
      const hit = await ctx.db
        .query('pages')
        .withIndex('by_workspace_pid', (q) => q.eq('workspaceId', m.workspaceId).eq('pid', pid))
        .first();
      if (hit) return m.workspaceId;
    }
    return null;
  },
});

// ---------- members ----------
export const members = query({
  args: { session: v.string(), workspaceId: v.id('workspaces') },
  handler: async (ctx, { session, workspaceId }) => {
    const user = await requireUser(ctx, session);
    const { role } = await requireMember(ctx, workspaceId, user._id);
    const rows = await ctx.db
      .query('members')
      .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
      .collect();
    const list = [];
    for (const m of rows) {
      const u = await ctx.db.get(m.userId);
      if (u) list.push({ ...publicUser(u), role: m.role, joinedAt: m.joinedAt });
    }
    let invites = [];
    if (role === 'owner') {
      invites = (
        await ctx.db
          .query('invites')
          .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
          .collect()
      )
        .filter((i) => !i.acceptedBy && i.expiresAt > Date.now())
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((i) => ({ id: i._id, token: i.token, email: i.email, expiresAt: i.expiresAt }));
    }
    return { role, members: list, invites };
  },
});

export const removeMember = mutation({
  args: { session: v.string(), workspaceId: v.id('workspaces'), userId: v.id('users') },
  handler: async (ctx, { session, workspaceId, userId }) => {
    const user = await requireUser(ctx, session);
    const { role } = await requireMember(ctx, workspaceId, user._id);
    if (userId !== user._id && role !== 'owner') fail(403, 'Only the owner can remove members');
    const target = await membership(ctx, workspaceId, userId);
    if (!target) fail(404, 'Not a member');
    if (target.role === 'owner') fail(400, 'The owner cannot leave or be removed');
    await ctx.db.delete(target._id);
    const tokens = await ctx.db
      .query('agentTokens')
      .withIndex('by_workspace_user', (q) => q.eq('workspaceId', workspaceId).eq('userId', userId))
      .collect();
    for (const t of tokens) await ctx.db.delete(t._id);
  },
});

// ---------- invites ----------
export const createInvite = action({
  args: { session: v.string(), workspaceId: v.id('workspaces'), email: v.optional(v.string()) },
  handler: async (ctx, args) => ctx.runMutation(internal.workspaces.insertInvite, { ...args, token: randomToken() }),
});

export const insertInvite = internalMutation({
  args: { session: v.string(), workspaceId: v.id('workspaces'), email: v.optional(v.string()), token: v.string() },
  handler: async (ctx, { session, workspaceId, email, token }) => {
    const user = await requireUser(ctx, session);
    await requireOwner(ctx, workspaceId, user._id);
    if (!inviteSignup()) fail(403, 'Sign-up is closed, so invite links are turned off. To invite someone, set SIGNUP to "invite" in the Convex dashboard (Settings → Environment Variables).');
    const e = normEmail(email);
    if (e && !validEmail(e)) fail(400, 'Invalid email');
    if (e) {
      const existing = await ctx.db
        .query('users')
        .withIndex('by_email', (q) => q.eq('email', e))
        .unique();
      if (existing && (await membership(ctx, workspaceId, existing._id))) fail(409, 'That person is already a member');
    }
    const expiresAt = Date.now() + INVITE_DAYS * DAY;
    const id = await ctx.db.insert('invites', { workspaceId, token, email: e || null, createdBy: user._id, createdAt: Date.now(), expiresAt, acceptedBy: null });
    return { id, token, email: e || null, expiresAt };
  },
});

export const revokeInvite = mutation({
  args: { session: v.string(), inviteId: v.id('invites') },
  handler: async (ctx, { session, inviteId }) => {
    const user = await requireUser(ctx, session);
    const inv = await ctx.db.get(inviteId);
    if (!inv) fail(404, 'Invite not found');
    await requireOwner(ctx, inv.workspaceId, user._id);
    await ctx.db.delete(inviteId);
  },
});

/** Public: what an invite link is for (shown before signing up). */
export const inviteInfo = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const inv = await ctx.db
      .query('invites')
      .withIndex('by_token', (q) => q.eq('token', token))
      .unique();
    const ws = inv && (await ctx.db.get(inv.workspaceId));
    if (!inv || !ws) return { valid: false, reason: 'This invite link is not valid.' };
    if (!inviteSignup()) return { valid: false, reason: 'Sign-up is closed.' };
    const expired = inv.expiresAt < Date.now();
    const by = await ctx.db.get(inv.createdBy);
    return {
      valid: !inv.acceptedBy && !expired,
      reason: inv.acceptedBy ? 'This invite link has already been used.' : expired ? 'This invite link has expired.' : null,
      workspace: { id: ws._id, name: ws.name },
      invitedBy: by?.name || 'Someone',
      email: inv.email,
    };
  },
});

export async function validInvite(ctx, token, email) {
  const inv = await ctx.db
    .query('invites')
    .withIndex('by_token', (q) => q.eq('token', token))
    .unique();
  if (!inv || !(await ctx.db.get(inv.workspaceId))) fail(404, 'This invite link is not valid');
  if (inv.acceptedBy) fail(410, 'This invite link has already been used');
  if (inv.expiresAt < Date.now()) fail(410, 'This invite link has expired');
  if (inv.email && email && inv.email !== normEmail(email)) fail(403, `This invite is for ${inv.email}`);
  return inv;
}

export async function acceptInvite(ctx, inv, userId) {
  if (await membership(ctx, inv.workspaceId, userId)) return inv.workspaceId; // already in; keep link usable
  await ctx.db.patch(inv._id, { acceptedBy: userId });
  await ctx.db.insert('members', { workspaceId: inv.workspaceId, userId, role: 'member', joinedAt: Date.now() });
  return inv.workspaceId;
}

export const accept = mutation({
  args: { session: v.string(), token: v.string() },
  handler: async (ctx, { session, token }) => {
    const user = await requireUser(ctx, session);
    return acceptInvite(ctx, await validInvite(ctx, token, user.email), user._id);
  },
});

export const acceptInviteFor = internalMutation({
  args: { userId: v.id('users'), token: v.string() },
  handler: async (ctx, { userId, token }) => {
    const user = await ctx.db.get(userId);
    return acceptInvite(ctx, await validInvite(ctx, token, user.email), userId);
  },
});

// ---------- agent tokens ----------
export const agentTokens = query({
  args: { session: v.string(), workspaceId: v.id('workspaces') },
  handler: async (ctx, { session, workspaceId }) => {
    const user = await requireUser(ctx, session);
    await requireMember(ctx, workspaceId, user._id);
    const rows = await ctx.db
      .query('agentTokens')
      .withIndex('by_workspace_user', (q) => q.eq('workspaceId', workspaceId).eq('userId', user._id))
      .collect();
    return rows.map((t) => ({ id: t._id, name: t.name, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt }));
  },
});

export const createAgentToken = action({
  args: { session: v.string(), workspaceId: v.id('workspaces'), name: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const token = randomToken('nca_');
    await ctx.runMutation(internal.workspaces.insertAgentToken, { ...args, tokenHash: sha256(token) });
    return { token };
  },
});

export const insertAgentToken = internalMutation({
  args: { session: v.string(), workspaceId: v.id('workspaces'), name: v.optional(v.string()), tokenHash: v.string() },
  handler: async (ctx, { session, workspaceId, name, tokenHash }) => {
    const user = await requireUser(ctx, session);
    await requireMember(ctx, workspaceId, user._id);
    await ctx.db.insert('agentTokens', { workspaceId, userId: user._id, name: String(name || 'Agent').slice(0, 60), tokenHash, createdAt: Date.now(), lastUsedAt: null });
  },
});

export const revokeAgentToken = mutation({
  args: { session: v.string(), tokenId: v.id('agentTokens') },
  handler: async (ctx, { session, tokenId }) => {
    const user = await requireUser(ctx, session);
    const t = await ctx.db.get(tokenId);
    if (!t || t.userId !== user._id) fail(404, 'Token not found');
    await ctx.db.delete(tokenId);
  },
});

// ---------- import (used by scripts/import-data.js via `npx convex run`) ----------
export const importWorkspace = internalMutation({
  args: { name: v.string(), pages: v.any() },
  handler: async (ctx, { name, pages }) => {
    const id = await ctx.db.insert('workspaces', { name, ownerId: null, createdAt: Date.now() });
    const { model, commit } = await loadWorkspace(ctx, id);
    Object.assign(model.data.pages, pages);
    model.normalize();
    await commit();
    return id;
  },
});

// Give ownerless (imported) workspaces to an existing account, for imports done after sign-up:
//   npx convex run --prod workspaces:claimImported '{"email":"you@example.com"}'
export const claimImported = internalMutation({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const user = await ctx.db.query('users').withIndex('by_email', (q) => q.eq('email', normEmail(email))).unique();
    if (!user) throw new Error(`No account for ${email}`);
    const claimed = [];
    for (const w of await ctx.db.query('workspaces').collect()) {
      if (w.ownerId) continue;
      await ctx.db.patch(w._id, { ownerId: user._id });
      await ctx.db.insert('members', { workspaceId: w._id, userId: user._id, role: 'owner', joinedAt: Date.now() });
      claimed.push(w.name);
    }
    return claimed;
  },
});
