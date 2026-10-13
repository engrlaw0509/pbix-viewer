// Runs the visual check on every visual of a .pbix and prints what it rebuilt.
// Usage: node tools/visual-check.mjs <file.pbix> [out.json]
// With out.json, the rebuilt rows are written there (ISO dates) for an independent comparison.
import { readFileSync, writeFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import initSqlJs from 'sql.js';
import { PbixFile } from '../js/pbix.js';
import { columnFormat, isoDate } from '../js/format.js';
import { ModelData, checkVisual } from '../js/visualcheck.js';

const [path, outPath] = process.argv.slice(2);
const f = await PbixFile.open(new Uint8Array(readFileSync(path)), { unzipSync, SQL: await initSqlJs() });
const tables = f.model.tables.filter(t => t.hasData).map(t => {
  const d = f.decodeTable(t.name);
  for (const c of d.columns) c.fmt = columnFormat(c.dataType, c.values);
  return { name: t.name, rowCount: d.rowCount, columns: d.columns };
});
const model = new ModelData(tables, f.model.relationships, f.model.measures);
const canon = v => (v instanceof Date ? isoDate(v, v.getUTCHours() || v.getUTCMinutes() || v.getUTCSeconds()) : typeof v === 'bigint' ? Number(v) : v);
const out = [];
for (const page of f.report.pages) {
  for (const visual of page.visuals) {
    const t0 = performance.now();
    const r = checkVisual(visual, page, f.report, model);
    const ms = Math.round(performance.now() - t0);
    const name = `${page.name} / ${visual.title || visual.type} (${visual.id})`;
    if (!r.ok) { console.log(`${name}: ${r.nothing ? 'nothing to check' : 'NOT REBUILT'}: ${r.reason}`); continue; }
    console.log(`${name}: ${r.rowCount} rows in ${ms} ms; anchor ${r.anchor}`);
    for (const fl of r.filters) console.log(`   filter [${fl.source}] ${fl.text}`);
    for (const n of r.notes) console.log(`   note: ${n}`);
    for (const c of r.columns) console.log(`   ${c.name} = ${c.sub}${c.total != null ? `   total ${c.total}` : ''}${c.error ? '   ERROR ' + c.error : ''}`);
    out.push({ id: visual.id, columns: r.columns.map(c => ({ name: c.name, sub: c.sub, total: canon(c.total), values: c.values.map(canon) })) });
  }
}
if (outPath) writeFileSync(outPath, JSON.stringify(out));
