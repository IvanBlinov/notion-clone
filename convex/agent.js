import { v } from 'convex/values';
import { internalMutation, internalQuery } from './_generated/server';
import { fail, loadWorkspace, membership, runModel, workspaceMembers } from './lib/util.js';
import { sha256 } from './lib/sha256.js';

// Agents may read and edit, but never permanently delete.
const AGENT_METHODS = new Set([
  'listTree',
  'listTrash',
  'getPage',
  'getPageMarkdown',
  'search',
  'createPage',
  'updatePage',
  'duplicatePage',
  'archivePage',
  'restorePage',
  'setContent',
  'appendContent',
  'updateBlock',
  'deleteBlocks',
  'moveBlock',
  'blockToPage',
  'createPages',
  'createDatabase',
  'getDatabase',
  'updateDatabase',
  'createRows',
  'updateRows',
  'archiveRows',
  'queryDatabase',
  'saveView',
  'createLinkedView',
  'updateLinkedView',
]);

async function tokenRecord(ctx, token) {
  if (!token) return null;
  const t = await ctx.db
    .query('agentTokens')
    .withIndex('by_tokenHash', (q) => q.eq('tokenHash', sha256(token)))
    .unique();
  if (!t || !(await membership(ctx, t.workspaceId, t.userId))) return null;
  return t;
}

/** Is this a valid agent token? (checked before starting an MCP request) */
export const check = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, { token }) => !!(await tokenRecord(ctx, token)),
});

/** Run one page-model method on behalf of an agent token. */
export const call = internalMutation({
  args: { token: v.string(), method: v.string(), args: v.any(), tool: v.optional(v.string()) },
  handler: async (ctx, { token, method, args, tool }) => {
    const t = await tokenRecord(ctx, token);
    if (!t) fail(401, 'Invalid or revoked agent token');
    const user = await ctx.db.get(t.userId);
    if (method === 'getContext') {
      await ctx.db.patch(t._id, { lastUsedAt: Date.now() });
      const ws = await ctx.db.get(t.workspaceId);
      const members = await workspaceMembers(ctx, t.workspaceId);
      const role = members.find((m) => m.id === user._id)?.role || 'member';
      return {
        user: { id: user._id, name: user.name, email: user.email, role },
        workspace: { id: ws._id, name: ws.name },
        members: members.map(({ id, name, email, role: r }) => ({ id, name, email, role: r })),
        permissions: { read: true, write: true, archive: true, delete_permanently: false, invite: false },
        token: t.name,
        webUrl: process.env.WEB_URL || null,
      };
    }
    if (!AGENT_METHODS.has(method)) fail(400, `Unknown method ${method}`);
    const { model, commit } = await loadWorkspace(ctx, t.workspaceId);
    const result = runModel(() => model[method](args || {}, { client: 'agent', kind: 'agent', name: `${user.name}'s agent`, userId: user._id }));
    await commit();
    await ctx.db.patch(t._id, { lastUsedAt: Date.now() });
    await ctx.db.patch(t.workspaceId, { lastAgentAt: Date.now(), ...(tool ? { lastAgentTool: tool } : {}) });
    return result ?? null;
  },
});
