// Display formatting and export (CSV / tab-separated for pasting into Excel).
import { DataType } from './vertipaq.js';

const pad = n => String(n).padStart(2, '0');

export function isNumericType(t) {
  return t === DataType.Int64 || t === DataType.Double || t === DataType.Decimal;
}

export function isoDate(d, withTime) {
  const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  if (!withTime) return day;
  return `${day} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

const formatters = new Map();
function numberFormat(minFrac, maxFrac, grouping = true) {
  const key = `${minFrac}/${maxFrac}/${grouping}`;
  if (!formatters.has(key)) {
    formatters.set(key, new Intl.NumberFormat('en-US', { minimumFractionDigits: minFrac, maximumFractionDigits: maxFrac, useGrouping: grouping }));
  }
  return formatters.get(key);
}

// Works out how a column should be displayed by looking at its values once.
export function columnFormat(dataType, values) {
  if (dataType === DataType.DateTime) {
    let withTime = false;
    for (const v of values) {
      if (v && (v.getUTCHours() || v.getUTCMinutes() || v.getUTCSeconds())) { withTime = true; break; }
    }
    return { kind: 'date', withTime };
  }
  if (dataType === DataType.Int64) return { kind: 'int' };
  if (dataType === DataType.Double || dataType === DataType.Decimal) {
    let decimals = 2;
    for (const v of values) {
      if (v == null || typeof v !== 'number') continue;
      const s = Math.abs(v * 100 - Math.round(v * 100));
      if (s > 1e-6 * Math.max(1, Math.abs(v))) { decimals = 6; break; }
    }
    return { kind: 'number', decimals };
  }
  if (dataType === DataType.Boolean) return { kind: 'bool' };
  return { kind: 'text' };
}

// Format for a value whose type is only known at run time (SQL results).
export function guessFormat(values) {
  let sawNumber = false, allInt = true;
  for (const v of values) {
    if (v == null) continue;
    if (typeof v === 'number' || typeof v === 'bigint') { sawNumber = true; if (typeof v === 'number' && !Number.isInteger(v)) allInt = false; }
    else return { kind: 'text' };
  }
  if (!sawNumber) return { kind: 'text' };
  if (allInt) return { kind: 'int' };
  return columnFormat(DataType.Double, values);
}

export function display(v, fmt) {
  if (v == null) return '';
  switch (fmt.kind) {
    case 'date': return v instanceof Date ? isoDate(v, fmt.withTime) : String(v);
    case 'int': return typeof v === 'bigint' ? v.toString() : typeof v === 'number' ? String(v) : String(v);
    case 'number':
      if (typeof v !== 'number') return String(v);
      return numberFormat(2, fmt.decimals).format(v);
    case 'bool': return v ? 'TRUE' : 'FALSE';
    default:
      if (v instanceof Uint8Array) return `<${v.length} bytes>`;
      return String(v);
  }
}

// Totals use grouping and at most the column's decimals.
export function displayTotal(v, fmt) {
  if (v == null || !Number.isFinite(v)) return '';
  if (fmt.kind === 'int') return numberFormat(0, 0).format(v);
  return numberFormat(2, fmt.decimals || 2).format(v);
}

// Raw, unformatted text for exports: exact numbers, ISO dates, TRUE/FALSE.
export function raw(v, fmt) {
  if (v == null) return '';
  if (v instanceof Date) return isoDate(v, fmt ? fmt.withTime : true);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Uint8Array) return '';
  return String(v);
}

function csvField(s) {
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function tsvField(s) {
  return /[\t"\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// columns: [{name, values, fmt}], order: row indexes to include
export function toDelimited(columns, order, sep) {
  const field = sep === '\t' ? tsvField : csvField;
  const lines = [columns.map(c => field(c.name)).join(sep)];
  for (const r of order) {
    let line = '';
    for (let c = 0; c < columns.length; c++) {
      if (c) line += sep;
      line += field(raw(columns[c].values[r], columns[c].fmt));
    }
    lines.push(line);
  }
  return lines.join('\r\n') + '\r\n';
}

export function downloadText(text, fileName, mime) {
  const blob = new Blob(['﻿' + text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName.replace(/[\\/:*?"<>|]+/g, '_');
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function bytesLabel(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

export const fmtCount = n => numberFormat(0, 0).format(n);
