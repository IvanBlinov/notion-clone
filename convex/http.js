import { httpRouter } from 'convex/server';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { httpAction } from './_generated/server';
import { internal } from './_generated/api';
import { createMcpServer } from '../src/tools.js';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const bearer = (req) => {
  const h = req.headers.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
};
const unwrap = (err) => {
  throw new Error(err?.data?.message || err?.message || 'Request failed');
};

/** The page API as seen by one agent token. */
function agentApi(ctx, token) {
  let tool;
  return {
    call: (method, args) => ctx.runMutation(internal.agent.call, { token, method, args: args || {}, tool }).catch(unwrap),
    onTool: (name) => {
      tool = name;
    },
  };
}

const http = httpRouter();

// MCP over Streamable HTTP (stateless). Auth: "Authorization: Bearer <agent token>".
http.route({
  path: '/mcp',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const token = bearer(request);
    if (!token || !(await ctx.runQuery(internal.agent.check, { token }))) {
      return json(401, {
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unauthorized: send "Authorization: Bearer <agent token>" (create one in Settings & members → AI agent)' },
        id: null,
      });
    }
    const server = createMcpServer(agentApi(ctx, token));
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(request);
    } finally {
      await server.close();
    }
  }),
});
for (const method of ['GET', 'DELETE']) {
  http.route({ path: '/mcp', method, handler: httpAction(async () => json(405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null })) });
}

// Plain JSON endpoint for the local stdio bridge (src/mcp-stdio.js).
http.route({
  path: '/agent/rpc',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const token = bearer(request);
    if (!token) return json(401, { error: 'Agent token required' });
    const { method, args, tool } = await request.json().catch(() => ({}));
    try {
      const result = await ctx.runMutation(internal.agent.call, { token, method: String(method || ''), args: args || {}, tool });
      return json(200, { result });
    } catch (err) {
      return json(err?.data?.status || 500, { error: err?.data?.message || err.message });
    }
  }),
});

export default http;
