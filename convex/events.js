// The change feed. Each saved change appends its events (the same objects webhooks receive)
// under a per-workspace sequence number. Agents read everything after a cursor, optionally
// filtered, and can wait for the next change (long-poll in convex/http.js).
import { v } from 'convex/values';
import { internalMutation } from './_generated/server';
import { emitEvents } from './webhooks.js';
import { fail } from './lib/util.js';

const PER_ROW = 100; // events per stored row (keeps documents well under 1 MB)
const KEEP_DAYS = 30;

/** Inside a mutation: append events to the feed and hand them to matching webhooks. */
export async function recordEvents(ctx, workspaceId, events) {
  if (!events?.length) return;
  const state = await ctx.db
    .query('eventSeq')
    .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
    .unique();
  let seq = state?.seq || 0;
  const at = Date.now();
  for (let i = 0; i < events.length; i += PER_ROW) {
    seq += 1;
    await ctx.db.insert('events', { workspaceId, seq, at, events: events.slice(i, i + PER_ROW) });
  }
  if (state) await ctx.db.patch(state._id, { seq });
  else await ctx.db.insert('eventSeq', { workspaceId, seq });
  await emitEvents(ctx, workspaceId, events);
}

export async function latestSeq(ctx, workspaceId) {
  const state = await ctx.db
    .query('eventSeq')
    .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
    .unique();
  return state?.seq || 0;
}

const typeMatches = (types, name) => !types?.length || types.some((t) => t === '*' || t === name || (t.endsWith('.*') && name.startsWith(t.slice(0, -1))));

/**
 * Events after `cursor` (a number from an earlier call), or since a time, newest last.
 * Filters: types ("item.updated", "comment.*"), databaseId, pageId, properties (item.updated
 * events only count when one of these properties changed), excludeActorId (skip your own edits).
 * Without cursor or since: the most recent events and the current cursor.
 */
export async function listEvents(ctx, workspaceId, { cursor, since, types, databaseId, pageId, properties, excludeActorId, limit = 100 } = {}) {
  const size = Math.max(1, Math.min(500, Number(limit) || 100));
  const props = (properties || []).map((p) => String(p).toLowerCase());
  const keep = (e) => {
    if (!typeMatches(types, e.event)) return false;
    if (databaseId && e.databaseId !== databaseId && e.page?.id !== databaseId) return false;
    if (pageId && e.page?.id !== pageId) return false;
    if (excludeActorId && e.actorId === excludeActorId) return false;
    if (props.length && e.event === 'item.updated' && !Object.keys(e.changes || {}).some((k) => props.includes(k.toLowerCase()))) return false;
    return true;
  };
  const current = await latestSeq(ctx, workspaceId);
  if (cursor == null && !since) {
    const rows = await ctx.db
      .query('events')
      .withIndex('by_seq', (q) => q.eq('workspaceId', workspaceId))
      .order('desc')
      .take(50);
    const out = rows.reverse().flatMap((r) => r.events.filter(keep));
    return { cursor: current, events: out.slice(-size), more: false, hint: 'Pass this cursor next time to get only newer events' };
  }
  let after = Number(cursor);
  if (cursor == null) {
    const t = new Date(since).getTime();
    if (isNaN(t)) fail(400, `Invalid time "${since}"; use an ISO date-time like 2026-11-10T12:00:00Z`);
    // first row at or after the time
    const first = await ctx.db
      .query('events')
      .withIndex('by_seq', (q) => q.eq('workspaceId', workspaceId))
      .filter((q) => q.gte(q.field('at'), t))
      .first();
    after = first ? first.seq - 1 : current;
  }
  if (!Number.isFinite(after) || after < 0) fail(400, 'cursor must be a number from an earlier list_events call');
  const out = [];
  let last = after;
  let more = false;
  for await (const r of ctx.db.query('events').withIndex('by_seq', (q) => q.eq('workspaceId', workspaceId).gt('seq', after))) {
    if (out.length >= size || last - after >= 500) {
      more = true;
      break;
    }
    out.push(...r.events.filter(keep));
    last = r.seq;
  }
  const oldest = await ctx.db
    .query('events')
    .withIndex('by_seq', (q) => q.eq('workspaceId', workspaceId))
    .first();
  return {
    cursor: after > current ? current : last,
    events: out,
    more,
    ...(oldest && after + 1 < oldest.seq && cursor != null ? { gap: `Events before #${oldest.seq} were dropped (the feed keeps ${KEEP_DAYS} days); use list_changes to catch up` } : {}),
  };
}

/** Daily: drop feed rows older than KEEP_DAYS. */
export const cleanup = internalMutation({
  args: {},
  handler: async (ctx) => {
    const old = await ctx.db
      .query('events')
      .withIndex('by_at', (q) => q.lt('at', Date.now() - KEEP_DAYS * 86400e3))
      .take(1000);
    for (const r of old) await ctx.db.delete(r._id);
  },
});
