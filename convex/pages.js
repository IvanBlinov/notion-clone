import { v } from 'convex/values';
import { query, mutation } from './_generated/server';
import { fail, loadWorkspace, requireUser, requireMember, runModel } from './lib/util.js';

/** Model methods the editor may call through `pages:run`. */
export const WRITE_METHODS = new Set([
  'createPage',
  'updatePage',
  'savePage',
  'duplicatePage',
  'archivePage',
  'restorePage',
  'deletePage',
  'emptyTrash',
  'setContent',
  'appendContent',
  'updateBlock',
  'deleteBlocks',
  'moveBlock',
  'blockToPage',
  'createPages',
  'createDatabase',
  'updateDatabase',
  'createRows',
  'updateRows',
  'upsertRows',
  'archiveRows',
  'saveView',
  'saveTemplate',
  'createLinkedView',
  'updateLinkedView',
]);

const base = { session: v.string(), workspaceId: v.id('workspaces') };

async function open(ctx, session, workspaceId) {
  const user = await requireUser(ctx, session);
  await requireMember(ctx, workspaceId, user._id);
  return { user, ...(await loadWorkspace(ctx, workspaceId)) };
}

// ---------- live queries (the browser subscribes to these) ----------
export const tree = query({
  args: base,
  handler: async (ctx, { session, workspaceId }) => (await open(ctx, session, workspaceId)).model.listTree(),
});

export const trash = query({
  args: base,
  handler: async (ctx, { session, workspaceId }) => (await open(ctx, session, workspaceId)).model.listTrash(),
});

/** A page with breadcrumb + children, or null if it doesn't exist (any more). */
export const get = query({
  args: { ...base, pageId: v.string() },
  handler: async (ctx, { session, workspaceId, pageId }) => {
    const { model } = await open(ctx, session, workspaceId);
    return model.hasPage(pageId) ? model.getPage({ pageId }) : null;
  },
});

export const markdown = query({
  args: { ...base, pageId: v.string() },
  handler: async (ctx, { session, workspaceId, pageId }) => {
    const { model } = await open(ctx, session, workspaceId);
    return runModel(() => model.getPageMarkdown({ pageId }));
  },
});

/** A database with all its rows (the browser applies views client-side). Null if gone. */
export const rows = query({
  args: { ...base, pageId: v.string() },
  handler: async (ctx, { session, workspaceId, pageId }) => {
    const { model } = await open(ctx, session, workspaceId);
    if (!model.hasPage(pageId)) return null;
    try {
      return model.databaseRows({ pageId });
    } catch {
      return null;
    }
  },
});

export const search = query({
  args: { ...base, query: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { session, workspaceId, query: q, limit }) => (await open(ctx, session, workspaceId)).model.search({ query: q, limit: limit || 20 }),
});

// ---------- writes ----------
export const run = mutation({
  args: { ...base, method: v.string(), args: v.any(), clientId: v.optional(v.string()) },
  handler: async (ctx, { session, workspaceId, method, args, clientId }) => {
    if (!WRITE_METHODS.has(method)) fail(400, `Unknown method ${method}`);
    const { user, model, commit } = await open(ctx, session, workspaceId);
    const actor = { client: clientId || 'web', kind: 'user', name: user.name, userId: user._id };
    const result = runModel(() => model[method](args || {}, actor));
    await commit({ actor: user.name, actorId: user._id });
    return result ?? null;
  },
});
