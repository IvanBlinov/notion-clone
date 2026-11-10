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
try { cli('env', 'remove', 'SIGNUP'); } catch {}
assert.deepEqual(await c.query(api.auth.status, {}), { hasUsers: false, openSignup: true, inviteSignup: false });
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

  // linked view of the database inside the stage page
  const stagePage = tree.results[1].id;
  const lv = await J('create_linked_database_view', { parent_page_id: stagePage, database_id: DB, name: 'Stage 1 tasks', filters: [{ property: 'Stage', operator: 'equals', value: 'Stage 1' }], sorts: [{ property: 'Due' }] });
  assert.equal(lv.name, 'Stage 1 tasks');
  const badLv = await call(db, 'create_linked_database_view', { parent_page_id: stagePage, database_id: DB, filters: [{ property: 'Nope', value: 1 }] });
  assert.equal(badLv.isError, true);
  let sp = await J('get_page', { page_id: stagePage });
  assert.equal(sp.linkedViews.length, 1);
  assert.match(sp.content, new RegExp(`\\[Stage 1 tasks\\]\\(database_view:${lv.blockId}\\)`));
  await J('replace_page_content', { page_id: stagePage, content: `# Intro\n\n${sp.content}`, expected_version: sp.version });
  sp = await J('get_page', { page_id: stagePage });
  assert.equal(sp.linkedViews[0].blockId, lv.blockId);
  assert.equal(sp.linkedViews[0].filters[0].value, 'Stage 1');
  const lvu = await J('update_linked_database_view', { page_id: stagePage, block_id: lv.blockId, view_type: 'board', group_by: 'State' });
  assert.equal(lvu.type, 'board');
  assert.equal(lvu.groupBy, 'State');

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

// ---------- the tracker features: relations, rollups, formulas, upsert, @this_page, files, comments… ----------
{
  const m = new Client({ name: 'smoke-tracker', version: '1' });
  await m.connect(new StreamableHTTPClientTransport(new URL(`${SITE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  const J = async (name, args) => {
    const r = await call(m, name, args);
    if (r.isError) throw new Error(`${name}: ${txt(r)}`);
    return r.structuredContent;
  };
  const fails = async (name, args, re) => {
    const r = await call(m, name, args);
    assert.equal(r.isError, true, `${name} should fail`);
    if (re) assert.match(txt(r), re);
  };
  const ctx = await J('get_context', {});
  assert.ok(ctx.agent.id.startsWith('agent_'));
  assert.ok(ctx.members.some((x) => x.id === ctx.agent.id && x.kind === 'agent')); // 15. the agent is assignable

  const hub = (await J('create_page', { title: 'Tracker' })).id;
  const epics = await J('create_database', { title: 'Epics', parent_id: hub, properties: [{ name: 'ID', type: 'unique_id', prefix: 'E' }] });
  const tasks = await J('create_database', {
    title: 'Tasks',
    parent_id: hub,
    sub_items: true,
    dependencies: true,
    properties: [
      { name: 'Status', type: 'status', options: ['Not started', 'In progress', { name: 'Waiting on owner', group: 'in_progress' }, 'Done'] },
      { name: 'Epic', type: 'relation', database_id: epics.id, two_way: true, reverse_name: 'Subtasks' },
      { name: 'Owner', type: 'person' },
      { name: 'Run', type: 'date' },
      { name: 'Credits', type: 'number' },
      { name: 'Links', type: 'links' },
      { name: 'Looks', type: 'files' },
      { name: 'Key', type: 'text' },
    ],
    views: [
      { name: 'Calendar', type: 'calendar', date_property: 'Run' },
      { name: 'Timeline', type: 'timeline', date_property: 'Run' },
      { name: 'Gallery', type: 'gallery', cover_property: 'Looks', card_size: 'large' },
      { name: 'List', type: 'list' },
    ],
  });
  assert.ok(['Sub-items', 'Parent item', 'Blocked by', 'Blocking'].every((n) => tasks.properties.some((p) => p.name === n))); // 9
  assert.equal((await J('get_database', { database_id: epics.id })).properties.find((p) => p.name === 'Subtasks').type, 'relation'); // 1. two-way
  assert.deepEqual(tasks.views.map((v) => v.type), ['table', 'calendar', 'timeline', 'gallery', 'list']); // 8
  const status = tasks.properties.find((p) => p.name === 'Status');
  assert.equal(status.options.find((o) => o.name === 'Waiting on owner').group, 'in_progress'); // 11

  const e = await J('create_database_items', { database_id: epics.id, items: [{ properties: { Name: 'Launch scope' } }, { properties: { Name: 'TestFlight' } }] });
  const [e1, e2] = e.results.map((x) => x.id);
  await J('update_database', {
    database_id: epics.id,
    add_properties: [
      { name: 'Progress', type: 'rollup', relation: 'Subtasks', property: 'Status', function: 'percent_where', value: '@complete', display: 'bar' },
      { name: 'Credits', type: 'rollup', relation: 'Subtasks', property: 'Credits', function: 'sum' },
      { name: 'Label', type: 'formula', expression: 'concat(prop("ID"), ": ", format(round(prop("Progress") * 100)), "%")' },
    ],
  });
  await fails('update_database', { database_id: epics.id, add_properties: [{ name: 'Bad', type: 'formula', expression: 'prop("Nope") +' }] });

  // 3. upsert by a key: create, then update / leave unchanged without looking up ids
  const items = [
    { properties: { Key: 'GEN', Name: 'Genesis pack', Status: 'Done', Epic: 'E-1', Credits: 40, Owner: '@agent', Run: { start: '2026-11-08T00:51:17Z', end: '2026-11-08T02:58:12Z' }, Links: [{ label: 'Spec', url: 'https://example.com/spec' }, 'https://github.com/x/y'] } },
    { properties: { Key: 'EXO', Name: 'Exodus pack', Status: 'Waiting on owner', Epic: 'Launch scope', Credits: 10, Looks: [{ name: 'Moses · elder', url: 'https://example.com/moses.png' }] } },
    { properties: { Key: 'TF', Name: 'Upload build', Status: 'Not started', Epic: e2, 'Blocked by': ['Exodus pack'] } },
  ];
  let up = await J('upsert_database_items', { database_id: tasks.id, match_property: 'Key', items });
  assert.deepEqual([up.created, up.updated, up.unchanged, up.failed], [3, 0, 0, 0]);
  up = await J('upsert_database_items', { database_id: tasks.id, match_property: 'Key', items: [items[0], { properties: { Key: 'EXO', Credits: 12 } }, { properties: { Key: 'NEW', Name: 'Leviticus' } }] });
  assert.deepEqual([up.created, up.updated, up.unchanged, up.failed], [1, 1, 1, 0]);

  // 2. rollups and formulas follow the relation
  let ep = (await J('query_database', { database_id: epics.id, sorts: [{ property: 'ID' }] })).items;
  assert.equal(ep[0].properties.ID, 'E-1'); // 14
  assert.equal(ep[0].properties.Progress, 0.5);
  assert.equal(ep[0].properties.Credits, 52);
  assert.equal(ep[0].properties.Label, 'E-1: 50%');
  assert.deepEqual(ep[0].properties.Subtasks.map((s) => s.title).sort(), ['Exodus pack', 'Genesis pack']);

  // 9 + 11. dependencies and status groups
  let open = await J('query_database', { database_id: tasks.id, filters: [{ property: 'Status', operator: 'not_in_group', value: 'complete' }, { property: 'Is blocked', operator: 'equals', value: true }] });
  assert.deepEqual(open.items.map((i) => i.title), ['Upload build']);
  const exo = up.results[1].id;
  await J('update_database_items', { updates: [{ item_id: exo, properties: { Status: 'Done' } }] });
  open = await J('query_database', { database_id: tasks.id, filters: [{ property: 'Is blocked', operator: 'equals', value: true }] });
  assert.equal(open.total, 0);
  const sub = await J('create_database_items', { database_id: tasks.id, items: [{ properties: { Name: 'Fix parser' }, parent_item_id: up.results[0].id }] });
  assert.equal((await J('query_database', { database_id: tasks.id, parent_item_id: up.results[0].id })).items[0].id, sub.results[0].id);

  // 7. date-times and ranges; 10. several links; 5. files; 15. the agent as assignee
  const gen = (await J('query_database', { database_id: tasks.id, filters: [{ property: 'Key', operator: 'equals', value: 'GEN' }] })).items[0];
  assert.equal(gen.properties.Run, '2026-11-08T00:51:17Z → 2026-11-08T02:58:12Z');
  assert.equal(gen.properties.Links.length, 2);
  assert.deepEqual(gen.properties.Owner, [ctx.agent.name]);
  assert.equal((await J('query_database', { database_id: tasks.id, filters: [{ property: 'Run', operator: 'after', value: '2026-11-08T00:30:00Z' }] })).total, 1);
  await J('update_database', { database_id: tasks.id, add_properties: [{ name: 'Minutes', type: 'formula', expression: 'dateBetween(end(prop("Run")), start(prop("Run")), "minutes")' }] });
  assert.equal((await J('query_database', { database_id: tasks.id, filters: [{ property: 'Key', operator: 'equals', value: 'GEN' }] })).items[0].properties.Minutes, 126);

  // 12. aggregations
  const agg = await J('query_database', { database_id: tasks.id, aggregations: { Credits: 'sum', Status: 'percent_checked' } });
  assert.equal(agg.aggregations.Credits.value, 52);
  assert.equal(agg.aggregations.Credits.text, '52');

  // 13 + 4. a template with a linked view that filters by "@this_page"
  await J('save_database_template', {
    database_id: epics.id,
    name: 'Epic',
    is_default: true,
    content: '## Done when\n\n## Owner actions',
    linked_views: [{ database_id: tasks.id, name: 'Subtasks', filters: [{ property: 'Epic', operator: 'contains', value: '@this_page' }] }],
  });
  const e3 = (await J('create_database_items', { database_id: epics.id, items: [{ properties: { Name: 'Characters' } }] })).results[0].id;
  const e3page = await J('get_page', { page_id: e3 });
  assert.match(e3page.content, /## Done when/);
  assert.equal(e3page.linkedViews[0].filters[0].value, '@this_page');
  assert.equal(e3page.properties.ID, 'E-3');
  await J('create_database_items', { database_id: tasks.id, items: [{ properties: { Name: 'Draw Moses', Epic: e3 } }] });
  const viaThis = await J('query_database', { database_id: tasks.id, filters: e3page.linkedViews[0].filters, context_page_id: e3 });
  assert.deepEqual(viaThis.items.map((i) => i.title), ['Draw Moses']);
  await J('update_page', { page_id: e3, title: 'Characters (renamed)' }); // still matches: by id, not title
  assert.equal((await J('query_database', { database_id: tasks.id, filters: e3page.linkedViews[0].filters, context_page_id: e3 })).total, 1);
  const plain = (await J('create_database_items', { database_id: epics.id, items: [{ properties: { Name: 'No template' }, template: 'none' }] })).results[0].id;
  assert.equal((await J('get_page', { page_id: plain })).linkedViews, undefined);

  // 6. comments: agent asks, the owner answers in the app, the agent reads unresolved threads
  const q1 = await J('add_comment', { page_id: up.results[1].id, text: 'Ship Exodus with the elder look? @Alice' });
  assert.equal(q1.comment.mentions[0].name, 'Alice');
  await c.mutation(api.comments.add, { ...A, pageId: up.results[1].id, text: 'Yes, ship it', parentId: q1.comment.id });
  let threads = await J('list_comments', { unresolved_only: true });
  assert.equal(threads.threads[0].replies[0].text, 'Yes, ship it');
  assert.equal(threads.threads[0].replies[0].author.name, 'Alice');
  await J('resolve_comment', { comment_id: q1.comment.id });
  assert.equal((await J('list_comments', { unresolved_only: true })).total, 0);
  assert.equal((await c.query(api.comments.counts, A))[up.results[1].id], undefined);

  // 16. what changed + webhooks
  const since = new Date(Date.now() - 1000).toISOString();
  await c.mutation(api.pages.run, { ...A, method: 'updateRows', args: { updates: [{ itemId: up.results[2].id, properties: { Status: 'Done' } }] } });
  const ch = await J('list_changes', { since, database_id: tasks.id });
  assert.ok(ch.changes.some((x) => x.id === up.results[2].id && x.lastEditedBy === 'Alice' && x.properties.Status === 'Done'));
  await fails('create_webhook', { url: 'http://127.0.0.1:9/hook' }, /https/);
  await fails('create_webhook', { url: 'https://10.0.0.5/hook' }, /Private/);
  const hook = await J('create_webhook', { url: 'https://example.com/notion-hook', events: ['item.updated'], database_id: tasks.id });
  assert.match(hook.webhook.secret, /^whsec_[0-9a-f]{48}$/);
  await c.mutation(api.pages.run, { ...A, method: 'updateRows', args: { updates: [{ itemId: up.results[2].id, properties: { Credits: 5 } }] } });
  let delivered = null;
  for (let i = 0; i < 40 && !delivered; i++) {
    await new Promise((r) => setTimeout(r, 250));
    delivered = (await J('list_webhooks', {})).webhooks[0].lastDelivery;
  }
  assert.ok(delivered, 'the webhook was called (any HTTP result or network error counts)');
  assert.equal((await J('delete_webhook', { webhook_id: hook.webhook.id })).deleted, true);

  // the browser gets computed values and related titles
  const brow = await c.query(api.pages.rows, { ...A, pageId: epics.id });
  assert.equal(brow.rows.find((r) => r.id === e1).props[brow.database.properties.find((p) => p.name === 'Progress').id], 1);
  assert.ok(brow.related[tasks.id].rows.length >= 4);
  await m.close();
}
step('tracker features: relations, rollups, formulas, upsert, @this_page, templates, status groups, sub-items, dependencies, date-times, files/links, aggregations, comments, changes, webhooks, agent member');

// ---------- stdio bridge ----------
const stdio = new Client({ name: 'smoke-stdio', version: '1' });
await stdio.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'src', 'mcp-stdio.js')], env: { ...process.env, NOTION_URL: SITE, NOTION_TOKEN: token }, stderr: 'ignore' }));
r = await call(stdio, 'search_pages', { query: 'Roadmap' });
assert.match(txt(r), /Roadmap/);
await stdio.close();
step('stdio bridge talks to Convex');

// ---------- closed sign-up (the default once an account exists) ----------
try { cli('env', 'remove', 'SIGNUP'); } catch {}
assert.deepEqual(await c.query(api.auth.status, {}), { hasUsers: true, openSignup: false, inviteSignup: false });
const closedErr = await errOf(c.action(api.authNode.signUp, { name: 'X', email: 'alice@example.com', password: 'password123' }));
assert.equal(closedErr.status, 403); // refused before revealing that the email exists
assert.match(closedErr.message, /closed/);
assert.equal((await errOf(c.action(api.authNode.signUp, { name: 'X', email: 'x@example.com', password: 'password123', inviteToken: 'bogus' }))).status, 403);
step('sign-up closed: no accounts without an invite, no account-exists leak');

// ---------- sign-up invites from the site admin (work while sign-up is closed) ----------
assert.equal(me.admin, true);
assert.equal((await errOf(c.action(api.workspaces.createPlatformInvite, { session: alice.session, email: '' }))).status, 400);
assert.equal((await errOf(c.action(api.workspaces.createPlatformInvite, { session: alice.session, email: 'alice@example.com' }))).status, 409);
const pinv = await c.action(api.workspaces.createPlatformInvite, { session: alice.session, email: 'Carol@Example.com' });
const pinfo = await c.query(api.workspaces.inviteInfo, { token: pinv.token });
assert.equal(pinfo.valid, true);
assert.equal(pinfo.workspace, null);
assert.equal(pinfo.canSignUp, true);
assert.equal(pinfo.email, 'carol@example.com');
assert.deepEqual((await c.query(api.workspaces.platformInvites, { session: alice.session })).invites.map((i) => i.email), ['carol@example.com']);
assert.equal((await errOf(c.action(api.authNode.signUp, { name: 'M', email: 'm@example.com', password: 'password123', inviteToken: pinv.token }))).status, 403);
assert.equal((await errOf(c.mutation(api.workspaces.accept, { session: alice.session, token: pinv.token }))).status, 403); // for carol's email
const carol = await c.action(api.authNode.signUp, { name: 'Carol', email: 'carol@example.com', password: 'password123', inviteToken: pinv.token });
const carolMe = await c.query(api.auth.me, { session: carol.session });
assert.equal(carolMe.workspaces.length, 1);
assert.notEqual(carolMe.workspaces[0].id, ws.id);
assert.equal(carolMe.workspaces[0].role, 'owner');
assert.equal(carolMe.admin, false);
assert.equal((await errOf(c.action(api.authNode.signUp, { name: 'C2', email: 'carol@example.com', password: 'password123', inviteToken: pinv.token }))).status, 410);
assert.equal((await c.query(api.workspaces.platformInvites, { session: alice.session })).invites.length, 0);
// a non-admin can't let new people in while sign-up is closed
assert.equal((await errOf(c.action(api.workspaces.createPlatformInvite, { session: carol.session, email: 'dave@example.com' }))).status, 403);
const C = { session: carol.session, workspaceId: carolMe.workspaces[0].id };
const dinv = await c.action(api.workspaces.createInvite, { ...C, email: 'dave@example.com' });
assert.equal((await c.query(api.workspaces.inviteInfo, { token: dinv.token })).canSignUp, false);
assert.equal((await errOf(c.action(api.authNode.signUp, { name: 'Dave', email: 'dave@example.com', password: 'password123', inviteToken: dinv.token }))).status, 403);
// ...but their workspace invites still work for people who already have an account
const ainv = await c.action(api.workspaces.createInvite, { ...C, email: 'alice@example.com' });
await c.mutation(api.workspaces.accept, { session: alice.session, token: ainv.token });
assert.equal((await c.query(api.auth.me, { session: alice.session })).workspaces.length, 2);
// an admin invite without an email can't create accounts while closed
const open = await c.action(api.workspaces.createInvite, A);
assert.equal((await errOf(c.action(api.authNode.signUp, { name: 'E', email: 'e@example.com', password: 'password123', inviteToken: open.token }))).status, 403);
await c.mutation(api.workspaces.revokeInvite, { session: alice.session, inviteId: open.id });
const rinv = await c.action(api.workspaces.createPlatformInvite, { session: alice.session, email: 'eve@example.com' });
assert.equal((await errOf(c.mutation(api.workspaces.revokeInvite, { session: carol.session, inviteId: rinv.id }))).status, 403);
await c.mutation(api.workspaces.revokeInvite, { session: alice.session, inviteId: rinv.id });
assert.equal((await c.query(api.workspaces.inviteInfo, { token: rinv.token })).valid, false);
step('sign-up invites: admin only, email-bound, single use, own workspace; closed sign-up still holds for others');

// ---------- invites & members (SIGNUP=invite) ----------
cli('env', 'set', 'SIGNUP', 'invite');
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
assert.equal((await errOf(c.action(api.workspaces.createPlatformInvite, { session: bob.session, email: 'z@example.com' }))).status, 403);
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

try { cli('env', 'remove', 'SIGNUP'); } catch {}
assert.equal((await c.query(api.workspaces.inviteInfo, { token: inv.token })).valid, false);

// ---------- deleting a workspace ----------
// Alice is a member (not owner) of Carol's workspace: she can't delete it
assert.equal((await errOf(c.mutation(api.workspaces.remove, { session: alice.session, workspaceId: C.workspaceId, confirmName: carolMe.workspaces[0].name }))).status, 403);
assert.equal((await errOf(c.mutation(api.workspaces.remove, { ...C, confirmName: 'wrong' }))).status, 400);
const cTok = await c.action(api.workspaces.createAgentToken, { ...C, name: 'to go' });
await c.mutation(api.workspaces.remove, { ...C, confirmName: carolMe.workspaces[0].name });
assert.equal((await c.query(api.auth.me, { session: carol.session })).workspaces.length, 0);
assert.deepEqual((await c.query(api.auth.me, { session: alice.session })).workspaces.map((x) => x.id), [ws.id]);
assert.equal((await errOf(c.query(api.pages.tree, { ...A, workspaceId: C.workspaceId }))).status, 404);
const gone = await fetch(`${SITE}/agent/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cTok.token}` }, body: JSON.stringify({ method: 'listTree' }) });
assert.ok(gone.status >= 400);
await new Promise((r) => setTimeout(r, 1500)); // page deletion runs in the background
const left = JSON.parse(cli('data', 'pages', '--limit', '1000', '--format', 'jsonArray')).filter((p) => p.workspaceId === C.workspaceId);
assert.equal(left.length, 0);
step('owner deletes a workspace: confirm by name, members/tokens/pages gone, others untouched');
console.log('\nALL SMOKE TESTS PASSED');
