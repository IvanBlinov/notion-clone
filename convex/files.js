// File uploads for "files" properties: the browser asks for an upload URL, POSTs the file
// there, then registers the storage id to get a permanent URL to store in the property.
import { v } from 'convex/values';
import { mutation } from './_generated/server';
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
