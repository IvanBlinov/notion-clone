// Storage-independent page model for one workspace. The Convex functions load a
// workspace's pages into it, run one operation, and write back what changed.
import { markdownToBlocks, blocksToMarkdown, sanitizeBlock, newId, BLOCK_TYPES } from './markdown.js';

export class NotFoundError extends Error {
  constructor(msg) {
    super(msg);
    this.status = 404;
  }
}
export class ConflictError extends Error {
  constructor(page) {
    super('Page was changed by someone else');
    this.status = 409;
    this.page = page;
  }
}
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const now = () => new Date().toISOString();

/** Who is making a change. `client` identifies the browser tab / agent so it can ignore its own events. */
export const SYSTEM = { client: 'system', kind: 'system', name: 'system' };
const actorOf = (a) => (a && typeof a === 'object' ? a : { client: String(a || 'api'), kind: a === 'agent' ? 'agent' : 'user', name: '' });
const editorName = (a) => (a.kind === 'agent' ? 'agent' : a.name || 'user');

/**
 * One workspace's pages, held in memory. All methods are synchronous.
 *
 * Sub-pages are mirrored as `page` blocks inside their parent's content (like
 * Notion). The order of those blocks is the order of the sub-pages in the sidebar.
 */
export class WorkspaceModel {
  /** @param pages map of page id -> page */
  constructor(pages = {}) {
    this.data = { pages };
  }
  /** Give sub-pages created before page blocks existed their blocks (used on import). */
  normalize() {
    for (const p of Object.values(this.data.pages)) this.#syncChildren(p, 'positions');
  }
  #changed() {}

  // ---------- helpers ----------
  #page(id) {
    const p = this.data.pages[id];
    if (!p) throw new NotFoundError(`No page with id "${id}"`);
    return p;
  }
  #children(parentId) {
    return Object.values(this.data.pages)
      .filter((p) => (p.parentId || null) === (parentId || null))
      .sort((a, b) => a.position - b.position);
  }
  #isHidden(p) {
    for (let cur = p; cur; cur = cur.parentId ? this.data.pages[cur.parentId] : null) {
      if (cur.archivedAt) return true;
    }
    return false;
  }
  #ancestors(p) {
    const out = [];
    for (let cur = p.parentId ? this.data.pages[p.parentId] : null; cur; cur = cur.parentId ? this.data.pages[cur.parentId] : null) {
      out.unshift(cur);
    }
    return out;
  }
  #descendants(id) {
    const out = [];
    const walk = (pid) => {
      for (const c of this.#children(pid)) {
        out.push(c);
        walk(c.id);
      }
    };
    walk(id);
    return out;
  }
  #summary(p) {
    return { id: p.id, title: p.title, icon: p.icon, parentId: p.parentId || null };
  }
  #touch(p, actor) {
    p.version = (p.version || 0) + 1;
    p.updatedAt = now();
    if (actor) p.lastEditedBy = editorName(actor);
  }
  #placeAt(p, parentId, index) {
    const siblings = this.#children(parentId).filter((s) => s.id !== p.id);
    const i = index == null ? siblings.length : Math.max(0, Math.min(siblings.length, index));
    siblings.splice(i, 0, p);
    siblings.forEach((s, k) => (s.position = k));
    p.parentId = parentId || null;
  }
  #full(p) {
    return {
      ...p,
      breadcrumb: this.#ancestors(p).map((a) => this.#summary(a)),
      children: this.#children(p.id)
        .filter((c) => !c.archivedAt)
        .map((c) => this.#summary(c)),
      archived: this.#isHidden(p),
    };
  }
  #blockIndex(p, blockId) {
    const i = p.blocks.findIndex((b) => b.id === blockId);
    if (i < 0) throw new NotFoundError(`No block "${blockId}" on page "${p.id}"`);
    return i;
  }

  /**
   * Make a page's `page` blocks match its live sub-pages: drop stale/foreign/duplicate
   * ones, add missing ones, refresh cached titles. `order`:
   *  - 'blocks'    → sub-page order follows block order (content edits)
   *  - 'positions' → block order follows sub-page positions (sidebar moves)
   * Returns true when the page's blocks changed (its version is bumped).
   */
  #syncChildren(p, order = 'blocks', actor = null) {
    if (!p) return false;
    const before = JSON.stringify(p.blocks);
    const kids = this.#children(p.id).filter((c) => !c.archivedAt);
    const kidIds = new Set(kids.map((k) => k.id));
    const seen = new Set();
    p.blocks = p.blocks.filter((b) => {
      if (b.type !== 'page') return true;
      if (!kidIds.has(b.pageId) || seen.has(b.pageId)) return false;
      seen.add(b.pageId);
      return true;
    });
    for (const k of kids) if (!seen.has(k.id)) p.blocks.push({ id: newId(), type: 'page', pageId: k.id, text: k.title || '' });
    if (order === 'positions') {
      const slots = [];
      const byPage = new Map();
      p.blocks.forEach((b, i) => {
        if (b.type === 'page') {
          slots.push(i);
          byPage.set(b.pageId, b);
        }
      });
      kids.forEach((k, j) => (p.blocks[slots[j]] = byPage.get(k.id)));
    }
    let pos = 0;
    for (const b of p.blocks) {
      if (b.type !== 'page') continue;
      const c = this.data.pages[b.pageId];
      b.text = c.title || '';
      c.position = pos++;
    }
    for (const c of this.#children(p.id)) if (c.archivedAt) c.position = pos++;
    const changed = JSON.stringify(p.blocks) !== before;
    if (changed) this.#touch(p, actor);
    return changed;
  }
  #syncParent(child, order, actor) {
    const parent = child.parentId ? this.data.pages[child.parentId] : null;
    return parent && this.#syncChildren(parent, order, actor) ? parent.id : null;
  }

  // ---------- read ----------
  listTree() {
    const build = (parentId) =>
      this.#children(parentId)
        .filter((p) => !p.archivedAt)
        .map((p) => ({ ...this.#summary(p), favorite: !!p.favorite, updatedAt: p.updatedAt, children: build(p.id) }));
    return build(null);
  }

  listTrash() {
    return Object.values(this.data.pages)
      .filter((p) => p.archivedAt && !this.#ancestors(p).some((a) => a.archivedAt))
      .sort((a, b) => b.archivedAt.localeCompare(a.archivedAt))
      .map((p) => ({ ...this.#summary(p), archivedAt: p.archivedAt, path: this.#ancestors(p).map((a) => a.title || 'Untitled') }));
  }

  hasPage(id) {
    return !!this.data.pages[id];
  }

  getPage({ pageId }) {
    return this.#full(this.#page(pageId));
  }

  getPageMarkdown({ pageId }) {
    return blocksToMarkdown(this.#page(pageId).blocks);
  }

  search({ query = '', limit = 20 } = {}) {
    const q = String(query).trim().toLowerCase();
    const pages = Object.values(this.data.pages).filter((p) => !this.#isHidden(p));
    if (!q) {
      return pages
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, limit)
        .map((p) => ({ ...this.#summary(p), snippet: '', path: this.#ancestors(p).map((a) => a.title || 'Untitled'), updatedAt: p.updatedAt }));
    }
    const results = [];
    for (const p of pages) {
      const inTitle = (p.title || '').toLowerCase().includes(q);
      const hit = p.blocks.find((b) => b.type !== 'page' && (b.text || '').toLowerCase().includes(q));
      if (!inTitle && !hit) continue;
      let snippet = '';
      if (hit) {
        const t = hit.text;
        const at = t.toLowerCase().indexOf(q);
        snippet = (at > 40 ? '…' : '') + t.slice(Math.max(0, at - 40), at + q.length + 60).replace(/\s+/g, ' ');
      }
      results.push({
        ...this.#summary(p),
        snippet,
        blockId: hit?.id || null,
        score: inTitle ? 2 : 1,
        path: this.#ancestors(p).map((a) => a.title || 'Untitled'),
        updatedAt: p.updatedAt,
      });
    }
    return results.sort((a, b) => b.score - a.score || b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
  }

  // ---------- pages ----------
  createPage({ title = '', parentId = null, icon = '', markdown = '', blocks = null, index = null, afterBlockId = null } = {}, actorArg) {
    const actor = actorOf(actorArg);
    const parent = parentId ? this.#page(parentId) : null;
    if (afterBlockId && parent) this.#blockIndex(parent, afterBlockId);
    const p = {
      id: newId(),
      title: String(title),
      icon: String(icon || ''),
      parentId: parentId || null,
      position: 0,
      blocks: (blocks ? blocks.map(sanitizeBlock) : markdownToBlocks(markdown)).filter((b) => b.type !== 'page'),
      favorite: false,
      archivedAt: null,
      createdAt: now(),
      updatedAt: now(),
      createdBy: editorName(actor),
      lastEditedBy: editorName(actor),
      version: 1,
    };
    this.data.pages[p.id] = p;
    this.#placeAt(p, parentId, index);
    if (parent) {
      if (afterBlockId) {
        parent.blocks.splice(this.#blockIndex(parent, afterBlockId) + 1, 0, { id: newId(), type: 'page', pageId: p.id, text: p.title });
        this.#syncChildren(parent, 'blocks', actor);
      } else {
        this.#syncChildren(parent, 'positions', actor);
      }
    }
    this.#changed(actor, [p.id, parentId], true);
    return this.#full(p);
  }

  updatePage({ pageId, title, icon, parentId, index, favorite } = {}, actorArg) {
    const actor = actorOf(actorArg);
    const p = this.#page(pageId);
    const changedIds = [p.id];
    let tree = false;
    if (title !== undefined) {
      p.title = String(title);
      tree = true;
    }
    if (icon !== undefined) {
      p.icon = String(icon || '');
      tree = true;
    }
    if (favorite !== undefined) {
      p.favorite = !!favorite;
      tree = true;
    }
    if (parentId !== undefined || index !== undefined) {
      const oldParent = p.parentId;
      const target = parentId === undefined ? p.parentId : parentId || null;
      if (target) {
        this.#page(target);
        if (target === p.id || this.#descendants(p.id).some((d) => d.id === target)) throw bad('Cannot move a page inside itself');
      }
      this.#placeAt(p, target, index ?? null);
      if (oldParent && oldParent !== target) changedIds.push(this.#syncChildren(this.data.pages[oldParent], 'blocks', actor) && oldParent);
      tree = true;
    }
    changedIds.push(this.#syncParent(p, parentId !== undefined || index !== undefined ? 'positions' : 'blocks', actor));
    this.#touch(p, actor);
    this.#changed(actor, changedIds, tree);
    return this.#full(p);
  }

  /** Full save from the editor: optimistic concurrency via baseVersion. */
  savePage({ pageId, title, icon, blocks, baseVersion } = {}, actorArg) {
    const actor = actorOf(actorArg);
    const p = this.#page(pageId);
    if (baseVersion != null && baseVersion !== p.version) throw new ConflictError(this.#full(p));
    const changedIds = [p.id];
    const titleChanged = title !== undefined && title !== p.title;
    if (title !== undefined) p.title = String(title);
    if (icon !== undefined) p.icon = String(icon || '');
    let archived = [];
    if (Array.isArray(blocks)) {
      const next = blocks.map(sanitizeBlock);
      // page blocks the user deleted → move those sub-pages to the Trash
      const kept = new Set(next.filter((b) => b.type === 'page').map((b) => b.pageId));
      for (const b of p.blocks) {
        const child = b.type === 'page' && !kept.has(b.pageId) ? this.data.pages[b.pageId] : null;
        if (child && child.parentId === p.id && !child.archivedAt) {
          child.archivedAt = now();
          child.favorite = false;
          archived.push(child.id);
        }
      }
      p.blocks = next;
    }
    this.#syncChildren(p, 'blocks');
    this.#touch(p, actor);
    if (titleChanged || icon !== undefined) changedIds.push(this.#syncParent(p, 'blocks', actor));
    this.#changed(actor, [...changedIds, ...archived], titleChanged || icon !== undefined || archived.length > 0);
    return { version: p.version, updatedAt: p.updatedAt, blocks: p.blocks, archived };
  }

  duplicatePage({ pageId } = {}, actorArg) {
    const p = this.#page(pageId);
    const siblings = this.#children(p.parentId);
    return this.createPage(
      {
        title: (p.title || 'Untitled') + ' (copy)',
        icon: p.icon,
        parentId: p.parentId,
        blocks: p.blocks.filter((b) => b.type !== 'page').map((b) => ({ ...b, id: newId() })),
        index: siblings.indexOf(p) + 1,
      },
      actorArg,
    );
  }

  archivePage({ pageId } = {}, actorArg) {
    const actor = actorOf(actorArg);
    const p = this.#page(pageId);
    p.archivedAt = now();
    p.favorite = false;
    const parent = this.#syncParent(p, 'blocks', actor);
    this.#changed(actor, [p.id, p.parentId, parent, ...this.#descendants(p.id).map((d) => d.id)], true);
    return { ok: true, archived: this.#summary(p) };
  }

  restorePage({ pageId } = {}, actorArg) {
    const actor = actorOf(actorArg);
    const p = this.#page(pageId);
    p.archivedAt = null;
    if (p.parentId && (!this.data.pages[p.parentId] || this.#isHidden(this.data.pages[p.parentId]))) this.#placeAt(p, null, null);
    const parent = this.#syncParent(p, 'positions', actor);
    this.#changed(actor, [p.id, p.parentId, parent], true);
    return this.#full(p);
  }

  deletePage({ pageId } = {}, actorArg) {
    const actor = actorOf(actorArg);
    const p = this.#page(pageId);
    const ids = [p.id, ...this.#descendants(p.id).map((d) => d.id)];
    for (const id of ids) delete this.data.pages[id];
    const parent = p.parentId ? this.data.pages[p.parentId] : null;
    const parentChanged = parent && this.#syncChildren(parent, 'blocks', actor) ? parent.id : null;
    this.#changed(actor, [...ids, parentChanged], true);
    return { ok: true, deleted: ids.length };
  }

  emptyTrash(_args = {}, actorArg) {
    const ids = this.listTrash().map((t) => t.id);
    for (const id of ids) if (this.data.pages[id]) this.deletePage({ pageId: id }, actorArg);
    return { ok: true, deleted: ids.length };
  }

  // ---------- content ----------
  #contentChanged(p, actor) {
    this.#syncChildren(p, 'blocks');
    this.#touch(p, actor);
    this.#changed(actor, [p.id], true);
  }

  setContent({ pageId, markdown = '' } = {}, actorArg) {
    const actor = actorOf(actorArg);
    const p = this.#page(pageId);
    p.blocks = markdownToBlocks(markdown);
    this.#contentChanged(p, actor);
    return this.#full(p);
  }

  appendContent({ pageId, markdown = '', afterBlockId = null } = {}, actorArg) {
    const actor = actorOf(actorArg);
    const p = this.#page(pageId);
    const blocks = markdownToBlocks(markdown).filter((b) => b.type !== 'page');
    const at = afterBlockId ? this.#blockIndex(p, afterBlockId) + 1 : p.blocks.length;
    p.blocks.splice(at, 0, ...blocks);
    this.#contentChanged(p, actor);
    return { page: this.#full(p), inserted: blocks };
  }

  updateBlock({ pageId, blockId, markdown, text, type, checked, language, icon, indent, url } = {}, actorArg) {
    const actor = actorOf(actorArg);
    const p = this.#page(pageId);
    const i = this.#blockIndex(p, blockId);
    if (p.blocks[i].type === 'page') {
      if (text === undefined || markdown !== undefined || type !== undefined) {
        throw bad('This block is a sub-page. Use update_page to rename or move it, archive_page to remove it, or move_block to reposition it.');
      }
      const r = this.updatePage({ pageId: p.blocks[i].pageId, title: text }, actor);
      return { page: this.#full(p), blocks: [this.#page(pageId).blocks[i]], subpage: r };
    }
    let result;
    if (markdown !== undefined) {
      const parsed = markdownToBlocks(markdown).filter((b) => b.type !== 'page');
      if (parsed.length) parsed[0].id = blockId;
      p.blocks.splice(i, 1, ...parsed);
      result = parsed;
    } else {
      const b = { ...p.blocks[i] };
      if (type !== undefined) {
        if (!BLOCK_TYPES.includes(type) || type === 'page') throw bad(`Invalid block type "${type}". Use convert_block_to_page to turn a block into a sub-page.`);
        b.type = type;
      }
      if (text !== undefined) b.text = String(text);
      if (checked !== undefined) b.checked = !!checked;
      if (language !== undefined) b.language = String(language);
      if (icon !== undefined) b.icon = String(icon);
      if (indent !== undefined) b.indent = Number(indent) || 0;
      if (url !== undefined) b.url = String(url);
      p.blocks[i] = sanitizeBlock(b);
      result = [p.blocks[i]];
    }
    this.#contentChanged(p, actor);
    return { page: this.#full(p), blocks: result };
  }

  /** Deleting a sub-page block moves that sub-page to the Trash (same as in the editor). */
  deleteBlocks({ pageId, blockIds = [] } = {}, actorArg) {
    const actor = actorOf(actorArg);
    const p = this.#page(pageId);
    const set = new Set(blockIds);
    const missing = blockIds.filter((id) => !p.blocks.some((b) => b.id === id));
    if (missing.length) throw new NotFoundError(`Blocks not found: ${missing.join(', ')}`);
    const archived = [];
    for (const b of p.blocks) {
      if (set.has(b.id) && b.type === 'page' && this.data.pages[b.pageId]) {
        this.data.pages[b.pageId].archivedAt = now();
        this.data.pages[b.pageId].favorite = false;
        archived.push(b.pageId);
      }
    }
    p.blocks = p.blocks.filter((b) => !set.has(b.id));
    this.#contentChanged(p, actor);
    if (archived.length) this.#changed(actor, archived, true);
    return { ok: true, deleted: blockIds.length, archivedPages: archived };
  }

  moveBlock({ pageId, blockId, afterBlockId = null } = {}, actorArg) {
    const actor = actorOf(actorArg);
    const p = this.#page(pageId);
    const [b] = p.blocks.splice(this.#blockIndex(p, blockId), 1);
    const at = afterBlockId ? this.#blockIndex(p, afterBlockId) + 1 : 0;
    p.blocks.splice(at, 0, b);
    this.#contentChanged(p, actor);
    return this.#full(p);
  }

  /** Turn a text block (e.g. a list item) into a sub-page titled with the block's text. */
  blockToPage({ pageId, blockId } = {}, actorArg) {
    const actor = actorOf(actorArg);
    const p = this.#page(pageId);
    const i = this.#blockIndex(p, blockId);
    const b = p.blocks[i];
    if (b.type === 'page') throw bad('That block is already a page');
    if (b.type === 'divider') throw bad('A divider cannot become a page');
    const child = {
      id: newId(),
      title: String(b.text || '').replace(/\s+/g, ' ').trim(),
      icon: '',
      parentId: p.id,
      position: 0,
      blocks: [],
      favorite: false,
      archivedAt: null,
      createdAt: now(),
      updatedAt: now(),
      createdBy: editorName(actor),
      lastEditedBy: editorName(actor),
      version: 1,
    };
    this.data.pages[child.id] = child;
    p.blocks[i] = { id: b.id, type: 'page', pageId: child.id, text: child.title };
    this.#contentChanged(p, actor);
    this.#changed(actor, [child.id], true);
    return this.#full(child);
  }

  // ---------- seed ----------
  seed() {
    const welcome = this.createPage(
      {
        title: 'Welcome',
        icon: '👋',
        markdown: `This is your workspace. It works like Notion — and an **AI agent can create and edit every page** through MCP.

## The basics

- Type \`/\` in any block to pick a block type — choose **Page** to add a sub-page right here
- Markdown shortcuts work: \`# \` heading, \`- \` bullet, \`1. \` list, \`[] \` to-do, \`> \` quote, three backticks for code, \`---\` divider
- **Ctrl+B**, *Ctrl+I*, \`Ctrl+E\` format the selected text
- Drag the ⋮⋮ handle to reorder blocks — drop a page block on a page in the sidebar to move it there
- Press **Ctrl+K** to search

## Collaborate

> [!👥] Open the workspace menu (top-left) → **Settings & members** to invite people and to connect an AI agent.

- [x] Open the workspace
- [ ] Invite a teammate
- [ ] Ask your agent to write a page for you

## Sub-pages`,
      },
      SYSTEM,
    );
    this.createPage(
      {
        title: 'Getting started with blocks',
        icon: '🧱',
        parentId: welcome.id,
        markdown: `# Heading 1

## Heading 2

### Heading 3

A plain paragraph with **bold**, *italic*, ~~strike~~, \`inline code\` and a [link](https://example.com).

> A quote block.

> [!WARNING] A callout block.

1. Numbered
2. List
  - Nested bullet

---

\`\`\`js
console.log('code block');
\`\`\``,
      },
      SYSTEM,
    );
  }
}
