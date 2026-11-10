import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { blocksToMarkdown, blockToMarkdown, BLOCK_TYPES } from './shared/markdown.js';
import { PROPERTY_TYPES, OPERATORS, VIEW_TYPES, ROLLUP_FUNCTIONS, AGGREGATIONS, NUMBER_FORMATS } from './shared/database.js';

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
  relation links items across (or within) databases, two-way if you ask; rollup summarizes related items
  (count, sum, percent_where "Done"…); formula computes from other properties (prop("A") / prop("B"));
  status has To-do / In progress / Complete groups; unique_id numbers items (E-1, E-2…); files and links hold lists.
  sub_items / dependencies on a database add Parent item / Sub-items or Blocked by / Blocking (items show "blocked").
- create_database_items adds up to 300 items per call (pass idempotency_key so a retry never duplicates);
  upsert_database_items matches existing items by a key property and updates them, creating only missing ones.
- query_database filters, sorts, paginates and totals (aggregations); update_database_items changes many items at once.
- save_database_view stores table, board, list, gallery, calendar or timeline views.
- save_database_template stores item templates (content, default values, linked views); new items use the default one.
- Person values: member id, email, unambiguous name, "me" (the user) or "@agent" (you). Dates: YYYY-MM-DD,
  "today", "+7d", or date-times like 2026-11-08T00:51:17Z; ranges as {"start": …, "end": …}.
- Comments: list_comments (e.g. unresolved answers from the owner), add_comment, resolve_comment.
- list_changes tells you what changed since your last session; create_webhook pushes changes to a URL.
- create_linked_database_view shows a database inside any other page as a live, filtered table or board (e.g. only
  this stage's tasks on a stage page). It uses the same records; new items added there get the filtered values.
  In Markdown it appears as "[View name](database_view:BLOCK_ID)"; keep that line in replace_page_content to keep it.
  Filter value "@this_page" means the page the view sits on (e.g. Epic contains @this_page), so the view keeps
  working when the page is renamed or duplicated, and can live in a template.

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
      `Filters, all must match: [{"property": "Status", "operator": "not_equals", "value": "Done"}, {"property": "Assignee", "operator": "contains", "value": "me"}]. Use {"or": [ ...filters ]} for alternatives. Operators: ${OPERATORS.join(', ')}. in_group / not_in_group take a status group: todo, in_progress, complete. Dates accept YYYY-MM-DD, "today", "+7d", ISO date-times. Relations match item ids or titles. Value "@this_page" = the page a linked view is on. Built-in properties: "Created time", "Last edited time", "Is blocked" (with dependencies).`,
    );
  const sortSchema = z.array(z.any()).describe('Sorts: [{"property": "Due", "direction": "ascending"}] (empty values last). Without sorts, manual order.');
  const optionSpec = z.union([z.string(), z.object({ name: z.string(), color: z.string().optional(), group: z.enum(['todo', 'in_progress', 'complete']).optional() })]);
  const propertySpec = z.object({
    name: z.string(),
    type: z.enum(PROPERTY_TYPES),
    options: z.array(optionSpec).optional().describe('select / multi_select / status options. Status options may set group (todo, in_progress, complete); otherwise it is guessed from the name.'),
    database_id: z.string().optional().describe('relation: the database whose items it links to ("self" for the same database)'),
    two_way: z.boolean().optional().describe('relation: also add a reverse property to the other database, kept in sync'),
    reverse_name: z.string().optional().describe('relation: name of that reverse property'),
    limit: z.literal(1).optional().describe('relation: 1 = at most one linked item'),
    relation: z.string().optional().describe('rollup: the relation property to follow'),
    property: z.string().optional().describe('rollup: property of the related items to summarize (default: title)'),
    function: z.enum(ROLLUP_FUNCTIONS).optional().describe('rollup: how to summarize; count_where / percent_where need value (e.g. "Done", or "@complete" for a status group)'),
    value: z.string().optional().describe('rollup: the value count_where / percent_where look for'),
    expression: z.string().optional().describe('formula, e.g. prop("Scenes illustrated") / prop("Scenes"), if(prop("Done"), "✓", ""), dateBetween(prop("End"), prop("Start"), "minutes")'),
    format: z.enum(NUMBER_FORMATS).optional().describe('number / rollup / formula display format'),
    display: z.enum(['number', 'bar', 'ring']).optional().describe('number / rollup / formula: show 0–1 values as a progress bar or ring'),
    prefix: z.string().optional().describe('unique_id: prefix, e.g. "E" → E-1, E-2'),
  });
  const viewSpec = {
    name: z.string().optional(),
    type: z.enum(VIEW_TYPES).optional().describe('board = Kanban grouped by group_by; gallery = cards with a cover image; calendar / timeline place items by a date property'),
    group_by: z.string().optional().describe('Status, select, person or checkbox property for board columns'),
    date_property: z.string().optional().describe('calendar / timeline: the date property to place items by'),
    end_property: z.string().optional().describe('timeline: a second date property for the end (otherwise the date range end)'),
    cover_property: z.string().optional().describe('gallery: files property for the card image, "content" (first image in the item) or "none"'),
    card_size: z.enum(['small', 'medium', 'large']).optional(),
    aggregations: z.record(z.string(), z.enum(AGGREGATIONS)).optional().describe('Table footer calculations by property, e.g. {"Credits": "sum", "Done": "percent_checked"}'),
    show_sub_items: z.boolean().optional().describe('Tables of databases with sub-items nest them under their parent (default true)'),
    filters: filterSchema.optional(),
    sorts: sortSchema.optional(),
    visible_properties: z.array(z.string()).optional().describe('Columns to show, in order (default: all)'),
  };
  const defined = (o) => Object.fromEntries(Object.entries(o).filter(([, x]) => x !== undefined));
  const toView = (v) =>
    defined({
      name: v.name,
      type: v.type,
      groupBy: v.group_by,
      filters: v.filters,
      sorts: v.sorts,
      visibleProperties: v.visible_properties,
      dateProperty: v.date_property,
      endProperty: v.end_property,
      coverProperty: v.cover_property,
      cardSize: v.card_size,
      aggregations: v.aggregations,
      showSubItems: v.show_sub_items,
    });
  const toProperty = (p) =>
    defined({
      name: p.name,
      type: p.type,
      options: p.options,
      databaseId: p.database_id,
      twoWay: p.two_way,
      reverseName: p.reverse_name,
      limit: p.limit,
      relation: p.relation,
      property: p.property,
      function: p.function,
      value: p.value,
      expression: p.expression,
      format: p.format,
      display: p.display,
      prefix: p.prefix,
    });

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
      if (p.linkedViews?.length) meta.linkedViews = p.linkedViews;
      if (p.kind === 'database') meta.database ={ rowCount: p.rowCount, hint: 'Use get_database for the schema and query_database for items' };
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
        'Create a database (a page whose items are typed records) under parent_id. It gets an "All" table view; add more views here or with save_database_view. Example properties: [{"name":"Status","type":"status","options":["Not started","In progress",{"name":"Waiting on owner","group":"in_progress"},"Done"]}, {"name":"Assignee","type":"person"}, {"name":"Due","type":"date"}, {"name":"Epic","type":"relation","database_id":"<epics id>","two_way":true,"reverse_name":"Subtasks"}, {"name":"ID","type":"unique_id","prefix":"T"}]. Rollups and formulas over a relation are easiest to add afterwards with update_database.',
      inputSchema: {
        title: z.string(),
        parent_id: z.string().optional().describe('Page to create it in (it appears there as a block); omit for top level'),
        icon: z.string().optional(),
        title_property: z.string().optional().describe('Name of the title column (default "Name")'),
        properties: z.array(propertySpec).optional(),
        views: z.array(z.object(viewSpec)).optional().describe('Extra views, e.g. [{"name":"Board","type":"board","group_by":"Status"}]'),
        description: z.string().optional().describe('Markdown shown above the views'),
        sub_items: z.boolean().optional().describe('Add Parent item / Sub-items so items can nest'),
        dependencies: z.boolean().optional().describe('Add Blocked by / Blocking; items whose blockers are not complete show as blocked'),
      },
    },
    async ({ title, parent_id, icon, title_property, properties, views, description, sub_items, dependencies }) => {
      const db = await api.call('createDatabase', {
        title,
        parentId: parent_id || null,
        icon: icon || '',
        titleName: title_property || 'Name',
        properties: (properties || []).map(toProperty),
        views: (views || []).map(toView),
        markdown: description || '',
        subItems: !!sub_items,
        dependencies: !!dependencies,
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
        'Rename the database, add / rename / retype / remove properties (with all the settings create_database takes), manage select and status options, and turn sub-items or dependencies on or off. Renaming keeps values, formulas and views working (they use stable ids). Changing a type converts values where possible. Example: add_properties [{"name":"Progress","type":"rollup","relation":"Subtasks","property":"Status","function":"percent_where","value":"@complete","display":"bar"}].',
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
              type: z.enum(PROPERTY_TYPES).optional().describe('Change the type; values are converted where possible. Relation / rollup / formula need their settings below.'),
              add_options: z.array(optionSpec).optional(),
              option_groups: z.record(z.string(), z.enum(['todo', 'in_progress', 'complete'])).optional().describe('Status: {"Waiting on owner": "in_progress"}'),
              expression: z.string().optional().describe('formula expression'),
              relation: z.string().optional().describe('rollup: relation property'),
              rollup_property: z.string().optional().describe('rollup: property of the related items'),
              function: z.enum(ROLLUP_FUNCTIONS).optional().describe('rollup function'),
              value: z.string().optional().describe('rollup: value for count_where / percent_where'),
              database_id: z.string().optional().describe('relation target (when changing the type to relation)'),
              format: z.enum(NUMBER_FORMATS).optional(),
              display: z.enum(['number', 'bar', 'ring']).optional(),
              prefix: z.string().optional().describe('unique_id prefix'),
              rename_options: z.record(z.string(), z.string()).optional().describe('{"Old name": "New name"}'),
              remove_options: z.array(z.string()).optional(),
              option_order: z.array(z.string()).optional().describe('Option names in the order to show (also board column order)'),
              option_colors: z.record(z.string(), z.string()).optional().describe('{"Done": "green"}; colors: gray, brown, orange, yellow, green, blue, purple, pink, red'),
            }),
          )
          .optional(),
        remove_properties: z.array(z.string()).optional(),
        sub_items: z.boolean().optional().describe('true adds Parent item / Sub-items; false removes them'),
        dependencies: z.boolean().optional().describe('true adds Blocked by / Blocking; false removes them'),
      },
      annotations: { destructiveHint: true },
    },
    async ({ database_id, title, icon, add_properties, update_properties, remove_properties, sub_items, dependencies }) => {
      const db = await api.call('updateDatabase', {
        pageId: database_id,
        title,
        icon,
        addProperties: (add_properties || []).map(toProperty),
        subItems: sub_items,
        dependencies,
        updateProperties: (update_properties || []).map((u) => ({
          property: u.property,
          name: u.name,
          type: u.type,
          options: u.add_options,
          renameOptions: u.rename_options,
          removeOptions: u.remove_options,
          optionOrder: u.option_order,
          optionColors: u.option_colors,
          optionGroups: u.option_groups,
          expression: u.expression,
          relation: u.relation,
          rollupProperty: u.rollup_property,
          function: u.function,
          value: u.value,
          databaseId: u.database_id,
          format: u.format,
          display: u.display,
          prefix: u.prefix,
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
              content: z.string().optional().describe("Markdown for the item's page body (instead of the template's)"),
              icon: z.string().optional(),
              template: z.string().optional().describe('Template name or id; "none" skips the default template'),
              parent_item_id: z.string().optional().describe('Make it a sub-item of this item (databases with sub_items)'),
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
        items: items.map((i) => defined({ properties: i.properties, markdown: i.content || '', icon: i.icon || '', template: i.template, parentItemId: i.parent_item_id })),
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
        search: z.string().optional().describe('Text to find in titles and text / select / person / relation values'),
        limit: z.number().int().min(1).max(200).optional(),
        cursor: z.string().optional(),
        aggregations: z.record(z.string(), z.enum(AGGREGATIONS)).optional().describe("Totals over all matching items, e.g. {\"Credits\": \"sum\", \"Status\": \"percent_checked\"} (default: the view's)"),
        context_page_id: z.string().optional().describe('The page "@this_page" filter values refer to'),
        parent_item_id: z.string().optional().describe('Only the sub-items of this item'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ database_id, view, filters, sorts, search, limit, cursor, aggregations, context_page_id, parent_item_id }) => {
      const r = await api.call('queryDatabase', {
        pageId: database_id,
        viewId: view || null,
        filters: filters || [],
        sorts: sorts || null,
        search: search || '',
        limit: limit || 50,
        cursor: cursor || null,
        aggregations: aggregations || null,
        contextPageId: context_page_id || null,
        parentItemId: parent_item_id || null,
      });
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

  tool(
    'create_linked_database_view',
    {
      title: 'Show a database inside a page',
      description:
        'Embed a live view of a database in another page (table, board, list, gallery, calendar or timeline) with its own filters, sorts and columns, over the same records (no copies). Use "@this_page" as a filter value for the page it sits on, e.g. on an epic page filters [{"property":"Epic","operator":"contains","value":"@this_page"}]; it survives renames and duplication. Example: on each stage page, a table of that stage\'s tasks with filters [{"property":"Stage","operator":"equals","value":"01 · Business & Feasibility"}]. Items created from the view get the filtered values. Placed at the end of the page or right after after_block_id. Remove it with delete_blocks.',
      inputSchema: {
        parent_page_id: z.string().describe('Page to show the view on'),
        database_id: dbId,
        name: z.string().optional().describe('View title shown above it (default: database title)'),
        view_type: z.enum(VIEW_TYPES).optional(),
        group_by: viewSpec.group_by,
        filters: filterSchema.optional(),
        sorts: sortSchema.optional(),
        visible_properties: viewSpec.visible_properties,
        date_property: viewSpec.date_property,
        end_property: viewSpec.end_property,
        cover_property: viewSpec.cover_property,
        card_size: viewSpec.card_size,
        aggregations: viewSpec.aggregations,
        after_block_id: z.string().optional().describe('Insert right after this block of the page (ids from get_page format "blocks")'),
      },
    },
    async ({ parent_page_id, database_id, view_type, after_block_id, ...v }) => {
      const r = await api.call('createLinkedView', { pageId: parent_page_id, databaseId: database_id, afterBlockId: after_block_id || null, ...toView({ ...v, type: view_type }) });
      return out({ created: true, ...r, url: await urlOf(parent_page_id) });
    },
  );

  tool(
    'update_linked_database_view',
    {
      title: 'Change a linked database view',
      description: 'Change the name, layout, grouping, filters, sorts or columns of a linked database view block (block ids from get_page → linkedViews). Only what you pass changes.',
      inputSchema: {
        page_id: pageId,
        block_id: z.string(),
        name: z.string().optional(),
        view_type: z.enum(VIEW_TYPES).optional(),
        group_by: viewSpec.group_by,
        filters: filterSchema.optional(),
        sorts: sortSchema.optional(),
        visible_properties: viewSpec.visible_properties,
        date_property: viewSpec.date_property,
        end_property: viewSpec.end_property,
        cover_property: viewSpec.cover_property,
        card_size: viewSpec.card_size,
        aggregations: viewSpec.aggregations,
      },
    },
    async ({ page_id, block_id, view_type, ...v }) => {
      const r = await api.call('updateLinkedView', { pageId: page_id, blockId: block_id, ...toView({ ...v, type: view_type }) });
      return out({ updated: true, ...r, url: await urlOf(page_id) });
    },
  );


  tool(
    'upsert_database_items',
    {
      title: 'Create or update items by key',
      description:
        'Sync up to 300 items into a database by a key property (e.g. match_property "Code" with items whose Code is "GEN"): matching items are updated, missing ones are created, identical ones are left alone. No need to look up item ids first. Results per item: created / updated / unchanged / failed.',
      inputSchema: {
        database_id: dbId,
        match_property: z.string().describe('Property that identifies an item: title, text, number, select, status, url, email or unique_id'),
        items: z
          .array(
            z.object({
              properties: propValues.describe('Must include the match property'),
              content: z.string().optional().describe('Markdown body; replaces the body when different'),
              icon: z.string().optional(),
            }),
          )
          .min(1)
          .max(300),
      },
    },
    async ({ database_id, match_property, items }) => {
      const r = await api.call('upsertRows', {
        pageId: database_id,
        matchProperty: match_property,
        items: items.map((i) => defined({ properties: i.properties, markdown: i.content, icon: i.icon })),
      });
      return out({ ...r, results: await withUrls(r.results) });
    },
  );

  tool(
    'save_database_template',
    {
      title: 'Create / change an item template',
      description:
        'Item templates give new items a title, icon, default property values, Markdown content and linked database views (use "@this_page" in their filters, e.g. a Subtasks table filtered by Epic contains @this_page). The default template applies to every new item (pass template "none" when creating to skip it). Omit template to create one; from_item_id copies an existing item; remove: true deletes. get_database lists templates.',
      inputSchema: {
        database_id: dbId,
        template: z.string().optional().describe('Existing template name or id to change'),
        name: z.string().optional(),
        title: z.string().optional().describe('Title new items get'),
        icon: z.string().optional(),
        properties: propValues.optional().describe('Default values'),
        content: z.string().optional().describe('Markdown body'),
        linked_views: z
          .array(
            z.object({
              database_id: z.string(),
              name: z.string().optional(),
              view_type: z.enum(VIEW_TYPES).optional(),
              group_by: z.string().optional(),
              filters: filterSchema.optional(),
              sorts: sortSchema.optional(),
              visible_properties: z.array(z.string()).optional(),
            }),
          )
          .optional()
          .describe('Linked database views added at the end of each new item'),
        is_default: z.boolean().optional(),
        from_item_id: z.string().optional().describe("Copy this item's values, content and linked views"),
        remove: z.boolean().optional(),
      },
    },
    async ({ database_id, template, linked_views, is_default, from_item_id, remove, content, ...rest }) => {
      const r = await api.call(
        'saveTemplate',
        defined({
          pageId: database_id,
          templateId: template || null,
          remove: !!remove,
          ...rest,
          markdown: content,
          isDefault: is_default,
          fromItemId: from_item_id,
          linkedViews: linked_views?.map((v) => defined({ databaseId: v.database_id, name: v.name, type: v.view_type, groupBy: v.group_by, filters: v.filters, sorts: v.sorts, visibleProperties: v.visible_properties })),
        }),
      );
      return out({ saved: !remove, databaseId: database_id, ...(r.templates ? r : { template: r }) });
    },
  );

  // ======================================================================
  // Comments
  // ======================================================================
  tool(
    'list_comments',
    {
      title: 'Read comments',
      description:
        'Comment threads (first comment + replies) on one page or item, or across the workspace. Use unresolved_only to find open questions and answers, and since to see what is new since your last session. Each comment has its author (person or agent), text, mentions and time.',
      inputSchema: {
        page_id: z.string().optional().describe('Page or database item; omit for the whole workspace'),
        unresolved_only: z.boolean().optional(),
        since: z.string().optional().describe('ISO date-time: only threads with comments after it (workspace-wide listing)'),
        limit: z.number().int().min(1).max(500).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ page_id, unresolved_only, since, limit }) => {
      const r = await api.call('listComments', { pageId: page_id || null, unresolvedOnly: !!unresolved_only, since: since || null, limit: limit || 100 });
      const b = await base();
      return out({ ...r, threads: r.threads.map((t) => ({ ...t, url: b ? `${b}#/${t.pageId}` : null })) });
    },
  );

  tool(
    'add_comment',
    {
      title: 'Comment',
      description: 'Add a comment to a page or database item, or reply to a thread (reply_to = a comment id). Mention people with @Name. A reply reopens a resolved thread.',
      inputSchema: {
        page_id: z.string().optional().describe('Page or item to comment on (not needed for a reply)'),
        text: z.string(),
        reply_to: z.string().optional().describe('Comment id to reply to'),
      },
    },
    async ({ page_id, text, reply_to }) => {
      if (!page_id && !reply_to) throw new Error('Give page_id, or reply_to for a reply');
      const c = await api.call('addComment', { pageId: page_id || null, text, parentId: reply_to || null });
      return out({ created: true, comment: c, url: await urlOf(c.pageId) });
    },
  );

  tool(
    'resolve_comment',
    {
      title: 'Resolve comment thread',
      description: 'Mark a comment thread resolved (or reopen it with resolved: false).',
      inputSchema: { comment_id: z.string(), resolved: z.boolean().optional() },
    },
    async ({ comment_id, resolved }) => out(await api.call('resolveComment', { commentId: comment_id, resolved: resolved !== false })),
  );

  // ======================================================================
  // Changes & webhooks
  // ======================================================================
  tool(
    'list_changes',
    {
      title: 'What changed',
      description:
        'Pages, databases and items changed after a time (oldest first), with who edited them and, for items, their current values. Use it at the start of a session to catch up on what people did in the app (e.g. tasks marked Done).',
      inputSchema: {
        since: z.string().describe('ISO date-time, e.g. 2026-11-09T18:00:00Z'),
        database_id: z.string().optional().describe('Only this database and its items'),
        limit: z.number().int().min(1).max(500).optional().describe('Default 100 (the most recent ones if there are more)'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ since, database_id, limit }) => {
      const r = await api.call('listChanges', { since, databaseId: database_id || null, limit: limit || 100 });
      return out({ ...r, changes: await withUrls(r.changes) });
    },
  );

  tool(
    'list_webhooks',
    {
      title: 'List webhooks',
      description: 'Webhooks of this workspace with their events and last delivery status.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => out({ webhooks: await api.call('listWebhooks', {}) }),
  );

  tool(
    'create_webhook',
    {
      title: 'Create webhook',
      description:
        'POST a JSON list of events to an https URL whenever things change: item.updated (with the changed properties, e.g. Status from "In progress" to "Done"), item.created, item.archived, page.*, database.*, comment.added, comment.resolved, or "*". Optionally only for one database. Each request is signed: X-Webhook-Signature = "sha256=" + HMAC-SHA256(secret, timestamp + "." + body), with X-Webhook-Timestamp. The secret is only shown in this result.',
      inputSchema: {
        url: z.string().describe('https:// endpoint'),
        events: z.array(z.string()).optional().describe('Default ["*"]'),
        database_id: z.string().optional(),
        description: z.string().optional(),
      },
    },
    async ({ url, events, database_id, description }) => out({ created: true, webhook: await api.call('createWebhook', defined({ url, events, databaseId: database_id, description })) }),
  );

  tool(
    'delete_webhook',
    {
      title: 'Delete webhook',
      description: 'Stop a webhook.',
      inputSchema: { webhook_id: z.string() },
      annotations: { destructiveHint: true },
    },
    async ({ webhook_id }) => out(await api.call('deleteWebhook', { webhookId: webhook_id })),
  );

  return server;
}
