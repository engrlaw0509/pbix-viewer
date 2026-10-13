// Static file server for hosting on Railway (or anywhere Node runs). No dependencies.
// The page itself does all the work in the browser; this only hands out the files.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT || 8080);

// Only what the page needs is served; tools, docs and package files are not.
const ALLOWED = [/^\/index\.html$/, /^\/css\/[\w.-]+\.css$/, /^\/js\/[\w.-]+\.js$/, /^\/vendor\/[\w.-]+\.(js|wasm|txt)$/, /^\/(LICENSE|THIRD_PARTY_NOTICES\.md)$/];
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '': 'text/plain; charset=utf-8',
};
const HEADERS = {
  // connect-src 'self' means the page cannot send anything to another site.
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

const cache = new Map();

createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  let path;
  try { path = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
  if (path === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok'); return; }
  if (path === '/') path = '/index.html';
  if (!ALLOWED.some(re => re.test(path))) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...HEADERS }).end('Not found');
    return;
  }
  const file = normalize(join(ROOT, path));
  if (!file.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep)) { res.writeHead(403).end(); return; }
  try {
    let entry = cache.get(file);
    if (!entry) {
      const body = await readFile(file);
      entry = { body, etag: '"' + createHash('sha1').update(body).digest('base64url') + '"' };
      cache.set(file, entry);
    }
    // Every file revalidates (cheap 304s): the modules import each other, so after a
    // deploy a fresh page must never run against a stale cached module.
    const common = { 'Cache-Control': 'no-cache', ETag: entry.etag, ...HEADERS };
    // Railway's edge compresses responses and weakens the ETag to W/"..."; compare without it.
    const sent = String(req.headers['if-none-match'] || '').split(',').map(t => t.trim().replace(/^W\//, ''));
    if (sent.includes(entry.etag)) {
      res.writeHead(304, common).end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
      'Content-Length': entry.body.length,
      ...common,
    });
    res.end(req.method === 'HEAD' ? undefined : entry.body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...HEADERS }).end('Not found');
  }
}).listen(PORT, () => console.log(`PBIX Viewer listening on port ${PORT}`));
