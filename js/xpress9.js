// XPress9 decompression for the DataModel stream inside a .pbix.
//
// Ported to JavaScript from Microsoft's Xpress9 decoder as published in
// https://github.com/Hugoberry/xpress9-python (MIT License,
// Copyright (c) Microsoft Corporation). The original streams compressed
// input through an internal ring buffer; here every chunk of a session is
// decoded straight into one output buffer, so LZ77 back-references simply
// index earlier output.

const XPRESS9_MAGIC = 0x4e86d72a;

const HUFFMAN_MAX_CODEWORD_LENGTH = 27;
const HUFFMAN_CODEWORD_LENGTH_LIMIT = 64;
const HUFFMAN_ENCODED_TABLE_FILL = HUFFMAN_MAX_CODEWORD_LENGTH + 1;
const HUFFMAN_ENCODED_TABLE_ZERO_REPT = HUFFMAN_MAX_CODEWORD_LENGTH + 2;
const HUFFMAN_ENCODED_TABLE_PREV = HUFFMAN_MAX_CODEWORD_LENGTH + 3;
const HUFFMAN_ENCODED_TABLE_ROW_0 = HUFFMAN_MAX_CODEWORD_LENGTH + 4;
const HUFFMAN_ENCODED_TABLE_ROW_1 = HUFFMAN_MAX_CODEWORD_LENGTH + 5;
const HUFFMAN_ENCODED_TABLE_SIZE = HUFFMAN_MAX_CODEWORD_LENGTH + 6;
const HUFFMAN_ENCODED_TABLE_ZERO_REPT_MIN_COUNT = 5;

const LZ77_MAX_MTF = 4;
const LZ77_MAX_SHORT_LENGTH_LOG = 4;
const LZ77_MAX_SHORT_LENGTH = 1 << LZ77_MAX_SHORT_LENGTH_LOG;
const LZ77_MAX_WINDOW_SIZE_LOG = 24;
const LZ77_LONG_LENGTH_ALPHABET_SIZE = 1 << 8;
const LZ77_MAX_LONG_LENGTH = LZ77_LONG_LENGTH_ALPHABET_SIZE - LZ77_MAX_WINDOW_SIZE_LOG;
const LZ77_SHORT_SYMBOL_ALPHABET_SIZE = 256 + ((LZ77_MAX_WINDOW_SIZE_LOG + LZ77_MAX_MTF) << LZ77_MAX_SHORT_LENGTH_LOG);
const ROOT_BITS = 12;
const TAIL_BITS = 6;
const DECODE_TABLE_SIZE = (1 << ROOT_BITS) + (1 << TAIL_BITS) * 64;

class CorruptError extends Error {
  constructor(msg) { super('XPress9: ' + msg); }
}

// LSB-first bit reader over a byte array (same bit order as the C BIORD_* macros).
class BitReader {
  constructor(src, byteOffset) {
    this.src = src;
    this.pos = byteOffset;
    this.start = byteOffset;
    this.buf = 0;
    this.cnt = 0;
  }
  fill(n) { // n <= 24
    while (this.cnt < n) {
      const b = this.pos < this.src.length ? this.src[this.pos] : 0;
      this.pos++;
      this.buf |= b << this.cnt;
      this.cnt += 8;
    }
  }
  peek(n) { this.fill(n); return this.buf & ((1 << n) - 1); }
  skip(n) { this.fill(n); this.buf >>>= n; this.cnt -= n; }
  read(n) {
    if (n === 0) return 0;
    if (n > 16) { const lo = this.read(16); return lo + this.read(n - 16) * 65536; }
    const v = this.peek(n);
    this.skip(n);
    return v;
  }
  consumedBits() { return (this.pos - this.start) * 8 - this.cnt; }
}

function reverseBits(v, n) {
  let r = 0;
  for (let i = 0; i < n; i++) { r = (r << 1) | (v & 1); v >>>= 1; }
  return r;
}

// Builds multi-level decode tables compatible with decodeSymbol below.
// Returns the index of the root table inside `table`.
function createDecodeTables(lengths, alphabetSize, table, rootBits, tailBits) {
  // sort symbols: descending by codeword length, then descending by symbol
  const chains = [];
  for (let i = 0; i < HUFFMAN_CODEWORD_LENGTH_LIMIT; i++) chains.push([]);
  const count = new Array(HUFFMAN_CODEWORD_LENGTH_LIMIT).fill(0);
  let numSymbols = 0;
  for (let i = alphabetSize - 1; i >= 0; i--) {
    const n = lengths[i];
    if (n !== 0) {
      if (n >= HUFFMAN_CODEWORD_LENGTH_LIMIT) throw new CorruptError('bit length too large');
      chains[n].push({ sym: i, bits: n, next: null });
      count[n]++;
      numSymbols++;
    }
  }
  let leaf = null;
  for (let i = 0; i < HUFFMAN_CODEWORD_LENGTH_LIMIT; i++) {
    const c = chains[i];
    if (c.length) {
      for (let k = 0; k < c.length - 1; k++) c[k].next = c[k + 1];
      c[c.length - 1].next = leaf;
      leaf = c[0];
    }
  }
  if (leaf === null) throw new CorruptError('empty Huffman table');

  if (numSymbols === 1) {
    const sym = (leaf.sym << 4) + leaf.bits;
    for (let i = 0; i < (1 << rootBits); i++) table[i] = sym;
    return 0;
  }

  // verify the tree is full
  let n = 0;
  for (let i = HUFFMAN_CODEWORD_LENGTH_LIMIT - 1; i !== 0; i--) {
    n += count[i];
    if (n & 1) throw new CorruptError('Huffman tree is not full');
    n >>= 1;
  }
  if (n !== 1 || count[0] !== 0) throw new CorruptError('Huffman tree is not full');

  // fill tables bottom-up
  let tableOffset = 0;
  let node = null;
  let tail = null;
  let rootLevel;
  do {
    let leafLevel = leaf ? leaf.bits : 0;
    if (node !== null && leafLevel < node.bits) leafLevel = node.bits;
    if (leafLevel <= rootBits) {
      rootLevel = 0;
      leafLevel = rootBits;
    } else {
      rootLevel = leafLevel - tailBits;
    }
    let i = 1 << (leafLevel - rootLevel);
    if (tableOffset + i > table.length) throw new CorruptError('decode table overflow');
    do {
      let sym, bits;
      if (node !== null && node.bits > rootLevel) {
        sym = (node.sym << tailBits) - tableOffset;
        bits = node.bits;
        node = node.next;
        sym += bits - rootLevel;
      } else {
        if (leaf === null) throw new CorruptError('ran out of Huffman leaves');
        sym = leaf.sym;
        bits = leaf.bits;
        leaf = leaf.next;
        sym = (sym << 4) + (bits - rootLevel);
      }
      const j = i - (1 << (leafLevel - bits));
      do {
        --i;
        table[tableOffset + reverseBits(i, leafLevel - rootLevel)] = sym;
      } while (i !== j);
    } while (i !== 0);

    const created = { sym: tableOffset >> tailBits, bits: rootLevel, next: null };
    if (node === null) node = created; else tail.next = created;
    tail = created;
    tableOffset += 1 << (leafLevel - rootLevel);
  } while (rootLevel !== 0);

  if (tableOffset < (1 << rootBits)) throw new CorruptError('decode table underflow');
  return tableOffset - (1 << rootBits);
}

function decodeSymbol(br, table, root, rootBits, tailBits) {
  let e = table[root + br.peek(rootBits)];
  if (e < 0) {
    br.skip(e & 15);
    let next = root + (e & ~15);
    while ((e = table[next + br.peek(tailBits)]) < 0) {
      br.skip(e & 15);
      next += e & ~15;
    }
  }
  br.skip(e & 15);
  return e >> 4;
}

function decodeLengthTable(br, lengths, alphabetSize, fillBoundary, maxCodewordLength) {
  let k = br.read(3);
  if (k === 0) {
    // "stored": first k symbols use msb bits, the rest msb+1
    const msb = 31 - Math.clz32(alphabetSize);
    k = (1 << (msb + 1)) - alphabetSize;
    let i = 0;
    for (; i < k; i++) lengths[i] = msb;
    for (; i < alphabetSize; i++) lengths[i] = msb + 1;
    return;
  }
  if (k !== 1) throw new CorruptError('unknown Huffman table encoding ' + k);

  const small = new Uint8Array(HUFFMAN_ENCODED_TABLE_SIZE);
  let prev = 4;
  for (let i = 0; i < HUFFMAN_ENCODED_TABLE_SIZE; i++) {
    if (br.read(1) === 0) {
      small[i] = prev;
    } else {
      k = br.read(3);
      if (k >= prev) {
        k += 1;
        if (k > 8) throw new CorruptError('bad small table');
      }
      small[i] = k;
      prev = k;
    }
  }
  const smallTable = new Int16Array((1 << 8) + (2 << 4));
  const smallRoot = createDecodeTables(small, HUFFMAN_ENCODED_TABLE_SIZE, smallTable, 8, 4);

  prev = 8;
  for (let i = 0; i < alphabetSize;) {
    let sym = decodeSymbol(br, smallTable, smallRoot, 8, 1);
    switch (sym) {
      case HUFFMAN_ENCODED_TABLE_FILL:
        do { lengths[i++] = 0; } while ((i & (fillBoundary - 1)) !== 0 && i < alphabetSize);
        break;
      case HUFFMAN_ENCODED_TABLE_ZERO_REPT: {
        k = br.read(2);
        sym = k + HUFFMAN_ENCODED_TABLE_ZERO_REPT_MIN_COUNT;
        if (k === 3) {
          do {
            k = br.read(3);
            sym += k;
            if (i + sym > alphabetSize || (i ^ (i + sym)) >= fillBoundary) throw new CorruptError('bad zero run');
          } while (k === 7);
        }
        if (i + sym > alphabetSize || (i ^ (i + sym)) >= fillBoundary) throw new CorruptError('bad zero run');
        do { lengths[i++] = 0; --sym; } while (i < alphabetSize && sym !== 0);
        break;
      }
      case HUFFMAN_ENCODED_TABLE_PREV:
        lengths[i++] = prev;
        break;
      case HUFFMAN_ENCODED_TABLE_ROW_0:
        if (i < fillBoundary) throw new CorruptError('bad ROW_0');
        lengths[i] = lengths[i - fillBoundary];
        if (lengths[i] === 0) throw new CorruptError('bad ROW_0 length');
        prev = lengths[i++];
        break;
      case HUFFMAN_ENCODED_TABLE_ROW_1:
        if (i < fillBoundary) throw new CorruptError('bad ROW_1');
        lengths[i] = lengths[i - fillBoundary] + 1;
        if (lengths[i] > maxCodewordLength || lengths[i] === 0) throw new CorruptError('bad ROW_1 length');
        prev = lengths[i++];
        break;
      default:
        if (sym > maxCodewordLength) throw new CorruptError('codeword too long');
        lengths[i++] = sym;
        if (sym !== 0) prev = sym;
    }
  }
}

// One XPress9 session: a sequence of blocks sharing one LZ77 history.
export class Xpress9Session {
  constructor(out, outStart) {
    this.out = out;
    this.sessionStart = outStart;
    this.pos = outStart;
    this.blockIndex = 0;
    this.signature = null;
    this.shortTable = new Int16Array(DECODE_TABLE_SIZE);
    this.longTable = new Int16Array(DECODE_TABLE_SIZE);
  }

  // Decodes one compressed block (one chunk of the DataModel stream).
  decodeBlock(src, expectedSize) {
    if (src.length < 32) throw new CorruptError('block too short');
    const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);
    const h = i => dv.getUint32(i * 4, true);
    if (h(0) !== XPRESS9_MAGIC) throw new CorruptError('bad block magic');
    if (this.signature === null) this.signature = h(5);
    if (h(5) !== this.signature) throw new CorruptError('session signature mismatch');
    if (h(6) !== this.blockIndex) throw new CorruptError('block index mismatch');
    if (h(4) !== 0) throw new CorruptError('reserved header field is not zero');
    const origSize = h(1);
    const encodedBits = h(2);
    const flags = h(3);
    if (expectedSize != null && origSize !== expectedSize) throw new CorruptError('block size mismatch');
    if (flags >>> 20) throw new CorruptError('reserved flags set');
    const huffmanBits = flags & 0x1fff;
    const windowLog2 = ((flags >>> 13) & 7) + 16;
    const mtfCount = ((flags >>> 16) & 3) << 1;
    const ptrMin = ((flags >>> 18) & 1) + 3;
    const mtfMin = ((flags >>> 19) & 1) + 2;
    if (mtfCount > 4) throw new CorruptError('bad MTF count');
    if (this.blockIndex === 0) {
      this.windowLog2 = windowLog2;
      this.mtfCount = mtfCount;
      this.ptrMin = ptrMin;
      this.mtfMin = mtfMin;
    } else if (windowLog2 !== this.windowLog2 || mtfCount !== this.mtfCount || ptrMin !== this.ptrMin || mtfMin !== this.mtfMin) {
      throw new CorruptError('block parameters changed inside a session');
    }
    if (encodedBits <= huffmanBits + 256) throw new CorruptError('bad encoded size');

    const br = new BitReader(src, 32);
    // MTF state and Huffman tables
    let lastPtr = 0, o0 = 0, o1 = 0, o2 = 0, o3 = 0;
    if (mtfCount > 0) {
      lastPtr = br.read(1);
      const offs = [0, 0, 0, 0];
      for (let i = 0; i < mtfCount; i++) {
        const msb = br.read(5);
        if (msb >= windowLog2) throw new CorruptError('bad MTF offset');
        offs[i] = br.read(msb) + 2 ** msb;
      }
      [o0, o1, o2, o3] = offs;
    }
    const shortLen = new Uint8Array(LZ77_SHORT_SYMBOL_ALPHABET_SIZE);
    decodeLengthTable(br, shortLen, LZ77_SHORT_SYMBOL_ALPHABET_SIZE, LZ77_MAX_SHORT_LENGTH, HUFFMAN_MAX_CODEWORD_LENGTH);
    const shortRoot = createDecodeTables(shortLen, LZ77_SHORT_SYMBOL_ALPHABET_SIZE, this.shortTable, ROOT_BITS, TAIL_BITS);
    const longLen = new Uint8Array(LZ77_LONG_LENGTH_ALPHABET_SIZE);
    decodeLengthTable(br, longLen, LZ77_LONG_LENGTH_ALPHABET_SIZE, LZ77_MAX_SHORT_LENGTH, HUFFMAN_MAX_CODEWORD_LENGTH);
    const longRoot = createDecodeTables(longLen, LZ77_LONG_LENGTH_ALPHABET_SIZE, this.longTable, ROOT_BITS, TAIL_BITS);
    if (br.consumedBits() !== huffmanBits) throw new CorruptError('Huffman table size mismatch');

    const out = this.out;
    const shortTable = this.shortTable;
    const longTable = this.longTable;
    let pos = this.pos;
    const end = pos + origSize;
    if (end > out.length) throw new CorruptError('output overflow');
    const sessionStart = this.sessionStart;

    while (pos < end) {
      let sym = decodeSymbol(br, shortTable, shortRoot, ROOT_BITS, TAIL_BITS);
      if (sym < 256) {
        out[pos++] = sym;
        lastPtr = 0;
        continue;
      }
      sym -= 256;
      let length = sym & (LZ77_MAX_SHORT_LENGTH - 1);
      sym >>= LZ77_MAX_SHORT_LENGTH_LOG;
      if (length === LZ77_MAX_SHORT_LENGTH - 1) {
        length = decodeSymbol(br, longTable, longRoot, ROOT_BITS, TAIL_BITS);
        if (length >= LZ77_MAX_LONG_LENGTH) {
          const bits = length - LZ77_MAX_LONG_LENGTH;
          length = br.read(bits) + 2 ** bits + LZ77_MAX_LONG_LENGTH - 1;
        }
        length += LZ77_MAX_SHORT_LENGTH - 1;
      }
      let offset;
      if (sym < mtfCount) {
        length += mtfMin;
        if (lastPtr) {
          if (mtfCount <= 2) {
            if (sym !== 0) throw new CorruptError('bad MTF symbol');
            offset = o1;
          } else if (sym === 0) {
            offset = o1;
          } else if (sym === 1) {
            offset = o2; o2 = o1;
          } else if (sym === 2) {
            offset = o3; o3 = o2; o2 = o1;
          } else {
            throw new CorruptError('bad MTF symbol');
          }
          o1 = o0; o0 = offset;
        } else if (sym === 0) {
          offset = o0;
        } else if (mtfCount <= 2 || sym === 1) {
          offset = o1; o1 = o0; o0 = offset;
        } else if (sym === 2) {
          offset = o2; o2 = o1; o1 = o0; o0 = offset;
        } else {
          offset = o3; o3 = o2; o2 = o1; o1 = o0; o0 = offset;
        }
      } else {
        length += ptrMin;
        sym -= mtfCount;
        offset = br.read(sym) + 2 ** sym;
        if (mtfCount > 2) { o3 = o2; o2 = o1; }
        if (mtfCount > 0) { o1 = o0; o0 = offset; }
      }
      if (offset > pos - sessionStart) throw new CorruptError('back-reference before start of stream');
      lastPtr = 1;
      const last = pos + length;
      if (last > end) throw new CorruptError('match runs past end of block');
      let from = pos - offset;
      while (pos < last) out[pos++] = out[from++];
    }
    if (br.consumedBits() !== encodedBits - 256) throw new CorruptError('encoded size mismatch');
    this.pos = pos;
    this.blockIndex++;
  }
}

const SINGLE_SIG = 'This backup was created using XPress9 compression.';
const MULTI_SIG = 'This backup was created using multithreaded XPrs9.';
const STREAM_STORAGE_SIG = 'STREAM_STORAGE_SIGNATURE_)!@#$%^&*(';

function utf16(bytes) {
  return new TextDecoder('utf-16le').decode(bytes);
}

// Decompresses the whole DataModel member of a .pbix into the raw ABF backup.
export function decompressDataModel(dm) {
  if (utf16(dm.subarray(0, 72)).includes(STREAM_STORAGE_SIG)) return dm; // already uncompressed
  const sig = utf16(dm.subarray(0, 102));
  const dv = new DataView(dm.buffer, dm.byteOffset, dm.byteLength);
  if (sig.includes(SINGLE_SIG)) {
    const chunks = [];
    let total = 0;
    for (let p = 102; p < dm.length;) {
      const usize = dv.getUint32(p, true);
      const csize = dv.getUint32(p + 4, true);
      chunks.push({ usize, data: dm.subarray(p + 8, p + 8 + csize) });
      total += usize;
      p += 8 + csize;
    }
    const out = new Uint8Array(total);
    const session = new Xpress9Session(out, 0);
    for (const c of chunks) session.decodeBlock(c.data, c.usize);
    return out;
  }
  if (sig.includes(MULTI_SIG)) {
    const u64 = p => Number(dv.getBigUint64(p, true));
    const mainChunksPerThread = u64(102);
    const prefixChunksPerThread = u64(110);
    const prefixThreadCount = u64(118);
    const mainThreadCount = u64(126);
    let p = 142;
    const groups = [];
    let total = 0;
    const readGroups = (threads, perThread) => {
      for (let t = 0; t < threads; t++) {
        const chunks = [];
        for (let c = 0; c < perThread; c++) {
          const usize = dv.getUint32(p, true);
          const csize = dv.getUint32(p + 4, true);
          chunks.push({ usize, data: dm.subarray(p + 8, p + 8 + csize) });
          total += usize;
          p += 8 + csize;
        }
        groups.push(chunks);
      }
    };
    if (prefixThreadCount > 0 && prefixChunksPerThread > 0) readGroups(prefixThreadCount, prefixChunksPerThread);
    if (mainThreadCount > 0 && mainChunksPerThread > 0) readGroups(mainThreadCount, mainChunksPerThread);
    const out = new Uint8Array(total);
    let start = 0;
    for (const chunks of groups) {
      const session = new Xpress9Session(out, start);
      for (const c of chunks) session.decodeBlock(c.data, c.usize);
      start = session.pos;
    }
    return out;
  }
  throw new Error('This DataModel uses an unknown compression format.');
}
