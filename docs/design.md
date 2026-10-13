# PBIX Viewer: design record

Approved 13 Oct 2026.

## Goal

A public web page the team opens to check the data inside a Power BI `.pbix`
(first case: an accounts payable dashboard prototype) against the source system.
Comparison itself is done by hand in Excel, so the page's job is to show the
numbers clearly and get them into Excel fast.

## Decisions

- **Hosting:** code in a public GitHub repository, served from Railway
  (https://pbix-viewer.up.railway.app/, auto-deploy from `main`). GitHub Pages was tried
  first, but under this account it is forced onto the user site's custom domain, which
  the owner does not want used for this. A claude.ai artifact was ruled out because its
  sandbox blocks loading WebAssembly.
- **Privacy:** the file is read in the browser only; nothing is uploaded and nothing is
  loaded from third-party servers (libraries are vendored). No `.pbix` or data dump is
  ever committed; `.gitignore` blocks them.
- **Scope:** browse tables, totals per column that follow filters, column checks, SQL,
  copy for Excel and CSV. Comparing two `.pbix` files was approved and then dropped
  the same day: comparison happens in Excel.
- **Decoder:** first planned as DuckDB-WASM with the `pbix` community extension. Testing
  on the real file showed that extension (0.5.3) corrupts negative values in
  value-encoded columns: 895 of 928 tax amounts came out near 1.84 × 10¹⁷.
  Replaced by a JavaScript port of PBIXray, Xpress9 and xmhuffman (all MIT), checked
  cell by cell against PBIXray (`tools/verify.mjs`).
- **Measures:** shown as DAX. Simple measures get an unfiltered grand total and the
  equivalent SQL; anything else is labelled as not worked out rather than guessed.
- **Report:** visuals list their fields and their applied filters in words, since a
  report number that does not match is most often explained by a visual filter.
- **Visual check (13 Oct 2026):** asked whether graphical reports were needed; the answer
  was no, since redrawn charts could look right yet differ from Power BI. Instead each
  report visual can rebuild the rows it should show, with its filters, relationships and
  Total row, as a table to copy into Excel. Unsupported cases are labelled, not guessed.
- **Look:** light only, matching the owner's preference for bright consumer UIs.
