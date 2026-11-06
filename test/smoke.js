// End-to-end test against the local Convex dev deployment (`npx convex dev`).
// It WIPES that deployment first, so it refuses to run unless ALLOW_TEST_RESET=true is set there:
//   npx convex env set ALLOW_TEST_RESET true
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ConvexHttpClient } from 'convex/browser';
import { anyApi as api } from 'convex/server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(
  fs
    .readFileSync(path.join(root, '.env.local'), 'utf8')
    .split(/\r?\n/)
    .map((l) => l.match(/^([A-Z_]+)=(.*)$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2]]),
);
const URL_ = env.CONVEX_URL;
const SITE = env.CONVEX_SITE_URL;
const cli = (...args) => execFileSync(process.execPath, [path.join(root, 'node_modules', 'convex', 'bin', 'main.js'), ...args], { cwd: root, encoding: 'utf8' });
const step = (s) => console.log('✓', s);
const txt = (r) => r.content.map((c) => c.text).join('\n');
const idOf = (s) => s.match(/id: (\w+)/)[1];
const errOf = async (p) => {
  try {
    await p;
  } catch (e) {
    return e.data || { message: e.message };
  }
  throw new Error('expected an error');
};

cli('run', 'testing:reset');
const c = new ConvexHttpClient(URL_);
const call = (client, name, args) => client.callTool({ name, arguments: args });

// ---------- import + first user ----------
assert.deepEqual(await c.query(api.auth.status, {}), { hasUsers: false, openSignup: true });
const legacy = JSON.parse(cli('run', 'workspaces:importWorkspace', JSON.stringify({ name: 'Old', pages: { a1: { id: 'a1', title: 'Imported', icon: '', parentId: null, position: 0, blocks: [], favorite: false, archivedAt: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', version: 1 }, b2: { id: 'b2', title: 'Child', icon: '', parentId: 'a1', position: 0, blocks: [], favorite: false, archivedAt: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', version: 1 } } })));
assert.equal((await errOf(c.action(api.authNode.signUp, { name: 'A', email: 'a@example.com', password: 'short' }))).status, 400);
const alice = await c.action(api.authNode.signUp, { name: 'Alice', email: 'Alice@Example.com', password: 'correct horse' });
const me = await c.query(api.auth.me, { session: alice.session });
assert.equal(me.workspaces.length, 1);
const ws = me.workspaces[0];
assert.equal(ws.id, legacy);
assert.equal(ws.role, 'owner');
assert.equal(ws.name, "Alice's Workspace");
const A = { session: alice.session, workspaceId: ws.id };
const tree = await c.query(api.pages.tree, A);
assert.equal(tree[0].title, 'Imported');
const imported = await c.query(api.pages.get, { ...A, pageId: 'a1' });
assert.equal(imported.blocks.find((b) => b.type === 'page').pageId, 'b2');
step('import: first sign-up owns the imported workspace; sub-pages get page blocks');

assert.equal((await errOf(c.action(api.authNode.signUp, { name: 'M', email: 'm@example.com', password: 'password123' }))).status, 403);
assert.equal((await errOf(c.query(api.pages.tree, { session: 'nope', workspaceId: ws.id }))).status, 401);
assert.equal((await errOf(c.action(api.authNode.logIn, { email: 'alice@example.com', password: 'wrong' }))).status, 401);
const again = await c.action(api.authNode.logIn, { email: 'alice@example.com', password: 'correct horse' });
assert.ok(again.session);
step('invite-only sign-up, sessions required, log-in works');

// ---------- agent token + MCP over HTTP ----------
const { token } = await c.action(api.workspaces.createAgentToken, { ...A, name: 'Test' });
const mcp = new Client({ name: 'smoke', version: '1' });
await mcp.connect(new StreamableHTTPClientTransport(new URL(`${SITE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
let r = await call(mcp, 'create_page', { title: 'Roadmap', icon: '🗺️', content: '# Q1\n\n- Ship MVP\n- Design system\n\nEnd' });
const roadmap = idOf(txt(r));
r = await call(mcp, 'get_page', { page_id: roadmap, format: 'blocks' });
const mvpBlock = txt(r).match(/\[(\w+)\] \(bulleted_list\) - Ship MVP/)[1];
const headingBlock = txt(r).match(/\[(\w+)\] \(heading_1\)/)[1];
r = await call(mcp, 'convert_block_to_page', { page_id: roadmap, block_id: mvpBlock });
const mvpPage = idOf(txt(r));
r = await call(mcp, 'create_page', { title: 'Notes', parent_id: roadmap, after_block_id: headingBlock });
const notes = idOf(txt(r));
r = await call(mcp, 'get_page', { page_id: roadmap });
assert.match(txt(r), /# Q1\n\n\[Notes\]\(page:\w+\)\n\n\[Ship MVP\]\(page:\w+\)\n\n- Design system\n\nEnd/);
r = await call(mcp, 'update_page', { page_id: notes, parent_id: mvpPage });
r = await call(mcp, 'get_page', { page_id: mvpPage, format: 'blocks' });
const notesBlock = txt(r).match(/\[(\w+)\] \(page\)/)[1];
r = await call(mcp, 'delete_blocks', { page_id: mvpPage, block_ids: [notesBlock] });
assert.match(txt(r), /Moved 1 sub-page/);
r = await call(mcp, 'get_page', { page_id: 'missing' });
assert.equal(r.isError, true);
const info = await c.query(api.workspaces.info, A);
assert.ok(info.agent.lastAt && info.agent.lastTool);
const page = await c.query(api.pages.get, { ...A, pageId: roadmap });
assert.equal(page.lastEditedBy, 'agent');
await mcp.close();
step('MCP over HTTP: page blocks, convert, move, trash; agent activity recorded');

const bad = await fetch(`${SITE}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer nca_wrong' }, body: '{}' });
assert.equal(bad.status, 401);
step('MCP rejects bad tokens');

// ---------- stdio bridge ----------
const stdio = new Client({ name: 'smoke-stdio', version: '1' });
await stdio.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'src', 'mcp-stdio.js')], env: { ...process.env, NOTION_URL: SITE, NOTION_TOKEN: token }, stderr: 'ignore' }));
r = await call(stdio, 'search_pages', { query: 'Roadmap' });
assert.match(txt(r), /Roadmap/);
await stdio.close();
step('stdio bridge talks to Convex');

// ---------- invites & members ----------
const inv = await c.action(api.workspaces.createInvite, { ...A, email: 'bob@example.com' });
const infoInv = await c.query(api.workspaces.inviteInfo, { token: inv.token });
assert.equal(infoInv.invitedBy, 'Alice');
assert.equal((await errOf(c.action(api.authNode.signUp, { name: 'M', email: 'm@example.com', password: 'password123', inviteToken: inv.token }))).status, 403);
const bob = await c.action(api.authNode.signUp, { name: 'Bob', email: 'bob@example.com', password: 'password123', inviteToken: inv.token });
const bobMe = await c.query(api.auth.me, { session: bob.session });
assert.deepEqual(
  bobMe.workspaces.map((w) => [w.id, w.role]),
  [[ws.id, 'member']],
);
assert.equal((await c.query(api.workspaces.inviteInfo, { token: inv.token })).valid, false);
const B = { session: bob.session, workspaceId: ws.id };
const bobPage = await c.mutation(api.pages.run, { ...B, method: 'createPage', args: { title: 'Bob page' } });
assert.equal(bobPage.createdBy, 'Bob');
assert.equal((await errOf(c.action(api.workspaces.createInvite, B))).status, 403);
const members = await c.query(api.workspaces.members, A);
assert.deepEqual(members.members.map((m) => m.name).sort(), ['Alice', 'Bob']);
step('email-bound invite, single use; members edit; only the owner invites');

// ---------- editor save path ----------
const p = await c.query(api.pages.get, { ...A, pageId: roadmap });
const without = p.blocks.filter((b) => !(b.type === 'page' && b.pageId === mvpPage));
r = await c.mutation(api.pages.run, { ...A, method: 'savePage', args: { pageId: roadmap, blocks: without, baseVersion: p.version } });
assert.deepEqual(r.archived, [mvpPage]);
const conflict = await errOf(c.mutation(api.pages.run, { ...A, method: 'savePage', args: { pageId: roadmap, blocks: [], baseVersion: 1 } }));
assert.equal(conflict.status, 409);
assert.ok(conflict.page.blocks.length > 0);
step('editor: removing a page block trashes it; stale saves get 409 with the fresh page');

// ---------- presence + removal ----------
await c.mutation(api.presence.heartbeat, { ...B, clientId: 'bob-tab', pageId: roadmap });
const pres = await c.query(api.presence.list, A);
assert.equal(pres[0].name, 'Bob');
await c.mutation(api.workspaces.removeMember, { ...A, userId: bobMe.user.id });
assert.equal((await errOf(c.query(api.pages.tree, B))).status, 403);
step('presence; owner removes a member');

console.log('\nALL SMOKE TESTS PASSED');
