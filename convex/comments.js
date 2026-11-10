// Comments on pages and database items: threads (a first comment + replies), @mentions,
// resolve / reopen. Used by the web app and, through agent.js, by MCP agents.
import { v } from 'convex/values';
import { query, mutation } from './_generated/server';
import { fail, requireUser, requireMember, workspaceMembers } from './lib/util.js';
import { recordEvents } from './events.js';

const MAX_TEXT = 5000;

async function pageDoc(ctx, workspaceId, pageId) {
  return ctx.db
    .query('pages')
    .withIndex('by_workspace_pid', (q) => q.eq('workspaceId', workspaceId).eq('pid', String(pageId)))
    .unique();
}

/** "@Anna", "@anna@example.com", "@Claude" → member ids (longest names first, so "@Anna Lee" beats "@Anna"). */
export function findMentions(text, members) {
  const out = new Set();
  const lower = String(text).toLowerCase();
  const names = members
    .flatMap((m) => [m.name && [m.name.toLowerCase(), m.id], m.email && [m.email.toLowerCase(), m.id], m.name && [m.name.toLowerCase().split(/\s+/)[0], m.id]].filter(Boolean))
    .sort((a, b) => b[0].length - a[0].length);
  let i = lower.indexOf('@');
  while (i >= 0) {
    const rest = lower.slice(i + 1);
    const hit = names.find(([n]) => rest.startsWith(n) && !/[\p{L}\p{N}_]/u.test(rest[n.length] || ''));
    if (hit) out.add(hit[1]);
    i = lower.indexOf('@', i + 1);
  }
  return [...out];
}

function commentOut(c, members, page) {
  const name = (id) => members.find((m) => m.id === id)?.name || 'Former member';
  return {
    id: c._id,
    pageId: c.pageId,
    ...(page ? { pageTitle: page.title } : {}),
    parentId: c.parentId,
    author: { id: c.authorId, name: c.authorName, kind: c.authorKind },
    text: c.text,
    mentions: c.mentions.map((id) => ({ id, name: name(id) })),
    resolved: c.resolved,
    ...(c.resolvedBy ? { resolvedBy: c.resolvedBy } : {}),
    createdAt: new Date(c.createdAt).toISOString(),
    ...(c.editedAt ? { editedAt: new Date(c.editedAt).toISOString() } : {}),
  };
}

/** Threads, oldest first: [{ ...first comment, replies: [...] }]. */
export async function listComments(ctx, workspaceId, { pageId = null, unresolvedOnly = false, since = null, limit = 100 } = {}) {
  const members = await workspaceMembers(ctx, workspaceId);
  let rows;
  if (pageId) {
    if (!(await pageDoc(ctx, workspaceId, pageId))) fail(404, `No page with id "${pageId}"`);
    rows = await ctx.db
      .query('comments')
      .withIndex('by_page', (q) => q.eq('workspaceId', workspaceId).eq('pageId', String(pageId)))
      .collect();
  } else {
    const from = since ? new Date(since).getTime() : 0;
    if (since && isNaN(from)) fail(400, `Invalid time "${since}"`);
    rows = await ctx.db
      .query('comments')
      .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId).gte('createdAt', 0))
      .order('desc')
      .take(2000);
    if (from) {
      // threads with any activity since then
      const active = new Set(rows.filter((c) => c.createdAt > from || (c.editedAt || 0) > from).map((c) => String(c.parentId || c._id)));
      rows = rows.filter((c) => active.has(String(c.parentId || c._id)));
    }
  }
  rows.sort((a, b) => a.createdAt - b.createdAt);
  const titles = new Map();
  const titleOf = async (pid) => {
    if (!titles.has(pid)) titles.set(pid, await pageDoc(ctx, workspaceId, pid));
    return titles.get(pid);
  };
  const threads = [];
  const byId = new Map();
  for (const c of rows.filter((x) => !x.parentId)) {
    const t = { ...commentOut(c, members, pageId ? null : await titleOf(c.pageId)), replies: [] };
    byId.set(String(c._id), t);
    threads.push(t);
  }
  for (const c of rows.filter((x) => x.parentId)) byId.get(String(c.parentId))?.replies.push(commentOut(c, members));
  const list = unresolvedOnly ? threads.filter((t) => !t.resolved) : threads;
  return { total: list.length, threads: list.slice(-Math.max(1, Math.min(500, limit))) };
}

/** author: { id, name, kind } */
export async function addComment(ctx, workspaceId, author, { pageId, text, parentId = null }) {
  const body = String(text ?? '').trim();
  if (!body) fail(400, 'Comment text is empty');
  if (body.length > MAX_TEXT) fail(400, `Comments are limited to ${MAX_TEXT} characters`);
  let thread = null;
  if (parentId) {
    const id = ctx.db.normalizeId('comments', String(parentId));
    thread = id && (await ctx.db.get(id));
    if (!thread || thread.workspaceId !== workspaceId) fail(404, 'Comment not found');
    if (thread.parentId) thread = await ctx.db.get(thread.parentId); // reply to a reply → same thread
    pageId = thread.pageId;
  }
  const page = await pageDoc(ctx, workspaceId, pageId);
  if (!page) fail(404, `No page with id "${pageId}"`);
  const members = await workspaceMembers(ctx, workspaceId);
  const id = await ctx.db.insert('comments', {
    workspaceId,
    pageId: page.pid,
    parentId: thread?._id ?? null,
    authorId: author.id,
    authorName: author.name,
    authorKind: author.kind,
    text: body,
    mentions: findMentions(body, members),
    resolved: false,
    createdAt: Date.now(),
  });
  if (thread?.resolved) await ctx.db.patch(thread._id, { resolved: false, resolvedBy: undefined }); // a reply reopens the thread
  const c = await ctx.db.get(id);
  const out = commentOut(c, members, page);
  await recordEvents(ctx, workspaceId, [{ event: 'comment.added', at: out.createdAt, actor: author.name, ...(author.id ? { actorId: author.id } : {}), page: { id: page.pid, title: page.title }, ...(page.parentId ? { databaseId: page.parentId } : {}), comment: out }]);
  return out;
}

export async function resolveComment(ctx, workspaceId, who, { commentId, resolved = true }) {
  const id = ctx.db.normalizeId('comments', String(commentId));
  let c = id && (await ctx.db.get(id));
  if (!c || c.workspaceId !== workspaceId) fail(404, 'Comment not found');
  if (c.parentId) c = await ctx.db.get(c.parentId); // resolving a reply resolves its thread
  await ctx.db.patch(c._id, { resolved: !!resolved, resolvedBy: resolved ? who.name : undefined });
  const page = await pageDoc(ctx, workspaceId, c.pageId);
  if (resolved) await recordEvents(ctx, workspaceId, [{ event: 'comment.resolved', at: new Date().toISOString(), actor: who.name, ...(who.id ? { actorId: who.id } : {}), page: { id: c.pageId, title: page?.title ?? '' }, ...(page?.parentId ? { databaseId: page.parentId } : {}), comment: { id: c._id, text: c.text } }]);
  return { id: c._id, resolved: !!resolved };
}

// ---------- web app ----------
async function open(ctx, session, workspaceId) {
  const user = await requireUser(ctx, session);
  const { role } = await requireMember(ctx, workspaceId, user._id);
  return { user, role };
}

export const list = query({
  args: { session: v.string(), workspaceId: v.id('workspaces'), pageId: v.string() },
  handler: async (ctx, { session, workspaceId, pageId }) => {
    await open(ctx, session, workspaceId);
    if (!(await pageDoc(ctx, workspaceId, pageId))) return { total: 0, threads: [] };
    return listComments(ctx, workspaceId, { pageId });
  },
});

/** People and AI agents of the workspace (for @mention suggestions). */
export const people = query({
  args: { session: v.string(), workspaceId: v.id('workspaces') },
  handler: async (ctx, { session, workspaceId }) => {
    await open(ctx, session, workspaceId);
    return (await workspaceMembers(ctx, workspaceId)).map(({ id, name, color, kind }) => ({ id, name, color, kind: kind || 'user' }));
  },
});

/** Open thread counts per page, for the 💬 badges. */
export const counts = query({
  args: { session: v.string(), workspaceId: v.id('workspaces') },
  handler: async (ctx, { session, workspaceId }) => {
    await open(ctx, session, workspaceId);
    const rows = await ctx.db
      .query('comments')
      .withIndex('by_workspace', (q) => q.eq('workspaceId', workspaceId).gte('createdAt', 0))
      .collect();
    const out = {};
    for (const c of rows) if (!c.parentId && !c.resolved) out[c.pageId] = (out[c.pageId] || 0) + 1;
    return out;
  },
});

export const add = mutation({
  args: { session: v.string(), workspaceId: v.id('workspaces'), pageId: v.string(), text: v.string(), parentId: v.optional(v.string()) },
  handler: async (ctx, { session, workspaceId, pageId, text, parentId }) => {
    const { user } = await open(ctx, session, workspaceId);
    return addComment(ctx, workspaceId, { id: user._id, name: user.name, kind: 'user' }, { pageId, text, parentId });
  },
});

export const resolve = mutation({
  args: { session: v.string(), workspaceId: v.id('workspaces'), commentId: v.string(), resolved: v.boolean() },
  handler: async (ctx, { session, workspaceId, commentId, resolved }) => {
    const { user } = await open(ctx, session, workspaceId);
    return resolveComment(ctx, workspaceId, { id: user._id, name: user.name }, { commentId, resolved });
  },
});

export const edit = mutation({
  args: { session: v.string(), workspaceId: v.id('workspaces'), commentId: v.string(), text: v.string() },
  handler: async (ctx, { session, workspaceId, commentId, text }) => {
    const { user } = await open(ctx, session, workspaceId);
    const id = ctx.db.normalizeId('comments', commentId);
    const c = id && (await ctx.db.get(id));
    if (!c || c.workspaceId !== workspaceId) fail(404, 'Comment not found');
    if (c.authorId !== user._id) fail(403, 'You can only edit your own comments');
    const body = String(text).trim();
    if (!body || body.length > MAX_TEXT) fail(400, 'Comment text is empty or too long');
    await ctx.db.patch(c._id, { text: body, mentions: findMentions(body, await workspaceMembers(ctx, workspaceId)), editedAt: Date.now() });
  },
});

export const remove = mutation({
  args: { session: v.string(), workspaceId: v.id('workspaces'), commentId: v.string() },
  handler: async (ctx, { session, workspaceId, commentId }) => {
    const { user, role } = await open(ctx, session, workspaceId);
    const id = ctx.db.normalizeId('comments', commentId);
    const c = id && (await ctx.db.get(id));
    if (!c || c.workspaceId !== workspaceId) fail(404, 'Comment not found');
    if (c.authorId !== user._id && role !== 'owner') fail(403, 'Only the author or the workspace owner can delete a comment');
    if (!c.parentId) for (const r of await ctx.db.query('comments').withIndex('by_page', (q) => q.eq('workspaceId', workspaceId).eq('pageId', c.pageId)).collect()) if (String(r.parentId) === String(c._id)) await ctx.db.delete(r._id);
    await ctx.db.delete(c._id);
  },
});
