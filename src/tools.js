import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { blocksToMarkdown, blockToMarkdown, BLOCK_TYPES } from './shared/markdown.js';
import { PROPERTY_TYPES, OPERATORS } from './shared/database.js';

/** API backed by the Convex deployment's HTTP endpoint (used by the stdio bridge). */
export function httpApi(siteUrl, token) {
  let tool;
  return {
    async call(method, args) {
      const res = await fetch(`${siteUrl}/agent/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ method, args: args || {}, tool }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      return body.result;
    },
    onTool(name) {
      tool = name;
    },
  };
}

const INSTRUCTIONS = `This server is a Notion-style workspace with pages and databases.

Start with get_context: it tells you who you act for, the workspace, and its members (use their ids or emails for person properties).

PAGES hold free-form content written as Markdown:
- "# ", "## ", "### " headings; "- " bullets, "1. " numbered, "- [ ] " / "- [x] " to-dos (indent 2 spaces per level)
- "> " quote; "> [!NOTE] text" (or "> [!💡] text") callout; \`\`\`lang code; "---" divider; "![caption](url)" image
- Inline: **bold**, *italic*, ~~strike~~, \`code\`, [link](url)
- Sub-pages appear in their parent's content as "[Title](page:ID)" lines. Create them with create_page / create_pages
  (parent_id) or convert_block_to_page; in replace_page_content keep those lines where you want the sub-pages.

DATABASES hold structured records (tasks, contacts, budgets…). Prefer them over Markdown checklists whenever items have
owners, statuses, dates or numbers. Each item is also a page, so it can have Markdown content too.
- create_database with typed properties (${PROPERTY_TYPES.join(', ')}); select options are created on first use.
- create_database_items adds up to 300 items per call (pass idempotency_key so a retry never duplicates).
- query_database filters, sorts and paginates; update_database_items changes many items at once.
- save_database_view stores table or board views (e.g. "My tasks", "Critical", a Kanban board grouped by Status).
- Person values: member id, email, unambiguous name, or "me". Dates: YYYY-MM-DD, "today", "+7d".

Every result includes ids and a url to open the page in the app; share urls with the user.
Never guess ids: use list_pages, search_pages, get_database or query_database.
Pages read with get_page report a version; pass it as expected_version to replace_page_content so you never overwrite
someone's newer edits. archive_page / archive_database_items move things to the Trash (restore_page brings them back).
The user sees your edits live in their browser.`;

const errorText = (s) => ({ content: [{ type: 'text', text: s }], isError: true });
const label = (p) => `${p.icon ? p.icon + ' ' : ''}${p.title || 'Untitled'}`;
/** Structured result: JSON text for any client, structuredContent for clients that read it. */
const out = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 1) }], structuredContent: data });

function blocksListing(blocks) {
  if (!blocks.length) return '(page is empty)';
  return blocks.map((b) => `[${b.id}] (${b.type}) ${blockToMarkdown(b).replace(/\n/g, '\n    ')}`).join('\n');
}

/**
 * @param api   { call(method, args), onTool(name) }
 * @param opts  { webUrl } — the web app's address, for page links. When missing it is read once from get_context.
 */
export function createMcpServer(api, opts = {}) {
  const server = new McpServer({ name: 'notion-clone', version: '2.0.0' }, { instructions: INSTRUCTIONS });
  let webUrl = opts.webUrl;
  const base = async () => {
    if (webUrl === undefined) webUrl = (await api.call('getContext', {}).catch(() => ({})))?.webUrl || null;
    return webUrl ? webUrl.replace(/#.*$/, '').replace(/\/?$/, '/') : null;
  };
  const urlOf = async (id) => {
    const b = await base();
    return b && id ? `${b}#/${id}` : null;
  };
  const withUrls = async (list, key = 'id') => {
    const b = await base();
    return list.map((x) => ({ ...x, url: b && x[key] ? `${b}#/${x[key]}` : null }));
  };

  const tool = (name, config, handler) =>
    server.registerTool(name, config, async (args) => {
      api.onTool?.(name);
      try {
        return await handler(args);
      } catch (err) {
        return errorText(`Error: ${err.message}`);
      }
    });

  const pageId = z.string().describe('Page id (from list_pages / search_pages)');
  const dbId = z.string().describe('Database id (a database is a page; ids from list_pages, search_pages or create_database)');
  const propValues = z
    .record(z.string(), z.any())
    .describe(
      'Values by property name, e.g. {"Status": "In Progress", "Assignee": "me", "Due": "2026-12-01", "Tags": ["legal", "kitchen"], "Done": true, "Cost": 120}. null clears a value. The title property (e.g. "Name") sets the item title.',
    );
  const filterSchema = z
    .array(z.any())
    .describe(
      `Filters, all must match: [{"property": "Status", "operator": "not_equals", "value": "Done"}, {"property": "Assignee", "operator": "contains", "value": "me"}]. Use {"or": [ ...filters ]} for alternatives. Operators: ${OPERATORS.join(', ')}. Dates accept YYYY-MM-DD, "today", "+7d". Built-in properties: "Created time", "Last edited time".`,
    );
  const sortSchema = z.array(z.any()).describe('Sorts: [{"property": "Due", "direction": "ascending"}] (empty values last). Without sorts, manual order.');
  const propertySpec = z.object({
    name: z.string(),
    type: z.enum([...PROPERTY_TYPES, 'status']).describe('"status" is a select'),
    options: z.array(z.union([z.string(), z.object({ name: z.string(), color: z.string().optional() })])).optional().describe('For select / multi_select'),
  });
  const viewSpec = {
    name: z.string().optional(),
    type: z.enum(['table', 'board']).optional().describe('board = Kanban columns grouped by group_by'),
    group_by: z.string().optional().describe('Select, person or checkbox property for board columns'),
    filters: filterSchema.optional(),
    sorts: sortSchema.optional(),
    visible_properties: z.array(z.string()).optional().describe('Columns to show, in order (default: all)'),
  };
  const toView = (v) => ({ name: v.name, type: v.type, groupBy: v.group_by, filters: v.filters, sorts: v.sorts, visibleProperties: v.visible_properties });

  // ======================================================================
  // Context
  // ======================================================================
  tool(
    'get_context',
    {
      title: 'Who and where am I',
      description: 'The user you act for, the workspace, its members (ids, names, emails, roles) and your permissions. Call this first; use member ids or emails for person properties.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const c = await api.call('getContext', {});
      if (webUrl === undefined) webUrl = c.webUrl || null;
      return out({ ...c, appUrl: await base() });
    },
  );

  // ======================================================================
  // Pages
  // ======================================================================
  tool(
    'list_pages',
    {
      title: 'List pages',
      description: 'The page tree with ids, kinds (page / database) and urls. Database items are not listed here; use query_database. Optionally only below parent_id, limited in depth, or with the Trash.',
      inputSchema: {
        parent_id: z.string().optional().describe('Only list the sub-tree under this page'),
        depth: z.number().int().min(1).max(20).optional().describe('How many levels to include (default: all)'),
        include_trash: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ parent_id, depth, include_trash }) => {
      let tree = await api.call('listTree', {});
      if (parent_id) {
        const find = (nodes) => {
          for (const n of nodes) {
            if (n.id === parent_id) return n;
            const f = find(n.children);
            if (f) return f;
          }
          return null;
        };
        const root = find(tree);
        if (!root) throw new Error(`No page "${parent_id}" in the tree (it may be a database item or in the Trash)`);
        tree = root.children;
      }
      const b = await base();
      const shape = (nodes, d) =>
        nodes.map((n) => ({
          id: n.id,
          title: n.title,
          icon: n.icon,
          kind: n.kind,
          url: b ? `${b}#/${n.id}` : null,
          ...(d < (depth || Infinity) && n.children.length ? { children: shape(n.children, d + 1) } : n.children.length ? { childCount: n.children.length } : {}),
        }));
      const result = { pages: shape(tree, 1) };
      if (include_trash) result.trash = await withUrls(await api.call('listTrash', {}));
      return out(result);
    },
  );

  tool(
    'search_pages',
    {
      title: 'Search',
      description: 'Full-text search over titles and content of pages, databases and database items. An empty query returns recently edited ones.',
      inputSchema: {
        query: z.string(),
        parent_id: z.string().optional().describe('Only search inside this page or database (all levels below it)'),
        kinds: z.array(z.enum(['page', 'database', 'row'])).optional().describe('Restrict to these kinds; "row" = database items'),
        limit: z.number().int().min(1).max(100).optional().describe('Default 20'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, parent_id, kinds, limit }) => {
      const results = await api.call('search', { query, limit: limit || 20, parentId: parent_id || null, kinds: kinds || null });
      return out({ query, results: await withUrls(results.map(({ score, ...r }) => r)) });
    },
  );

  tool(
    'get_page',
    {
      title: 'Read page',
      description:
        'Read a page, database or database item: title, url, version, location, sub-pages, item properties, and content. format "markdown" (default) or "blocks" (each block with its id, for update_block / delete_blocks / move_block / append_content). For a database this returns its description; use get_database / query_database for its items.',
      inputSchema: { page_id: pageId, format: z.enum(['markdown', 'blocks']).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ page_id, format }) => {
      const p = await api.call('getPage', { pageId: page_id });
      const meta = {
        id: p.id,
        title: p.title,
        icon: p.icon,
        kind: p.kind,
        url: await urlOf(p.id),
        version: p.version,
        parentId: p.parentId,
        breadcrumb: p.breadcrumb.map((c) => ({ id: c.id, title: c.title })),
        archived: !!p.archived,
        subpages: p.children.map((c) => ({ id: c.id, title: c.title, kind: c.kind })),
        lastEditedBy: p.lastEditedBy,
        updatedAt: p.updatedAt,
      };
      if (p.row) {
        meta.database = { id: p.row.databaseId, title: p.row.databaseTitle };
        meta.properties = p.properties;
      }
      if (p.kind === 'database') meta.database = { rowCount: p.rowCount, hint: 'Use get_database for the schema and query_database for items' };
      const body = format === 'blocks' ? blocksListing(p.blocks) : blocksToMarkdown(p.blocks) || '(empty)';
      return {
        content: [{ type: 'text', text: `${JSON.stringify(meta, null, 1)}\n\n---- content (${format || 'markdown'}) ----\n${body}` }],
        structuredContent: { ...meta, content: body, format: format || 'markdown' },
      };
    },
  );

  tool(
    'create_page',
    {
      title: 'Create page',
      description:
        "Create a page with Markdown content. With parent_id it becomes a sub-page shown as a page block in the parent's content (at the end, or right after after_block_id). For many pages use create_pages; for structured items use a database.",
      inputSchema: {
        title: z.string(),
        content: z.string().optional().describe('Body as Markdown'),
        parent_id: z.string().optional().describe('Parent page id; omit for top level'),
        after_block_id: z.string().optional().describe("Place the sub-page's block right after this block of the parent"),
        icon: z.string().optional().describe('Emoji, e.g. "📝"'),
      },
    },
    async ({ title, content, parent_id, after_block_id, icon }) => {
      const p = await api.call('createPage', { title, markdown: content || '', parentId: parent_id || null, afterBlockId: (parent_id && after_block_id) || null, icon: icon || '' });
      return out({ created: true, id: p.id, title: p.title, parentId: p.parentId, url: await urlOf(p.id), version: p.version, blockCount: p.blocks.length });
    },
  );

  tool(
    'create_pages',
    {
      title: 'Create many pages',
      description:
        'Create up to 100 pages in one call. Give an item a key and later items parent_key to build a whole tree at once (or use parent_id for existing pages). Returns one result per item; failed items are reported, the rest are still created.',
      inputSchema: {
        pages: z
          .array(
            z.object({
              title: z.string(),
              content: z.string().optional().describe('Markdown body'),
              icon: z.string().optional(),
              parent_id: z.string().optional().describe('Existing parent page id'),
              key: z.string().optional().describe('Your label for this item, so later items can use it as parent_key'),
              parent_key: z.string().optional().describe('key of an earlier item in this list to nest under'),
            }),
          )
          .min(1)
          .max(100),
      },
    },
    async ({ pages }) => {
      const results = await api.call('createPages', {
        pages: pages.map((p) => ({ title: p.title, markdown: p.content || '', icon: p.icon || '', parentId: p.parent_id || null, key: p.key, parentKey: p.parent_key })),
      });
      return out({ created: results.filter((r) => r.status === 'created').length, failed: results.filter((r) => r.status === 'failed').length, results: await withUrls(results) });
    },
  );

  tool(
    'convert_block_to_page',
    {
      title: 'Turn block into sub-page',
      description: "Turn a block (e.g. a list item) into a sub-page titled with the block's text, at the same spot. Returns the new page id.",
      inputSchema: { page_id: pageId, block_id: z.string() },
    },
    async ({ page_id, block_id }) => {
      const p = await api.call('blockToPage', { pageId: page_id, blockId: block_id });
      return out({ created: true, id: p.id, title: p.title, parentId: page_id, url: await urlOf(p.id) });
    },
  );

  tool(
    'update_page',
    {
      title: 'Rename / move page',
      description:
        'Change the title or icon of a page, database or item, or move it: parent_id = another page id to nest it, "root" for top level. index = position among siblings (0 = first). Moving a page into a database makes it an item.',
      inputSchema: {
        page_id: pageId,
        title: z.string().optional(),
        icon: z.string().optional().describe('Emoji; empty string removes it'),
        parent_id: z.string().optional().describe('New parent id, or "root"'),
        index: z.number().int().min(0).optional(),
      },
    },
    async ({ page_id, title, icon, parent_id, index }) => {
      const args = { pageId: page_id, title, icon, index };
      if (parent_id !== undefined) args.parentId = parent_id === 'root' || parent_id === '' ? null : parent_id;
      const p = await api.call('updatePage', args);
      return out({ updated: true, id: p.id, title: p.title, kind: p.kind, parentId: p.parentId, breadcrumb: p.breadcrumb.map((c) => c.title), url: await urlOf(p.id), version: p.version });
    },
  );

  tool(
    'replace_page_content',
    {
      title: 'Replace page content',
      description:
        'Overwrite the whole body of a page with Markdown (block ids are regenerated). Pass expected_version (from get_page) so the call fails instead of overwriting newer edits by someone else. Keep "[Title](page:ID)" lines to position sub-pages; omitted sub-pages are kept at the end.',
      inputSchema: {
        page_id: pageId,
        content: z.string().describe('The full new body as Markdown'),
        expected_version: z.number().int().optional().describe('The version you read; recommended'),
      },
      annotations: { destructiveHint: true },
    },
    async ({ page_id, content, expected_version }) => {
      const p = await api.call('setContent', { pageId: page_id, markdown: content, expectedVersion: expected_version });
      return out({ updated: true, id: p.id, title: p.title, version: p.version, blockCount: p.blocks.length, url: await urlOf(p.id) });
    },
  );

  tool(
    'append_content',
    {
      title: 'Add content',
      description: 'Insert Markdown into a page — at the end, or right after a block id.',
      inputSchema: {
        page_id: pageId,
        content: z.string(),
        after_block_id: z.string().optional().describe('Insert after this block (ids from get_page format "blocks")'),
      },
    },
    async ({ page_id, content, after_block_id }) => {
      const { page, inserted } = await api.call('appendContent', { pageId: page_id, markdown: content, afterBlockId: after_block_id || null });
      return out({ updated: true, id: page.id, version: page.version, insertedBlockIds: inserted.map((b) => b.id), url: await urlOf(page.id) });
    },
  );

  tool(
    'update_block',
    {
      title: 'Edit block',
      description:
        'Edit one block. Either pass markdown to replace it (may become several blocks), or patch fields: text (inline Markdown allowed), type, checked (to-dos), language (code), icon (callouts), indent (lists, 0-4).',
      inputSchema: {
        page_id: pageId,
        block_id: z.string(),
        markdown: z.string().optional(),
        text: z.string().optional(),
        type: z.enum(BLOCK_TYPES).optional(),
        checked: z.boolean().optional(),
        language: z.string().optional(),
        icon: z.string().optional(),
        indent: z.number().int().min(0).max(4).optional(),
      },
    },
    async ({ page_id, block_id, ...patch }) => {
      const { page, blocks } = await api.call('updateBlock', { pageId: page_id, blockId: block_id, ...patch });
      return out({ updated: true, pageId: page_id, version: page.version, blocks: blocks.map((b) => ({ id: b.id, type: b.type, markdown: blockToMarkdown(b) })) });
    },
  );

  tool(
    'delete_blocks',
    {
      title: 'Delete blocks',
      description: 'Delete blocks from a page by id. Deleting a sub-page block moves that sub-page to the Trash.',
      inputSchema: { page_id: pageId, block_ids: z.array(z.string()).min(1) },
      annotations: { destructiveHint: true },
    },
    async ({ page_id, block_ids }) => out(await api.call('deleteBlocks', { pageId: page_id, blockIds: block_ids })),
  );

  tool(
    'move_block',
    {
      title: 'Move block',
      description: 'Reorder a block within its page: right after another block, or at the top if after_block_id is omitted.',
      inputSchema: { page_id: pageId, block_id: z.string(), after_block_id: z.string().optional() },
    },
    async ({ page_id, block_id, after_block_id }) => {
      const p = await api.call('moveBlock', { pageId: page_id, blockId: block_id, afterBlockId: after_block_id || null });
      return out({ moved: true, blockId: block_id, after: after_block_id || null, version: p.version });
    },
  );

  tool(
    'archive_page',
    {
      title: 'Move page to Trash',
      description: 'Move a page, database or item (and everything under it) to the Trash. Reversible with restore_page.',
      inputSchema: { page_id: pageId },
      annotations: { destructiveHint: true },
    },
    async ({ page_id }) => {
      const r = await api.call('archivePage', { pageId: page_id });
      return out({ archived: true, id: r.archived.id, title: r.archived.title });
    },
  );

  tool(
    'restore_page',
    {
      title: 'Restore from Trash',
      description: 'Bring an archived page, database or item back out of the Trash.',
      inputSchema: { page_id: pageId },
    },
    async ({ page_id }) => {
      const p = await api.call('restorePage', { pageId: page_id });
      return out({ restored: true, id: p.id, title: p.title, url: await urlOf(p.id) });
    },
  );

  // ======================================================================
  // Databases
  // ======================================================================
  tool(
    'create_database',
    {
      title: 'Create database',
      description:
        'Create a database (a page whose items are typed records) under parent_id. It gets an "All" table view; add more views here or with save_database_view. Example properties: [{"name":"Status","type":"status","options":["Not Started","In Progress","Blocked","Done"]}, {"name":"Assignee","type":"person"}, {"name":"Due","type":"date"}, {"name":"Priority","type":"select","options":["Low","Medium","High","Critical"]}].',
      inputSchema: {
        title: z.string(),
        parent_id: z.string().optional().describe('Page to create it in (it appears there as a block); omit for top level'),
        icon: z.string().optional(),
        title_property: z.string().optional().describe('Name of the title column (default "Name")'),
        properties: z.array(propertySpec).optional(),
        views: z.array(z.object(viewSpec)).optional().describe('Extra views, e.g. [{"name":"Board","type":"board","group_by":"Status"}]'),
        description: z.string().optional().describe('Markdown shown above the views'),
      },
    },
    async ({ title, parent_id, icon, title_property, properties, views, description }) => {
      const db = await api.call('createDatabase', {
        title,
        parentId: parent_id || null,
        icon: icon || '',
        titleName: title_property || 'Name',
        properties: properties || [],
        views: (views || []).map(toView),
        markdown: description || '',
      });
      return out({ created: true, ...db, url: await urlOf(db.id) });
    },
  );

  tool(
    'get_database',
    {
      title: 'Read database schema',
      description: 'Properties (with types and select options), saved views and item count of a database.',
      inputSchema: { database_id: dbId },
      annotations: { readOnlyHint: true },
    },
    async ({ database_id }) => {
      const db = await api.call('getDatabase', { pageId: database_id });
      return out({ ...db, url: await urlOf(db.id) });
    },
  );

  tool(
    'update_database',
    {
      title: 'Change database schema',
      description:
        'Rename the database, add / rename / retype / remove properties, and manage select options. Renaming keeps all values and views working (they use stable ids). Changing a type converts values where possible.',
      inputSchema: {
        database_id: dbId,
        title: z.string().optional(),
        icon: z.string().optional(),
        add_properties: z.array(propertySpec).optional(),
        update_properties: z
          .array(
            z.object({
              property: z.string().describe('Current name or id'),
              name: z.string().optional().describe('New name'),
              type: z.enum([...PROPERTY_TYPES, 'status']).optional(),
              add_options: z.array(z.string()).optional(),
              rename_options: z.record(z.string(), z.string()).optional().describe('{"Old name": "New name"}'),
              remove_options: z.array(z.string()).optional(),
              option_order: z.array(z.string()).optional().describe('Option names in the order to show (also board column order)'),
              option_colors: z.record(z.string(), z.string()).optional().describe('{"Done": "green"}; colors: gray, brown, orange, yellow, green, blue, purple, pink, red'),
            }),
          )
          .optional(),
        remove_properties: z.array(z.string()).optional(),
      },
      annotations: { destructiveHint: true },
    },
    async ({ database_id, title, icon, add_properties, update_properties, remove_properties }) => {
      const db = await api.call('updateDatabase', {
        pageId: database_id,
        title,
        icon,
        addProperties: add_properties || [],
        updateProperties: (update_properties || []).map((u) => ({
          property: u.property,
          name: u.name,
          type: u.type,
          options: u.add_options,
          renameOptions: u.rename_options,
          removeOptions: u.remove_options,
          optionOrder: u.option_order,
          optionColors: u.option_colors,
        })),
        removeProperties: remove_properties || [],
      });
      return out({ updated: true, ...db, url: await urlOf(db.id) });
    },
  );

  tool(
    'create_database_items',
    {
      title: 'Add database items',
      description:
        'Create up to 300 items in a database in one call. Each item: properties by name (the title property, e.g. "Name", is the item title) and optional Markdown content for its page. New select options are added automatically. Always pass an idempotency_key for imports: repeating a call with the same key returns the first result instead of creating duplicates. Failed items are reported per index; the others are created.',
      inputSchema: {
        database_id: dbId,
        items: z
          .array(
            z.object({
              properties: propValues,
              content: z.string().optional().describe("Markdown for the item's page body"),
              icon: z.string().optional(),
            }),
          )
          .min(1)
          .max(300),
        idempotency_key: z.string().optional().describe('Any unique string for this batch, e.g. "big-pie-tasks-v1"'),
      },
    },
    async ({ database_id, items, idempotency_key }) => {
      const r = await api.call('createRows', {
        pageId: database_id,
        idempotencyKey: idempotency_key || null,
        items: items.map((i) => ({ properties: i.properties, markdown: i.content || '', icon: i.icon || '' })),
      });
      return out({ ...r, results: await withUrls(r.results) });
    },
  );

  tool(
    'query_database',
    {
      title: 'Query database',
      description:
        'List database items matching filters, sorted and paginated (default 50, max 200 per call; pass next_cursor back as cursor). Optionally start from a saved view (its filters and sorts apply too) and add a text search. Use this instead of reading pages to answer questions like "what does Anna need to finish this week".',
      inputSchema: {
        database_id: dbId,
        view: z.string().optional().describe('Saved view name or id'),
        filters: filterSchema.optional(),
        sorts: sortSchema.optional(),
        search: z.string().optional().describe('Text to find in titles and text / select / person values'),
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ database_id, view, filters, sorts, search, limit, cursor }) => {
      const r = await api.call('queryDatabase', { pageId: database_id, viewId: view || null, filters: filters || [], sorts: sorts || null, search: search || '', limit: limit || 50, cursor: cursor || null });
      return out({ ...r, items: await withUrls(r.items) });
    },
  );

  tool(
    'update_database_items',
    {
      title: 'Update database items',
      description:
        'Change properties (and title / icon) of up to 300 items in one call, e.g. mark several tasks Done or reassign them. Only the properties you pass change. Results are reported per item.',
      inputSchema: {
        updates: z
          .array(
            z.object({
              item_id: z.string(),
              properties: propValues.optional(),
              icon: z.string().optional(),
            }),
          )
          .min(1)
          .max(300),
      },
    },
    async ({ updates }) => {
      const r = await api.call('updateRows', { updates: updates.map((u) => ({ itemId: u.item_id, properties: u.properties || {}, icon: u.icon })) });
      return out({ ...r, results: await withUrls(r.results.map(({ item, ...x }) => ({ ...x, ...(item ? { properties: item.properties } : {}) }))) });
    },
  );

  tool(
    'archive_database_items',
    {
      title: 'Move database items to Trash',
      description: 'Move items to the Trash (restore_page brings one back).',
      inputSchema: { item_ids: z.array(z.string()).min(1).max(300) },
      annotations: { destructiveHint: true },
    },
    async ({ item_ids }) => out(await api.call('archiveRows', { itemIds: item_ids })),
  );

  tool(
    'save_database_view',
    {
      title: 'Create / change a database view',
      description:
        'Create a saved view (omit view) or change one (view = its name or id). Views store filters, sorts, visible columns and, for boards, the group-by property — e.g. "My tasks" (Assignee contains me), "This week" (Due on_or_before +7d), or a Kanban "Board" grouped by Status. remove: true deletes the view.',
      inputSchema: {
        database_id: dbId,
        view: z.string().optional().describe('Existing view name or id to change; omit to create'),
        ...viewSpec,
        position: z.number().int().min(0).optional().describe('Tab position (0 = first)'),
        remove: z.boolean().optional(),
      },
    },
    async ({ database_id, view, remove, position, ...spec }) => {
      const v = toView(spec);
      for (const k of Object.keys(v)) if (v[k] === undefined) delete v[k];
      const r = await api.call('saveView', { pageId: database_id, viewId: view || null, remove: !!remove, index: position ?? null, ...v });
      return out({ saved: !remove, databaseId: database_id, ...(r.views ? r : { view: r }), url: await urlOf(database_id) });
    },
  );

  return server;
}
