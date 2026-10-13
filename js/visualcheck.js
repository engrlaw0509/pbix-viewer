// Visual check: rebuilds the numbers a report visual shows, straight from the stored
// rows, so they can be compared with the visual in Power BI and with the source.
//
// It follows Power BI's rules for the common cases:
//  - the visual's own filters, its page's and the report's, plus saved slicer
//    selections on the same page, are applied first;
//  - filters flow along active relationships from the "one" side to the "many"
//    side, and both ways where the relationship cross-filters both directions;
//  - plain columns on the visual are grouped; aggregations (Sum, Count, ...) and
//    measures are worked out inside each group's filter context;
//  - rows whose values are all blank are dropped, as Power BI does;
//  - the Total row is evaluated over the whole filtered context, not added up.
// Anything outside that (Top N or relative date filters, hierarchies, DAX the
// measure helper cannot read, ...) is reported instead of guessed.
import { parseFieldRef, fieldLabel, describeFilters } from './pbix.js';
import { tryMeasure } from './dax.js';
import { guessFormat, isNumericType } from './format.js';
import { DataType } from './vertipaq.js';

class Unsupported extends Error {}

const NO_DATA = new Set(['textbox', 'image', 'shape', 'basicShape', 'actionButton', 'pageNavigator', 'bookmarkNavigator', 'group', 'unknown']);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function isSlicer(type) { return /slicer/i.test(type || ''); }
export function hasNoData(visual) { return NO_DATA.has(visual.type) || !visual.fields.length; }

// Normalised key for joins, grouping and filter matching: VertiPaq compares text
// without regard to case, and dates by their instant.
function nk(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string') return v.toLowerCase();
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  return v;
}

function levelValue(v, level) {
  if (!level) return v;
  if (!(v instanceof Date)) return null;
  switch (level) {
    case 'Year': return v.getUTCFullYear();
    case 'Quarter': return 'Qtr ' + (Math.floor(v.getUTCMonth() / 3) + 1);
    case 'Month': return MONTHS[v.getUTCMonth()];
    case 'Day': return v.getUTCDate();
  }
  return null;
}

function levelSortKey(v, level) {
  if (v == null) return null;
  if (level === 'Month') return MONTHS.indexOf(v);
  if (level === 'Quarter') return Number(String(v).slice(4));
  return v;
}

// ---------------------------------------------------------------- the model

export class ModelData {
  // tables: [{ name, rowCount, columns: [{ name, values, dataType, fmt }] }]
  constructor(tables, relationships, measures) {
    this.tables = new Map(tables.map(t => [t.name, { name: t.name, rowCount: t.rowCount, cols: new Map(t.columns.map(c => [c.name, c])) }]));
    this.measures = measures || [];
    this.rels = [];
    for (const r of relationships || []) {
      if (!r.isActive || !this.tables.has(r.fromTable) || !this.tables.has(r.toTable)) continue;
      // Filters flow from the "one" side (`to`) to the "many" side (`from`).
      let rel = { from: r.fromTable, fromCol: r.fromColumn, to: r.toTable, toCol: r.toColumn };
      if (r.fromCardinality === 1 && r.toCardinality === 2) rel = { from: r.toTable, fromCol: r.toColumn, to: r.fromTable, toCol: r.fromColumn };
      rel.both = r.crossFilter === 2 || (r.fromCardinality === 1 && r.toCardinality === 1);
      this.rels.push(rel);
    }
    this.indexes = new Map();
    this.all = new Map();
    this.daxCols = new Map();
  }

  col(table, column) {
    const t = this.tables.get(table);
    const c = t && t.cols.get(column);
    if (!c) throw new Unsupported(`${table}[${column}] has no stored rows in this file`);
    return c;
  }

  allRows(table) {
    if (!this.all.has(table)) {
      const n = this.tables.get(table).rowCount;
      const rows = new Array(n);
      for (let i = 0; i < n; i++) rows[i] = i;
      this.all.set(table, rows);
    }
    return this.all.get(table);
  }

  // key -> row indexes, for one column
  index(table, column) {
    const id = table + '\u0000' + column;
    if (!this.indexes.has(id)) {
      const values = this.col(table, column).values;
      const map = new Map();
      for (let r = 0; r < values.length; r++) {
        const k = nk(values[r]);
        if (k == null) continue;
        let list = map.get(k);
        if (!list) map.set(k, (list = []));
        list.push(r);
      }
      this.indexes.set(id, map);
    }
    return this.indexes.get(id);
  }

  daxColumns(table) {
    if (!this.daxCols.has(table)) {
      const t = this.tables.get(table);
      this.daxCols.set(table, new Map([...t.cols].map(([name, c]) => [name, { values: c.values, numeric: isNumericType(c.dataType) }])));
    }
    return this.daxCols.get(table);
  }
}

// ---------------------------------------------------------------- filters

function parseLiteral(l) {
  const v = l?.Value;
  if (v == null) throw new Unsupported('a filter value this page does not read');
  if (v === 'null') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  let m;
  if ((m = /^'(.*)'$/s.exec(v))) return m[1].replace(/''/g, "'");
  if ((m = /^datetime'(.+)'$/.exec(v))) {
    const t = Date.parse(/Z|[+-]\d\d:\d\d$/.test(m[1]) ? m[1] : m[1] + 'Z');
    if (Number.isNaN(t)) throw new Unsupported(`a date filter value ${v}`);
    return new Date(t);
  }
  if ((m = /^(-?\d+(?:\.\d+)?(?:E[+-]?\d+)?)[LDM]?$/i.exec(v))) return Number(m[1]);
  throw new Unsupported(`a filter value ${v}`);
}

// Case-insensitive like VertiPaq, and not "natural": Power BI sorts PO1000 before PO706.
const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: false });

// DAX compares a blank as 0, "" or FALSE, whichever matches the other side.
function compare(v, lit) {
  if (lit instanceof Date) {
    const a = v == null ? 0 : v instanceof Date ? v.getTime() : Number(v);
    return a - lit.getTime();
  }
  if (typeof lit === 'number') {
    const a = v == null ? 0 : v instanceof Date ? v.getTime() : Number(v);
    return a - lit;
  }
  if (typeof lit === 'boolean') return Number(Boolean(v)) - Number(lit);
  return collator.compare(v == null ? '' : String(v), lit);
}

const isBlank = v => v == null || v === '';

function makeTest(kind, lit) {
  if (lit === null) {
    if (kind === 0) return v => isBlank(v);
    throw new Unsupported('a filter that compares with blank');
  }
  switch (kind) {
    case 0: return v => compare(v, lit) === 0;
    case 1: return v => compare(v, lit) > 0;
    case 2: return v => compare(v, lit) >= 0;
    case 3: return v => compare(v, lit) < 0;
    case 4: return v => compare(v, lit) <= 0;
  }
  throw new Unsupported('a comparison this page does not read');
}

// A filter expression is either on a column (applied to rows before grouping) or on a
// measure / aggregation (applied to the visual's rows afterwards).
function operand(e, aliases, model) {
  const ref = parseFieldRef(e, '', aliases);
  if (!ref) throw new Unsupported('a filter on something other than a column or measure');
  if (ref.kind === 'hierarchy') throw new Unsupported('a filter on a hierarchy level');
  if (ref.kind === 'measure' || ref.agg) return { value: ref };
  const c = model.col(ref.table, ref.column);
  return { table: ref.table, get: ref.level ? r => levelValue(c.values[r], ref.level) : r => c.values[r] };
}

function wrap(op, test) {
  return op.value ? [{ value: op.value, test }] : [{ table: op.table, test: r => test(op.get(r)) }];
}

function compileCondition(c, aliases, model) {
  if (!c) throw new Unsupported('an empty filter condition');
  if (c.And) return [...compileCondition(c.And.Left, aliases, model), ...compileCondition(c.And.Right, aliases, model)];
  if (c.Or) {
    const l = compileCondition(c.Or.Left, aliases, model);
    const r = compileCondition(c.Or.Right, aliases, model);
    if (l.length !== 1 || r.length !== 1 || l[0].value || r[0].value || l[0].table !== r[0].table) throw new Unsupported('an OR filter across different tables');
    return [{ table: l[0].table, test: row => l[0].test(row) || r[0].test(row) }];
  }
  if (c.Not) {
    const inner = compileCondition(c.Not.Expression, aliases, model);
    if (inner.length !== 1) throw new Unsupported('a NOT filter over several conditions');
    const t = inner[0];
    return [t.value ? { value: t.value, test: v => !t.test(v) } : { table: t.table, test: row => !t.test(row) }];
  }
  if (c.In) {
    if (c.In.Table) throw new Unsupported('a filter that refers to another query');
    const ops = c.In.Expressions.map(e => operand(e, aliases, model));
    const key = vals => vals.map(v => String(nk(v))).join('\u0001');
    const keys = new Set(c.In.Values.map(row => key(row.map(x => parseLiteral(x.Literal)))));
    if (ops.length === 1) return wrap(ops[0], v => keys.has(key([v])));
    if (ops.some(o => o.value) || new Set(ops.map(o => o.table)).size !== 1) throw new Unsupported('a multi-column filter across tables');
    return [{ table: ops[0].table, test: r => keys.has(key(ops.map(o => o.get(r)))) }];
  }
  if (c.Comparison) {
    if (!c.Comparison.Right?.Literal) throw new Unsupported('a filter that compares two fields');
    return wrap(operand(c.Comparison.Left, aliases, model), makeTest(c.Comparison.ComparisonKind, parseLiteral(c.Comparison.Right.Literal)));
  }
  for (const k of ['Contains', 'StartsWith', 'EndsWith']) {
    if (c[k]) {
      const needle = String(parseLiteral(c[k].Right?.Literal) ?? '').toLowerCase();
      const fn = k === 'Contains' ? (s => s.includes(needle)) : k === 'StartsWith' ? (s => s.startsWith(needle)) : (s => s.endsWith(needle));
      return wrap(operand(c[k].Left, aliases, model), v => v != null && fn(String(v).toLowerCase()));
    }
  }
  throw new Unsupported('a filter type this page does not read');
}

function compileFilters(list, model) {
  const rowTests = [];
  const valueTests = [];
  for (const fl of list) {
    if (/TopN|Relative|Passthrough|Tuple/i.test(fl.type || '')) throw new Unsupported(`a ${fl.type} filter`);
    const aliases = new Map((fl.filter.From || []).map(f => [f.Name, f.Entity]));
    for (const w of fl.filter.Where || []) {
      for (const part of compileCondition(w.Condition, aliases, model)) (part.value ? valueTests : rowTests).push(part);
    }
  }
  return { rowTests, valueTests };
}

// ---------------------------------------------------------------- filter context

// Applies row filters and spreads them along relationships until nothing changes.
// Returns Map(table -> Uint8Array mask); tables without an entry are unfiltered.
function baseMasks(model, rowTests) {
  const eff = new Map();
  for (const { table, test } of rowTests) {
    const n = model.tables.get(table).rowCount;
    let m = eff.get(table);
    if (!m) eff.set(table, (m = new Uint8Array(n).fill(1)));
    for (let r = 0; r < n; r++) if (m[r] && !test(r)) m[r] = 0;
  }
  const restrict = (target, targetCol, source, sourceCol) => {
    const sm = eff.get(source);
    const sv = model.col(source, sourceCol).values;
    const keys = new Set();
    for (let r = 0; r < sv.length; r++) if (sm[r]) { const k = nk(sv[r]); if (k != null) keys.add(k); }
    const tv = model.col(target, targetCol).values;
    let m = eff.get(target);
    let changed = false;
    if (!m) { eff.set(target, (m = new Uint8Array(tv.length).fill(1))); changed = true; }
    for (let r = 0; r < tv.length; r++) {
      if (m[r] && !keys.has(nk(tv[r]))) { m[r] = 0; changed = true; }
    }
    return changed;
  };
  for (let pass = 0, changed = true; changed && pass < 50; pass++) {
    changed = false;
    for (const rel of model.rels) {
      if (eff.has(rel.to) && restrict(rel.from, rel.fromCol, rel.to, rel.toCol)) changed = true;
      if (rel.both && eff.has(rel.from) && restrict(rel.to, rel.toCol, rel.from, rel.fromCol)) changed = true;
    }
  }
  return eff;
}

class Context {
  constructor(model, masks) {
    this.model = model;
    this.masks = masks;
    this.baseCache = new Map();
  }
  baseRows(table) {
    if (!this.baseCache.has(table)) {
      const m = this.masks.get(table);
      const all = this.model.allRows(table);
      this.baseCache.set(table, m ? all.filter(r => m[r]) : all);
    }
    return this.baseCache.get(table);
  }
  // Spreads a group's restrictions (Map table -> rows) along relationships. Tables in
  // `fixed` keep their rows as given: a group's own rows already are its answer, and
  // re-filtering them through a lookup table would drop rows with no match there
  // (Power BI keeps those under the blank value).
  narrow(restrictions, fixed = new Set()) {
    const { model, masks } = this;
    const sets = new Map(restrictions);
    const queue = [...restrictions.keys()];
    const push = (table, rows) => {
      if (fixed.has(table)) return;
      const m = masks.get(table);
      const kept = [...new Set(m ? rows.filter(r => m[r]) : rows)];
      const prev = sets.get(table);
      let next = kept;
      if (prev) { const s = new Set(kept); next = prev.filter(r => s.has(r)); }
      if (!prev || next.length !== prev.length) { sets.set(table, next); queue.push(table); }
    };
    while (queue.length) {
      const t = queue.shift();
      const rows = sets.get(t);
      for (const rel of model.rels) {
        if (rel.to === t) {
          const idx = model.index(rel.from, rel.fromCol);
          const keys = model.col(rel.to, rel.toCol).values;
          const out = [];
          for (const r of rows) { const kids = idx.get(nk(keys[r])); if (kids) for (const k of kids) out.push(k); }
          push(rel.from, out);
        }
        if (rel.both && rel.from === t) {
          const idx = model.index(rel.to, rel.toCol);
          const fks = model.col(rel.from, rel.fromCol).values;
          const out = [];
          const seen = new Set();
          for (const r of rows) {
            const k = nk(fks[r]);
            if (k == null || seen.has(k)) continue;
            seen.add(k);
            const parents = idx.get(k);
            if (parents) for (const p of parents) out.push(p);
          }
          push(rel.to, out);
        }
      }
    }
    return table => sets.get(table) ?? this.baseRows(table);
  }
}

// ---------------------------------------------------------------- values

function aggregateColumn(agg, c, rows) {
  const vals = c.values;
  const numeric = isNumericType(c.dataType);
  switch (agg) {
    case 'Sum': case 'Average': case 'Median': {
      if (!numeric) throw new Unsupported(`${agg} of a column that is not a number`);
      const xs = [];
      for (const r of rows) { const v = vals[r]; if (v != null) xs.push(Number(v)); }
      if (!xs.length) return null;
      if (agg === 'Sum') return xs.reduce((a, b) => a + b, 0);
      if (agg === 'Average') return xs.reduce((a, b) => a + b, 0) / xs.length;
      xs.sort((a, b) => a - b);
      const mid = xs.length >> 1;
      return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
    }
    case 'Min': case 'Max': {
      let best = null, bestK = null;
      for (const r of rows) {
        const v = vals[r];
        if (isBlank(v)) continue;
        const k = v instanceof Date ? v.getTime() : typeof v === 'bigint' ? Number(v) : v;
        const better = bestK == null || (typeof k === 'string' ? (agg === 'Min' ? collator.compare(k, bestK) < 0 : collator.compare(k, bestK) > 0) : (agg === 'Min' ? k < bestK : k > bestK));
        if (better) { best = v; bestK = k; }
      }
      return best;
    }
    case 'Count': { // Power BI's "Count (Distinct)"; a blank counts as one value
      if (!rows.length) return null;
      const s = new Set();
      for (const r of rows) s.add(nk(vals[r]));
      return s.size;
    }
    case 'CountNonNull': {
      let n = 0;
      for (const r of rows) if (vals[r] != null) n++;
      return n || null;
    }
  }
  throw new Unsupported(`${agg} is not worked out here`);
}

function valueFormat(f, c, values) {
  const agg = f.ref.agg;
  if (f.ref.kind === 'measure') return guessFormat(values);
  if (agg === 'Count' || agg === 'CountNonNull') return { kind: 'int' };
  if (agg === 'Average' || agg === 'Median') return { kind: 'number', decimals: 6 };
  if (c.dataType === DataType.Int64 && agg === 'Sum') return { kind: 'int' };
  return c.fmt || guessFormat(values);
}

function groupFormat(f, c) {
  if (f.ref.level === 'Year' || f.ref.level === 'Day') return { kind: 'int' };
  if (f.ref.level) return { kind: 'text' };
  return c.fmt || { kind: 'text' };
}

// ---------------------------------------------------------------- the visual

export function checkVisual(visual, page, report, model) {
  try {
    return run(visual, page, report, model);
  } catch (e) {
    if (e instanceof Unsupported) return { ok: false, reason: e.message };
    throw e;
  }
}

function sameRef(a, b) {
  return a && b && a.kind === b.kind && a.table === b.table && (a.kind === 'measure' ? a.name === b.name : a.column === b.column);
}

function run(visual, page, report, model) {
  if (isSlicer(visual.type) || hasNoData(visual)) return { ok: false, nothing: true, reason: isSlicer(visual.type) ? 'a slicer filters the other visuals and has no numbers of its own' : 'this visual shows no data' };
  if (visual.fields.some(f => !f.ref)) throw new Unsupported('it uses a field this page cannot read (the older report format is not supported for checks yet)');
  if (visual.fields.some(f => f.ref.kind === 'hierarchy')) throw new Unsupported('it uses a hierarchy level');

  // Within a role, drill state marks the levels on show as active.
  const roles = new Map();
  for (const f of visual.fields) { if (!roles.has(f.role)) roles.set(f.role, []); roles.get(f.role).push(f); }
  const fields = [];
  for (const list of roles.values()) {
    const active = list.filter(f => f.active === true);
    fields.push(...(active.length && active.length < list.length ? active : list));
  }
  const groupFields = fields.filter(f => f.ref.kind === 'column' && !f.ref.agg);
  const valueFields = fields.filter(f => f.ref.kind === 'measure' || f.ref.agg);
  for (const f of fields) if (f.ref.kind === 'column') model.col(f.ref.table, f.ref.column);

  // ---- filters
  const applied = [];
  const sources = [];
  const add = (list, source) => { for (const fl of list || []) { sources.push(fl); for (const d of describeFilters([fl])) applied.push({ source, text: d }); } };
  add(report.rawFilters, 'Report');
  add(page.rawFilters, 'Page');
  add(visual.rawFilters, 'Visual');
  const slicers = page.visuals.filter(v => v !== visual && isSlicer(v.type));
  for (const s of slicers) {
    if (!s.slicerSelection) continue;
    const off = (page.interactions || []).some(i => i.source === s.id && i.target === visual.id && /NoFilter/i.test(i.type || ''));
    if (!off) add([{ type: 'Categorical', filter: s.slicerSelection }], 'Slicer');
  }
  const { rowTests, valueTests } = compileFilters(sources, model);
  const ctx = new Context(model, baseMasks(model, rowTests));

  // ---- groups
  const groupTables = [...new Set(groupFields.map(f => f.ref.table))];
  let anchor = null;
  const paths = new Map();
  const upPath = (from, to) => { // many -> one steps from `from` up to `to`
    const prev = new Map([[from, null]]);
    const queue = [from];
    while (queue.length) {
      const t = queue.shift();
      if (t === to) break;
      for (const rel of model.rels) if (rel.from === t && !prev.has(rel.to)) { prev.set(rel.to, rel); queue.push(rel.to); }
    }
    if (!prev.has(to)) return null;
    const steps = [];
    for (let t = to; t !== from; t = prev.get(t).from) steps.unshift(prev.get(t));
    return steps;
  };
  // The anchor is the grouped table every other grouped table can be looked up from.
  for (const t of groupTables) {
    const found = new Map();
    for (const o of groupTables) if (o !== t) found.set(o, upPath(t, o));
    if ([...found.values()].every(Boolean)) {
      anchor = t;
      for (const [k, v] of found) paths.set(k, v);
      break;
    }
  }
  if (groupTables.length && !anchor) throw new Unsupported('its grouped columns come from tables that are not related');

  const groups = [];
  if (!groupFields.length) {
    groups.push({ values: [], restrictions: new Map() });
  } else {
    const readers = groupFields.map(f => {
      const c = model.col(f.ref.table, f.ref.column);
      const steps = f.ref.table === anchor ? [] : paths.get(f.ref.table);
      return r => {
        let row = r;
        for (const s of steps) {
          const parents = model.index(s.to, s.toCol).get(nk(model.col(s.from, s.fromCol).values[row]));
          if (!parents) return null;
          row = parents[0];
        }
        return levelValue(c.values[row], f.ref.level);
      };
    });
    const map = new Map();
    for (const r of ctx.baseRows(anchor)) {
      const vals = readers.map(read => read(r));
      const key = vals.map(v => String(nk(v))).join('\u0001');
      let g = map.get(key);
      if (!g) map.set(key, (g = { values: vals, rows: [] }));
      g.rows.push(r);
    }
    // Columns from lookup tables filter those tables by value too, which reaches their other facts.
    const lookupFields = groupFields.map((f, i) => [f, i]).filter(([f]) => f.ref.table !== anchor);
    const byValue = new Map();
    const lookupRows = (f, v) => {
      const id = f.ref.table + '\u0000' + f.ref.column + '\u0000' + (f.ref.level || '');
      if (!byValue.has(id)) {
        const c = model.col(f.ref.table, f.ref.column);
        const m = new Map();
        for (const r of ctx.baseRows(f.ref.table)) {
          const k = String(nk(levelValue(c.values[r], f.ref.level)));
          if (!m.has(k)) m.set(k, []);
          m.get(k).push(r);
        }
        byValue.set(id, m);
      }
      return byValue.get(id).get(String(nk(v))) || [];
    };
    for (const g of map.values()) {
      const restrictions = new Map([[anchor, g.rows]]);
      for (const [f, i] of lookupFields) {
        const rows = lookupRows(f, g.values[i]);
        const prev = restrictions.get(f.ref.table);
        restrictions.set(f.ref.table, prev ? (s => prev.filter(r => s.has(r)))(new Set(rows)) : rows);
      }
      groups.push({ values: g.values, restrictions });
    }
  }

  // ---- values per group
  const errors = new Map();
  const evaluate = (field, rowsOf) => {
    const r = field.ref;
    if (r.kind === 'measure') {
      const m = model.measures.find(x => x.name === r.name && (!r.table || x.tableName === r.table)) || model.measures.find(x => x.name === r.name);
      if (!m) throw new Unsupported(`the measure [${r.name}] is not in the model`);
      const res = tryMeasure(m.expression, {
        measures: model.measures,
        getTable: name => (model.tables.has(name) ? { name, rowCount: model.tables.get(name).rowCount, rows: rowsOf(name), columns: model.daxColumns(name) } : null),
      });
      if (!res.ok) { errors.set(field, res.reason); return null; }
      return res.value;
    }
    return aggregateColumn(r.agg, model.col(r.table, r.column), rowsOf(r.table));
  };
  // Filters on a measure or aggregation keep or drop whole rows of the visual.
  const extra = valueTests.map(t => ({ field: { ref: t.value, header: fieldLabel(t.value) }, test: t.test }));
  const filterValue = (x, rowsOf) => {
    const v = evaluate(x.field, rowsOf);
    if (errors.has(x.field)) throw new Unsupported(`a filter on ${x.field.header}, which ${errors.get(x.field)}`);
    return v;
  };
  const rows = [];
  for (const g of groups) {
    const rowsOf = g.restrictions.size ? ctx.narrow(g.restrictions, new Set([anchor])) : t => ctx.baseRows(t);
    const vals = valueFields.map(f => evaluate(f, rowsOf));
    if (extra.some(x => !x.test(filterValue(x, rowsOf)))) continue;
    if (valueFields.length && groupFields.length && vals.every((v, i) => v == null && !errors.has(valueFields[i]))) continue;
    rows.push({ g, vals });
  }

  // ---- total, over the same context the rows came from
  let totals = null;
  if (groupFields.length && valueFields.length) {
    let rowsOf = t => ctx.baseRows(t);
    if (extra.length) {
      const union = new Map();
      for (const { g } of rows) for (const [t, rs] of g.restrictions) { if (!union.has(t)) union.set(t, new Set()); for (const r of rs) union.get(t).add(r); }
      rowsOf = union.size ? ctx.narrow(new Map([...union].map(([t, s]) => [t, [...s]])), new Set([anchor])) : (() => []);
    }
    totals = valueFields.map(f => evaluate(f, rowsOf));
  }

  // ---- columns in the visual's order
  const columns = fields.map(f => {
    const gi = groupFields.indexOf(f);
    const values = gi >= 0 ? rows.map(x => x.g.values[gi]) : rows.map(x => x.vals[valueFields.indexOf(f)]);
    const c = f.ref.kind === 'column' ? model.col(f.ref.table, f.ref.column) : null;
    return {
      name: f.header,
      sub: fieldLabel(f.ref),
      fmt: gi >= 0 ? groupFormat(f, c) : valueFormat(f, c, values),
      values,
      group: gi >= 0,
      level: f.ref.level || null,
      error: errors.get(f) || null,
      total: gi >= 0 || !totals ? null : totals[valueFields.indexOf(f)],
    };
  });

  // ---- sort: the visual's own sort, else its grouped columns in order
  const order = rows.map((_, i) => i);
  const sorts = (visual.sort || []).map(s => {
    let ci = fields.findIndex(f => sameRef(f.ref, s.ref) && !!f.ref.agg === !!s.ref.agg && f.ref.level === s.ref.level);
    if (ci < 0) ci = fields.findIndex(f => sameRef(f.ref, s.ref));
    return ci >= 0 ? { ci, dir: s.dir } : null;
  }).filter(Boolean);
  if (!sorts.length) for (const g of groupFields) sorts.push({ ci: fields.indexOf(g), dir: 1 });
  if (sorts.length) {
    const key = (col, v) => (v == null ? null : col.level ? levelSortKey(v, col.level) : v instanceof Date ? v.getTime() : typeof v === 'bigint' ? Number(v) : v);
    order.sort((a, b) => {
      for (const { ci, dir } of sorts) {
        const col = columns[ci];
        const x = key(col, col.values[a]), y = key(col, col.values[b]);
        if (x == null || y == null) { if (x == null && y == null) continue; return (x == null ? -1 : 1) * dir; }
        const cmp = typeof x === 'string' || typeof y === 'string' ? collator.compare(String(x), String(y)) : x - y;
        if (cmp) return cmp * dir;
      }
      return a - b;
    });
    for (const col of columns) col.values = order.map(i => col.values[i]);
  }

  const notes = [];
  if (slicers.length && !slicers.some(s => s.slicerSelection)) notes.push(`The ${slicers.length === 1 ? 'slicer' : slicers.length + ' slicers'} on this page ${slicers.length === 1 ? 'has' : 'have'} no saved selection, so ${slicers.length === 1 ? 'it filters' : 'they filter'} nothing here.`);
  if (fields.some(f => f.ref.agg === 'Count')) notes.push('Count follows Power BI: Count(...) is the number of distinct values (a blank counts as one), CountNonNull(...) the number of non-blank rows.');
  for (const [f, reason] of errors) notes.push(`${f.header}: not worked out here (${reason}); shown blank.`);

  return { ok: true, columns, rowCount: rows.length, filters: applied, notes, anchor, hasTotals: !!totals };
}
