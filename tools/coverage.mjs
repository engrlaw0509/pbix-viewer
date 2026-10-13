// Reports which storage features a .pbix exercises (debug aid for testing).
// Usage: node tools/coverage.mjs <file.pbix>
import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import initSqlJs from 'sql.js';
import { PbixFile } from '../js/pbix.js';
import { parseIdfmeta } from '../js/vertipaq.js';

const f = await PbixFile.open(new Uint8Array(readFileSync(process.argv[2])), { unzipSync, SQL: await initSqlJs() });
const stats = { dictionaryColumns: 0, valueEncodedColumns: 0, noStorage: 0, multiPartition: 0, multiSegment: 0, segmentsWithNulls: 0, stringPagesCompressed: 0, stringPagesPlain: 0, bitWidths: new Set(), dictTypes: new Set() };
for (const c of f.model.storage) {
  if (c.dictionary) {
    stats.dictionaryColumns++;
    const b = f.abf.get(c.dictionary);
    const type = new DataView(b.buffer, b.byteOffset).getInt32(0, true);
    stats.dictTypes.add(type);
    if (type === 2) {
      // page compressed flag sits after a fixed page header; count via a scan for page markers
      for (let i = 0; i + 4 < b.length; i++) {
        if (b[i] === 0xdd && b[i + 1] === 0xcc && b[i + 2] === 0xbb && b[i + 3] === 0xaa) {
          if (b[i - 1] === 1) stats.stringPagesCompressed++; else stats.stringPagesPlain++;
        }
      }
    }
  } else if (c.hidx) stats.valueEncodedColumns++;
  else stats.noStorage++;
  if (c.idfs.length > 1) stats.multiPartition++;
  for (const idf of c.idfs) {
    const metas = parseIdfmeta(f.abf.get(idf + 'meta'));
    if (metas.length > 1) stats.multiSegment++;
    for (const m of metas) { if (m.hasNulls) stats.segmentsWithNulls++; stats.bitWidths.add(m.bitWidth); }
  }
}
console.log({ ...stats, bitWidths: [...stats.bitWidths].sort((a, b) => a - b), dictTypes: [...stats.dictTypes] });
