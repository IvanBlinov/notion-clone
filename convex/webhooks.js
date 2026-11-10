// Outgoing webhooks. After a change is saved, matching webhooks get one POST with a JSON
// list of events, signed with the webhook's secret:
//   X-Webhook-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<body>">
//   X-Webhook-Timestamp: <unix seconds>
// Events: page.created / page.updated / page.archived / page.restored / page.deleted, the same for
// database.* and item.* (items carry the changed properties), comment.added, comment.resolved.
import { v } from 'convex/values';
import { query, mutation, action, internalAction, internalMutation, internalQuery } from './_generated/server';
import { internal } from './_generated/api';
import { fail, requireUser, requireMember, requireOwner } from './lib/util.js';
import * as DB from '../src/shared/database.js';

export const EVENT_TYPES = ['page.created', 'page.updated', 'page.archived', 'page.restored', 'page.deleted', 'database.created', 'database.updated', 'database.archived', 'database.restored', 'database.deleted', 'item.created', 'item.updated', 'item.archived', 'item.restored', 'item.deleted', 'comment.added', 'comment.resolved'];
const MAX_HOOKS = 10;
/** JSON with sorted keys (stored objects may come back with keys in another order). */
const stable = (v) => JSON.stringify(v ?? null, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));

/** https only, and never an address inside a private network or a cloud metadata service. */
export function webhookUrlProblem(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return 'Not a valid URL';
  }
  if (u.protocol !== 'https:') return 'Webhook URLs must use https://';
  if (u.username || u.password) return 'Put credentials in the secret, not in the URL';
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') || !h.includes('.')) return 'That host is not reachable from the internet';
  const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224) return 'Private and reserved IP addresses are not allowed';
  }
  if (h.includes(':')) return 'Use a host name, not an IPv6 address';
  return null;
}

const matchesEvent = (hook, e) =>
  (hook.events.includes('*') || hook.events.includes(e.event) || hook.events.includes(`${e.event.split('.')[0]}.*`)) && (!hook.databaseId || e.databaseId === hook.databaseId || e.page?.id === hook.databaseId);

/** Called inside mutations: queue a delivery to every webhook that wants some of these events. */
export async function emitEvents(ctx, workspaceId, events) {
  if (!events.length || !ctx.scheduler) return;
  const hooks = await ctx.db
    .query('webhooks')
    .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
    .collect();
  for (const hook of hooks) {
    const mine = events.filter((e) => matchesEvent(hook, e)).slice(0, 500);
    if (mine.length) await ctx.scheduler.runAfter(0, internal.webhooks.deliver, { hookId: hook._id, events: mine });
  }
}

/** Events for the pages a mutation changed (old JSON → new page). */
export function pageEvents(model, changed, actorName, actorId) {
  const pages = model.data.pages;
  const comp = DB.createComputer({ pages, members: model.members });
  const env = { titleOf: comp.titleOf };
  const at = new Date().toISOString();
  const out = [];
  const oldSchema = new Map(changed.filter((c) => c.old?.database).map((c) => [c.pid, c.old.database.properties]));
  const show = (prop, v) => {
    try {
      return DB.displayValue(prop, v, model.members, env);
    } catch {
      return v == null ? null : String(v);
    }
  };
  for (const { pid, old, now } of changed) {
    const p = now || old;
    const parent = p.parentId ? pages[p.parentId] || null : null;
    const kind = p.database ? 'database' : parent?.database ? 'item' : 'page';
    let type;
    if (!now) type = 'deleted';
    else if (!old) type = 'created';
    else if (!old.archivedAt && now.archivedAt) type = 'archived';
    else if (old.archivedAt && !now.archivedAt) type = 'restored';
    else type = 'updated';
    const e = { event: `${kind}.${type}`, at, actor: actorName || p.lastEditedBy || null, ...(actorId ? { actorId } : {}), page: { id: p.id, title: p.title, kind } };
    if (kind === 'item') {
      e.databaseId = parent.id;
      e.database = { id: parent.id, title: parent.title };
    }
    if (type === 'updated') {
      const changes = {};
      if (old.title !== now.title) changes.title = { from: old.title, to: now.title };
      if (old.icon !== now.icon) changes.icon = { from: old.icon, to: now.icon };
      if (stable(old.blocks) !== stable(now.blocks)) changes.content = true;
      if (kind === 'item') {
        for (const prop of parent.database.properties) {
          if (DB.COMPUTED_TYPES.includes(prop.type)) continue;
          const a = old.props?.[prop.id];
          const b = now.props?.[prop.id];
          if (stable(a) === stable(b)) continue;
          const oldProp = oldSchema.get(parent.id)?.find((x) => x.id === prop.id) || prop; // a retyped property shows its old value the old way
          changes[prop.name] = { from: show(oldProp, a), to: show(prop, b) };
        }
      }
      if (kind === 'database' && stable(old.database?.properties) !== stable(now.database?.properties)) changes.schema = true;
      if (!Object.keys(changes).length) continue; // only a version / position / bookkeeping change
      e.changes = changes;
    }
    if (kind === 'item' && type === 'created') {
      const r = comp.row(parent.id, p.id) || p;
      e.properties = Object.fromEntries(parent.database.properties.map((prop) => [prop.name, show(prop, DB.rawValue(r, prop))]).filter(([, v]) => v != null && v !== false));
    }
    out.push(e);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function sign(secret, text) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text)));
}

export const hookFor = internalQuery({
  args: { hookId: v.id('webhooks') },
  handler: async (ctx, { hookId }) => ctx.db.get(hookId),
});

export const deliver = internalAction({
  args: { hookId: v.id('webhooks'), events: v.any(), test: v.optional(v.boolean()) },
  handler: async (ctx, { hookId, events, test }) => {
    const hook = await ctx.runQuery(internal.webhooks.hookFor, { hookId });
    if (!hook) return { ok: false, error: 'Webhook was removed' };
    const problem = webhookUrlProblem(hook.url);
    let status = null;
    let error = problem;
    if (!problem) {
      const ts = Math.floor(Date.now() / 1000);
      const body = JSON.stringify({ webhookId: hookId, workspaceId: hook.workspaceId, test: !!test, events, webUrl: process.env.WEB_URL || null });
      try {
        const res = await fetch(hook.url, {
          method: 'POST',
          redirect: 'manual',
          headers: { 'Content-Type': 'application/json', 'User-Agent': 'notion-clone-webhooks/1', 'X-Webhook-Id': hookId, 'X-Webhook-Timestamp': String(ts), 'X-Webhook-Signature': `sha256=${await sign(hook.secret, `${ts}.${body}`)}` },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        status = res.status;
        error = res.ok ? null : `HTTP ${res.status}`;
      } catch (err) {
        error = String(err?.message || err).slice(0, 200);
      }
    }
    await ctx.runMutation(internal.webhooks.record, { hookId, status, error });
    return { ok: !error, status, error };
  },
});

export const record = internalMutation({
  args: { hookId: v.id('webhooks'), status: v.union(v.number(), v.null()), error: v.union(v.string(), v.null()) },
  handler: async (ctx, { hookId, status, error }) => {
    const hook = await ctx.db.get(hookId);
    if (hook) await ctx.db.patch(hookId, { lastStatus: status, lastError: error, lastAt: Date.now(), failures: error ? hook.failures + 1 : 0 });
  },
});

// ---------------------------------------------------------------------------
// Management (owner in Settings, or an agent through MCP)
// ---------------------------------------------------------------------------
export const hookOut = (h, withSecret = false) => ({
  id: h._id,
  url: h.url,
  events: h.events,
  databaseId: h.databaseId,
  description: h.description,
  createdBy: h.createdBy,
  createdAt: new Date(h.createdAt).toISOString(),
  lastDelivery: h.lastAt ? { at: new Date(h.lastAt).toISOString(), status: h.lastStatus, error: h.lastError } : null,
  failuresInARow: h.failures,
  ...(withSecret ? { secret: h.secret } : {}),
});

export async function listHooks(ctx, workspaceId) {
  return (
    await ctx.db
      .query('webhooks')
      .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId))
      .collect()
  ).map((h) => hookOut(h));
}

export async function createHook(ctx, workspaceId, { url, events, databaseId, description, secret }, createdBy) {
  const problem = webhookUrlProblem(String(url || ''));
  if (problem) fail(400, problem);
  const list = (events?.length ? events : ['*']).map((e) => String(e).trim().toLowerCase());
  for (const e of list) if (e !== '*' && !EVENT_TYPES.includes(e) && !/^(page|database|item|comment)\.\*$/.test(e)) fail(400, `Unknown event "${e}". Events: *, ${EVENT_TYPES.join(', ')}, or "item.*" style groups`);
  const count = (await ctx.db.query('webhooks').withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId)).collect()).length;
  if (count >= MAX_HOOKS) fail(400, `At most ${MAX_HOOKS} webhooks per workspace`);
  if (databaseId) {
    const db = await ctx.db
      .query('pages')
      .withIndex('by_workspace_pid', (q) => q.eq('workspaceId', workspaceId).eq('pid', databaseId))
      .unique();
    if (!db?.database) fail(400, `"${databaseId}" is not a database`);
  }
  const id = await ctx.db.insert('webhooks', {
    workspaceId,
    url: String(url).slice(0, 2000),
    events: list,
    databaseId: databaseId || null,
    secret,
    description: String(description || '').slice(0, 200),
    createdBy,
    createdAt: Date.now(),
    lastStatus: null,
    lastError: null,
    lastAt: null,
    failures: 0,
  });
  return hookOut(await ctx.db.get(id), true);
}

export async function deleteHook(ctx, workspaceId, hookId) {
  const id = ctx.db.normalizeId('webhooks', String(hookId));
  const hook = id && (await ctx.db.get(id));
  if (!hook || hook.workspaceId !== workspaceId) fail(404, 'Webhook not found');
  await ctx.db.delete(hook._id);
  return { deleted: true, id: hook._id };
}

export const newSecret = () => 'whsec_' + [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, '0')).join('');

export const list = query({
  args: { session: v.string(), workspaceId: v.id('workspaces') },
  handler: async (ctx, { session, workspaceId }) => {
    const user = await requireUser(ctx, session);
    await requireMember(ctx, workspaceId, user._id);
    return listHooks(ctx, workspaceId);
  },
});

export const create = action({
  args: { session: v.string(), workspaceId: v.id('workspaces'), url: v.string(), events: v.optional(v.array(v.string())), databaseId: v.optional(v.string()), description: v.optional(v.string()) },
  handler: async (ctx, a) => ctx.runMutation(internal.webhooks.insert, { ...a, secret: newSecret() }),
});

export const insert = internalMutation({
  args: { session: v.string(), workspaceId: v.id('workspaces'), url: v.string(), events: v.optional(v.array(v.string())), databaseId: v.optional(v.string()), description: v.optional(v.string()), secret: v.string() },
  handler: async (ctx, { session, workspaceId, ...a }) => {
    const user = await requireUser(ctx, session);
    await requireOwner(ctx, workspaceId, user._id);
    return createHook(ctx, workspaceId, a, user.name);
  },
});

export const remove = mutation({
  args: { session: v.string(), workspaceId: v.id('workspaces'), hookId: v.string() },
  handler: async (ctx, { session, workspaceId, hookId }) => {
    const user = await requireUser(ctx, session);
    await requireOwner(ctx, workspaceId, user._id);
    return deleteHook(ctx, workspaceId, hookId);
  },
});

/** Send a test event now. */
export const test = mutation({
  args: { session: v.string(), workspaceId: v.id('workspaces'), hookId: v.id('webhooks') },
  handler: async (ctx, { session, workspaceId, hookId }) => {
    const user = await requireUser(ctx, session);
    await requireOwner(ctx, workspaceId, user._id);
    const hook = await ctx.db.get(hookId);
    if (!hook || hook.workspaceId !== workspaceId) fail(404, 'Webhook not found');
    await ctx.scheduler.runAfter(0, internal.webhooks.deliver, { hookId, events: [{ event: 'test', at: new Date().toISOString(), actor: user.name }], test: true });
    return { queued: true };
  },
});
