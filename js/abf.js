// Reads the Analysis Services backup (ABF) that a decompressed DataModel holds:
// a header page, a virtual directory and a backup log, which together say where
// every internal file (metadata.sqlitedb, column .idf/.dictionary files, ...)
// lives inside the buffer. Mirrors pbixray/abf (MIT, Igor Cotruta).

function decodeXml(bytes) {
  let s;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) s = new TextDecoder('utf-16le').decode(bytes.subarray(2));
  else if (bytes.length > 1 && bytes[1] === 0) s = new TextDecoder('utf-16le').decode(bytes);
  else s = new TextDecoder('utf-8').decode(bytes);
  return s.replace(/\u0000+$/g, '').replace(/^﻿/, '');
}

function unescapeXml(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e];
  });
}

function text(xml, tag) {
  const m = xml.match(new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>'));
  return m ? unescapeXml(m[1]) : null;
}

function blocks(xml, tag) {
  const re = new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>', 'g');
  const out = [];
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}

export class Abf {
  constructor(buf) {
    this.buf = buf;
    const header = decodeXml(buf.subarray(72, 0x1000));
    const vdOffset = Number(text(header, 'm_cbOffsetHeader'));
    const vdSize = Number(text(header, 'DataSize'));
    this.errorCode = text(header, 'ErrorCode') === 'true';
    this.applyCompression = text(header, 'ApplyCompression') === 'true';
    if (!Number.isFinite(vdOffset) || !Number.isFinite(vdSize)) throw new Error('The data model backup header could not be read.');

    const vd = decodeXml(buf.subarray(vdOffset, vdOffset + vdSize));
    const vdFiles = blocks(vd, 'BackupFile').map(b => ({
      path: text(b, 'Path'),
      size: Number(text(b, 'Size')),
      offset: Number(text(b, 'm_cbOffsetHeader')),
    }));
    if (!vdFiles.length) throw new Error('The data model backup has no files.');
    const logRef = vdFiles[vdFiles.length - 1];
    let logBytes = buf.subarray(logRef.offset, logRef.offset + logRef.size);
    if (this.errorCode) logBytes = logBytes.subarray(0, logBytes.length - 4);
    const log = decodeXml(logBytes);

    const groups = blocks(log, 'FileGroup');
    const persistRoot = (groups.length > 1 ? text(groups[1], 'PersistLocationPath') || '' : '') + '\\';
    const byPath = new Map(vdFiles.map(f => [f.path, f]));
    this.files = new Map();
    for (const g of groups) {
      for (const bf of blocks(g, 'BackupFile')) {
        const storagePath = text(bf, 'StoragePath');
        const vf = byPath.get(storagePath);
        if (!vf) continue;
        let path = text(bf, 'Path') || '';
        if (path.startsWith(persistRoot)) path = path.slice(persistRoot.length);
        const fileName = path.split('\\').pop();
        if (!this.files.has(fileName)) {
          this.files.set(fileName, { path, offset: vf.offset, size: vf.size, sizeFromLog: Number(text(bf, 'Size')) });
        }
      }
    }
  }

  has(fileName) { return this.files.has(fileName); }

  get(fileName) {
    const f = this.files.get(fileName);
    if (!f) throw new Error('File not found in data model: ' + fileName);
    if (this.applyCompression) throw new Error('This data model stores its files with per-file compression, which is not supported yet.');
    const size = this.errorCode ? f.size - 4 : f.size;
    return this.buf.subarray(f.offset, f.offset + size);
  }
}
