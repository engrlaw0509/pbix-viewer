// Grand totals for simple DAX measures, so they can be checked against a source.
//
// Only a strict subset is understood: column aggregations (SUM, AVERAGE, MIN,
// MAX, COUNT, COUNTA, COUNTBLANK, DISTINCTCOUNT, DISTINCTCOUNTNOBLANK),
// COUNTROWS, the X iterators over one table with row arithmetic, DIVIDE,
// arithmetic between those, and references to other such measures. Anything
// else (CALCULATE, FILTER, time intelligence, variables, ...) is reported as
// unsupported instead of guessed. Totals are unfiltered: the whole table.

class Unsupported extends Error {}

function tokenize(src) {
  const s = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(\/\/|--)[^\n]*/g, ' ');
  const out = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === "'") {
      let j = i + 1, v = '';
      for (;;) {
        if (j >= s.length) throw new Unsupported('unclosed quote');
        if (s[j] === "'") { if (s[j + 1] === "'") { v += "'"; j += 2; continue; } break; }
        v += s[j++];
      }
      out.push({ t: 'table', v });
      i = j + 1;
      continue;
    }
    if (ch === '[') {
      let j = i + 1, v = '';
      for (;;) {
        if (j >= s.length) throw new Unsupported('unclosed bracket');
        if (s[j] === ']') { if (s[j + 1] === ']') { v += ']'; j += 2; continue; } break; }
        v += s[j++];
      }
      out.push({ t: 'col', v });
      i = j + 1;
      continue;
    }
    const num = s.slice(i).match(/^\d+(\.\d+)?([eE][+-]?\d+)?/);
    if (num) { out.push({ t: 'num', v: Number(num[0]) }); i += num[0].length; continue; }
    const id = s.slice(i).match(/^[A-Za-z_][A-Za-z0-9_.]*/);
    if (id) { out.push({ t: 'id', v: id[0] }); i += id[0].length; continue; }
    if ('+-*/(),'.includes(ch)) { out.push({ t: ch }); i++; continue; }
    throw new Unsupported(`unsupported character "${ch}"`);
  }
  return out;
}

const COLUMN_AGGS = ['SUM', 'AVERAGE', 'MIN', 'MAX', 'COUNT', 'COUNTA', 'COUNTBLANK', 'DISTINCTCOUNT', 'DISTINCTCOUNTNOBLANK'];
const ITERATORS = ['SUMX', 'AVERAGEX', 'MINX', 'MAXX', 'COUNTX'];

// DAX blank arithmetic: BLANK + x = x, BLANK * x = BLANK, x / BLANK = infinity.
function arith(op, a, b) {
  if (a == null && b == null) return null;
  switch (op) {
    case '+': return (a ?? 0) + (b ?? 0);
    case '-': return (a ?? 0) - (b ?? 0);
    case '*': return a == null || b == null ? null : a * b;
    case '/':
      if (a == null) return null;
      if (b == null || b === 0) throw new Unsupported('the data divides by zero or blank');
      return a / b;
  }
  return null;
}

const q = name => '"' + name.replace(/"/g, '""') + '"';

class Parser {
  constructor(tokens, ctx) { this.tk = tokens; this.i = 0; this.ctx = ctx; }
  peek(o = 0) { return this.tk[this.i + o]; }
  next() { return this.tk[this.i++]; }
  expect(t) {
    const tok = this.next();
    if (!tok || tok.t !== t) throw new Unsupported(`expected "${t}"`);
    return tok;
  }
  done() { return this.i >= this.tk.length; }

  // measure-level expression -> { value, sql? }
  expr() {
    let left = this.term();
    while (this.peek() && (this.peek().t === '+' || this.peek().t === '-')) {
      const op = this.next().t;
      const right = this.term();
      left = { value: arith(op, left.value, right.value), sql: null };
    }
    return left;
  }
  term() {
    let left = this.factor();
    while (this.peek() && (this.peek().t === '*' || this.peek().t === '/')) {
      const op = this.next().t;
      const right = this.factor();
      left = { value: arith(op, left.value, right.value), sql: null };
    }
    return left;
  }
  factor() {
    const tok = this.next();
    if (!tok) throw new Unsupported('unexpected end');
    if (tok.t === 'num') return { value: tok.v, sql: null };
    if (tok.t === '-') { const f = this.factor(); return { value: f.value == null ? null : -f.value, sql: null }; }
    if (tok.t === '(') { const e = this.expr(); this.expect(')'); return { value: e.value, sql: null }; }
    if (tok.t === 'col') {
      const m = this.ctx.measure(tok.v);
      return { value: m.value, sql: null };
    }
    if (tok.t === 'id') return this.call(tok.v.toUpperCase());
    throw new Unsupported('unsupported expression');
  }
  tableRef() {
    const tok = this.next();
    if (!tok || (tok.t !== 'table' && tok.t !== 'id')) throw new Unsupported('expected a table');
    return this.ctx.table(tok.v);
  }
  colRef(defaultTable) {
    let table = defaultTable;
    if (this.peek() && (this.peek().t === 'table' || this.peek().t === 'id') && this.peek(1) && this.peek(1).t === 'col') {
      table = this.tableRef();
    }
    const col = this.expect('col').v;
    if (!table) throw new Unsupported('column without a table');
    if (defaultTable && table.name !== defaultTable.name) throw new Unsupported('refers to another table inside an iterator');
    return { table, column: this.ctx.column(table, col), name: col };
  }
  call(fn) {
    this.expect('(');
    let result;
    if (COLUMN_AGGS.includes(fn)) {
      const { table, column, name } = this.colRef(null);
      result = aggregate(fn, column.values, column.numeric, table.name, name);
    } else if (fn === 'COUNTROWS') {
      const table = this.tableRef();
      result = { value: table.rowCount || null, sql: `SELECT COUNT(*) FROM ${q(table.name)}` };
    } else if (ITERATORS.includes(fn)) {
      const table = this.tableRef();
      this.expect(',');
      const rowExpr = this.rowExpr(table);
      const vals = [];
      for (let r = 0; r < table.rowCount; r++) vals.push(rowExpr.eval(r));
      const base = { SUMX: 'SUM', AVERAGEX: 'AVERAGE', MINX: 'MIN', MAXX: 'MAX', COUNTX: 'COUNT' }[fn];
      result = aggregate(base, vals, true, table.name, null);
      result.sql = rowExpr.sql ? `SELECT ${base === 'AVERAGE' ? 'AVG' : base}(${rowExpr.sql}) FROM ${q(table.name)}` : null;
    } else if (fn === 'DIVIDE') {
      const a = this.expr();
      this.expect(',');
      const b = this.expr();
      let alt = { value: null };
      if (this.peek() && this.peek().t === ',') { this.next(); alt = this.expr(); }
      const v = a.value == null ? null : b.value == null || b.value === 0 ? alt.value : a.value / b.value;
      result = { value: v, sql: null };
    } else {
      throw new Unsupported(`${fn}() is not worked out here`);
    }
    this.expect(')');
    return result;
  }

  // row-level arithmetic inside an iterator -> { eval(row), sql }
  rowExpr(table) {
    let left = this.rowTerm(table);
    while (this.peek() && (this.peek().t === '+' || this.peek().t === '-')) {
      const op = this.next().t;
      const right = this.rowTerm(table);
      left = combine(op, left, right);
    }
    return left;
  }
  rowTerm(table) {
    let left = this.rowFactor(table);
    while (this.peek() && (this.peek().t === '*' || this.peek().t === '/')) {
      const op = this.next().t;
      const right = this.rowFactor(table);
      left = combine(op, left, right);
    }
    return left;
  }
  rowFactor(table) {
    const tok = this.peek();
    if (!tok) throw new Unsupported('unexpected end');
    if (tok.t === 'num') { this.next(); return { eval: () => tok.v, sql: String(tok.v) }; }
    if (tok.t === '-') { this.next(); const f = this.rowFactor(table); return { eval: r => { const v = f.eval(r); return v == null ? null : -v; }, sql: f.sql && `-(${f.sql})` }; }
    if (tok.t === '(') { this.next(); const e = this.rowExpr(table); this.expect(')'); return { eval: e.eval, sql: e.sql && `(${e.sql})` }; }
    const { column, name } = this.colRef(table);
    if (!column.numeric) throw new Unsupported(`[${name}] is not a number column`);
    const vals = column.values;
    return { eval: r => vals[r], sql: q(name) };
  }
}

function combine(op, a, b) {
  return { eval: r => arith(op, a.eval(r), b.eval(r)), sql: a.sql && b.sql ? `${a.sql} ${op} ${b.sql}` : null };
}

function aggregate(fn, values, numeric, tableName, colName) {
  const col = colName == null ? null : q(colName);
  const from = ` FROM ${q(tableName)}`;
  let value = null;
  let sql = null;
  const nonBlank = values.filter(v => v != null && v !== '');
  switch (fn) {
    case 'SUM': case 'AVERAGE': case 'MIN': case 'MAX': {
      if (!numeric) throw new Unsupported(`${fn} over a column that is not a number`);
      if (nonBlank.length) {
        if (fn === 'SUM') value = nonBlank.reduce((a, b) => a + Number(b), 0);
        if (fn === 'AVERAGE') value = nonBlank.reduce((a, b) => a + Number(b), 0) / nonBlank.length;
        if (fn === 'MIN') value = nonBlank.reduce((a, b) => (Number(b) < a ? Number(b) : a), Infinity);
        if (fn === 'MAX') value = nonBlank.reduce((a, b) => (Number(b) > a ? Number(b) : a), -Infinity);
      }
      if (col) sql = `SELECT ${fn === 'AVERAGE' ? 'AVG' : fn}(${col})${from}`;
      break;
    }
    case 'COUNT': case 'COUNTA':
      value = nonBlank.length || null;
      if (col) sql = `SELECT COUNT(${col})${from}`;
      break;
    case 'COUNTBLANK':
      value = values.length - nonBlank.length || null;
      if (col) sql = `SELECT SUM(${col} IS NULL OR ${col} = '')${from}`;
      break;
    case 'DISTINCTCOUNT': case 'DISTINCTCOUNTNOBLANK': {
      const set = new Set(values.map(v => (v instanceof Date ? v.getTime() : v)));
      const hasBlank = set.has(null);
      value = set.size - (fn === 'DISTINCTCOUNTNOBLANK' && hasBlank ? 1 : 0) || null;
      if (col) sql = `SELECT COUNT(DISTINCT ${col})${fn === 'DISTINCTCOUNT' ? ` + MAX(${col} IS NULL)` : ''}${from}`;
      break;
    }
  }
  return { value, sql };
}

// ctx: { getTable(name) -> {name, rowCount, columns: Map(name -> {values, numeric})} | null,
//        measures: [{name, expression}] }
export function evaluateMeasure(expression, ctx, depth = 0) {
  if (depth > 8) throw new Unsupported('measure references go too deep');
  const tokens = tokenize(expression || '');
  if (!tokens.length) throw new Unsupported('empty expression');
  const parser = new Parser(tokens, {
    table(name) {
      const t = ctx.getTable(name);
      if (!t) throw new Unsupported(`table '${name}' has no data here`);
      return t;
    },
    column(table, name) {
      const c = table.columns.get(name);
      if (!c) throw new Unsupported(`column [${name}] not found in '${table.name}'`);
      return c;
    },
    measure(name) {
      const m = ctx.measures.find(x => x.name === name);
      if (!m) throw new Unsupported(`[${name}] is a column outside an aggregation`);
      return evaluateMeasure(m.expression, ctx, depth + 1);
    },
  });
  const result = parser.expr();
  if (!parser.done()) throw new Unsupported('more than one simple expression');
  return result;
}

// Wraps evaluateMeasure: returns { ok, value, sql } or { ok: false, reason }.
export function tryMeasure(expression, ctx) {
  try {
    const r = evaluateMeasure(expression, ctx);
    return { ok: true, value: r.value, sql: r.sql };
  } catch (e) {
    if (e instanceof Unsupported) return { ok: false, reason: e.message };
    return { ok: false, reason: 'could not be worked out (' + e.message + ')' };
  }
}
