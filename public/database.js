// Database views (table + board) and the property panel of database items.
// Filtering / sorting use the same shared code as the server's query_database.
import { titleProp, applyView, groupsFor, groupKeyOf, rawValue, displayValue, resolveProp, PROPERTY_TYPES, GROUPABLE } from './shared/database.js';

const TYPE_ICON = { title: 'Aa', text: '≡', number: '#', checkbox: '☑', select: '◉', multi_select: '☰', date: '📅', person: '👤', url: '🔗', email: '@', created_time: '🕒', last_edited_time: '🕒' };
const TYPE_NAME = { text: 'Text', number: 'Number', checkbox: 'Checkbox', select: 'Select', multi_select: 'Multi-select', date: 'Date', person: 'Person', url: 'URL', email: 'Email' };
const OPS = {
  text: ['contains', 'not_contains', 'equals', 'not_equals', 'is_empty', 'is_not_empty'],
  number: ['equals', 'not_equals', 'greater_than', 'less_than', 'greater_or_equal', 'less_or_equal', 'is_empty', 'is_not_empty'],
  select: ['equals', 'not_equals', 'is_empty', 'is_not_empty'],
  multi: ['contains', 'not_contains', 'is_empty', 'is_not_empty'],
  checkbox: ['equals'],
  date: ['equals', 'before', 'after', 'on_or_before', 'on_or_after', 'is_empty', 'is_not_empty'],
};
const OP_NAME = {
  equals: 'is',
  not_equals: 'is not',
  contains: 'contains',
  not_contains: 'does not contain',
  is_empty: 'is empty',
  is_not_empty: 'is not empty',
  greater_than: '>',
  less_than: '<',
  greater_or_equal: '≥',
  less_or_equal: '≤',
  before: 'is before',
  after: 'is after',
  on_or_before: 'is on or before',
  on_or_after: 'is on or after',
};
const opsFor = (t) =>
  ({ title: OPS.text, text: OPS.text, url: OPS.text, email: OPS.text, number: OPS.number, select: OPS.select, multi_select: OPS.multi, person: OPS.multi, checkbox: OPS.checkbox, date: OPS.date, created_time: OPS.date, last_edited_time: OPS.date })[t] ||
  OPS.text;

// ---------------------------------------------------------------------------
// Value cells (shared by the table, board cards and the item property panel)
// ---------------------------------------------------------------------------
function chip(h, name, color) {
  return h('span', { class: `db-chip opt-${color || 'gray'}` }, name);
}

/**
 * An editable value. ctx: { h, db, members, save(row, prop, value), deps }.
 * `row` is { id, title, props }.
 */
function valueCell(ctx, row, prop, { compact = false } = {}) {
  const { h, db, members, deps } = ctx;
  const v = rawValue(row, prop);
  const commit = (value) => ctx.save(row, prop, value);
  const input = (type, value, parse = (x) => x) => {
    const el = h('input', { class: 'db-input', type, value: value ?? '' });
    let last = el.value;
    const done = () => {
      if (el.value === last) return;
      last = el.value;
      commit(parse(el.value));
    };
    el.addEventListener('change', done);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        el.blur();
      }
      if (e.key === 'Escape') {
        el.value = last;
        el.blur();
      }
    });
    return el;
  };
  switch (prop.type) {
    case 'title': {
      const el = input('text', row.title || '', (x) => x);
      el.classList.add('db-title-input');
      el.placeholder = 'Untitled';
      return el;
    }
    case 'text':
    case 'email':
      return input('text', v ?? '');
    case 'url': {
      const wrap = h('div', { class: 'db-url' }, input('text', v ?? ''));
      if (v) wrap.append(h('a', { class: 'db-url-open', href: /^https?:/i.test(v) ? v : `https://${v}`, target: '_blank', rel: 'noopener', title: 'Open link' }, '↗'));
      return wrap;
    }
    case 'number':
      return input('number', v ?? '', (x) => (x === '' ? null : Number(x)));
    case 'checkbox': {
      const el = h('input', { type: 'checkbox', class: 'db-check' });
      el.checked = !!v;
      el.addEventListener('change', () => commit(el.checked));
      return el;
    }
    case 'date': {
      const el = input('date', v?.start ? String(v.start).slice(0, 10) : '', (x) => x || null);
      return el;
    }
    case 'select':
    case 'multi_select':
    case 'person': {
      const ids = prop.type === 'select' ? (v ? [v] : []) : v || [];
      const shown = ids.map((id) => {
        if (prop.type === 'person') {
          const m = members.find((x) => x.id === id);
          return h('span', { class: 'db-person' }, deps.avatar(m || { name: '?', color: '#999' }, 'tiny'), m?.name || 'Former member');
        }
        const o = prop.options.find((x) => x.id === id);
        return o ? chip(h, o.name, o.color) : null;
      });
      const el = h('button', { class: `db-chips${compact ? ' compact' : ''}`, type: 'button' }, ...shown);
      if (!ids.length) el.append(h('span', { class: 'db-empty' }, compact ? '' : 'Empty'));
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        optionPicker(ctx, el, row, prop);
      });
      return el;
    }
    case 'created_time':
    case 'last_edited_time':
      return h('span', { class: 'db-readonly' }, v ? new Date(v).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');
    default:
      return h('span', {}, String(displayValue(prop, v, members) ?? ''));
  }
}

/** Pick select / multi-select options or people; typing a new name creates an option. */
function optionPicker(ctx, anchor, row, prop) {
  const { h, members, deps } = ctx;
  const multi = prop.type !== 'select';
  let current = prop.type === 'select' ? (rawValue(row, prop) ? [rawValue(row, prop)] : []) : [...(rawValue(row, prop) || [])];
  const search = h('input', { class: 'pop-input', placeholder: prop.type === 'person' ? 'Search people…' : 'Search or create an option…' });
  const list = h('div', { class: 'db-opt-list' });
  const choices = () =>
    prop.type === 'person' ? members.map((m) => ({ id: m.id, name: m.name, color: m.color, member: m })) : prop.options.map((o) => ({ id: o.id, name: o.name, color: o.color }));
  const apply = (next) => {
    current = next;
    ctx.save(row, prop, prop.type === 'select' ? next[0] ?? null : next);
  };
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const items = choices().filter((c) => !q || c.name.toLowerCase().includes(q));
    list.replaceChildren(
      ...items.map((c) =>
        h(
          'button',
          {
            class: `menu-item compact${current.includes(c.id) ? ' active' : ''}`,
            onclick: () => {
              if (multi) apply(current.includes(c.id) ? current.filter((x) => x !== c.id) : [...current, c.id]);
              else {
                apply(current[0] === c.id ? [] : [c.id]);
                deps.closePop();
              }
              draw();
            },
          },
          h('span', { class: 'mi-icon' }, current.includes(c.id) ? '✓' : ''),
          c.member ? h('span', { class: 'db-person' }, deps.avatar(c.member, 'tiny'), c.name) : chip(h, c.name, c.color),
        ),
      ),
    );
    if (q && prop.type !== 'person' && !choices().some((c) => c.name.toLowerCase() === q)) {
      list.append(
        h(
          'button',
          {
            class: 'menu-item compact',
            onclick: () => {
              const name = search.value.trim();
              // the server adds the option; send its name
              ctx.save(row, prop, prop.type === 'select' ? name : [...current.map((id) => prop.options.find((o) => o.id === id)?.name || id), name]);
              deps.closePop();
            },
          },
          h('span', { class: 'mi-icon' }, '＋'),
          h('span', {}, 'Create ', chip(h, search.value.trim(), 'gray')),
        ),
      );
    }
    if (!list.children.length) list.append(h('div', { class: 'empty-note' }, prop.type === 'person' ? 'No members' : 'Type to create an option'));
  };
  search.addEventListener('input', draw);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      list.querySelector('.menu-item')?.click();
    }
    if (e.key === 'Escape') deps.closePop();
  });
  const clear = current.length ? h('button', { class: 'menu-item compact', onclick: () => (apply([]), deps.closePop()) }, h('span', { class: 'mi-icon' }, '✕'), h('span', {}, 'Clear')) : null;
  deps.openPop(anchor, [search, list, clear], { width: 260 });
  draw();
}

// ---------------------------------------------------------------------------
// Database view (tabs, toolbar, table / board)
// ---------------------------------------------------------------------------
/**
 * opts.linked: { view, onChange(view), onRemove() } — show the database inside another page
 * with one view whose settings belong to that page's block, not to the database.
 */
export function createDatabaseView(pageId, deps, opts = {}) {
  const { h } = deps;
  let linked = opts.linked || null;
  const el = h('div', { class: `db${linked ? ' linked' : ''}` }, h('div', { class: 'db-loading' }, 'Loading…'));
  let data; // undefined while loading, null if the database is gone
  let search = '';
  let pending = false;
  let focusRow = null;
  const viewKey = `dbview:${pageId}`;
  let viewId = localStorage.getItem(viewKey);

  const unsub = deps.watch(deps.cx.pages.rows, { ...deps.ws(), pageId }, (d) => {
    data = d;
    if (el.contains(document.activeElement) && document.activeElement.matches('input')) pending = true;
    else render();
  });
  el.addEventListener('focusout', () =>
    setTimeout(() => {
      if (pending && !el.contains(document.activeElement)) {
        pending = false;
        render();
      }
    }, 0),
  );

  const write = (method, args) => deps.rpc(method, { pageId, ...args }).catch((err) => (deps.toast(err.message), null));
  const save = (row, prop, value) =>
    deps
      .rpc('updateRows', { updates: [prop.type === 'title' ? { itemId: row.id, title: value ?? '' } : { itemId: row.id, properties: { [prop.id]: value } }] })
      .then((r) => r?.failed && deps.toast(r.results[0].error))
      .catch((err) => deps.toast(err.message));
  const saveView = (patch) => {
    if (!linked) return write('saveView', { viewId: currentView().id, ...patch });
    // a linked view's settings are part of the page that shows it
    const { visibleProperties, ...rest } = patch;
    const next = { ...linked.view, ...rest, ...(visibleProperties !== undefined ? { visible: visibleProperties } : {}) };
    if (next.type === 'board' && !next.groupBy) next.groupBy = (data.database.properties.find((p) => p.type === 'select') || data.database.properties.find((p) => GROUPABLE.includes(p.type)))?.id || null;
    linked = { ...linked, view: next };
    linked.onChange(next);
    render();
    return Promise.resolve(next);
  };
  const updateDb = (patch) => write('updateDatabase', patch);

  function currentView() {
    if (linked) return { filters: [], sorts: [], type: 'table', name: data.database.title, ...linked.view };
    const views = data.database.views;
    return views.find((v) => v.id === viewId) || views[0];
  }
  function ctx() {
    return { h, db: data.database, members: data.members, save, deps };
  }
  /** Values that make a new row show up in the current (filtered) view. */
  function defaultsFor(view) {
    const out = {};
    for (const f of view.filters || []) {
      if (f.or || f.and || f.value == null) continue;
      const prop = data.database.properties.find((p) => p.id === f.property);
      if (!prop) continue;
      if ((f.operator === 'equals' && ['select', 'checkbox'].includes(prop.type)) || (f.operator === 'contains' && ['multi_select', 'person'].includes(prop.type))) out[prop.id] = prop.type === 'checkbox' ? f.value : f.value;
    }
    return out;
  }
  async function newRow(extra = {}) {
    const view = currentView();
    const r = await write('createRows', { items: [{ title: '', properties: { ...defaultsFor(view), ...extra } }] });
    if (r?.results?.[0]?.id) focusRow = r.results[0].id;
    if (r?.failed) deps.toast(r.results[0].error);
    focusNewRow(); // the row may already be drawn (the subscription can beat the mutation's reply)
  }
  function focusNewRow() {
    if (!focusRow) return;
    const t = el.querySelector(`[data-row="${CSS.escape(focusRow)}"] .db-title-input, .db-card[data-row="${CSS.escape(focusRow)}"]`);
    if (!t) return;
    focusRow = null;
    if (t.matches('input')) t.focus();
    else deps.go(t.dataset.row); // on a board, open the new card's page to name it
  }

  function render() {
    if (data === undefined) {
      el.replaceChildren(h('div', { class: 'db-loading' }, 'Loading…'));
      return;
    }
    if (!data) {
      el.replaceChildren(h('div', { class: 'db-loading' }, 'This database is not available.'));
      return;
    }
    const view = currentView();
    const c = { members: data.members, me: deps.me()?.id };
    let rows = [];
    try {
      rows = applyView(data.database, data.rows, { filters: view.filters, sorts: view.sorts, search }, c);
    } catch (err) {
      deps.toast(err.message);
      rows = data.rows;
    }
    el.replaceChildren(toolbar(view, rows.length), view.type === 'board' ? board(view, rows) : table(view, rows));
    focusNewRow();
  }

  // ---------- toolbar ----------
  function toolbar(view, count) {
    const tabs = linked
      ? h(
          'div',
          { class: 'db-tabs linked' },
          h('button', { class: 'db-linked-title', title: 'View options', onclick: (e) => viewMenu(e.currentTarget, view) }, h('span', { class: 'db-tab-icon' }, view.type === 'board' ? '▥' : '▤'), view.name || data.database.title || 'Untitled'),
          h('button', { class: 'db-linked-source', title: 'Open the database', onclick: () => deps.go(pageId) }, '↗ ', data.title || 'Database'),
        )
      : h(
      'div',
      { class: 'db-tabs' },
      data.database.views.map((v) =>
        h(
          'button',
          {
            class: `db-tab${v.id === view.id ? ' active' : ''}`,
            onclick: (e) => {
              if (v.id === view.id) return viewMenu(e.currentTarget, v);
              viewId = v.id;
              localStorage.setItem(viewKey, v.id);
              render();
            },
            title: v.id === view.id ? 'View options' : '',
          },
          h('span', { class: 'db-tab-icon' }, v.type === 'board' ? '▥' : '▤'),
          v.name,
        ),
      ),
      h('button', { class: 'db-tab add', title: 'Add a view', onclick: (e) => addViewMenu(e.currentTarget) }, '＋'),
    );
    const nFilters = (view.filters || []).length;
    const nSorts = (view.sorts || []).length;
    const searchEl = h('input', { class: 'db-search', placeholder: 'Search…', value: search });
    searchEl.addEventListener('input', () => {
      search = searchEl.value;
      const pos = searchEl.selectionStart;
      render();
      const s = el.querySelector('.db-search');
      s.focus();
      s.setSelectionRange(pos, pos);
    });
    const actions = h(
      'div',
      { class: 'db-actions' },
      h('span', { class: 'db-count' }, `${count} ${count === 1 ? 'item' : 'items'}`),
      h('button', { class: `db-btn${nFilters ? ' on' : ''}`, onclick: (e) => filterEditor(e.currentTarget) }, nFilters ? `Filter · ${nFilters}` : 'Filter'),
      h('button', { class: `db-btn${nSorts ? ' on' : ''}`, onclick: (e) => sortEditor(e.currentTarget) }, nSorts ? `Sort · ${nSorts}` : 'Sort'),
      searchEl,
      h('button', { class: 'btn primary small', onclick: () => newRow() }, 'New'),
    );
    return h('div', { class: 'db-toolbar' }, tabs, actions);
  }

  function addViewMenu(anchor) {
    deps.menu(anchor, [
      { icon: '▤', name: 'Table', run: () => write('saveView', { type: 'table', name: 'Table' }).then((v) => v && ((viewId = v.id), localStorage.setItem(viewKey, v.id))) },
      {
        icon: '▥',
        name: 'Board',
        run: () => {
          if (!data.database.properties.some((p) => GROUPABLE.includes(p.type))) return deps.toast('Add a Select, Person or Checkbox property to group a board by');
          write('saveView', { type: 'board', name: 'Board' }).then((v) => v && ((viewId = v.id), localStorage.setItem(viewKey, v.id)));
        },
      },
    ]);
  }

  function viewMenu(anchor, v) {
    const groupable = data.database.properties.filter((p) => GROUPABLE.includes(p.type));
    deps.menu(anchor, [
      { label: v.name },
      { icon: '✎', name: 'Rename', run: () => deps.askInput(anchor, 'View name', v.name, (name) => saveView({ name })) },
      v.type === 'table' && groupable.length ? { icon: '▥', name: 'Show as board', run: () => saveView({ type: 'board' }) } : null,
      v.type === 'board' ? { icon: '▤', name: 'Show as table', run: () => saveView({ type: 'table' }) } : null,
      v.type === 'board' ? { icon: '⇶', name: 'Group by…', run: () => deps.menu(anchor, groupable.map((p) => ({ icon: TYPE_ICON[p.type], name: p.name + (p.id === v.groupBy ? '  ✓' : ''), run: () => saveView({ groupBy: p.id }) }))) } : null,
      { icon: '☷', name: 'Properties…', run: () => visibilityEditor(anchor, v) },
      linked ? { icon: '↗', name: 'Open source database', run: () => deps.go(pageId) } : null,
      '-',
      linked ? { icon: '🗑', name: 'Remove from this page', danger: true, run: () => linked.onRemove() } : null,
      !linked && data.database.views.length > 1 ? { icon: '🗑', name: 'Delete view', danger: true, run: () => write('saveView', { viewId: v.id, remove: true }) } : null,
    ]);
  }

  function visibilityEditor(anchor, v) {
    const all = [titleProp(data.database), ...data.database.properties, { id: 'created_time', name: 'Created time', type: 'created_time' }, { id: 'last_edited_time', name: 'Last edited time', type: 'last_edited_time' }];
    let visible = v.visible ? [...v.visible] : [titleProp(data.database), ...data.database.properties].map((p) => p.id);
    const list = h('div', { class: 'db-opt-list' });
    const draw = () =>
      list.replaceChildren(
        ...all.map((p) => {
          const box = h('input', { type: 'checkbox' });
          box.checked = visible.includes(p.id);
          box.disabled = p.type === 'title';
          box.addEventListener('change', () => {
            visible = box.checked ? [...visible, p.id] : visible.filter((x) => x !== p.id);
            saveView({ visibleProperties: all.map((x) => x.id).filter((id) => visible.includes(id)) });
          });
          return h('label', { class: 'db-vis-row' }, box, h('span', { class: 'mi-icon' }, TYPE_ICON[p.type]), p.name);
        }),
      );
    draw();
    deps.openPop(anchor, [h('div', { class: 'pop-label' }, 'Shown properties'), list], { width: 260 });
  }

  // ---------- filters & sorts ----------
  function valueControl(prop, value, onChange) {
    if (['select', 'multi_select'].includes(prop.type)) {
      const s = h('select', { class: 'db-select' }, h('option', { value: '' }, '—'), prop.options.map((o) => h('option', { value: o.name, selected: o.name === value || o.id === value ? true : null }, o.name)));
      s.addEventListener('change', () => onChange(s.value));
      return s;
    }
    if (prop.type === 'person') {
      const s = h(
        'select',
        { class: 'db-select' },
        h('option', { value: 'me', selected: value === 'me' ? true : null }, 'Me'),
        data.members.map((m) => h('option', { value: m.id, selected: m.id === value ? true : null }, m.name)),
      );
      s.addEventListener('change', () => onChange(s.value));
      if (value == null) queueMicrotask(() => onChange(s.value));
      return s;
    }
    if (prop.type === 'checkbox') {
      const s = h('select', { class: 'db-select' }, h('option', { value: 'true', selected: value === true || value === 'true' ? true : null }, 'Checked'), h('option', { value: 'false', selected: value === false || value === 'false' ? true : null }, 'Unchecked'));
      s.addEventListener('change', () => onChange(s.value === 'true'));
      if (value == null) queueMicrotask(() => onChange(true));
      return s;
    }
    const isDate = ['date', 'created_time', 'last_edited_time'].includes(prop.type);
    const i = h('input', { class: 'db-input boxed', value: value ?? '', placeholder: isDate ? 'YYYY-MM-DD, today, +7d' : 'Value' });
    i.addEventListener('change', () => onChange(prop.type === 'number' ? Number(i.value) : i.value));
    return i;
  }

  function filterEditor(anchor) {
    const view = currentView();
    let filters = structuredClone(view.filters || []);
    const all = [titleProp(data.database), ...data.database.properties, { id: 'created_time', name: 'Created time', type: 'created_time' }, { id: 'last_edited_time', name: 'Last edited time', type: 'last_edited_time' }];
    const body = h('div', { class: 'db-editor' });
    const commit = () => saveView({ filters });
    const draw = () => {
      body.replaceChildren();
      if (!filters.length) body.append(h('div', { class: 'empty-note' }, 'No filters. Only matching items will show in this view.'));
      filters.forEach((f, i) => {
        if (f.or || f.and) {
          body.append(h('div', { class: 'db-editor-row' }, h('span', { class: 'grow sub' }, `Advanced group (${(f.or || f.and).length} conditions, set by an agent)`), h('button', { class: 'icon-btn small', onclick: () => (filters.splice(i, 1), commit(), draw()) }, '✕')));
          return;
        }
        let prop;
        try {
          prop = resolveProp(data.database, f.property);
        } catch {
          return;
        }
        const propSel = h('select', { class: 'db-select' }, all.map((p) => h('option', { value: p.id, selected: p.id === prop.id ? true : null }, p.name)));
        propSel.addEventListener('change', () => {
          const np = all.find((p) => p.id === propSel.value);
          filters[i] = { property: np.id, operator: opsFor(np.type)[0], value: null };
          draw();
        });
        const opSel = h('select', { class: 'db-select' }, opsFor(prop.type).map((o) => h('option', { value: o, selected: o === f.operator ? true : null }, OP_NAME[o])));
        opSel.addEventListener('change', () => {
          f.operator = opSel.value;
          if (['is_empty', 'is_not_empty'].includes(f.operator)) delete f.value;
          commit();
          draw();
        });
        const val = ['is_empty', 'is_not_empty'].includes(f.operator)
          ? h('span', { class: 'grow' })
          : valueControl(prop, f.value, (value) => {
              f.value = value;
              if (value !== '' && value != null) commit();
            });
        body.append(h('div', { class: 'db-editor-row' }, propSel, opSel, val, h('button', { class: 'icon-btn small', title: 'Remove', onclick: () => (filters.splice(i, 1), commit(), draw()) }, '✕')));
      });
      body.append(
        h(
          'button',
          {
            class: 'menu-item compact',
            onclick: () => {
              const p = data.database.properties[0] || titleProp(data.database);
              filters.push({ property: p.id, operator: opsFor(p.type)[0], value: null });
              draw();
            },
          },
          h('span', { class: 'mi-icon' }, '＋'),
          'Add filter',
        ),
      );
    };
    draw();
    deps.openPop(anchor, [h('div', { class: 'pop-label' }, `Filters · ${view.name}`), body], { width: 520 });
  }

  function sortEditor(anchor) {
    const view = currentView();
    let sorts = structuredClone(view.sorts || []);
    const all = [titleProp(data.database), ...data.database.properties, { id: 'created_time', name: 'Created time' }, { id: 'last_edited_time', name: 'Last edited time' }];
    const body = h('div', { class: 'db-editor' });
    const commit = () => saveView({ sorts });
    const draw = () => {
      body.replaceChildren();
      if (!sorts.length) body.append(h('div', { class: 'empty-note' }, 'No sorts. Items keep their manual order.'));
      sorts.forEach((s, i) => {
        const propSel = h('select', { class: 'db-select' }, all.map((p) => h('option', { value: p.id, selected: p.id === s.property ? true : null }, p.name)));
        propSel.addEventListener('change', () => ((s.property = propSel.value), commit()));
        const dir = h('select', { class: 'db-select' }, h('option', { value: 'ascending', selected: s.direction !== 'descending' ? true : null }, 'Ascending'), h('option', { value: 'descending', selected: s.direction === 'descending' ? true : null }, 'Descending'));
        dir.addEventListener('change', () => ((s.direction = dir.value), commit()));
        body.append(h('div', { class: 'db-editor-row' }, propSel, dir, h('span', { class: 'grow' }), h('button', { class: 'icon-btn small', onclick: () => (sorts.splice(i, 1), commit(), draw()) }, '✕')));
      });
      body.append(
        h(
          'button',
          { class: 'menu-item compact', onclick: () => (sorts.push({ property: (data.database.properties[0] || titleProp(data.database)).id, direction: 'ascending' }), commit(), draw()) },
          h('span', { class: 'mi-icon' }, '＋'),
          'Add sort',
        ),
      );
    };
    draw();
    deps.openPop(anchor, [h('div', { class: 'pop-label' }, `Sort · ${view.name}`), body], { width: 400 });
  }

  // ---------- properties ----------
  function addPropertyPop(anchor) {
    const name = h('input', { class: 'pop-input', placeholder: 'Property name' });
    const types = h(
      'div',
      { class: 'db-opt-list' },
      PROPERTY_TYPES.map((t) =>
        h(
          'button',
          {
            class: 'menu-item compact',
            onclick: () => {
              const n = name.value.trim() || TYPE_NAME[t];
              deps.closePop();
              updateDb({ addProperties: [{ name: n, type: t }] });
            },
          },
          h('span', { class: 'mi-icon' }, TYPE_ICON[t]),
          TYPE_NAME[t],
        ),
      ),
    );
    deps.openPop(anchor, [name, h('div', { class: 'pop-label' }, 'Type'), types], { width: 240 });
  }

  function headerMenu(anchor, prop) {
    const isTitle = prop.type === 'title';
    const isPseudo = ['created_time', 'last_edited_time'].includes(prop.type);
    deps.menu(anchor, [
      { label: prop.name },
      !isPseudo ? { icon: '✎', name: 'Rename', run: () => deps.askInput(anchor, 'Property name', prop.name, (n) => updateDb(isTitle ? { titleName: n } : { updateProperties: [{ property: prop.id, name: n }] })) } : null,
      !isTitle && !isPseudo
        ? {
            icon: '⇄',
            name: `Type: ${TYPE_NAME[prop.type]}`,
            run: () =>
              deps.menu(
                anchor,
                PROPERTY_TYPES.map((t) => ({ icon: TYPE_ICON[t], name: TYPE_NAME[t] + (t === prop.type ? '  ✓' : ''), run: () => t !== prop.type && updateDb({ updateProperties: [{ property: prop.id, type: t }] }) })),
              ),
          }
        : null,
      { icon: '↑', name: 'Sort ascending', run: () => saveView({ sorts: [{ property: prop.id, direction: 'ascending' }] }) },
      { icon: '↓', name: 'Sort descending', run: () => saveView({ sorts: [{ property: prop.id, direction: 'descending' }] }) },
      !isTitle
        ? {
            icon: '◌',
            name: 'Hide in this view',
            run: () => {
              const v = currentView();
              const ids = (v.visible || [titleProp(data.database), ...data.database.properties].map((p) => p.id)).filter((id) => id !== prop.id);
              saveView({ visibleProperties: ids });
            },
          }
        : null,
      !isTitle && !isPseudo ? '-' : null,
      !isTitle && !isPseudo
        ? { icon: '🗑', name: 'Delete property', danger: true, run: () => confirm(`Delete "${prop.name}" and its values from every item?`) && updateDb({ removeProperties: [prop.id] }) }
        : null,
    ]);
  }

  // ---------- table ----------
  function columns(view) {
    const db = data.database;
    const pseudo = { created_time: { id: 'created_time', name: 'Created time', type: 'created_time' }, last_edited_time: { id: 'last_edited_time', name: 'Last edited time', type: 'last_edited_time' } };
    const byId = (id) => (id === 'title' ? titleProp(db) : db.properties.find((p) => p.id === id) || pseudo[id]);
    const cols = (view.visible || [titleProp(db), ...db.properties].map((p) => p.id)).map(byId).filter(Boolean);
    return cols[0]?.type === 'title' ? cols : [titleProp(db), ...cols.filter((c) => c.type !== 'title')];
  }

  function table(view, rows) {
    const cols = columns(view);
    const c = ctx();
    const head = h(
      'div',
      { class: 'db-row db-head' },
      cols.map((p) => h('button', { class: `db-cell db-th${p.type === 'title' ? ' title' : ''}`, onclick: (e) => headerMenu(e.currentTarget, p) }, h('span', { class: 'db-type' }, TYPE_ICON[p.type]), h('span', { class: 'db-th-name' }, p.name))),
      h('button', { class: 'db-cell db-th add', title: 'Add a property', onclick: (e) => addPropertyPop(e.currentTarget) }, '＋'),
    );
    const body = rows.map((r) =>
      h(
        'div',
        { class: 'db-row', dataset: { row: r.id } },
        cols.map((p) =>
          h(
            'div',
            { class: `db-cell type-${p.type}${p.type === 'title' ? ' title' : ''}` },
            p.type === 'title'
              ? [
                  h('span', { class: 'db-row-icon' }, r.icon || (r.hasContent ? '📄' : '')),
                  valueCell(c, r, p),
                  h('button', { class: 'db-open', title: 'Open as page', onclick: () => deps.go(r.id) }, 'Open'),
                ]
              : valueCell(c, r, p, { compact: true }),
          ),
        ),
        h('div', { class: 'db-cell add' }),
      ),
    );
    const foot = h('button', { class: 'db-new-row', onclick: () => newRow() }, '＋ New');
    const empty = !rows.length ? h('div', { class: 'db-empty-view' }, data.rows.length ? 'No items match this view.' : 'No items yet.') : null;
    return h('div', { class: 'db-table-wrap' }, h('div', { class: 'db-table', style: `--cols:${cols.length}` }, head, body, empty, foot));
  }

  // ---------- board ----------
  function board(view, rows) {
    const db = data.database;
    let group;
    try {
      group = resolveProp(db, view.groupBy, { allowPseudo: false });
    } catch {
      return h('div', { class: 'db-empty-view' }, 'Choose a property to group this board by (click the view tab).');
    }
    const c = ctx();
    const shown = columns(view).filter((p) => p.type !== 'title' && p.id !== group.id);
    const groups = groupsFor(group, data.members);
    const keyOf = (k) => JSON.stringify(k);
    const buckets = new Map(groups.map((g) => [keyOf(g.key), []]));
    for (const r of rows) {
      const k = keyOf(groupKeyOf(group, r));
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(r);
    }
    const valueFor = (key) => (group.type === 'person' ? (key ? [key] : []) : key);
    const cols = groups
      .filter((g) => g.key !== null || buckets.get(keyOf(null))?.length)
      .map((g) => {
        const items = buckets.get(keyOf(g.key)) || [];
        const col = h(
          'div',
          { class: 'db-col' },
          h('div', { class: 'db-col-head' }, g.color && group.type === 'select' ? chip(h, g.name, g.color) : h('span', { class: 'db-col-name' }, g.name), h('span', { class: 'db-col-count' }, String(items.length))),
          items.map((r) => {
            const card = h(
              'div',
              { class: 'db-card', draggable: 'true', dataset: { row: r.id }, onclick: (e) => !e.target.closest('button, input, a') && deps.go(r.id) },
              h('div', { class: 'db-card-title' }, r.icon ? r.icon + ' ' : '', r.title || 'Untitled'),
              shown
                .filter((p) => {
                  const v = rawValue(r, p);
                  return p.type === 'checkbox' ? v : v != null && !(Array.isArray(v) && !v.length);
                })
                .map((p) => h('div', { class: 'db-card-prop', title: p.name }, p.type === 'checkbox' ? h('span', { class: 'sub' }, `☑ ${p.name}`) : valueCell(c, r, p, { compact: true }))),
            );
            card.addEventListener('dragstart', (e) => {
              e.dataTransfer.setData('text/x-db-row', r.id);
              e.dataTransfer.effectAllowed = 'move';
              card.classList.add('dragging');
            });
            card.addEventListener('dragend', () => card.classList.remove('dragging'));
            return card;
          }),
          h('button', { class: 'db-new-row', onclick: () => newRow({ [group.id]: valueFor(g.key) }) }, '＋ New'),
        );
        col.addEventListener('dragover', (e) => {
          if (!e.dataTransfer.types.includes('text/x-db-row')) return;
          e.preventDefault();
          col.classList.add('drop');
        });
        col.addEventListener('dragleave', () => col.classList.remove('drop'));
        col.addEventListener('drop', (e) => {
          e.preventDefault();
          col.classList.remove('drop');
          const id = e.dataTransfer.getData('text/x-db-row');
          const r = data.rows.find((x) => x.id === id);
          if (r && keyOf(groupKeyOf(group, r)) !== keyOf(g.key)) save(r, group, valueFor(g.key));
        });
        return col;
      });
    return h('div', { class: 'db-board' }, cols);
  }

  render();
  return {
    el,
    destroy() {
      unsub?.();
    },
    /** A linked view's settings changed elsewhere (another person, an agent). */
    setLinkedView(view) {
      if (!linked || JSON.stringify(view) === JSON.stringify(linked.view)) return;
      linked = { ...linked, view };
      if (data) render();
    },
  };
}

// ---------------------------------------------------------------------------
// Property panel at the top of a database item's page
// ---------------------------------------------------------------------------
export function rowPropertiesPanel(page, deps) {
  const { h } = deps;
  const db = { titleName: page.row.titleName, properties: page.row.properties, views: [] };
  const members = page.row.members || [];
  const row = { id: page.id, title: page.title, props: page.props || {} };
  const save = (r, prop, value) =>
    deps
      .rpc('updateRows', { updates: [{ itemId: r.id, properties: { [prop.id]: value } }] })
      .then((res) => res?.failed && deps.toast(res.results[0].error))
      .catch((err) => deps.toast(err.message));
  const c = { h, db, members, save, deps };
  return h(
    'div',
    { class: 'db-props' },
    db.properties.map((p) => h('div', { class: 'db-prop-row' }, h('div', { class: 'db-prop-name' }, h('span', { class: 'db-type' }, TYPE_ICON[p.type]), p.name), h('div', { class: `db-prop-value type-${p.type}` }, valueCell(c, row, p)))),
    h('div', { class: 'db-prop-row' }, h('div', { class: 'db-prop-name' }, h('span', { class: 'db-type' }, '🗃️'), 'Database'), h('div', { class: 'db-prop-value' }, h('button', { class: 'db-link', onclick: () => deps.go(page.row.databaseId) }, page.row.databaseTitle || 'Untitled'))),
  );
}
