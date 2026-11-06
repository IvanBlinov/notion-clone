import { v } from 'convex/values';
import { query, mutation, internalQuery, internalMutation } from './_generated/server';
import { COLORS, DAY, fail, openSignup, publicUser, requireUser, createWorkspaceWithSeed } from './lib/util.js';
import { sha256 } from './lib/sha256.js';
import { acceptInvite, validInvite } from './workspaces.js';

const SESSION_DAYS = 30;

export const status = query({
  args: {},
  handler: async (ctx) => ({ hasUsers: !!(await ctx.db.query('users').first()), openSignup: await openSignup(ctx) }),
});

/** Current user + their workspaces. */
export const me = query({
  args: { session: v.string() },
  handler: async (ctx, { session }) => {
    const user = await requireUser(ctx, session);
    const memberships = await ctx.db
      .query('members')
      .withIndex('by_user', (q) => q.eq('userId', user._id))
      .collect();
    const workspaces = [];
    for (const m of memberships) {
      const w = await ctx.db.get(m.workspaceId);
      if (w) workspaces.push({ id: w._id, name: w.name, role: m.role, createdAt: w.createdAt });
    }
    workspaces.sort((a, b) => a.createdAt - b.createdAt);
    return { user: publicUser(user), workspaces };
  },
});

export const logOut = mutation({
  args: { session: v.string() },
  handler: async (ctx, { session }) => {
    const s = await ctx.db
      .query('sessions')
      .withIndex('by_tokenHash', (q) => q.eq('tokenHash', sha256(session)))
      .unique();
    if (s) await ctx.db.delete(s._id);
  },
});

// ---------- internal (called by the Node actions in authNode.js) ----------
export const credentials = internalQuery({
  args: { email: v.string() },
  handler: async (ctx, { email }) => {
    const u = await ctx.db
      .query('users')
      .withIndex('by_email', (q) => q.eq('email', email))
      .unique();
    return u && { userId: u._id, salt: u.salt, passwordHash: u.passwordHash, lockedUntil: u.lockedUntil };
  },
});

export const recordFailure = internalMutation({
  args: { userId: v.id('users') },
  handler: async (ctx, { userId }) => {
    const u = await ctx.db.get(userId);
    const failed = (u.failedLogins || 0) + 1;
    await ctx.db.patch(userId, failed >= 10 ? { failedLogins: 0, lockedUntil: Date.now() + 15 * 60_000 } : { failedLogins: failed });
  },
});

async function newSession(ctx, userId, sessionHash) {
  await ctx.db.insert('sessions', { userId, tokenHash: sessionHash, expiresAt: Date.now() + SESSION_DAYS * DAY });
}

export const createSession = internalMutation({
  args: { userId: v.id('users'), sessionHash: v.string() },
  handler: async (ctx, { userId, sessionHash }) => {
    await ctx.db.patch(userId, { failedLogins: 0, lockedUntil: undefined });
    await newSession(ctx, userId, sessionHash);
    return publicUser(await ctx.db.get(userId));
  },
});

export const createAccount = internalMutation({
  args: { name: v.string(), email: v.string(), salt: v.string(), passwordHash: v.string(), sessionHash: v.string(), inviteToken: v.optional(v.string()) },
  handler: async (ctx, a) => {
    const exists = await ctx.db
      .query('users')
      .withIndex('by_email', (q) => q.eq('email', a.email))
      .unique();
    if (exists) fail(409, 'An account with this email already exists — log in instead');
    const invite = a.inviteToken ? await validInvite(ctx, a.inviteToken, a.email) : null;
    const first = !(await ctx.db.query('users').first());
    if (!invite && !(await openSignup(ctx))) fail(403, 'Sign-up is by invitation only. Ask a workspace owner for an invite link.');
    const count = (await ctx.db.query('users').take(1000)).length;
    const userId = await ctx.db.insert('users', {
      name: a.name,
      email: a.email,
      salt: a.salt,
      passwordHash: a.passwordHash,
      color: COLORS[count % COLORS.length],
      createdAt: Date.now(),
    });
    if (first) {
      // The first account owns any workspace that was imported before accounts existed.
      for (const w of await ctx.db.query('workspaces').collect()) {
        if (w.ownerId) continue;
        await ctx.db.patch(w._id, { ownerId: userId, name: `${a.name}'s Workspace` });
        await ctx.db.insert('members', { workspaceId: w._id, userId, role: 'owner', joinedAt: Date.now() });
      }
    }
    if (invite) await acceptInvite(ctx, invite, userId);
    else if (!(await ctx.db.query('members').withIndex('by_user', (q) => q.eq('userId', userId)).first())) {
      await createWorkspaceWithSeed(ctx, userId, `${a.name}'s Workspace`);
    }
    await newSession(ctx, userId, a.sessionHash);
    return publicUser(await ctx.db.get(userId));
  },
});
