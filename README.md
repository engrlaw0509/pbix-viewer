# PBIX Viewer

**Live:** https://pbix-viewer.up.railway.app/

Open a Power BI `.pbix` file in the browser and check the data inside it: every table
and row, column totals that follow your filters, the DAX of each measure, the fields and
filters behind each report visual, and a SQL box. Anything can be copied straight into
Excel or downloaded as CSV for a side-by-side comparison.

**The file never leaves your computer.** The page reads it in your browser. The server
(`server.mjs`) only hands out the page's own HTML, JavaScript and CSS and accepts no
uploads, and its Content-Security-Policy (`connect-src 'self'`) stops the page from
sending anything to another site. The page loads nothing from other sites either: its two
libraries are copied into `vendor/`.

## What it shows

| View | What you get |
| --- | --- |
| Overview | Tables with row and column counts, measure, relationship and page counts |
| Table → Data | All rows; search, a filter per column (`text`, `=vendor_bill`, `>100`, `<0`, `10..20`, `=2026-01-31`, `blank`), sorting, a totals row for the filtered rows; click a cell and press Ctrl+C for its exact value |
| Table → Column checks | Non-blank, blank and distinct counts, sum, minimum and maximum per column, for the filtered rows |
| Table → Model columns / Source query | Data types, calculated-column DAX, format strings, and the Power Query (M) or DAX behind the table |
| Measures | Each measure's DAX; simple measures also get their grand total with no filters, plus the matching SQL |
| Relationships | From/to columns, cardinality, cross-filter direction, active or not |
| Report pages | Each visual's fields, and its filters spelled out (for example `open_balance > 0`) |
| SQL | Every table loaded into SQLite in the browser; examples included |

## What it does not do

- **Measures are not evaluated the way a visual does.** Power BI computes a measure under
  each visual's filters. Only the unfiltered grand total of simple measures (`SUM`,
  `SUMX` over one table, `COUNTROWS`, `DISTINCTCOUNT`, `DIVIDE`, arithmetic between them,
  ...) is worked out; anything using `CALCULATE`, `FILTER`, variables or time
  intelligence is shown as DAX only.
- Charts are not drawn.
- Live-connection and DirectQuery reports keep no data in the file, so there is nothing
  to show beyond the report pages.
- Values are what the file held at its last refresh in Power BI Desktop.

## How the file is read

A `.pbix` is a zip. Its `DataModel` part is an Analysis Services backup compressed with
Microsoft's XPress9; inside are a SQLite metadata database and the VertiPaq column store
(`.idf` / `.idfmeta` / `.dictionary` files).

- `js/xpress9.js`: XPress9 decompression, ported from Microsoft's MIT-licensed decoder
- `js/abf.js`: locates each file inside the backup
- `js/vertipaq.js`: decodes columns (RLE and bit-packed data ids, numeric and Huffman-compressed string dictionaries, value encoding, nulls)
- `js/pbix.js`: metadata (tables, columns, measures, relationships, partitions) and the report layout (PBIR and legacy `Report/Layout`)
- `js/dax.js`: grand totals for simple measures
- `js/app.js`, `js/grid.js`, `js/format.js`: the interface

The decoding follows [PBIXray](https://github.com/Hugoberry/pbixray). An earlier option,
the DuckDB `pbix` extension 0.5.3, was rejected: it turns negative values in
value-encoded columns into numbers near 1.84 × 10¹⁷ (in the first test file, 895 of 928
tax amounts on purchase order lines), which a checking tool cannot have.

## Checking the decoder

`tools/verify.mjs` compares every cell the page decodes with PBIXray's output for the
same file:

```bash
pip install pbixray
python -I tools/pbixray_dump.py "file.pbix" ref.json
npm install
node tools/verify.mjs "file.pbix" ref.json
```

On the first test file, an accounts payable model (6 tables, 12,638 rows), all 329,610
cells match. The only
differences are timestamps one second apart, where PBIXray truncates float day values and
this decoder rounds them: a stored `22:51:06.000` held as `22:51:05.99999` shows `:05`
there and `:06` here. `tools/coverage.mjs` lists which storage features a file uses.
Large tables split into several segments or partitions (well over a million rows) are
decoded the same way but have not been checked against a real file yet.

Keep `.pbix` files and reference dumps out of the repository; `.gitignore` blocks them.

## Running and hosting

```bash
npm start
```

serves the page on http://localhost:8080 (or `$PORT`). It is hosted on Railway (project
`pbix-viewer`, service `web`), which redeploys automatically on every push to `main`.
GitHub Pages is not used: under this account it would be forced onto the user site's
custom domain.

`npm run vendor` refreshes `vendor/` after changing the fflate or sql.js version.

## License

MIT; see `LICENSE`. Ported code and bundled libraries keep their own MIT notices; see
`THIRD_PARTY_NOTICES.md` and `vendor/LICENSES.txt`.
