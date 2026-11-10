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
const VIEW_EXTRAS = ['dateProperty', 'endProperty', 'coverProperty', 'cardSize', 'aggregations', 'showSubItems'];
const pickViewExtras = (x) => Object.fromEntries(VIEW_EXTRAS.filter((k) => x?.[k] !== undefined).map((k) => [k, x[k]]));
const now = () => new Date().toISOString();
/** JSON with sorted keys: storage may reorder object keys, so compare values with this. */
const stable = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));

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
  #comp = null; // computed values, rebuilt after any change
  #changed() {
    this.#comp = null;
  }

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
    this.#comp = null;
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
    let row = null;
    if (parent?.database) {
      const d = parent.database;
      const related = {};
      for (const prop of d.properties) {
        if (prop.type !== 'relation' || related[prop.databaseId]) continue;
        const t = this.data.pages[prop.databaseId];
        related[prop.databaseId] = t?.database ? { id: t.id, title: t.title, rows: this.#rows(t).map((r) => ({ id: r.id, title: r.title, icon: r.icon })) } : null;
      }
      row = {
        row: { databaseId: parent.id, databaseTitle: parent.title, titleName: d.titleName, properties: d.properties, dependencies: d.dependencies || null, subItems: d.subItems || null, templates: (d.templates || []).map((t) => ({ id: t.id, name: t.name })), members: this.members, related },
        props: (this.#computer().row(parent.id, p.id) || p).props || {},
        properties: this.#rowOut(p, parent).properties,
      };
    }
    return {
      ...p,
      kind: this.#kind(p),
      ...(row || {}),
      ...(p.database ? { rowCount: this.#children(p.id).filter((c) => !c.archivedAt).length } : {}),
      breadcrumb: this.#ancestors(p).map((a) => this.#summary(a)),
      children: (p.database ? [] : this.#children(p.id))
        .filter((c) => !c.archivedAt)
        .map((c) => this.#summary(c)),
      archived: this.#isHidden(p),
      linkedViews: p.blocks.filter((b) => b.type === 'database_view').map((b) => this.#linkedOut(b)),
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
      blocks: this.#linkBlocks(null, (blocks ? blocks.map(sanitizeBlock) : markdownToBlocks(markdown)).filter((b) => b.type !== 'page'), { refs: false }),
      favorite: false,
      archivedAt: null,
      createdAt: now(),
      updatedAt: now(),
      createdBy: editorName(actor),
      lastEditedBy: editorName(actor),
      version: 1,
    };
    if (parent?.database) p.props = this.#newRowProps(parent);
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
      const next = this.#linkBlocks(p, blocks.map(sanitizeBlock));
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
    const parent = p.parentId ? this.data.pages[p.parentId] : null;
    if (p.props) {
      // a duplicated item keeps its values, but not links that would need the other side updated,
      // and gets a fresh unique id
      const props = structuredClone(p.props);
      for (const prop of parent?.database?.properties || []) {
        if (prop.type === 'relation' && prop.reverseId) delete props[prop.id];
        if (prop.type === 'unique_id') props[prop.id] = raw.props?.[prop.id];
      }
      raw.props = props;
      if (parent?.database) {
        const linked = {};
        for (const prop of parent.database.properties) if (prop.type === 'relation' && prop.reverseId && p.props[prop.id]) linked[prop.id] = p.props[prop.id];
        this.#setProps(raw, parent, { ...props, ...linked }, actorOf(actorArg));
      }
    }
    if (p.database) {
      const d = structuredClone(p.database);
      raw.database = { ...d, idem: {} };
      // relations to other databases become one-way; relations inside the database point into the copy
      for (const prop of d.properties) {
        if (prop.type !== 'relation') continue;
        if (prop.databaseId === p.id) prop.databaseId = raw.id;
        else delete prop.reverseId;
      }
      const map = new Map();
      for (const r of this.#children(p.id).filter((c) => !c.archivedAt)) {
        const row = this.createPage({ title: r.title, icon: r.icon, parentId: copy.id, blocks: r.blocks.filter((b) => b.type !== 'page') }, actorArg);
        this.data.pages[row.id].props = structuredClone(r.props || {});
        map.set(r.id, row.id);
      }
      for (const newId_ of map.values()) {
        const props = this.data.pages[newId_].props;
        for (const prop of d.properties) if (prop.type === 'relation' && prop.databaseId === raw.id && props[prop.id]) props[prop.id] = props[prop.id].map((x) => map.get(x)).filter(Boolean);
      }
    }
    this.#changed();
    return this.#full(raw);
  }

  archivePage({ pageId } = {}, actorArg) {
    const actor = actorOf(actorArg);
    const p = this.#page(pageId);
    p.archivedAt = now();
    p.updatedAt = p.archivedAt;
    p.favorite = false;
    const parent = this.#syncParent(p, 'blocks', actor);
    this.#changed(actor, [p.id, p.parentId, parent, ...this.#descendants(p.id).map((d) => d.id)], true);
    return { ok: true, archived: this.#summary(p) };
  }

  restorePage({ pageId } = {}, actorArg) {
    const actor = actorOf(actorArg);
    const p = this.#page(pageId);
    p.archivedAt = null;
    p.updatedAt = now();
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
  /**
   * Resolve linked database views in incoming blocks. A Markdown line
   * "[Name](database_view:ID)" refers to an existing block of this page and keeps its
   * settings (refs: true); unknown ones are dropped. Blocks that carry settings (editor
   * saves, duplicates) are validated against their database.
   */
  #linkBlocks(p, blocks, { refs = true } = {}) {
    const old = new Map((p?.blocks || []).filter((b) => b.type === 'database_view').map((b) => [b.id, b]));
    const seen = new Set();
    const out = [];
    for (const b of blocks) {
      if (b.type !== 'database_view') {
        out.push(b);
        continue;
      }
      if (b.ref) {
        const o = refs ? old.get(b.ref) : null;
        if (o && !seen.has(o.id)) out.push(o), seen.add(o.id);
        continue;
      }
      if (!b.databaseId || seen.has(b.id)) continue;
      const db = this.data.pages[b.databaseId];
      if (db?.database) b.view = DB.linkedView(db.database, b.view || {});
      seen.add(b.id);
      out.push(b);
    }
    return out;
  }
  #linkedOut(b) {
    const db = this.data.pages[b.databaseId];
    if (!db?.database) return { blockId: b.id, databaseId: b.databaseId, available: false };
    return { blockId: b.id, databaseId: db.id, databaseTitle: db.title, ...this.#viewOut(db, b.view || DB.linkedView(db.database, {})), id: undefined, viewId: b.view?.id };
  }

  /** Show a database inside another page: a live, filtered view of the same records. */
  createLinkedView({ pageId, databaseId, afterBlockId = null, name, type, groupBy, filters, sorts, visibleProperties, ...extra } = {}, actorArg) {
    const actor = actorOf(actorArg);
    const p = this.#page(pageId);
    const db = this.#db(databaseId);
    if (p.id === db.id) throw bad('A database already shows its own views; add a linked view to another page');
    const view = DB.linkedView(db.database, { ...pickViewExtras(extra), name: name || db.title || 'Linked view', type, groupBy, filters, sorts, visibleProperties }, { strict: true });
    const block = { id: newId(), type: 'database_view', text: '', databaseId: db.id, view };
    const at = afterBlockId ? this.#blockIndex(p, afterBlockId) + 1 : p.blocks.length;
    p.blocks.splice(at, 0, block);
    this.#contentChanged(p, actor);
    return { pageId: p.id, version: p.version, ...this.#linkedOut(block) };
  }

  updateLinkedView({ pageId, blockId, name, type, groupBy, filters, sorts, visibleProperties, ...extra } = {}, actorArg) {
    const actor = actorOf(actorArg);
    const p = this.#page(pageId);
    const b = p.blocks[this.#blockIndex(p, blockId)];
    if (b.type !== 'database_view') throw bad(`Block ${blockId} is not a linked database view`);
    const db = this.#db(b.databaseId);
    const cur = b.view || DB.linkedView(db.database, {});
    const pick = (x, y) => (x === undefined ? y : x);
    b.view = DB.linkedView(
      db.database,
      {
        ...cur,
        visible: undefined,
        ...pickViewExtras(extra),
        id: cur.id,
        name: pick(name, cur.name),
        type: pick(type, cur.type),
        groupBy: pick(groupBy, cur.groupBy),
        filters: pick(filters, cur.filters),
        sorts: pick(sorts, cur.sorts),
        visibleProperties: pick(visibleProperties, cur.visible),
      },
      { strict: true },
    );
    this.#contentChanged(p, actor);
    return { pageId: p.id, version: p.version, ...this.#linkedOut(b) };
  }

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
    p.blocks = this.#linkBlocks(p, markdownToBlocks(markdown));
    this.#contentChanged(p, actor);
    return this.#full(p);
  }

  appendContent({ pageId, markdown = '', afterBlockId = null, expectedVersion } = {}, actorArg) {
    const actor = actorOf(actorArg);
    const p = this.#page(pageId);
    this.#expectVersion(p, expectedVersion);
    const blocks = this.#linkBlocks(p, markdownToBlocks(markdown).filter((b) => b.type !== 'page'), { refs: false });
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
      const parsed = this.#linkBlocks(p, markdownToBlocks(markdown).filter((b) => b.type !== 'page'), { refs: false });
      if (parsed.length) parsed[0].id = blockId;
      p.blocks.splice(i, 1, ...parsed);
      result = parsed;
    } else {
      if (p.blocks[i].type === 'database_view') throw bad('This block is a linked database view. Use update_linked_database_view to change it, or delete_blocks to remove it.');
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
    if (b.type === 'divider' || b.type === 'database_view') throw bad(`A ${b.type === 'divider' ? 'divider' : 'linked database view'} cannot become a page`);
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
  /** Computed values (rollups, formulas, "is blocked") for the current state; rebuilt after any change. */
  #computer() {
    return (this.#comp ||= DB.createComputer({ pages: this.data.pages, members: this.members }));
  }
  /** Lookups the shared database code needs. */
  #env() {
    return {
      database: (key) => {
        const k = String(key ?? '').trim();
        let p = this.data.pages[k];
        if (!p?.database) {
          const hits = Object.values(this.data.pages).filter((x) => x.database && !this.#isHidden(x) && (x.title || '').trim().toLowerCase() === k.toLowerCase());
          p = hits.length === 1 ? hits[0] : null;
        }
        return p?.database && !this.#isHidden(p) ? { id: p.id, title: p.title, database: p.database } : null;
      },
      titleOf: (id) => this.#computer().titleOf(id),
    };
  }
  #valueCtx(actor, extra = {}) {
    return {
      members: this.members,
      me: actor?.userId || null,
      agentId: actor?.agentId || null,
      titleOf: (id) => this.#computer().titleOf(id),
      resolveRow: (dbId, x) => this.#resolveRow(dbId, x),
      ...extra,
    };
  }
  /** An item of a database by id, unique id ("E-3") or exact title. */
  #resolveRow(dbId, x) {
    const s = String(x ?? '').trim();
    const db = this.data.pages[dbId];
    if (!db?.database) throw bad('The related database no longer exists');
    const rows = this.#rows(db);
    const byId = rows.find((r) => r.id === s);
    if (byId) return byId.id;
    const uid = db.database.properties.find((p) => p.type === 'unique_id');
    if (uid) {
      const hit = rows.find((r) => r.props?.[uid.id] != null && DB.uniqueIdText(uid, r.props[uid.id]).toLowerCase() === s.toLowerCase());
      if (hit) return hit.id;
    }
    const hits = rows.filter((r) => (r.title || '').trim().toLowerCase() === s.toLowerCase());
    if (hits.length === 1) return hits[0].id;
    if (hits.length > 1) throw bad(`Several items in "${db.title}" are titled "${s}"; use the item id`);
    throw bad(`No item "${s}" in "${db.title || 'Untitled'}"`);
  }
  #rows(db) {
    return this.#children(db.id).filter((c) => !c.archivedAt);
  }
  /** A row as tools see it: property values by property name. */
  #rowOut(row, db) {
    const r = this.#computer().row(db.id, row.id) || row;
    const d = db.database;
    const env = this.#env();
    const properties = {};
    for (const prop of [DB.titleProp(d), ...d.properties]) {
      const v = DB.rawValue(r, prop);
      if (prop.type === 'relation') properties[prop.name] = (v || []).map((id) => ({ id, title: env.titleOf(id) }));
      else properties[prop.name] = DB.displayValue(prop, v, this.members, env);
    }
    const out = {
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
    if (d.dependencies) out.blocked = !!r.props?.blocked;
    return out;
  }
  #schemaOut(db) {
    const d = db.database;
    const env = this.#env();
    const name = (id) => d.properties.find((p) => p.id === id)?.name ?? null;
    return {
      id: db.id,
      title: db.title,
      icon: db.icon,
      parentId: db.parentId || null,
      titleProperty: d.titleName,
      properties: d.properties.map((p) => DB.describeProperty(d, p, env)),
      views: d.views.map((v) => this.#viewOut(db, v)),
      templates: (d.templates || []).map((t) => this.#templateOut(db, t)),
      ...(d.subItems ? { subItems: { parentProperty: name(d.subItems.parent), childrenProperty: name(d.subItems.children) } } : {}),
      ...(d.dependencies ? { dependencies: { blockedByProperty: name(d.dependencies.blockedBy), blockingProperty: name(d.dependencies.blocking) } } : {}),
      rowCount: this.#rows(db).length,
      version: db.version,
    };
  }
  #viewOut(db, v) {
    const name = (id) => {
      try {
        return DB.resolveProp(db.database, id).name;
      } catch {
        return id;
      }
    };
    const f = (list) => list.map((x) => (x.or ? { or: f(x.or) } : x.and ? { and: f(x.and) } : { ...x, property: name(x.property) }));
    return {
      id: v.id,
      name: v.name,
      type: v.type,
      ...(v.groupBy ? { groupBy: name(v.groupBy) } : {}),
      filters: f(v.filters || []),
      sorts: (v.sorts || []).map((s) => ({ ...s, property: name(s.property) })),
      ...(v.visible ? { visibleProperties: v.visible.map(name) } : {}),
      ...(v.dateProperty ? { dateProperty: name(v.dateProperty) } : {}),
      ...(v.endProperty ? { endProperty: name(v.endProperty) } : {}),
      ...(v.coverProperty ? { coverProperty: ['none', 'content'].includes(v.coverProperty) ? v.coverProperty : name(v.coverProperty) } : {}),
      ...(v.cardSize ? { cardSize: v.cardSize } : {}),
      ...(v.aggregations ? { aggregations: Object.fromEntries(Object.entries(v.aggregations).map(([id, fn]) => [name(id), fn])) } : {}),
      ...(v.showSubItems === false ? { showSubItems: false } : {}),
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
  /**
   * Store new props on a row and keep two-way relations in step: linking A → B also
   * links B → A in B's reverse property (and unlinks on removal).
   */
  #setProps(row, db, next, actor) {
    const prev = row.props || {};
    row.props = next; // first, so a self-relation writes its reverse side into the new props
    for (const prop of db.database.properties) {
      if (prop.type !== 'relation' || !prop.reverseId) continue;
      const before = new Set(prev[prop.id] || []);
      const after = new Set(next[prop.id] || []);
      const target = this.data.pages[prop.databaseId];
      const reverse = target?.database?.properties.find((p) => p.id === prop.reverseId);
      if (!reverse) continue;
      for (const id of after) {
        if (before.has(id)) continue;
        const t = this.data.pages[id];
        if (!t) continue;
        t.props ||= {};
        let list = t.props[reverse.id] || [];
        if (reverse.limit === 1) {
          // the other item can link back to only one: unlink it from its previous one
          for (const old of list) if (old !== row.id && this.data.pages[old]?.props?.[prop.id]) {
            const o = this.data.pages[old];
            o.props[prop.id] = o.props[prop.id].filter((x) => x !== id);
            if (!o.props[prop.id].length) delete o.props[prop.id];
            this.#touch(o, actor);
          }
          list = [];
        }
        if (!list.includes(row.id)) t.props[reverse.id] = [...list, row.id];
        if (t !== row) this.#touch(t, actor);
      }
      for (const id of before) {
        if (after.has(id)) continue;
        const t = this.data.pages[id];
        if (!t?.props?.[reverse.id]) continue;
        t.props[reverse.id] = t.props[reverse.id].filter((x) => x !== row.id);
        if (!t.props[reverse.id].length) delete t.props[reverse.id];
        if (t !== row) this.#touch(t, actor);
      }
    }
  }
  /** Props a new item starts with (unique ids). */
  #newRowProps(db) {
    const props = {};
    for (const p of db.database.properties) {
      if (p.type !== 'unique_id') continue;
      p.next ||= 1;
      props[p.id] = p.next++;
    }
    return props;
  }

  /** Add a property; a two-way relation also adds the reverse property to the other database. */
  #addProperty(db, spec, actor) {
    const d = db.database;
    const env = this.#env();
    const s = { ...spec };
    const target = s.databaseId ?? s.database_id ?? s.database;
    if (target === 'self' || target === db.id) s.databaseId = db.id;
    if (target === 'self') delete s.database;
    const prop = DB.makeProperty(d, { ...s, database: undefined, database_id: undefined, databaseId: s.databaseId ?? target }, env);
    d.properties.push(prop);
    if (prop.type === 'unique_id') {
      prop.next = 1;
      for (const r of this.#children(db.id)) {
        r.props ||= {};
        r.props[prop.id] = prop.next++;
        this.#touch(r, actor);
      }
    }
    if (prop.type === 'relation' && (s.twoWay || s.two_way)) {
      const tdb = this.data.pages[prop.databaseId];
      const td = tdb.database;
      const taken = (n) => [DB.titleProp(td), ...td.properties].some((x) => x.name.toLowerCase() === n.toLowerCase());
      let rname = String(s.reverseName || s.reverse_name || db.title || 'Related').trim().slice(0, 60);
      for (let i = 2; taken(rname); i++) rname = `${String(s.reverseName || s.reverse_name || db.title || 'Related').slice(0, 55)} ${i}`;
      const reverse = { id: newId().slice(0, 8), name: rname, type: 'relation', databaseId: db.id, reverseId: prop.id };
      if (s.reverseLimit === 1 || s.reverse_limit === 1) reverse.limit = 1;
      td.properties.push(reverse);
      prop.reverseId = reverse.id;
      if (tdb !== db) this.#touch(tdb, actor);
    }
    return prop;
  }
  /** Remove a property (and the other side of a two-way relation). */
  #removeProperty(db, prop, actor) {
    const d = db.database;
    const deps = DB.dependents(d, prop.id).filter((x) => x.id !== prop.id);
    if (deps.length) throw bad(`"${prop.name}" is used by ${deps.map((x) => `"${x.name}"`).join(', ')}; change or remove those first`);
    d.properties = d.properties.filter((x) => x.id !== prop.id);
    for (const r of this.#children(db.id)) if (r.props && prop.id in r.props) delete r.props[prop.id];
    DB.forgetProperty(d, prop.id);
    if (d.subItems && [d.subItems.parent, d.subItems.children].includes(prop.id)) delete d.subItems;
    if (d.dependencies && [d.dependencies.blockedBy, d.dependencies.blocking].includes(prop.id)) delete d.dependencies;
    // rollups in other databases that read this property can't work any more
    for (const other of Object.values(this.data.pages)) {
      if (!other.database) continue;
      for (const rp of other.database.properties) {
        if (rp.type !== 'rollup' || rp.target !== prop.id) continue;
        const rel = other.database.properties.find((x) => x.id === rp.relation);
        if (rel?.databaseId === db.id) rp.target = 'title';
      }
    }
    if (prop.type === 'relation' && prop.reverseId) {
      const tdb = this.data.pages[prop.databaseId];
      const reverse = tdb?.database?.properties.find((x) => x.id === prop.reverseId);
      if (reverse) {
        delete reverse.reverseId;
        this.#removeProperty(tdb, reverse, actor);
        if (tdb !== db) this.#touch(tdb, actor);
      }
    }
    // the reverse side of a relation in another database stops being two-way
    for (const other of Object.values(this.data.pages)) {
      for (const rp of other.database?.properties || []) if (rp.type === 'relation' && rp.databaseId === db.id && rp.reverseId === prop.id) delete rp.reverseId;
    }
  }
  /** Linked views of this database on other pages drop references to removed properties. */
  #refreshLinkedViews(db, actor) {
    for (const page of Object.values(this.data.pages)) {
      const linked = page.blocks.filter((b) => b.type === 'database_view' && b.databaseId === db.id);
      if (!linked.length) continue;
      for (const b of linked) b.view = DB.linkedView(db.database, b.view || {});
      this.#touch(page, actor);
    }
  }

  createDatabase({ title = '', icon = '', parentId = null, afterBlockId = null, index = null, titleName = 'Name', properties = [], views = [], markdown = '', subItems = false, dependencies = false } = {}, actorArg) {
    const actor = actorOf(actorArg);
    const created = this.createPage({ title, icon, parentId, afterBlockId, index, markdown }, actor);
    const p = this.data.pages[created.id];
    p.database = { titleName: String(titleName || 'Name').slice(0, 60), properties: [], views: [], templates: [], idem: {} };
    try {
      for (const spec of properties || []) this.#addProperty(p, spec, actor);
      if (subItems) this.#enableSubItems(p, actor);
      if (dependencies) this.#enableDependencies(p, actor);
      p.database.views.push(DB.makeView(p.database, { name: 'All', type: 'table' }));
      for (const spec of views || []) p.database.views.push(DB.makeView(p.database, spec));
    } catch (err) {
      this.deletePage({ pageId: p.id }, actor);
      throw err;
    }
    return this.#schemaOut(p);
  }

  #enableSubItems(db, actor) {
    const d = db.database;
    if (d.subItems) return;
    const children = this.#addProperty(db, { name: this.#freeName(d, 'Sub-items'), type: 'relation', databaseId: db.id, twoWay: true, reverseName: this.#freeName(d, 'Parent item'), reverseLimit: 1 }, actor);
    d.subItems = { children: children.id, parent: children.reverseId };
  }
  #enableDependencies(db, actor) {
    const d = db.database;
    if (d.dependencies) return;
    const blockedBy = this.#addProperty(db, { name: this.#freeName(d, 'Blocked by'), type: 'relation', databaseId: db.id, twoWay: true, reverseName: this.#freeName(d, 'Blocking') }, actor);
    d.dependencies = { blockedBy: blockedBy.id, blocking: blockedBy.reverseId };
  }
  #freeName(d, base) {
    const taken = (n) => [DB.titleProp(d), ...d.properties].some((x) => x.name.toLowerCase() === n.toLowerCase());
    let n = base;
    for (let i = 2; taken(n); i++) n = `${base} ${i}`;
    return n;
  }

  getDatabase({ pageId } = {}) {
    return this.#schemaOut(this.#db(pageId));
  }

  updateDatabase({ pageId, title, icon, titleName, addProperties = [], updateProperties = [], removeProperties = [], subItems, dependencies } = {}, actorArg) {
    const actor = actorOf(actorArg);
    const p = this.#db(pageId);
    const d = p.database;
    const env = this.#env();
    const taken = (n, except) => [DB.titleProp(d), ...d.properties].some((x) => x.id !== except && x.name.toLowerCase() === String(n).trim().toLowerCase());
    if (title !== undefined || icon !== undefined) this.updatePage({ pageId, title, icon }, actor);
    if (titleName !== undefined) {
      if (!String(titleName).trim() || taken(titleName, 'title')) throw bad(`Can't name the title column "${titleName}"`);
      d.titleName = String(titleName).trim().slice(0, 60);
    }
    for (const spec of addProperties || []) this.#addProperty(p, spec, actor);
    let removed = false;
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
      const newType = u.type === undefined ? undefined : ({ multiselect: 'multi_select', people: 'person', file: 'files', link: 'links' }[u.type] || u.type);
      if (newType !== undefined && newType !== prop.type) {
        this.#convertProperty(p, prop, newType, u, actor);
        removed = true;
      } else {
        const cfg = {};
        for (const [k, key] of [
          ['expression', 'expression'],
          ['relation', 'relation'],
          ['rollupProperty', 'property'],
          ['function', 'function'],
          ['value', 'value'],
          ['format', 'format'],
          ['display', 'display'],
          ['prefix', 'prefix'],
          ['limit', 'limit'],
        ])
          if (u[k] !== undefined) cfg[key] = u[k];
        if (Object.keys(cfg).length) DB.configureProperty(d, prop, cfg, env, false);
      }
      if (u.options && prop.options) for (const o of u.options) DB.addOption(prop, typeof o === 'string' ? o : o.name, o?.color, o?.group);
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
      if (u.optionGroups && prop.type === 'status') {
        for (const [n, g] of Object.entries(u.optionGroups)) {
          const o = prop.options.find((x) => x.id === n || x.name.toLowerCase() === n.toLowerCase());
          if (!o) throw bad(`"${prop.name}" has no option "${n}"`);
          o.group = DB.groupId(g);
        }
        DB.sortStatusOptions(prop);
      }
      if (u.removeOptions && prop.options) {
        const gone = new Set(u.removeOptions.map((n) => prop.options.find((o) => o.id === n || o.name.toLowerCase() === String(n).toLowerCase())?.id).filter(Boolean));
        prop.options = prop.options.filter((o) => !gone.has(o.id));
        for (const r of this.#children(p.id)) {
          const v = r.props?.[prop.id];
          if ((prop.type === 'select' || prop.type === 'status') && gone.has(v)) delete r.props[prop.id];
          if (prop.type === 'multi_select' && Array.isArray(v)) r.props[prop.id] = v.filter((id) => !gone.has(id));
        }
      }
      if (u.optionOrder && prop.options) {
        const rank = (o) => {
          const i = u.optionOrder.findIndex((n) => n === o.id || String(n).toLowerCase() === o.name.toLowerCase());
          return i < 0 ? Infinity : i;
        };
        prop.options.sort((a, b) => rank(a) - rank(b));
        if (prop.type === 'status') DB.sortStatusOptions(prop);
      }
    }
    for (const key of removeProperties || []) {
      const prop = DB.resolveProp(d, key, { allowPseudo: false });
      if (prop.type === 'title') throw bad('The title column cannot be removed');
      this.#removeProperty(p, prop, actor);
      removed = true;
    }
    if (subItems === true) this.#enableSubItems(p, actor);
    if (subItems === false && d.subItems) {
      const prop = d.properties.find((x) => x.id === d.subItems.children);
      delete d.subItems;
      if (prop) this.#removeProperty(p, prop, actor);
      removed = true;
    }
    if (dependencies === true) this.#enableDependencies(p, actor);
    if (dependencies === false && d.dependencies) {
      const prop = d.properties.find((x) => x.id === d.dependencies.blockedBy);
      delete d.dependencies;
      if (prop) this.#removeProperty(p, prop, actor);
      removed = true;
    }
    if (removed) this.#refreshLinkedViews(p, actor);
    this.#touch(p, actor);
    return this.#schemaOut(p);
  }

  /** Change a property's type, converting values through their text form; values that don't fit are cleared. */
  #convertProperty(db, prop, type, u, actor) {
    const d = db.database;
    const env = this.#env();
    if (!DB.PROPERTY_TYPES.includes(type)) throw bad(`Unknown property type "${type}". Types: ${DB.PROPERTY_TYPES.join(', ')}`);
    if (DB.dependents(d, prop.id).length && ['rollup', 'formula'].includes(type)) throw bad(`"${prop.name}" is used by other properties`);
    if (prop.type === 'relation' && prop.reverseId) {
      const reverse = this.data.pages[prop.databaseId]?.database?.properties.find((x) => x.id === prop.reverseId);
      if (reverse) this.#removeProperty(this.data.pages[prop.databaseId], { ...reverse, reverseId: undefined }, actor);
      delete prop.reverseId;
    }
    const scratch = { titleName: '\u0000', properties: d.properties.filter((x) => x.id !== prop.id) };
    const spec = { name: prop.name, type, options: [], expression: u.expression, relation: u.relation, property: u.rollupProperty, function: u.function, value: u.value, format: u.format, display: u.display, prefix: u.prefix, databaseId: u.databaseId, limit: u.limit };
    const next = DB.makeProperty(scratch, spec, env);
    const rows = this.#children(db.id);
    const texts = new Map(rows.map((r) => [r.id, DB.valueText(prop, r.props?.[prop.id], this.members, env)]));
    for (const k of Object.keys(prop)) if (!['id', 'name'].includes(k)) delete prop[k];
    Object.assign(prop, { ...next, id: prop.id, name: prop.name });
    if (type === 'unique_id') prop.next = 1;
    for (const r of rows) {
      r.props ||= {};
      if (DB.COMPUTED_TYPES.includes(type)) {
        delete r.props[prop.id];
        continue;
      }
      if (type === 'unique_id') {
        r.props[prop.id] = prop.next++;
        continue;
      }
      const t = texts.get(r.id);
      let v = null;
      try {
        v = type === 'checkbox' ? ['true', 'yes', '1', 'done', 'checked', 'x'].includes(String(t).toLowerCase()) : t ? DB.parseValue(prop, type === 'relation' ? t.split(/\s*,\s*/) : t, this.#valueCtx(actor)) : null;
      } catch {}
      if (v == null || (Array.isArray(v) && !v.length)) delete r.props[prop.id];
      else r.props[prop.id] = v;
    }
    for (const v of d.views) {
      if (v.groupBy === prop.id && !DB.GROUPABLE.includes(prop.type)) {
        v.groupBy = null;
        if (v.type === 'board') v.type = 'table';
      }
    }
  }

  /** Everything the browser needs to draw a database's views. */
  databaseRows({ pageId } = {}) {
    const p = this.#db(pageId);
    const c = this.#computer();
    const related = {};
    for (const prop of p.database.properties) {
      if (prop.type !== 'relation' || related[prop.databaseId]) continue;
      const t = this.data.pages[prop.databaseId];
      related[prop.databaseId] = t?.database && !this.#isHidden(t) ? { id: t.id, title: t.title, icon: t.icon, rows: this.#rows(t).map((r) => ({ id: r.id, title: r.title, icon: r.icon })) } : null;
    }
    return {
      id: p.id,
      title: p.title,
      icon: p.icon,
      version: p.version,
      database: p.database,
      members: this.members,
      related,
      rows: c.rows(p.id).map((r) => ({
        id: r.id,
        title: r.title,
        icon: r.icon,
        props: r.props || {},
        position: r.position,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        lastEditedBy: r.lastEditedBy,
        hasContent: r.blocks.some((b) => b.type !== 'page' && (b.text || b.url)),
        cover: r.blocks.find((b) => b.type === 'image' && b.url)?.url || null,
      })),
    };
  }

  /** Item templates: title / icon / property defaults / content / linked views. */
  #templateOut(db, t) {
    return { id: t.id, name: t.name, isDefault: !!t.isDefault, title: t.title || '', icon: t.icon || '', properties: t.properties || {}, content: t.markdown || '', linkedViews: (t.linkedViews || []).map((v) => ({ ...v })) };
  }
  #template(db, key) {
    const list = db.database.templates || [];
    const t = list.find((x) => x.id === key || x.name.toLowerCase() === String(key).toLowerCase());
    if (!t) throw bad(`No template "${key}" in "${db.title}". Templates: ${list.map((x) => `"${x.name}"`).join(', ') || 'none'}`);
    return t;
  }
  /**
   * Create (no templateId), change or remove (remove: true) an item template. fromItemId copies
   * an existing item's properties, content and linked views.
   */
  saveTemplate({ pageId, templateId = null, remove = false, name, title, icon, properties, markdown, linkedViews, isDefault, fromItemId } = {}, actorArg) {
    const actor = actorOf(actorArg);
    const p = this.#db(pageId);
    const d = p.database;
    d.templates ||= [];
    let t = templateId ? this.#template(p, templateId) : null;
    if (remove) {
      if (!t) throw bad('Say which template to remove');
      d.templates = d.templates.filter((x) => x !== t);
      this.#touch(p, actor);
      return { removed: t.id, templates: d.templates.map((x) => this.#templateOut(p, x)) };
    }
    if (!t) {
      t = { id: newId().slice(0, 8), name: 'Template' };
      d.templates.push(t);
    }
    if (fromItemId) {
      const row = this.#page(fromItemId);
      if (row.parentId !== p.id) throw bad('That item is not in this database');
      const out = this.#rowOut(row, p);
      t.title = row.title || '';
      t.icon = row.icon || '';
      t.properties = {};
      for (const prop of d.properties) {
        if (DB.READ_ONLY_TYPES.includes(prop.type)) continue;
        const v = out.properties[prop.name];
        if (v == null || v === false || (Array.isArray(v) && !v.length)) continue;
        t.properties[prop.id] = prop.type === 'relation' ? v.map((x) => x.id) : prop.type === 'date' ? row.props[prop.id] : v;
      }
      t.markdown = blocksToMarkdown(row.blocks.filter((b) => b.type !== 'page' && b.type !== 'database_view'));
      t.linkedViews = row.blocks.filter((b) => b.type === 'database_view').map((b) => ({ databaseId: b.databaseId, ...this.#viewOut(this.data.pages[b.databaseId] || p, b.view || {}), id: undefined }));
      if (name === undefined && t.name === 'Template') t.name = row.title || 'Template';
    }
    if (name !== undefined) t.name = String(name || 'Template').slice(0, 60);
    if (title !== undefined) t.title = String(title || '');
    if (icon !== undefined) t.icon = String(icon || '');
    if (markdown !== undefined) t.markdown = String(markdown || '');
    if (properties !== undefined) {
      // validate now (names → ids) so a broken template fails here, not on every new item
      const probe = structuredClone(d);
      const ids = {};
      for (const [k, v] of Object.entries(properties || {})) {
        const prop = DB.resolveProp(d, k, { allowPseudo: false });
        DB.parseValue(probe.properties.find((x) => x.id === prop.id) || DB.titleProp(probe), v, this.#valueCtx(actor));
        ids[prop.id] = v;
      }
      t.properties = ids;
    }
    if (linkedViews !== undefined) {
      t.linkedViews = (linkedViews || []).map((lv) => {
        const target = this.#db(lv.databaseId || lv.database_id || p.id);
        DB.linkedView(target.database, lv, { strict: true });
        return { databaseId: target.id, name: lv.name, type: lv.type, groupBy: lv.groupBy, filters: lv.filters, sorts: lv.sorts, visibleProperties: lv.visibleProperties };
      });
    }
    if (isDefault !== undefined) for (const x of d.templates) x.isDefault = x === t ? !!isDefault : isDefault ? false : !!x.isDefault;
    this.#touch(p, actor);
    return this.#templateOut(p, t);
  }

  /**
   * Create up to 300 rows. items: [{ title, icon, properties: { name: value }, markdown, template, parentItemId }].
   * Bad items are reported and skipped; the rest are created. Re-sending the same
   * idempotencyKey returns the first call's results instead of creating duplicates.
   * The database's default template applies unless an item says template: null / "none".
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
        const id = this.#createRow(p, item, index, actor);
        if (index != null) index++;
        return { index: i, status: 'created', id, title: this.data.pages[id].title };
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

  #createRow(p, item, index, actor) {
    const d = p.database;
    const tKey = item.template === undefined ? (d.templates || []).find((t) => t.isDefault)?.id : item.template;
    const t = tKey && tKey !== 'none' ? this.#template(p, tKey) : null;
    const input = { ...(t?.properties || {}), ...(item.properties || {}) };
    if (item.parentItemId) {
      if (!d.subItems) throw bad(`"${p.title}" has no sub-items; turn them on with update_database (sub_items: true)`);
      input[d.subItems.parent] = [item.parentItemId];
    }
    // parse before creating the page, so a bad value creates nothing
    const probe = this.#parseProps(p, input, actor, {});
    const title = item.title ?? probe.title ?? t?.title ?? '';
    const markdown = item.markdown || t?.markdown || '';
    const row = this.createPage({ title, icon: item.icon || t?.icon || '', parentId: p.id, markdown, index }, actor);
    const raw = this.data.pages[row.id];
    this.#setProps(raw, p, { ...(raw.props || {}), ...probe.props }, actor);
    for (const lv of t?.linkedViews || []) {
      if (!this.data.pages[lv.databaseId]?.database) continue;
      this.createLinkedView({ pageId: raw.id, databaseId: lv.databaseId, name: lv.name, type: lv.type, groupBy: lv.groupBy, filters: lv.filters, sorts: lv.sorts, visibleProperties: lv.visibleProperties }, actor);
    }
    return raw.id;
  }

  /** updates: [{ itemId, title, icon, properties: { name: value } }]. Per-item results. */
  updateRows({ updates = [] } = {}, actorArg) {
    const actor = actorOf(actorArg);
    if (!Array.isArray(updates) || !updates.length) throw bad('updates must be a non-empty list');
    if (updates.length > 300) throw bad('At most 300 updates per call');
    const touched = [];
    const results = updates.map((u, index) => {
      try {
        const row = this.#page(u.itemId);
        const db = row.parentId ? this.data.pages[row.parentId] : null;
        if (!db?.database) throw bad(`"${row.title || row.id}" is not a database item`);
        const { props, title } = this.#parseProps(db, u.properties, actor, structuredClone(row.props || {}));
        this.#setProps(row, db, props, actor);
        if (title !== undefined) row.title = title;
        if (u.title !== undefined) row.title = String(u.title);
        if (u.icon !== undefined) row.icon = String(u.icon || '');
        this.#touch(row, actor);
        touched.push([index, row, db]);
        return { index, status: 'updated', id: row.id };
      } catch (err) {
        return { index, status: 'failed', id: u?.itemId, error: err.message };
      }
    });
    for (const [index, row, db] of touched) results[index].item = this.#rowOut(row, db);
    return { updated: results.filter((r) => r.status === 'updated').length, failed: results.filter((r) => r.status === 'failed').length, results };
  }

  /**
   * Update items matched by a key property (e.g. "Code" = "GEN") and create the missing ones.
   * Per item: created / updated / unchanged / failed.
   */
  upsertRows({ pageId, matchProperty, items = [] } = {}, actorArg) {
    const actor = actorOf(actorArg);
    const p = this.#db(pageId);
    const d = p.database;
    if (!Array.isArray(items) || !items.length) throw bad('items must be a non-empty list');
    if (items.length > 300) throw bad('At most 300 items per call');
    const key = DB.resolveProp(d, matchProperty, { allowPseudo: false });
    if (!['title', 'text', 'number', 'select', 'status', 'url', 'email', 'unique_id'].includes(key.type)) throw bad(`Can't match on "${key.name}" (${key.type}); use a title, text, number, select, url, email or unique id property`);
    const env = this.#env();
    const keyText = (v) => String(key.type === 'title' ? v ?? '' : DB.valueText(key, v, this.members, env)).trim().toLowerCase();
    const index = new Map();
    for (const r of this.#rows(p)) {
      const k = keyText(DB.rawValue(r, key));
      if (!k) continue;
      if (!index.has(k)) index.set(k, []);
      index.get(k).push(r);
    }
    const results = items.map((item, i) => {
      try {
        const props = item.properties || {};
        const entry = Object.entries(props).find(([k]) => {
          try {
            return DB.resolveProp(d, k, { allowPseudo: false }).id === key.id;
          } catch {
            return false;
          }
        });
        if (!entry || entry[1] == null || entry[1] === '') throw bad(`Item has no "${key.name}" value to match on`);
        const want =
          key.type === 'unique_id'
            ? String(DB.uniqueIdText(key, Number(String(entry[1]).replace(/^[A-Za-z_]+-/, '')))).toLowerCase()
            : key.type === 'select' || key.type === 'status' || key.type === 'title'
              ? String(entry[1]).trim().toLowerCase()
              : keyText(DB.parseValue(structuredClone(key), entry[1], this.#valueCtx(actor)));
        const hits = index.get(want) || [];
        if (hits.length > 1) throw bad(`${hits.length} items have ${key.name} = "${entry[1]}"; make the key unique first`);
        if (!hits.length) {
          if (key.type === 'unique_id') throw bad(`No item with ${key.name} "${entry[1]}" (unique ids are assigned, not created)`);
          const id = this.#createRow(p, { properties: props, markdown: item.markdown, icon: item.icon, template: item.template, parentItemId: item.parentItemId }, null, actor);
          index.set(want, [this.data.pages[id]]);
          return { index: i, status: 'created', id, key: entry[1] };
        }
        const row = hits[0];
        const rest = Object.fromEntries(Object.entries(props).filter(([k]) => k !== entry[0] || key.type === 'title'));
        if (key.type === 'unique_id') delete rest[entry[0]];
        const before = stable([row.title, row.icon, row.props || {}]);
        const { props: next, title } = this.#parseProps(p, rest, actor, structuredClone(row.props || {}));
        const nextTitle = title !== undefined ? title : row.title;
        const nextIcon = item.icon !== undefined ? String(item.icon || '') : row.icon;
        const sameBody = !item.markdown || blocksToMarkdown(row.blocks.filter((b) => b.type !== 'page')).trim() === String(item.markdown).trim();
        if (stable([nextTitle, nextIcon, next]) === before && sameBody) return { index: i, status: 'unchanged', id: row.id, key: entry[1] };
        this.#setProps(row, p, next, actor);
        row.title = nextTitle;
        row.icon = nextIcon;
        if (!sameBody) {
          const subpages = row.blocks.filter((b) => b.type === 'page');
          row.blocks = [...this.#linkBlocks(row, markdownToBlocks(item.markdown).filter((b) => b.type !== 'page')), ...subpages];
        }
        this.#touch(row, actor);
        return { index: i, status: 'updated', id: row.id, key: entry[1] };
      } catch (err) {
        return { index: i, status: 'failed', error: err.message };
      }
    });
    this.#touch(p, actor);
    const count = (s) => results.filter((r) => r.status === s).length;
    return { databaseId: p.id, matchProperty: key.name, created: count('created'), updated: count('updated'), unchanged: count('unchanged'), failed: count('failed'), results };
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

  /**
   * Filter / sort / search / paginate rows. A view's filters are AND-ed with extra filters.
   * contextPageId: the page "@this_page" filter values refer to. parentItemId: only sub-items of that item.
   */
  queryDatabase({ pageId, viewId = null, filters = [], sorts = null, search = '', limit = 50, cursor = null, contextPageId = null, aggregations = null, parentItemId = null } = {}, actorArg) {
    const actor = actorOf(actorArg);
    const p = this.#db(pageId);
    const d = p.database;
    const view = viewId ? d.views.find((v) => v.id === viewId || v.name.toLowerCase() === String(viewId).toLowerCase()) : null;
    if (viewId && !view) throw bad(`No view "${viewId}". Views: ${d.views.map((v) => `"${v.name}" (${v.id})`).join(', ')}`);
    const all = [...(view?.filters || []), ...DB.normalizeFilters(d, filters)];
    const order = sorts && sorts.length ? DB.normalizeSorts(d, sorts) : view?.sorts || [];
    const ctxPage = contextPageId ? this.#page(contextPageId) : null;
    const ctx = this.#valueCtx(actor, { thisPage: ctxPage ? { id: ctxPage.id, title: ctxPage.title } : null });
    let source = this.#computer().rows(p.id);
    if (parentItemId) {
      if (!d.subItems) throw bad(`"${p.title}" has no sub-items`);
      source = source.filter((r) => (r.props?.[d.subItems.parent] || []).includes(parentItemId));
    }
    const rows = DB.applyView(d, source, { filters: all, sorts: order, search }, ctx);
    const start = Math.max(0, Number(cursor) || 0);
    const size = Math.max(1, Math.min(200, Number(limit) || 50));
    const aggSpec = aggregations ? Object.fromEntries(Object.entries(aggregations).map(([k, fn]) => [DB.resolveProp(d, k).id, String(fn).toLowerCase()])) : view?.aggregations;
    for (const fn of Object.values(aggSpec || {})) if (!DB.AGGREGATIONS.includes(fn)) throw bad(`Unknown calculation "${fn}". Calculations: ${DB.AGGREGATIONS.join(', ')}`);
    const agg = aggSpec ? DB.aggregateView(d, rows, aggSpec, ctx) : null;
    return {
      databaseId: p.id,
      title: p.title,
      ...(view ? { view: view.name } : {}),
      total: rows.length,
      items: rows.slice(start, start + size).map((r) => this.#rowOut(r, p)),
      nextCursor: start + size < rows.length ? String(start + size) : null,
      hasMore: start + size < rows.length,
      ...(agg ? { aggregations: Object.fromEntries(Object.entries(agg).map(([id, a]) => [DB.resolveProp(d, id).name, { function: a.function, value: a.value, text: a.text }])) } : {}),
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

  /** What changed since a time: pages, databases and items, oldest first (for agents catching up). */
  listChanges({ since, databaseId = null, limit = 100 } = {}) {
    const t = since ? new Date(since) : null;
    if (since && isNaN(t?.getTime())) throw bad(`Invalid time "${since}"; use an ISO date-time like 2026-11-09T12:00:00Z`);
    const iso = t ? t.toISOString() : '';
    if (databaseId) this.#db(databaseId);
    const env = this.#env();
    const list = Object.values(this.data.pages)
      .filter((p) => (p.updatedAt || '') > iso && (!databaseId || p.parentId === databaseId || p.id === databaseId))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    const size = Math.max(1, Math.min(500, Number(limit) || 100));
    return {
      since: iso || null,
      total: list.length,
      changes: list.slice(-size).map((p) => {
        const parent = p.parentId ? this.data.pages[p.parentId] : null;
        return {
          id: p.id,
          title: p.title,
          kind: this.#kind(p),
          updatedAt: p.updatedAt,
          lastEditedBy: p.lastEditedBy || null,
          archived: this.#isHidden(p),
          ...(parent?.database ? { database: { id: parent.id, title: env.titleOf(parent.id) ?? parent.title }, properties: this.#rowOut(p, parent).properties } : {}),
        };
      }),
      truncated: list.length > size,
    };
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
