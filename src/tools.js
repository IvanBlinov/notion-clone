import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { blocksToMarkdown, blockToMarkdown, BLOCK_TYPES } from './shared/markdown.js';

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

const INSTRUCTIONS = `This server is a Notion-style workspace. You can read, create, edit, move and archive pages.

Pages form a tree (a page can have sub-pages). Page content is a flat list of blocks, and you read/write it as Markdown:
- "# ", "## ", "### " headings
- "- " bullets, "1. " numbered items, "- [ ] " / "- [x] " to-dos (indent 2 spaces per level)
- "> " quote; "> [!NOTE] text" (or "> [!💡] text" with any emoji) is a callout
- \`\`\`lang fenced code, "---" divider, "![caption](url)" image
- Inline: **bold**, *italic*, ~~strike~~, \`code\`, [link](url)
- Sub-pages appear inside their parent's content as page blocks, written "[Title](page:ID)" on their own line.
  Their order in the content is their order in the sidebar. You cannot create sub-pages by writing these lines —
  use create_page (with parent_id and optionally after_block_id) or convert_block_to_page. In replace_page_content,
  keep the "[Title](page:ID)" lines where you want those sub-pages; any you leave out are kept at the end of the page.
  Deleting a page block with delete_blocks moves that sub-page to the Trash.

Workflow tips:
- Use list_pages or search_pages to find page ids. Never guess ids.
- get_page with format "blocks" shows each block's id so you can make precise edits with update_block, delete_blocks, move_block or append_content(after_block_id).
- For large rewrites use replace_page_content. To add to the end use append_content.
- archive_page moves a page (and its sub-pages) to the Trash; restore_page brings it back.
The user sees your edits live in their browser.`;

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const errorText = (s) => ({ content: [{ type: 'text', text: s }], isError: true });
const label = (p) => `${p.icon ? p.icon + ' ' : ''}${p.title || 'Untitled'}`;

function treeToText(nodes, depth = 0) {
  return nodes
    .map((n) => `${'  '.repeat(depth)}- ${label(n)} (id: ${n.id})\n${treeToText(n.children || [], depth + 1)}`)
    .join('');
}

function pageHeader(p) {
  const lines = [`# ${label(p)}`, `id: ${p.id}`];
  lines.push(`location: ${p.breadcrumb.length ? p.breadcrumb.map(label).join(' / ') + ` (parent id: ${p.parentId})` : 'top level'}`);
  if (p.archived) lines.push('status: in Trash (archived)');
  if (p.children.length) lines.push(`sub-pages: ${p.children.map((c) => `${label(c)} (id: ${c.id})`).join(', ')}`);
  lines.push(`last edited: ${p.updatedAt} by ${p.lastEditedBy || 'user'}`);
  return lines.join('\n');
}

function blocksListing(blocks) {
  if (!blocks.length) return '(page is empty)';
  return blocks
    .map((b) => {
      const md = blockToMarkdown(b).replace(/\n/g, '\n    ');
      return `[${b.id}] (${b.type}) ${md}`;
    })
    .join('\n');
}

function renderPage(p, format = 'markdown') {
  const body = format === 'blocks' ? blocksListing(p.blocks) : blocksToMarkdown(p.blocks) || '(page is empty)';
  return `${pageHeader(p)}\n\n---- content (${format}) ----\n${body}`;
}

export function createMcpServer(api) {
  const server = new McpServer({ name: 'notion-clone', version: '1.0.0' }, { instructions: INSTRUCTIONS });

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

  tool(
    'list_pages',
    {
      title: 'List pages',
      description: 'Show the whole page tree of the workspace with page ids. Optionally include pages in the Trash.',
      inputSchema: { include_trash: z.boolean().optional().describe('Also list archived pages in the Trash') },
      annotations: { readOnlyHint: true },
    },
    async ({ include_trash }) => {
      const tree = await api.call('listTree', {});
      let out = tree.length ? treeToText(tree) : '(workspace has no pages)\n';
      if (include_trash) {
        const trash = await api.call('listTrash', {});
        out += `\nTrash:\n${trash.length ? trash.map((t) => `- ${label(t)} (id: ${t.id}) archived ${t.archivedAt}`).join('\n') : '(empty)'}`;
      }
      return text(out);
    },
  );

  tool(
    'search_pages',
    {
      title: 'Search pages',
      description: 'Full-text search over page titles and content. An empty query returns recently edited pages.',
      inputSchema: {
        query: z.string().describe('Text to look for'),
        limit: z.number().int().min(1).max(100).optional().describe('Max results (default 20)'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit }) => {
      const results = await api.call('search', { query, limit: limit || 20 });
      if (!results.length) return text(`No pages match "${query}".`);
      return text(
        results
          .map(
            (r) =>
              `- ${label(r)} (id: ${r.id})${r.path.length ? ` in ${r.path.join(' / ')}` : ''}${r.snippet ? `\n    ${r.snippet}` : ''}${r.blockId ? ` [block ${r.blockId}]` : ''}`,
          )
          .join('\n'),
      );
    },
  );

  tool(
    'get_page',
    {
      title: 'Read page',
      description:
        'Read a page: title, location, sub-pages and content. format "markdown" (default) returns clean Markdown; "blocks" lists every block with its id, which you need for update_block / delete_blocks / move_block / append_content(after_block_id).',
      inputSchema: { page_id: pageId, format: z.enum(['markdown', 'blocks']).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ page_id, format }) => text(renderPage(await api.call('getPage', { pageId: page_id }), format || 'markdown')),
  );

  tool(
    'create_page',
    {
      title: 'Create page',
      description:
        "Create a new page with Markdown content. With parent_id it becomes a sub-page and appears as a page block in the parent's content (at the end, or right after after_block_id).",
      inputSchema: {
        title: z.string().describe('Page title'),
        content: z.string().optional().describe('Page body as Markdown'),
        parent_id: z.string().optional().describe('Create as a sub-page of this page id; omit for a top-level page'),
        after_block_id: z.string().optional().describe("Place the sub-page's block right after this block of the parent page"),
        icon: z.string().optional().describe('An emoji used as the page icon, e.g. "📝"'),
      },
    },
    async ({ title, content, parent_id, after_block_id, icon }) => {
      const p = await api.call('createPage', {
        title,
        markdown: content || '',
        parentId: parent_id || null,
        afterBlockId: (parent_id && after_block_id) || null,
        icon: icon || '',
      });
      return text(`Created page ${label(p)} (id: ${p.id})${p.parentId ? ` under parent ${p.parentId}` : ''} with ${p.blocks.length} blocks.`);
    },
  );

  tool(
    'convert_block_to_page',
    {
      title: 'Turn block into sub-page',
      description:
        'Turn a block (e.g. a list item or paragraph) into a sub-page titled with the block\'s text. The block becomes a page block at the same spot. Returns the new page id so you can fill it with append_content.',
      inputSchema: { page_id: pageId, block_id: z.string() },
    },
    async ({ page_id, block_id }) => {
      const p = await api.call('blockToPage', { pageId: page_id, blockId: block_id });
      return text(`Created sub-page ${label(p)} (id: ${p.id}) in place of block ${block_id}.`);
    },
  );

  tool(
    'update_page',
    {
      title: 'Rename / move page',
      description:
        'Change a page\'s title or icon, or move it: set parent_id to another page id to nest it, or to "root" to make it top-level. index sets the position among its siblings (0 = first).',
      inputSchema: {
        page_id: pageId,
        title: z.string().optional(),
        icon: z.string().optional().describe('Emoji icon; empty string removes it'),
        parent_id: z.string().optional().describe('New parent page id, or "root"'),
        index: z.number().int().min(0).optional(),
      },
    },
    async ({ page_id, title, icon, parent_id, index }) => {
      const args = { pageId: page_id, title, icon, index };
      if (parent_id !== undefined) args.parentId = parent_id === 'root' || parent_id === '' ? null : parent_id;
      const p = await api.call('updatePage', args);
      return text(`Updated page ${label(p)} (id: ${p.id}). Location: ${p.breadcrumb.length ? p.breadcrumb.map(label).join(' / ') : 'top level'}.`);
    },
  );

  tool(
    'replace_page_content',
    {
      title: 'Replace page content',
      description:
        'Overwrite the entire body of a page with new Markdown. Block ids are regenerated. Use for full rewrites. Keep "[Title](page:ID)" lines to position sub-pages; omitted sub-pages are kept at the end.',
      inputSchema: { page_id: pageId, content: z.string().describe('The full new page body as Markdown') },
      annotations: { destructiveHint: true },
    },
    async ({ page_id, content }) => {
      const p = await api.call('setContent', { pageId: page_id, markdown: content });
      return text(`Replaced content of ${label(p)} (id: ${p.id}); it now has ${p.blocks.length} blocks.`);
    },
  );

  tool(
    'append_content',
    {
      title: 'Add content',
      description: 'Insert Markdown content into a page — at the end by default, or right after a given block id.',
      inputSchema: {
        page_id: pageId,
        content: z.string().describe('Markdown to insert'),
        after_block_id: z.string().optional().describe('Insert after this block (ids from get_page format "blocks")'),
      },
    },
    async ({ page_id, content, after_block_id }) => {
      const { page, inserted } = await api.call('appendContent', { pageId: page_id, markdown: content, afterBlockId: after_block_id || null });
      return text(`Inserted ${inserted.length} block(s) into ${label(page)}: ${inserted.map((b) => b.id).join(', ')}`);
    },
  );

  tool(
    'update_block',
    {
      title: 'Edit block',
      description:
        'Edit one block. Either pass `markdown` to replace the block with parsed Markdown (may become several blocks), or patch fields: text (inline Markdown allowed), type, checked (to-dos), language (code), icon (callouts), indent (lists, 0-4).',
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
      const { blocks } = await api.call('updateBlock', { pageId: page_id, blockId: block_id, ...patch });
      return text(blocks.length ? `Block updated:\n${blocksListing(blocks)}` : `Block ${block_id} removed (markdown was empty).`);
    },
  );

  tool(
    'delete_blocks',
    {
      title: 'Delete blocks',
      description: 'Delete one or more blocks from a page by id. Deleting a sub-page block moves that sub-page to the Trash.',
      inputSchema: { page_id: pageId, block_ids: z.array(z.string()).min(1) },
      annotations: { destructiveHint: true },
    },
    async ({ page_id, block_ids }) => {
      const r = await api.call('deleteBlocks', { pageId: page_id, blockIds: block_ids });
      return text(`Deleted ${r.deleted} block(s).${r.archivedPages?.length ? ` Moved ${r.archivedPages.length} sub-page(s) to the Trash.` : ''}`);
    },
  );

  tool(
    'move_block',
    {
      title: 'Move block',
      description: 'Reorder a block within its page: place it right after another block, or at the very top if after_block_id is omitted.',
      inputSchema: { page_id: pageId, block_id: z.string(), after_block_id: z.string().optional() },
    },
    async ({ page_id, block_id, after_block_id }) => {
      await api.call('moveBlock', { pageId: page_id, blockId: block_id, afterBlockId: after_block_id || null });
      return text(`Moved block ${block_id}${after_block_id ? ` after ${after_block_id}` : ' to the top'}.`);
    },
  );

  tool(
    'archive_page',
    {
      title: 'Move page to Trash',
      description: 'Move a page and all its sub-pages to the Trash. Reversible with restore_page.',
      inputSchema: { page_id: pageId },
      annotations: { destructiveHint: true },
    },
    async ({ page_id }) => {
      const r = await api.call('archivePage', { pageId: page_id });
      return text(`Moved ${label(r.archived)} to the Trash.`);
    },
  );

  tool(
    'restore_page',
    {
      title: 'Restore page from Trash',
      description: 'Bring an archived page back out of the Trash.',
      inputSchema: { page_id: pageId },
    },
    async ({ page_id }) => {
      const p = await api.call('restorePage', { pageId: page_id });
      return text(`Restored ${label(p)} (id: ${p.id}).`);
    },
  );

  return server;
}
