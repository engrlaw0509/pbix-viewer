// VertiPaq column storage decoding: .idfmeta segment metadata, .idf RLE /
// bit-packed data ids, and .dictionary value stores (including the Huffman
// compressed string pages). Ported from pbixray (MIT, Igor Cotruta) and the
// xmhuffman kernel (MIT, Igor Cotruta).

// VertiPaq reserves data id 2 for NULL; the first real data id is 3.
const XM_DATA_ID_NULL = 2;
const XM_FIRST_DATA_ID = 3;

const HUFFMAN_GENERAL = 0x000aba92; // UTF-16LE bytes via general Huffman
const HUFFMAN_CHARSET = 0x000aba91; // single-byte charset Huffman

class Reader {
  constructor(bytes) {
    this.b = bytes;
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.p = 0;
  }
  eof() { return this.p >= this.b.length; }
  u1() { return this.b[this.p++]; }
  s1() { const v = this.dv.getInt8(this.p); this.p += 1; return v; }
  u4() { const v = this.dv.getUint32(this.p, true); this.p += 4; return v; }
  s4() { const v = this.dv.getInt32(this.p, true); this.p += 4; return v; }
  u8() { const v = this.dv.getBigUint64(this.p, true); this.p += 8; return Number(v); }
  s8() { const v = this.dv.getBigInt64(this.p, true); this.p += 8; return v; }
  f8() { const v = this.dv.getFloat64(this.p, true); this.p += 8; return v; }
  bytes(n) { const v = this.b.subarray(this.p, this.p + n); this.p += n; return v; }
  tag(expected) {
    for (let i = 0; i < expected.length; i++) {
      if (this.b[this.p + i] !== expected.charCodeAt(i)) throw new Error('Unexpected column metadata layout (missing ' + expected.replace('\0', '') + ')');
    }
    this.p += expected.length;
  }
}

function bitWidthOf(cls) {
  if (cls >= 703031 && cls <= 703040) return cls - 703030;
  if (cls === 703042) return 12;
  if (cls === 703046) return 16;
  if (cls === 703051) return 21;
  if (cls === 703062) return 32;
  return 0;
}

function readCs(r, isSub) {
  r.tag('<1:CS\0');
  const seg = { records: r.u8(), baseId: r.u8() };
  if (!isSub) {
    seg.compressionClass = r.u4();
    seg.subCompressionClass = r.u4();
    if (seg.compressionClass === 703066) {
      r.u8(); r.u8(); r.u8(); r.u1(); // RLE facet: bookmark bits, alloc size, used size, needs resizing
    }
    seg.firstRunValue = r.u4();
    r.tag('<1:SS\0');
    seg.distinctStates = r.u8();
    seg.minDataId = r.u4();
    seg.maxDataId = r.u4();
    r.u4(); // original min segment data id
    r.s8(); // rle sort order
    seg.rowCount = r.u8();
    seg.hasNulls = r.u1() !== 0;
    r.u8(); r.u8(); // rle runs, others rle runs
    r.tag('SS:1>\0');
  }
  seg.hasSubsegment = r.u1() !== 0;
  if (seg.hasSubsegment) seg.subsegment = readCs(r, true);
  r.tag('CS:1>\0');
  if (!isSub) {
    let w = bitWidthOf(seg.compressionClass);
    if (!w && seg.compressionClass === 703066) w = bitWidthOf(seg.subCompressionClass);
    seg.bitWidth = w;
  }
  return seg;
}

// Per-segment metadata for one partition of a column.
export function parseIdfmeta(bytes) {
  const r = new Reader(bytes);
  r.tag('<1:CP\0');
  const n = r.u8();
  const segments = [];
  for (let i = 0; i < n; i++) segments.push(readCs(r, false));
  r.tag('CP:1>\0');
  return segments.map(s => ({
    minDataId: s.minDataId,
    hasNulls: s.hasNulls,
    countBitPacked: s.hasSubsegment ? s.subsegment.records : 0,
    bitWidth: s.bitWidth,
    records: s.records,
  }));
}

// .idf: a run of segments, each an RLE entry list plus a bit-packed sub segment.
export function parseIdf(bytes) {
  const r = new Reader(bytes);
  const segments = [];
  while (!r.eof()) {
    const n = r.u8();
    const dataValue = new Uint32Array(n);
    const repeat = new Uint32Array(n);
    for (let i = 0; i < n; i++) { dataValue[i] = r.u4(); repeat[i] = r.u4(); }
    const subWords = r.u8();
    const sub = r.bytes(subWords * 8);
    segments.push({ dataValue, repeat, subWords, sub });
  }
  return segments;
}

function unpackBits(sub, subWords, bitWidth, base) {
  const perWord = Math.floor(64 / bitWidth);
  const out = new Float64Array(subWords * perWord);
  const dv = new DataView(sub.buffer, sub.byteOffset, sub.byteLength);
  const mask = bitWidth === 32 ? 0xffffffff : (1 << bitWidth) - 1;
  let k = 0;
  for (let w = 0; w < subWords; w++) {
    const lo = dv.getUint32(w * 8, true);
    const hi = dv.getUint32(w * 8 + 4, true);
    for (let j = 0; j < perWord; j++) {
      const s = j * bitWidth;
      let v;
      if (s + bitWidth <= 32) v = bitWidth === 32 ? lo : (lo >>> s) & mask;
      else if (s >= 32) v = (hi >>> (s - 32)) & mask;
      else v = ((lo >>> s) | (hi << (32 - s))) & mask;
      out[k++] = (v >>> 0) + base;
    }
  }
  return out;
}

// Decodes one segment to absolute data ids (one per row).
function decodeSegment(seg, meta, base) {
  const cap = meta.records || 0;
  const n = seg.dataValue.length;
  const counts = new Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    let rv = seg.repeat[i];
    if (cap && total >= cap) rv = 0;
    else if (cap && total + rv > cap) rv = cap - total;
    counts[i] = rv;
    total += rv;
  }
  const ids = new Float64Array(total);
  let packed = null;
  if (meta.countBitPacked > 0 && meta.bitWidth > 0) packed = unpackBits(seg.sub, seg.subWords, meta.bitWidth, base);
  let pos = 0;
  let packedOffset = 0;
  for (let i = 0; i < n; i++) {
    const count = counts[i];
    if (count === 0) continue;
    if (seg.dataValue[i] + packedOffset === 0xffffffff) {
      if (!packed || packedOffset + count > packed.length) throw new Error('Bit-packed run is out of range');
      ids.set(packed.subarray(packedOffset, packedOffset + count), pos);
      packedOffset += count;
    } else {
      ids.fill(seg.dataValue[i], pos, pos + count);
    }
    pos += count;
  }
  return ids;
}

// ---- string dictionaries ----------------------------------------------------

function buildHuffman(encodeArray) {
  const lengths = new Uint8Array(256);
  for (let i = 0; i < 128; i++) {
    lengths[2 * i] = encodeArray[i] & 0x0f;
    lengths[2 * i + 1] = (encodeArray[i] >> 4) & 0x0f;
  }
  const count = new Uint32Array(17);
  let maxLen = 0;
  for (let s = 0; s < 256; s++) {
    const L = lengths[s];
    if (!L) continue;
    count[L]++;
    if (L > maxLen) maxLen = L;
  }
  if (maxLen === 0) return { maxLen: 0, table: null };
  let left = 1;
  for (let L = 1; L <= maxLen; L++) {
    left <<= 1;
    if (count[L] > left) throw new Error('Invalid string dictionary code lengths');
    left -= count[L];
  }
  if (left !== 0) throw new Error('Invalid string dictionary code lengths');
  const next = new Uint32Array(17);
  let code = 0;
  for (let L = 1; L <= maxLen; L++) { code = (code + count[L - 1]) << 1; next[L] = code; }
  const table = new Uint16Array(1 << maxLen);
  for (let s = 0; s < 256; s++) {
    const L = lengths[s];
    if (!L) continue;
    const c = next[L]++;
    const pad = maxLen - L;
    table.fill((s << 8) | L, c << pad, (c << pad) + (1 << pad));
  }
  return { maxLen, table };
}

function decodeCompressedPage(store, offsets) {
  const { maxLen, table } = buildHuffman(store.encodeArray);
  const n = offsets.length;
  if (maxLen === 0) return new Array(n).fill('');
  // the bitstream is stored with each byte pair swapped
  const src = store.buffer;
  const len = src.length;
  const sw = new Uint8Array(len + 4);
  for (let i = 0; i + 1 < len; i += 2) { sw[i] = src[i + 1]; sw[i + 1] = src[i]; }
  if (len & 1) sw[len - 1] = src[len - 1];
  const mask = (1 << maxLen) - 1;
  const general = store.charsetType === HUFFMAN_GENERAL;
  const hiByte = general ? 0 : store.charsetUsed;
  const out = new Array(n);
  const bytes = [];
  for (let i = 0; i < n; i++) {
    const endBit = i + 1 === n ? store.totalBits : offsets[i + 1];
    let bit = offsets[i];
    bytes.length = 0;
    while (bit < endBit) {
      const byte = bit >>> 3;
      const off = bit & 7;
      const w = (sw[byte] << 16) | (sw[byte + 1] << 8) | sw[byte + 2];
      const e = table[(w >>> (24 - maxLen - off)) & mask];
      const L = e & 0xff;
      if (L === 0) throw new Error('Corrupt string dictionary page');
      bytes.push(e >> 8);
      bit += L;
    }
    let s = '';
    if (general) {
      for (let k = 0; k + 1 < bytes.length; k += 2) s += String.fromCharCode(bytes[k] | (bytes[k + 1] << 8));
    } else {
      for (let k = 0; k < bytes.length; k++) s += String.fromCharCode(bytes[k] | (hiByte << 8));
    }
    out[i] = s;
  }
  return out;
}

// Returns { values: Array (index 0 = data id 3), isString }.
export function parseDictionary(bytes) {
  const r = new Reader(bytes);
  const type = r.s4();
  for (let i = 0; i < 6; i++) r.s4(); // hash info
  if (type === 0 || type === 1) {
    const n = r.u8();
    const size = r.u4();
    const values = new Array(n);
    for (let i = 0; i < n; i++) {
      if (size === 4) values[i] = r.s4();
      else if (type === 0) {
        const v = r.s8();
        values[i] = v >= -9007199254740991n && v <= 9007199254740991n ? Number(v) : v;
      } else values[i] = r.f8();
    }
    return { values, isString: false };
  }
  if (type !== 2) throw new Error('Unknown dictionary type ' + type);

  r.s8(); r.s1(); r.s8(); // string count, compressed flag, longest string
  const pageCount = r.u8();
  const pages = [];
  for (let p = 0; p < pageCount; p++) {
    r.u8(); r.u1(); r.u8(); r.u8(); // mask, contains nulls, start index, string count
    const compressed = r.u1();
    r.tag('\xDD\xCC\xBB\xAA');
    if (compressed === 0) {
      r.u8(); // remaining store available
      const used = r.u8();
      const alloc = r.u8();
      const chars = r.bytes(used * 2);
      r.bytes(alloc - used * 2);
      pages.push({ compressed: false, text: new TextDecoder('utf-16le').decode(chars) });
    } else {
      const totalBits = r.u4();
      const charsetType = r.u4();
      const bufLen = r.u8();
      const charsetUsed = charsetType === HUFFMAN_CHARSET ? r.u1() : 0;
      r.u4(); // ui decode bits
      const encodeArray = r.bytes(128);
      r.u8(); // buffer size
      const buffer = r.bytes(bufLen);
      pages.push({ compressed: true, store: { totalBits, charsetType, charsetUsed, encodeArray, buffer } });
    }
    r.tag('\xCD\xAB\xCD\xAB');
  }
  const handleCount = r.u8();
  r.u4(); // element size (8)
  const handlesByPage = new Map();
  for (let i = 0; i < handleCount; i++) {
    const offset = r.u4();
    const page = r.u4();
    if (!handlesByPage.has(page)) handlesByPage.set(page, []);
    handlesByPage.get(page).push(offset);
  }
  const values = [];
  pages.forEach((page, id) => {
    if (page.compressed) {
      const offsets = handlesByPage.get(id);
      if (!offsets) return;
      for (const s of decodeCompressedPage(page.store, offsets)) values.push(s);
    } else {
      const parts = page.text.split('\0');
      parts.pop();
      for (const s of parts) values.push(s);
    }
  });
  return { values, isString: true };
}

// ---- column decoding ----------------------------------------------------------

// AMO data types
export const DataType = { String: 2, Int64: 6, Double: 8, DateTime: 9, Decimal: 10, Boolean: 11, Binary: 17 };

const DAY_MS = 86400000;
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);

function toDate(days) {
  if (days == null) return null;
  return new Date(EXCEL_EPOCH_MS + Math.round(days * DAY_MS));
}

// Decodes one column. `getFile(name)` returns the bytes of an ABF file.
// `col` = { dictionary, hidx, idfs: [..], baseId, magnitude, dataType }.
export function decodeColumn(col, getFile) {
  const mode = col.dictionary ? 'dictionary' : col.hidx ? 'hidx' : 'none';
  let dict = null;
  if (mode === 'dictionary') dict = parseDictionary(getFile(col.dictionary));
  const parts = [];
  let total = 0;
  for (const idf of col.idfs) {
    const metas = parseIdfmeta(getFile(idf + 'meta'));
    if (mode === 'none') {
      for (const m of metas) { parts.push({ none: m.records || 0 }); total += m.records || 0; }
      continue;
    }
    const segs = parseIdf(getFile(idf));
    metas.forEach((m, i) => {
      const base = m.hasNulls ? XM_DATA_ID_NULL : m.minDataId;
      const ids = decodeSegment(segs[i], m, base);
      parts.push({ ids, hasNulls: m.hasNulls });
      total += ids.length;
    });
  }

  const out = new Array(total);
  let p = 0;
  const dictValues = dict ? dict.values : null;
  const dictLen = dictValues ? dictValues.length : 0;
  const baseId = Number(col.baseId) || 0;
  const magnitude = Number(col.magnitude) || 1;
  for (const part of parts) {
    if (part.none != null) { for (let i = 0; i < part.none; i++) out[p++] = null; continue; }
    const ids = part.ids;
    if (mode === 'dictionary') {
      for (let i = 0; i < ids.length; i++) {
        const k = ids[i] - XM_FIRST_DATA_ID;
        out[p++] = k >= 0 && k < dictLen ? dictValues[k] : null;
      }
    } else {
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        out[p++] = part.hasNulls && id === XM_DATA_ID_NULL ? null : (id + baseId) / magnitude;
      }
    }
  }
  return finalize(out, col.dataType);
}

function finalize(values, dataType) {
  switch (dataType) {
    case DataType.DateTime:
      return values.map(v => (v == null || typeof v !== 'number' ? null : toDate(v)));
    case DataType.Decimal:
      return values.map(v => (v == null ? null : Number(v) / 10000));
    case DataType.Boolean:
      return values.map(v => (v == null ? null : Boolean(Number(v))));
    case DataType.Int64:
      return values.map(v => (v == null ? null : typeof v === 'bigint' ? v : Math.round(v)));
    case DataType.String:
      return values.map(v => (v == null ? null : String(v)));
    default:
      return values;
  }
}
