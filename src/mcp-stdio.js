#!/usr/bin/env node
// MCP over stdio — for agents that launch a local command (Claude Desktop, Claude Code, Cursor, ...).
// It forwards tool calls to the Convex deployment, so edits appear live for everyone.
//   NOTION_TOKEN  agent token from Settings & members → AI agent (required; picks the workspace)
//   NOTION_URL    the deployment's HTTP actions URL, e.g. https://<name>.convex.site
// IMPORTANT: stdout is reserved for the MCP protocol — log to stderr only.
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer, httpApi } from './tools.js';

const url = (process.env.NOTION_URL || '').replace(/\/$/, '');
const token = process.env.NOTION_TOKEN || '';
if (!url || !token) {
  console.error('[notion-mcp] Set NOTION_URL (https://<deployment>.convex.site) and NOTION_TOKEN (Settings & members → AI agent).');
  process.exit(1);
}
const server = createMcpServer(httpApi(url, token));
await server.connect(new StdioServerTransport());
console.error('[notion-mcp] ready →', url);
