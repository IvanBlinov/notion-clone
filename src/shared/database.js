// Databases: typed properties, value parsing, filters, sorts and views.
// Shared by the server (WorkspaceModel) and the browser (table / board views),
// so a view shows exactly what a query_database call with the same filters returns.
//
// A database is a page with `database: { titleName, properties, views, idem }`.
// Its rows are its child pages; each row keeps typed values in `props: { [propertyId]: value }`.

import { newId } from './markdown.js';

export const PROPERTY_TYPES = ['text', 'number', 'checkbox', 'select', 'multi_select', 'date', 'person', 'url', 'email'];
export const OPTION_COLORS = ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'];
export const VIEW_TYPES = ['table', 'board'];
export const GROUPABLE = ['select', 'person', 'checkbox'];
export const OPERATORS = [
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'is_empty',
  'is_not_empty',
  'greater_than',
  'less_than',
  'greater_or_equal',
  'less_or_equal',
  'before',
  'after',
  'on_or_before',
  'on_or_after',
];

/** Built-in columns every database has. */
const PSEUDO = [
  { id: 'title', type: 'title' },
  { id: 'created_time', name: 'Created time', type: 'created_time' },
  { id: 'last_edited_time', name: 'Last edited time', type: 'last_edited_time' },
];

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const shortId = () => newId().slice(0, 8);
const norm = (s) => String(s ?? '').trim().toLowerCase();

export function titleProp(db) {
  return { id: 'title', name: db.titleName || 'Name', type: 'title' };
}

/** All columns: title, user properties, then the built-in times. */
export function allProps(db) {
  return [titleProp(db), ...db.properties, ...PSEUDO.slice(1)];
}

/** Find a property by id, name (any case) or built-in alias. Throws a helpful error when missing. */
export function resolveProp(db, key, { allowPseudo = true } = {}) {
  const k = norm(key);
  const list = allowPseudo ? allProps(db) : [titleProp(db), ...db.properties];
  const found =
    list.find((p) => p.id === key) ||
    list.find((p) => norm(p.name) === k) ||
    (['title', 'name'].includes(k) ? titleProp(db) : null) ||
    (allowPseudo && ['created', 'created_time', 'created at'].includes(k) ? PSEUDO[1] : null) ||
    (allowPseudo && ['last_edited', 'last_edited_time', 'updated', 'updated_at', 'last edited'].includes(k) ? PSEUDO[2] : null);
  if (!found) throw bad(`Unknown property "${key}". Properties: ${[titleProp(db), ...db.properties].map((p) => `"${p.name}"`).join(', ')}`);
  return found;
}

/** Validate and normalize a property definition from a create/update request. */
export function makeProperty(db, spec) {
  const name = String(spec?.name || '').trim();
  if (!name) throw bad('Every property needs a name');
  const type = spec.type === 'status' ? 'select' : spec.type === 'multiselect' ? 'multi_select' : spec.type === 'people' || spec.type === 'user' ? 'person' : spec.type;
  if (!PROPERTY_TYPES.includes(type)) throw bad(`Unknown property type "${spec.type}" for "${name}". Types: ${PROPERTY_TYPES.join(', ')}`);
  if ([titleProp(db), ...db.properties].some((p) => norm(p.name) === norm(name))) throw bad(`A property named "${name}" already exists`);
  const prop = { id: shortId(), name: name.slice(0, 60), type };
  if (type === 'select' || type === 'multi_select') {
    prop.options = [];
    for (const o of spec.options || []) addOption(prop, typeof o === 'string' ? o : o?.name, typeof o === 'object' ? o?.color : undefined);
  }
  if (type === 'number' && spec.format) prop.format = String(spec.format).slice(0, 20);
  return prop;
}

export function addOption(prop, name, color) {
  const n = String(name ?? '').trim();
  if (!n) throw bad(`Empty option for "${prop.name}"`);
  const existing = prop.options.find((o) => norm(o.name) === norm(n) || o.id === name);
  if (existing) return existing;
  const o = { id: shortId(), name: n.slice(0, 60), color: OPTION_COLORS.includes(color) ? color : OPTION_COLORS[prop.options.length % OPTION_COLORS.length] };
  prop.options.push(o);
  return o;
}

// ---------------------------------------------------------------------------
// Dates: stored as { start: "YYYY-MM-DD" or ISO datetime, end: same or null }
// ---------------------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** "today", "tomorrow", "yesterday", "+7d", "-2w", "2026-11-20", ISO datetimes. */
export function parseDateString(s, today = new Date()) {
  const t = norm(s);
  if (!t) return null;
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (t === 'today') return ymd(base);
  if (t === 'tomorrow') return ymd(new Date(base.getTime() + 86400000));
  if (t === 'yesterday') return ymd(new Date(base.getTime() - 86400000));
  const rel = t.match(/^([+-]\d+)\s*([dwm])$/);
  if (rel) {
    const n = Number(rel[1]);
    const d = new Date(base);
    if (rel[2] === 'd') d.setDate(d.getDate() + n);
    if (rel[2] === 'w') d.setDate(d.getDate() + 7 * n);
    if (rel[2] === 'm') d.setMonth(d.getMonth() + n);
    return ymd(d);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(t) && !isNaN(new Date(t + 'T00:00:00').getTime())) return t;
  if (/^\d{4}-\d{2}-\d{2}t/.test(t) && !isNaN(new Date(s).getTime())) return String(s).trim();
  throw bad(`Invalid date "${s}". Use YYYY-MM-DD, an ISO date-time, "today", "tomorrow" or a relative offset like "+7d".`);
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------
const isEmpty = (v) => v == null || v === '' || (Array.isArray(v) && !v.length);

/**
 * Turn what a person or an agent typed into the stored value.
 * Select options are matched by name (any case) and created when new.
 * People are matched by user id, email, or an unambiguous name ("me" = the caller).
 * ctx: { members: [{ id, name, email }], me: userId }
 */
export function parseValue(prop, raw, ctx = {}) {
  if (prop.type === 'checkbox') {
    if (typeof raw === 'string') return ['true', 'yes', 'y', '1', 'done', 'checked', 'x'].includes(norm(raw));
    return !!raw;
  }
  if (isEmpty(raw)) return null;
  switch (prop.type) {
    case 'title':
    case 'text':
      return String(raw).slice(0, 5000);
    case 'url':
    case 'email':
      return String(raw).trim().slice(0, 2000);
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[,\s$€£%]/g, ''));
      if (!Number.isFinite(n)) throw bad(`"${prop.name}" needs a number, got "${raw}"`);
      return n;
    }
    case 'select':
      return addOption(prop, Array.isArray(raw) ? raw[0] : raw).id;
    case 'multi_select': {
      const list = Array.isArray(raw) ? raw : String(raw).split(',');
      return [...new Set(list.map((x) => String(x).trim()).filter(Boolean).map((x) => addOption(prop, x).id))];
    }
    case 'date': {
      if (typeof raw === 'object' && !Array.isArray(raw)) {
        const start = parseDateString(raw.start);
        if (!start) return null;
        return { start, end: raw.end ? parseDateString(raw.end) : null };
      }
      return { start: parseDateString(raw), end: null };
    }
    case 'person': {
      const list = Array.isArray(raw) ? raw : String(raw).split(',');
      return [...new Set(list.map((x) => resolveMember(x, ctx)).filter(Boolean))];
    }
    default:
      throw bad(`Property "${prop.name}" (${prop.type}) can't be set directly`);
  }
}

export function resolveMember(who, { members = [], me } = {}) {
  const s = String(typeof who === 'object' && who ? who.id || who.email || who.name : who ?? '').trim();
  if (!s) return null;
  const k = norm(s);
  if (['me', '@me', 'myself'].includes(k)) {
    if (!me) throw bad('"me" is not available here');
    return me;
  }
  const byId = members.find((m) => m.id === s);
  if (byId) return byId.id;
  const byEmail = members.find((m) => norm(m.email) === k);
  if (byEmail) return byEmail.id;
  let hits = members.filter((m) => norm(m.name) === k);
  if (!hits.length) hits = members.filter((m) => norm(m.name).split(/\s+/)[0] === k);
  if (hits.length === 1) return hits[0].id;
  const list = members.map((m) => `${m.name} <${m.email}> (id ${m.id})`).join('; ');
  if (hits.length > 1) throw bad(`"${s}" matches several members; use an email or id. Members: ${list}`);
  throw bad(`"${s}" is not a member of this workspace. Members: ${list || 'none'}`);
}

/** Stored value of any column for a row. */
export function rawValue(row, prop) {
  if (prop.type === 'title') return row.title || '';
  if (prop.type === 'created_time') return row.createdAt || null;
  if (prop.type === 'last_edited_time') return row.updatedAt || null;
  return row.props?.[prop.id] ?? (prop.type === 'checkbox' ? false : null);
}

/** Human / JSON friendly value: option names, member names, "start → end" dates. */
export function displayValue(prop, value, members = []) {
  if (prop.type === 'checkbox') return !!value;
  if (isEmpty(value)) return null;
  switch (prop.type) {
    case 'select':
      return prop.options.find((o) => o.id === value)?.name ?? null;
    case 'multi_select':
      return value.map((id) => prop.options.find((o) => o.id === id)?.name).filter(Boolean);
    case 'person':
      return value.map((id) => members.find((m) => m.id === id)?.name || 'Former member');
    case 'date':
      return value.end ? `${value.start} → ${value.end}` : value.start;
    default:
      return value;
  }
}

/** Plain text for search and for type conversions. */
export function valueText(prop, value, members = []) {
  const d = displayValue(prop, value, members);
  if (d == null) return '';
  return Array.isArray(d) ? d.join(', ') : String(d);
}

// ---------------------------------------------------------------------------
// Filters & sorts
// Filter: { property, operator, value } — a list is AND-ed; { or: [filters] } is OR.
// ---------------------------------------------------------------------------
const OP_ALIASES = { '=': 'equals', is: 'equals', eq: 'equals', '!=': 'not_equals', is_not: 'not_equals', '>': 'greater_than', '<': 'less_than', '>=': 'greater_or_equal', '<=': 'less_or_equal', gt: 'greater_than', lt: 'less_than', gte: 'greater_or_equal', lte: 'less_or_equal' };

/** Resolve property names to ids and check operators, so saved views survive renames. */
export function normalizeFilters(db, filters) {
  if (!filters) return [];
  if (!Array.isArray(filters)) filters = [filters];
  return filters.map((f) => {
    if (f && Array.isArray(f.or)) return { or: normalizeFilters(db, f.or) };
    if (f && Array.isArray(f.and)) return { and: normalizeFilters(db, f.and) };
    const prop = resolveProp(db, f?.property);
    const operator = OP_ALIASES[norm(f.operator)] || norm(f.operator || 'equals');
    if (!OPERATORS.includes(operator)) throw bad(`Unknown operator "${f.operator}". Operators: ${OPERATORS.join(', ')}`);
    const out = { property: prop.id, operator };
    if (!['is_empty', 'is_not_empty'].includes(operator)) out.value = f.value ?? null;
    return out;
  });
}

export function normalizeSorts(db, sorts) {
  if (!sorts) return [];
  if (!Array.isArray(sorts)) sorts = [sorts];
  return sorts.map((s) => {
    const prop = resolveProp(db, typeof s === 'string' ? s : s?.property);
    const dir = norm(typeof s === 'string' ? 'ascending' : s.direction || 'ascending');
    return { property: prop.id, direction: dir.startsWith('desc') ? 'descending' : 'ascending' };
  });
}

const dateKey = (v) => (v == null ? null : typeof v === 'object' ? v.start : String(v)).slice(0, 10);

function optionMatches(prop, id, want) {
  const o = prop.options.find((x) => x.id === id);
  return !!o && (o.id === want || norm(o.name) === norm(want));
}

function matchOne(db, row, f, ctx) {
  const prop = resolveProp(db, f.property);
  const v = rawValue(row, prop);
  const want = f.value;
  const empty = prop.type === 'checkbox' ? !v : isEmpty(v);
  switch (f.operator) {
    case 'is_empty':
      return empty;
    case 'is_not_empty':
      return !empty;
  }
  const wants = Array.isArray(want) ? want : [want];
  const negate = f.operator === 'not_equals' || f.operator === 'not_contains';
  const op = negate ? (f.operator === 'not_equals' ? 'equals' : 'contains') : f.operator;
  let hit;
  switch (prop.type) {
    case 'checkbox':
      hit = !!v === parseValue(prop, want);
      break;
    case 'select':
      hit = wants.some((w) => optionMatches(prop, v, w));
      break;
    case 'multi_select':
      hit = wants.some((w) => (v || []).some((id) => optionMatches(prop, id, w)));
      break;
    case 'person': {
      const ids = wants.map((w) => {
        try {
          return resolveMember(w, ctx);
        } catch {
          return null;
        }
      });
      hit = ids.some((id) => id && (v || []).includes(id));
      break;
    }
    case 'number': {
      const n = Number(want);
      if (v == null) return negate;
      hit = { equals: v === n, contains: v === n, greater_than: v > n, less_than: v < n, greater_or_equal: v >= n, less_or_equal: v <= n }[op];
      if (hit === undefined) throw bad(`Operator "${f.operator}" doesn't apply to number "${prop.name}"`);
      break;
    }
    case 'date':
    case 'created_time':
    case 'last_edited_time': {
      if (v == null) return negate;
      const a = prop.type === 'date' ? dateKey(v) : ymd(new Date(v));
      const b = parseDateString(typeof want === 'object' && want ? want.start : want);
      hit = { equals: a === b, contains: a === b, before: a < b, less_than: a < b, after: a > b, greater_than: a > b, on_or_before: a <= b, less_or_equal: a <= b, on_or_after: a >= b, greater_or_equal: a >= b }[op];
      if (hit === undefined) throw bad(`Operator "${f.operator}" doesn't apply to date "${prop.name}"`);
      break;
    }
    default: {
      const s = norm(v);
      hit = op === 'equals' ? wants.some((w) => s === norm(w)) : op === 'contains' ? wants.some((w) => s.includes(norm(w))) : undefined;
      if (hit === undefined) throw bad(`Operator "${f.operator}" doesn't apply to text "${prop.name}"`);
    }
  }
  return negate ? !hit : hit;
}

export function matches(db, row, filters, ctx = {}) {
  return (filters || []).every((f) => (f.or ? f.or.some((g) => matches(db, row, [g], ctx)) : f.and ? matches(db, row, f.and, ctx) : matchOne(db, row, f, ctx)));
}

function sortKey(prop, v, members) {
  if (prop.type === 'checkbox') return v ? 1 : 0;
  if (isEmpty(v)) return null;
  if (prop.type === 'number') return v;
  if (prop.type === 'date') return dateKey(v);
  if (prop.type === 'select') return prop.options.findIndex((o) => o.id === v); // option order, like Notion
  return norm(valueText(prop, v, members));
}

/** Sort rows (empties last). Without sorts, keeps manual order (position). */
export function sortRows(db, rows, sorts, members = []) {
  const keyed = (sorts || []).map((s) => ({ prop: resolveProp(db, s.property), dir: s.direction === 'descending' ? -1 : 1 }));
  return [...rows].sort((a, b) => {
    for (const { prop, dir } of keyed) {
      const x = sortKey(prop, rawValue(a, prop), members);
      const y = sortKey(prop, rawValue(b, prop), members);
      if (x === y) continue;
      if (x == null) return 1;
      if (y == null) return -1;
      return (x < y ? -1 : 1) * dir;
    }
    return (a.position ?? 0) - (b.position ?? 0);
  });
}

export function searchRows(db, rows, q, members = []) {
  const k = norm(q);
  if (!k) return rows;
  const props = db.properties.filter((p) => ['text', 'url', 'email', 'select', 'multi_select', 'person'].includes(p.type));
  return rows.filter((r) => norm(r.title).includes(k) || props.some((p) => norm(valueText(p, r.props?.[p.id], members)).includes(k)));
}

/** Apply a view (or ad-hoc filters/sorts) to rows. */
export function applyView(db, rows, { filters = [], sorts = [], search = '' } = {}, ctx = {}) {
  const filtered = searchRows(db, rows, search, ctx.members).filter((r) => matches(db, r, filters, ctx));
  return sortRows(db, filtered, sorts, ctx.members);
}

/** Board columns for a group-by property: [{ key, name, color }] plus "No value". */
export function groupsFor(prop, members = []) {
  if (prop.type === 'select') return [{ key: null, name: `No ${prop.name}` }, ...prop.options.map((o) => ({ key: o.id, name: o.name, color: o.color }))];
  if (prop.type === 'checkbox') return [{ key: false, name: 'Unchecked' }, { key: true, name: 'Checked' }];
  if (prop.type === 'person') return [{ key: null, name: 'Unassigned' }, ...members.map((m) => ({ key: m.id, name: m.name, color: m.color }))];
  return [];
}
export function groupKeyOf(prop, row) {
  const v = rawValue(row, prop);
  if (prop.type === 'checkbox') return !!v;
  if (prop.type === 'person') return v?.[0] ?? null;
  return v ?? null;
}

/** Validate a view definition (names → ids). */
export function makeView(db, spec, existing = null) {
  const view = existing ? { ...existing } : { id: shortId(), name: 'Table', type: 'table', filters: [], sorts: [], groupBy: null, visible: null };
  if (spec.name !== undefined) view.name = String(spec.name || 'View').slice(0, 60);
  if (spec.type !== undefined) {
    if (!VIEW_TYPES.includes(spec.type)) throw bad(`Unknown view type "${spec.type}". Types: ${VIEW_TYPES.join(', ')}`);
    view.type = spec.type;
  }
  if (spec.filters !== undefined) view.filters = normalizeFilters(db, spec.filters);
  if (spec.sorts !== undefined) view.sorts = normalizeSorts(db, spec.sorts);
  if (spec.visibleProperties !== undefined) view.visible = spec.visibleProperties ? spec.visibleProperties.map((k) => resolveProp(db, k).id) : null;
  if (spec.groupBy !== undefined) {
    if (spec.groupBy) {
      const g = resolveProp(db, spec.groupBy, { allowPseudo: false });
      if (!GROUPABLE.includes(g.type)) throw bad(`Boards can be grouped by ${GROUPABLE.join(', ')} properties; "${g.name}" is ${g.type}`);
      view.groupBy = g.id;
    } else view.groupBy = null;
  }
  if (view.type === 'board' && !view.groupBy) {
    const g = db.properties.find((p) => p.type === 'select') || db.properties.find((p) => GROUPABLE.includes(p.type));
    if (!g) throw bad('A board view needs a select, person or checkbox property to group by');
    view.groupBy = g.id;
  }
  if (!existing && spec.name === undefined) view.name = view.type === 'board' ? 'Board' : 'Table';
  return view;
}

/**
 * Validate the settings of a linked view (a database_view block on another page).
 * strict: throw on unknown properties (agent requests); otherwise silently drop references
 * to properties that no longer exist (saves from the editor after a property was deleted).
 */
export function linkedView(db, v, { strict = false } = {}) {
  const known = (id) => {
    try {
      resolveProp(db, id);
      return true;
    } catch {
      return false;
    }
  };
  const prune = (fs) => (fs || []).filter((f) => (f?.or ? ((f.or = prune(f.or)), f.or.length) : f?.and ? ((f.and = prune(f.and)), f.and.length) : known(f?.property)));
  const spec = {
    name: v?.name ?? 'Linked view',
    type: v?.type || 'table',
    filters: strict ? v?.filters || [] : prune(structuredClone(v?.filters || [])),
    sorts: strict ? v?.sorts || [] : (v?.sorts || []).filter((s) => known(typeof s === 'string' ? s : s?.property)),
    groupBy: v?.groupBy && (strict || known(v.groupBy)) ? v.groupBy : null,
    visibleProperties: v?.visible || v?.visibleProperties ? (strict ? v.visible || v.visibleProperties : (v.visible || v.visibleProperties).filter(known)) : null,
  };
  if (!strict && spec.type === 'board' && !spec.groupBy && !db.properties.some((p) => GROUPABLE.includes(p.type))) spec.type = 'table';
  return makeView(db, spec, { id: v?.id || shortId(), name: '', type: 'table', filters: [], sorts: [], groupBy: null, visible: null });
}

/** Drop references to a removed property from every view. */
export function forgetProperty(db, propId) {
  const strip = (fs) => fs.filter((f) => (f.or ? ((f.or = strip(f.or)), f.or.length) : f.and ? ((f.and = strip(f.and)), f.and.length) : f.property !== propId));
  for (const v of db.views) {
    v.filters = strip(v.filters || []);
    v.sorts = (v.sorts || []).filter((s) => s.property !== propId);
    if (v.visible) v.visible = v.visible.filter((id) => id !== propId);
    if (v.groupBy === propId) {
      v.groupBy = null;
      if (v.type === 'board') v.type = 'table';
    }
  }
}
