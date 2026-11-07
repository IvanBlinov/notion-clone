// Storage-independent page model for one workspace. The Convex functions load a
// workspace's pages into it, run one operation, and write back what changed.
import { markdownToBlocks, blocksToMarkdown, sanitizeBlock, newId, BLOCK_TYPES } from './markdown.js';
import * as DB from './database.js';

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
  constructor(pages = {}, members = []) {
    this.data = { pages };
    /** Workspace members [{ id, name, email, color }] — for person properties. */
    this.members = members;
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
    return { id: p.id, title: p.title, icon: p.icon, parentId: p.parentId || null, kind: this.#kind(p) };
  }
  /** 'database', 'row' (a page inside a database) or 'page'. */
  #kind(p) {
    if (p.database) return 'database';
    return p.parentId && this.data.pages[p.parentId]?.database ? 'row' : 'page';
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
    const parent = p.parentId ? this.data.pages[p.parentId] : null;
    return {
      ...p,
      kind: this.#kind(p),
      ...(parent?.database ? { row: { databaseId: parent.id, databaseTitle: parent.title, titleName: parent.database.titleName, properties: parent.database.properties, members: this.members }, properties: this.#rowOut(p, parent).properties } : {}),
      ...(p.database ? { rowCount: this.#children(p.id).filter((c) => !c.archivedAt).length } : {}),
      breadcrumb: this.#ancestors(p).map((a) => this.#summary(a)),
      children: (p.database ? [] : this.#children(p.id))
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
    if (p.database) {
      // A database's children are its rows: shown in its views, never as page blocks.
      p.blocks = p.blocks.filter((b) => b.type !== 'page');
      const changed = JSON.stringify(p.blocks) !== before;
      if (changed) this.#touch(p, actor);
      return changed;
    }
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
        .map((p) => ({ ...this.#summary(p), favorite: !!p.favorite, updatedAt: p.updatedAt, children: p.database ? [] : build(p.id) }));
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

  search({ query = '', limit = 20, parentId = null, kinds = null } = {}) {
    const q = String(query).trim().toLowerCase();
    const pages = Object.values(this.data.pages).filter(
      (p) => !this.#isHidden(p) && (!parentId || this.#ancestors(p).some((a) => a.id === parentId)) && (!kinds || kinds.includes(this.#kind(p))),
    );
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
    const copy = this.createPage(
      {
        title: (p.title || 'Untitled') + ' (copy)',
        icon: p.icon,
        parentId: p.parentId,
        blocks: p.blocks.filter((b) => b.type !== 'page').map((b) => ({ ...b, id: newId() })),
        index: siblings.indexOf(p) + 1,
      },
      actorArg,
    );
    const raw = this.data.pages[copy.id];
    if (p.props) raw.props = structuredClone(p.props);
    if (p.database) {
      raw.database = { ...structuredClone(p.database), idem: {} };
      for (const r of this.#children(p.id).filter((c) => !c.archivedAt)) {
        const row = this.createPage({ title: r.title, icon: r.icon, parentId: copy.id, blocks: r.blocks.filter((b) => b.type !== 'page') }, actorArg);
        this.data.pages[row.id].props = structuredClone(r.props || {});
      }
    }
    return this.#full(raw);
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
  #expectVersion(p, expected) {
    if (expected == null || expected === p.version) return;
    throw Object.assign(new Error(`Version conflict: you read version ${expected} of "${p.title || 'Untitled'}", but it is now at version ${p.version} (edited by ${p.lastEditedBy || 'someone'}). Read the page again and retry.`), { status: 409 });
  }
  #contentChanged(p, actor) {
    this.#syncChildren(p, 'blocks');
    this.#touch(p, actor);
    this.#changed(actor, [p.id], true);
  }

  setContent({ pageId, markdown = '', expectedVersion } = {}, actorArg) {
    const actor = actorOf(actorArg);
    const p = this.#page(pageId);
    this.#expectVersion(p, expectedVersion);
    p.blocks = markdownToBlocks(markdown);
    this.#contentChanged(p, actor);
    return this.#full(p);
  }

  appendContent({ pageId, markdown = '', afterBlockId = null, expectedVersion } = {}, actorArg) {
    const actor = actorOf(actorArg);
    const p = this.#page(pageId);
    this.#expectVersion(p, expectedVersion);
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
    if (p.database) throw bad('Blocks of a database page cannot become pages; add rows with create_database_items');
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

  // ---------- batches ----------
  /**
   * Create up to 100 pages in one go. Each item may set `key` and point at an
   * earlier item with `parentKey`, so a whole tree can be created in one call.
   * Returns one result per item ({ index, status: 'created' | 'failed', id | error }).
   */
  createPages({ pages = [] } = {}, actorArg) {
    if (!Array.isArray(pages) || !pages.length) throw bad('pages must be a non-empty list');
    if (pages.length > 100) throw bad('At most 100 pages per call');
    const keys = new Map();
    return pages.map((item, index) => {
      try {
        const parentId = item.parentKey != null ? keys.get(String(item.parentKey)) : item.parentId || null;
        if (item.parentKey != null && !parentId) throw bad(`parent_key "${item.parentKey}" doesn't match an earlier item`);
        const p = this.createPage({ title: item.title || '', icon: item.icon || '', markdown: item.markdown || '', parentId, afterBlockId: item.afterBlockId || null }, actorArg);
        if (item.key != null) keys.set(String(item.key), p.id);
        return { index, status: 'created', id: p.id, title: p.title, parentId: p.parentId, ...(item.key != null ? { key: item.key } : {}) };
      } catch (err) {
        return { index, status: 'failed', error: err.message, ...(item.key != null ? { key: item.key } : {}) };
      }
    });
  }

  // ---------- databases ----------
  #db(pageId) {
    const p = this.#page(pageId);
    if (!p.database) throw bad(`"${p.title || pageId}" is not a database. Create one with create_database.`);
    return p;
  }
  #valueCtx(actor) {
    return { members: this.members, me: actor?.userId || null };
  }
  #rows(db) {
    return this.#children(db.id).filter((c) => !c.archivedAt);
  }
  /** A row as tools see it: property values by property name. */
  #rowOut(row, db) {
    const properties = {};
    for (const prop of [DB.titleProp(db.database), ...db.database.properties]) properties[prop.name] = DB.displayValue(prop, DB.rawValue(row, prop), this.members);
    return {
      id: row.id,
      title: row.title,
      icon: row.icon || '',
      properties,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lastEditedBy: row.lastEditedBy,
      version: row.version,
      hasContent: row.blocks.some((b) => b.type !== 'page' && (b.text || b.url)),
    };
  }
  #schemaOut(db) {
    const d = db.database;
    return {
      id: db.id,
      title: db.title,
      icon: db.icon,
      parentId: db.parentId || null,
      titleProperty: d.titleName,
      properties: d.properties.map((p) => ({ id: p.id, name: p.name, type: p.type, ...(p.options ? { options: p.options.map((o) => o.name) } : {}) })),
      views: d.views.map((v) => this.#viewOut(db, v)),
      rowCount: this.#rows(db).length,
      version: db.version,
    };
  }
  #viewOut(db, v) {
    const name = (id) => DB.resolveProp(db.database, id).name;
    const f = (list) => list.map((x) => (x.or ? { or: f(x.or) } : x.and ? { and: f(x.and) } : { ...x, property: name(x.property) }));
    return {
      id: v.id,
      name: v.name,
      type: v.type,
      ...(v.groupBy ? { groupBy: name(v.groupBy) } : {}),
      filters: f(v.filters || []),
      sorts: (v.sorts || []).map((s) => ({ ...s, property: name(s.property) })),
      ...(v.visible ? { visibleProperties: v.visible.map(name) } : {}),
    };
  }
  /** Parse { propertyName: value } into stored props (adds new select options as needed). */
  #parseProps(db, input, actor, into = {}) {
    let title;
    for (const [key, value] of Object.entries(input || {})) {
      const prop = DB.resolveProp(db.database, key, { allowPseudo: false });
      if (prop.type === 'title') title = value == null ? '' : String(value);
      else {
        const v = DB.parseValue(prop, value, this.#valueCtx(actor));
        if (v == null || (Array.isArray(v) && !v.length)) delete into[prop.id];
        else into[prop.id] = v;
      }
    }
    return { props: into, title };
  }

  createDatabase({ title = '', icon = '', parentId = null, afterBlockId = null, index = null, titleName = 'Name', properties = [], views = [], markdown = '' } = {}, actorArg) {
    const actor = actorOf(actorArg);
    const database = { titleName: String(titleName || 'Name').slice(0, 60), properties: [], views: [], idem: {} };
    for (const spec of properties || []) database.properties.push(DB.makeProperty(database, spec));
    database.views.push(DB.makeView(database, { name: 'All', type: 'table' }));
    for (const spec of views || []) database.views.push(DB.makeView(database, spec));
    const created = this.createPage({ title, icon, parentId, afterBlockId, index, markdown }, actor);
    const p = this.data.pages[created.id];
    p.database = database;
    return this.#schemaOut(p);
  }

  getDatabase({ pageId } = {}) {
    return this.#schemaOut(this.#db(pageId));
  }

  updateDatabase({ pageId, title, icon, titleName, addProperties = [], updateProperties = [], removeProperties = [] } = {}, actorArg) {
    const actor = actorOf(actorArg);
    const p = this.#db(pageId);
    const d = p.database;
    const taken = (n, except) => [DB.titleProp(d), ...d.properties].some((x) => x.id !== except && x.name.toLowerCase() === String(n).trim().toLowerCase());
    if (title !== undefined || icon !== undefined) this.updatePage({ pageId, title, icon }, actor);
    if (titleName !== undefined) {
      if (!String(titleName).trim() || taken(titleName, 'title')) throw bad(`Can't name the title column "${titleName}"`);
      d.titleName = String(titleName).trim().slice(0, 60);
    }
    for (const spec of addProperties || []) d.properties.push(DB.makeProperty(d, spec));
    for (const u of updateProperties || []) {
      const prop = DB.resolveProp(d, u.property, { allowPseudo: false });
      if (prop.type === 'title') {
        if (u.name) {
          if (taken(u.name, 'title')) throw bad(`A property named "${u.name}" already exists`);
          d.titleName = String(u.name).trim().slice(0, 60);
        }
        continue;
      }
      if (u.name !== undefined && u.name !== prop.name) {
        if (!String(u.name).trim() || taken(u.name, prop.id)) throw bad(`Can't rename "${prop.name}" to "${u.name}"`);
        prop.name = String(u.name).trim().slice(0, 60);
      }
      if (u.type !== undefined && u.type !== prop.type) {
        // convert values through their text form; values that don't fit are cleared
        const next = DB.makeProperty({ titleName: '\u0000', properties: [] }, { name: prop.name, type: u.type });
        for (const r of this.#children(p.id)) {
          const old = r.props?.[prop.id];
          if (old == null) continue;
          let v = null;
          try {
            v = next.type === 'checkbox' ? !!old : DB.parseValue(next, DB.valueText(prop, old, this.members), this.#valueCtx(actor));
          } catch {}
          if (v == null || (Array.isArray(v) && !v.length)) delete r.props[prop.id];
          else r.props[prop.id] = v;
        }
        prop.type = next.type;
        delete prop.options;
        if (next.options) prop.options = next.options;
        for (const v of d.views) {
          if (v.groupBy === prop.id && !DB.GROUPABLE.includes(prop.type)) {
            v.groupBy = null;
            if (v.type === 'board') v.type = 'table';
          }
        }
      }
      if (u.options && prop.options) for (const o of u.options) DB.addOption(prop, typeof o === 'string' ? o : o.name, o?.color);
      if (u.renameOptions && prop.options) {
        for (const [from, to] of Object.entries(u.renameOptions)) {
          const o = prop.options.find((x) => x.id === from || x.name.toLowerCase() === from.toLowerCase());
          if (!o) throw bad(`"${prop.name}" has no option "${from}"`);
          o.name = String(to).trim().slice(0, 60) || o.name;
        }
      }
      if (u.optionColors && prop.options) {
        for (const [n, color] of Object.entries(u.optionColors)) {
          const o = prop.options.find((x) => x.id === n || x.name.toLowerCase() === n.toLowerCase());
          if (o && DB.OPTION_COLORS.includes(color)) o.color = color;
        }
      }
      if (u.removeOptions && prop.options) {
        const gone = new Set(u.removeOptions.map((n) => prop.options.find((o) => o.id === n || o.name.toLowerCase() === String(n).toLowerCase())?.id).filter(Boolean));
        prop.options = prop.options.filter((o) => !gone.has(o.id));
        for (const r of this.#children(p.id)) {
          const v = r.props?.[prop.id];
          if (prop.type === 'select' && gone.has(v)) delete r.props[prop.id];
          if (prop.type === 'multi_select' && Array.isArray(v)) r.props[prop.id] = v.filter((id) => !gone.has(id));
        }
      }
      if (u.optionOrder && prop.options) {
        const rank = (o) => {
          const i = u.optionOrder.findIndex((n) => n === o.id || String(n).toLowerCase() === o.name.toLowerCase());
          return i < 0 ? Infinity : i;
        };
        prop.options.sort((a, b) => rank(a) - rank(b));
      }
    }
    for (const key of removeProperties || []) {
      const prop = DB.resolveProp(d, key, { allowPseudo: false });
      if (prop.type === 'title') throw bad('The title column cannot be removed');
      d.properties = d.properties.filter((x) => x.id !== prop.id);
      for (const r of this.#children(p.id)) if (r.props) delete r.props[prop.id];
      DB.forgetProperty(d, prop.id);
    }
    this.#touch(p, actor);
    return this.#schemaOut(p);
  }

  /** Everything the browser needs to draw a database's views. */
  databaseRows({ pageId } = {}) {
    const p = this.#db(pageId);
    return {
      id: p.id,
      version: p.version,
      database: p.database,
      members: this.members,
      rows: this.#rows(p).map((r) => ({
        id: r.id,
        title: r.title,
        icon: r.icon,
        props: r.props || {},
        position: r.position,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        lastEditedBy: r.lastEditedBy,
        hasContent: r.blocks.some((b) => b.type !== 'page' && (b.text || b.url)),
      })),
    };
  }

  /**
   * Create up to 300 rows. items: [{ title, icon, properties: { name: value }, markdown }].
   * Bad items are reported and skipped; the rest are created. Re-sending the same
   * idempotencyKey returns the first call's results instead of creating duplicates.
   */
  createRows({ pageId, items = [], idempotencyKey = null, afterRowId = null } = {}, actorArg) {
    const actor = actorOf(actorArg);
    const p = this.#db(pageId);
    const d = p.database;
    if (!Array.isArray(items) || !items.length) throw bad('items must be a non-empty list');
    if (items.length > 300) throw bad('At most 300 items per call; split larger imports');
    d.idem ||= {};
    const key = idempotencyKey ? String(idempotencyKey).slice(0, 100) : null;
    if (key && d.idem[key]) return { ...d.idem[key].result, replayed: true };
    let index = null;
    if (afterRowId) {
      const i = this.#rows(p).findIndex((r) => r.id === afterRowId);
      if (i >= 0) index = i + 1;
    }
    const results = items.map((item, i) => {
      try {
        const { props, title } = this.#parseProps(p, item.properties, actor);
        const row = this.createPage({ title: item.title ?? title ?? '', icon: item.icon || '', parentId: p.id, markdown: item.markdown || '', index }, actor);
        if (index != null) index++;
        this.data.pages[row.id].props = props;
        return { index: i, status: 'created', id: row.id, title: row.title };
      } catch (err) {
        return { index: i, status: 'failed', error: err.message };
      }
    });
    const result = { databaseId: p.id, created: results.filter((r) => r.status === 'created').length, failed: results.filter((r) => r.status === 'failed').length, results };
    if (key) {
      d.idem[key] = { at: now(), result };
      const keys = Object.keys(d.idem).sort((a, b) => d.idem[a].at.localeCompare(d.idem[b].at));
      while (keys.length > 20) delete d.idem[keys.shift()];
    }
    this.#touch(p, actor);
    return result;
  }

  /** updates: [{ itemId, title, icon, properties: { name: value } }]. Per-item results. */
  updateRows({ updates = [] } = {}, actorArg) {
    const actor = actorOf(actorArg);
    if (!Array.isArray(updates) || !updates.length) throw bad('updates must be a non-empty list');
    if (updates.length > 300) throw bad('At most 300 updates per call');
    const results = updates.map((u, index) => {
      try {
        const row = this.#page(u.itemId);
        const db = row.parentId ? this.data.pages[row.parentId] : null;
        if (!db?.database) throw bad(`"${row.title || row.id}" is not a database item`);
        const { props, title } = this.#parseProps(db, u.properties, actor, structuredClone(row.props || {}));
        row.props = props;
        if (title !== undefined) row.title = title;
        if (u.title !== undefined) row.title = String(u.title);
        if (u.icon !== undefined) row.icon = String(u.icon || '');
        this.#touch(row, actor);
        return { index, status: 'updated', id: row.id, item: this.#rowOut(row, db) };
      } catch (err) {
        return { index, status: 'failed', id: u?.itemId, error: err.message };
      }
    });
    return { updated: results.filter((r) => r.status === 'updated').length, failed: results.filter((r) => r.status === 'failed').length, results };
  }

  archiveRows({ itemIds = [] } = {}, actorArg) {
    if (!Array.isArray(itemIds) || !itemIds.length) throw bad('item_ids must be a non-empty list');
    const results = itemIds.map((id, index) => {
      try {
        const row = this.#page(id);
        if (!row.parentId || !this.data.pages[row.parentId]?.database) throw bad(`"${row.title || id}" is not a database item`);
        this.archivePage({ pageId: id }, actorArg);
        return { index, status: 'archived', id };
      } catch (err) {
        return { index, status: 'failed', id, error: err.message };
      }
    });
    return { archived: results.filter((r) => r.status === 'archived').length, failed: results.filter((r) => r.status === 'failed').length, results };
  }

  /** Filter / sort / search / paginate rows. A view's filters are AND-ed with extra filters. */
  queryDatabase({ pageId, viewId = null, filters = [], sorts = null, search = '', limit = 50, cursor = null } = {}, actorArg) {
    const actor = actorOf(actorArg);
    const p = this.#db(pageId);
    const d = p.database;
    const view = viewId ? d.views.find((v) => v.id === viewId || v.name.toLowerCase() === String(viewId).toLowerCase()) : null;
    if (viewId && !view) throw bad(`No view "${viewId}". Views: ${d.views.map((v) => `"${v.name}" (${v.id})`).join(', ')}`);
    const all = [...(view?.filters || []), ...DB.normalizeFilters(d, filters)];
    const order = sorts && sorts.length ? DB.normalizeSorts(d, sorts) : view?.sorts || [];
    const rows = DB.applyView(d, this.#rows(p), { filters: all, sorts: order, search }, this.#valueCtx(actor));
    const start = Math.max(0, Number(cursor) || 0);
    const size = Math.max(1, Math.min(200, Number(limit) || 50));
    return {
      databaseId: p.id,
      title: p.title,
      ...(view ? { view: view.name } : {}),
      total: rows.length,
      items: rows.slice(start, start + size).map((r) => this.#rowOut(r, p)),
      nextCursor: start + size < rows.length ? String(start + size) : null,
      hasMore: start + size < rows.length,
    };
  }

  /** Create (no viewId) or update a saved view; remove: true deletes it. */
  saveView({ pageId, viewId = null, remove = false, index = null, ...spec } = {}, actorArg) {
    const actor = actorOf(actorArg);
    const p = this.#db(pageId);
    const d = p.database;
    let view;
    if (viewId) {
      const i = d.views.findIndex((v) => v.id === viewId || v.name.toLowerCase() === String(viewId).toLowerCase());
      if (i < 0) throw new NotFoundError(`No view "${viewId}". Views: ${d.views.map((v) => `"${v.name}" (${v.id})`).join(', ')}`);
      if (remove) {
        if (d.views.length === 1) throw bad('A database needs at least one view');
        const [gone] = d.views.splice(i, 1);
        this.#touch(p, actor);
        return { removed: gone.id, views: d.views.map((v) => this.#viewOut(p, v)) };
      }
      view = d.views[i] = DB.makeView(d, spec, d.views[i]);
      if (index != null) {
        d.views.splice(i, 1);
        d.views.splice(Math.max(0, Math.min(d.views.length, index)), 0, view);
      }
    } else {
      view = DB.makeView(d, spec);
      if (index != null) d.views.splice(Math.max(0, Math.min(d.views.length, index)), 0, view);
      else d.views.push(view);
    }
    this.#touch(p, actor);
    return this.#viewOut(p, view);
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
