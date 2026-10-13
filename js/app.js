import { unzipSync } from '../vendor/fflate.js';
import { PbixFile, DataType } from './pbix.js';
import { columnFormat, guessFormat, display, displayTotal, raw, toDelimited, downloadText, bytesLabel, fmtCount, isNumericType } from './format.js';
import { Grid } from './grid.js';
import { tryMeasure } from './dax.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const tick = () => new Promise(r => setTimeout(r, 0));
const q = name => '"' + String(name).replace(/"/g, '""') + '"';

const SHORT_TYPE = { [DataType.String]: 'text', [DataType.Int64]: 'whole number', [DataType.Double]: 'decimal', [DataType.DateTime]: 'date/time', [DataType.Decimal]: 'fixed decimal', [DataType.Boolean]: 'true/false', [DataType.Binary]: 'binary' };
const ICON_SEARCH = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path d="m20 20-3.5-3.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const ICON_COPY = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';
const ICON_DOWN = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 19h14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

let SQL = null;
async function getSql() {
  if (!SQL) SQL = await window.initSqlJs({ locateFile: () => 'vendor/sql-wasm-browser.wasm' });
  return SQL;
}

const state = {
  pbix: null,
  fileName: '',
  fileSize: 0,
  tables: [],          // { meta, data: {columns, rowCount} | null, view, order }
  byName: new Map(),
  route: { view: 'overview' },
  grid: null,
  sqlDbPromise: null,  // in-memory SQLite copy of the tables, built on first visit to SQL
  sqlText: '',
  sqlResult: null,
  showAutoTables: false,
  daxCtx: null,
};

// ---------------------------------------------------------------- opening

function show(id) {
  for (const s of ['landing', 'loading', 'error', 'workspace']) $(s).hidden = s !== id;
  document.body.classList.toggle('has-file', id === 'workspace');
}

function setLoading(text) { $('loadingText').textContent = text; }

async function openFile(file) {
  if (!file) return;
  show('loading');
  setLoading('Reading ' + file.name);
  await tick();
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const Sql = await getSql();
    if (state.grid) { state.grid.destroy(); state.grid = null; }
    if (state.pbix) state.pbix.close();
    if (state.sqlDbPromise) {
      const old = state.sqlDbPromise;
      state.sqlDbPromise = null;
      old.then(db => db.close()).catch(() => {});
    }
    const pbix = await PbixFile.open(bytes, { unzipSync, SQL: Sql, onProgress: setLoading });
    const tables = [];
    if (pbix.model) {
      const withData = pbix.model.tables.filter(t => t.hasData);
      for (let i = 0; i < withData.length; i++) {
        const meta = withData[i];
        setLoading(`Decoding ${meta.name} (${i + 1} of ${withData.length})`);
        await tick();
        const data = pbix.decodeTable(meta.name);
        const metaCols = new Map(meta.columns.map(c => [c.name, c]));
        for (const c of data.columns) {
          c.fmt = columnFormat(c.dataType, c.values);
          const m = metaCols.get(c.name);
          c.meta = m || null;
          c.sub = c.error ? 'could not be read' : [SHORT_TYPE[c.dataType] || 'other', m && m.isCalculated ? 'calculated' : null, m && m.isHidden ? 'hidden' : null].filter(Boolean).join(' · ');
        }
        tables.push({ meta, data, view: { search: '', filters: [], sort: null }, order: null });
      }
      for (const meta of pbix.model.tables.filter(t => !t.hasData)) tables.push({ meta, data: null, view: null, order: null });
    }
    Object.assign(state, {
      pbix, fileName: file.name, fileSize: file.size, tables,
      byName: new Map(tables.map(t => [t.meta.name, t])),
      route: { view: 'overview' }, sqlText: '', sqlResult: null, daxCtx: null,
    });
    renderTopbar();
    renderSidebar();
    show('workspace');
    go({ view: 'overview' });
  } catch (e) {
    console.error(e);
    $('errorText').textContent = e && e.message ? e.message : String(e);
    show('error');
  }
}

function renderTopbar() {
  const rows = state.tables.reduce((a, t) => a + (t.data ? t.data.rowCount : 0), 0);
  const n = state.tables.filter(t => t.data).length;
  $('filePill').hidden = false;
  $('filePill').innerHTML = `<strong>${esc(state.fileName)}</strong> · ${bytesLabel(state.fileSize)} · ${n} table${n === 1 ? '' : 's'} · ${fmtCount(rows)} rows`;
  $('filePill').title = state.fileName;
  $('openBtn').querySelector('span').textContent = 'Open another';
}

// ---------------------------------------------------------------- navigation

function visibleTables() {
  return state.tables.filter(t => t.data && (state.showAutoTables || !t.meta.isAutoDate));
}

function renderSidebar() {
  const m = state.pbix.model;
  const pages = state.pbix.report.pages.length;
  const item = (route, label, count, extra = '') =>
    `<button class="nav-item${extra}" data-route='${esc(JSON.stringify(route))}'><span class="label">${esc(label)}</span>${count != null ? `<span class="count">${count}</span>` : ''}</button>`;
  let h = '<div class="nav-group"><div class="nav-title">File</div>';
  h += item({ view: 'overview' }, 'Overview');
  if (m) {
    h += item({ view: 'measures' }, 'Measures', m.measures.length);
    h += item({ view: 'relationships' }, 'Relationships', m.relationships.length);
  }
  h += item({ view: 'report' }, 'Report pages', pages);
  if (m) h += item({ view: 'sql' }, 'SQL');
  h += '</div>';
  if (m) {
    h += '<div class="nav-group"><div class="nav-title">Tables</div>';
    for (const t of visibleTables()) {
      h += item({ view: 'table', table: t.meta.name, tab: 'data' }, t.meta.name, fmtCount(t.data.rowCount), t.meta.isHidden || t.meta.isAutoDate ? ' dim' : '');
    }
    const auto = state.tables.filter(t => t.data && t.meta.isAutoDate).length;
    if (auto) h += `<button class="nav-item nav-toggle" id="toggleAuto"><span class="label">${state.showAutoTables ? 'Hide' : 'Show'} ${auto} auto date table${auto === 1 ? '' : 's'}</span></button>`;
    h += '</div>';
  }
  const sb = $('sidebar');
  sb.innerHTML = h;
  sb.querySelectorAll('[data-route]').forEach(b => b.addEventListener('click', () => go(JSON.parse(b.dataset.route))));
  const toggle = $('toggleAuto');
  if (toggle) toggle.addEventListener('click', () => { state.showAutoTables = !state.showAutoTables; renderSidebar(); markActive(); });
  markActive();
}

function markActive() {
  const r = state.route;
  $('sidebar').querySelectorAll('[data-route]').forEach(b => {
    const br = JSON.parse(b.dataset.route);
    b.classList.toggle('active', br.view === r.view && (br.view !== 'table' || br.table === r.table));
  });
}

function go(route) {
  if (state.grid) { state.grid.destroy(); state.grid = null; }
  state.route = route;
  markActive();
  const c = $('content');
  c.classList.remove('fill');
  c.scrollTop = 0;
  switch (route.view) {
    case 'overview': return renderOverview(c);
    case 'table': return renderTable(c, state.byName.get(route.table), route.tab || 'data');
    case 'measures': return renderMeasures(c);
    case 'relationships': return renderRelationships(c);
    case 'report': return renderReport(c);
    case 'sql': return renderSql(c);
  }
}

// ---------------------------------------------------------------- helpers

function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 3200);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

const exportName = (part, ext) => `${part} - ${state.fileName.replace(/\.pbi[xt]$/i, '')}.${ext}`;

function formatScalar(v) {
  if (v == null) return '(blank)';
  if (typeof v !== 'number') return String(v);
  return Number.isInteger(v) ? fmtCount(v) : display(v, { kind: 'number', decimals: 6 });
}

function daxContext() {
  if (state.daxCtx) return state.daxCtx;
  const cache = new Map();
  state.daxCtx = {
    measures: state.pbix.model.measures,
    getTable(name) {
      const t = state.byName.get(name);
      if (!t || !t.data) return null;
      if (!cache.has(name)) {
        cache.set(name, {
          name,
          rowCount: t.data.rowCount,
          columns: new Map(t.data.columns.map(c => [c.name, { values: c.values, numeric: isNumericType(c.dataType) }])),
        });
      }
      return cache.get(name);
    },
  };
  return state.daxCtx;
}

// ---------------------------------------------------------------- overview

function renderOverview(c) {
  const { pbix } = state;
  const m = pbix.model;
  const dataTables = state.tables.filter(t => t.data);
  const rows = dataTables.reduce((a, t) => a + t.data.rowCount, 0);
  const cols = dataTables.reduce((a, t) => a + t.data.columns.length, 0);
  let h = `<div class="page-head"><h2>${esc(state.fileName)}</h2><div class="chips">` +
    `<span class="chip">${bytesLabel(state.fileSize)}</span>` +
    (pbix.version ? `<span class="chip">File version ${esc(pbix.version)}</span>` : '') +
    (m && m.culture ? `<span class="chip">Culture ${esc(m.culture)}</span>` : '') +
    `<span class="chip">Report format ${esc(pbix.report.format)}</span></div></div>`;
  if (!m) {
    h += `<div class="note">This file has no data model inside it${pbix.liveConnection ? ': it is a live-connection report whose data lives on a server' : ''}. Only its report pages can be shown.</div>`;
    c.innerHTML = h;
    return;
  }
  h += '<div class="tiles">' +
    tile(fmtCount(dataTables.length), 'tables with data') +
    tile(fmtCount(rows), 'rows') +
    tile(fmtCount(cols), 'columns') +
    tile(fmtCount(m.measures.length), 'measures') +
    tile(fmtCount(m.relationships.length), 'relationships') +
    tile(fmtCount(pbix.report.pages.length), 'report pages') + '</div>';
  h += `<div class="note info">Everything here is read from the data stored in the file, as of its last refresh in Power BI Desktop. Totals and checks follow your filters; measures are listed with their DAX, and simple ones get a grand total.</div>`;
  h += '<div class="panel"><h3>Tables</h3><div class="table-wrap"><table class="list"><thead><tr><th>Table</th><th class="num">Rows</th><th class="num">Columns</th><th>Source</th><th>Notes</th></tr></thead><tbody>';
  for (const t of state.tables) {
    const notes = [t.meta.isHidden ? 'hidden' : null, t.meta.isAutoDate ? 'auto date table' : null, !t.data ? 'no stored rows' : null].filter(Boolean).join(', ');
    h += `<tr class="${t.data ? 'click' : ''}" data-table="${esc(t.meta.name)}"><td>${esc(t.meta.name)}</td>` +
      `<td class="num">${t.data ? fmtCount(t.data.rowCount) : '–'}</td><td class="num">${t.data ? t.data.columns.length : '–'}</td>` +
      `<td>${esc(t.meta.source)}</td><td class="muted">${esc(notes)}</td></tr>`;
  }
  h += '</tbody></table></div></div>';
  c.innerHTML = h;
  c.querySelectorAll('tr.click').forEach(tr => tr.addEventListener('click', () => go({ view: 'table', table: tr.dataset.table, tab: 'data' })));
}

const tile = (v, k) => `<div class="tile"><div class="v">${v}</div><div class="k">${esc(k)}</div></div>`;

// ---------------------------------------------------------------- table view

function renderTable(c, t, tab) {
  if (!t) return renderOverview(c);
  const { meta, data } = t;
  let h = `<div class="page-head"><h2>${esc(meta.name)}</h2><div class="chips">` +
    `<span class="chip">${fmtCount(data.rowCount)} rows</span><span class="chip">${data.columns.length} columns</span>` +
    `<span class="chip">${esc(meta.source)}</span>` + (meta.isHidden ? '<span class="chip warn">hidden in report</span>' : '') + '</div></div>';
  const broken = data.columns.filter(col => col.error);
  if (broken.length) {
    h += `<div class="note">${broken.length === 1 ? 'One column' : broken.length + ' columns'} could not be read and ${broken.length === 1 ? 'is' : 'are'} shown blank; do not use ${broken.length === 1 ? 'it' : 'them'} for checks: ` +
      broken.map(col => `<strong>${esc(col.name)}</strong> (${esc(col.error)})`).join(', ') + '.</div>';
  }
  const tabs = [['data', 'Data'], ['profile', 'Column checks'], ['columns', 'Model columns'], ['source', 'Source query']];
  h += '<div class="tabs" role="tablist">' + tabs.map(([k, l]) => `<button class="tab${k === tab ? ' active' : ''}" data-tab="${k}" role="tab">${l}</button>`).join('') + '</div><div id="tabBody" class="tab-body"></div>';
  c.innerHTML = h;
  c.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => go({ view: 'table', table: meta.name, tab: b.dataset.tab })));
  const body = $('tabBody');
  if (tab === 'data') {
    c.classList.add('fill');
    body.className = 'tab-body data-area';
    renderTableData(body, t);
  } else if (tab === 'profile') renderProfile(body, t);
  else if (tab === 'columns') renderModelColumns(body, t);
  else renderSource(body, t);
}

function makePredicate(text, col) {
  const s = text.trim();
  if (!s) return null;
  const isBlank = v => v == null || v === '';
  if (/^\(?blank\)?$/i.test(s)) return isBlank;
  if (/^(!|not\s*)\(?blank\)?$/i.test(s)) return v => !isBlank(v);
  const kind = col.fmt.kind;
  const numeric = kind === 'int' || kind === 'number';
  const toNum = str => {
    if (kind === 'date') {
      const d = Date.parse(str.length <= 10 ? str + 'T00:00:00Z' : str.replace(' ', 'T') + 'Z');
      return Number.isNaN(d) ? NaN : d;
    }
    return Number(str.replace(/,/g, ''));
  };
  const valNum = v => (v instanceof Date ? v.getTime() : Number(v));
  if (numeric || kind === 'date') {
    const range = s.match(/^(.+?)\s*\.\.\s*(.+)$/);
    if (range) {
      const a = toNum(range[1]), b = toNum(range[2]);
      if (!Number.isNaN(a) && !Number.isNaN(b)) return v => v != null && valNum(v) >= a && valNum(v) <= b;
    }
    const m = s.match(/^(>=|<=|<>|!=|=|>|<)\s*(.+)$/);
    if (m) {
      const n = toNum(m[2]);
      if (!Number.isNaN(n)) {
        const ops = { '>=': (x) => x >= n, '<=': (x) => x <= n, '>': (x) => x > n, '<': (x) => x < n, '=': (x) => x === n, '!=': (x) => x !== n, '<>': (x) => x !== n };
        if (kind === 'date' && m[1] === '=' && m[2].trim().length <= 10) return v => v != null && valNum(v) >= n && valNum(v) < n + 86400000;
        const op = ops[m[1]];
        return v => v != null && op(valNum(v));
      }
    }
  } else {
    const m = s.match(/^(=|!=|<>)\s*(.*)$/);
    if (m) {
      const target = m[2].toLowerCase();
      return m[1] === '=' ? v => v != null && display(v, col.fmt).toLowerCase() === target : v => v == null || display(v, col.fmt).toLowerCase() !== target;
    }
  }
  const needle = s.toLowerCase();
  return v => v != null && (display(v, col.fmt).toLowerCase().includes(needle) || raw(v, col.fmt).toLowerCase().includes(needle));
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function buildOrder(t) {
  const { columns, rowCount } = t.data;
  const v = t.view;
  const preds = columns.map((col, i) => (v.filters[i] ? makePredicate(v.filters[i], col) : null));
  const active = preds.map((p, i) => [p, columns[i].values]).filter(([p]) => p);
  const needle = v.search.trim().toLowerCase();
  const order = [];
  for (let r = 0; r < rowCount; r++) {
    let ok = true;
    for (let k = 0; k < active.length; k++) if (!active[k][0](active[k][1][r])) { ok = false; break; }
    if (ok && needle) {
      ok = false;
      for (let ci = 0; ci < columns.length; ci++) {
        const val = columns[ci].values[r];
        if (val == null) continue;
        if (display(val, columns[ci].fmt).toLowerCase().includes(needle) || raw(val, columns[ci].fmt).toLowerCase().includes(needle)) { ok = true; break; }
      }
    }
    if (ok) order.push(r);
  }
  if (v.sort) {
    const vals = columns[v.sort.col].values;
    const dir = v.sort.dir;
    const key = x => (x instanceof Date ? x.getTime() : typeof x === 'bigint' ? Number(x) : typeof x === 'boolean' ? Number(x) : x);
    order.sort((a, b) => {
      const x = vals[a], y = vals[b];
      if (x == null || y == null) return x == null && y == null ? a - b : x == null ? 1 : -1;
      const kx = key(x), ky = key(y);
      const cmp = typeof kx === 'string' || typeof ky === 'string' ? collator.compare(String(kx), String(ky)) : kx - ky;
      return cmp ? cmp * dir : a - b;
    });
  }
  t.order = order;
}

function computeTotals(t) {
  return t.data.columns.map(c => {
    if (isNumericType(c.dataType)) {
      let s = 0, n = 0;
      for (const r of t.order) { const v = c.values[r]; if (v != null) { s += Number(v); n++; } }
      if (!n) return null;
      const text = displayTotal(s, c.fmt);
      return { text, kind: 'sum', title: `Sum of ${c.name} over ${fmtCount(t.order.length)} rows`, negative: s < 0 };
    }
    let n = 0;
    for (const r of t.order) { const v = c.values[r]; if (v != null && v !== '') n++; }
    return { text: fmtCount(n), kind: 'count', title: `${fmtCount(n)} non-blank values in ${c.name}` };
  });
}

function filtersActive(t) {
  return !!(t.view.search.trim() || t.view.filters.some(f => f && f.trim()));
}

function renderTableData(body, t) {
  if (!t.order) buildOrder(t);
  body.innerHTML = `<div class="toolbar">
      <label class="search">${ICON_SEARCH}<input type="search" id="tblSearch" placeholder="Search all columns" value="${esc(t.view.search)}" aria-label="Search all columns"></label>
      <button class="btn btn-small" id="clearFilters">Clear filters</button>
      <span class="count-label" id="countLabel"></span>
      <span class="spacer"></span>
      <button class="btn btn-small" id="copyExcel" title="Copies the rows that match your filters, ready to paste into Excel">${ICON_COPY}Copy for Excel</button>
      <button class="btn btn-small" id="downloadCsv">${ICON_DOWN}Download CSV</button>
    </div>
    <div id="gridHost"></div>
    <div class="statusbar" id="statusbar">Click a cell to select it, then press <kbd>Ctrl</kbd>+<kbd>C</kbd> to copy its exact value. Filters accept text, <kbd>&gt;100</kbd>, <kbd>&lt;0</kbd>, <kbd>=2026-01-31</kbd>, <kbd>10..20</kbd> or <kbd>blank</kbd>.</div>`;
  const cols = t.data.columns;
  const countLabel = $('countLabel');
  const setCount = () => {
    countLabel.textContent = filtersActive(t) ? `${fmtCount(t.order.length)} of ${fmtCount(t.data.rowCount)} rows` : `${fmtCount(t.data.rowCount)} rows`;
  };
  const totalsLabel = () => `Totals for the ${fmtCount(t.order.length)} rows shown`;
  const grid = new Grid($('gridHost'), {
    columns: cols.map(c => ({ name: c.name, fmt: c.fmt, sub: c.sub })),
    rowCount: t.order.length,
    getValue: (r, ci) => cols[ci].values[t.order[r]],
    filters: t.view.filters,
    onFilter: (ci, text) => { t.view.filters[ci] = text; refresh(); },
    sort: t.view.sort,
    onSort: ci => {
      const s = t.view.sort;
      t.view.sort = !s || s.col !== ci ? { col: ci, dir: 1 } : s.dir === 1 ? { col: ci, dir: -1 } : null;
      refresh();
    },
    totals: computeTotals(t),
    totalsLabel: totalsLabel(),
    onSelect: ({ row, column, value }) => {
      $('statusbar').innerHTML = `Row ${fmtCount(row + 1)} · <strong>${esc(column.name)}</strong> = ${value == null ? '<em>blank</em>' : esc(raw(value, column.fmt))} <span class="muted">· <kbd>Ctrl</kbd>+<kbd>C</kbd> copies it</span>`;
    },
    onCopy: async ({ row, col }) => {
      const v = cols[col].values[t.order[row]];
      if (await copyText(raw(v, cols[col].fmt))) toast('Copied the cell value');
    },
  });
  state.grid = grid;
  setCount();
  function refresh() {
    buildOrder(t);
    grid.update({ rowCount: t.order.length, totals: computeTotals(t), totalsLabel: totalsLabel(), sort: t.view.sort });
    setCount();
  }
  let timer = 0;
  $('tblSearch').addEventListener('input', e => {
    clearTimeout(timer);
    timer = setTimeout(() => { t.view.search = e.target.value; refresh(); }, 220);
  });
  $('clearFilters').addEventListener('click', () => {
    t.view = { search: '', filters: [], sort: null };
    t.order = null;
    go({ view: 'table', table: t.meta.name, tab: 'data' });
  });
  $('copyExcel').addEventListener('click', async () => {
    const text = toDelimited(cols, t.order, '\t');
    if (await copyText(text)) toast(`Copied ${fmtCount(t.order.length)} rows × ${cols.length} columns. Paste into Excel.`);
    else toast('Copying was blocked by the browser; use Download CSV instead.');
  });
  $('downloadCsv').addEventListener('click', () => {
    downloadText(toDelimited(cols, t.order, ','), exportName(t.meta.name, 'csv'), 'text/csv;charset=utf-8');
  });
}

function renderProfile(body, t) {
  if (!t.order) buildOrder(t);
  const n = t.order.length;
  let h = `<p class="muted" style="margin:0 0 12px">${filtersActive(t)
    ? `Based on the <strong>${fmtCount(n)}</strong> of ${fmtCount(t.data.rowCount)} rows that match the filters on the Data tab.`
    : `Based on all <strong>${fmtCount(n)}</strong> rows.`} Use these to tie the table back to the source system.</p>`;
  h += '<div class="panel"><div class="table-wrap"><table class="list"><thead><tr><th>Column</th><th>Type</th><th class="num">Non-blank</th><th class="num">Blank</th><th class="num">Distinct</th><th class="num">Sum</th><th>Minimum</th><th>Maximum</th></tr></thead><tbody>';
  const key = v => (v instanceof Date ? v.getTime() : typeof v === 'bigint' || typeof v === 'boolean' ? Number(v) : v);
  const less = (a, b) => (typeof a === 'string' ? collator.compare(a, b) < 0 : a < b);
  for (const c of t.data.columns) {
    let nonBlank = 0, min = null, max = null, minK = null, maxK = null, sum = 0;
    const distinct = new Set();
    const numeric = isNumericType(c.dataType);
    for (const r of t.order) {
      const v = c.values[r];
      distinct.add(key(v));
      if (v == null || v === '') continue;
      nonBlank++;
      const k = key(v);
      if (minK == null || less(k, minK)) { minK = k; min = v; }
      if (maxK == null || less(maxK, k)) { maxK = k; max = v; }
      if (numeric) sum += Number(v);
    }
    const blank = n - nonBlank;
    const cell = (v, extra) => {
      if (v == null) return '<td></td>';
      const s = display(v, c.fmt);
      const cls = ['clip', numeric ? 'tabular' : '', numeric && v < 0 ? 'neg' : '', extra].filter(Boolean).join(' ');
      return `<td class="${cls}" title="${esc(s)}">${esc(s)}</td>`;
    };
    h += `<tr><td>${esc(c.name)}</td><td class="muted nowrap">${esc(c.sub)}</td><td class="num">${fmtCount(nonBlank)}</td>` +
      `<td class="num">${blank ? fmtCount(blank) : '0'}</td><td class="num">${fmtCount(distinct.size)}</td>` +
      `<td class="num strong${sum < 0 ? ' neg' : ''}">${numeric && nonBlank ? esc(displayTotal(sum, c.fmt)) : ''}</td>` +
      cell(min) + cell(max) + '</tr>';
  }
  h += '</tbody></table></div></div>';
  body.innerHTML = h;
}

function renderModelColumns(body, t) {
  const cols = t.meta.columns;
  let h = '<div class="panel"><div class="table-wrap"><table class="list"><thead><tr><th>Column</th><th>Type</th><th>Kind</th><th>Hidden</th><th>Format string</th><th>Expression / description</th></tr></thead><tbody>';
  for (const c of cols) {
    h += `<tr><td>${esc(c.name)}</td><td>${esc(c.typeName)}</td><td>${c.isCalculated ? 'Calculated (DAX)' : c.kind === 4 ? 'Calculated table column' : 'Data'}</td>` +
      `<td>${c.isHidden ? 'Yes' : ''}</td><td class="mono">${esc(c.formatString || '')}</td>` +
      `<td>${c.expression ? `<pre class="code">${esc(c.expression.trim())}</pre>` : ''}${c.description ? `<div class="muted">${esc(c.description)}</div>` : ''}</td></tr>`;
  }
  h += '</tbody></table></div></div>';
  body.innerHTML = h;
}

function renderSource(body, t) {
  const parts = t.meta.partitions.filter(p => p.query);
  let h = '';
  if (!parts.length && state.pbix.mashup) {
    h += '<p class="muted">This table has no query in the model; the Power Query document of the file is shown instead.</p>' + `<pre class="code">${esc(state.pbix.mashup)}</pre>`;
  } else if (!parts.length) {
    h += '<p class="muted">No source query is stored for this table.</p>';
  }
  for (const p of parts) {
    const kind = p.type === 4 ? 'Power Query (M)' : p.type === 2 ? 'DAX' : 'Query';
    const mode = p.mode === 1 ? 'DirectQuery' : p.mode === 0 ? 'Import' : p.mode === 2 ? 'Push' : null;
    h += `<div class="card"><div class="card-head"><h3>${esc(p.name)}</h3><span class="chip">${kind}</span>${mode ? `<span class="chip">${mode}</span>` : ''}<span class="spacer"></span>` +
      `<button class="btn btn-small" data-copy="${esc(p.query)}">${ICON_COPY}Copy</button></div><pre class="code">${esc(p.query.trim())}</pre></div>`;
  }
  body.innerHTML = `<div class="cards">${h}</div>`;
  wireCopyButtons(body);
}

function wireCopyButtons(root) {
  root.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', async () => {
    if (await copyText(b.dataset.copy)) toast('Copied');
  }));
}

// ---------------------------------------------------------------- measures

function renderMeasures(c) {
  const ms = state.pbix.model.measures;
  let h = `<div class="page-head"><h2>Measures</h2><div class="chips"><span class="chip">${ms.length}</span></div></div>`;
  h += '<div class="note info">Measures are calculated by Power BI from the filters on each visual, so this page cannot reproduce every number on the report. For simple measures it works out the <strong>grand total with no filters</strong>, straight from the stored rows, and shows the matching SQL so you can add your own filters.</div>';
  if (!ms.length) h += '<p class="muted">This model has no measures.</p>';
  h += '<div class="cards">';
  const ctx = daxContext();
  for (const m of ms) {
    const r = tryMeasure(m.expression, ctx);
    h += `<div class="card"><div class="card-head"><h3>${esc(m.name)}</h3><span class="chip">${esc(m.tableName)}</span>` +
      (m.displayFolder ? `<span class="chip">${esc(m.displayFolder)}</span>` : '') +
      (m.formatString ? `<span class="chip">format ${esc(m.formatString)}</span>` : '') +
      (m.isHidden ? '<span class="chip warn">hidden</span>' : '') +
      `<span class="spacer"></span><button class="btn btn-small" data-copy="${esc(m.expression)}">${ICON_COPY}Copy DAX</button></div>` +
      `<pre class="code">${esc((m.expression || '').trim())}</pre>`;
    if (r.ok) {
      h += `<div class="result"><span class="muted">Grand total, no filters</span><span class="total${typeof r.value === 'number' && r.value < 0 ? ' neg' : ''}">${esc(formatScalar(r.value))}</span>` +
        (r.sql ? `<code>${esc(r.sql)}</code><button class="btn btn-small" data-sql="${esc(r.sql)}">Open in SQL</button>` : '') + '</div>';
    } else {
      h += `<div class="result"><span class="why">Not worked out here: ${esc(r.reason)}.</span></div>`;
    }
    if (m.description) h += `<p class="muted">${esc(m.description)}</p>`;
    h += '</div>';
  }
  h += '</div>';
  c.innerHTML = h;
  wireCopyButtons(c);
  c.querySelectorAll('[data-sql]').forEach(b => b.addEventListener('click', () => { state.sqlText = b.dataset.sql; state.sqlResult = null; go({ view: 'sql', run: true }); }));
}

// ---------------------------------------------------------------- relationships

function renderRelationships(c) {
  const rels = state.pbix.model.relationships;
  const card = v => (v === 2 ? 'Many' : v === 1 ? 'One' : '?');
  const cross = v => (v === 2 ? 'Both directions' : v === 1 ? 'Single' : v === 3 ? 'Automatic' : '');
  let h = `<div class="page-head"><h2>Relationships</h2><div class="chips"><span class="chip">${rels.length}</span></div></div>`;
  if (!rels.length) { c.innerHTML = h + '<p class="muted">This model has no relationships.</p>'; return; }
  h += '<div class="panel"><div class="table-wrap"><table class="list"><thead><tr><th>From</th><th></th><th>To</th><th>Cardinality</th><th>Cross filter</th><th>Active</th></tr></thead><tbody>';
  for (const r of rels) {
    h += `<tr><td>${esc(r.fromTable)}<span class="muted">[${esc(r.fromColumn)}]</span></td><td class="muted">→</td>` +
      `<td>${esc(r.toTable)}<span class="muted">[${esc(r.toColumn)}]</span></td><td>${card(r.fromCardinality)} to ${card(r.toCardinality).toLowerCase()}</td>` +
      `<td>${cross(r.crossFilter)}</td><td>${r.isActive ? 'Yes' : '<span class="chip warn">inactive</span>'}</td></tr>`;
  }
  h += '</tbody></table></div></div>';
  c.innerHTML = h;
}

// ---------------------------------------------------------------- report

const VISUAL_NAMES = {
  tableEx: 'Table', pivotTable: 'Matrix', card: 'Card', cardVisual: 'Card', multiRowCard: 'Multi-row card', slicer: 'Slicer',
  textbox: 'Text box', image: 'Image', shape: 'Shape', actionButton: 'Button', basicShape: 'Shape', group: 'Group',
  clusteredBarChart: 'Clustered bar chart', clusteredColumnChart: 'Clustered column chart', lineChart: 'Line chart',
  pieChart: 'Pie chart', donutChart: 'Donut chart', kpi: 'KPI', gauge: 'Gauge', map: 'Map', filledMap: 'Filled map',
  areaChart: 'Area chart', waterfallChart: 'Waterfall chart', scatterChart: 'Scatter chart', treemap: 'Treemap',
};
const prettyType = t => VISUAL_NAMES[t] || String(t).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, s => s.toUpperCase());

function renderReport(c) {
  const { pages } = state.pbix.report;
  const measureRefs = new Set((state.pbix.model ? state.pbix.model.measures : []).map(m => `${m.tableName}[${m.name}]`));
  let h = `<div class="page-head"><h2>Report pages</h2><div class="chips"><span class="chip">${pages.length} page${pages.length === 1 ? '' : 's'}</span></div></div>`;
  if (!pages.length) h += '<p class="muted">No report pages were found in this file.</p>';
  h += '<p class="muted" style="margin:0 0 14px">Charts are not drawn here; each visual lists the fields it shows and any filter it applies. When a number on the report does not match your source, check its filters first.</p>';
  const filterLine = (label, list) => (list.length ? `<div class="filters"><span class="filters-label">${label}</span>${list.map(f => `<span class="filter">${esc(f)}</span>`).join('')}</div>` : '');
  if (state.pbix.report.filters && state.pbix.report.filters.length) h += `<div class="panel" style="padding:12px 16px">${filterLine('Filters on all pages', state.pbix.report.filters)}</div>`;
  for (const p of pages) {
    h += `<div class="panel"><h3>${esc(p.name)} <span class="muted" style="font-weight:400">· ${p.visuals.length} visual${p.visuals.length === 1 ? '' : 's'}${p.hidden ? ' · hidden page' : ''}</span></h3>`;
    if (p.filters.length) h += `<div class="panel-note">${filterLine('Filters on this page', p.filters)}</div>`;
    h += '<div class="visual-list">';
    for (const v of p.visuals) {
      const sub = [v.title ? prettyType(v.type) : null, v.hidden ? 'hidden' : null].filter(Boolean).join(' · ');
      h += `<div class="visual"><div class="vt">${esc(v.title || prettyType(v.type))}</div>${sub ? `<div class="vs">${esc(sub)}</div>` : ''}`;
      if (v.fields.length) {
        const roles = [...new Set(v.fields.map(f => f.role))];
        for (const role of roles) {
          h += `<div class="role-group"><div class="role">${esc(role)}</div><div class="fields">` + v.fields.filter(f => f.role === role).map(f => {
            const base = f.field.replace(/^[A-Za-z]+\((.*)\)$/, '$1');
            const isMeasure = measureRefs.has(base);
            return `<span class="field${isMeasure ? ' measure' : ''}" title="${esc([isMeasure ? 'Measure' : null, f.label ? 'Shown as ' + f.label : null].filter(Boolean).join(' · '))}">${esc(f.field)}</span>`;
          }).join('') + '</div></div>';
        }
      } else {
        h += '<div class="muted" style="font-size:12.5px">No data fields</div>';
      }
      h += filterLine('Filtered to', v.filters);
      h += '</div>';
    }
    h += '</div></div>';
  }
  c.innerHTML = h;
}

// ---------------------------------------------------------------- SQL

function ensureSqlDb() {
  if (!state.sqlDbPromise) state.sqlDbPromise = buildSqlDb();
  return state.sqlDbPromise;
}

async function buildSqlDb() {
  const tables = state.tables.filter(x => x.data); // captured: a new file may open while this runs
  const Sql = await getSql();
  const db = new Sql.Database();
  db.run('BEGIN');
  for (const t of tables) {
    const cols = t.data.columns;
    const typeOf = c => (c.dataType === DataType.Int64 || c.dataType === DataType.Boolean ? 'INTEGER' : c.dataType === DataType.Double || c.dataType === DataType.Decimal ? 'REAL' : 'TEXT');
    db.run(`CREATE TABLE ${q(t.meta.name)} (${cols.map(c => `${q(c.name)} ${typeOf(c)}`).join(', ')})`);
    const stmt = db.prepare(`INSERT INTO ${q(t.meta.name)} VALUES (${cols.map(() => '?').join(',')})`);
    const toSql = (v, c) => (v == null ? null : v instanceof Date ? raw(v, c.fmt) : typeof v === 'boolean' ? (v ? 1 : 0) : typeof v === 'bigint' ? v.toString() : v);
    for (let r = 0; r < t.data.rowCount; r++) stmt.run(cols.map(c => toSql(c.values[r], c)));
    stmt.free();
    await tick();
  }
  db.run('COMMIT');
  return db;
}

function sqlExamples() {
  const tables = state.tables.filter(t => t.data && !t.meta.isAutoDate);
  const ex = [];
  if (tables.length) ex.push(['Row count of every table', tables.map(t => `SELECT '${t.meta.name.replace(/'/g, "''")}' AS table_name, COUNT(*) AS row_count FROM ${q(t.meta.name)}`).join('\nUNION ALL\n')]);
  const withNums = tables.find(t => t.data.columns.some(c => c.dataType === DataType.Double || c.dataType === DataType.Decimal));
  if (withNums) {
    const nums = withNums.data.columns.filter(c => c.dataType === DataType.Double || c.dataType === DataType.Decimal).slice(0, 5);
    ex.push([`Totals of ${withNums.meta.name}`, `SELECT COUNT(*) AS row_count,\n       ${nums.map(c => `ROUND(SUM(${q(c.name)}), 2) AS ${q(c.name)}`).join(',\n       ')}\nFROM ${q(withNums.meta.name)}`]);
    const group = withNums.data.columns.find(c => c.dataType === DataType.String && new Set(c.values).size <= 60 && new Set(c.values).size > 1);
    if (group) ex.push([`${withNums.meta.name} by ${group.name}`, `SELECT ${q(group.name)}, COUNT(*) AS row_count, ROUND(SUM(${q(nums[0].name)}), 2) AS ${q(nums[0].name)}\nFROM ${q(withNums.meta.name)}\nGROUP BY ${q(group.name)}\nORDER BY ${q(group.name)}`]);
  }
  return ex;
}

async function renderSql(c) {
  c.classList.add('fill');
  c.innerHTML = '<div class="loading"><div class="spinner"></div><p>Loading the tables into the SQL engine</p></div>';
  const pending = ensureSqlDb();
  const db = await pending;
  if (state.route.view !== 'sql' || pending !== state.sqlDbPromise) return; // navigated away or opened another file
  const examples = sqlExamples();
  if (!state.sqlText) state.sqlText = examples.length ? examples[0][1] : 'SELECT 1';
  let side = '<h4>Tables</h4>';
  for (const t of state.tables.filter(x => x.data)) {
    side += `<details><summary data-insert="${esc(q(t.meta.name))}">${esc(t.meta.name)}</summary><ul>` +
      t.data.columns.map(col => `<li data-insert="${esc(q(col.name))}" title="${esc(col.sub)}">${esc(col.name)}</li>`).join('') + '</ul></details>';
  }
  c.innerHTML = `<div class="page-head"><h2>SQL</h2><div class="chips"><span class="chip">SQLite, in your browser</span></div></div>
    <div class="sql-layout">
      <div class="sql-main">
        <div class="toolbar"><span class="muted">Examples:</span><div class="examples">${examples.map((e, i) => `<button class="btn btn-small" data-example="${i}">${esc(e[0])}</button>`).join('')}</div></div>
        <textarea class="sql-editor" id="sqlEditor" spellcheck="false" aria-label="SQL query">${esc(state.sqlText)}</textarea>
        <div class="toolbar" style="margin-top:8px">
          <button class="btn btn-primary btn-small" id="runSql">Run <span style="opacity:.75;font-weight:400">Ctrl+Enter</span></button>
          <span class="count-label" id="sqlStatus"></span><span class="spacer"></span>
          <button class="btn btn-small" id="sqlCopy" disabled>${ICON_COPY}Copy for Excel</button>
          <button class="btn btn-small" id="sqlCsv" disabled>${ICON_DOWN}Download CSV</button>
        </div>
        <div id="sqlError" class="sql-error" hidden></div>
        <div class="data-area" style="min-height:200px"><div id="sqlGrid"></div></div>
        <p class="muted" style="margin:8px 0 0;font-size:12.5px">Names with spaces need double quotes, like <code>"AP Transactions"</code>. Dates are text such as <code>'2026-01-31'</code>; true/false are 1/0. Changes you make here stay in this browser tab and never touch the file.</p>
      </div>
      <aside class="sql-side">${side}</aside>
    </div>`;
  const editor = $('sqlEditor');
  const run = () => runSql(db, editor.value);
  $('runSql').addEventListener('click', run);
  editor.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); } });
  editor.addEventListener('input', () => { state.sqlText = editor.value; });
  c.querySelectorAll('[data-example]').forEach(b => b.addEventListener('click', () => { editor.value = examples[Number(b.dataset.example)][1]; state.sqlText = editor.value; run(); }));
  c.querySelectorAll('[data-insert]').forEach(el => el.addEventListener('click', e => {
    if (el.tagName === 'SUMMARY' && !e.altKey) return;
    const text = el.dataset.insert;
    const s = editor.selectionStart, en = editor.selectionEnd;
    editor.value = editor.value.slice(0, s) + text + editor.value.slice(en);
    editor.focus();
    editor.selectionStart = editor.selectionEnd = s + text.length;
    state.sqlText = editor.value;
  }));
  $('sqlCopy').addEventListener('click', async () => {
    const r = state.sqlResult;
    if (r && await copyText(toDelimited(r.columns, r.order, '\t'))) toast(`Copied ${fmtCount(r.order.length)} rows. Paste into Excel.`);
  });
  $('sqlCsv').addEventListener('click', () => {
    const r = state.sqlResult;
    if (r) downloadText(toDelimited(r.columns, r.order, ','), exportName('SQL result', 'csv'), 'text/csv;charset=utf-8');
  });
  if (state.sqlResult) showSqlResult(state.sqlResult);
  else run();
}

function runSql(db, text) {
  const status = $('sqlStatus');
  const err = $('sqlError');
  err.hidden = true;
  const t0 = performance.now();
  let res;
  try {
    res = db.exec(text);
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
    status.textContent = '';
    return;
  }
  const ms = Math.round(performance.now() - t0);
  if (!res.length) {
    state.sqlResult = null;
    if (state.grid) { state.grid.destroy(); state.grid = null; }
    status.textContent = `Ran in ${ms} ms; no rows returned.`;
    $('sqlCopy').disabled = $('sqlCsv').disabled = true;
    return;
  }
  const last = res[res.length - 1];
  const columns = last.columns.map((name, i) => {
    const values = last.values.map(row => row[i]);
    return { name, values, fmt: guessFormat(values) };
  });
  state.sqlResult = { columns, order: last.values.map((_, i) => i), ms };
  showSqlResult(state.sqlResult);
}

function showSqlResult(r) {
  if (state.grid) { state.grid.destroy(); state.grid = null; }
  $('sqlStatus').textContent = `${fmtCount(r.order.length)} row${r.order.length === 1 ? '' : 's'} · ${r.ms} ms`;
  $('sqlCopy').disabled = $('sqlCsv').disabled = false;
  state.grid = new Grid($('sqlGrid'), {
    columns: r.columns.map(c => ({ name: c.name, fmt: c.fmt })),
    rowCount: r.order.length,
    getValue: (row, ci) => r.columns[ci].values[row],
    onCopy: async ({ row, col }) => { if (await copyText(raw(r.columns[col].values[row], r.columns[col].fmt))) toast('Copied the cell value'); },
  });
}

// ---------------------------------------------------------------- wiring

for (const id of ['fileInput', 'fileInput2', 'fileInput3']) {
  $(id).addEventListener('change', e => { openFile(e.target.files[0]); e.target.value = ''; });
}
document.querySelectorAll('label.btn, label.dropzone').forEach(l => {
  l.tabIndex = 0;
  l.setAttribute('role', 'button');
  l.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); l.querySelector('input').click(); } });
});

let dragDepth = 0;
window.addEventListener('dragenter', e => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { dragDepth++; $('dropOverlay').hidden = false; $('dropzone').classList.add('over'); } });
window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) { $('dropOverlay').hidden = true; $('dropzone').classList.remove('over'); } });
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => {
  e.preventDefault();
  dragDepth = 0;
  $('dropOverlay').hidden = true;
  $('dropzone').classList.remove('over');
  const f = e.dataTransfer && e.dataTransfer.files[0];
  if (f) openFile(f);
});

// Lets automated checks open a file the same way a drop does.
window.pbixViewer = { openFile };
