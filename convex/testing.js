import { internalMutation } from './_generated/server';

/** Wipe all data — only for the local test deployment (requires ALLOW_TEST_RESET=true). */
export const reset = internalMutation({
  args: {},
  handler: async (ctx) => {
    if (process.env.ALLOW_TEST_RESET !== 'true') throw new Error('Reset is disabled on this deployment');
    for (const table of ['users', 'sessions', 'workspaces', 'members', 'invites', 'agentTokens', 'pages', 'presence']) {
      for (const row of await ctx.db.query(table).collect()) await ctx.db.delete(row._id);
    }
  },
});
