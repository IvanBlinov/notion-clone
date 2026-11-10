// Databases: typed properties, value parsing, computed values, filters, sorts and views.
// Shared by the server (WorkspaceModel) and the browser (table / board / … views),
// so a view shows exactly what a query_database call with the same filters returns.
//
// A database is a page with `database: { titleName, properties, views, templates, idem, subItems, dependencies }`.
// Its rows are its child pages; each row keeps typed values in `props: { [propertyId]: value }`.
// Rollup, formula and "blocked" values are computed (createComputer) and never stored.

import { newId } from './markdown.js';
import { parseFormula, evalFormula, formulaText, formulaProps, valueToText } from './formula.js';

export const PROPERTY_TYPES = ['text', 'number', 'checkbox', 'select', 'status', 'multi_select', 'date', 'person', 'relation', 'rollup', 'formula', 'files', 'links', 'url', 'email', 'unique_id'];
export const COMPUTED_TYPES = ['rollup', 'formula'];
export const READ_ONLY_TYPES = ['rollup', 'formula', 'unique_id'];
export const OPTION_COLORS = ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'];
export const STATUS_GROUPS = [
  { id: 'todo', name: 'To-do', color: 'gray' },
  { id: 'in_progress', name: 'In progress', color: 'blue' },
  { id: 'complete', name: 'Complete', color: 'green' },
];
export const VIEW_TYPES = ['table', 'board', 'list', 'gallery', 'calendar', 'timeline'];
export const GROUPABLE = ['select', 'status', 'person', 'checkbox'];
export const NUMBER_FORMATS = ['number', 'number_with_commas', 'percent', 'dollar', 'euro', 'pound', 'yen', 'ruble'];
export const ROLLUP_FUNCTIONS = [
  'show_original',
  'count',
  'count_values',
  'count_unique',
  'count_empty',
  'count_not_empty',
  'percent_empty',
  'percent_not_empty',
  'sum',
  'average',
  'median',
  'min',
  'max',
  'range',
  'earliest_date',
  'latest_date',
  'date_range',
  'checked',
  'unchecked',
  'percent_checked',
  'percent_unchecked',
  'count_where',
  'percent_where',
];
/** Footer calculations of table views (same engine as rollups). */
export const AGGREGATIONS = ROLLUP_FUNCTIONS.filter((f) => !['show_original', 'count_where', 'percent_where', 'date_range'].includes(f));
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
  'in_group',
  'not_in_group',
];
/** Filter value meaning "the page this linked view sits on". */
export const THIS_PAGE = '@this_page';

/** Built-in columns every database has. */
const PSEUDO = [
  { id: 'title', type: 'title' },
  { id: 'created_time', name: 'Created time', type: 'created_time' },
  { id: 'last_edited_time', name: 'Last edited time', type: 'last_edited_time' },
];
/** Computed when the database tracks dependencies: true while a "Blocked by" item is not complete. */
export const BLOCKED_PROP = { id: 'blocked', name: 'Is blocked', type: 'blocked' };

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const shortId = () => newId().slice(0, 8);
const norm = (s) => String(s ?? '').trim().toLowerCase();
const isEmpty = (v) => v == null || v === '' || (Array.isArray(v) && !v.length);

export function titleProp(db) {
  return { id: 'title', name: db.titleName || 'Name', type: 'title' };
}

/** All columns: title, user properties, then the built-in ones. */
export function allProps(db) {
  return [titleProp(db), ...db.properties, ...PSEUDO.slice(1), ...(db.dependencies ? [BLOCKED_PROP] : [])];
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
    (allowPseudo && ['last_edited', 'last_edited_time', 'updated', 'updated_at', 'last edited'].includes(k) ? PSEUDO[2] : null) ||
    (allowPseudo && db.dependencies && ['blocked', 'is_blocked'].includes(k) ? BLOCKED_PROP : null);
  if (!found) throw bad(`Unknown property "${key}". Properties: ${[titleProp(db), ...db.properties].map((p) => `"${p.name}"`).join(', ')}`);
  return found;
}

// ---------------------------------------------------------------------------
// Property definitions
// ---------------------------------------------------------------------------
const TYPE_ALIASES = { multiselect: 'multi_select', people: 'person', user: 'person', file: 'files', image: 'files', images: 'files', link: 'links', urls: 'links', id: 'unique_id', autonumber: 'unique_id', auto_number: 'unique_id' };

/** Group of a status option from its name, when none is given. */
export function inferGroup(name) {
  const n = norm(name);
  if (/(done|complete|finished|shipped|closed|resolved|launched|approved|published|cancel)/.test(n)) return 'complete';
  if (/(progress|doing|review|block|wait|test|start|active|working|ongoing|pending|qa)/.test(n) && !/not start/.test(n)) return 'in_progress';
  return 'todo';
}
export const groupId = (g) => {
  const k = norm(g).replace(/[\s-]+/g, '_');
  const hit = STATUS_GROUPS.find((x) => x.id === k || norm(x.name).replace(/[\s-]+/g, '_') === k) || (['to_do', 'todo', 'not_started'].includes(k) ? STATUS_GROUPS[0] : ['done', 'completed'].includes(k) ? STATUS_GROUPS[2] : null);
  if (!hit) throw bad(`Unknown status group "${g}". Groups: todo, in_progress, complete`);
  return hit.id;
};

/**
 * Validate and normalize a property definition from a create/update request.
 * env (needed for relation / rollup): { database(id) → { id, title, database } }.
 */
export function makeProperty(db, spec, env = {}) {
  const name = String(spec?.name || '').trim();
  if (!name) throw bad('Every property needs a name');
  const raw = String(spec.type || '').toLowerCase();
  const type = TYPE_ALIASES[raw] || raw;
  if (!PROPERTY_TYPES.includes(type)) throw bad(`Unknown property type "${spec.type}" for "${name}". Types: ${PROPERTY_TYPES.join(', ')}`);
  if ([titleProp(db), ...db.properties].some((p) => norm(p.name) === norm(name))) throw bad(`A property named "${name}" already exists`);
  const prop = { id: shortId(), name: name.slice(0, 60), type };
  configureProperty(db, prop, spec, env, true);
  return prop;
}

/** Apply the type-specific settings of a spec to a property (on create, and on update). */
export function configureProperty(db, prop, spec, env = {}, fresh = false) {
  const t = prop.type;
  if (t === 'select' || t === 'multi_select' || t === 'status') {
    prop.options ||= [];
    const opts = spec.options ?? (fresh && t === 'status' ? ['Not started', 'In progress', 'Done'] : []);
    for (const o of opts) addOption(prop, typeof o === 'string' ? o : o?.name, typeof o === 'object' ? o?.color : undefined, typeof o === 'object' ? o?.group : undefined);
  }
  if (['number', 'rollup', 'formula'].includes(t)) {
    if (spec.format !== undefined) {
      if (spec.format && !NUMBER_FORMATS.includes(spec.format)) throw bad(`Unknown number format "${spec.format}". Formats: ${NUMBER_FORMATS.join(', ')}`);
      prop.format = spec.format || undefined;
    }
    if (spec.display !== undefined) {
      if (spec.display && !['number', 'bar', 'ring'].includes(spec.display)) throw bad('display is "number", "bar" or "ring"');
      prop.display = spec.display || undefined;
    }
  }
  if (t === 'unique_id' && spec.prefix !== undefined) {
    const p = String(spec.prefix || '').trim().replace(/[^A-Za-z0-9_]/g, '').slice(0, 10);
    prop.prefix = p || undefined;
  }
  if (t === 'relation') {
    const target = spec.databaseId ?? spec.database_id ?? spec.database;
    if (fresh || target !== undefined) {
      if (!target) throw bad(`Relation "${prop.name}" needs database_id (the database whose items it links to)`);
      const d = env.database?.(target);
      if (!d) throw bad(`Relation "${prop.name}": "${target}" is not a database`);
      prop.databaseId = d.id;
    }
    if (spec.limit !== undefined) prop.limit = Number(spec.limit) === 1 ? 1 : undefined;
  }
  if (t === 'rollup') {
    if (fresh || spec.relation !== undefined) {
      const rel = resolveProp(db, spec.relation ?? '', { allowPseudo: false });
      if (rel.type !== 'relation') throw bad(`Rollup "${prop.name}": "${rel.name}" is not a relation property`);
      prop.relation = rel.id;
    }
    const rel = db.properties.find((p) => p.id === prop.relation);
    const target = rel && env.database?.(rel.databaseId);
    if (fresh || spec.property !== undefined) {
      if (!target) throw bad(`Rollup "${prop.name}": the related database is missing`);
      prop.target = resolveProp(target.database, spec.property ?? 'title').id;
    }
    if (fresh || spec.function !== undefined) {
      const f = String(spec.function || 'count').toLowerCase();
      if (!ROLLUP_FUNCTIONS.includes(f)) throw bad(`Unknown rollup function "${spec.function}". Functions: ${ROLLUP_FUNCTIONS.join(', ')}`);
      prop.function = f;
    }
    if (spec.value !== undefined) prop.value = spec.value == null ? undefined : String(spec.value);
    if (['count_where', 'percent_where'].includes(prop.function) && prop.value == null) throw bad(`Rollup "${prop.name}": ${prop.function} needs a value to look for, e.g. "Done" (or a status group like "@complete")`);
    if (fresh && /^percent/.test(prop.function) && !prop.format) prop.format = 'percent';
  }
  if (t === 'formula' && (fresh || spec.expression !== undefined)) {
    const expr = spec.expression ?? spec.formula;
    if (!String(expr ?? '').trim()) throw bad(`Formula "${prop.name}" needs an expression, e.g. prop("Done") / prop("Total")`);
    prop.formula = parseFormula(expr, (n) => {
      const p = resolveProp(db, n);
      if (p.id === prop.id) throw bad(`Formula "${prop.name}" can't refer to itself`);
      return p.id;
    });
  }
  return prop;
}

export function addOption(prop, name, color, group) {
  const n = String(name ?? '').trim();
  if (!n) throw bad(`Empty option for "${prop.name}"`);
  const existing = prop.options.find((o) => norm(o.name) === norm(n) || o.id === name);
  if (existing) {
    if (prop.type === 'status' && group) existing.group = groupId(group);
    return existing;
  }
  const o = { id: shortId(), name: n.slice(0, 60), color: OPTION_COLORS.includes(color) ? color : OPTION_COLORS[prop.options.length % OPTION_COLORS.length] };
  if (prop.type === 'status') {
    o.group = group ? groupId(group) : inferGroup(n);
    if (!OPTION_COLORS.includes(color)) o.color = STATUS_GROUPS.find((g) => g.id === o.group).color;
  }
  prop.options.push(o);
  if (prop.type === 'status') sortStatusOptions(prop);
  return o;
}
/** Keep status options ordered by group (To-do, In progress, Complete), stable inside a group. */
export function sortStatusOptions(prop) {
  const rank = (o) => STATUS_GROUPS.findIndex((g) => g.id === o.group);
  prop.options = prop.options.map((o, i) => [o, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([o]) => o);
}

/** Readable settings of a property (for get_database and the UI). */
export function describeProperty(db, p, env = {}) {
  const out = { id: p.id, name: p.name, type: p.type };
  if (p.options) out.options = p.options.map((o) => (p.type === 'status' ? { name: o.name, color: o.color, group: o.group } : o.name));
  if (p.format) out.format = p.format;
  if (p.display) out.display = p.display;
  if (p.type === 'unique_id') out.prefix = p.prefix || null;
  if (p.type === 'relation') {
    const target = env.database?.(p.databaseId);
    out.database = { id: p.databaseId, title: target?.title ?? '(deleted)' };
    if (p.limit) out.limit = p.limit;
    if (p.reverseId) out.reverseProperty = target?.database?.properties.find((x) => x.id === p.reverseId)?.name ?? null;
  }
  if (p.type === 'rollup') {
    const rel = db.properties.find((x) => x.id === p.relation);
    const target = rel && env.database?.(rel.databaseId);
    out.relation = rel?.name ?? null;
    out.property = target ? safeName(target.database, p.target) : null;
    out.function = p.function;
    if (p.value != null) out.value = p.value;
  }
  if (p.type === 'formula') out.expression = formulaText(p.formula, (id) => safeName(db, id));
  return out;
}
const safeName = (db, id) => {
  try {
    return resolveProp(db, id).name;
  } catch {
    return '(deleted)';
  }
};

// ---------------------------------------------------------------------------
// Dates: stored as { start: "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM:SSZ", end: same or null }
// ---------------------------------------------------------------------------
const pad = (n) => String(n).padStart(2, '0');
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const isoUtc = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
export const hasTime = (s) => /T\d/.test(String(s || ''));

/** "today", "tomorrow", "yesterday", "+7d", "-2w", "2026-11-20", "2026-11-08 00:51" (UTC), ISO date-times. */
export function parseDateString(s, today = new Date()) {
  const t = norm(s);
  if (!t) return null;
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (t === 'today') return ymd(base);
  if (t === 'now') return isoUtc(today);
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
  const dt = t.match(/^(\d{4}-\d{2}-\d{2})[t ](\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(z|utc|[+-]\d{2}:?\d{2})?$/);
  if (dt) {
    const zone = !dt[3] || dt[3] === 'z' || dt[3] === 'utc' ? 'Z' : dt[3].length === 5 ? `${dt[3].slice(0, 3)}:${dt[3].slice(3)}` : dt[3];
    const d = new Date(`${dt[1]}T${dt[2].length === 4 ? '0' + dt[2] : dt[2]}${zone}`);
    if (!isNaN(d.getTime())) return isoUtc(d);
  }
  throw bad(`Invalid date "${s}". Use YYYY-MM-DD, an ISO date-time like 2026-11-08T00:51:17Z, "today", "tomorrow" or a relative offset like "+7d".`);
}

export function parseDateValue(raw) {
  if (isEmpty(raw)) return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    const start = parseDateString(raw.start);
    if (!start) return null;
    const end = raw.end ? parseDateString(raw.end) : null;
    if (end && dateMs(end) < dateMs(start)) throw bad(`The end (${raw.end}) is before the start (${raw.start})`);
    return { start, end };
  }
  const s = String(raw);
  const range = s.split(/\s*(?:→|->|\/)\s*/);
  if (range.length === 2 && range[1]) return parseDateValue({ start: range[0], end: range[1] });
  return { start: parseDateString(s), end: null };
}
const dateMs = (s) => new Date(hasTime(s) ? s : s + 'T00:00:00Z').getTime();

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------
function fileList(raw, kind) {
  const list = Array.isArray(raw) ? raw : typeof raw === 'object' ? [raw] : String(raw).split(/\s*[\n,]\s*/);
  const out = [];
  for (const x of list) {
    if (isEmpty(x)) continue;
    const o = typeof x === 'object' ? x : { url: String(x) };
    const url = String(o.url || o.href || '').trim();
    if (!url) throw bad(`Each ${kind === 'files' ? 'file' : 'link'} needs a url`);
    if (!/^(https?:|mailto:)/i.test(url) && !/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(url)) throw bad(`"${url}" is not a link (use an https:// URL)`);
    const label = String(o.name ?? o.label ?? o.title ?? '').trim().slice(0, 200);
    const item = { url: url.slice(0, 2000) };
    if (label) item[kind === 'files' ? 'name' : 'label'] = label;
    if (kind === 'files' && o.storageId) item.storageId = String(o.storageId);
    const thumb = String(o.thumbnail || '').trim();
    if (kind === 'files' && /^https?:\/\//i.test(thumb)) item.thumbnail = thumb.slice(0, 2000);
    if (o.import === true) throw bad(`Files with "import": true are imported by the MCP tools; "${url}" reached the database without being imported`);
    out.push(item);
  }
  if (out.length > 50) throw bad('At most 50 entries');
  return out;
}

/**
 * Turn what a person or an agent typed into the stored value.
 * Select options are matched by name (any case) and created when new.
 * People are matched by user id, email, or an unambiguous name ("me" = the caller).
 * ctx: { members, me, agentId, resolveRow(databaseId, idOrTitle) → id }
 */
export function parseValue(prop, raw, ctx = {}) {
  if (prop.type === 'checkbox') {
    if (typeof raw === 'string') return ['true', 'yes', 'y', '1', 'done', 'checked', 'x'].includes(norm(raw));
    return !!raw;
  }
  if (READ_ONLY_TYPES.includes(prop.type) || ['created_time', 'last_edited_time', 'blocked'].includes(prop.type)) throw bad(`"${prop.name}" (${prop.type}) is computed and can't be set`);
  if (isEmpty(raw)) return null;
  switch (prop.type) {
    case 'title':
    case 'text':
      return String(raw).slice(0, 5000);
    case 'url':
    case 'email':
      return String(raw).trim().slice(0, 2000);
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[,\s$€£¥₽%]/g, ''));
      if (!Number.isFinite(n)) throw bad(`"${prop.name}" needs a number, got "${raw}"`);
      return typeof raw === 'string' && /%\s*$/.test(raw) && prop.format === 'percent' ? n / 100 : n;
    }
    case 'select':
    case 'status':
      return addOption(prop, Array.isArray(raw) ? raw[0] : typeof raw === 'object' ? raw.name : raw).id;
    case 'multi_select': {
      const list = Array.isArray(raw) ? raw : String(raw).split(',');
      return [...new Set(list.map((x) => String(x).trim()).filter(Boolean).map((x) => addOption(prop, x).id))];
    }
    case 'date':
      return parseDateValue(raw);
    case 'person': {
      const list = Array.isArray(raw) ? raw : String(raw).split(',');
      return [...new Set(list.map((x) => resolveMember(x, ctx)).filter(Boolean))];
    }
    case 'relation': {
      const list = Array.isArray(raw) ? raw : typeof raw === 'string' && !ctx.resolveRow ? raw.split(',') : [raw];
      if (!ctx.resolveRow) throw bad('Relations can only be set on the server');
      const ids = [...new Set(list.filter((x) => !isEmpty(x)).map((x) => ctx.resolveRow(prop.databaseId, typeof x === 'object' ? x.id || x.title : x)))];
      return prop.limit === 1 ? ids.slice(-1) : ids;
    }
    case 'files':
    case 'links':
      return fileList(raw, prop.type);
    default:
      throw bad(`Property "${prop.name}" (${prop.type}) can't be set directly`);
  }
}

export function resolveMember(who, { members = [], me, agentId } = {}) {
  const s = String(typeof who === 'object' && who ? who.id || who.email || who.name : who ?? '').trim();
  if (!s) return null;
  const k = norm(s);
  if (['me', '@me', 'myself'].includes(k)) {
    if (!me) throw bad('"me" is not available here');
    return me;
  }
  if (['@agent', 'agent', 'this agent', 'yourself'].includes(k)) {
    if (!agentId) throw bad('"@agent" only works for an AI agent connected with a token');
    return agentId;
  }
  const byId = members.find((m) => m.id === s);
  if (byId) return byId.id;
  const byEmail = members.find((m) => m.email && norm(m.email) === k);
  if (byEmail) return byEmail.id;
  let hits = members.filter((m) => norm(m.name) === k);
  if (!hits.length) hits = members.filter((m) => norm(m.name).split(/\s+/)[0] === k);
  if (hits.length === 1) return hits[0].id;
  const list = members.map((m) => `${m.name}${m.email ? ` <${m.email}>` : m.kind === 'agent' ? ' (AI agent)' : ''} (id ${m.id})`).join('; ');
  if (hits.length > 1) throw bad(`"${s}" matches several members; use an email or id. Members: ${list}`);
  throw bad(`"${s}" is not a member of this workspace. Members: ${list || 'none'}`);
}

/** Stored (or computed) value of any column for a row. */
export function rawValue(row, prop) {
  if (prop.type === 'title') return row.title || '';
  if (prop.type === 'created_time') return row.createdAt || null;
  if (prop.type === 'last_edited_time') return row.updatedAt || null;
  if (prop.type === 'blocked') return !!row.props?.blocked;
  return row.props?.[prop.id] ?? (prop.type === 'checkbox' ? false : null);
}

export const uniqueIdText = (prop, n) => (n == null ? null : prop.prefix ? `${prop.prefix}-${n}` : String(n));
const dateText = (v) => (v.end ? `${v.start} → ${v.end}` : v.start);

/**
 * JSON friendly value: option names, member names, "start → end" dates, related item titles.
 * env: { titleOf(id) } for relations.
 */
export function displayValue(prop, value, members = [], env = {}) {
  if (prop.type === 'checkbox' || prop.type === 'blocked') return !!value;
  if (isEmpty(value)) return null;
  switch (prop.type) {
    case 'select':
    case 'status':
      return prop.options.find((o) => o.id === value)?.name ?? null;
    case 'multi_select':
      return value.map((id) => prop.options.find((o) => o.id === id)?.name).filter(Boolean);
    case 'person':
      return value.map((id) => members.find((m) => m.id === id)?.name || 'Former member');
    case 'date':
      return dateText(value);
    case 'relation':
      return value.map((id) => env.titleOf?.(id) ?? id);
    case 'unique_id':
      return uniqueIdText(prop, value);
    case 'rollup':
    case 'formula':
      return typeof value === 'object' && !Array.isArray(value) ? dateText(value) : value;
    default:
      return value;
  }
}

/** Plain text for search and for type conversions. */
export function valueText(prop, value, members = [], env = {}) {
  const d = displayValue(prop, value, members, env);
  if (d == null) return '';
  if (prop.type === 'files') return d.map((f) => f.name || f.url).join(', ');
  if (prop.type === 'links') return d.map((f) => (f.label ? `${f.label} ${f.url}` : f.url)).join(', ');
  return Array.isArray(d) ? d.map(valueToText).join(', ') : valueToText(d);
}

const CURRENCY = { dollar: '$', euro: '€', pound: '£', yen: '¥', ruble: '₽' };
/** Show a number in a property's format: 0.42 → "42%", 1200 → "$1,200". */
export function formatNumber(n, format) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return n == null ? '' : String(n);
  if (format === 'percent') return `${Math.round(n * 1000) / 10}%`;
  const fixed = Math.round(n * 100) / 100;
  if (CURRENCY[format]) return `${CURRENCY[format]}${fixed.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(fixed) ? 0 : 2, maximumFractionDigits: 2 })}`;
  if (format === 'number_with_commas') return fixed.toLocaleString('en-US');
  return String(Math.round(n * 1e6) / 1e6);
}

// ---------------------------------------------------------------------------
// Rollups and table footers: reduce a list of values of one property.
// ---------------------------------------------------------------------------
function isComplete(prop, v) {
  if (prop.type === 'status') return prop.options.find((o) => o.id === v)?.group === 'complete';
  if (prop.type === 'checkbox' || prop.type === 'blocked') return !!v;
  if (prop.type === 'select') return !!v && inferGroup(prop.options.find((o) => o.id === v)?.name) === 'complete';
  return false;
}
/** The property that says whether an item is finished: a status, else a "Status" select, else a "Done" checkbox. */
export function completionProp(d) {
  return d.properties.find((p) => p.type === 'status') || d.properties.find((p) => p.type === 'select' && /status|state/i.test(p.name)) || d.properties.find((p) => p.type === 'checkbox' && /done|complete/i.test(p.name)) || null;
}

/** Does one value match `want` (an option / text, or "@complete", "@todo", "@in_progress")? */
function valueIs(prop, v, want, ctx) {
  const w = String(want ?? '');
  if (w.startsWith('@') && prop.type === 'status') {
    const g = groupId(w.slice(1));
    return prop.options.find((o) => o.id === v)?.group === g;
  }
  if (prop.type === 'checkbox') return !!v === ['true', 'yes', '1', 'checked', 'x'].includes(norm(w));
  const text = valueText(prop, v, ctx.members, ctx);
  return norm(text) === norm(w) || (Array.isArray(displayValue(prop, v, ctx.members, ctx)) && displayValue(prop, v, ctx.members, ctx).some((x) => norm(valueToText(x)) === norm(w)));
}

export function reduceValues(prop, values, fn, { value, members = [], titleOf } = {}) {
  const ctx = { members, titleOf };
  const empties = values.filter((v) => (prop.type === 'checkbox' ? false : isEmpty(v))).length;
  const filled = values.filter((v) => !isEmpty(v));
  const total = values.length;
  const numsOf = () =>
    filled
      .flatMap((v) => (Array.isArray(v) ? v : [v]))
      .map((v) => (typeof v === 'number' ? v : prop.type === 'unique_id' ? Number(v) : Number(v)))
      .filter((n) => Number.isFinite(n));
  const datesOf = () =>
    filled
      .map((v) => (typeof v === 'object' && v && 'start' in v ? v : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? { start: v, end: null } : null))
      .filter(Boolean);
  switch (fn) {
    case 'show_original':
      return filled.flatMap((v) => {
        const d = displayValue(prop, v, members, ctx);
        if (prop.type === 'files' || prop.type === 'links') return d.map((x) => x.name || x.label || x.url);
        return Array.isArray(d) ? d.map(valueToText) : [valueToText(d)];
      });
    case 'count':
      return total;
    case 'count_values':
      return filled.reduce((s, v) => s + (Array.isArray(v) ? v.length : 1), 0);
    case 'count_unique':
      return new Set(filled.flatMap((v) => (Array.isArray(v) ? v : [v])).map((v) => JSON.stringify(v))).size;
    case 'count_empty':
      return prop.type === 'checkbox' ? 0 : empties;
    case 'count_not_empty':
      return prop.type === 'checkbox' ? total : total - empties;
    case 'percent_empty':
      return total ? empties / total : null;
    case 'percent_not_empty':
      return total ? (total - empties) / total : null;
    case 'sum':
      return numsOf().reduce((s, n) => s + n, 0);
    case 'average': {
      const n = numsOf();
      return n.length ? n.reduce((s, x) => s + x, 0) / n.length : null;
    }
    case 'median': {
      const n = numsOf().sort((a, b) => a - b);
      if (!n.length) return null;
      const m = Math.floor(n.length / 2);
      return n.length % 2 ? n[m] : (n[m - 1] + n[m]) / 2;
    }
    case 'min':
    case 'max': {
      const n = numsOf();
      return n.length ? Math[fn](...n) : null;
    }
    case 'range': {
      const n = numsOf();
      return n.length ? Math.max(...n) - Math.min(...n) : null;
    }
    case 'earliest_date':
    case 'latest_date':
    case 'date_range': {
      const ds = datesOf();
      if (!ds.length) return null;
      const starts = ds.map((d) => d.start).sort((a, b) => dateMs(a) - dateMs(b));
      const ends = ds.map((d) => d.end || d.start).sort((a, b) => dateMs(a) - dateMs(b));
      if (fn === 'earliest_date') return { start: starts[0], end: null };
      if (fn === 'latest_date') return { start: ends[ends.length - 1], end: null };
      return { start: starts[0], end: ends[ends.length - 1] };
    }
    case 'checked':
    case 'unchecked':
    case 'percent_checked':
    case 'percent_unchecked': {
      const done = values.filter((v) => (prop.type === 'checkbox' || prop.type === 'blocked' ? !!v : isComplete(prop, v))).length;
      if (fn === 'checked') return done;
      if (fn === 'unchecked') return total - done;
      if (!total) return null;
      return fn === 'percent_checked' ? done / total : (total - done) / total;
    }
    case 'count_where':
    case 'percent_where': {
      const hits = values.filter((v) => valueIs(prop, v, value, ctx)).length;
      if (fn === 'count_where') return hits;
      return total ? hits / total : null;
    }
  }
  throw bad(`Unknown function "${fn}"`);
}

// ---------------------------------------------------------------------------
// Computed values for whole databases (rollups, formulas, "is blocked").
// pages: { id → page } of one workspace.
// ---------------------------------------------------------------------------
export function createComputer({ pages, members = [] }) {
  const kids = new Map();
  for (const p of Object.values(pages)) {
    if (!p.parentId || p.archivedAt) continue;
    if (!kids.has(p.parentId)) kids.set(p.parentId, []);
    kids.get(p.parentId).push(p);
  }
  for (const list of kids.values()) list.sort((a, b) => a.position - b.position);
  const live = (id) => {
    const p = pages[id];
    if (!p || p.archivedAt) return null;
    const parent = p.parentId ? pages[p.parentId] : null;
    return parent && parent.archivedAt ? null : p;
  };
  const titleOf = (id) => (live(id) ? pages[id].title || 'Untitled' : null);
  const cache = new Map(); // db id → Map(row id → enriched row)
  const busy = new Set();

  function enrichedMap(dbId) {
    if (cache.has(dbId)) return cache.get(dbId);
    const dbPage = pages[dbId];
    const map = new Map();
    if (!dbPage?.database) return map;
    if (busy.has(dbId)) {
      // a rollup that loops back here: use stored values only
      for (const r of kids.get(dbId) || []) map.set(r.id, r);
      return map;
    }
    busy.add(dbId);
    const d = dbPage.database;
    const rows = kids.get(dbId) || [];
    const rollups = d.properties.filter((p) => p.type === 'rollup');
    const formulas = d.properties.filter((p) => p.type === 'formula');
    const completeProp = completionProp(d);
    const blockedBy = d.dependencies ? d.properties.find((p) => p.id === d.dependencies.blockedBy) : null;
    for (const row of rows) {
      const props = { ...(row.props || {}) };
      // drop links to deleted / trashed items
      for (const p of d.properties) if (p.type === 'relation' && Array.isArray(props[p.id])) props[p.id] = props[p.id].filter((id) => live(id));
      const r = { ...row, props };
      for (const p of rollups) {
        try {
          const rel = d.properties.find((x) => x.id === p.relation);
          const target = rel && pages[rel.databaseId];
          if (!target?.database) {
            props[p.id] = null;
            continue;
          }
          const tProp = resolveProp(target.database, p.target);
          const tRows = enrichedMap(target.id);
          const vals = (props[rel.id] || []).map((id) => tRows.get(id) || pages[id]).filter(Boolean).map((x) => rawValue(x, tProp));
          props[p.id] = reduceValues(tProp, vals, p.function, { value: p.value, members, titleOf });
        } catch {
          props[p.id] = null;
        }
      }
      if (blockedBy) {
        props.blocked = (props[blockedBy.id] || []).some((id) => {
          const b = pages[id];
          return b && !(completeProp && isComplete(completeProp, rawValue(b, completeProp)));
        });
      }
      // formulas may use each other: evaluate on demand, once each
      const done = new Map();
      const evaluating = new Set();
      const get = (id) => {
        const p = id === 'title' ? titleProp(d) : allProps(d).find((x) => x.id === id);
        if (!p) return null;
        if (p.type === 'formula') {
          if (done.has(p.id)) return done.get(p.id);
          if (evaluating.has(p.id)) return null;
          evaluating.add(p.id);
          let v = null;
          try {
            v = evalFormula(p.formula, (pid) => formulaInput(pid));
            if (typeof v === 'number' && !Number.isFinite(v)) v = null;
          } catch {
            v = null;
          }
          evaluating.delete(p.id);
          done.set(p.id, v);
          return v;
        }
        return formulaInput(id);
      };
      const formulaInput = (id) => {
        const p = id === 'title' ? titleProp(d) : allProps(d).find((x) => x.id === id);
        if (!p) return null;
        if (p.type === 'formula') return get(id);
        const v = rawValue(r, p);
        switch (p.type) {
          case 'select':
          case 'status':
          case 'multi_select':
          case 'person':
          case 'relation':
            return displayValue(p, v, members, { titleOf });
          case 'unique_id':
            return uniqueIdText(p, v);
          case 'files':
            return (v || []).map((f) => f.name || f.url);
          case 'links':
            return (v || []).map((f) => f.label || f.url);
          case 'created_time':
          case 'last_edited_time':
            return v ? { start: v.replace(/\.\d{3}Z$/, 'Z'), end: null } : null;
          default:
            return v;
        }
      };
      for (const p of formulas) props[p.id] = get(p.id);
      map.set(row.id, r);
    }
    busy.delete(dbId);
    cache.set(dbId, map);
    return map;
  }

  return {
    titleOf,
    /** Live rows of a database with computed values filled in, in manual order. */
    rows: (dbId) => [...enrichedMap(dbId).values()],
    row: (dbId, rowId) => enrichedMap(dbId).get(rowId) || null,
  };
}

// ---------------------------------------------------------------------------
// Filters & sorts
// Filter: { property, operator, value } — a list is AND-ed; { or: [filters] } is OR.
// ---------------------------------------------------------------------------
const OP_ALIASES = { '=': 'equals', is: 'equals', eq: 'equals', '!=': 'not_equals', is_not: 'not_equals', '>': 'greater_than', '<': 'less_than', '>=': 'greater_or_equal', '<=': 'less_or_equal', gt: 'greater_than', lt: 'less_than', gte: 'greater_or_equal', lte: 'less_or_equal', group: 'in_group', is_group: 'in_group' };

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
    if (['in_group', 'not_in_group'].includes(operator)) {
      if (!['status', 'select'].includes(prop.type)) throw bad(`in_group works on status properties; "${prop.name}" is ${prop.type}`);
      return { property: prop.id, operator, value: groupId(f.value) };
    }
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
/** A filter value, with "@this_page" replaced by the page a linked view sits on. */
function wantFor(want, prop, ctx) {
  if (want !== THIS_PAGE) return want;
  if (!ctx.thisPage) return null;
  return prop.type === 'relation' ? ctx.thisPage.id : ctx.thisPage.title;
}
const groupOf = (prop, v) => (prop.type === 'status' ? prop.options.find((o) => o.id === v)?.group : v ? inferGroup(prop.options?.find((o) => o.id === v)?.name) : null);

function compareDates(prop, v, want, op, negate) {
  if (v == null) return negate;
  const raw = typeof want === 'object' && want ? want.start : want;
  const b = parseDateString(raw);
  if (!b) return negate;
  let a;
  let w;
  if (hasTime(b)) {
    const s = prop.type === 'date' || typeof v === 'object' ? v.start : v;
    a = new Date(hasTime(s) ? s : s + 'T00:00:00Z').getTime();
    w = new Date(b).getTime();
  } else {
    a = prop.type === 'date' || (typeof v === 'object' && v) ? dateKey(v) : ymd(new Date(v));
    w = b;
  }
  const hit = { equals: a === w, contains: a === w, before: a < w, less_than: a < w, after: a > w, greater_than: a > w, on_or_before: a <= w, less_or_equal: a <= w, on_or_after: a >= w, greater_or_equal: a >= w }[op];
  if (hit === undefined) throw bad(`Operator "${op}" doesn't apply to date "${prop.name}"`);
  return hit;
}

function matchOne(db, row, f, ctx) {
  const prop = resolveProp(db, f.property);
  const v = rawValue(row, prop);
  const want = wantFor(f.value, prop, ctx);
  const empty = prop.type === 'checkbox' || prop.type === 'blocked' ? !v : isEmpty(v);
  switch (f.operator) {
    case 'is_empty':
      return empty;
    case 'is_not_empty':
      return !empty;
    case 'in_group':
      return groupOf(prop, v) === f.value;
    case 'not_in_group':
      return groupOf(prop, v) !== f.value;
  }
  if (f.value === THIS_PAGE && want == null) return false; // not on a page: nothing matches
  const wants = Array.isArray(want) ? want : [want];
  const negate = f.operator === 'not_equals' || f.operator === 'not_contains';
  const op = negate ? (f.operator === 'not_equals' ? 'equals' : 'contains') : f.operator;
  let hit;
  switch (prop.type) {
    case 'checkbox':
    case 'blocked':
      hit = !!v === parseValue({ type: 'checkbox' }, want);
      break;
    case 'select':
    case 'status':
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
    case 'relation':
      hit = wants.some((w) => (v || []).some((id) => id === w || norm(ctx.titleOf?.(id)) === norm(w)));
      if (op === 'equals' && (v || []).length > 1 && !negate) hit = hit && (v || []).length === wants.length;
      break;
    case 'files':
    case 'links':
      hit = wants.some((w) => norm(valueText(prop, v)).includes(norm(w)));
      break;
    case 'unique_id':
    case 'number': {
      const n = prop.type === 'unique_id' ? Number(String(want).replace(/^[A-Za-z_]+-/, '')) : Number(want);
      if (v == null) return negate;
      hit = { equals: v === n, contains: v === n, greater_than: v > n, less_than: v < n, greater_or_equal: v >= n, less_or_equal: v <= n }[op];
      if (hit === undefined) throw bad(`Operator "${f.operator}" doesn't apply to number "${prop.name}"`);
      break;
    }
    case 'date':
    case 'created_time':
    case 'last_edited_time':
      return negate ? !compareDates(prop, v, want, op, negate) : compareDates(prop, v, want, op, negate);
    case 'rollup':
    case 'formula': {
      if (v == null) return negate;
      if (typeof v === 'number') {
        const n = Number(want);
        hit = { equals: v === n, contains: v === n, greater_than: v > n, less_than: v < n, greater_or_equal: v >= n, less_or_equal: v <= n }[op];
      } else if (typeof v === 'boolean') hit = v === parseValue({ type: 'checkbox' }, want);
      else if (typeof v === 'object' && !Array.isArray(v)) hit = compareDates({ type: 'date', name: prop.name }, v, want, op, negate);
      else {
        const items = Array.isArray(v) ? v.map((x) => norm(valueToText(x))) : [norm(v)];
        hit = op === 'equals' ? wants.some((w) => items.includes(norm(w)) || items.join(', ') === norm(w)) : op === 'contains' ? wants.some((w) => items.some((s) => s.includes(norm(w)))) : undefined;
      }
      if (hit === undefined) throw bad(`Operator "${f.operator}" doesn't apply to "${prop.name}"`);
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

/** ctx: { members, me, agentId, titleOf(id), thisPage: { id, title } } */
export function matches(db, row, filters, ctx = {}) {
  return (filters || []).every((f) => (f.or ? f.or.some((g) => matches(db, row, [g], ctx)) : f.and ? matches(db, row, f.and, ctx) : matchOne(db, row, f, ctx)));
}

function sortKey(prop, v, ctx) {
  if (prop.type === 'checkbox' || prop.type === 'blocked') return v ? 1 : 0;
  if (isEmpty(v)) return null;
  if (prop.type === 'number' || prop.type === 'unique_id') return v;
  if (prop.type === 'date') return v.start;
  if (prop.type === 'select' || prop.type === 'status') return prop.options.findIndex((o) => o.id === v); // option order, like Notion
  if (prop.type === 'rollup' || prop.type === 'formula') {
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'object' && !Array.isArray(v)) return v.start;
  }
  return norm(valueText(prop, v, ctx.members, ctx));
}

/** Sort rows (empties last). Without sorts, keeps manual order (position). */
export function sortRows(db, rows, sorts, ctx = {}) {
  if (Array.isArray(ctx)) ctx = { members: ctx };
  const keyed = (sorts || []).map((s) => ({ prop: resolveProp(db, s.property), dir: s.direction === 'descending' ? -1 : 1 }));
  return [...rows].sort((a, b) => {
    for (const { prop, dir } of keyed) {
      const x = sortKey(prop, rawValue(a, prop), ctx);
      const y = sortKey(prop, rawValue(b, prop), ctx);
      if (x === y) continue;
      if (x == null) return 1;
      if (y == null) return -1;
      return (x < y ? -1 : 1) * dir;
    }
    return (a.position ?? 0) - (b.position ?? 0);
  });
}

export function searchRows(db, rows, q, ctx = {}) {
  if (Array.isArray(ctx)) ctx = { members: ctx };
  const k = norm(q);
  if (!k) return rows;
  const props = db.properties.filter((p) => ['text', 'url', 'email', 'select', 'status', 'multi_select', 'person', 'relation', 'links', 'files', 'unique_id', 'formula'].includes(p.type));
  return rows.filter((r) => norm(r.title).includes(k) || props.some((p) => norm(valueText(p, r.props?.[p.id], ctx.members, ctx)).includes(k)));
}

/** Apply a view (or ad-hoc filters/sorts) to rows. */
export function applyView(db, rows, { filters = [], sorts = [], search = '' } = {}, ctx = {}) {
  const filtered = searchRows(db, rows, search, ctx).filter((r) => matches(db, r, filters, ctx));
  return sortRows(db, filtered, sorts, ctx);
}

/** Footer values of a view: { propId: { function, value, text } }. */
export function aggregateView(db, rows, aggregations = {}, ctx = {}) {
  const out = {};
  for (const [id, fn] of Object.entries(aggregations || {})) {
    let prop;
    try {
      prop = resolveProp(db, id);
    } catch {
      continue;
    }
    const value = reduceValues(prop, rows.map((r) => rawValue(r, prop)), fn, ctx);
    out[id] = { function: fn, value, text: aggregateText(prop, fn, value) };
  }
  return out;
}
export function aggregateText(prop, fn, value) {
  if (value == null) return '—';
  if (typeof value === 'object' && !Array.isArray(value)) return dateText(value);
  if (/^percent/.test(fn)) return formatNumber(value, 'percent');
  if (['sum', 'average', 'median', 'min', 'max', 'range'].includes(fn)) return formatNumber(value, prop.format);
  return String(value);
}

/** Board columns for a group-by property: [{ key, name, color, group }] plus "No value". */
export function groupsFor(prop, members = []) {
  if (prop.type === 'select') return [{ key: null, name: `No ${prop.name}` }, ...prop.options.map((o) => ({ key: o.id, name: o.name, color: o.color }))];
  if (prop.type === 'status') return [{ key: null, name: `No ${prop.name}` }, ...prop.options.map((o) => ({ key: o.id, name: o.name, color: o.color, group: o.group }))];
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

const DATE_LIKE = ['date', 'created_time', 'last_edited_time'];
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
  if (spec.dateProperty !== undefined) {
    if (spec.dateProperty) {
      const p = resolveProp(db, spec.dateProperty);
      if (!DATE_LIKE.includes(p.type)) throw bad(`"${p.name}" is not a date property`);
      view.dateProperty = p.id;
    } else delete view.dateProperty;
  }
  if (spec.endProperty !== undefined) {
    if (spec.endProperty) {
      const p = resolveProp(db, spec.endProperty);
      if (!DATE_LIKE.includes(p.type)) throw bad(`"${p.name}" is not a date property`);
      view.endProperty = p.id;
    } else delete view.endProperty;
  }
  if (spec.coverProperty !== undefined) {
    if (spec.coverProperty && !['none', 'content'].includes(spec.coverProperty)) {
      const p = resolveProp(db, spec.coverProperty, { allowPseudo: false });
      if (p.type !== 'files') throw bad(`A gallery cover must be a files property; "${p.name}" is ${p.type}`);
      view.coverProperty = p.id;
    } else if (spec.coverProperty) view.coverProperty = spec.coverProperty;
    else delete view.coverProperty;
  }
  if (spec.cardSize !== undefined) {
    if (spec.cardSize && !['small', 'medium', 'large'].includes(spec.cardSize)) throw bad('card_size is small, medium or large');
    view.cardSize = spec.cardSize || undefined;
  }
  if (spec.aggregations !== undefined) {
    const agg = {};
    for (const [k, fn] of Object.entries(spec.aggregations || {})) {
      if (!fn) continue;
      const p = resolveProp(db, k);
      const f = String(fn).toLowerCase();
      if (!AGGREGATIONS.includes(f)) throw bad(`Unknown calculation "${fn}". Calculations: ${AGGREGATIONS.join(', ')}`);
      agg[p.id] = f;
    }
    view.aggregations = Object.keys(agg).length ? agg : undefined;
  }
  if (spec.showSubItems !== undefined) view.showSubItems = spec.showSubItems === false ? false : undefined;
  if (view.type === 'board' && !view.groupBy) {
    const g = db.properties.find((p) => p.type === 'status') || db.properties.find((p) => p.type === 'select') || db.properties.find((p) => GROUPABLE.includes(p.type));
    if (!g) throw bad('A board view needs a status, select, person or checkbox property to group by');
    view.groupBy = g.id;
  }
  if ((view.type === 'calendar' || view.type === 'timeline') && !view.dateProperty) {
    const p = db.properties.find((x) => x.type === 'date');
    if (!p) throw bad(`A ${view.type} view needs a date property`);
    view.dateProperty = p.id;
  }
  if (!existing && spec.name === undefined) view.name = view.type[0].toUpperCase() + view.type.slice(1);
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
  for (const k of ['dateProperty', 'endProperty', 'coverProperty', 'cardSize', 'aggregations', 'showSubItems']) {
    if (v?.[k] === undefined) continue;
    if (strict || k === 'cardSize' || k === 'showSubItems' || (k === 'coverProperty' && ['none', 'content'].includes(v[k]))) spec[k] = v[k];
    else if (k === 'aggregations') spec[k] = Object.fromEntries(Object.entries(v[k] || {}).filter(([id]) => known(id)));
    else if (known(v[k])) spec[k] = v[k];
  }
  if (!strict && spec.type === 'board' && !spec.groupBy && !db.properties.some((p) => GROUPABLE.includes(p.type))) spec.type = 'table';
  if (!strict && ['calendar', 'timeline'].includes(spec.type) && !spec.dateProperty && !db.properties.some((p) => p.type === 'date')) spec.type = 'table';
  return makeView(db, spec, { id: v?.id || shortId(), name: '', type: 'table', filters: [], sorts: [], groupBy: null, visible: null });
}

/** Drop references to a removed property from every view. */
export function forgetProperty(db, propId) {
  const strip = (fs) => fs.filter((f) => (f.or ? ((f.or = strip(f.or)), f.or.length) : f.and ? ((f.and = strip(f.and)), f.and.length) : f.property !== propId));
  for (const v of db.views) {
    v.filters = strip(v.filters || []);
    v.sorts = (v.sorts || []).filter((s) => s.property !== propId);
    if (v.visible) v.visible = v.visible.filter((id) => id !== propId);
    if (v.aggregations) delete v.aggregations[propId];
    if (v.coverProperty === propId) delete v.coverProperty;
    if (v.groupBy === propId) {
      v.groupBy = null;
      if (v.type === 'board') v.type = 'table';
    }
    if (v.dateProperty === propId || v.endProperty === propId) {
      if (v.endProperty === propId) delete v.endProperty;
      if (v.dateProperty === propId) {
        delete v.dateProperty;
        if (['calendar', 'timeline'].includes(v.type)) v.type = 'table';
      }
    }
  }
}

/** Properties a formula / rollup depends on (to refuse removing them). */
export function dependents(db, propId) {
  return db.properties.filter((p) => (p.type === 'formula' && formulaProps(p.formula).has(propId)) || (p.type === 'rollup' && p.relation === propId));
}

export { formulaText, valueToText };
