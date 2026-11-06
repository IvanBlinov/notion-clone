import { v } from 'convex/values';
import { query, mutation, internalMutation } from './_generated/server';
import { requireUser, requireMember } from './lib/util.js';

/** Called by each open browser tab every ~20s and whenever it opens another page. */
export const heartbeat = mutation({
  args: { session: v.string(), workspaceId: v.id('workspaces'), clientId: v.string(), pageId: v.union(v.string(), v.null()) },
  handler: async (ctx, { session, workspaceId, clientId, pageId }) => {
    const user = await requireUser(ctx, session);
    await requireMember(ctx, workspaceId, user._id);
    const row = { workspaceId, clientId, userId: user._id, name: user.name, color: user.color, pageId, lastSeen: Date.now() };
    const existing = await ctx.db
      .query('presence')
      .withIndex('by_client', (q) => q.eq('clientId', clientId))
      .unique();
    if (existing) await ctx.db.replace(existing._id, row);
    else await ctx.db.insert('presence', row);
  },
});

export const leave = mutation({
  args: { clientId: v.string() },
  handler: async (ctx, { clientId }) => {
    const existing = await ctx.db
      .query('presence')
      .withIndex('by_client', (q) => q.eq('clientId', clientId))
      .unique();
    if (existing) await ctx.db.delete(existing._id);
  },
});

/** Everyone currently in the workspace (clients drop rows older than ~1 minute). */
export const list = query({
  args: { session: v.string(), workspaceId: v.id('workspaces') },
  handler: async (ctx, { session, workspaceId }) => {
    const user = await requireUser(ctx, session);
    await requireMember(ctx, workspaceId, user._id);
    const rows = await ctx.db
      .query('presence')
      .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
      .collect();
    return rows.map((r) => ({ clientId: r.clientId, userId: r.userId, name: r.name, color: r.color, pageId: r.pageId, lastSeen: r.lastSeen }));
  },
});

export const cleanup = internalMutation({
  args: {},
  handler: async (ctx) => {
    const stale = await ctx.db
      .query('presence')
      .withIndex('by_lastSeen', (q) => q.lt('lastSeen', Date.now() - 60_000))
      .take(500);
    for (const r of stale) await ctx.db.delete(r._id);
    const expired = await ctx.db
      .query('sessions')
      .withIndex('by_expiresAt', (q) => q.lt('expiresAt', Date.now()))
      .take(500);
    for (const s of expired) await ctx.db.delete(s._id);
  },
});
