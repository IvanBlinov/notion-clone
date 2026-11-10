// File uploads for "files" properties: the browser asks for an upload URL, POSTs the file
// there, then calls fileImport.finishUpload (stores the record and a thumbnail) to get a
// permanent URL to store in the property. Agents import files with convex/fileImport.js.
import { v } from 'convex/values';
import { mutation, internalQuery, internalMutation } from './_generated/server';
import { fail, requireUser, requireMember } from './lib/util.js';

const MAX_BYTES = 20 * 1024 * 1024;

export const uploadUrl = mutation({
  args: { session: v.string(), workspaceId: v.id('workspaces') },
  handler: async (ctx, { session, workspaceId }) => {
    const user = await requireUser(ctx, session);
    await requireMember(ctx, workspaceId, user._id);
    return ctx.storage.generateUploadUrl();
  },
});

/** Older clients: register an upload without a thumbnail. */
export const register = mutation({
  args: { session: v.string(), workspaceId: v.id('workspaces'), storageId: v.id('_storage'), name: v.string() },
  handler: async (ctx, { session, workspaceId, storageId, name }) => {
    const user = await requireUser(ctx, session);
    await requireMember(ctx, workspaceId, user._id);
    const meta = await ctx.db.system.get(storageId);
    if (!meta) fail(404, 'Upload not found');
    if (meta.size > MAX_BYTES) {
      await ctx.storage.delete(storageId);
      fail(400, 'Files are limited to 20 MB');
    }
    return { name: String(name || 'file').slice(0, 200), url: await ctx.storage.getUrl(storageId), storageId, size: meta.size, contentType: meta.contentType || null };
  },
});

export const checkUpload = internalQuery({
  args: { session: v.string(), workspaceId: v.id('workspaces'), storageId: v.id('_storage') },
  handler: async (ctx, { session, workspaceId, storageId }) => {
    const user = await requireUser(ctx, session);
    await requireMember(ctx, workspaceId, user._id);
    const meta = await ctx.db.system.get(storageId);
    if (!meta) fail(404, 'Upload not found');
    // an upload already recorded for another workspace can't be claimed
    const known = await ctx.db
      .query('files')
      .withIndex('by_storage', (q) => q.eq('storageId', storageId))
      .first();
    if (known && known.workspaceId !== workspaceId) fail(404, 'Upload not found');
    return { size: meta.size, contentType: meta.contentType || null };
  },
});

async function fileOut(ctx, f) {
  return {
    name: f.name,
    url: await ctx.storage.getUrl(f.storageId),
    thumbnail: f.thumbId ? await ctx.storage.getUrl(f.thumbId) : null,
    storageId: f.storageId,
    size: f.size,
    contentType: f.contentType,
    ...(f.width ? { width: f.width, height: f.height } : {}),
  };
}

export const byKey = internalQuery({
  args: { workspaceId: v.id('workspaces'), key: v.string() },
  handler: async (ctx, { workspaceId, key }) => {
    const f = await ctx.db
      .query('files')
      .withIndex('by_key', (q) => q.eq('workspaceId', workspaceId).eq('key', key))
      .first();
    return f ? fileOut(ctx, f) : null;
  },
});

export const byHash = internalQuery({
  args: { workspaceId: v.id('workspaces'), sha256: v.string() },
  handler: async (ctx, { workspaceId, sha256 }) => {
    const f = await ctx.db
      .query('files')
      .withIndex('by_hash', (q) => q.eq('workspaceId', workspaceId).eq('sha256', sha256))
      .first();
    return f ? { id: f._id, key: f.key, storageId: f.storageId, out: await fileOut(ctx, f) } : null;
  },
});

export const setKey = internalMutation({
  args: { id: v.id('files'), key: v.string() },
  handler: async (ctx, { id, key }) => {
    await ctx.db.patch(id, { key });
  },
});

export const insert = internalMutation({
  args: {
    workspaceId: v.id('workspaces'),
    storageId: v.id('_storage'),
    thumbId: v.union(v.id('_storage'), v.null()),
    sha256: v.string(),
    key: v.union(v.string(), v.null()),
    name: v.string(),
    size: v.number(),
    contentType: v.union(v.string(), v.null()),
    width: v.union(v.number(), v.null()),
    height: v.union(v.number(), v.null()),
    sourceUrl: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const id = await ctx.db.insert('files', { ...args, createdAt: Date.now() });
    return fileOut(ctx, await ctx.db.get(id));
  },
});
