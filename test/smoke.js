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
const idOf = (s) => JSON.parse(s).id;
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
assert.equal(r.structuredContent.archivedPages.length, 1);
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

// ---------- databases over MCP ----------
{
  const db = new Client({ name: 'smoke-db', version: '1' });
  await db.connect(new StreamableHTTPClientTransport(new URL(`${SITE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const J = async (name, args) => {
    const r = await call(db, name, args);
    if (r.isError) throw new Error(`${name}: ${txt(r)}`);
    assert.ok(r.structuredContent, `${name} returns structuredContent`);
    return r.structuredContent;
  };
  const ctx = await J('get_context', {});
  assert.equal(ctx.user.name, 'Alice');
  assert.ok(ctx.members.some((m) => m.email === 'alice@example.com'));

  const tree = await J('create_pages', { pages: [{ key: 'p', title: 'Big Pie Club', icon: '🍕' }, { key: 's1', parent_key: 'p', title: 'Licences' }, { parent_key: 'nope', title: 'Bad' }] });
  assert.equal(tree.created, 2);
  assert.equal(tree.failed, 1);
  const project = tree.results[0].id;

  const created = await J('create_database', {
    title: 'Launch tasks',
    parent_id: project,
    icon: '✅',
    properties: [
      { name: 'Status', type: 'status', options: ['Not Started', 'In Progress', 'Blocked', 'Done'] },
      { name: 'Priority', type: 'select', options: ['Low', 'Medium', 'High', 'Critical'] },
      { name: 'Assignee', type: 'person' },
      { name: 'Due', type: 'date' },
      { name: 'Hours', type: 'number' },
      { name: 'Stage', type: 'select' },
    ],
    views: [{ name: 'Board', type: 'board', group_by: 'Status' }],
  });
  const DB = created.id;
  assert.deepEqual(created.views.map((v) => v.name), ['All', 'Board']);
  assert.ok(created.url === null || created.url.includes(`#/${DB}`));

  const items = Array.from({ length: 187 }, (_, i) => ({
    properties: { Name: `Task ${i + 1}`, Status: ['Not Started', 'In Progress', 'Done'][i % 3], Priority: i % 10 ? 'High' : 'Critical', Assignee: i % 2 ? 'me' : 'alice@example.com', Due: `+${i % 40}d`, Hours: i % 8, Stage: `Stage ${(i % 14) + 1}` },
    ...(i === 0 ? { content: '## Notes\n\nCall the city.' } : {}),
  }));
  const batch = await J('create_database_items', { database_id: DB, items, idempotency_key: 'big-pie-v1' });
  assert.equal(batch.created, 187);
  const again = await J('create_database_items', { database_id: DB, items, idempotency_key: 'big-pie-v1' });
  assert.equal(again.replayed, true);
  assert.equal((await J('get_database', { database_id: DB })).rowCount, 187);
  assert.equal((await J('get_database', { database_id: DB })).properties.find((p) => p.name === 'Stage').options.length, 14);
  const bad = await J('create_database_items', { database_id: DB, items: [{ properties: { Name: 'x', Assignee: 'Nobody' } }, { properties: { Name: 'ok' } }] });
  assert.equal(bad.failed, 1);
  assert.match(bad.results[0].error, /not a member/);

  const q = await J('query_database', {
    database_id: DB,
    filters: [{ property: 'Priority', operator: 'equals', value: 'Critical' }, { property: 'Status', operator: 'not_equals', value: 'Done' }],
    sorts: [{ property: 'Due', direction: 'ascending' }],
    limit: 5,
  });
  assert.ok(q.total > 5 && q.items.length === 5 && q.hasMore && q.nextCursor === '5');
  assert.ok(q.items.every((it) => it.properties.Priority === 'Critical' && it.properties.Status !== 'Done'));
  const page2 = await J('query_database', { database_id: DB, filters: [{ property: 'Priority', operator: 'equals', value: 'Critical' }, { property: 'Status', operator: 'not_equals', value: 'Done' }], limit: 5, cursor: '5' });
  assert.ok(page2.items.length > 0);

  const upd = await J('update_database_items', { updates: q.items.map((it) => ({ item_id: it.id, properties: { Status: 'Done' } })) });
  assert.equal(upd.updated, 5);
  assert.equal((await J('query_database', { database_id: DB, filters: [{ property: 'Priority', operator: 'equals', value: 'Critical' }, { property: 'Status', operator: 'not_equals', value: 'Done' }] })).total, q.total - 5);

  const view = await J('save_database_view', { database_id: DB, name: 'My critical', filters: [{ property: 'Assignee', operator: 'contains', value: 'me' }, { property: 'Priority', operator: 'equals', value: 'Critical' }], sorts: [{ property: 'Due' }] });
  assert.equal(view.view.name, 'My critical');
  const viaView = await J('query_database', { database_id: DB, view: 'My critical' });
  assert.ok(viaView.items.every((it) => it.properties.Priority === 'Critical'));

  await J('update_database', { database_id: DB, update_properties: [{ property: 'Status', name: 'State', rename_options: { Done: 'Complete' } }] });
  const afterRename = await J('query_database', { database_id: DB, view: 'Board', limit: 1, filters: [{ property: 'State', operator: 'equals', value: 'Complete' }] });
  assert.ok(afterRename.total > 0);

  const first = (await J('query_database', { database_id: DB, search: 'Task 1', limit: 1, sorts: [{ property: 'Name' }] })).items[0];
  const row = await J('get_page', { page_id: first.id });
  assert.equal(row.kind, 'row');
  assert.equal(row.database.id, DB);
  assert.ok(row.properties.State);

  const list = await J('list_pages', { parent_id: project });
  assert.ok(list.pages.some((n) => n.id === DB && n.kind === 'database' && !n.children));

  const proj = await J('get_page', { page_id: project });
  await J('replace_page_content', { page_id: project, content: 'Hello', expected_version: proj.version });
  const stale = await call(db, 'replace_page_content', { page_id: project, content: 'Overwrite', expected_version: proj.version });
  assert.equal(stale.isError, true);
  assert.match(txt(stale), /Version conflict/);
  await db.close();

  // the browser's view of the same database
  const rows = await c.query(api.pages.rows, { ...A, pageId: DB });
  assert.equal(rows.rows.length, 188);
  assert.ok(rows.database.views.length === 3 && rows.members.length >= 1);
}
step('databases: 187 items in one call, idempotent retry, filters/sorts/pagination, bulk update, views, renames, version conflicts');

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

// ---------- OAuth (ChatGPT / claude.ai connectors) ----------
const noAuth = await fetch(`${SITE}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
assert.equal(noAuth.status, 401);
const prmUrl = noAuth.headers.get('www-authenticate').match(/resource_metadata="([^"]+)"/)[1];
const prm = await (await fetch(prmUrl)).json();
assert.equal(prm.resource, `${SITE}/mcp`);
const asMeta = await (await fetch(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json();
assert.deepEqual(asMeta.code_challenge_methods_supported, ['S256']);
const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
assert.equal((await fetch(asMeta.registration_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['http://evil.example/cb'] }) })).status, 400);
const reg = await (await fetch(asMeta.registration_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'ChatGPT', redirect_uris: [REDIRECT] }) })).json();
const { createHash, randomBytes } = await import('node:crypto');
const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const authz = new URL(asMeta.authorization_endpoint);
Object.entries({ response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', scope: 'pages' }).forEach(([k, v]) => authz.searchParams.set(k, v));
const toConsent = await fetch(authz, { redirect: 'manual' });
assert.equal(toConsent.status, 302);
const consent = new URL(toConsent.headers.get('location'));
assert.match(consent.hash, /^#\/oauth\?/);
const cp = new URLSearchParams(consent.hash.slice('#/oauth?'.length));
const badRedirect = new URL(authz);
badRedirect.searchParams.set('redirect_uri', 'https://evil.example/cb');
assert.equal((await fetch(badRedirect, { redirect: 'manual' })).status, 400);
assert.equal((await c.query(api.oauth.clientInfo, { clientId: reg.client_id, redirectUri: REDIRECT })).name, 'ChatGPT');
const approve = (codeChallenge) =>
  c.action(api.oauth.approve, { session: alice.session, workspaceId: ws.id, clientId: cp.get('client_id'), redirectUri: cp.get('redirect_uri'), codeChallenge, state: cp.get('state'), scope: cp.get('scope') });
const back = new URL((await approve(cp.get('code_challenge'))).redirect);
assert.equal(back.origin + back.pathname, REDIRECT);
assert.equal(back.searchParams.get('state'), 'xyz');
const exchange = (code, code_verifier) =>
  fetch(asMeta.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier, client_id: reg.client_id, redirect_uri: REDIRECT }) });
const wrongVerifier = await exchange(new URL((await approve(cp.get('code_challenge'))).redirect).searchParams.get('code'), randomBytes(32).toString('base64url'));
assert.equal((await wrongVerifier.json()).error, 'invalid_grant');
const tok = await exchange(back.searchParams.get('code'), verifier);
assert.equal(tok.status, 200);
const { access_token } = await tok.json();
assert.equal((await (await exchange(back.searchParams.get('code'), verifier)).json()).error, 'invalid_grant'); // single use
const oc = new Client({ name: 'oauth', version: '1' });
await oc.connect(new StreamableHTTPClientTransport(new URL(`${SITE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${access_token}` } } }));
assert.match(txt(await call(oc, 'search_pages', { query: 'Roadmap' })), /Roadmap/);
await oc.close();
assert.ok((await c.query(api.workspaces.agentTokens, A)).some((t) => t.name === 'ChatGPT (connected)'));
step('OAuth: discovery, registration, consent redirect, PKCE, single-use codes, token works with MCP');

// ---------- presence + removal ----------
await c.mutation(api.presence.heartbeat, { ...B, clientId: 'bob-tab', pageId: roadmap });
const pres = await c.query(api.presence.list, A);
assert.equal(pres[0].name, 'Bob');
await c.mutation(api.workspaces.removeMember, { ...A, userId: bobMe.user.id });
assert.equal((await errOf(c.query(api.pages.tree, B))).status, 403);
step('presence; owner removes a member');

console.log('\nALL SMOKE TESTS PASSED');
