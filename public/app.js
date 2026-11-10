import { markdownToBlocks, blocksToMarkdown, newId, LIST_TYPES, ATOMIC_TYPES } from './shared/markdown.js';
import { cx, query, mutation, action, watch, session, mcpUrl, siteUrl, inviteUrl } from './backend.js';
import { createDatabaseView, rowPropertiesPanel } from './database.js';

// =====================================================================
// API (Convex)
// =====================================================================
const CLIENT_ID = 'web-' + newId();
let WS_ID = null; // current workspace
const ws = () => ({ session: session.get(), workspaceId: WS_ID });

// Page-model reads are Convex queries; everything else goes through the `pages:run` mutation.
const READS = { listTree: 'tree', listTrash: 'trash', getPage: 'get', getPageMarkdown: 'markdown', search: 'search' };
async function rpc(method, args = {}) {
  try {
    if (READS[method]) {
      const r = await query(cx.pages[READS[method]], { ...ws(), ...args });
      if (method === 'getPage' && r === null) throw Object.assign(new Error('Page not found'), { status: 404 });
      return r;
    }
    return await mutation(cx.pages.run, { ...ws(), method, args, clientId: CLIENT_ID });
  } catch (err) {
    if (err.status === 403 && /member/.test(err.message)) {
      localStorage.removeItem('ws'); // removed from this workspace
      location.reload();
    }
    throw err;
  }
}

// =====================================================================
// Helpers
// =====================================================================
const $ = (sel, root = document) => root.querySelector(sel);
const h = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
  return el;
};
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s) => esc(s).replace(/"/g, '&quot;');
const label = (p) => p?.title || 'Untitled';
const iconOf = (p) => p?.icon || (p?.kind === 'database' ? '🗃️' : '📄');
const debounce = (fn, ms) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};
function timeAgo(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}
function toast(msg, kind = '') {
  const t = h('div', { class: `toast ${kind}` }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 3200);
}
async function copyText(s, what = 'Copied') {
  try {
    await navigator.clipboard.writeText(s);
    toast(what);
  } catch {
    toast('Could not access the clipboard');
  }
}

const PLAINTEXT_ONLY = (() => {
  const d = document.createElement('div');
  d.contentEditable = 'plaintext-only';
  return d.contentEditable === 'plaintext-only';
})();
const EDITABLE = PLAINTEXT_ONLY ? 'plaintext-only' : 'true';

const CHEVRON = '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M3 1.5 7 5 3 8.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const EMOJIS = '📄 📝 📌 📎 📚 📖 🗂️ 📁 📊 📈 🗓️ ✅ ☑️ 💡 🔥 ⭐ 🚀 🎯 🧠 🤖 💼 🏠 🛠️ ⚙️ 🔧 🧪 🧩 🎨 🎵 🎬 📷 ✈️ 🌍 🌱 🍀 ☕ 🍕 💰 💳 🛒 ❤️ 💬 📣 🔔 🔒 🔑 ⚠️ ❗ ❓ 👋 🙂 😎 🤔 🎉 🏆 📦 🧾 🖥️ 📱 ⌨️ 🐛 🧹 📬 🗺️ 🏁 🌙 ☀️ ⚡ 💎 🧱'.split(' ');

// =====================================================================
// Inline markdown highlighting. The DOM text always equals the raw
// markdown (markers are kept as dimmed spans), so caret offsets are stable.
// =====================================================================
const mk = (s) => `<span class="md">${esc(s)}</span>`;
const safeHref = (u) => (/^(https?:|mailto:|\/|#)/i.test(u) ? u : null);
const RULES = [
  { re: /`([^`\n]+)`/y, r: (m) => mk('`') + `<code>${esc(m[1])}</code>` + mk('`') },
  { re: /\*\*(?=\S)([\s\S]*?\S)\*\*/y, r: (m) => mk('**') + `<strong>${inline(m[1])}</strong>` + mk('**') },
  { re: /~~(?=\S)([\s\S]*?\S)~~/y, r: (m) => mk('~~') + `<s>${inline(m[1])}</s>` + mk('~~') },
  { re: /\*([^\s*](?:[^*\n]*[^\s*])?)\*/y, r: (m) => mk('*') + `<em>${inline(m[1])}</em>` + mk('*') },
  { re: /_([^\s_](?:[^_\n]*[^\s_])?)_(?!\w)/y, word: true, r: (m) => mk('_') + `<em>${inline(m[1])}</em>` + mk('_') },
  {
    re: /\[([^\]\n]+)\]\(([^)\s]+)\)/y,
    r: (m) => {
      const href = safeHref(m[2]);
      return mk('[') + `<a${href ? ` href="${escAttr(href)}"` : ''} target="_blank" rel="noopener">${inline(m[1])}</a>` + mk(`](${m[2]})`);
    },
  },
];
function inline(s) {
  let out = '';
  let plain = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    let hit = null;
    if ('`*~_['.includes(ch)) {
      for (const rule of RULES) {
        if (rule.word && i > 0 && /\w/.test(s[i - 1])) continue;
        rule.re.lastIndex = i;
        const m = rule.re.exec(s);
        if (m) {
          hit = { m, rule };
          break;
        }
      }
    }
    if (hit) {
      out += esc(plain) + hit.rule.r(hit.m);
      plain = '';
      i += hit.m[0].length;
    } else {
      plain += ch;
      i++;
    }
  }
  return out + esc(plain);
}
function highlight(text, type) {
  const html = type === 'code' ? esc(text) : inline(text);
  return text.endsWith('\n') ? html + '<br data-trail="1">' : html;
}

// =====================================================================
// Caret helpers (offsets into the raw text of a .text element)
// =====================================================================
function textOf(node) {
  let s = '';
  const walk = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) s += c.data;
      else if (c.nodeName === 'BR') {
        if (!c.dataset?.trail) s += '\n';
      } else walk(c);
    }
  };
  walk(node);
  return s.replace(/ /g, ' ');
}
const getText = (el) => textOf(el);
function getSel(el) {
  const sel = getSelection();
  if (!sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  if (!el.contains(r.startContainer) || !el.contains(r.endContainer)) return null;
  const off = (node, o) => {
    const rr = document.createRange();
    rr.setStart(el, 0);
    rr.setEnd(node, o);
    return textOf(rr.cloneContents()).length;
  };
  return { start: off(r.startContainer, r.startOffset), end: off(r.endContainer, r.endOffset) };
}
function pointAt(el, target) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let acc = 0;
  let n;
  let last = null;
  while ((n = walker.nextNode())) {
    if (acc + n.data.length >= target) return [n, target - acc];
    acc += n.data.length;
    last = n;
  }
  return last ? [last, last.data.length] : [el, 0];
}
function setCaret(el, start, end = start) {
  const sel = getSelection();
  const r = document.createRange();
  const [sn, so] = pointAt(el, start);
  const [en, eo] = pointAt(el, end);
  r.setStart(sn, so);
  r.setEnd(en, eo);
  sel.removeAllRanges();
  sel.addRange(r);
}
function caretRect() {
  const sel = getSelection();
  if (!sel.rangeCount) return null;
  const r = sel.getRangeAt(0).cloneRange();
  r.collapse(true);
  return r.getClientRects()[0] || null;
}
function caretOnEdgeLine(el, top) {
  const rect = caretRect();
  if (!rect) return true;
  const box = el.getBoundingClientRect();
  const lh = parseFloat(getComputedStyle(el).lineHeight) || 24;
  return top ? rect.top - box.top < lh * 0.8 : box.bottom - rect.bottom < lh * 0.8;
}
function focusAtX(el, x, fromBottom) {
  const box = el.getBoundingClientRect();
  const y = fromBottom ? box.bottom - 8 : box.top + 8;
  let node;
  let offset;
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    if (p) [node, offset] = [p.offsetNode, p.offset];
  } else if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(x, y);
    if (r) [node, offset] = [r.startContainer, r.startOffset];
  }
  el.focus({ preventScroll: true });
  if (node && el.contains(node)) {
    const r = document.createRange();
    r.setStart(node, offset);
    r.collapse(true);
    getSelection().removeAllRanges();
    getSelection().addRange(r);
  } else {
    setCaret(el, fromBottom ? getText(el).length : 0);
  }
  el.scrollIntoView({ block: 'nearest' });
}

// =====================================================================
// State
// =====================================================================
const state = {
  tree: [],
  flat: new Map(), // id -> node (with parentId)
  page: null,
  expanded: new Set(JSON.parse(localStorage.getItem('expanded') || '[]')),
  agent: { lastAt: null },
  info: null,
  me: null, // { id, name, email, color }
  workspaces: [],
  presence: [],
};
const currentWs = () => state.workspaces.find((w) => w.id === WS_ID);
const dirty = { ids: new Set(), deleted: new Set(), title: false, icon: false, any: false };
let saveTimer = null;
let saving = null;

const saveExpanded = () => localStorage.setItem('expanded', JSON.stringify([...state.expanded]));

// =====================================================================
// Sidebar
// =====================================================================
async function loadTree() {
  setTree(await rpc('listTree'));
}
/** Also called by the live `pages:tree` subscription. */
function setTree(tree) {
  state.tree = tree;
  state.flat = new Map();
  const walk = (nodes) => nodes.forEach((n) => (state.flat.set(n.id, n), walk(n.children)));
  walk(state.tree);
  renderSidebar();
}

function renderSidebar() {
  const tree = $('#tree');
  tree.replaceChildren(...state.tree.map((n) => treeNode(n, 0)));
  if (!state.tree.length) tree.append(h('div', { class: 'tree-empty', style: 'padding-left:12px' }, 'No pages yet'));
  const favs = [...state.flat.values()].filter((n) => n.favorite);
  $('#fav-section').hidden = !favs.length;
  $('#fav-list').replaceChildren(...favs.map((n) => treeNode({ ...n, children: [] }, 0, true)));
  refreshPageLinks();
}
/** Keep page-block titles/icons in the editor in sync with the tree. */
function refreshPageLinks() {
  document.querySelectorAll('.block.type-page').forEach((el) => {
    const b = getBlock(el.dataset.id);
    const n = b && state.flat.get(b.pageId);
    if (!n) return;
    el.querySelector('.pl-icon').textContent = iconOf(n);
    el.querySelector('.pl-title').textContent = label(n);
  });
}

function treeNode(n, depth, isFav = false) {
  const open = !isFav && state.expanded.has(n.id);
  const active = state.page?.id === n.id;
  const row = h(
    'div',
    {
      class: `tree-row${active ? ' active' : ''}`,
      style: `padding-left:${depth * 14 + 4}px`,
      draggable: isFav ? null : 'true',
      dataset: { id: n.id },
      onclick: () => go(n.id),
    },
    n.kind === 'database'
      ? h('span', { class: 'tree-toggle placeholder' })
      : h(
      'button',
      {
        class: `tree-toggle${open ? ' open' : ''}`,
        title: open ? 'Collapse' : 'Expand',
        onclick: (e) => {
          e.stopPropagation();
          if (isFav) return go(n.id);
          state.expanded.has(n.id) ? state.expanded.delete(n.id) : state.expanded.add(n.id);
          saveExpanded();
          renderSidebar();
        },
      },
      h('span', { html: CHEVRON }),
    ),
    h('span', { class: 'tree-icon' }, iconOf(n)),
    h('span', { class: 'tree-title' }, label(n)),
    h(
      'span',
      { class: 'tree-actions' },
      h('button', { class: 'icon-btn small', title: 'More', onclick: (e) => (e.stopPropagation(), pageMenu(e.currentTarget, n.id)) }, '⋯'),
      isFav || n.kind === 'database' ? null : h('button', { class: 'icon-btn small', title: 'Add a page inside', onclick: (e) => (e.stopPropagation(), newPage(n.id)) }, '＋'),
    ),
  );
  if (!isFav) attachTreeDnD(row, n);
  const node = h('div', { class: 'tree-node' }, row);
  if (open && n.kind !== 'database') {
    if (n.children.length) node.append(...n.children.map((c) => treeNode(c, depth + 1)));
    else node.append(h('div', { class: 'tree-empty', style: `padding-left:${depth * 14 + 34}px` }, 'No pages inside'));
  }
  return node;
}

// Pages can be dragged from the sidebar (treeDrag) or as page blocks from the editor (blockPageDrag).
let treeDrag = null;
let blockPageDrag = null;
const draggedPage = () => treeDrag || blockPageDrag;
const clearTreeDrop = () => document.querySelectorAll('.tree-row').forEach((r) => r.classList.remove('drop-inside', 'drop-before', 'drop-after'));
function isInside(ancestorId, id) {
  for (let cur = state.flat.get(id); cur; cur = cur.parentId ? state.flat.get(cur.parentId) : null) if (cur.id === ancestorId) return true;
  return false;
}
/** Move a page and refresh whatever is affected. */
async function movePage(id, parentId, index) {
  await flushSave();
  try {
    await rpc('updatePage', { pageId: id, parentId, ...(index != null ? { index } : {}) });
    if (parentId) state.expanded.add(parentId), saveExpanded();
    await loadTree();
    await reloadPage();
  } catch (err) {
    toast(err.message);
  }
}
function attachTreeDnD(row, n) {
  row.addEventListener('dragstart', (e) => {
    treeDrag = n.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', n.title || 'Untitled');
  });
  row.addEventListener('dragend', () => {
    treeDrag = null;
    clearTreeDrop();
  });
  row.addEventListener('dragover', (e) => {
    const id = draggedPage();
    if (!id || isInside(id, n.id)) return; // can't drop a page into itself or its descendants
    e.preventDefault();
    clearTreeDrop();
    const r = row.getBoundingClientRect();
    const y = e.clientY - r.top;
    row.classList.add(y < r.height * 0.28 ? 'drop-before' : y > r.height * 0.72 ? 'drop-after' : 'drop-inside');
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop-inside', 'drop-before', 'drop-after'));
  row.addEventListener('drop', async (e) => {
    e.preventDefault();
    const zone = row.classList.contains('drop-inside') ? 'inside' : row.classList.contains('drop-before') ? 'before' : 'after';
    clearTreeDrop();
    const id = draggedPage();
    treeDrag = blockPageDrag = null;
    if (!id || isInside(id, n.id)) return;
    if (zone === 'inside') return movePage(id, n.id);
    const parentId = n.parentId || null;
    const siblings = (parentId ? state.flat.get(parentId)?.children : state.tree) || [];
    const others = siblings.filter((s) => s.id !== id);
    const at = others.findIndex((s) => s.id === n.id) + (zone === 'after' ? 1 : 0);
    movePage(id, parentId, at);
  });
}
// Drop on the "Pages" label → move to the top level
const pagesLabel = $('.side-section:not(#fav-section) .side-label');
pagesLabel.addEventListener('dragover', (e) => draggedPage() && e.preventDefault());
pagesLabel.addEventListener('drop', (e) => {
  e.preventDefault();
  const id = draggedPage();
  treeDrag = blockPageDrag = null;
  if (id) movePage(id, null);
});

// =====================================================================
// Routing / opening pages
// =====================================================================
const currentRouteId = () => {
  const r = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  return r && !r.startsWith('invite/') && !r.startsWith('oauth') ? r : null;
};
function go(id) {
  if (currentRouteId() === id) return;
  location.hash = '/' + id;
}
window.addEventListener('hashchange', () => WS_ID && openPage(currentRouteId()));

async function openPage(id, { focusBlockId } = {}) {
  closePop();
  await flushSave();
  if (!id) {
    const first = state.tree[0];
    if (first) return go(first.id);
    state.page = null;
    return renderEmpty();
  }
  try {
    state.page = await rpc('getPage', { pageId: id });
  } catch (err) {
    state.page = null;
    if (err.status === 404) {
      // Maybe it lives in another of my workspaces (e.g. a link a teammate sent)
      const workspaceId = await query(cx.workspaces.locate, { session: session.get(), pid: id }).catch(() => null);
      if (workspaceId && workspaceId !== WS_ID) return switchWorkspace(workspaceId, id);
      localStorage.removeItem(lastPageKey());
      postPresence(null);
      watchPage(null);
      return renderEmpty('This page does not exist.');
    }
    throw err;
  }
  resetDirty();
  postPresence(id);
  watchPage(id);
  localStorage.setItem(lastPageKey(), id);
  if (currentRouteId() !== id) history.replaceState(null, '', '#/' + id);
  renderPage();
  renderSidebar();
  $('#scroller').scrollTop = 0;
  if (focusBlockId) {
    const el = blockElById(focusBlockId);
    if (el) {
      el.scrollIntoView({ block: 'center' });
      el.classList.add('flash');
    }
  } else if (!state.page.title && !state.page.blocks.some((b) => b.text)) {
    $('.page-title')?.focus();
  }
}

async function reloadPage() {
  if (!state.page) return;
  const fresh = await rpc('getPage', { pageId: state.page.id }).catch(() => null);
  if (fresh) applyServerPage(fresh, false);
}

async function newPage(parentId = null, opts = {}) {
  const p = await rpc('createPage', { title: '', parentId });
  if (parentId) {
    state.expanded.add(parentId);
    saveExpanded();
  }
  await loadTree();
  go(p.id);
  return p;
}

// =====================================================================
// Saving (debounced, optimistic concurrency with merge on conflict)
// =====================================================================
function resetDirty() {
  dirty.ids.clear();
  dirty.deleted.clear();
  dirty.title = dirty.icon = dirty.any = false;
  clearTimeout(saveTimer);
}
function markDirty(blockId, kind) {
  if (blockId) dirty.ids.add(blockId);
  if (kind === 'title') dirty.title = true;
  if (kind === 'icon') dirty.icon = true;
  dirty.any = true;
  setEditedLabel('Saving…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 450);
}
async function flushSave() {
  clearTimeout(saveTimer);
  if (saving) await saving;
  if (dirty.any) await save();
}
function save() {
  if (saving) {
    return saving.then(() => dirty.any && save());
  }
  const page = state.page;
  if (!page || !dirty.any) return Promise.resolve();
  const snap = { ids: new Set(dirty.ids), deleted: new Set(dirty.deleted), title: dirty.title, icon: dirty.icon };
  resetDirty();
  saving = (async () => {
    try {
      const r = await rpc('savePage', {
        pageId: page.id,
        title: page.title,
        icon: page.icon,
        blocks: page.blocks,
        baseVersion: page.version,
      });
      page.version = r.version;
      page.updatedAt = r.updatedAt;
      page.lastEditedBy = state.me?.name || 'user';
      setEditedLabel();
      if (r.archived?.length) {
        toast(r.archived.length === 1 ? 'Page moved to Trash' : `${r.archived.length} pages moved to Trash`);
        loadTree();
      }
      // The server may normalise blocks (e.g. sub-page titles); adopt that if nothing changed meanwhile.
      if (!dirty.any && state.page === page && !sameBlocks(r.blocks, page.blocks)) {
        applyServerPage({ ...page, blocks: r.blocks }, false);
      }
    } catch (err) {
      // put the unsaved edits back
      snap.ids.forEach((id) => dirty.ids.add(id));
      snap.deleted.forEach((id) => dirty.deleted.add(id));
      dirty.title ||= snap.title;
      dirty.icon ||= snap.icon;
      dirty.any = true;
      if (err.status === 409 && err.page && state.page === page) {
        applyServerPage(err.page, true);
      } else if (err.status === 404) {
        dirty.any = false;
        toast('This page was deleted');
      } else {
        toast('Could not save: ' + err.message);
        setEditedLabel('Unsaved changes');
        return;
      }
    } finally {
      saving = null;
    }
    if (dirty.any && state.page === page) await save();
  })();
  return saving;
}
// Save right away when the tab is hidden or closed; warn if something is still unsaved.
document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flushSave());
window.addEventListener('beforeunload', (e) => {
  if (dirty.any || saving) {
    flushSave();
    e.preventDefault();
  }
});

/** Content-only fingerprint of a block (ignores key order / defaulted fields). */
const canon = (b) => JSON.stringify([b.id, b.type, b.text || '', b.pageId || '', !!b.checked, b.indent || 0, b.icon || '', b.language || '', b.url || '', b.databaseId || '', b.view || null]);
const sameBlocks = (a, b) => a.length === b.length && a.every((x, i) => canon(x) === canon(b[i]));

/** Merge a fresher server copy of the open page with local unsaved edits and re-render. */
function applyServerPage(server, keepLocal = dirty.any) {
  const local = state.page;
  const before = new Map(local.blocks.map((b) => [b.id, canon(b)]));
  let blocks = server.blocks;
  if (keepLocal) {
    const localMap = new Map(local.blocks.map((b) => [b.id, b]));
    const serverIds = new Set(server.blocks.map((b) => b.id));
    blocks = server.blocks.filter((b) => !dirty.deleted.has(b.id)).map((b) => (dirty.ids.has(b.id) && localMap.has(b.id) ? localMap.get(b.id) : b));
    local.blocks.forEach((b, i) => {
      if (!dirty.ids.has(b.id) || serverIds.has(b.id)) return;
      const prev = local.blocks[i - 1];
      const at = prev ? blocks.findIndex((x) => x.id === prev.id) : -1;
      blocks.splice(at + 1, 0, b);
    });
  }
  const next = { ...server, blocks };
  if (keepLocal && dirty.title) next.title = local.title;
  if (keepLocal && dirty.icon) next.icon = local.icon;
  const changed = blocks.filter((b) => before.get(b.id) !== canon(b)).map((b) => b.id);
  const sameShape =
    local.blocks.length === blocks.length && local.blocks.every((b, i) => b.id === blocks[i].id) && local.title === next.title && local.icon === next.icon && !!local.archived === !!next.archived;
  state.page = next;
  if (sameShape) patchBlocks(changed); // only re-draw what changed, so collaborators can keep typing
  else rerenderPreservingFocus(changed);
  renderTop();
  renderSubpages();
  if (keepLocal) markDirty();
}

/** Re-render just these blocks, keeping the caret if one of them is being edited. */
function patchBlocks(ids) {
  for (const id of ids) {
    const b = getBlock(id);
    const old = blockElById(id);
    if (!b || !old) continue;
    const active = old.contains(document.activeElement) ? getSel(document.activeElement) : null;
    const el = replaceBlockEl(b);
    if (active) {
      const t = el.querySelector('.text');
      if (t) {
        t.focus({ preventScroll: true });
        const len = getText(t).length;
        setCaret(t, Math.min(active.start, len), Math.min(active.end, len));
      }
    }
    el.classList.add('flash');
  }
}

// =====================================================================
// Page rendering
// =====================================================================
function renderEmpty(msg) {
  document.title = 'Workspace';
  $('#page').classList.remove('wide');
  $('#breadcrumb').replaceChildren();
  $('#edited-label').textContent = '';
  $('#btn-fav').hidden = $('#btn-page-menu').hidden = $('#btn-comments').hidden = true;
  closeComments();
  $('#page').replaceChildren(
    h(
      'div',
      { class: 'empty-state' },
      h('p', {}, msg || 'No pages yet.'),
      h('button', { class: 'btn', onclick: () => newPage() }, '＋ New page'),
    ),
  );
}

function renderTop() {
  const p = state.page;
  document.title = `${p.icon ? p.icon + ' ' : ''}${label(p)}`;
  const crumbs = [...p.breadcrumb, p];
  const bc = $('#breadcrumb');
  bc.replaceChildren();
  crumbs.forEach((c, i) => {
    if (i) bc.append(h('span', { class: 'crumb-sep' }, '/'));
    bc.append(h('button', { class: 'crumb', onclick: () => go(c.id) }, `${c.icon ? c.icon + ' ' : ''}${label(c)}`));
  });
  $('#btn-fav').hidden = $('#btn-page-menu').hidden = $('#btn-comments').hidden = false;
  renderCommentBadge();
  if (comments.open && comments.pageId !== p.id) openComments();
  const fav = state.flat.get(p.id)?.favorite;
  $('#btn-fav').textContent = fav ? '★' : '☆';
  $('#btn-fav').classList.toggle('on', !!fav);
  $('#btn-fav').title = fav ? 'Remove from favorites' : 'Add to favorites';
  setEditedLabel();
  renderPresence();
}

// ---------- presence (who else is looking at this page) ----------
const initials = (name) =>
  String(name || '?')
    .split(/\s+/)
    .map((s) => s[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
const avatar = (u, cls = '') => h('span', { class: `avatar ${cls}`, style: `background:${u.color || '#888'}`, title: u.name }, initials(u.name));
function renderPresence() {
  const wrap = $('#presence');
  const here = new Map();
  const fresh = Date.now() - 70_000; // tabs heartbeat every 20s
  for (const p of state.presence) {
    if (p.lastSeen > fresh && p.userId !== state.me?.id && state.page && p.pageId === state.page.id) here.set(p.userId, p);
  }
  wrap.replaceChildren(...[...here.values()].slice(0, 5).map((u) => avatar(u)));
  wrap.title = [...here.values()].map((u) => u.name).join(', ') + (here.size ? ' viewing this page' : '');
}
let presencePage = null;
function postPresence(pageId = presencePage) {
  presencePage = pageId;
  if (!WS_ID) return;
  mutation(cx.presence.heartbeat, { ...ws(), clientId: CLIENT_ID, pageId: pageId || null }).catch(() => {});
}
setInterval(() => document.visibilityState === 'visible' && postPresence(), 20_000);
window.addEventListener('pagehide', () => mutation(cx.presence.leave, { clientId: CLIENT_ID }).catch(() => {}));

function setEditedLabel(override) {
  const el = $('#edited-label');
  if (!state.page) return (el.textContent = '');
  if (override) {
    el.textContent = override;
    el.classList.remove('agent');
    return;
  }
  const by = state.page.lastEditedBy;
  const byAgent = by === 'agent';
  const who = byAgent ? '🤖 Agent edited' : by && !['user', 'system', state.me?.name].includes(by) ? `${by} edited` : 'Edited';
  el.textContent = `${who} ${timeAgo(state.page.updatedAt)}`;
  el.classList.toggle('agent', byAgent);
}

function renderPage() {
  const p = state.page;
  if (!p.blocks.length) p.blocks.push({ id: newId(), type: 'paragraph', text: '' });
  renderTop();
  const root = $('#page');
  root.classList.toggle('wide', p.kind === 'database');
  root.replaceChildren();

  if (p.archived) {
    root.append(
      h(
        'div',
        { class: 'type-callout' },
        h(
          'div',
          { class: 'block-body', style: 'background:rgba(235,87,87,.12);align-items:center;gap:10px' },
          h('span', {}, '🗑 This page is in the Trash.'),
          h('button', { class: 'btn', onclick: async () => (await rpc('restorePage', { pageId: p.id }), await loadTree(), reloadPage()) }, 'Restore'),
          h(
            'button',
            {
              class: 'btn danger',
              onclick: async () => {
                if (!confirm('Delete this page forever? This cannot be undone.')) return;
                await rpc('deletePage', { pageId: p.id });
                resetDirty();
                state.page = null;
                await loadTree();
                location.hash = '';
                openPage(null);
              },
            },
            'Delete forever',
          ),
        ),
      ),
    );
  }

  const iconWrap = h('div', { class: 'page-icon-wrap' });
  if (p.icon) {
    iconWrap.append(h('span', { class: 'page-icon', title: 'Change icon', onclick: (e) => iconPicker(e.currentTarget, setPageIcon, true) }, p.icon));
  } else {
    iconWrap.append(
      h(
        'div',
        { class: 'page-meta-actions' },
        h('button', { class: 'ghost-btn', onclick: () => setPageIcon(EMOJIS[Math.floor(Math.random() * 40)]) }, '☺ Add icon'),
      ),
    );
  }
  const title = h('h1', { class: 'page-title', contenteditable: EDITABLE, spellcheck: 'true', 'data-placeholder': 'Untitled' });
  title.textContent = p.title;
  title.addEventListener('input', () => {
    p.title = getText(title).replace(/\n/g, ' ');
    markDirty(null, 'title');
    const node = state.flat.get(p.id);
    if (node) node.title = p.title;
    renderTop();
    renderSidebar();
  });
  title.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || (e.key === 'ArrowDown' && caretOnEdgeLine(title, false))) {
      e.preventDefault();
      if (e.key === 'Enter') {
        const sel = getSel(title);
        const text = getText(title);
        if (sel && sel.start < text.length) {
          // move the text after the caret into a new first block
          const rest = text.slice(sel.start);
          title.textContent = p.title = text.slice(0, sel.start);
          markDirty(null, 'title');
          const nb = { id: newId(), type: 'paragraph', text: rest };
          insertBlock(nb, 0);
          return focusBlock(nb.id, 0);
        }
        const first = p.blocks[0];
        if (first && first.type === 'paragraph' && !first.text) return focusBlock(first.id, 0);
        const nb = { id: newId(), type: 'paragraph', text: '' };
        insertBlock(nb, 0);
        return focusBlock(nb.id, 0);
      }
      focusBlock(p.blocks[0]?.id, 0);
    }
  });
  title.addEventListener('paste', (e) => {
    e.preventDefault();
    document.execCommand('insertText', false, e.clipboardData.getData('text/plain').replace(/\s*\n\s*/g, ' '));
  });

  const blocksEl = h('div', { class: 'blocks' });
  wireBlocks(blocksEl);
  const below = h('div', {
    class: 'click-below',
    onclick: () => {
      const last = p.blocks[p.blocks.length - 1];
      if (last && last.type === 'paragraph' && !last.text) return focusBlock(last.id, 0);
      const nb = { id: newId(), type: 'paragraph', text: '' };
      insertBlock(nb, p.blocks.length);
      focusBlock(nb.id, 0);
    },
  });
  const sub = h('div', { class: 'subpages' });
  const rowPanel = p.row ? h('div', { class: 'row-panel' }, rowPropertiesPanel(p, dbDeps)) : null;
  if (p.kind === 'database') {
    if (!dbView || dbView.pageId !== p.id) {
      dbView?.destroy();
      dbView = { pageId: p.id, ...createDatabaseView(p.id, dbDeps) };
    }
  } else if (dbView) {
    dbView.destroy();
    dbView = null;
  }
  root.append(...[iconWrap, title, rowPanel, blocksEl, dbView?.el, sub, below].filter(Boolean));
  renderBlocks();
  renderSubpages();
}

// ---------- databases ----------
let dbView = null; // { pageId, el, destroy } for the open database page
const dbDeps = {
  h,
  rpc,
  go: (id) => flushSave().then(() => go(id)),
  toast,
  openPop: (...a) => openPop(...a),
  closePop: () => closePop(),
  menu: (...a) => menu(...a),
  askInput: (...a) => askInput(...a),
  watch,
  cx,
  ws: () => ws(),
  me: () => state.me,
  avatar: (...a) => avatar(...a),
  /** Databases of this workspace, for relation pickers. */
  databases: () => [...state.flat.values()].filter((n) => n.kind === 'database').map((n) => ({ id: n.id, title: label(n), icon: n.icon })),
  /** Schema of another database (for rollup settings). */
  databaseSchema: (id) => query(cx.pages.rows, { ...ws(), pageId: id }),
  /** Upload a file for a files property → { name, url, storageId }. */
  upload: async (file) => {
    if (file.size > 20 * 1024 * 1024) throw new Error(`${file.name} is larger than 20 MB`);
    const url = await mutation(cx.files.uploadUrl, ws());
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
    if (!res.ok) throw new Error(`Upload failed (${res.status})`);
    const { storageId } = await res.json();
    return mutation(cx.files.register, { ...ws(), storageId, name: file.name });
  },
};
// Linked database views embedded in pages: one live component per block, reused across redraws.
const linkedViews = new Map(); // block id -> { databaseId, inst }
function linkedViewEl(b) {
  let entry = linkedViews.get(b.id);
  if (entry && entry.databaseId !== b.databaseId) {
    entry.inst.destroy();
    entry = null;
  }
  if (!entry) {
    const inst = createDatabaseView(b.databaseId, dbDeps, {
      linked: {
        view: b.view || {},
        onChange: (view) => {
          const blk = getBlock(b.id);
          if (!blk) return;
          blk.view = view;
          markDirty(blk.id);
        },
        onRemove: () => {
          removeBlock(b.id);
        },
        // "@this_page" filters refer to the page this view sits on
        thisPage: state.page ? { id: state.page.id, title: state.page.title } : null,
      },
    });
    entry = { databaseId: b.databaseId, inst };
    linkedViews.set(b.id, entry);
  } else entry.inst.setLinkedView(b.view || {});
  return entry.inst.el;
}
// drop the live subscriptions of linked views that are no longer on screen
setInterval(() => {
  for (const [id, e] of linkedViews) {
    if (!e.inst.el.isConnected) {
      e.inst.destroy();
      linkedViews.delete(id);
    }
  }
}, 4000);

async function addLinkedView(b) {
  const dbs = [...state.flat.values()].filter((n) => n.kind === 'database' && n.id !== state.page.id);
  const anchor = blockElById(b.id) || $('#page');
  if (!dbs.length) return toast('No databases yet — type /database to create one');
  menu(anchor, [
    { label: 'Show which database?' },
    ...dbs.map((n) => ({
      icon: iconOf(n),
      name: label(n),
      run: () => {
        const blk = getBlock(b.id);
        if (!blk) return;
        convertBlock(blk, 'database_view', { text: '', databaseId: n.id, view: { name: label(n), type: 'table', filters: [], sorts: [] } });
        const nb = { id: newId(), type: 'paragraph', text: '' };
        insertAfter(blk.id, nb);
      },
    })),
  ]);
}

// ---------- comments ----------
const comments = { open: false, pageId: null, unsub: null, counts: {}, countsUnsub: null, el: null };
function renderCommentBadge() {
  const n = state.page ? comments.counts[state.page.id] || 0 : 0;
  const b = $('#btn-comments .badge');
  b.hidden = !n;
  b.textContent = n;
  $('#btn-comments').title = n ? `${n} open comment thread${n === 1 ? '' : 's'}` : 'Comments';
}
function watchCommentCounts() {
  comments.countsUnsub?.();
  comments.countsUnsub = watch(cx.comments.counts, ws(), (c) => {
    comments.counts = c || {};
    renderCommentBadge();
  });
}
function closeComments() {
  comments.open = false;
  comments.unsub?.();
  comments.unsub = null;
  comments.el?.remove();
  comments.el = null;
  document.body.classList.remove('comments-open');
}
function openComments() {
  if (!state.page) return;
  comments.unsub?.();
  comments.open = true;
  const pageId = (comments.pageId = state.page.id);
  if (!comments.el) {
    comments.el = h('aside', { class: 'comments-panel' });
    $('#main').append(comments.el);
  }
  document.body.classList.add('comments-open');
  const panel = comments.el;
  let data = null;
  let showResolved = false;
  let pending = false;
  const call = (fn, args) => mutation(fn, { ...ws(), ...args }).catch((err) => (toast(err.message), null));
  const members = () => state.members || [];
  /** A textarea that suggests @mentions. */
  const composer = (placeholder, onSend, initial = '') => {
    const ta = h('textarea', { class: 'cm-input', rows: 2, placeholder });
    ta.value = initial;
    const sugg = h('div', { class: 'cm-suggest' });
    const send = h('button', { class: 'btn primary small', onclick: () => submit() }, 'Send');
    const submit = async () => {
      const text = ta.value.trim();
      if (!text) return;
      send.disabled = true;
      const ok = await onSend(text);
      send.disabled = false;
      sugg.replaceChildren();
      if (ok !== null) {
        ta.value = '';
        pending = false;
        render(); // show it now, even though the box still has focus
      }
    };
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        submit();
      }
    });
    ta.addEventListener('input', () => {
      const before = ta.value.slice(0, ta.selectionStart);
      const m = before.match(/@([\p{L}\p{N}_.-]*)$/u);
      if (!m) return sugg.replaceChildren();
      const q = m[1].toLowerCase();
      const hits = members().filter((x) => x.name.toLowerCase().includes(q)).slice(0, 6);
      sugg.replaceChildren(
        ...hits.map((x) =>
          h(
            'button',
            {
              class: 'cm-chip',
              onmousedown: (e) => {
                e.preventDefault();
                const start = before.length - m[0].length;
                ta.value = `${ta.value.slice(0, start)}@${x.name} ${ta.value.slice(ta.selectionStart)}`;
                ta.selectionStart = ta.selectionEnd = start + x.name.length + 2;
                sugg.replaceChildren();
                ta.focus();
              },
            },
            x.kind === 'agent' ? '🤖 ' : '@',
            x.name,
          ),
        ),
      );
    });
    return { el: h('div', { class: 'cm-composer' }, ta, sugg, h('div', { class: 'cm-row' }, h('span', { class: 'sub' }, 'Ctrl+Enter to send · @ to mention'), send)), focus: () => ta.focus() };
  };
  const textWithMentions = (c) => {
    // highlight @Name for the mentioned members
    const names = c.mentions.map((m) => m.name).filter(Boolean).sort((a, b) => b.length - a.length);
    if (!names.length) return [c.text];
    const re = new RegExp(`(@(?:${names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}))`, 'gi');
    return c.text.split(re).map((part, i) => (i % 2 ? h('span', { class: 'cm-mention' }, part) : part));
  };
  const commentEl = (c, thread) => {
    const mine = c.author.id === state.me.id;
    const owner = currentWs()?.role === 'owner';
    const body = h('div', { class: 'cm-text' }, textWithMentions(c));
    return h(
      'div',
      { class: 'cm-comment' },
      h(
        'div',
        { class: 'cm-head' },
        c.author.kind === 'agent' ? h('span', { class: 'avatar tiny agent' }, '🤖') : avatar(members().find((m) => m.id === c.author.id) || { name: c.author.name, color: '#999' }, 'tiny'),
        h('b', {}, c.author.name),
        h('span', { class: 'sub' }, timeAgo(c.createdAt) + (c.editedAt ? ' · edited' : '')),
        h('span', { class: 'grow' }),
        !c.parentId
          ? h('button', { class: 'icon-btn small', title: thread.resolved ? 'Reopen' : 'Resolve', onclick: () => call(cx.comments.resolve, { commentId: c.id, resolved: !thread.resolved }) }, thread.resolved ? '↺' : '✓')
          : null,
        mine || owner
          ? h(
              'button',
              {
                class: 'icon-btn small',
                title: 'More',
                onclick: (e) =>
                  menu(e.currentTarget, [
                    mine
                      ? {
                          icon: '✎',
                          name: 'Edit',
                          run: () => {
                            const ed = composer('Edit comment', (text) => call(cx.comments.edit, { commentId: c.id, text }), c.text);
                            body.replaceWith(ed.el);
                            ed.focus();
                          },
                        }
                      : null,
                    { icon: '🗑', name: c.parentId ? 'Delete' : 'Delete thread', danger: true, run: () => confirm('Delete this comment?') && call(cx.comments.remove, { commentId: c.id }) },
                  ]),
              },
              '⋯',
            )
          : null,
      ),
      body,
    );
  };
  const render = () => {
    if (!panel.isConnected) return;
    const threads = data?.threads || [];
    const open = threads.filter((t) => !t.resolved);
    const resolved = threads.filter((t) => t.resolved);
    const top = composer('Add a comment…', (text) => call(cx.comments.add, { pageId, text }));
    const threadEl = (t) => {
      const replyBox = h('div');
      return h(
        'div',
        { class: `cm-thread${t.resolved ? ' resolved' : ''}` },
        commentEl(t, t),
        t.replies.map((r) => commentEl(r, t)),
        h(
          'button',
          {
            class: 'cm-reply-btn',
            onclick: (e) => {
              const c = composer('Reply…', (text) => call(cx.comments.add, { pageId, text, parentId: t.id }));
              replyBox.replaceChildren(c.el);
              e.currentTarget.remove();
              c.focus();
            },
          },
          'Reply',
        ),
        replyBox,
      );
    };
    panel.replaceChildren(
      h('div', { class: 'cm-top' }, h('b', {}, 'Comments'), h('span', { class: 'sub' }, data ? `${open.length} open` : ''), h('span', { class: 'grow' }), h('button', { class: 'icon-btn', title: 'Close', onclick: closeComments }, '✕')),
      h('div', { class: 'cm-list' }, !data ? h('div', { class: 'empty-note' }, 'Loading…') : !threads.length ? h('div', { class: 'empty-note' }, 'No comments yet. Ask a question or leave a note — agents can read and answer them too.') : null, open.map(threadEl), resolved.length ? h('button', { class: 'cm-resolved-toggle', onclick: () => ((showResolved = !showResolved), render()) }, `${showResolved ? '▾' : '▸'} Resolved (${resolved.length})`) : null, showResolved ? resolved.map(threadEl) : null),
      top.el,
    );
  };
  panel.addEventListener('focusout', () =>
    setTimeout(() => {
      if (pending && !panel.contains(document.activeElement)) {
        pending = false;
        render();
      }
    }, 0),
  );
  render();
  comments.unsub = watch(cx.comments.list, { ...ws(), pageId }, (d) => {
    data = d;
    if (panel.contains(document.activeElement) && document.activeElement.matches('textarea') && document.activeElement.value) pending = true;
    else render();
  });
}

/** Redraw an item's property panel after a change from elsewhere (unless someone is typing in it). */
function refreshRowPanel() {
  const panel = $('.row-panel');
  if (!panel || !state.page?.row || panel.contains(document.activeElement)) return;
  panel.replaceChildren(rowPropertiesPanel(state.page, dbDeps));
}

// Sub-pages are shown as page blocks inside the content; this just keeps their titles fresh.
function renderSubpages() {
  refreshPageLinks();
}

function setPageIcon(icon) {
  state.page.icon = icon;
  markDirty(null, 'icon');
  const node = state.flat.get(state.page.id);
  if (node) node.icon = icon;
  renderSidebar();
  const focusTitle = false;
  rerenderPreservingFocus([], focusTitle);
}

// =====================================================================
// Blocks
// =====================================================================
const PLACEHOLDERS = {
  paragraph: "Type '/' for commands",
  heading_1: 'Heading 1',
  heading_2: 'Heading 2',
  heading_3: 'Heading 3',
  bulleted_list: 'List',
  numbered_list: 'List',
  to_do: 'To-do',
  quote: 'Empty quote',
  callout: 'Type something…',
  code: '',
};
const getBlock = (id) => state.page?.blocks.find((b) => b.id === id);
const blockIndex = (id) => state.page.blocks.findIndex((b) => b.id === id);
const blockElById = (id) => document.querySelector(`.block[data-id="${CSS.escape(id)}"]`);
const textElById = (id) => blockElById(id)?.querySelector('.text');
const hasText = (b) => b && !ATOMIC_TYPES.includes(b.type);

function numbers() {
  const map = new Map();
  const counters = [];
  let prev = null;
  for (const b of state.page.blocks) {
    const ind = b.indent || 0;
    if (b.type === 'numbered_list') {
      if (prev && LIST_TYPES.includes(prev.type)) {
        counters.length = ind + 1;
        counters[ind] = (counters[ind] || 0) + 1;
      } else {
        counters.length = 0;
        counters[ind] = 1;
      }
      map.set(b.id, counters[ind]);
    } else if (LIST_TYPES.includes(b.type)) {
      counters.length = ind + 1;
      counters[ind] = 0;
    } else counters.length = 0;
    prev = b;
  }
  return map;
}
function renumber() {
  const nums = numbers();
  document.querySelectorAll('.block.type-numbered_list').forEach((el) => {
    const n = el.querySelector('.prefix.number');
    if (n) n.textContent = (nums.get(el.dataset.id) || 1) + '.';
  });
  const only = state.page.blocks.length === 1 && state.page.blocks[0].type === 'paragraph';
  document.querySelectorAll('.block').forEach((el) => el.classList.toggle('only-block', only));
}

function renderBlocks() {
  const wrap = $('.blocks');
  wrap.replaceChildren(...state.page.blocks.map(blockEl));
  renumber();
}

function blockEl(b) {
  const el = h('div', {
    class: `block type-${b.type}${b.indent ? ` indent-${b.indent}` : ''}${b.type === 'to_do' && b.checked ? ' checked' : ''}`,
    dataset: { id: b.id },
    style: b.indent ? `margin-left:${b.indent * 26}px` : null,
  });
  const gutter = h(
    'div',
    { class: 'gutter', contenteditable: 'false' },
    h('button', { class: 'add', title: 'Click to add a block below' }, '+'),
    h('button', { class: 'handle', title: 'Drag to move\nClick for options', draggable: 'true' }, '⋮⋮'),
  );
  const body = h('div', { class: 'block-body' });
  const text = () => {
    const t = h('div', {
      class: 'text',
      contenteditable: EDITABLE,
      spellcheck: b.type === 'code' ? 'false' : 'true',
      'data-placeholder': PLACEHOLDERS[b.type] ?? '',
    });
    t.innerHTML = highlight(b.text || '', b.type);
    return t;
  };
  switch (b.type) {
    case 'bulleted_list':
      body.append(h('div', { class: 'prefix bullet' }), text());
      break;
    case 'numbered_list':
      body.append(h('div', { class: 'prefix number' }, '1.'), text());
      break;
    case 'to_do':
      body.append(h('div', { class: 'prefix check' }, h('div', { class: `checkbox${b.checked ? ' on' : ''}`, role: 'checkbox', 'aria-checked': String(!!b.checked) })), text());
      break;
    case 'callout':
      body.append(h('div', { class: 'callout-icon', title: 'Change icon' }, b.icon || '💡'), text());
      break;
    case 'code':
      body.append(
        h('input', { class: 'code-lang', value: b.language || '', placeholder: 'plain text', spellcheck: 'false' }),
        h('button', { class: 'copy-code' }, 'Copy'),
        text(),
      );
      break;
    case 'divider':
      body.append(h('hr'));
      body.tabIndex = 0;
      break;
    case 'page': {
      const n = state.flat.get(b.pageId);
      body.tabIndex = 0;
      body.title = 'Open page (Enter) · Backspace moves it to Trash';
      body.append(h('span', { class: 'pl-icon' }, n ? iconOf(n) : '📄'), h('span', { class: 'pl-title' }, n ? label(n) : b.text || 'Untitled'));
      break;
    }
    case 'database_view': {
      body.tabIndex = 0;
      body.append(linkedViewEl(b));
      break;
    }
    case 'image':
      if (b.url) body.append(h('img', { src: b.url, alt: b.text || '', loading: 'lazy' }));
      else body.append(h('div', { class: 'img-empty' }, '🖼  Add an image — click to paste a URL'));
      body.append(text());
      break;
    default:
      body.append(text());
  }
  el.append(gutter, body);
  return el;
}

function replaceBlockEl(b) {
  const old = blockElById(b.id);
  const fresh = blockEl(b);
  old ? old.replaceWith(fresh) : null;
  renumber();
  return fresh;
}

function insertBlock(b, index) {
  state.page.blocks.splice(index, 0, b);
  const wrap = $('.blocks');
  const el = blockEl(b);
  const next = wrap.children[index];
  next ? wrap.insertBefore(el, next) : wrap.append(el);
  dirty.deleted.delete(b.id);
  markDirty(b.id);
  renumber();
  return el;
}
const insertAfter = (afterId, b) => insertBlock(b, blockIndex(afterId) + 1);

function removeBlock(id) {
  const i = blockIndex(id);
  if (i < 0) return;
  state.page.blocks.splice(i, 1);
  blockElById(id)?.remove();
  dirty.ids.delete(id);
  dirty.deleted.add(id);
  markDirty();
  if (!state.page.blocks.length) {
    const nb = { id: newId(), type: 'paragraph', text: '' };
    insertBlock(nb, 0);
  }
  renumber();
}

function setBlockText(b, text) {
  b.text = text;
  const el = textElById(b.id);
  if (el) el.innerHTML = highlight(text, b.type);
  markDirty(b.id);
}

function focusBlock(id, pos = 'end', posEnd) {
  const b = getBlock(id);
  if (!b) return;
  if (ATOMIC_TYPES.includes(b.type)) {
    const body = blockElById(id)?.querySelector('.block-body');
    body?.focus({ preventScroll: true });
    body?.scrollIntoView({ block: 'nearest' });
    return;
  }
  const el = textElById(id);
  if (!el) return;
  el.focus({ preventScroll: true });
  const len = getText(el).length;
  const p = pos === 'end' ? len : pos === 'start' ? 0 : Math.min(pos, len);
  setCaret(el, p, posEnd ?? p);
  el.scrollIntoView({ block: 'nearest' });
}

function convertBlock(b, type, extra = {}) {
  b.type = type;
  Object.assign(b, extra);
  if (!LIST_TYPES.includes(type)) delete b.indent;
  if (type === 'to_do') b.checked ??= false;
  if (type === 'callout') b.icon ||= '💡';
  if (type === 'code') b.language ??= '';
  if (type === 'divider') b.text = '';
  replaceBlockEl(b);
  markDirty(b.id);
}

function rerenderPreservingFocus(flashIds = [], _focusTitle) {
  if (!state.page) return;
  const active = document.activeElement;
  let restore = null;
  if (active?.classList?.contains('text')) {
    const id = active.closest('.block')?.dataset.id;
    restore = { kind: 'block', id, sel: getSel(active) };
  } else if (active?.classList?.contains('page-title')) {
    restore = { kind: 'title', sel: getSel(active) };
  }
  renderPage();
  if (restore?.kind === 'block' && getBlock(restore.id)) {
    const el = textElById(restore.id);
    if (el) {
      el.focus({ preventScroll: true });
      const len = getText(el).length;
      if (restore.sel) setCaret(el, Math.min(restore.sel.start, len), Math.min(restore.sel.end, len));
    }
  } else if (restore?.kind === 'title') {
    const t = $('.page-title');
    t.focus({ preventScroll: true });
    if (restore.sel) setCaret(t, Math.min(restore.sel.start, getText(t).length));
  }
  for (const id of flashIds) {
    const el = blockElById(id);
    if (el) {
      el.classList.remove('flash');
      void el.offsetWidth;
      el.classList.add('flash');
    }
  }
}

// ---------- markdown shortcuts ----------
const SHORTCUTS = [
  [/^#\s/, 'heading_1'],
  [/^##\s/, 'heading_2'],
  [/^###\s/, 'heading_3'],
  [/^[-*+]\s/, 'bulleted_list'],
  [/^1[.)]\s/, 'numbered_list'],
  [/^\[\s?\]\s/, 'to_do'],
  [/^\[[xX]\]\s/, 'to_do', { checked: true }],
  [/^>\s/, 'quote'],
  [/^"\s/, 'quote'],
  [/^!\s/, 'callout'],
];
function applyShortcut(b, el, text, sel) {
  if (!sel || sel.start !== sel.end) return false;
  if (b.type === 'paragraph' && text === '---') {
    convertBlock(b, 'divider');
    const nb = { id: newId(), type: 'paragraph', text: '' };
    insertAfter(b.id, nb);
    focusBlock(nb.id, 0);
    return true;
  }
  if (b.type === 'paragraph' && text.startsWith('```') && sel.start === 3) {
    convertBlock(b, 'code', { text: text.slice(3) });
    focusBlock(b.id, 0);
    return true;
  }
  if (b.type !== 'paragraph' && !(b.type === 'bulleted_list' && /^\[/.test(text))) return false;
  for (const [re, type, extra] of SHORTCUTS) {
    const m = text.match(re);
    if (m && sel.start === m[0].length) {
      convertBlock(b, type, { ...extra, text: text.slice(m[0].length) });
      focusBlock(b.id, 0);
      return true;
    }
  }
  return false;
}

// ---------- event wiring ----------
function wireBlocks(wrap) {
  wrap.addEventListener('input', onInput);
  wrap.addEventListener('keydown', onKeyDown);
  wrap.addEventListener('paste', onPaste);
  wrap.addEventListener('compositionend', (e) => {
    const el = e.target.closest?.('.text');
    if (!el) return;
    const b = getBlock(el.closest('.block').dataset.id);
    const text = getText(el);
    b.text = text;
    rehighlight(el, b);
    markDirty(b.id);
  });
  wrap.addEventListener('mousedown', (e) => {
    const a = e.target.closest('a[href]');
    const t = e.target.closest('.text');
    if (a && t && (document.activeElement !== t || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      window.open(a.href, '_blank', 'noopener');
    }
  });
  wrap.addEventListener('click', onBlockClick);
  wireBlockDnD(wrap);
}

function rehighlight(el, b) {
  const text = getText(el);
  const html = highlight(text, b.type);
  if (el.innerHTML !== html) {
    const sel = getSel(el);
    el.innerHTML = html;
    if (sel && document.activeElement === el) setCaret(el, sel.start, sel.end);
  }
}

function onInput(e) {
  if (e.target.classList.contains('code-lang')) {
    const b = getBlock(e.target.closest('.block').dataset.id);
    b.language = e.target.value;
    return markDirty(b.id);
  }
  const el = e.target.closest('.text');
  if (!el) return;
  const b = getBlock(el.closest('.block').dataset.id);
  if (!b) return;
  const text = getText(el);
  b.text = text;
  markDirty(b.id);
  if (e.isComposing) return;
  const sel = getSel(el);
  if (b.type !== 'code' && applyShortcut(b, el, text, sel)) return closeSlash();
  rehighlight(el, b);
  if (e.inputType === 'insertText' && e.data === '/' && sel && b.type !== 'code') {
    const at = sel.start - 1;
    if (at === 0 || /\s/.test(text[at - 1])) openSlash(b, el, at);
  } else if (slash) updateSlash();
}

/** Keyboard on a focused divider or page block. */
function onAtomicKeyDown(e) {
  const body = e.target.closest('.block-body[tabindex]');
  if (!body || e.target !== body) return;
  const id = body.closest('.block').dataset.id;
  const b = getBlock(id);
  const i = blockIndex(id);
  const blocks = state.page.blocks;
  switch (e.key) {
    case 'Backspace':
    case 'Delete': {
      e.preventDefault();
      removeBlock(id); // a page block → the page goes to the Trash on save
      const target = blocks[Math.max(0, i - 1)];
      if (target) focusBlock(target.id, 'end');
      return;
    }
    case 'Enter': {
      e.preventDefault();
      if (b.type === 'page') return flushSave().then(() => go(b.pageId));
      const nb = { id: newId(), type: 'paragraph', text: '' };
      insertAfter(id, nb);
      return focusBlock(nb.id, 0);
    }
    case 'ArrowUp':
    case 'ArrowLeft':
      if (blocks[i - 1]) {
        e.preventDefault();
        focusBlock(blocks[i - 1].id, 'end');
      }
      return;
    case 'ArrowDown':
    case 'ArrowRight':
      if (blocks[i + 1]) {
        e.preventDefault();
        focusBlock(blocks[i + 1].id, 0);
      }
      return;
  }
}

function onKeyDown(e) {
  const el = e.target.closest('.text');
  if (!el) return onAtomicKeyDown(e);
  if (slash && handleSlashKey(e)) return;
  if (e.isComposing || e.keyCode === 229) return;
  const b = getBlock(el.closest('.block').dataset.id);
  const text = getText(el);
  const sel = getSel(el) || { start: 0, end: 0 };
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();

  if (mod && !e.altKey && ['b', 'i', 'e'].includes(key) && !e.shiftKey) {
    e.preventDefault();
    return wrapSelection(b, el, text, sel, { b: '**', i: '*', e: '`' }[key]);
  }
  if (mod && e.shiftKey && key === 's') {
    e.preventDefault();
    return wrapSelection(b, el, text, sel, '~~');
  }
  if (mod && key === 'k' && sel.start !== sel.end) {
    e.preventDefault();
    e.stopPropagation();
    const selected = text.slice(sel.start, sel.end);
    const next = text.slice(0, sel.start) + `[${selected}](https://)` + text.slice(sel.end);
    setBlockText(b, next);
    const urlStart = sel.start + selected.length + 3;
    return setCaret(el, urlStart, urlStart + 8);
  }
  if (mod && key === 'd') {
    e.preventDefault();
    return duplicateBlock(b);
  }

  switch (e.key) {
    case 'Enter': {
      if (b.type === 'code' && !mod && !e.shiftKey) {
        e.preventDefault();
        return insertTextAt(b, el, text, sel, '\n');
      }
      if (e.shiftKey) {
        e.preventDefault();
        return insertTextAt(b, el, text, sel, '\n');
      }
      e.preventDefault();
      return splitBlock(b, text, sel);
    }
    case 'Backspace':
      if (sel.start === 0 && sel.end === 0) {
        e.preventDefault();
        return backspaceAtStart(b, text);
      }
      return;
    case 'Delete':
      if (sel.start === text.length && sel.end === text.length) {
        e.preventDefault();
        return mergeNext(b, text);
      }
      return;
    case 'Tab': {
      e.preventDefault();
      if (b.type === 'code') return insertTextAt(b, el, text, sel, '  ');
      const i = blockIndex(b.id);
      const prev = state.page.blocks[i - 1];
      if (!LIST_TYPES.includes(b.type) && b.type !== 'paragraph') return;
      if (b.type === 'paragraph') return;
      const cur = b.indent || 0;
      const max = prev && LIST_TYPES.includes(prev.type) ? Math.min(4, (prev.indent || 0) + 1) : 0;
      const next = e.shiftKey ? Math.max(0, cur - 1) : Math.min(max, cur + 1);
      if (next === cur) return;
      b.indent = next;
      replaceBlockEl(b);
      markDirty(b.id);
      return focusBlock(b.id, sel.start, sel.end);
    }
    case 'ArrowUp':
    case 'ArrowDown': {
      if (e.shiftKey || mod) return;
      const up = e.key === 'ArrowUp';
      if (!caretOnEdgeLine(el, up)) return;
      const i = blockIndex(b.id);
      const target = state.page.blocks[up ? i - 1 : i + 1];
      if (!target) {
        if (up) {
          e.preventDefault();
          const t = $('.page-title');
          t.focus();
          setCaret(t, getText(t).length);
        }
        return;
      }
      e.preventDefault();
      const x = caretRect()?.left ?? el.getBoundingClientRect().left;
      if (ATOMIC_TYPES.includes(target.type)) return focusBlock(target.id);
      return focusAtX(textElById(target.id), x, up);
    }
    case 'ArrowLeft':
      if (sel.start === 0 && sel.end === 0 && !e.shiftKey) {
        const prev = state.page.blocks[blockIndex(b.id) - 1];
        if (prev && hasText(prev)) {
          e.preventDefault();
          focusBlock(prev.id, 'end');
        }
      }
      return;
    case 'ArrowRight':
      if (sel.start === text.length && sel.end === text.length && !e.shiftKey) {
        const next = state.page.blocks[blockIndex(b.id) + 1];
        if (next && hasText(next)) {
          e.preventDefault();
          focusBlock(next.id, 0);
        }
      }
      return;
    case 'Escape':
      el.blur();
      return;
  }
}

function insertTextAt(b, el, text, sel, s) {
  const next = text.slice(0, sel.start) + s + text.slice(sel.end);
  setBlockText(b, next);
  setCaret(el, sel.start + s.length);
}

function wrapSelection(b, el, text, sel, marker) {
  const { start, end } = sel;
  const inner = text.slice(start, end);
  // unwrap if already wrapped
  if (text.slice(start - marker.length, start) === marker && text.slice(end, end + marker.length) === marker) {
    setBlockText(b, text.slice(0, start - marker.length) + inner + text.slice(end + marker.length));
    return setCaret(el, start - marker.length, end - marker.length);
  }
  setBlockText(b, text.slice(0, start) + marker + inner + marker + text.slice(end));
  setCaret(el, start + marker.length, end + marker.length);
}

const CONTINUES = new Set(['bulleted_list', 'numbered_list', 'to_do']);
function splitBlock(b, text, sel) {
  if (!text && (LIST_TYPES.includes(b.type) || b.type === 'quote' || b.type === 'callout')) {
    if ((b.indent || 0) > 0) {
      b.indent--;
      replaceBlockEl(b);
      markDirty(b.id);
    } else convertBlock(b, 'paragraph');
    return focusBlock(b.id, 0);
  }
  const type = CONTINUES.has(b.type) ? b.type : 'paragraph';
  const extra = LIST_TYPES.includes(type) ? { indent: b.indent || 0 } : {};
  if (type === 'to_do') extra.checked = false;
  if (sel.start === 0 && sel.end === 0 && text) {
    // caret at start: push an empty block above
    const nb = { id: newId(), type: b.type.startsWith('heading') ? 'paragraph' : type, text: '', ...extra };
    insertBlock(nb, blockIndex(b.id));
    return focusBlock(b.id, 0);
  }
  const before = text.slice(0, sel.start);
  const after = text.slice(sel.end);
  setBlockText(b, before);
  const nb = { id: newId(), type, text: after, ...extra };
  insertAfter(b.id, nb);
  focusBlock(nb.id, 0);
}

function backspaceAtStart(b, text) {
  if ((b.indent || 0) > 0) {
    b.indent--;
    replaceBlockEl(b);
    markDirty(b.id);
    return focusBlock(b.id, 0);
  }
  if (b.type !== 'paragraph') {
    if (b.type === 'code' && text) return;
    if (b.type === 'image' && b.url) return;
    convertBlock(b, 'paragraph');
    return focusBlock(b.id, 0);
  }
  const i = blockIndex(b.id);
  const prev = state.page.blocks[i - 1];
  if (!prev) {
    if (!text && state.page.blocks.length > 1) {
      removeBlock(b.id);
      const t = $('.page-title');
      t.focus();
      setCaret(t, getText(t).length);
    }
    return;
  }
  if (prev.type === 'page') {
    // never delete a page by accident: select it first (Backspace again trashes it)
    if (!text) removeBlock(b.id);
    return focusBlock(prev.id);
  }
  if (prev.type === 'divider' || (prev.type === 'image' && prev.url)) {
    removeBlock(prev.id);
    return focusBlock(b.id, 0);
  }
  const at = (prev.text || '').length;
  setBlockText(prev, (prev.text || '') + text);
  removeBlock(b.id);
  focusBlock(prev.id, at);
}

function mergeNext(b, text) {
  const next = state.page.blocks[blockIndex(b.id) + 1];
  if (!next) return;
  if (next.type === 'page') return focusBlock(next.id);
  if (next.type === 'divider' || next.type === 'image') {
    removeBlock(next.id);
    return focusBlock(b.id, 'end');
  }
  setBlockText(b, text + (next.text || ''));
  removeBlock(next.id);
  focusBlock(b.id, text.length);
}

function duplicateBlock(b) {
  const copy = { ...structuredClone(b), id: newId() };
  insertAfter(b.id, copy);
  focusBlock(copy.id, 'end');
}

function onPaste(e) {
  const el = e.target.closest('.text');
  if (!el) return;
  e.preventDefault();
  const b = getBlock(el.closest('.block').dataset.id);
  const pasted = e.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n');
  if (!pasted) return;
  const text = getText(el);
  const sel = getSel(el) || { start: text.length, end: text.length };
  // Paste a URL over a selection → link
  if (sel.start !== sel.end && /^https?:\/\/\S+$/.test(pasted.trim()) && b.type !== 'code') {
    const selected = text.slice(sel.start, sel.end);
    const md = `[${selected}](${pasted.trim()})`;
    setBlockText(b, text.slice(0, sel.start) + md + text.slice(sel.end));
    return setCaret(el, sel.start + md.length);
  }
  if (b.type === 'code' || !pasted.includes('\n')) return insertTextAt(b, el, text, sel, pasted);
  const parsed = markdownToBlocks(pasted).filter((x) => x.type !== 'page');
  if (!parsed.length) return;
  const before = text.slice(0, sel.start);
  const after = text.slice(sel.end);
  let lastId = b.id;
  let rest = parsed;
  if (parsed[0].type === 'paragraph' || !before) {
    // first pasted block merges into the current one
    const first = parsed[0];
    if (!before && b.type === 'paragraph') {
      b.type = first.type;
      Object.assign(b, { ...first, id: b.id, text: first.text });
      replaceBlockEl(b);
    } else {
      b.text = before + first.text;
    }
    rest = parsed.slice(1);
  } else {
    b.text = before;
  }
  replaceBlockEl(b);
  markDirty(b.id);
  for (const nb of rest) {
    insertAfter(lastId, nb);
    lastId = nb.id;
  }
  const last = getBlock(lastId);
  const caret = (last.text || '').length;
  if (after) setBlockText(last, (last.text || '') + after);
  focusBlock(lastId, caret);
}

function onBlockClick(e) {
  const blockNode = e.target.closest('.block');
  if (!blockNode) return;
  const b = getBlock(blockNode.dataset.id);
  if (!b) return;
  if (e.target.closest('.checkbox')) {
    b.checked = !b.checked;
    replaceBlockEl(b);
    markDirty(b.id);
    return;
  }
  if (e.target.closest('.gutter .add')) {
    if (b.type === 'paragraph' && !b.text) {
      setBlockText(b, '/');
      focusBlock(b.id, 'end');
      return openSlash(b, textElById(b.id), 0);
    }
    const nb = { id: newId(), type: 'paragraph', text: '/' };
    insertAfter(b.id, nb);
    focusBlock(nb.id, 'end');
    return openSlash(nb, textElById(nb.id), 0);
  }
  if (e.target.closest('.gutter .handle')) return blockMenu(e.target.closest('.handle'), b);
  if (b.type === 'page' && e.target.closest('.block-body')) return flushSave().then(() => go(b.pageId));
  if (e.target.closest('.callout-icon')) {
    return iconPicker(e.target.closest('.callout-icon'), (icon) => {
      b.icon = icon || '💡';
      replaceBlockEl(b);
      markDirty(b.id);
    });
  }
  if (e.target.closest('.copy-code')) return copyText(b.text || '', 'Code copied');
  if (e.target.closest('.img-empty') || (e.target.closest('img') && e.detail === 2)) {
    return askInput(e.target, 'Paste an image URL…', b.url || '', (url) => {
      b.url = url.trim();
      replaceBlockEl(b);
      markDirty(b.id);
    });
  }
}

// ---------- drag & drop blocks ----------
function wireBlockDnD(wrap) {
  let dragId = null;
  const clear = () => wrap.querySelectorAll('.drop-before,.drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
  wrap.addEventListener('dragstart', (e) => {
    const handle = e.target.closest?.('.handle');
    if (!handle) return;
    const blk = handle.closest('.block');
    dragId = blk.dataset.id;
    const b = getBlock(dragId);
    // a page block can also be dropped onto a page in the sidebar to move it there
    blockPageDrag = b?.type === 'page' ? b.pageId : null;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', b?.text || '');
    e.dataTransfer.setDragImage(blk, 20, 12);
    blk.style.opacity = '0.4';
  });
  wrap.addEventListener('dragover', (e) => {
    if (!dragId) return;
    e.preventDefault();
    const blk = e.target.closest('.block');
    clear();
    if (!blk || blk.dataset.id === dragId) return;
    const r = blk.getBoundingClientRect();
    blk.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
  });
  wrap.addEventListener('drop', (e) => {
    if (!dragId) return;
    e.preventDefault();
    const target = wrap.querySelector('.drop-before,.drop-after');
    if (target) {
      const after = target.classList.contains('drop-after');
      const blocks = state.page.blocks;
      const [moved] = blocks.splice(blockIndex(dragId), 1);
      let at = blocks.findIndex((x) => x.id === target.dataset.id);
      if (after) at++;
      blocks.splice(at, 0, moved);
      markDirty(moved.id);
      renderBlocks();
    }
    clear();
  });
  wrap.addEventListener('dragend', () => {
    if (dragId) {
      const el = blockElById(dragId);
      if (el) el.style.opacity = '';
    }
    dragId = null;
    blockPageDrag = null;
    clearTreeDrop();
    clear();
  });
}

// =====================================================================
// Slash menu
// =====================================================================
const SLASH_ITEMS = [
  { type: 'paragraph', name: 'Text', icon: 'Aa', desc: 'Just start writing with plain text.', keys: 'text paragraph plain' },
  { type: 'page', name: 'Page', icon: '📄', desc: 'Embed a sub-page inside this page.', keys: 'page subpage new' },
  { type: 'database', name: 'Database', icon: '🗃️', desc: 'Tasks, contacts… with table and board views.', keys: 'database table board kanban tasks' },
  { type: 'linked_view', name: 'Linked view of database', icon: '⧉', desc: 'Show an existing database here, filtered.', keys: 'linked view database embed table board' },
  { type: 'to_do', name: 'To-do list', icon: '☑', desc: 'Track tasks with a to-do list.', keys: 'todo task checkbox check' },
  { type: 'heading_1', name: 'Heading 1', icon: 'H1', desc: 'Big section heading.', keys: 'h1 heading title' },
  { type: 'heading_2', name: 'Heading 2', icon: 'H2', desc: 'Medium section heading.', keys: 'h2 heading subtitle' },
  { type: 'heading_3', name: 'Heading 3', icon: 'H3', desc: 'Small section heading.', keys: 'h3 heading' },
  { type: 'bulleted_list', name: 'Bulleted list', icon: '•', desc: 'Create a simple bulleted list.', keys: 'bullet list ul unordered' },
  { type: 'numbered_list', name: 'Numbered list', icon: '1.', desc: 'Create a list with numbering.', keys: 'number list ol ordered' },
  { type: 'quote', name: 'Quote', icon: '❝', desc: 'Capture a quote.', keys: 'quote blockquote citation' },
  { type: 'callout', name: 'Callout', icon: '💡', desc: 'Make writing stand out.', keys: 'callout note info warning tip' },
  { type: 'code', name: 'Code', icon: '</>', desc: 'Capture a code snippet.', keys: 'code snippet pre' },
  { type: 'divider', name: 'Divider', icon: '—', desc: 'Visually divide blocks.', keys: 'divider hr line separator' },
  { type: 'image', name: 'Image', icon: '🖼', desc: 'Embed an image from a URL.', keys: 'image picture img photo' },
];
let slash = null;

function openSlash(b, el, at) {
  closePop();
  slash = { blockId: b.id, el, at, index: 0, items: SLASH_ITEMS, pop: null };
  renderSlash();
}
function closeSlash() {
  if (!slash) return;
  slash.pop?.remove();
  slash = null;
}
function slashQuery() {
  const text = getText(slash.el);
  const sel = getSel(slash.el);
  if (!sel || sel.start <= slash.at || text[slash.at] !== '/') return null;
  return text.slice(slash.at + 1, sel.start);
}
function updateSlash() {
  const q = slashQuery();
  if (q == null || q.length > 24 || /\s\s/.test(q)) return closeSlash();
  const ql = q.toLowerCase().trim();
  slash.items = SLASH_ITEMS.filter((it) => !ql || it.name.toLowerCase().includes(ql) || it.keys.includes(ql));
  if (!slash.items.length && q.length > 3) return closeSlash();
  slash.index = Math.min(slash.index, Math.max(0, slash.items.length - 1));
  renderSlash();
}
function renderSlash() {
  slash.pop?.remove();
  const pop = h('div', { class: 'pop slash-pop', style: 'width:300px' });
  pop.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the editor
  if (!slash.items.length) pop.append(h('div', { class: 'empty-note' }, 'No results'));
  else pop.append(h('div', { class: 'pop-label' }, 'Basic blocks'));
  slash.items.forEach((it, i) => {
    const row = h(
      'button',
      { class: `menu-item${i === slash.index ? ' active' : ''}`, onclick: () => chooseSlash(it), onmousemove: () => i !== slash.index && ((slash.index = i), renderSlash()) },
      h('span', { class: 'mi-icon' }, it.icon),
      h('span', { class: 'mi-text' }, h('span', {}, it.name), h('span', { class: 'mi-desc' }, it.desc)),
    );
    pop.append(row);
  });
  $('#layer').append(pop);
  slash.pop = pop;
  const r = caretRect() || slash.el.getBoundingClientRect();
  placePop(pop, { left: r.left, top: r.top, bottom: r.bottom, width: 0, height: r.height });
  pop.querySelector('.menu-item.active')?.scrollIntoView({ block: 'nearest' });
}
function handleSlashKey(e) {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const n = slash.items.length;
    if (!n) return true;
    slash.index = (slash.index + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
    renderSlash();
    return true;
  }
  if (e.key === 'Enter' || e.key === 'Tab') {
    if (!slash.items.length) return closeSlash(), false;
    e.preventDefault();
    chooseSlash(slash.items[slash.index]);
    return true;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    closeSlash();
    return true;
  }
  return false;
}
async function chooseSlash(item) {
  const { blockId, el, at } = slash;
  const b = getBlock(blockId);
  const text = getText(el);
  const sel = getSel(el);
  const end = sel ? sel.start : text.length;
  const rest = text.slice(0, at) + text.slice(end);
  closeSlash();
  if (!b) return;
  if (item.type === 'linked_view') {
    setBlockText(b, rest.trim() ? rest : '');
    let target = b;
    if (rest.trim()) {
      target = { id: newId(), type: 'paragraph', text: '' };
      insertAfter(b.id, target);
    }
    return addLinkedView(target);
  }
  if (item.type === 'database') {
    setBlockText(b, rest);
    await flushSave();
    try {
      const db = await rpc('createDatabase', {
        title: '',
        parentId: state.page.id,
        afterBlockId: b.id,
        properties: [
          { name: 'Status', type: 'select', options: ['Not started', 'In progress', 'Done'] },
          { name: 'Assignee', type: 'person' },
          { name: 'Due', type: 'date' },
        ],
        views: [{ name: 'Board', type: 'board', groupBy: 'Status' }],
      });
      await loadTree();
      go(db.id);
    } catch (err) {
      toast(err.message);
    }
    return;
  }
  if (item.type === 'page') {
    // The sub-page appears as a page block right here (replacing an empty line).
    setBlockText(b, rest.trim() ? rest : '');
    await flushSave();
    const parentId = state.page.id;
    try {
      const child = rest.trim()
        ? await rpc('createPage', { title: '', parentId, afterBlockId: b.id })
        : await rpc('blockToPage', { pageId: parentId, blockId: b.id });
      state.expanded.add(parentId);
      saveExpanded();
      await loadTree();
      go(child.id);
    } catch (err) {
      toast(err.message);
    }
    return;
  }
  if (!rest.trim()) {
    convertBlock(b, item.type, { text: '' });
    if (item.type === 'divider') {
      const nb = { id: newId(), type: 'paragraph', text: '' };
      insertAfter(b.id, nb);
      return focusBlock(nb.id, 0);
    }
    if (item.type === 'image') {
      const anchor = blockElById(b.id).querySelector('.img-empty');
      return askInput(anchor, 'Paste an image URL…', '', (url) => {
        b.url = url.trim();
        replaceBlockEl(b);
        markDirty(b.id);
      });
    }
    return focusBlock(b.id, 0);
  }
  setBlockText(b, rest);
  const nb = { id: newId(), type: item.type, text: '' };
  if (LIST_TYPES.includes(item.type)) nb.indent = 0;
  if (item.type === 'to_do') nb.checked = false;
  if (item.type === 'callout') nb.icon = '💡';
  if (item.type === 'code') nb.language = '';
  insertAfter(b.id, nb);
  focusBlock(nb.id, 0);
}

// =====================================================================
// Popovers, menus, modals
// =====================================================================
let pop = null;
function placePop(el, r) {
  const pw = el.offsetWidth;
  const ph = el.offsetHeight;
  let left = Math.min(r.left, innerWidth - pw - 8);
  let top = r.bottom + 6;
  if (top + ph > innerHeight - 8) top = Math.max(8, r.top - ph - 6);
  el.style.left = Math.max(8, left) + 'px';
  el.style.top = top + 'px';
}
function openPop(anchor, content, opts = {}) {
  closePop();
  closeSlash();
  const el = h('div', { class: 'pop', style: opts.width ? `width:${opts.width}px` : null }, content);
  $('#layer').append(el);
  placePop(el, anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : anchor);
  pop = { el, onClose: opts.onClose };
  setTimeout(() => el.querySelector('input')?.focus(), 0);
  return el;
}
function closePop() {
  if (!pop) return;
  const p = pop;
  pop = null;
  p.el.remove();
  p.onClose?.();
}
document.addEventListener('mousedown', (e) => {
  if (pop && !pop.el.contains(e.target)) closePop();
  if (slash && !slash.pop?.contains(e.target) && !slash.el.contains(e.target)) closeSlash();
});

function menu(anchor, items, opts) {
  const content = items.filter(Boolean).map((it) => {
    if (it === '-') return h('div', { class: 'menu-sep' });
    if (it.label) return h('div', { class: 'pop-label' }, it.label);
    return h(
      'button',
      {
        class: `menu-item compact${it.danger ? ' danger' : ''}`,
        onclick: () => {
          closePop();
          it.run();
        },
      },
      h('span', { class: 'mi-icon' }, it.icon || ''),
      h('span', { class: 'mi-text' }, it.name),
    );
  });
  return openPop(anchor, content, opts);
}

function askInput(anchor, placeholder, value, onSubmit) {
  const input = h('input', { class: 'pop-input', placeholder, value });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = input.value;
      closePop();
      if (v.trim()) onSubmit(v);
    }
    if (e.key === 'Escape') closePop();
  });
  openPop(anchor, [input, h('div', { class: 'mi-desc', style: 'padding:2px 4px;color:var(--text-3);font-size:12px' }, 'Press Enter to confirm')], { width: 340 });
}

function iconPicker(anchor, onPick, allowRemove = false) {
  const grid = h(
    'div',
    { class: 'emoji-grid' },
    EMOJIS.map((e) =>
      h(
        'button',
        {
          onclick: () => {
            closePop();
            onPick(e);
          },
        },
        e,
      ),
    ),
  );
  const custom = h('input', { class: 'pop-input', placeholder: 'Or type / paste any emoji and press Enter' });
  custom.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && custom.value.trim()) {
      const v = [...custom.value.trim()].slice(0, 4).join('');
      closePop();
      onPick(v);
    }
  });
  const parts = [custom, grid];
  if (allowRemove) parts.push(h('div', { class: 'menu-sep' }), h('button', { class: 'menu-item compact', onclick: () => (closePop(), onPick('')) }, h('span', { class: 'mi-icon' }, '✕'), 'Remove icon'));
  openPop(anchor, parts, { width: 336 });
}

const TURN_INTO = SLASH_ITEMS.filter((i) => !['page', 'database', 'linked_view', 'image', 'divider'].includes(i.type));
function blockMenu(anchor, b) {
  if (b.type === 'database_view') {
    return menu(anchor, [
      { name: 'Open source database', icon: '↗', run: () => flushSave().then(() => go(b.databaseId)) },
      {
        name: 'Duplicate view',
        icon: '⧉',
        run: () => insertAfter(b.id, { ...structuredClone(b), id: newId(), view: { ...structuredClone(b.view || {}), id: undefined, name: `${b.view?.name || 'View'} (copy)` } }),
      },
      '-',
      { name: 'Remove from page', icon: '🗑', danger: true, run: () => removeBlock(b.id) },
    ]);
  }
  if (b.type === 'page') {
    return menu(anchor, [
      { name: 'Open', icon: '↗', run: () => flushSave().then(() => go(b.pageId)) },
      { name: 'Move to…', icon: '↪', run: () => movePicker(anchor, b.pageId) },
      {
        name: 'Duplicate',
        icon: '⧉',
        run: async () => {
          await flushSave();
          await rpc('duplicatePage', { pageId: b.pageId });
          await loadTree();
          await reloadPage();
        },
      },
      { name: 'Copy page ID', icon: '#', run: () => copyText(b.pageId, 'Page ID copied') },
      '-',
      { name: 'Move to Trash', icon: '🗑', danger: true, run: () => removeBlock(b.id) },
    ]);
  }
  const canBePage = b.type !== 'divider';
  menu(anchor, [
    { name: 'Delete', icon: '🗑', danger: true, run: () => removeBlock(b.id) },
    { name: 'Duplicate', icon: '⧉', run: () => duplicateBlock(b) },
    { name: 'Move to…', icon: '↪', run: () => moveBlockPicker(anchor, b) },
    { name: 'Copy as Markdown', icon: '⎘', run: () => copyText(blocksToMarkdown([b]), 'Copied as Markdown') },
    '-',
    { label: 'Turn into' },
    canBePage && { name: 'Page', icon: '📄', run: () => turnIntoPage(b) },
    ...TURN_INTO.map((it) => ({
      name: it.name + (b.type === it.type ? '  ✓' : ''),
      icon: it.icon,
      run: () => {
        convertBlock(b, it.type);
        focusBlock(b.id, 'end');
      },
    })),
  ]);
}

function pageMenu(anchor, id) {
  const node = state.flat.get(id) || state.page;
  menu(anchor, [
    {
      name: node?.favorite ? 'Remove from Favorites' : 'Add to Favorites',
      icon: node?.favorite ? '★' : '☆',
      run: () => toggleFavorite(id),
    },
    { name: 'Add sub-page', icon: '＋', run: () => newPage(id) },
    {
      name: 'Duplicate',
      icon: '⧉',
      run: async () => {
        await flushSave();
        const copy = await rpc('duplicatePage', { pageId: id });
        await loadTree();
        go(copy.id);
      },
    },
    { name: 'Move to…', icon: '↪', run: () => movePicker(anchor, id) },
    { name: 'Copy page ID', icon: '#', run: () => copyText(id, 'Page ID copied — paste it to your agent') },
    {
      name: 'Copy as Markdown',
      icon: '⎘',
      run: async () => {
        await flushSave();
        const md = await rpc('getPageMarkdown', { pageId: id });
        const p = state.flat.get(id);
        copyText(`# ${label(p)}\n\n${md}`, 'Copied as Markdown');
      },
    },
    {
      name: 'Export Markdown file',
      icon: '⤓',
      run: async () => {
        await flushSave();
        const md = await rpc('getPageMarkdown', { pageId: id });
        const p = state.flat.get(id);
        const a = h('a', { href: URL.createObjectURL(new Blob([`# ${label(p)}\n\n${md}`], { type: 'text/markdown' })), download: `${(label(p) || 'page').replace(/[\\/:*?"<>|]+/g, '_')}.md` });
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      },
    },
    '-',
    {
      name: 'Move to Trash',
      icon: '🗑',
      danger: true,
      run: async () => {
        if (state.page?.id === id) await flushSave();
        await rpc('archivePage', { pageId: id });
        toast('Moved to Trash');
        await loadTree();
        await reloadPage();
      },
    },
  ]);
}

async function toggleFavorite(id) {
  const node = state.flat.get(id);
  await rpc('updatePage', { pageId: id, favorite: !node?.favorite });
  await loadTree();
  if (state.page) renderTop();
}

/** Searchable list of pages to pick a destination from. */
function pagePicker(anchor, { placeholder, exclude = new Set(), allowRoot = false, onPick }) {
  const input = h('input', { class: 'pop-input', placeholder });
  const list = h('div');
  const pathOf = (n) => {
    const parts = [];
    for (let cur = n.parentId && state.flat.get(n.parentId); cur; cur = cur.parentId && state.flat.get(cur.parentId)) parts.unshift(label(cur));
    return parts.join(' / ');
  };
  const pick = (id) => {
    closePop();
    onPick(id);
  };
  const render = () => {
    const q = input.value.trim().toLowerCase();
    const items = [...state.flat.values()].filter((n) => !exclude.has(n.id) && (!q || label(n).toLowerCase().includes(q))).slice(0, 60);
    list.replaceChildren(
      allowRoot ? h('button', { class: 'menu-item compact', onclick: () => pick(null) }, h('span', { class: 'mi-icon' }, '⌂'), 'Top level (no parent)') : null,
      ...items.map((n) =>
        h(
          'button',
          { class: 'menu-item compact', onclick: () => pick(n.id) },
          h('span', { class: 'mi-icon' }, iconOf(n)),
          h('span', { class: 'mi-text' }, h('span', {}, label(n)), pathOf(n) ? h('span', { class: 'mi-desc' }, pathOf(n)) : null),
        ),
      ),
    );
  };
  input.addEventListener('input', render);
  render();
  openPop(anchor, [input, list], { width: 320 });
}

function movePicker(anchor, id) {
  const exclude = new Set([id]);
  const collect = (n) => n.children.forEach((c) => (exclude.add(c.id), collect(c)));
  const self = state.flat.get(id);
  if (self) collect(self);
  pagePicker(anchor, {
    placeholder: 'Move page to…',
    exclude,
    allowRoot: true,
    onPick: async (parentId) => {
      await movePage(id, parentId);
      toast('Page moved');
    },
  });
}

/** Move a regular block to the end of another page. */
function moveBlockPicker(anchor, b) {
  pagePicker(anchor, {
    placeholder: 'Move block to page…',
    exclude: new Set([state.page.id]),
    onPick: async (targetId) => {
      try {
        await rpc('appendContent', { pageId: targetId, markdown: blocksToMarkdown([b]) });
        removeBlock(b.id);
        await flushSave();
        toast(`Moved to ${label(state.flat.get(targetId))}`);
      } catch (err) {
        toast(err.message);
      }
    },
  });
}

/** Turn a text block (e.g. a list item) into a sub-page in place. */
async function turnIntoPage(b) {
  await flushSave();
  try {
    await rpc('blockToPage', { pageId: state.page.id, blockId: b.id });
    state.expanded.add(state.page.id);
    saveExpanded();
    await loadTree();
    await reloadPage();
    focusBlock(b.id);
  } catch (err) {
    toast(err.message);
  }
}

function openModal(content, { onClose } = {}) {
  closePop();
  closeSlash();
  const overlay = h('div', { class: 'overlay' }, h('div', { class: 'modal' }, content));
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    onClose?.();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  overlay.addEventListener('mousedown', (e) => e.target === overlay && close());
  document.addEventListener('keydown', onKey, true);
  $('#layer').append(overlay);
  return close;
}

// ---------- search ----------
function openSearch() {
  const input = h('input', { class: 'modal-input', placeholder: 'Search pages…' });
  const body = h('div', { class: 'modal-body' });
  let results = [];
  let index = 0;
  const hl = (s, q) => {
    if (!q) return esc(s);
    const i = s.toLowerCase().indexOf(q.toLowerCase());
    return i < 0 ? esc(s) : esc(s.slice(0, i)) + '<mark>' + esc(s.slice(i, i + q.length)) + '</mark>' + esc(s.slice(i + q.length));
  };
  const render = () => {
    const q = input.value.trim();
    body.replaceChildren(
      q ? h('div', { class: 'pop-label' }, results.length ? 'Results' : '') : h('div', { class: 'pop-label' }, 'Recently edited'),
      ...results.map((r, i) =>
        h(
          'div',
          { class: `result${i === index ? ' active' : ''}`, onclick: () => pick(r), onmousemove: () => i !== index && ((index = i), render()) },
          h('div', { class: 'r-title', html: `${esc(iconOf(r))} ${hl(label(r), q)}` }),
          r.snippet ? h('div', { class: 'r-snip', html: hl(r.snippet, q) }) : null,
          r.path.length ? h('div', { class: 'r-sub' }, r.path.join(' / ')) : null,
        ),
      ),
    );
    if (!results.length && q) body.append(h('div', { class: 'empty-note' }, 'No results'));
  };
  const run = debounce(async () => {
    results = await rpc('search', { query: input.value, limit: 30 });
    index = 0;
    render();
  }, 120);
  const pick = (r) => {
    close();
    if (state.page?.id === r.id) {
      const el = r.blockId && blockElById(r.blockId);
      if (el) el.scrollIntoView({ block: 'center' }), el.classList.add('flash');
    } else {
      location.hash = '/' + r.id;
      if (r.blockId) setTimeout(() => {
        const el = blockElById(r.blockId);
        if (el) el.scrollIntoView({ block: 'center' }), el.classList.add('flash');
      }, 250);
    }
  };
  input.addEventListener('input', run);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!results.length) return;
      index = (index + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      render();
      body.querySelector('.result.active')?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && results[index]) pick(results[index]);
  });
  const close = openModal([input, body]);
  input.focus();
  run();
}

// ---------- trash ----------
async function openTrash() {
  const body = h('div', { class: 'modal-body' });
  const render = async () => {
    const items = await rpc('listTrash');
    body.replaceChildren(
      ...(items.length
        ? items.map((t) =>
            h(
              'div',
              { class: 'trash-row' },
              h('span', {}, iconOf(t)),
              h(
                'div',
                { class: 'grow', onclick: () => (close(), (location.hash = '/' + t.id)) },
                h('div', {}, label(t)),
                h('div', { class: 'r-sub', style: 'font-size:12px;color:var(--text-3)' }, [t.path.join(' / '), timeAgo(t.archivedAt)].filter(Boolean).join(' · ')),
              ),
              h('button', { class: 'btn', title: 'Restore', onclick: async () => (await rpc('restorePage', { pageId: t.id }), await loadTree(), render(), state.page?.id === t.id && reloadPage()) }, 'Restore'),
              h(
                'button',
                {
                  class: 'btn danger',
                  title: 'Delete forever',
                  onclick: async () => {
                    if (!confirm(`Delete “${label(t)}” forever?`)) return;
                    await rpc('deletePage', { pageId: t.id });
                    render();
                    if (state.page?.id === t.id) (location.hash = ''), openPage(null);
                  },
                },
                'Delete',
              ),
            ),
          )
        : [h('div', { class: 'empty-note' }, 'Trash is empty')]),
    );
    if (items.length) {
      body.append(
        h(
          'div',
          { style: 'padding:8px 12px;text-align:right' },
          h(
            'button',
            {
              class: 'btn danger',
              onclick: async () => {
                if (!confirm('Permanently delete everything in the Trash?')) return;
                await rpc('emptyTrash');
                render();
              },
            },
            'Empty trash',
          ),
        ),
      );
    }
  };
  const close = openModal([h('div', { class: 'modal-head' }, '🗑 Trash'), body]);
  render();
}

// =====================================================================
// Workspaces, members, invites, agent
// =====================================================================
const lastPageKey = () => `lastPage:${WS_ID}`;

function renderWorkspaceHeader() {
  const w = currentWs();
  $('#ws-switcher .ws-name').textContent = w?.name || 'Workspace';
  $('#ws-switcher .ws-logo').textContent = (w?.name || 'W').trim()[0].toUpperCase();
}

function workspaceMenu(anchor) {
  menu(anchor, [
    { label: state.me.email },
    ...state.workspaces.map((w) => ({
      name: `${w.name}${w.id === WS_ID ? '  ✓' : ''}`,
      icon: w.name.trim()[0].toUpperCase(),
      run: () => w.id !== WS_ID && switchWorkspace(w.id),
    })),
    '-',
    { name: 'Settings & members', icon: '⚙', run: () => openSettings('members') },
    { name: 'Invite people', icon: '✉', run: () => openSettings('members') },
    { name: 'Create workspace', icon: '＋', run: () => createWorkspace(anchor) },
    '-',
    {
      name: 'Log out',
      icon: '⎋',
      run: async () => {
        await flushSave();
        await mutation(cx.auth.logOut, { session: session.get() }).catch(() => {});
        session.clear();
        location.hash = '';
        location.reload();
      },
    },
  ]);
}

function createWorkspace(anchor) {
  askInput(anchor, 'Workspace name', `${state.me.name}'s Workspace`, async (name) => {
    try {
      const w = await mutation(cx.workspaces.create, { session: session.get(), name });
      state.workspaces.push(w);
      switchWorkspace(w.id);
    } catch (err) {
      toast(err.message);
    }
  });
}

async function switchWorkspace(id, pageId = null) {
  await flushSave();
  WS_ID = id;
  localStorage.setItem('ws', id);
  state.page = null;
  state.presence = [];
  renderWorkspaceHeader();
  watchWorkspace();
  await loadTree();
  const target = pageId || localStorage.getItem(lastPageKey());
  if (target && currentRouteId() !== target) history.replaceState(null, '', '#/' + target);
  await openPage(target && (state.flat.has(target) || pageId) ? target : state.tree[0]?.id || null);
}

const snippet = (s) => {
  const pre = h('pre', {}, s);
  pre.append(h('button', { class: 'copy-btn', onclick: () => copyText(s) }, 'Copy'));
  return pre;
};

async function openSettings(tab = 'members') {
  const w = currentWs();
  const S = { session: session.get(), workspaceId: WS_ID };
  const tabs = [
    ['members', '👥 Members'],
    ['agent', '🤖 AI agent'],
    ['workspace', '⚙ Workspace'],
    ...(state.admin ? [['signups', '✉ Sign-up invites']] : []),
  ];
  const nav = h('div', { class: 'tabs' });
  const body = h('div', { class: 'modal-text settings-body' });
  const show = async (name) => {
    tab = name;
    nav.replaceChildren(...tabs.map(([k, t]) => h('button', { class: `tab${k === tab ? ' on' : ''}`, onclick: () => show(k) }, t)));
    body.replaceChildren(h('div', { class: 'empty-note' }, 'Loading…'));
    try {
      body.replaceChildren(...(await { members: membersTab, agent: agentTab, workspace: workspaceTab, signups: signupsTab }[tab]()));
    } catch (err) {
      body.replaceChildren(h('div', { class: 'empty-note' }, err.message));
    }
  };

  // ---- members & invites ----
  async function membersTab() {
    const { role, members } = await query(cx.workspaces.members, S);
    const owner = role === 'owner';
    const out = [];
    const pending = h('div');
    const refreshInvites = async () => {
      const { invites } = await query(cx.workspaces.members, S);
      pending.replaceChildren(
        ...(invites.length ? [h('h4', {}, 'Pending invites')] : []),
        ...invites.map((inv) =>
          h(
            'div',
            { class: 'member' },
            h('span', { class: 'avatar ghost' }, '✉'),
            h('div', { class: 'grow' }, h('div', {}, inv.email || 'Anyone with the link'), h('div', { class: 'sub' }, `Expires ${new Date(inv.expiresAt).toLocaleDateString()}`)),
            h('button', { class: 'btn', onclick: () => copyText(inviteUrl(inv.token), 'Invite link copied') }, 'Copy link'),
            h(
              'button',
              {
                class: 'btn danger',
                onclick: async () => {
                  await mutation(cx.workspaces.revokeInvite, { session: S.session, inviteId: inv.id });
                  refreshInvites();
                },
              },
              'Revoke',
            ),
          ),
        ),
      );
    };
    const signup = owner ? await query(cx.auth.status, {}).catch(() => ({ inviteSignup: true })) : null;
    if (owner) {
      const email = h('input', { class: 'field', type: 'email', placeholder: 'Email (optional — leave empty for a link anyone can use once)' });
      const result = h('div');
      const create = async () => {
        try {
          const inv = await action(cx.workspaces.createInvite, { ...S, email: email.value.trim() || undefined });
          const url = inviteUrl(inv.token);
          result.replaceChildren(h('div', { class: 'hint' }, `Send this link to ${inv.email || 'the person you want to invite'}. It works once and expires in 7 days.`), snippet(url));
          copyText(url, 'Invite link copied');
          email.value = '';
          refreshInvites();
        } catch (err) {
          toast(err.message);
        }
      };
      email.addEventListener('keydown', (e) => e.key === 'Enter' && create());
      out.push(h('h4', {}, `Invite people to ${w.name}`), h('div', { class: 'row' }, email, h('button', { class: 'btn primary', onclick: create }, 'Create invite link')), result);
      if (!signup.inviteSignup) {
        out.push(
          h(
            'div',
            { class: 'hint' },
            state.admin
              ? 'Sign-up is closed: a new person can only create an account with an invite sent to their email. To let someone sign up without joining this workspace, use the Sign-up invites tab.'
              : 'Sign-up is closed: only people who already have an account can join with an invite.',
          ),
        );
      }
      if (['localhost', '127.0.0.1'].includes(location.hostname)) {
        out.push(h('div', { class: 'warn' }, '⚠ You are on a local copy of the app — invite links point to localhost. Create invites from the deployed site so teammates can open them.'));
      }
    }
    out.push(h('h4', {}, `Members · ${members.length}`));
    for (const m of members) {
      const me = m.id === state.me.id;
      out.push(
        h(
          'div',
          { class: 'member' },
          avatar(m),
          h('div', { class: 'grow' }, h('div', {}, m.name + (me ? ' (you)' : '')), h('div', { class: 'sub' }, m.email)),
          h('span', { class: 'role' }, m.role === 'owner' ? 'Owner' : 'Member'),
          (owner && !me) || (me && m.role !== 'owner')
            ? h(
                'button',
                {
                  class: 'btn danger',
                  onclick: async () => {
                    if (!confirm(me ? `Leave ${w.name}?` : `Remove ${m.name} from ${w.name}?`)) return;
                    await mutation(cx.workspaces.removeMember, { ...S, userId: m.id });
                    if (me) return (localStorage.removeItem('ws'), location.reload());
                    show('members');
                  },
                },
                me ? 'Leave' : 'Remove',
              )
            : null,
        ),
      );
    }
    if (owner) {
      out.push(pending);
      refreshInvites();
    } else {
      out.push(h('div', { class: 'hint' }, 'Only the workspace owner can invite or remove people.'));
    }
    return out;
  }

  // ---- sign-up invites (site admin): an account on this site, without joining a workspace ----
  async function signupsTab() {
    const pending = h('div');
    const refresh = async () => {
      const { invites } = await query(cx.workspaces.platformInvites, { session: S.session });
      pending.replaceChildren(
        ...(invites.length ? [h('h4', {}, 'Pending sign-up invites')] : []),
        ...invites.map((inv) =>
          h(
            'div',
            { class: 'member' },
            h('span', { class: 'avatar ghost' }, '✉'),
            h('div', { class: 'grow' }, h('div', {}, inv.email), h('div', { class: 'sub' }, `Expires ${new Date(inv.expiresAt).toLocaleDateString()}`)),
            h('button', { class: 'btn', onclick: () => copyText(inviteUrl(inv.token), 'Invite link copied') }, 'Copy link'),
            h(
              'button',
              {
                class: 'btn danger',
                onclick: async () => {
                  await mutation(cx.workspaces.revokeInvite, { session: S.session, inviteId: inv.id });
                  refresh();
                },
              },
              'Revoke',
            ),
          ),
        ),
      );
    };
    const email = h('input', { class: 'field', type: 'email', placeholder: 'Their email' });
    const result = h('div');
    const create = async () => {
      try {
        const inv = await action(cx.workspaces.createPlatformInvite, { session: S.session, email: email.value.trim() });
        const url = inviteUrl(inv.token);
        result.replaceChildren(h('div', { class: 'hint' }, `Send this link to ${inv.email}. It works once, only for that email, and expires in 7 days.`), snippet(url));
        copyText(url, 'Invite link copied');
        email.value = '';
        refresh();
      } catch (err) {
        toast(err.message);
      }
    };
    email.addEventListener('keydown', (e) => e.key === 'Enter' && create());
    const out = [
      h('div', {}, 'Let someone create an account on this site. They get their own workspace and don’t see any of yours. You can invite them to a workspace later from the Members tab.'),
      h('div', { class: 'row' }, email, h('button', { class: 'btn primary', onclick: create }, 'Create sign-up link')),
      result,
    ];
    if (['localhost', '127.0.0.1'].includes(location.hostname)) {
      out.push(h('div', { class: 'warn' }, '⚠ You are on a local copy of the app — invite links point to localhost. Create invites from the deployed site.'));
    }
    out.push(pending);
    refresh();
    return out;
  }

  // ---- AI agent ----
  async function agentTab() {
    const tokens = await query(cx.workspaces.agentTokens, S);
    const agent = state.agent || {};
    const fresh = h('div');
    const out = [
      h('div', {}, `Your agent can list, search, read, create, edit, move and trash pages in “${w.name}”. Edits appear live for everyone.`),
      h('div', { class: 'hint' }, agent.lastAt ? `Last agent activity: ${timeAgo(agent.lastAt)}${agent.lastTool ? ` (${agent.lastTool})` : ''}` : 'No agent activity yet.'),
      h('div', { class: 'hint' }, 'MCP endpoint:'),
      snippet(mcpUrl),
      h('h4', {}, 'Personal agent tokens'),
      h('div', { class: 'hint' }, 'A token lets an agent act in this workspace on your behalf. Treat it like a password.'),
    ];
    for (const t of tokens) {
      out.push(
        h(
          'div',
          { class: 'member' },
          h('span', { class: 'avatar ghost' }, '🔑'),
          h('div', { class: 'grow' }, h('div', {}, t.name), h('div', { class: 'sub' }, `Created ${timeAgo(new Date(t.createdAt).toISOString())} · ${t.lastUsedAt ? `last used ${timeAgo(new Date(t.lastUsedAt).toISOString())}` : 'never used'} · can be assigned in person properties`)),
          h(
            'button',
            {
              class: 'btn',
              title: 'The name it has in person properties and comments',
              onclick: (e) =>
                askInput(e.currentTarget, 'Agent name, e.g. Claude', t.name, async (name) => {
                  await mutation(cx.workspaces.renameAgentToken, { session: S.session, tokenId: t.id, name }).catch((err) => toast(err.message));
                  show('agent');
                }),
            },
            'Rename',
          ),
          h(
            'button',
            {
              class: 'btn danger',
              onclick: async () => {
                if (!confirm(`Revoke “${t.name}”? Agents using it will lose access.`)) return;
                await mutation(cx.workspaces.revokeAgentToken, { session: S.session, tokenId: t.id });
                show('agent');
              },
            },
            'Revoke',
          ),
        ),
      );
    }
    const name = h('input', { class: 'field', placeholder: 'Token name, e.g. “Claude Code on laptop”' });
    out.push(
      h(
        'div',
        { class: 'row' },
        name,
        h(
          'button',
          {
            class: 'btn primary',
            onclick: async () => {
              const { token } = await action(cx.workspaces.createAgentToken, { ...S, name: name.value.trim() || 'Agent' });
              fresh.replaceChildren(
                h('div', { class: 'warn' }, '🔑 Copy this token now — it will not be shown again.'),
                snippet(token),
                h('h4', {}, 'Claude Code'),
                snippet(`claude mcp add --scope user --transport http notion-clone ${mcpUrl} --header "Authorization: Bearer ${token}"`),
                h('h4', {}, 'Claude Desktop / stdio-only clients (needs this repo checked out)'),
                snippet(JSON.stringify({ mcpServers: { 'notion-clone': { command: 'node', args: ['<path-to-notion-clone>/src/mcp-stdio.js'], env: { NOTION_URL: siteUrl, NOTION_TOKEN: token } } } }, null, 2)),
                h('h4', {}, 'Cursor, VS Code and other HTTP clients'),
                snippet(JSON.stringify({ mcpServers: { 'notion-clone': { url: mcpUrl, headers: { Authorization: `Bearer ${token}` } } } }, null, 2)),
              );
              show('agent').then(() => body.append(fresh));
            },
          },
          'Create token',
        ),
      ),
      fresh,
    );
    return out;
  }

  // ---- workspace ----
  async function workspaceTab() {
    const owner = w.role === 'owner';
    const name = h('input', { class: 'field', value: w.name, disabled: !owner });
    return [
      h('h4', {}, 'Workspace name'),
      h(
        'div',
        { class: 'row' },
        name,
        owner
          ? h(
              'button',
              {
                class: 'btn primary',
                onclick: async () => {
                  try {
                    const r = await mutation(cx.workspaces.rename, { ...S, name: name.value });
                    w.name = r.name;
                    renderWorkspaceHeader();
                    toast('Saved');
                  } catch (err) {
                    toast(err.message);
                  }
                },
              },
              'Save',
            )
          : null,
      ),
      h('h4', {}, 'Your account'),
      h('div', { class: 'member' }, avatar(state.me), h('div', { class: 'grow' }, h('div', {}, state.me.name), h('div', { class: 'sub' }, state.me.email))),
      ...(owner ? await webhooksSection() : []),
      ...(owner ? deleteSection() : []),
    ];
  }

  async function webhooksSection() {
    const box = h('div');
    const draw = async () => {
      const hooks = await query(cx.webhooks.list, S).catch(() => []);
      const url = h('input', { class: 'field', placeholder: 'https://example.com/hooks/notion' });
      const events = h(
        'select',
        { class: 'field narrow' },
        h('option', { value: '*' }, 'All events'),
        h('option', { value: 'item.*' }, 'Database items'),
        h('option', { value: 'item.updated' }, 'Item changes only'),
        h('option', { value: 'comment.*' }, 'Comments'),
        h('option', { value: 'page.*' }, 'Pages'),
      );
      const result = h('div');
      const add = async () => {
        try {
          const r = await action(cx.webhooks.create, { ...S, url: url.value.trim(), events: [events.value] });
          await draw();
          box.append(h('div', { class: 'hint' }, 'Signing secret (shown once — store it in your receiver): '), snippet(r.secret));
        } catch (err) {
          toast(err.message);
        }
      };
      box.replaceChildren(
        h('h4', {}, 'Webhooks'),
        h('div', { class: 'hint' }, 'POST a signed JSON event to a URL when pages, items or comments change — e.g. to tell an agent that a task was marked Done.'),
        ...hooks.map((wh) =>
          h(
            'div',
            { class: 'member' },
            h('span', { class: 'avatar ghost' }, '⚡'),
            h(
              'div',
              { class: 'grow' },
              h('div', { class: 'ellipsis' }, wh.url),
              h('div', { class: 'sub' }, `${wh.events.join(', ')} · ${wh.lastDelivery ? `last ${timeAgo(wh.lastDelivery.at)}: ${wh.lastDelivery.error || `HTTP ${wh.lastDelivery.status}`}` : 'not called yet'}${wh.failuresInARow > 1 ? ` · ${wh.failuresInARow} failures in a row` : ''}`),
            ),
            h('button', { class: 'btn', onclick: () => mutation(cx.webhooks.test, { ...S, hookId: wh.id }).then(() => toast('Test event sent')).catch((err) => toast(err.message)) }, 'Test'),
            h('button', { class: 'btn danger', onclick: async () => confirm('Delete this webhook?') && (await mutation(cx.webhooks.remove, { ...S, hookId: wh.id }), draw()) }, 'Delete'),
          ),
        ),
        h('div', { class: 'row' }, url, events, h('button', { class: 'btn primary', onclick: add }, 'Add')),
        result,
      );
    };
    await draw();
    return [box];
  }

  function deleteSection() {
    const others = state.workspaces.filter((x) => x.id !== WS_ID);
    const confirmName = h('input', { class: 'field', placeholder: `Type “${w.name}” to confirm` });
    const btn = h('button', { class: 'btn danger', disabled: true }, 'Delete workspace');
    confirmName.addEventListener('input', () => (btn.disabled = confirmName.value.trim() !== w.name.trim()));
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await mutation(cx.workspaces.remove, { ...S, confirmName: confirmName.value });
        if (others[0]) localStorage.setItem('ws', others[0].id);
        else localStorage.removeItem('ws');
        location.hash = '';
        location.reload();
      } catch (err) {
        toast(err.message);
        btn.disabled = false;
      }
    };
    return [
      h('h4', { class: 'danger-title' }, 'Delete workspace'),
      h(
        'div',
        { class: 'hint' },
        `Permanently deletes “${w.name}”: all its pages and databases (Trash included), members, invite links and connected AI agents. This can’t be undone.` +
          (others.length ? '' : ' It’s your only workspace, so you’ll get a new empty one.'),
      ),
      h('div', { class: 'row' }, confirmName, btn),
    ];
  }

  openModal([h('div', { class: 'modal-head' }, w.name), nav, body]);
  show(tab);
}

// =====================================================================
// Live updates (Convex subscriptions)
// =====================================================================
const subs = { tree: null, presence: null, info: null, page: null, people: null };
const stop = (k) => {
  subs[k]?.();
  subs[k] = null;
};

/** Subscribe to the sidebar tree, presence and workspace info of the current workspace. */
function watchWorkspace() {
  ['tree', 'presence', 'info', 'people'].forEach(stop);
  const args = ws();
  watchCommentCounts();
  subs.people = watch(cx.comments.people, args, (list) => (state.members = list || []));
  subs.tree = watch(cx.pages.tree, args, (tree) => {
    setTree(tree);
    if (state.page) renderTop();
  });
  subs.presence = watch(cx.presence.list, args, (rows) => {
    state.presence = rows;
    renderPresence();
  });
  subs.info = watch(cx.workspaces.info, args, (info) => {
    setAgent(info.agent);
    const w = currentWs();
    if (w && w.name !== info.name) {
      w.name = info.name;
      renderWorkspaceHeader();
    }
  });
}

/** Subscribe to the open page; applies edits from teammates and agents as they happen. */
function watchPage(pageId) {
  stop('page');
  if (!pageId) return;
  subs.page = watch(cx.pages.get, { ...ws(), pageId }, (fresh) => onPageUpdate(pageId, fresh));
}
async function onPageUpdate(pageId, fresh) {
  if (!state.page || state.page.id !== pageId) return;
  if (saving) await saving;
  if (!state.page || state.page.id !== pageId) return;
  if (fresh === null) {
    resetDirty();
    state.page = null;
    toast('This page was deleted');
    return openPage(null);
  }
  if (fresh.version <= state.page.version) {
    // only the surroundings changed (breadcrumb titles, trash state, sub-page titles)
    const archivedChanged = !!fresh.archived !== !!state.page.archived;
    Object.assign(state.page, { breadcrumb: fresh.breadcrumb, children: fresh.children, archived: fresh.archived, row: fresh.row, properties: fresh.properties });
    if (archivedChanged) rerenderPreservingFocus([]);
    else renderTop();
    return;
  }
  const byAgent = fresh.lastEditedBy === 'agent';
  const byOther = byAgent || fresh.lastEditedBy !== state.me?.name;
  applyServerPage(fresh);
  refreshRowPanel();
  if (byAgent) toast('🤖 Agent updated this page', 'agent');
  else if (byOther && !dirty.any) setEditedLabel();
}

function setAgent(agent) {
  state.agent = agent || {};
  updateAgentDot();
}
function updateAgentDot() {
  const at = state.agent?.lastAt;
  const active = at && Date.now() - new Date(at).getTime() < 90_000;
  const dot = $('#agent-dot');
  dot.classList.toggle('active', !!active);
  dot.title = at ? `Agent active ${timeAgo(at)}` : 'No agent activity yet';
}
setInterval(() => {
  updateAgentDot();
  renderPresence();
  if (state.page && !dirty.any && !saving) setEditedLabel();
}, 20_000);

// =====================================================================
// Global UI
// =====================================================================
$('#btn-search').onclick = openSearch;
$('#btn-new-page').onclick = () => newPage();
$('#btn-add-root').onclick = () => newPage();
$('#btn-trash').onclick = openTrash;
$('#btn-agent').onclick = () => openSettings('agent');
$('#btn-invite').onclick = () => openSettings('members');
$('#ws-switcher').onclick = (e) => workspaceMenu(e.currentTarget);
$('#btn-fav').onclick = () => state.page && toggleFavorite(state.page.id);
$('#btn-comments').onclick = () => (comments.open ? closeComments() : openComments());
$('#btn-page-menu').onclick = (e) => state.page && pageMenu(e.currentTarget, state.page.id);
const setSidebar = (open) => {
  $('#app').classList.toggle('sidebar-closed', !open);
  localStorage.setItem('sidebar', open ? '1' : '0');
};
$('#collapse-sidebar').onclick = () => setSidebar(false);
$('#open-sidebar').onclick = () => setSidebar(true);
if (localStorage.getItem('sidebar') === '0' || innerWidth < 760) setSidebar(false);

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openSearch();
  } else if (mod && e.key === '\\') {
    e.preventDefault();
    setSidebar($('#app').classList.contains('sidebar-closed'));
  } else if (mod && e.key.toLowerCase() === 's') {
    e.preventDefault();
    flushSave();
  } else if (e.key === 'Escape') {
    closePop();
  }
});
$('#scroller').addEventListener('scroll', () => {
  closePop();
  closeSlash();
});

// =====================================================================
// Boot
// =====================================================================
// A connect request (#/oauth?…) opened in a tab that already runs the app: restart into the consent screen.
addEventListener('hashchange', () => {
  if (/^#\/oauth\?/.test(location.hash)) location.reload();
});

(async function boot() {
  const invite = location.hash.match(/^#\/invite\/([^/?#]+)/);
  // An app asking to connect (OAuth). Kept in sessionStorage so it survives logging in.
  const oauthMatch = location.hash.match(/^#\/oauth\?(.*)$/);
  if (oauthMatch) {
    sessionStorage.setItem('oauth', oauthMatch[1]);
    history.replaceState(null, '', location.pathname);
  }
  const oauth = sessionStorage.getItem('oauth');
  let me = null;
  if (session.get()) me = await query(cx.auth.me, { session: session.get() }).catch(() => null);
  if (!me) {
    session.clear();
    const account = await import('./account.js');
    return account.renderAuth({ inviteToken: invite ? decodeURIComponent(invite[1]) : null, connecting: !!oauth });
  }
  if (oauth) {
    const account = await import('./account.js');
    return account.renderConsent(new URLSearchParams(oauth), me);
  }
  if (invite) {
    const account = await import('./account.js');
    return account.renderAcceptInvite(decodeURIComponent(invite[1]), me);
  }
  state.me = me.user;
  state.admin = !!me.admin;
  state.workspaces = me.workspaces;
  if (!state.workspaces.length) state.workspaces = [await mutation(cx.workspaces.create, { session: session.get(), name: `${me.user.name}'s Workspace` })];
  const saved = localStorage.getItem('ws');
  WS_ID = state.workspaces.some((w) => w.id === saved) ? saved : state.workspaces[0].id;
  localStorage.setItem('ws', WS_ID);
  renderWorkspaceHeader();
  watchWorkspace();
  await loadTree();
  const id = currentRouteId() || localStorage.getItem(lastPageKey());
  if (id && !currentRouteId()) history.replaceState(null, '', '#/' + id);
  await openPage(id && (state.flat.has(id) || currentRouteId()) ? id : state.tree[0]?.id || null);
})();
