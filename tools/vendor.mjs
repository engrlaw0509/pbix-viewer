// Copies the two browser dependencies (and their licenses) from node_modules
// into vendor/, so the published page loads nothing from third-party servers.
// Run after changing a dependency version: npm run vendor
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

mkdirSync('vendor', { recursive: true });
const files = [
  ['node_modules/fflate/esm/browser.js', 'vendor/fflate.js'],
  ['node_modules/sql.js/dist/sql-wasm-browser.js', 'vendor/sql-wasm-browser.js'],
  ['node_modules/sql.js/dist/sql-wasm-browser.wasm', 'vendor/sql-wasm-browser.wasm'],
];
for (const [from, to] of files) copyFileSync(from, to);

const version = name => JSON.parse(readFileSync(`node_modules/${name}/package.json`, 'utf8')).version;
writeFileSync('vendor/LICENSES.txt', [
  `fflate ${version('fflate')} - https://github.com/101arrowz/fflate`,
  readFileSync('node_modules/fflate/LICENSE', 'utf8').trim(),
  '',
  '-'.repeat(72),
  '',
  `sql.js ${version('sql.js')} - https://github.com/sql-js/sql.js`,
  readFileSync('node_modules/sql.js/LICENSE', 'utf8').trim(),
  '',
].join('\n'));
console.log('vendor/ updated');
