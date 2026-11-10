// Database views (table, board, list, gallery, calendar, timeline) and the property panel of
// database items. Filtering / sorting use the same shared code as the server's query_database;
// computed values (rollups, formulas, "is blocked") arrive already filled in from the server.
import {
  titleProp,
  allProps,
  applyView,
  groupsFor,
  groupKeyOf,
  rawValue,
  displayValue,
  resolveProp,
  formatNumber,
  aggregateView,
  aggregateText,
  uniqueIdText,
  hasTime,
  PROPERTY_TYPES,
  GROUPABLE,
  STATUS_GROUPS,
  ROLLUP_FUNCTIONS,
  AGGREGATIONS,
  NUMBER_FORMATS,
  READ_ONLY_TYPES,
  THIS_PAGE,
  BLOCKED_PROP,
  valueToText,
} from './shared/database.js';

const TYPE_ICON = {
  title: 'Aa',
  text: '≡',
  number: '#',
  checkbox: '☑',
  select: '◉',
  status: '◔',
  multi_select: '☰',
  date: '📅',
  person: '👤',
  relation: '↗',
  rollup: '∑',
  formula: 'ƒ',
  files: '📎',
  links: '🔗',
  url: '🔗',
  email: '@',
  unique_id: '№',
  created_time: '🕒',
  last_edited_time: '🕒',
  blocked: '⛔',
};
const TYPE_NAME = {
  text: 'Text',
  number: 'Number',
  checkbox: 'Checkbox',
  select: 'Select',
  status: 'Status',
  multi_select: 'Multi-select',
  date: 'Date',
  person: 'Person',
  relation: 'Relation',
  rollup: 'Rollup',
  formula: 'Formula',
  files: 'Files & media',
  links: 'Links',
  url: 'URL',
  email: 'Email',
  unique_id: 'ID',
};
const VIEW_ICON = { table: '▤', board: '▥', list: '☰', gallery: '▦', calendar: '▣', timeline: '⇶' };
const VIEW_NAME = { table: 'Table', board: 'Board', list: 'List', gallery: 'Gallery', calendar: 'Calendar', timeline: 'Timeline' };
const FN_NAME = {
  show_original: 'Show original',
  count: 'Count all',
  count_values: 'Count values',
  count_unique: 'Count unique',
  count_empty: 'Count empty',
  count_not_empty: 'Count not empty',
  percent_empty: 'Percent empty',
  percent_not_empty: 'Percent not empty',
  sum: 'Sum',
  average: 'Average',
  median: 'Median',
  min: 'Min',
  max: 'Max',
  range: 'Range',
  earliest_date: 'Earliest date',
  latest_date: 'Latest date',
  date_range: 'Date range',
  checked: 'Checked / complete',
  unchecked: 'Unchecked / not complete',
  percent_checked: 'Percent checked / complete',
  percent_unchecked: 'Percent unchecked / not complete',
  count_where: 'Count where…',
  percent_where: 'Percent where…',
};
const FORMAT_NAME = { number: 'Number', number_with_commas: 'Number with commas', percent: 'Percent', dollar: 'US dollar', euro: 'Euro', pound: 'Pound', yen: 'Yen', ruble: 'Ruble' };
const OPS = {
  text: ['contains', 'not_contains', 'equals', 'not_equals', 'is_empty', 'is_not_empty'],
  number: ['equals', 'not_equals', 'greater_than', 'less_than', 'greater_or_equal', 'less_or_equal', 'is_empty', 'is_not_empty'],
  select: ['equals', 'not_equals', 'is_empty', 'is_not_empty'],
  status: ['equals', 'not_equals', 'in_group', 'not_in_group', 'is_empty', 'is_not_empty'],
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
  in_group: 'is in group',
  not_in_group: 'is not in group',
};
const opsFor = (t) =>
  ({
    title: OPS.text,
    text: OPS.text,
    url: OPS.text,
    email: OPS.text,
    links: OPS.multi,
    files: OPS.multi,
    number: OPS.number,
    unique_id: OPS.number,
    select: OPS.select,
    status: OPS.status,
    multi_select: OPS.multi,
    person: OPS.multi,
    relation: OPS.multi,
    checkbox: OPS.checkbox,
    blocked: OPS.checkbox,
    date: OPS.date,
    created_time: OPS.date,
    last_edited_time: OPS.date,
    rollup: [...OPS.number.slice(0, 6), 'contains', 'is_empty', 'is_not_empty'],
    formula: [...OPS.number.slice(0, 6), 'contains', 'is_empty', 'is_not_empty'],
  })[t] || OPS.text;

const isEmpty = (v) => v == null || v === '' || (Array.isArray(v) && !v.length);
const pad = (n) => String(n).padStart(2, '0');
const localYmd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** A stored date ("2026-11-08" or an ISO date-time) as a local Date. */
const toLocal = (s) => (hasTime(s) ? new Date(s) : new Date(`${String(s).slice(0, 10)}T00:00:00`));
/** Local calendar day of a stored date. */
const dayOf = (s) => (s ? localYmd(toLocal(s)) : null);
function fmtDate(s) {
  if (!s) return '';
  const d = toLocal(s);
  if (isNaN(d.getTime())) return String(s);
  return hasTime(s) ? d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : d.toLocaleDateString([], { dateStyle: 'medium' });
}
const fmtRange = (v) => (v ? (v.end ? `${fmtDate(v.start)} → ${fmtDate(v.end)}` : fmtDate(v.start)) : '');

// ---------------------------------------------------------------------------
// Value cells (shared by every view and the item property panel)
// ---------------------------------------------------------------------------
function chip(h, name, color) {
  return h('span', { class: `db-chip opt-${color || 'gray'}` }, name);
}
function progress(h, n, kind = 'bar') {
  const pct = Math.max(0, Math.min(1, n));
  if (kind === 'ring') {
    const deg = Math.round(pct * 360);
    return h('span', { class: 'db-ring', style: `--deg:${deg}deg`, title: formatNumber(n, 'percent') });
  }
  return h('span', { class: 'db-bar', title: formatNumber(n, 'percent') }, h('span', { class: 'db-bar-fill', style: `width:${pct * 100}%` }));
}
/** Read-only display of a rollup / formula value. */
function computedEl(h, prop, v) {
  if (v == null || (Array.isArray(v) && !v.length)) return h('span', { class: 'db-empty' }, '');
  if (typeof v === 'boolean') return h('span', { class: 'db-readonly' }, v ? '☑' : '☐');
  if (typeof v === 'number') {
    const text = formatNumber(v, prop.format);
    if (prop.display === 'bar' || prop.display === 'ring') return h('span', { class: 'db-progress' }, progress(h, prop.format === 'percent' || v <= 1 ? v : v / 100, prop.display), h('span', { class: 'db-readonly' }, text));
    return h('span', { class: 'db-readonly num' }, text);
  }
  if (typeof v === 'object' && !Array.isArray(v)) return h('span', { class: 'db-readonly' }, fmtRange(v));
  if (Array.isArray(v)) return h('span', { class: 'db-chips static' }, v.slice(0, 20).map((x) => chip(h, valueToText(x), 'gray')));
  return h('span', { class: 'db-readonly wrap' }, String(v));
}

/**
 * An editable value. ctx: { h, db, members, related, save(row, prop, value), deps, thisPage }.
 * `row` is { id, title, props }.
 */
function valueCell(ctx, row, prop, { compact = false } = {}) {
  const { h, members, deps } = ctx;
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
    case 'number': {
      // formatted text; becomes an input on click
      const shown = h('button', { class: 'db-num', type: 'button' }, v == null ? h('span', { class: 'db-empty' }, compact ? '' : 'Empty') : prop.display === 'bar' || prop.display === 'ring' ? [progress(h, prop.format === 'percent' || v <= 1 ? v : v / 100, prop.display), formatNumber(v, prop.format)] : formatNumber(v, prop.format));
      shown.addEventListener('click', (e) => {
        e.stopPropagation();
        const el = input('number', v ?? '', (x) => (x === '' ? null : Number(x)));
        el.step = 'any';
        el.addEventListener('blur', () => setTimeout(() => el.isConnected && el.replaceWith(shown), 0));
        shown.replaceWith(el);
        el.focus();
      });
      return shown;
    }
    case 'checkbox': {
      const el = h('input', { type: 'checkbox', class: 'db-check' });
      el.checked = !!v;
      el.addEventListener('change', () => commit(el.checked));
      return el;
    }
    case 'date': {
      const el = h('button', { class: 'db-date', type: 'button' }, v ? fmtRange(v) : h('span', { class: 'db-empty' }, compact ? '' : 'Empty'));
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        dateEditor(ctx, el, row, prop);
      });
      return el;
    }
    case 'select':
    case 'status':
    case 'multi_select':
    case 'person': {
      const ids = prop.type === 'select' || prop.type === 'status' ? (v ? [v] : []) : v || [];
      const shown = ids.map((id) => {
        if (prop.type === 'person') {
          const m = members.find((x) => x.id === id);
          return h('span', { class: 'db-person' }, deps.avatar(m || { name: '?', color: '#999' }, 'tiny'), m?.name || 'Former member', m?.kind === 'agent' ? h('span', { class: 'db-agent-tag' }, 'AI') : null);
        }
        const o = prop.options.find((x) => x.id === id);
        if (!o) return null;
        return prop.type === 'status' ? h('span', { class: `db-chip db-status opt-${o.color || 'gray'}` }, h('span', { class: `db-status-dot g-${o.group}` }), o.name) : chip(h, o.name, o.color);
      });
      const el = h('button', { class: `db-chips${compact ? ' compact' : ''}`, type: 'button' }, ...shown);
      if (!ids.length) el.append(h('span', { class: 'db-empty' }, compact ? '' : 'Empty'));
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        optionPicker(ctx, el, row, prop);
      });
      return el;
    }
    case 'relation': {
      const ids = v || [];
      const rel = ctx.related?.[prop.databaseId];
      const title = (id) => rel?.rows.find((r) => r.id === id);
      const el = h(
        'div',
        { class: `db-chips${compact ? ' compact' : ''}`, role: 'button', tabindex: '0' },
        ids.map((id) => {
          const r = title(id);
          return h('a', { class: 'db-rel', href: `#/${id}`, onclick: (e) => (e.preventDefault(), e.stopPropagation(), deps.go(id)) }, r?.icon || '📄', ' ', r ? r.title || 'Untitled' : 'Unavailable');
        }),
      );
      if (!ids.length) el.append(h('span', { class: 'db-empty' }, compact ? '' : 'Empty'));
      el.addEventListener('click', (e) => {
        if (e.target.closest('a')) return;
        e.stopPropagation();
        relationPicker(ctx, el, row, prop);
      });
      return el;
    }
    case 'files':
    case 'links': {
      const list = v || [];
      const el = h(
        'div',
        { class: `db-chips db-files${compact ? ' compact' : ''}`, role: 'button', tabindex: '0' },
        list.map((f) =>
          prop.type === 'files' && (f.thumbnail || /\.(png|jpe?g|gif|webp|svg|avif)(\?|$)/i.test(f.url)) && compact
            ? h('a', { class: 'db-thumb', href: f.url, target: '_blank', rel: 'noopener', title: f.name || f.url, onclick: (e) => e.stopPropagation() }, h('img', { src: f.thumbnail || f.url, alt: f.name || '', loading: 'lazy', decoding: 'async' }))
            : h('a', { class: 'db-file', href: f.url, target: '_blank', rel: 'noopener', title: f.url, onclick: (e) => e.stopPropagation() }, prop.type === 'files' ? '📎 ' : '🔗 ', f.name || f.label || f.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 40)),
        ),
      );
      if (!list.length) el.append(h('span', { class: 'db-empty' }, compact ? '' : 'Empty'));
      el.addEventListener('click', (e) => {
        if (e.target.closest('a')) return;
        e.stopPropagation();
        filesEditor(ctx, el, row, prop);
      });
      return el;
    }
    case 'rollup':
    case 'formula':
      return computedEl(h, prop, v);
    case 'unique_id':
      return h('span', { class: 'db-readonly' }, uniqueIdText(prop, v) ?? '');
    case 'blocked':
      return v ? h('span', { class: 'db-blocked' }, '⛔ Blocked') : h('span', { class: 'db-empty' }, '');
    case 'created_time':
    case 'last_edited_time':
      return h('span', { class: 'db-readonly' }, v ? new Date(v).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');
    default:
      return h('span', {}, String(displayValue(prop, v, members) ?? ''));
  }
}

/** Pick select / status / multi-select options or people; typing a new name creates an option. */
function optionPicker(ctx, anchor, row, prop) {
  const { h, members, deps } = ctx;
  const single = prop.type === 'select' || prop.type === 'status';
  const multi = !single;
  let current = single ? (rawValue(row, prop) ? [rawValue(row, prop)] : []) : [...(rawValue(row, prop) || [])];
  const search = h('input', { class: 'pop-input', placeholder: prop.type === 'person' ? 'Search people…' : 'Search or create an option…' });
  const list = h('div', { class: 'db-opt-list' });
  const choices = () =>
    prop.type === 'person' ? members.map((m) => ({ id: m.id, name: m.name, color: m.color, member: m })) : prop.options.map((o) => ({ id: o.id, name: o.name, color: o.color, group: o.group }));
  const apply = (next) => {
    current = next;
    ctx.save(row, prop, single ? next[0] ?? null : next);
  };
  const item = (c) =>
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
      c.member ? h('span', { class: 'db-person' }, deps.avatar(c.member, 'tiny'), c.name, c.member.kind === 'agent' ? h('span', { class: 'db-agent-tag' }, 'AI') : null) : chip(h, c.name, c.color),
    );
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const items = choices().filter((c) => !q || c.name.toLowerCase().includes(q));
    if (prop.type === 'status') {
      list.replaceChildren(
        ...STATUS_GROUPS.flatMap((g) => {
          const mine = items.filter((c) => c.group === g.id);
          return mine.length ? [h('div', { class: 'pop-label' }, g.name), ...mine.map(item)] : [];
        }),
      );
    } else list.replaceChildren(...items.map(item));
    if (q && prop.type !== 'person' && !choices().some((c) => c.name.toLowerCase() === q)) {
      list.append(
        h(
          'button',
          {
            class: 'menu-item compact',
            onclick: () => {
              const name = search.value.trim();
              // the server adds the option; send its name
              ctx.save(row, prop, single ? name : [...current.map((id) => prop.options.find((o) => o.id === id)?.name || id), name]);
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

/** Link items of the related database. */
function relationPicker(ctx, anchor, row, prop) {
  const { h, deps } = ctx;
  const rel = ctx.related?.[prop.databaseId];
  if (!rel) return deps.toast('The related database is not available');
  let current = [...(rawValue(row, prop) || [])];
  const search = h('input', { class: 'pop-input', placeholder: `Link to ${rel.title || 'an item'}…` });
  const list = h('div', { class: 'db-opt-list' });
  const apply = (next) => {
    current = prop.limit === 1 ? next.slice(-1) : next;
    ctx.save(row, prop, current);
  };
  const draw = () => {
    const q = search.value.trim().toLowerCase();
    const rows = rel.rows.filter((r) => r.id !== row.id || prop.databaseId !== ctx.dbId).filter((r) => !q || (r.title || '').toLowerCase().includes(q));
    rows.sort((a, b) => Number(current.includes(b.id)) - Number(current.includes(a.id)));
    list.replaceChildren(
      ...rows.slice(0, 100).map((r) =>
        h(
          'button',
          {
            class: `menu-item compact${current.includes(r.id) ? ' active' : ''}`,
            onclick: () => {
              apply(current.includes(r.id) ? current.filter((x) => x !== r.id) : [...current, r.id]);
              if (prop.limit === 1) deps.closePop();
              else draw();
            },
          },
          h('span', { class: 'mi-icon' }, current.includes(r.id) ? '✓' : ''),
          h('span', { class: 'db-rel-name' }, r.icon || '📄', ' ', r.title || 'Untitled'),
        ),
      ),
    );
    if (!rows.length) list.append(h('div', { class: 'empty-note' }, 'No matching items'));
  };
  search.addEventListener('input', draw);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      list.querySelector('.menu-item')?.click();
    }
    if (e.key === 'Escape') deps.closePop();
  });
  deps.openPop(anchor, [h('div', { class: 'pop-label' }, `${prop.name} → ${rel.title || 'Untitled'}${prop.limit === 1 ? ' (one item)' : ''}`), search, list], { width: 300 });
  draw();
}

/** Start / end / time editor for date values. */
function dateEditor(ctx, anchor, row, prop) {
  const { h, deps } = ctx;
  const v = rawValue(row, prop) || null;
  let withTime = !!(v && hasTime(v.start));
  let withEnd = !!v?.end;
  const toInput = (s) => {
    if (!s) return '';
    if (!withTime) return dayOf(s);
    const d = toLocal(s);
    return `${localYmd(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const fromInput = (x) => (!x ? null : withTime ? new Date(x).toISOString() : x);
  const body = h('div', { class: 'db-editor' });
  let start = v?.start || null;
  let end = v?.end || null;
  const save = () => {
    if (!start) return ctx.save(row, prop, null);
    if (end && toLocal(end) < toLocal(start)) end = null;
    ctx.save(row, prop, { start, end: withEnd ? end : null });
  };
  const draw = () => {
    const s = h('input', { class: 'db-input boxed', type: withTime ? 'datetime-local' : 'date', value: toInput(start) });
    s.addEventListener('change', () => {
      start = fromInput(s.value);
      save();
    });
    const e = h('input', { class: 'db-input boxed', type: withTime ? 'datetime-local' : 'date', value: toInput(end) });
    e.addEventListener('change', () => {
      end = fromInput(e.value);
      save();
    });
    const endBox = h('input', { type: 'checkbox' });
    endBox.checked = withEnd;
    endBox.addEventListener('change', () => {
      withEnd = endBox.checked;
      if (!withEnd) end = null;
      else if (!end && start) end = start;
      save();
      draw();
    });
    const timeBox = h('input', { type: 'checkbox' });
    timeBox.checked = withTime;
    timeBox.addEventListener('change', () => {
      withTime = timeBox.checked;
      const conv = (x) => (!x ? x : withTime ? toLocal(x).toISOString() : dayOf(x));
      start = conv(start);
      end = conv(end);
      save();
      draw();
    });
    body.replaceChildren(
      ...[
      h('div', { class: 'db-editor-row' }, h('span', { class: 'sub w60' }, 'Start'), s),
      withEnd ? h('div', { class: 'db-editor-row' }, h('span', { class: 'sub w60' }, 'End'), e) : null,
      h('label', { class: 'db-vis-row' }, endBox, 'End date'),
      h('label', { class: 'db-vis-row' }, timeBox, 'Include time'),
      withTime ? h('div', { class: 'sub small' }, `Times are in your time zone (${Intl.DateTimeFormat().resolvedOptions().timeZone}).`) : null,
      start ? h('button', { class: 'menu-item compact', onclick: () => ((start = null), save(), deps.closePop()) }, h('span', { class: 'mi-icon' }, '✕'), 'Clear') : null,
      ].filter(Boolean),
    );
  };
  draw();
  deps.openPop(anchor, [h('div', { class: 'pop-label' }, prop.name), body], { width: 300 });
}

/** Files (upload or URL) and links (label + URL). */
function filesEditor(ctx, anchor, row, prop) {
  const { h, deps } = ctx;
  const files = prop.type === 'files';
  let list = [...(rawValue(row, prop) || [])];
  const body = h('div', { class: 'db-editor' });
  const save = () => ctx.save(row, prop, list);
  const draw = () => {
    const label = h('input', { class: 'db-input boxed', placeholder: files ? 'Name (optional)' : 'Label (optional)' });
    const url = h('input', { class: 'db-input boxed', placeholder: 'https://…' });
    const add = () => {
      const u = url.value.trim();
      if (!u) return;
      list = [...list, files ? { name: label.value.trim() || undefined, url: u } : { label: label.value.trim() || undefined, url: u }];
      save();
      draw();
    };
    url.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), add()));
    const upload = files
      ? (() => {
          const inp = h('input', { type: 'file', multiple: true, hidden: true });
          inp.addEventListener('change', async () => {
            for (const f of inp.files) {
              try {
                deps.toast(`Uploading ${f.name}…`);
                const r = await deps.upload(f);
                list = [...list, { name: r.name, url: r.url, ...(r.thumbnail ? { thumbnail: r.thumbnail } : {}), storageId: r.storageId }];
                save();
                draw();
              } catch (err) {
                deps.toast(err.message);
              }
            }
          });
          return h('button', { class: 'btn', onclick: () => inp.click() }, '⬆ Upload', inp);
        })()
      : null;
    body.replaceChildren(
      ...[
      ...list.map((f, i) =>
        h(
          'div',
          { class: 'db-editor-row' },
          files && (f.thumbnail || /\.(png|jpe?g|gif|webp|svg|avif)(\?|$)/i.test(f.url)) ? h('img', { class: 'db-thumb-sm', src: f.thumbnail || f.url, alt: '', loading: 'lazy' }) : h('span', { class: 'mi-icon' }, files ? '📎' : '🔗'),
          h('a', { class: 'grow db-file-name', href: f.url, target: '_blank', rel: 'noopener' }, f.name || f.label || f.url),
          h('button', { class: 'icon-btn small', title: 'Remove', onclick: () => ((list = list.filter((_, j) => j !== i)), save(), draw()) }, '✕'),
        ),
      ),
      list.length ? h('div', { class: 'menu-sep' }) : null,
      h('div', { class: 'db-editor-row' }, label),
      h('div', { class: 'db-editor-row' }, url, h('button', { class: 'btn', onclick: add }, 'Add')),
      upload ? h('div', { class: 'db-editor-row' }, upload, h('span', { class: 'sub small' }, 'Up to 20 MB each')) : null,
      ].filter(Boolean),
    );
  };
  draw();
  deps.openPop(anchor, [h('div', { class: 'pop-label' }, prop.name), body], { width: 360 });
}

// ---------------------------------------------------------------------------
// Database view (tabs, toolbar, layouts)
// ---------------------------------------------------------------------------
/**
 * opts.linked: { view, onChange(view), onRemove(), thisPage: { id, title } } — show the database inside
 * another page with one view whose settings belong to that page's block, not to the database.
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
  const expanded = new Set(); // rows whose sub-items are shown
  let calMonth = null; // first day of the month a calendar shows
  const zoomKey = (v) => `dbzoom:${pageId}:${v.id}`;

  const unsub = deps.watch(deps.cx.pages.rows, { ...deps.ws(), pageId }, (d) => {
    data = d;
    if (el.contains(document.activeElement) && document.activeElement.matches('input, textarea')) pending = true;
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
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    if (next.type === 'board' && !next.groupBy) next.groupBy = (data.database.properties.find((p) => p.type === 'status' || p.type === 'select') || data.database.properties.find((p) => GROUPABLE.includes(p.type)))?.id || null;
    if (['calendar', 'timeline'].includes(next.type) && !next.dateProperty) next.dateProperty = data.database.properties.find((p) => p.type === 'date')?.id;
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
  function valueCtx() {
    return { members: data.members, me: deps.me()?.id, titleOf: (id) => titleIndex().get(id), thisPage: linked?.thisPage || null };
  }
  let titles = null;
  function titleIndex() {
    if (titles?.data === data) return titles.map;
    const map = new Map();
    for (const r of Object.values(data.related || {})) for (const x of r?.rows || []) map.set(x.id, x.title || 'Untitled');
    for (const x of data.rows) map.set(x.id, x.title || 'Untitled');
    titles = { data, map };
    return map;
  }
  function ctx() {
    return { h, db: data.database, dbId: pageId, members: data.members, related: { ...(data.related || {}), [pageId]: { id: pageId, title: data.title, rows: data.rows.map((r) => ({ id: r.id, title: r.title, icon: r.icon })) } }, save, deps, thisPage: linked?.thisPage || null };
  }
  /** Values that make a new row show up in the current (filtered) view. */
  function defaultsFor(view) {
    const out = {};
    for (const f of view.filters || []) {
      if (f.or || f.and || f.value == null) continue;
      const prop = data.database.properties.find((p) => p.id === f.property);
      if (!prop) continue;
      let value = f.value;
      if (value === THIS_PAGE) {
        if (!linked?.thisPage) continue;
        value = prop.type === 'relation' ? linked.thisPage.id : linked.thisPage.title;
      }
      if (f.operator === 'in_group' && prop.type === 'status') {
        const o = prop.options.find((x) => x.group === f.value);
        if (o) out[prop.id] = o.id;
        continue;
      }
      if (f.operator === 'equals' && ['select', 'status', 'checkbox', 'text'].includes(prop.type)) out[prop.id] = value;
      else if (f.operator === 'contains' && ['multi_select', 'person'].includes(prop.type)) out[prop.id] = [value];
      else if (['contains', 'equals'].includes(f.operator) && prop.type === 'relation') out[prop.id] = [value];
    }
    return out;
  }
  async function newRow(extra = {}, template) {
    const view = currentView();
    const item = { title: '', properties: { ...defaultsFor(view), ...extra } };
    if (template !== undefined) item.template = template;
    const r = await write('createRows', { items: [item] });
    if (r?.results?.[0]?.id) focusRow = r.results[0].id;
    if (r?.failed) deps.toast(r.results[0].error);
    focusNewRow(); // the row may already be drawn (the subscription can beat the mutation's reply)
  }
  function focusNewRow() {
    if (!focusRow) return;
    const t = el.querySelector(`[data-row="${CSS.escape(focusRow)}"] .db-title-input, .db-card[data-row="${CSS.escape(focusRow)}"], .db-list-row[data-row="${CSS.escape(focusRow)}"], .db-cal-item[data-row="${CSS.escape(focusRow)}"], .db-tl-row[data-row="${CSS.escape(focusRow)}"]`);
    if (!t) return;
    focusRow = null;
    if (t.matches('input')) t.focus();
    else deps.go(t.dataset.row); // open the new item's page to name it
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
    let rows = [];
    try {
      rows = applyView(data.database, data.rows, { filters: view.filters, sorts: view.sorts, search }, valueCtx());
    } catch (err) {
      deps.toast(err.message);
      rows = data.rows;
    }
    const layouts = { table, board, list, gallery, calendar, timeline };
    let body;
    try {
      body = (layouts[view.type] || table)(view, rows);
    } catch (err) {
      body = h('div', { class: 'db-empty-view' }, err.message);
    }
    el.replaceChildren(toolbar(view, rows.length), body);
    focusNewRow();
  }

  // ---------- toolbar ----------
  function toolbar(view, count) {
    const tabs = linked
      ? h(
          'div',
          { class: 'db-tabs linked' },
          h('button', { class: 'db-linked-title', title: 'View options', onclick: (e) => viewMenu(e.currentTarget, view) }, h('span', { class: 'db-tab-icon' }, VIEW_ICON[view.type] || '▤'), view.name || data.database.title || 'Untitled'),
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
              h('span', { class: 'db-tab-icon' }, VIEW_ICON[v.type] || '▤'),
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
    const templates = data.database.templates || [];
    const actions = h(
      'div',
      { class: 'db-actions' },
      h('span', { class: 'db-count' }, `${count} ${count === 1 ? 'item' : 'items'}`),
      h('button', { class: `db-btn${nFilters ? ' on' : ''}`, onclick: (e) => filterEditor(e.currentTarget) }, nFilters ? `Filter · ${nFilters}` : 'Filter'),
      h('button', { class: `db-btn${nSorts ? ' on' : ''}`, onclick: (e) => sortEditor(e.currentTarget) }, nSorts ? `Sort · ${nSorts}` : 'Sort'),
      searchEl,
      h('span', { class: 'db-new' }, h('button', { class: 'btn primary small', onclick: () => newRow() }, 'New'), h('button', { class: 'btn primary small db-new-more', title: 'Templates', onclick: (e) => templateMenu(e.currentTarget) }, '▾')),
    );
    if (!templates.length) actions.querySelector('.db-new-more').title = 'New item from a template';
    return h('div', { class: 'db-toolbar' }, tabs, actions);
  }

  function templateMenu(anchor) {
    const templates = data.database.templates || [];
    deps.menu(anchor, [
      { label: 'New item' },
      { icon: '📄', name: 'Empty item', run: () => newRow({}, 'none') },
      ...templates.map((t) => ({ icon: '📋', name: t.name + (t.isDefault ? '  · default' : ''), run: () => newRow({}, t.id) })),
      templates.length ? '-' : null,
      ...templates.map((t) => ({
        icon: '⚙',
        name: `${t.name}…`,
        run: () =>
          deps.menu(anchor, [
            { label: t.name },
            { icon: '★', name: t.isDefault ? 'Stop using as default' : 'Use for every new item', run: () => write('saveTemplate', { templateId: t.id, isDefault: !t.isDefault }) },
            { icon: '✎', name: 'Rename', run: () => deps.askInput(anchor, 'Template name', t.name, (name) => write('saveTemplate', { templateId: t.id, name })) },
            { icon: '🗑', name: 'Delete template', danger: true, run: () => confirm(`Delete the template "${t.name}"?`) && write('saveTemplate', { templateId: t.id, remove: true }) },
          ]),
      })),
      !templates.length ? { label: 'To make a template, open an item and choose “Save as template”.' } : null,
    ]);
  }

  function addViewMenu(anchor) {
    const add = (type) => {
      const has = (t) => data.database.properties.some((p) => t.includes(p.type));
      if (type === 'board' && !has(GROUPABLE)) return deps.toast('Add a Status, Select, Person or Checkbox property to group a board by');
      if ((type === 'calendar' || type === 'timeline') && !has(['date'])) return deps.toast(`Add a Date property for a ${type}`);
      write('saveView', { type, name: VIEW_NAME[type] }).then((v) => v && ((viewId = v.id), localStorage.setItem(viewKey, v.id)));
    };
    deps.menu(
      anchor,
      Object.keys(VIEW_NAME).map((t) => ({ icon: VIEW_ICON[t], name: VIEW_NAME[t], run: () => add(t) })),
    );
  }

  function viewMenu(anchor, v) {
    const db = data.database;
    const groupable = db.properties.filter((p) => GROUPABLE.includes(p.type));
    const dates = db.properties.filter((p) => p.type === 'date');
    const filesProps = db.properties.filter((p) => p.type === 'files');
    deps.menu(anchor, [
      { label: v.name },
      { icon: '✎', name: 'Rename', run: () => deps.askInput(anchor, 'View name', v.name, (name) => saveView({ name })) },
      {
        icon: VIEW_ICON[v.type],
        name: `Layout: ${VIEW_NAME[v.type]}`,
        run: () =>
          deps.menu(
            anchor,
            Object.keys(VIEW_NAME).map((t) => ({
              icon: VIEW_ICON[t],
              name: VIEW_NAME[t] + (t === v.type ? '  ✓' : ''),
              run: () => {
                if (t === 'board' && !groupable.length) return deps.toast('Add a Status, Select, Person or Checkbox property first');
                if ((t === 'calendar' || t === 'timeline') && !dates.length) return deps.toast('Add a Date property first');
                saveView({ type: t });
              },
            })),
          ),
      },
      v.type === 'board' ? { icon: '⇶', name: 'Group by…', run: () => deps.menu(anchor, groupable.map((p) => ({ icon: TYPE_ICON[p.type], name: p.name + (p.id === v.groupBy ? '  ✓' : ''), run: () => saveView({ groupBy: p.id }) }))) } : null,
      ['calendar', 'timeline'].includes(v.type) ? { icon: '📅', name: 'Date property…', run: () => deps.menu(anchor, dates.map((p) => ({ icon: '📅', name: p.name + (p.id === v.dateProperty ? '  ✓' : ''), run: () => saveView({ dateProperty: p.id }) }))) } : null,
      v.type === 'timeline'
        ? {
            icon: '⇥',
            name: 'End date…',
            run: () =>
              deps.menu(anchor, [
                { icon: '↔', name: `Range end of the date${!v.endProperty ? '  ✓' : ''}`, run: () => saveView({ endProperty: null }) },
                ...dates.filter((p) => p.id !== v.dateProperty).map((p) => ({ icon: '📅', name: p.name + (p.id === v.endProperty ? '  ✓' : ''), run: () => saveView({ endProperty: p.id }) })),
              ]),
          }
        : null,
      v.type === 'gallery'
        ? {
            icon: '🖼',
            name: 'Card image…',
            run: () =>
              deps.menu(anchor, [
                { icon: '📄', name: `First image in the item${!v.coverProperty || v.coverProperty === 'content' ? '  ✓' : ''}`, run: () => saveView({ coverProperty: 'content' }) },
                ...filesProps.map((p) => ({ icon: '📎', name: p.name + (p.id === v.coverProperty ? '  ✓' : ''), run: () => saveView({ coverProperty: p.id }) })),
                { icon: '∅', name: `No image${v.coverProperty === 'none' ? '  ✓' : ''}`, run: () => saveView({ coverProperty: 'none' }) },
              ]),
          }
        : null,
      v.type === 'gallery' ? { icon: '⤢', name: 'Card size…', run: () => deps.menu(anchor, ['small', 'medium', 'large'].map((s) => ({ icon: '▦', name: s[0].toUpperCase() + s.slice(1) + ((v.cardSize || 'medium') === s ? '  ✓' : ''), run: () => saveView({ cardSize: s }) }))) } : null,
      v.type === 'table' && db.subItems ? { icon: '↳', name: v.showSubItems === false ? 'Nest sub-items' : 'Show sub-items flat', run: () => saveView({ showSubItems: v.showSubItems === false }) } : null,
      { icon: '☷', name: 'Properties…', run: () => visibilityEditor(anchor, v) },
      linked ? { icon: '↗', name: 'Open source database', run: () => deps.go(pageId) } : null,
      '-',
      linked ? { icon: '🗑', name: 'Remove from this page', danger: true, run: () => linked.onRemove() } : null,
      !linked && db.views.length > 1 ? { icon: '🗑', name: 'Delete view', danger: true, run: () => write('saveView', { viewId: v.id, remove: true }) } : null,
    ]);
  }

  function propsList(withPseudo = true) {
    const db = data.database;
    return withPseudo ? allProps(db) : [titleProp(db), ...db.properties];
  }

  function visibilityEditor(anchor, v) {
    const all = propsList();
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
    const thisPageOpt = linked ? h('option', { value: THIS_PAGE, selected: value === THIS_PAGE ? true : null }, '◎ This page') : null;
    if (['select', 'multi_select', 'status'].includes(prop.type)) {
      const s = h('select', { class: 'db-select' }, h('option', { value: '' }, '—'), thisPageOpt, prop.options.map((o) => h('option', { value: o.name, selected: o.name === value || o.id === value ? true : null }, o.name)));
      s.addEventListener('change', () => onChange(s.value));
      return s;
    }
    if (prop.type === 'relation') {
      const rel = data.related?.[prop.databaseId] || (prop.databaseId === pageId ? { rows: data.rows } : null);
      const s = h('select', { class: 'db-select' }, h('option', { value: '' }, '—'), thisPageOpt, (rel?.rows || []).map((r) => h('option', { value: r.id, selected: r.id === value || r.title === value ? true : null }, r.title || 'Untitled')));
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
    if (prop.type === 'checkbox' || prop.type === 'blocked') {
      const s = h('select', { class: 'db-select' }, h('option', { value: 'true', selected: value === true || value === 'true' ? true : null }, 'Checked'), h('option', { value: 'false', selected: value === false || value === 'false' ? true : null }, 'Unchecked'));
      s.addEventListener('change', () => onChange(s.value === 'true'));
      if (value == null) queueMicrotask(() => onChange(true));
      return s;
    }
    const isDate = ['date', 'created_time', 'last_edited_time'].includes(prop.type);
    const i = h('input', { class: 'db-input boxed', value: value === THIS_PAGE ? '' : value ?? '', placeholder: isDate ? 'YYYY-MM-DD, today, +7d' : linked && ['text', 'title'].includes(prop.type) ? 'Value, or @this_page' : 'Value' });
    i.addEventListener('change', () => onChange(['number', 'unique_id'].includes(prop.type) ? Number(i.value) : i.value));
    return i;
  }

  function filterEditor(anchor) {
    const view = currentView();
    let filters = structuredClone(view.filters || []);
    const all = propsList();
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
          if (['in_group', 'not_in_group'].includes(f.operator)) f.value = 'complete';
          commit();
          draw();
        });
        let val;
        if (['is_empty', 'is_not_empty'].includes(f.operator)) val = h('span', { class: 'grow' });
        else if (['in_group', 'not_in_group'].includes(f.operator)) {
          val = h('select', { class: 'db-select' }, STATUS_GROUPS.map((g) => h('option', { value: g.id, selected: g.id === f.value ? true : null }, g.name)));
          val.addEventListener('change', () => ((f.value = val.value), commit()));
        } else
          val = valueControl(prop, f.value, (value) => {
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
    deps.openPop(anchor, [h('div', { class: 'pop-label' }, `Filters · ${view.name}`), body], { width: 540 });
  }

  function sortEditor(anchor) {
    const view = currentView();
    let sorts = structuredClone(view.sorts || []);
    const all = propsList();
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
    const area = h('div');
    const create = (spec) => {
      deps.closePop();
      updateDb({ addProperties: [{ name: name.value.trim() || TYPE_NAME[spec.type], ...spec }] });
    };
    const types = h(
      'div',
      { class: 'db-opt-list' },
      PROPERTY_TYPES.map((t) =>
        h(
          'button',
          {
            class: 'menu-item compact',
            onclick: () => {
              if (['relation', 'rollup', 'formula', 'unique_id'].includes(t)) area.replaceChildren(configForm(t, null, create));
              else create({ type: t });
            },
          },
          h('span', { class: 'mi-icon' }, TYPE_ICON[t]),
          TYPE_NAME[t],
        ),
      ),
    );
    area.append(h('div', { class: 'pop-label' }, 'Type'), types);
    deps.openPop(anchor, [name, area], { width: 300 });
    name.focus();
  }

  /** Settings form for relation / rollup / formula / unique id properties (new or existing). */
  function configForm(type, prop, done) {
    const db = data.database;
    const form = h('div', { class: 'db-editor' });
    const row = (label, ...ctl) => h('div', { class: 'db-editor-row' }, h('span', { class: 'sub w90' }, label), ...ctl);
    if (type === 'relation') {
      const dbs = deps.databases().filter((d) => d.id !== pageId);
      const target = h('select', { class: 'db-select wide' }, h('option', { value: 'self' }, `This database (${data.title || 'Untitled'})`), dbs.map((d) => h('option', { value: d.id }, d.title || 'Untitled')));
      const two = h('input', { type: 'checkbox', checked: true });
      const one = h('input', { type: 'checkbox' });
      const rname = h('input', { class: 'db-input boxed', placeholder: `Name on the other side (default: ${data.title || 'Related'})` });
      form.append(
        row('Link to', target),
        h('label', { class: 'db-vis-row' }, two, 'Show on the other database too (two-way)'),
        row('', rname),
        h('label', { class: 'db-vis-row' }, one, 'Only one item'),
        h('button', { class: 'btn primary', onclick: () => done({ type, databaseId: target.value, twoWay: two.checked, reverseName: rname.value.trim() || undefined, limit: one.checked ? 1 : undefined }) }, 'Create relation'),
      );
    }
    if (type === 'rollup') {
      const rels = db.properties.filter((p) => p.type === 'relation');
      if (!rels.length) return h('div', { class: 'empty-note' }, 'A rollup summarizes related items. Add a Relation property first.');
      const relSel = h('select', { class: 'db-select wide' }, rels.map((p) => h('option', { value: p.id, selected: prop?.relation === p.id ? true : null }, p.name)));
      const propSel = h('select', { class: 'db-select wide' });
      const fnSel = h('select', { class: 'db-select wide' }, ROLLUP_FUNCTIONS.map((f) => h('option', { value: f, selected: (prop?.function || 'count') === f ? true : null }, FN_NAME[f])));
      const value = h('input', { class: 'db-input boxed', placeholder: 'Value, e.g. Done or @complete', value: prop?.value || '' });
      const display = h('select', { class: 'db-select wide' }, h('option', { value: '' }, 'Number'), h('option', { value: 'bar', selected: prop?.display === 'bar' ? true : null }, 'Progress bar'), h('option', { value: 'ring', selected: prop?.display === 'ring' ? true : null }, 'Ring'));
      const loadTargets = async () => {
        const rel = db.properties.find((p) => p.id === relSel.value);
        propSel.replaceChildren(h('option', {}, 'Loading…'));
        const t = rel.databaseId === pageId ? data : await deps.databaseSchema(rel.databaseId);
        const list = t ? [titleProp(t.database), ...t.database.properties] : [];
        propSel.replaceChildren(...list.map((p) => h('option', { value: p.id, selected: prop?.target === p.id ? true : null }, `${TYPE_ICON[p.type] || ''} ${p.name}`)));
      };
      relSel.addEventListener('change', loadTargets);
      const where = () => (value.hidden = !['count_where', 'percent_where'].includes(fnSel.value));
      fnSel.addEventListener('change', where);
      loadTargets();
      where();
      form.append(
        row('Relation', relSel),
        row('Property', propSel),
        row('Calculate', fnSel),
        row('', value),
        row('Show as', display),
        h('button', { class: 'btn primary', onclick: () => done({ type, relation: relSel.value, property: propSel.value, function: fnSel.value, value: value.hidden ? undefined : value.value.trim(), display: display.value || null }) }, prop ? 'Save' : 'Create rollup'),
      );
    }
    if (type === 'formula') {
      const expr = h('textarea', { class: 'db-formula', rows: 4, placeholder: 'prop("Scenes illustrated") / prop("Scenes")' });
      expr.value = prop?.expressionText || '';
      const fmt = h('select', { class: 'db-select wide' }, h('option', { value: '' }, 'Automatic'), NUMBER_FORMATS.map((f) => h('option', { value: f, selected: prop?.format === f ? true : null }, FORMAT_NAME[f])));
      const display = h('select', { class: 'db-select wide' }, h('option', { value: '' }, 'Value'), h('option', { value: 'bar', selected: prop?.display === 'bar' ? true : null }, 'Progress bar'), h('option', { value: 'ring', selected: prop?.display === 'ring' ? true : null }, 'Ring'));
      const names = h('div', { class: 'db-formula-props' }, [titleProp(db), ...db.properties].filter((p) => p.id !== prop?.id).map((p) => h('button', { class: 'db-chip opt-gray', onclick: () => insertAtCursor(expr, `prop("${p.name}")`) }, p.name)));
      form.append(
        expr,
        names,
        h('div', { class: 'sub small' }, 'Functions: if, concat, round, min, max, sum, dateBetween(a, b, "days"), dateAdd, formatDate, now, today, contains, length, empty, and, or, not.'),
        row('Number format', fmt),
        row('Show as', display),
        h('button', { class: 'btn primary', onclick: () => done({ type, expression: expr.value, format: fmt.value || null, display: display.value || null }) }, prop ? 'Save' : 'Create formula'),
      );
      setTimeout(() => expr.focus(), 0);
    }
    if (type === 'unique_id') {
      const prefix = h('input', { class: 'db-input boxed', placeholder: 'Prefix, e.g. E', value: prop?.prefix || '' });
      form.append(row('Prefix', prefix), h('div', { class: 'sub small' }, 'Every item gets a number that never changes: E-1, E-2, …'), h('button', { class: 'btn primary', onclick: () => done({ type, prefix: prefix.value.trim() }) }, prop ? 'Save' : 'Create ID'));
    }
    return form;
  }
  function insertAtCursor(ta, text) {
    const s = ta.selectionStart ?? ta.value.length;
    ta.value = ta.value.slice(0, s) + text + ta.value.slice(ta.selectionEnd ?? s);
    ta.focus();
    ta.selectionStart = ta.selectionEnd = s + text.length;
  }

  function headerMenu(anchor, prop) {
    const isTitle = prop.type === 'title';
    const isPseudo = ['created_time', 'last_edited_time', 'blocked'].includes(prop.type);
    // sub-items and dependencies are fixed pairs of self-relations
    const structural = (p) => {
      const d = data.database;
      return [d.subItems?.children, d.subItems?.parent, d.dependencies?.blockedBy, d.dependencies?.blocking].includes(p.id);
    };
    const simple = PROPERTY_TYPES.filter((t) => !['relation', 'rollup', 'formula'].includes(t));
    const editSettings = (type) => {
      const form = configForm(type, prop.type === 'formula' ? { ...prop, expressionText: expressionOf(prop) } : prop, (spec) => {
        deps.closePop();
        const u = { property: prop.id };
        if (type === 'formula') Object.assign(u, { expression: spec.expression, format: spec.format, display: spec.display });
        if (type === 'rollup') Object.assign(u, { relation: spec.relation, rollupProperty: spec.property, function: spec.function, value: spec.value, display: spec.display });
        if (type === 'unique_id') u.prefix = spec.prefix;
        updateDb({ updateProperties: [u] });
      });
      deps.openPop(anchor, [h('div', { class: 'pop-label' }, prop.name), form], { width: 360 });
    };
    deps.menu(anchor, [
      { label: prop.name },
      !isPseudo ? { icon: '✎', name: 'Rename', run: () => deps.askInput(anchor, 'Property name', prop.name, (n) => updateDb(isTitle ? { titleName: n } : { updateProperties: [{ property: prop.id, name: n }] })) } : null,
      prop.type === 'formula' ? { icon: 'ƒ', name: 'Edit formula', run: () => editSettings('formula') } : null,
      prop.type === 'rollup' ? { icon: '∑', name: 'Edit rollup', run: () => editSettings('rollup') } : null,
      prop.type === 'unique_id' ? { icon: '№', name: 'Prefix', run: () => editSettings('unique_id') } : null,
      ['number', 'rollup', 'formula'].includes(prop.type)
        ? {
            icon: '%',
            name: 'Number format',
            run: () =>
              deps.menu(
                anchor,
                NUMBER_FORMATS.map((f) => ({ icon: '#', name: FORMAT_NAME[f] + ((prop.format || 'number') === f ? '  ✓' : ''), run: () => updateDb({ updateProperties: [{ property: prop.id, format: f }] }) })).concat([
                  '-',
                  { icon: '▭', name: `Show as number${!prop.display ? '  ✓' : ''}`, run: () => updateDb({ updateProperties: [{ property: prop.id, display: null }] }) },
                  { icon: '▬', name: `Show as bar${prop.display === 'bar' ? '  ✓' : ''}`, run: () => updateDb({ updateProperties: [{ property: prop.id, display: 'bar' }] }) },
                  { icon: '◔', name: `Show as ring${prop.display === 'ring' ? '  ✓' : ''}`, run: () => updateDb({ updateProperties: [{ property: prop.id, display: 'ring' }] }) },
                ]),
              ),
          }
        : null,
      prop.type === 'status' ? { icon: '◔', name: 'Option groups…', run: () => statusGroupsEditor(anchor, prop) } : null,
      !isTitle && !isPseudo && prop.type !== 'relation'
        ? {
            icon: '⇄',
            name: `Type: ${TYPE_NAME[prop.type]}`,
            run: () =>
              deps.menu(
                anchor,
                simple.map((t) => ({ icon: TYPE_ICON[t], name: TYPE_NAME[t] + (t === prop.type ? '  ✓' : ''), run: () => t !== prop.type && updateDb({ updateProperties: [{ property: prop.id, type: t }] }) })),
              ),
          }
        : null,
      prop.type === 'relation' ? { label: `Links to ${data.related?.[prop.databaseId]?.title || (prop.databaseId === pageId ? 'this database' : 'another database')}${prop.reverseId ? ' (two-way)' : ''}` } : null,
      prop.type === 'relation' && !structural(prop)
        ? prop.reverseId
          ? { icon: '→', name: 'Make one-way', run: () => confirm(`Remove the other side of "${prop.name}" from the related database? The links on this side stay.`) && updateDb({ updateProperties: [{ property: prop.id, twoWay: false }] }) }
          : { icon: '⇄', name: 'Make two-way…', run: () => deps.askInput(anchor, `Name of the property on ${data.related?.[prop.databaseId]?.title || 'the related database'}`, data.title || 'Related', (n) => updateDb({ updateProperties: [{ property: prop.id, twoWay: true, reverseName: n }] })) }
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
        ? { icon: '🗑', name: 'Delete property', danger: true, run: () => confirm(`Delete "${prop.name}" and its values from every item?${prop.reverseId ? ' Its other side in the related database goes too.' : ''}`) && updateDb({ removeProperties: [prop.id] }) }
        : null,
    ]);
  }
  /** Formula text with current names (the server keeps the tree; rebuild text from it). */
  function expressionOf(prop) {
    const name = (id) => {
      try {
        return resolveProp(data.database, id).name;
      } catch {
        return '(deleted)';
      }
    };
    const q = (s) => JSON.stringify(String(s));
    const text = (n) => {
      switch (n?.k) {
        case 'lit':
          return typeof n.v === 'string' ? q(n.v) : String(n.v);
        case 'prop':
          return `prop(${q(name(n.id))})`;
        case 'call':
          return `${n.f}(${n.args.map(text).join(', ')})`;
        case 'if':
          return `if(${text(n.c)}, ${text(n.a)}, ${text(n.b)})`;
        case 'un':
          return n.op === '-' ? `-${text(n.a)}` : `not ${text(n.a)}`;
        case 'bin':
          return `${text(n.a)} ${n.op} ${text(n.b)}`;
      }
      return '';
    };
    return text(prop.formula);
  }
  function statusGroupsEditor(anchor, prop) {
    const body = h('div', { class: 'db-editor' });
    body.append(
      ...prop.options.map((o) => {
        const s = h('select', { class: 'db-select' }, STATUS_GROUPS.map((g) => h('option', { value: g.id, selected: o.group === g.id ? true : null }, g.name)));
        s.addEventListener('change', () => updateDb({ updateProperties: [{ property: prop.id, optionGroups: { [o.id]: s.value } }] }));
        return h('div', { class: 'db-editor-row' }, chip(h, o.name, o.color), h('span', { class: 'grow' }), s);
      }),
      h('div', { class: 'sub small' }, 'Filters, rollups and “blocked” use the groups: an item is done when its status is in Complete.'),
    );
    deps.openPop(anchor, [h('div', { class: 'pop-label' }, `${prop.name} · groups`), body], { width: 340 });
  }

  // ---------- table ----------
  function columns(view) {
    const db = data.database;
    const byId = (id) => allProps(db).find((p) => p.id === id);
    const cols = (view.visible || [titleProp(db), ...db.properties].map((p) => p.id)).map(byId).filter(Boolean);
    return cols[0]?.type === 'title' ? cols : [titleProp(db), ...cols.filter((c) => c.type !== 'title')];
  }

  /** Rows as a tree when the database has sub-items: [{ row, depth, kids }]. */
  function nest(view, rows) {
    const sub = data.database.subItems;
    if (!sub || view.showSubItems === false || search) return rows.map((row) => ({ row, depth: 0, kids: 0 }));
    const inView = new Set(rows.map((r) => r.id));
    const kidsOf = new Map();
    const roots = [];
    for (const r of rows) {
      const parent = (r.props?.[sub.parent] || [])[0];
      if (parent && inView.has(parent)) {
        if (!kidsOf.has(parent)) kidsOf.set(parent, []);
        kidsOf.get(parent).push(r);
      } else roots.push(r);
    }
    const out = [];
    const walk = (r, depth, seen) => {
      const kids = kidsOf.get(r.id) || [];
      out.push({ row: r, depth, kids: kids.length });
      if (!expanded.has(r.id) || seen.has(r.id)) return;
      seen.add(r.id);
      for (const k of kids) walk(k, depth + 1, seen);
    };
    for (const r of roots) walk(r, 0, new Set());
    return out;
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
    const sub = data.database.subItems;
    const body = nest(view, rows).map(({ row: r, depth, kids }) =>
      h(
        'div',
        { class: 'db-row', dataset: { row: r.id } },
        cols.map((p) =>
          h(
            'div',
            { class: `db-cell type-${p.type}${p.type === 'title' ? ' title' : ''}`, style: p.type === 'title' && depth ? `padding-left:${6 + depth * 22}px` : null },
            p.type === 'title'
              ? [
                  sub && view.showSubItems !== false && !search
                    ? h(
                        'button',
                        { class: `db-toggle${kids ? '' : ' none'}${expanded.has(r.id) ? ' open' : ''}`, title: kids ? `${kids} sub-item${kids === 1 ? '' : 's'}` : 'Add a sub-item', onclick: () => (kids ? (expanded.has(r.id) ? expanded.delete(r.id) : expanded.add(r.id), render()) : (expanded.add(r.id), newRow({ [sub.parent]: [r.id] }))) },
                        kids ? '▸' : '+',
                      )
                    : null,
                  h('span', { class: 'db-row-icon' }, r.icon || (r.hasContent ? '📄' : '')),
                  valueCell(c, r, p),
                  data.database.dependencies && r.props?.blocked ? h('span', { class: 'db-blocked small', title: 'Waiting on items in "Blocked by"' }, '⛔') : null,
                  h('button', { class: 'db-open', title: 'Open as page', onclick: () => deps.go(r.id) }, 'Open'),
                ]
              : valueCell(c, r, p, { compact: true }),
          ),
        ),
        h('div', { class: 'db-cell add' }),
      ),
    );
    const agg = view.aggregations || {};
    const totals = aggregateView(data.database, rows, agg, valueCtx());
    const footer = h(
      'div',
      { class: 'db-row db-foot' },
      cols.map((p) =>
        h(
          'button',
          { class: 'db-cell db-agg', title: 'Calculate', onclick: (e) => aggMenu(e.currentTarget, view, p) },
          agg[p.id] ? [h('span', { class: 'sub' }, FN_NAME[agg[p.id]].replace(' / complete', '').replace(' / not complete', '') + ' '), h('b', {}, totals[p.id]?.text ?? '—')] : h('span', { class: 'db-agg-hint' }, 'Calculate'),
        ),
      ),
      h('div', { class: 'db-cell add' }),
    );
    const foot = h('button', { class: 'db-new-row', onclick: () => newRow() }, '＋ New');
    const empty = !rows.length ? h('div', { class: 'db-empty-view' }, data.rows.length ? 'No items match this view.' : 'No items yet.') : null;
    return h('div', { class: 'db-table-wrap' }, h('div', { class: 'db-table', style: `--cols:${cols.length}` }, head, body, empty, foot, footer));
  }

  function aggMenu(anchor, view, prop) {
    const agg = { ...(view.aggregations || {}) };
    const fns = AGGREGATIONS.filter((f) => {
      if (['sum', 'average', 'median', 'min', 'max', 'range'].includes(f)) return ['number', 'rollup', 'formula', 'unique_id'].includes(prop.type);
      if (['earliest_date', 'latest_date'].includes(f)) return ['date', 'created_time', 'last_edited_time', 'rollup', 'formula'].includes(prop.type);
      if (['checked', 'unchecked', 'percent_checked', 'percent_unchecked'].includes(f)) return ['checkbox', 'status', 'blocked'].includes(prop.type);
      return true;
    });
    deps.menu(anchor, [
      { label: `Calculate · ${prop.name}` },
      { icon: '∅', name: `None${!agg[prop.id] ? '  ✓' : ''}`, run: () => (delete agg[prop.id], saveView({ aggregations: agg })) },
      ...fns.map((f) => ({ icon: '∑', name: FN_NAME[f] + (agg[prop.id] === f ? '  ✓' : ''), run: () => saveView({ aggregations: { ...agg, [prop.id]: f } }) })),
    ]);
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
          h(
            'div',
            { class: 'db-col-head' },
            g.color && (group.type === 'select' || group.type === 'status') ? chip(h, g.name, g.color) : h('span', { class: 'db-col-name' }, g.name),
            h('span', { class: 'db-col-count' }, String(items.length)),
          ),
          items.map((r) => card(r, shown, 'db-card')),
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

  /** A card (board / gallery) with the shown, non-empty properties. */
  function card(r, shown, cls, cover = null) {
    const c = ctx();
    const el = h(
      'div',
      { class: cls, draggable: 'true', dataset: { row: r.id }, onclick: (e) => !e.target.closest('button, input, a, .db-chips') && deps.go(r.id) },
      cover,
      h('div', { class: 'db-card-body' }, h('div', { class: 'db-card-title' }, r.icon ? r.icon + ' ' : '', r.title || 'Untitled', data.database.dependencies && r.props?.blocked ? h('span', { class: 'db-blocked small' }, ' ⛔') : null), shown.filter((p) => !isEmpty(rawValue(r, p)) && rawValue(r, p) !== false).map((p) => h('div', { class: 'db-card-prop', title: p.name }, p.type === 'checkbox' ? h('span', { class: 'sub' }, `☑ ${p.name}`) : valueCell(c, r, p, { compact: true })))),
    );
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/x-db-row', r.id);
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
    return el;
  }

  // ---------- list ----------
  function list(view, rows) {
    const shown = columns(view).filter((p) => p.type !== 'title');
    const c = ctx();
    return h(
      'div',
      { class: 'db-list' },
      rows.map((r) =>
        h(
          'div',
          { class: 'db-list-row', dataset: { row: r.id }, onclick: (e) => !e.target.closest('button, input, a, .db-chips') && deps.go(r.id) },
          h('span', { class: 'db-row-icon' }, r.icon || '📄'),
          h('span', { class: 'db-list-title' }, r.title || 'Untitled'),
          data.database.dependencies && r.props?.blocked ? h('span', { class: 'db-blocked small' }, '⛔') : null,
          h('span', { class: 'db-list-props' }, shown.filter((p) => !isEmpty(rawValue(r, p)) && rawValue(r, p) !== false).map((p) => h('span', { class: 'db-list-prop', title: p.name }, p.type === 'checkbox' ? `☑ ${p.name}` : valueCell(c, r, p, { compact: true })))),
        ),
      ),
      !rows.length ? h('div', { class: 'db-empty-view' }, data.rows.length ? 'No items match this view.' : 'No items yet.') : null,
      h('button', { class: 'db-new-row', onclick: () => newRow() }, '＋ New'),
    );
  }

  // ---------- gallery ----------
  function gallery(view, rows) {
    const db = data.database;
    const shown = columns(view).filter((p) => p.type !== 'title');
    const coverProp = view.coverProperty && !['none', 'content'].includes(view.coverProperty) ? db.properties.find((p) => p.id === view.coverProperty) : !view.coverProperty ? db.properties.find((p) => p.type === 'files') : null;
    const coverOf = (r) => {
      if (view.coverProperty === 'none') return null;
      const files = coverProp ? rawValue(r, coverProp) || [] : [];
      const img = files.find((f) => f.thumbnail || /\.(png|jpe?g|gif|webp|svg|avif)(\?|$)/i.test(f.url) || f.storageId) || files[0];
      return img?.thumbnail || img?.url || (view.coverProperty === 'content' || !coverProp ? r.cover : null) || r.cover || null;
    };
    return h(
      'div',
      { class: `db-gallery size-${view.cardSize || 'medium'}` },
      rows.map((r) => {
        const url = coverOf(r);
        const cover = view.coverProperty === 'none' ? null : h('div', { class: 'db-cover' }, url ? h('img', { src: url, alt: '', loading: 'lazy' }) : h('span', { class: 'db-cover-empty' }, r.icon || '📄'));
        return card(r, shown, 'db-card db-gcard', cover);
      }),
      h('button', { class: 'db-gcard db-gcard-new', onclick: () => newRow() }, '＋ New'),
    );
  }

  // ---------- calendar ----------
  function calendar(view, rows) {
    const db = data.database;
    let prop;
    try {
      prop = resolveProp(db, view.dateProperty);
    } catch {
      return h('div', { class: 'db-empty-view' }, 'Choose a date property for this calendar (click the view tab).');
    }
    const today = new Date();
    if (!calMonth) calMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const first = new Date(calMonth);
    const startOffset = (first.getDay() + 6) % 7; // weeks start on Monday
    const gridStart = new Date(first.getFullYear(), first.getMonth(), 1 - startOffset);
    const days = Array.from({ length: 42 }, (_, i) => new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i));
    const byDay = new Map();
    for (const r of rows) {
      const v = rawValue(r, prop);
      const s = typeof v === 'object' && v ? v.start : v;
      if (!s) continue;
      const e = (typeof v === 'object' && v?.end) || s;
      const a = toLocal(s);
      const b = toLocal(e);
      for (let d = new Date(a.getFullYear(), a.getMonth(), a.getDate()), n = 0; d <= b && n < 62; d.setDate(d.getDate() + 1), n++) {
        const k = localYmd(d);
        if (!byDay.has(k)) byDay.set(k, []);
        byDay.get(k).push({ r, time: n === 0 && hasTime(s) ? a.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null });
      }
    }
    const shift = (n) => {
      calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + n, 1);
      render();
    };
    const head = h(
      'div',
      { class: 'db-cal-head' },
      h('b', {}, calMonth.toLocaleDateString([], { month: 'long', year: 'numeric' })),
      h('span', { class: 'grow' }),
      h('button', { class: 'db-btn', onclick: () => shift(-1) }, '‹'),
      h('button', { class: 'db-btn', onclick: () => ((calMonth = new Date(today.getFullYear(), today.getMonth(), 1)), render()) }, 'Today'),
      h('button', { class: 'db-btn', onclick: () => shift(1) }, '›'),
    );
    const names = Array.from({ length: 7 }, (_, i) => new Date(2024, 0, 1 + i).toLocaleDateString([], { weekday: 'short' }));
    const writable = prop.type === 'date';
    const grid = h(
      'div',
      { class: 'db-cal' },
      names.map((n) => h('div', { class: 'db-cal-dow' }, n)),
      days.map((d) => {
        const k = localYmd(d);
        const items = byDay.get(k) || [];
        const cell = h(
          'div',
          { class: `db-cal-day${d.getMonth() !== calMonth.getMonth() ? ' other' : ''}${k === localYmd(today) ? ' today' : ''}`, dataset: { day: k } },
          h('div', { class: 'db-cal-num' }, h('span', {}, String(d.getDate())), writable ? h('button', { class: 'db-cal-add', title: 'New item on this day', onclick: () => newRow({ [prop.id]: k }) }, '+') : null),
          items.slice(0, 6).map(({ r, time }) =>
            h(
              'button',
              { class: 'db-cal-item', draggable: writable ? 'true' : null, dataset: { row: r.id }, onclick: () => deps.go(r.id), ondragstart: (e) => e.dataTransfer.setData('text/x-db-row', r.id) },
              time ? h('span', { class: 'sub' }, time + ' ') : null,
              r.icon ? r.icon + ' ' : '',
              r.title || 'Untitled',
            ),
          ),
          items.length > 6 ? h('div', { class: 'sub small' }, `+${items.length - 6} more`) : null,
        );
        if (writable) {
          cell.addEventListener('dragover', (e) => e.dataTransfer.types.includes('text/x-db-row') && (e.preventDefault(), cell.classList.add('drop')));
          cell.addEventListener('dragleave', () => cell.classList.remove('drop'));
          cell.addEventListener('drop', (e) => {
            e.preventDefault();
            cell.classList.remove('drop');
            const r = data.rows.find((x) => x.id === e.dataTransfer.getData('text/x-db-row'));
            if (!r) return;
            const v = rawValue(r, prop);
            // move the start to the dropped day, keep the time of day and the length of a range
            const from = toLocal(v.start);
            const to = new Date(d.getFullYear(), d.getMonth(), d.getDate(), from.getHours(), from.getMinutes());
            const delta = to - new Date(from.getFullYear(), from.getMonth(), from.getDate(), from.getHours(), from.getMinutes());
            const move = (s) => (s ? (hasTime(s) ? new Date(toLocal(s).getTime() + delta).toISOString() : localYmd(new Date(toLocal(s).getTime() + delta))) : null);
            save(r, prop, { start: move(v.start), end: move(v.end) });
          });
        }
        return cell;
      }),
    );
    const undated = rows.filter((r) => isEmpty(rawValue(r, prop))).length;
    return h('div', { class: 'db-cal-wrap' }, head, grid, undated ? h('div', { class: 'sub small' }, `${undated} item${undated === 1 ? '' : 's'} without ${prop.name} not shown`) : null);
  }

  // ---------- timeline ----------
  function timeline(view, rows) {
    const db = data.database;
    let prop;
    try {
      prop = resolveProp(db, view.dateProperty);
    } catch {
      return h('div', { class: 'db-empty-view' }, 'Choose a date property for this timeline (click the view tab).');
    }
    const endProp = view.endProperty ? db.properties.find((p) => p.id === view.endProperty) : null;
    const zoom = localStorage.getItem(zoomKey(view)) || 'day';
    const W = { day: 34, week: 12, month: 4 }[zoom] || 34;
    const spanOf = (r) => {
      const v = rawValue(r, prop);
      const s = typeof v === 'object' && v ? v.start : v;
      if (!s) return null;
      const ev = endProp ? rawValue(r, endProp) : null;
      const e = (endProp ? (typeof ev === 'object' && ev ? ev.end || ev.start : ev) : typeof v === 'object' ? v?.end : null) || s;
      const a = toLocal(s);
      const b = toLocal(e);
      return { a: new Date(a.getFullYear(), a.getMonth(), a.getDate()), b: new Date(b.getFullYear(), b.getMonth(), b.getDate()), s, e };
    };
    const spans = rows.map((r) => ({ r, sp: spanOf(r) }));
    const dated = spans.filter((x) => x.sp && x.sp.b >= x.sp.a);
    const today = new Date();
    const t0 = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    let min = new Date(t0.getTime() - 7 * 864e5);
    let max = new Date(t0.getTime() + 30 * 864e5);
    for (const { sp } of dated) {
      if (sp.a < min) min = new Date(sp.a);
      if (sp.b > max) max = new Date(sp.b);
    }
    min = new Date(min.getFullYear(), min.getMonth(), min.getDate() - 3);
    const nDays = Math.min(730, Math.round((max - min) / 864e5) + 10);
    const dayIndex = (d) => Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - min) / 864e5);
    const width = nDays * W;
    const scale = h('div', { class: 'db-tl-scale', style: `width:${width}px` });
    for (let i = 0; i < nDays; i++) {
      const d = new Date(min.getFullYear(), min.getMonth(), min.getDate() + i);
      if (d.getDate() === 1 || i === 0) scale.append(h('div', { class: 'db-tl-month', style: `left:${i * W}px` }, d.toLocaleDateString([], { month: 'short', year: 'numeric' })));
      if (zoom === 'day') scale.append(h('div', { class: `db-tl-day${[0, 6].includes(d.getDay()) ? ' weekend' : ''}`, style: `left:${i * W}px;width:${W}px` }, String(d.getDate())));
      else if (zoom === 'week' && d.getDay() === 1) scale.append(h('div', { class: 'db-tl-day', style: `left:${i * W}px;width:${7 * W}px` }, String(d.getDate())));
    }
    const todayX = dayIndex(t0) * W + W / 2;
    const lines = dated.map(({ r, sp }) => {
      const x = dayIndex(sp.a) * W;
      const w = Math.max(W, (dayIndex(sp.b) - dayIndex(sp.a) + 1) * W);
      const blocked = db.dependencies && r.props?.blocked;
      return h(
        'div',
        { class: 'db-tl-row', dataset: { row: r.id } },
        h('button', { class: 'db-tl-label', onclick: () => deps.go(r.id), title: r.title }, r.icon ? r.icon + ' ' : '', r.title || 'Untitled'),
        h('div', { class: 'db-tl-track', style: `width:${width}px` }, h('button', { class: `db-tl-bar${blocked ? ' blocked' : ''}`, style: `left:${x}px;width:${w - 4}px`, title: `${r.title || 'Untitled'} · ${fmtDate(sp.s)}${sp.e !== sp.s ? ` → ${fmtDate(sp.e)}` : ''}${blocked ? ' · blocked' : ''}`, onclick: () => deps.go(r.id) }, blocked ? '⛔ ' : '', r.title || 'Untitled')),
      );
    });
    const undated = spans.filter((x) => !x.sp);
    const zoomBtns = h(
      'div',
      { class: 'db-tl-zoom' },
      ['day', 'week', 'month'].map((z) => h('button', { class: `db-btn${z === zoom ? ' on' : ''}`, onclick: () => (localStorage.setItem(zoomKey(view), z), render()) }, z[0].toUpperCase() + z.slice(1))),
    );
    const scroller = h(
      'div',
      { class: 'db-tl' },
      h('div', { class: 'db-tl-row head' }, h('div', { class: 'db-tl-label' }, data.database.titleName || 'Name'), scale),
      lines,
      h('div', { class: 'db-tl-today', style: `left:calc(var(--tl-label) + ${todayX}px)` }),
    );
    requestAnimationFrame(() => {
      if (!scroller.dataset.scrolled) {
        scroller.scrollLeft = Math.max(0, todayX - 200);
        scroller.dataset.scrolled = '1';
      }
    });
    return h(
      'div',
      { class: 'db-tl-wrap' },
      zoomBtns,
      scroller,
      undated.length ? h('details', { class: 'db-tl-undated' }, h('summary', {}, `${undated.length} without ${prop.name}`), undated.map(({ r }) => h('button', { class: 'db-list-row', dataset: { row: r.id }, onclick: () => deps.go(r.id) }, r.icon || '📄', ' ', r.title || 'Untitled'))) : null,
      h('button', { class: 'db-new-row', onclick: () => newRow({ [prop.id]: prop.type === 'date' ? localYmd(today) : undefined }) }, '＋ New'),
    );
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
  const r = page.row;
  const db = { titleName: r.titleName, properties: r.properties, views: [], dependencies: r.dependencies, subItems: r.subItems };
  const members = r.members || [];
  const row = { id: page.id, title: page.title, props: page.props || {} };
  const save = (x, prop, value) =>
    deps
      .rpc('updateRows', { updates: [{ itemId: x.id, properties: { [prop.id]: value } }] })
      .then((res) => res?.failed && deps.toast(res.results[0].error))
      .catch((err) => deps.toast(err.message));
  const c = { h, db, dbId: r.databaseId, members, related: r.related || {}, save, deps };
  const props = [...db.properties, ...(db.dependencies ? [BLOCKED_PROP] : [])];
  return h(
    'div',
    { class: 'db-props' },
    props.map((p) =>
      h(
        'div',
        { class: 'db-prop-row' },
        h('div', { class: 'db-prop-name', title: READ_ONLY_TYPES.includes(p.type) || p.type === 'blocked' ? 'Computed' : '' }, h('span', { class: 'db-type' }, TYPE_ICON[p.type]), p.name),
        h('div', { class: `db-prop-value type-${p.type}` }, valueCell(c, row, p)),
      ),
    ),
    h(
      'div',
      { class: 'db-prop-row' },
      h('div', { class: 'db-prop-name' }, h('span', { class: 'db-type' }, '🗃️'), 'Database'),
      h(
        'div',
        { class: 'db-prop-value' },
        h('button', { class: 'db-link', onclick: () => deps.go(r.databaseId) }, r.databaseTitle || 'Untitled'),
        h('span', { class: 'grow' }),
        h(
          'button',
          {
            class: 'db-btn',
            title: 'New items can start as a copy of this one',
            onclick: (e) =>
              deps.askInput(e.currentTarget, 'Template name', page.title || 'Template', (name) =>
                deps
                  .rpc('saveTemplate', { pageId: r.databaseId, fromItemId: page.id, name })
                  .then(() => deps.toast(`Saved template “${name}”. Pick it from the ▾ next to New.`))
                  .catch((err) => deps.toast(err.message)),
              ),
          },
          '📋 Save as template',
        ),
      ),
    ),
  );
}
