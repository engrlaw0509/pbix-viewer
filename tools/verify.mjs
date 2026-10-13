// Checks the decoder cell by cell against a PBIXray reference dump.
//
//   python -I tools/pbixray_dump.py file.pbix ref.json   (needs: pip install pbixray)
//   node tools/verify.mjs file.pbix ref.json
//
// Neither file belongs in this repository: .pbix files carry client data.
import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import initSqlJs from 'sql.js';
import { PbixFile } from '../js/pbix.js';

const [pbixPath, refPath] = process.argv.slice(2);
if (!pbixPath || !refPath) {
  console.error('usage: node tools/verify.mjs <file.pbix> <reference.json>');
  process.exit(2);
}

const pad = n => String(n).padStart(2, '0');
function canon(v) {
  if (v instanceof Date) {
    const d = `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
    const t = `${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}:${pad(v.getUTCSeconds())}`;
    return t === '00:00:00' ? d : `${d} ${t}`;
  }
  if (typeof v === 'bigint') return Number(v);
  return v;
}

// PBIXray truncates float day values to whole seconds, so a stored
// 22:51:06.000 that the float holds as 22:51:05.99999 shows as :05 there.
// We round instead; a one-second gap on a timestamp is counted, not failed.
let timestampRounding = 0;
const isStamp = s => typeof s === 'string' && /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(s);
function same(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  }
  if (isStamp(a) && isStamp(b) && Math.abs(Date.parse(a + 'Z') - Date.parse(b + 'Z')) <= 1000) {
    timestampRounding++;
    return true;
  }
  return false;
}

const SQL = await initSqlJs();
const t0 = performance.now();
const file = await PbixFile.open(new Uint8Array(readFileSync(pbixPath)), { unzipSync, SQL });
const ref = JSON.parse(readFileSync(refPath, 'utf8'));
let failures = 0;
let cells = 0;

const ours = new Set(file.model.storage.map(s => s.tableName));
for (const t of Object.keys(ref.tables)) if (!ours.has(t)) { console.log(`MISSING TABLE ${t}`); failures++; }
for (const t of ours) if (!ref.tables[t]) { console.log(`EXTRA TABLE ${t}`); failures++; }

for (const [tname, refCols] of Object.entries(ref.tables)) {
  if (!ours.has(tname)) continue;
  const table = file.decodeTable(tname);
  const byName = new Map(table.columns.map(c => [c.name, c]));
  for (const [cname, refVals] of Object.entries(refCols)) {
    const col = byName.get(cname);
    if (!col) { console.log(`MISSING COLUMN ${tname}[${cname}]`); failures++; continue; }
    if (col.values.length !== refVals.length) {
      console.log(`ROW COUNT ${tname}[${cname}]: ours ${col.values.length}, reference ${refVals.length}`);
      failures++;
      continue;
    }
    let bad = 0;
    for (let i = 0; i < refVals.length; i++) {
      cells++;
      const a = canon(col.values[i]);
      if (!same(a, refVals[i])) {
        if (bad < 3) console.log(`DIFF ${tname}[${cname}] row ${i}: ours ${JSON.stringify(a)} reference ${JSON.stringify(refVals[i])}`);
        bad++;
      }
    }
    if (bad) { console.log(`  ${tname}[${cname}]: ${bad} of ${refVals.length} cells differ`); failures++; }
  }
  console.log(`${tname}: ${table.rowCount} rows x ${table.columns.length} columns checked`);
}

const refMeasures = new Set(ref.measures.map(m => `${m.table}|${m.name}|${m.expression}`));
for (const m of file.model.measures) {
  if (!refMeasures.has(`${m.tableName}|${m.name}|${m.expression}`)) { console.log(`MEASURE DIFF ${m.tableName}[${m.name}]`); failures++; }
}
if (file.model.measures.length !== ref.measures.length) { console.log('MEASURE COUNT DIFF'); failures++; }
if (file.model.relationships.length !== ref.relationships.length) { console.log('RELATIONSHIP COUNT DIFF'); failures++; }

console.log(`\n${cells} cells compared in ${Math.round(performance.now() - t0)} ms; ${failures ? failures + ' FAILURES' : 'all match'}`);
if (timestampRounding) console.log(`(${timestampRounding} timestamps differ from the reference by under one second: rounding vs truncation)`);
process.exit(failures ? 1 : 0);
