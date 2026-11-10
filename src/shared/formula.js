// Formula properties: a small, safe expression language (no eval).
//
//   prop("Scenes illustrated") / prop("Scenes")
//   if(prop("Done"), "✓", concat(prop("Left"), " left"))
//   dateBetween(prop("Finished"), prop("Started"), "minutes")
//
// Expressions are parsed once when the property is saved. Property references are stored
// by id in the syntax tree, so renaming a property keeps the formula working; the text is
// regenerated from the tree with the current names.

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------
function tokenize(src) {
  const out = [];
  let i = 0;
  const s = String(src ?? '');
  if (s.length > 2000) throw bad('Formula is too long (max 2000 characters)');
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(s[i + 1] || ''))) {
      const m = s.slice(i).match(/^\d*\.?\d+(?:e[+-]?\d+)?/i);
      out.push({ t: 'num', v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (c === '"' || c === "'" || c === '“' || c === '”') {
      const close = c === '“' ? '”' : c;
      let j = i + 1;
      let str = '';
      while (j < s.length && s[j] !== close && !(close === '”' && s[j] === '"')) {
        if (s[j] === '\\' && j + 1 < s.length) {
          str += s[j + 1];
          j += 2;
        } else str += s[j++];
      }
      if (j >= s.length) throw bad('Unclosed string in formula');
      out.push({ t: 'str', v: str });
      i = j + 1;
      continue;
    }
    const two = s.slice(i, i + 2);
    if (['==', '!=', '>=', '<=', '&&', '||'].includes(two)) {
      out.push({ t: 'op', v: two });
      i += 2;
      continue;
    }
    if ('+-*/%()<>,!=?:'.includes(c)) {
      out.push({ t: c === '(' || c === ')' || c === ',' ? c : 'op', v: c === '=' ? '==' : c });
      i++;
      continue;
    }
    const m = s.slice(i).match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (m) {
      out.push({ t: 'id', v: m[0] });
      i += m[0].length;
      continue;
    }
    throw bad(`Unexpected "${c}" in formula`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parser → tree. Nodes: {k:'lit', v} {k:'prop', id} {k:'call', f, args} {k:'bin', op, a, b} {k:'un', op, a} {k:'if', c, a, b}
// ---------------------------------------------------------------------------
export const FUNCTIONS = {
  if: [2, 3],
  concat: [0, 50],
  join: [1, 2],
  length: [1, 1],
  empty: [1, 1],
  not: [1, 1],
  round: [1, 2],
  floor: [1, 1],
  ceil: [1, 1],
  abs: [1, 1],
  sqrt: [1, 1],
  pow: [2, 2],
  min: [1, 50],
  max: [1, 50],
  sum: [1, 50],
  average: [1, 50],
  toNumber: [1, 1],
  format: [1, 1],
  lower: [1, 1],
  upper: [1, 1],
  trim: [1, 1],
  contains: [2, 2],
  startsWith: [2, 2],
  replace: [3, 3],
  slice: [2, 3],
  now: [0, 0],
  today: [0, 0],
  dateBetween: [3, 3],
  dateAdd: [3, 3],
  formatDate: [1, 2],
  start: [1, 1],
  end: [1, 1],
  year: [1, 1],
  month: [1, 1],
  day: [1, 1],
  coalesce: [1, 50],
  percent: [2, 2],
};

export function parseFormula(src, resolveProp) {
  const toks = tokenize(src);
  let i = 0;
  const peek = () => toks[i];
  const take = () => toks[i++];
  const isOp = (...ops) => peek()?.t === 'op' && ops.includes(peek().v);
  const isWord = (...w) => peek()?.t === 'id' && w.includes(peek().v.toLowerCase());
  const expect = (t) => {
    const x = take();
    if (!x || x.t !== t) throw bad(`Formula: expected "${t}"${x ? ` but found "${x.v ?? x.t}"` : ' at the end'}`);
    return x;
  };

  const ternary = () => {
    const c = or();
    if (isOp('?')) {
      take();
      const a = ternary();
      if (!isOp(':')) throw bad('Formula: expected ":" in "a ? b : c"');
      take();
      return { k: 'if', c, a, b: ternary() };
    }
    return c;
  };
  const or = () => {
    let a = and();
    while (isOp('||') || isWord('or')) {
      take();
      a = { k: 'bin', op: '||', a, b: and() };
    }
    return a;
  };
  const and = () => {
    let a = not();
    while (isOp('&&') || isWord('and')) {
      take();
      a = { k: 'bin', op: '&&', a, b: not() };
    }
    return a;
  };
  const not = () => {
    if (isOp('!') || (isWord('not') && toks[i + 1]?.t !== '(')) {
      take();
      return { k: 'un', op: '!', a: not() };
    }
    return cmp();
  };
  const cmp = () => {
    const a = add();
    if (isOp('==', '!=', '>', '<', '>=', '<=')) {
      const op = take().v;
      return { k: 'bin', op, a, b: add() };
    }
    return a;
  };
  const add = () => {
    let a = mul();
    while (isOp('+', '-')) {
      const op = take().v;
      a = { k: 'bin', op, a, b: mul() };
    }
    return a;
  };
  const mul = () => {
    let a = unary();
    while (isOp('*', '/', '%')) {
      const op = take().v;
      a = { k: 'bin', op, a, b: unary() };
    }
    return a;
  };
  const unary = () => {
    if (isOp('-')) {
      take();
      return { k: 'un', op: '-', a: unary() };
    }
    if (isOp('+')) {
      take();
      return unary();
    }
    return atom();
  };
  const atom = () => {
    const x = take();
    if (!x) throw bad('Formula ends too early');
    if (x.t === 'num' || x.t === 'str') return { k: 'lit', v: x.v };
    if (x.t === '(') {
      const e = ternary();
      expect(')');
      return e;
    }
    if (x.t === 'id') {
      const name = x.v;
      const low = name.toLowerCase();
      if (low === 'true' || low === 'false') return { k: 'lit', v: low === 'true' };
      if (peek()?.t !== '(') throw bad(`Formula: unknown word "${name}". Use prop("Name") for properties and quotes for text.`);
      take();
      const args = [];
      if (peek()?.t !== ')') {
        args.push(ternary());
        while (peek()?.t === ',') {
          take();
          args.push(ternary());
        }
      }
      expect(')');
      if (low === 'prop') {
        if (args.length !== 1 || args[0].k !== 'lit' || typeof args[0].v !== 'string') throw bad('Formula: prop() takes one property name in quotes, e.g. prop("Status")');
        return { k: 'prop', id: resolveProp(args[0].v) };
      }
      const fname = Object.keys(FUNCTIONS).find((f) => f.toLowerCase() === low);
      if (!fname) throw bad(`Formula: unknown function "${name}". Functions: ${Object.keys(FUNCTIONS).join(', ')}`);
      const [lo, hi] = FUNCTIONS[fname];
      if (args.length < lo || args.length > hi) throw bad(`Formula: ${fname}() takes ${lo === hi ? lo : `${lo}–${hi}`} arguments`);
      if (fname === 'if') return { k: 'if', c: args[0], a: args[1], b: args[2] ?? { k: 'lit', v: null } };
      return { k: 'call', f: fname, args };
    }
    throw bad(`Formula: unexpected "${x.v}"`);
  };

  if (!toks.length) throw bad('Formula is empty');
  const tree = ternary();
  if (i < toks.length) throw bad(`Formula: unexpected "${toks[i].v ?? toks[i].t}" after the end of the expression`);
  return tree;
}

/** The tree back to text, with current property names. */
export function formulaText(n, nameOf) {
  const q = (s) => JSON.stringify(String(s));
  switch (n.k) {
    case 'lit':
      return typeof n.v === 'string' ? q(n.v) : String(n.v);
    case 'prop':
      return `prop(${q(nameOf(n.id))})`;
    case 'call':
      return `${n.f}(${n.args.map((a) => formulaText(a, nameOf)).join(', ')})`;
    case 'if':
      return `if(${formulaText(n.c, nameOf)}, ${formulaText(n.a, nameOf)}, ${formulaText(n.b, nameOf)})`;
    case 'un':
      return n.op === '-' ? `-${formulaText(n.a, nameOf)}` : `not ${formulaText(n.a, nameOf)}`;
    case 'bin':
      return `(${formulaText(n.a, nameOf)} ${n.op} ${formulaText(n.b, nameOf)})`;
  }
  return '';
}

export function formulaProps(n, acc = new Set()) {
  if (!n) return acc;
  if (n.k === 'prop') acc.add(n.id);
  for (const k of ['a', 'b', 'c']) if (n[k]) formulaProps(n[k], acc);
  for (const a of n.args || []) formulaProps(a, acc);
  return acc;
}

// ---------------------------------------------------------------------------
// Evaluation. Values: number, string, boolean, null, array, or a date { start, end }.
// ---------------------------------------------------------------------------
const isDate = (v) => v && typeof v === 'object' && !Array.isArray(v) && 'start' in v;
const toDate = (v) => {
  if (v == null || v === '') return null;
  const s = isDate(v) ? v.start : v instanceof Date ? v.toISOString() : String(v);
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T00:00:00Z' : s);
  return isNaN(d.getTime()) ? null : d;
};
export const valueToText = (v) => {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map(valueToText).join(', ');
  if (isDate(v)) return v.end ? `${v.start} → ${v.end}` : v.start;
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6);
  return String(v);
};
const num = (v) => {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (Array.isArray(v)) return v.length;
  const n = Number(String(v ?? '').replace(/[,\s$€£%]/g, ''));
  return v == null || v === '' || !Number.isFinite(n) ? null : n;
};
const truthy = (v) => (Array.isArray(v) ? v.length > 0 : isDate(v) ? true : !!v);
const UNIT_MS = { seconds: 1e3, minutes: 6e4, hours: 36e5, days: 864e5, weeks: 6048e5 };
const unitOf = (u) => {
  const k = String(u || 'days').toLowerCase().replace(/s?$/, 's');
  if (!UNIT_MS[k] && !['months', 'years'].includes(k)) throw bad(`Unknown date unit "${u}". Units: seconds, minutes, hours, days, weeks, months, years`);
  return k;
};
const iso = (d, dateOnly) => (dateOnly ? d.toISOString().slice(0, 10) : d.toISOString().replace('.000Z', 'Z'));

export function evalFormula(n, get, depth = 0) {
  if (depth > 200) throw bad('Formula is nested too deeply');
  const ev = (x) => evalFormula(x, get, depth + 1);
  switch (n.k) {
    case 'lit':
      return n.v;
    case 'prop':
      return get(n.id);
    case 'if':
      return truthy(ev(n.c)) ? ev(n.a) : ev(n.b);
    case 'un': {
      const a = ev(n.a);
      return n.op === '-' ? (num(a) == null ? null : -num(a)) : !truthy(a);
    }
    case 'bin': {
      if (n.op === '&&') return truthy(ev(n.a)) && truthy(ev(n.b));
      if (n.op === '||') return truthy(ev(n.a)) || truthy(ev(n.b));
      const a = ev(n.a);
      const b = ev(n.b);
      if (n.op === '+') {
        if (typeof a === 'string' || typeof b === 'string' || Array.isArray(a) || Array.isArray(b)) return valueToText(a) + valueToText(b);
        if (num(a) == null && num(b) == null) return null;
        return (num(a) ?? 0) + (num(b) ?? 0);
      }
      if (['-', '*', '/', '%'].includes(n.op)) {
        const x = num(a);
        const y = num(b);
        if (x == null || y == null) return null;
        if ((n.op === '/' || n.op === '%') && y === 0) return null;
        return { '-': x - y, '*': x * y, '/': x / y, '%': x % y }[n.op];
      }
      // comparisons: numbers numerically, dates by time, everything else as text
      let x = a;
      let y = b;
      if (isDate(a) || isDate(b)) {
        x = toDate(a)?.getTime() ?? null;
        y = toDate(b)?.getTime() ?? null;
      } else if (typeof a === 'number' || typeof b === 'number') {
        x = num(a);
        y = num(b);
      } else if (typeof a === 'boolean' || typeof b === 'boolean') {
        x = truthy(a);
        y = truthy(b);
      } else {
        x = valueToText(a).toLowerCase();
        y = valueToText(b).toLowerCase();
      }
      if (n.op === '==') return x === y;
      if (n.op === '!=') return x !== y;
      if (x == null || y == null) return false;
      return { '>': x > y, '<': x < y, '>=': x >= y, '<=': x <= y }[n.op];
    }
    case 'call':
      return callFn(n.f, n.args.map(ev));
  }
  return null;
}

function callFn(f, a) {
  const nums = () => a.flat().map(num).filter((x) => x != null);
  switch (f) {
    case 'concat':
      return a.map(valueToText).join('');
    case 'join':
      return (Array.isArray(a[0]) ? a[0] : [a[0]]).map(valueToText).join(a[1] == null ? ', ' : valueToText(a[1]));
    case 'length':
      return Array.isArray(a[0]) ? a[0].length : valueToText(a[0]).length;
    case 'empty':
      return a[0] == null || a[0] === '' || (Array.isArray(a[0]) && !a[0].length);
    case 'not':
      return !truthy(a[0]);
    case 'round': {
      const x = num(a[0]);
      const p = 10 ** (num(a[1]) || 0);
      return x == null ? null : Math.round(x * p) / p;
    }
    case 'floor':
    case 'ceil':
    case 'abs':
    case 'sqrt': {
      const x = num(a[0]);
      return x == null ? null : Math[f](x);
    }
    case 'pow': {
      const x = num(a[0]);
      const y = num(a[1]);
      return x == null || y == null ? null : x ** y;
    }
    case 'min':
    case 'max': {
      const xs = nums();
      return xs.length ? Math[f](...xs) : null;
    }
    case 'sum':
      return nums().reduce((s, x) => s + x, 0);
    case 'average': {
      const xs = nums();
      return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
    }
    case 'percent': {
      const x = num(a[0]);
      const y = num(a[1]);
      return x == null || !y ? null : x / y;
    }
    case 'toNumber':
      return num(a[0]);
    case 'format':
      return valueToText(a[0]);
    case 'lower':
      return valueToText(a[0]).toLowerCase();
    case 'upper':
      return valueToText(a[0]).toUpperCase();
    case 'trim':
      return valueToText(a[0]).trim();
    case 'contains':
      return Array.isArray(a[0]) ? a[0].some((x) => valueToText(x).toLowerCase() === valueToText(a[1]).toLowerCase()) : valueToText(a[0]).toLowerCase().includes(valueToText(a[1]).toLowerCase());
    case 'startsWith':
      return valueToText(a[0]).toLowerCase().startsWith(valueToText(a[1]).toLowerCase());
    case 'replace':
      return valueToText(a[0]).split(valueToText(a[1])).join(valueToText(a[2]));
    case 'slice':
      return valueToText(a[0]).slice(num(a[1]) ?? 0, a[2] == null ? undefined : num(a[2]) ?? undefined);
    case 'coalesce':
      return a.find((x) => x != null && x !== '' && !(Array.isArray(x) && !x.length)) ?? null;
    case 'now':
      return { start: iso(new Date()), end: null };
    case 'today':
      return { start: iso(new Date(), true), end: null };
    case 'start':
    case 'end': {
      if (!isDate(a[0])) return a[0] ?? null;
      const s = f === 'end' ? a[0].end || a[0].start : a[0].start;
      return { start: s, end: null };
    }
    case 'year':
    case 'month':
    case 'day': {
      const d = toDate(a[0]);
      if (!d) return null;
      return f === 'year' ? d.getUTCFullYear() : f === 'month' ? d.getUTCMonth() + 1 : d.getUTCDate();
    }
    case 'dateBetween': {
      const x = toDate(a[0]);
      const y = toDate(a[1]);
      if (!x || !y) return null;
      const u = unitOf(a[2]);
      if (u === 'months' || u === 'years') {
        const m = (x.getUTCFullYear() - y.getUTCFullYear()) * 12 + (x.getUTCMonth() - y.getUTCMonth());
        return u === 'years' ? Math.trunc(m / 12) : m;
      }
      return Math.trunc((x - y) / UNIT_MS[u]);
    }
    case 'dateAdd': {
      const d = toDate(a[0]);
      const n = num(a[1]);
      if (!d || n == null) return null;
      const u = unitOf(a[2]);
      const out = new Date(d);
      if (u === 'months') out.setUTCMonth(out.getUTCMonth() + n);
      else if (u === 'years') out.setUTCFullYear(out.getUTCFullYear() + n);
      else out.setTime(out.getTime() + n * UNIT_MS[u]);
      const dateOnly = isDate(a[0]) ? /^\d{4}-\d{2}-\d{2}$/.test(a[0].start) && UNIT_MS[u] >= UNIT_MS.days : false;
      return { start: iso(out, dateOnly), end: null };
    }
    case 'formatDate': {
      const d = toDate(a[0]);
      if (!d) return '';
      const fmt = valueToText(a[1] ?? 'YYYY-MM-DD');
      const p = (n) => String(n).padStart(2, '0');
      return fmt
        .replace(/YYYY/g, d.getUTCFullYear())
        .replace(/MM/g, p(d.getUTCMonth() + 1))
        .replace(/DD/g, p(d.getUTCDate()))
        .replace(/HH/g, p(d.getUTCHours()))
        .replace(/mm/g, p(d.getUTCMinutes()));
    }
  }
  throw bad(`Formula: unknown function ${f}`);
}
