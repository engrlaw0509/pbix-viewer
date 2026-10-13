// Prints the grand total the page works out for each measure.
// Usage: node tools/measures.mjs <file.pbix>
import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import initSqlJs from 'sql.js';
import { PbixFile } from '../js/pbix.js';
import { isNumericType } from '../js/format.js';
import { tryMeasure } from '../js/dax.js';

const f = await PbixFile.open(new Uint8Array(readFileSync(process.argv[2])), { unzipSync, SQL: await initSqlJs() });
const cache = new Map();
const ctx = {
  measures: f.model.measures,
  getTable(name) {
    if (!f.model.storage.some(s => s.tableName === name)) return null;
    if (!cache.has(name)) {
      const t = f.decodeTable(name);
      cache.set(name, { name, rowCount: t.rowCount, columns: new Map(t.columns.map(c => [c.name, { values: c.values, numeric: isNumericType(c.dataType) }])) });
    }
    return cache.get(name);
  },
};
for (const m of f.model.measures) {
  const r = tryMeasure(m.expression, ctx);
  console.log(`${m.tableName}[${m.name}] =>`, r.ok ? `${r.value}  sql: ${r.sql}` : `not worked out: ${r.reason}`);
}
