// Visual check rules on a small invented model (no client data).
// Run: node --test tools/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelData, checkVisual } from '../js/visualcheck.js';
import { columnFormat } from '../js/format.js';
import { DataType as T } from '../js/vertipaq.js';

const d = s => new Date(s + 'T00:00:00Z');
const table = (name, cols) => {
  const columns = Object.entries(cols).map(([n, [dataType, values]]) => ({ name: n, dataType, values, fmt: columnFormat(dataType, values) }));
  return { name, rowCount: columns[0].values.length, columns };
};
const tables = [
  table('Vendors', { vendor_id: [T.Int64, [1, 2, 3]], name: [T.String, ['Acme', 'Beta', 'Gamma']], country: [T.String, ['AU', 'PH', 'AU']] }),
  table('Bills', {
    bill_id: [T.Int64, [10, 11, 12, 13, 14, 15]],
    vendor_id: [T.Int64, [1, 1, 2, 3, 3, null]],
    amount: [T.Double, [100, -20, 50, 30, null, 5]],
    date: [T.DateTime, [d('2025-01-05'), d('2026-02-01'), d('2026-03-03'), d('2025-07-07'), d('2026-01-01'), d('2026-05-05')]],
    status: [T.String, ['Open', 'Paid', 'Open', 'open', 'Paid', null]],
  }),
  table('Lines', { bill_id: [T.Int64, [10, 10, 12, 13, 99]], qty: [T.Double, [1, 2, 3, 4, 5]], rate: [T.Double, [10, 10, 1, 2, 7]] }),
];
const rel = (fromTable, fromColumn, toTable, toColumn, crossFilter = 1) => ({ fromTable, fromColumn, toTable, toColumn, isActive: 1, fromCardinality: 2, toCardinality: 1, crossFilter });
const measures = [{ tableName: 'Lines', name: 'Line Value', expression: "SUMX('Lines', 'Lines'[qty] * 'Lines'[rate])" }];
const model = (both = false) => new ModelData(tables, [rel('Bills', 'vendor_id', 'Vendors', 'vendor_id'), rel('Lines', 'bill_id', 'Bills', 'bill_id', both ? 2 : 1)], measures);

const col = (t, c, extra = {}) => ({ role: 'Values', ref: { kind: 'column', table: t, column: c, ...extra }, header: extra.agg ? `${extra.agg} of ${c}` : c + (extra.level ? ' ' + extra.level : '') });
const measure = n => ({ role: 'Values', ref: { kind: 'measure', table: 'Lines', name: n }, header: n });
const colExpr = (src, c) => ({ Column: { Expression: { SourceRef: { Source: src } }, Property: c } });
const lit = v => ({ Literal: { Value: v } });
const filter = (entity, condition) => ({ type: 'Advanced', filter: { Version: 2, From: [{ Name: 'x', Entity: entity, Type: 0 }], Where: [{ Condition: condition }] } });
const visual = (fields, rawFilters = [], extra = {}) => ({ id: 'v', type: 'tableEx', fields, rawFilters, sort: [], ...extra });
const run = (v, m = model(), pageExtra = {}) => {
  const page = { visuals: [v, ...(pageExtra.visuals || [])], rawFilters: [], interactions: [] };
  const r = checkVisual(v, page, { rawFilters: [] }, m);
  assert.ok(r.ok, r.reason);
  return r;
};
const rowsOf = r => r.columns[0].values.map((_, i) => r.columns.map(c => (c.values[i] instanceof Date ? c.values[i].toISOString().slice(0, 10) : c.values[i])));
const totals = r => r.columns.map(c => c.total);

test('groups by a lookup column, filters case-insensitively, and spreads to the lines', () => {
  const r = run(visual([col('Vendors', 'name'), col('Bills', 'amount', { agg: 'Sum' }), measure('Line Value')],
    [filter('Bills', { In: { Expressions: [colExpr('x', 'status')], Values: [[lit("'open'")]] } })]));
  assert.deepEqual(rowsOf(r), [['Acme', 100, 30], ['Beta', 50, 3], ['Gamma', 30, 8]]);
  assert.deepEqual(totals(r), [null, 180, 41]); // orphan line of bill 99 is excluded once Bills is filtered
});

test('date levels, a blank lookup value, Count (distinct) and CountNonNull', () => {
  const r = run(visual([col('Bills', 'date', { level: 'Year' }), col('Vendors', 'country'), col('Bills', 'amount', { agg: 'CountNonNull' }), col('Bills', 'status', { agg: 'Count' })]));
  assert.deepEqual(rowsOf(r), [[2025, 'AU', 2, 1], [2026, null, 1, 1], [2026, 'AU', 1, 1], [2026, 'PH', 1, 1]]);
  assert.deepEqual(totals(r), [null, null, 5, 3]); // Open and open are one value; the blank status counts as one
});

test('a filter on a measure drops rows and the total follows the rows kept', () => {
  const r = run(visual([col('Bills', 'bill_id'), measure('Line Value')],
    [{ type: 'Advanced', filter: { Version: 2, From: [{ Name: 'l', Entity: 'Lines', Type: 0 }], Where: [{ Condition: { Comparison: { ComparisonKind: 1, Left: { Measure: { Expression: { SourceRef: { Source: 'l' } }, Property: 'Line Value' } }, Right: lit('5L') } } }] } }]));
  assert.deepEqual(rowsOf(r), [[10, 30], [13, 8]]);
  assert.deepEqual(totals(r), [null, 38]);
});

test('a saved slicer selection on the page filters the visual', () => {
  const v = visual([col('Bills', 'bill_id'), col('Bills', 'amount', { agg: 'Sum' })]);
  const slicer = { id: 's', type: 'slicer', fields: [col('Vendors', 'name')], rawFilters: [], sort: [], slicerSelection: { Version: 2, From: [{ Name: 'v', Entity: 'Vendors', Type: 0 }], Where: [{ Condition: { In: { Expressions: [colExpr('v', 'name')], Values: [[lit("'Beta'")]] } } }] } };
  const r = run(v, model(), { visuals: [slicer] });
  assert.deepEqual(rowsOf(r), [[12, 50]]);
  assert.equal(r.filters[0].source, 'Slicer');
});

test('blank compares as zero, like DAX', () => {
  const r = run(visual([col('Bills', 'bill_id'), col('Bills', 'amount', { agg: 'Sum' })],
    [filter('Bills', { Comparison: { ComparisonKind: 3, Left: colExpr('x', 'amount'), Right: lit('40L') } })]));
  assert.deepEqual(rowsOf(r), [[11, -20], [13, 30], [15, 5]]); // bill 14 passes the filter but its sum is blank, so the row goes
  assert.deepEqual(totals(r), [null, 15]);
});

test('NOT IN keeps blanks', () => {
  const r = run(visual([col('Bills', 'bill_id'), col('Bills', 'amount', { agg: 'Sum' })],
    [filter('Bills', { Not: { Expression: { In: { Expressions: [colExpr('x', 'status')], Values: [[lit("'Paid'")]] } } } })]));
  assert.deepEqual(rowsOf(r), [[10, 100], [12, 50], [13, 30], [15, 5]]);
});

test('a both-directions relationship lets the many side filter the one side', () => {
  const v = visual([col('Bills', 'bill_id'), col('Bills', 'amount', { agg: 'Sum' })], [filter('Lines', { Comparison: { ComparisonKind: 2, Left: colExpr('x', 'qty'), Right: lit('3D') } })]);
  assert.deepEqual(rowsOf(run(v, model(true))), [[12, 50], [13, 30]]);
  assert.equal(rowsOf(run(v, model(false))).length, 5); // single direction: Lines does not filter Bills (bill 14 is blank, dropped)
});

test('the visual sort is applied, blanks first when ascending', () => {
  const v = visual([col('Bills', 'status'), col('Bills', 'amount', { agg: 'Sum' })], [], { sort: [{ ref: { kind: 'column', table: 'Bills', column: 'amount' }, dir: -1 }] });
  assert.deepEqual(rowsOf(run(v)), [['Open', 180], [null, 5], ['Paid', -20]]);
});

test('unsupported things are reported, not guessed', () => {
  const v = visual([col('Bills', 'bill_id')], [{ type: 'TopN', filter: { Version: 2, From: [], Where: [{ Condition: {} }] } }]);
  const r = checkVisual(v, { visuals: [v], rawFilters: [], interactions: [] }, { rawFilters: [] }, model());
  assert.equal(r.ok, false);
  assert.match(r.reason, /TopN/);
});
