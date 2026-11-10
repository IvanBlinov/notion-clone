import { v } from 'convex/values';
import { internalMutation, internalQuery } from './_generated/server';
import { fail, loadWorkspace, membership, runModel, workspaceMembers, agentMemberId } from './lib/util.js';
import { sha256 } from './lib/sha256.js';
import { listComments, addComment, resolveComment } from './comments.js';
import { listHooks, createHook, deleteHook } from './webhooks.js';

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
  'upsertRows',
  'archiveRows',
  'queryDatabase',
  'saveView',
  'saveTemplate',
  'createLinkedView',
  'updateLinkedView',
  'listChanges',
]);
const READ_ONLY = new Set(['listTree', 'listTrash', 'getPage', 'getPageMarkdown', 'search', 'getDatabase', 'queryDatabase', 'listChanges']);

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

/** Run one page-model method (or comment / webhook call) on behalf of an agent token. */
export const call = internalMutation({
  args: { token: v.string(), method: v.string(), args: v.any(), tool: v.optional(v.string()) },
  handler: async (ctx, { token, method, args, tool }) => {
    const t = await tokenRecord(ctx, token);
    if (!t) fail(401, 'Invalid or revoked agent token');
    const user = await ctx.db.get(t.userId);
    const agent = { id: agentMemberId(t._id), name: t.name, kind: 'agent' };
    const a = args || {};
    const done = async (result) => {
      await ctx.db.patch(t._id, { lastUsedAt: Date.now() });
      if (!READ_ONLY.has(method) && !['getContext', 'listComments', 'listWebhooks'].includes(method)) await ctx.db.patch(t.workspaceId, { lastAgentAt: Date.now(), ...(tool ? { lastAgentTool: tool } : {}) });
      return result ?? null;
    };
    switch (method) {
      case 'getContext': {
        const ws = await ctx.db.get(t.workspaceId);
        const members = await workspaceMembers(ctx, t.workspaceId);
        const role = members.find((m) => m.id === user._id)?.role || 'member';
        return done({
          user: { id: user._id, name: user.name, email: user.email, role },
          agent: { id: agent.id, name: agent.name, hint: 'Assign work to yourself with this id or "@agent" in person properties' },
          workspace: { id: ws._id, name: ws.name },
          members: members.map(({ id, name, email, role: r, kind }) => ({ id, name, ...(email ? { email } : {}), role: r, ...(kind ? { kind } : {}) })),
          permissions: { read: true, write: true, archive: true, delete_permanently: false, invite: false, comment: true, webhooks: true },
          token: t.name,
          webUrl: process.env.WEB_URL || null,
        });
      }
      case 'listComments':
        return done(await listComments(ctx, t.workspaceId, a));
      case 'addComment':
        return done(await addComment(ctx, t.workspaceId, agent, a));
      case 'resolveComment':
        return done(await resolveComment(ctx, t.workspaceId, agent, a));
      case 'listWebhooks':
        return done(await listHooks(ctx, t.workspaceId));
      case 'createWebhook':
        if (!/^whsec_[0-9a-f]{48}$/.test(String(a.secret || ''))) fail(400, 'Missing webhook secret');
        return done(await createHook(ctx, t.workspaceId, a, agent.name));
      case 'deleteWebhook':
        return done(await deleteHook(ctx, t.workspaceId, a.webhookId));
    }
    if (!AGENT_METHODS.has(method)) fail(400, `Unknown method ${method}`);
    const { model, commit } = await loadWorkspace(ctx, t.workspaceId);
    const result = runModel(() => model[method](a, { client: 'agent', kind: 'agent', name: agent.name, userId: user._id, agentId: agent.id }));
    await commit({ actor: agent.name });
    return done(result);
  },
});
