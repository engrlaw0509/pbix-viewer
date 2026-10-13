// Opens a .pbix entirely in memory and exposes its data model and report.
// Dependencies are injected so the same code runs in the browser and in Node:
//   unzipSync - fflate's unzipSync
//   SQL       - an initialised sql.js module
import { decompressDataModel } from './xpress9.js';
import { Abf } from './abf.js';
import { decodeColumn, DataType } from './vertipaq.js';

export { DataType };

const utf16 = b => new TextDecoder('utf-16le').decode(b).replace(/^﻿/, '');
const utf8 = b => new TextDecoder('utf-8').decode(b).replace(/^﻿/, '');

function rows(db, sql) {
  let res;
  try { res = db.exec(sql); } catch (e) { return []; }
  if (!res.length) return [];
  const { columns, values } = res[0];
  return values.map(v => Object.fromEntries(columns.map((c, i) => [c, v[i]])));
}

function hasColumn(db, table, column) {
  return rows(db, `PRAGMA table_info([${table}])`).some(r => r.name === column);
}

export const typeName = {
  [DataType.String]: 'Text',
  [DataType.Int64]: 'Whole number',
  [DataType.Double]: 'Decimal number',
  [DataType.DateTime]: 'Date/time',
  [DataType.Decimal]: 'Fixed decimal',
  [DataType.Boolean]: 'True/false',
  [DataType.Binary]: 'Binary',
};

export class PbixFile {
  static async open(bytes, { unzipSync, SQL, onProgress = () => {} }) {
    const f = new PbixFile();
    onProgress('Opening the file');
    let zip;
    try { zip = unzipSync(bytes); } catch (e) { throw new Error('This is not a valid .pbix file (it could not be unzipped).'); }
    f.zip = zip;
    f.version = zip.Version ? utf16(zip.Version) : null;
    f.report = readReport(zip);
    f.mashup = readMashup(zip, unzipSync);
    if (!zip.DataModel) {
      f.model = null;
      f.liveConnection = !!zip.Connections;
      return f;
    }
    onProgress('Decompressing the data model');
    await tick();
    f.abf = new Abf(decompressDataModel(zip.DataModel));
    onProgress('Reading the model metadata');
    await tick();
    f.db = new SQL.Database(f.abf.get('metadata.sqlitedb'));
    f.model = readModel(f.db);
    return f;
  }

  // Decodes every column of one table. Returns { columns: [{name, dataType, values, error?}], rowCount }.
  // A column that cannot be read comes back blank with `error` set, so the rest of the
  // table stays usable and the failure is visible instead of silently wrong.
  decodeTable(tableName) {
    const cols = this.model.storage.filter(c => c.tableName === tableName);
    const getFile = name => this.abf.get(name);
    const columns = cols.map(c => {
      try {
        return { name: c.columnName, dataType: c.dataType, values: decodeColumn(c, getFile) };
      } catch (e) {
        return { name: c.columnName, dataType: c.dataType, values: null, error: e.message || String(e) };
      }
    });
    const lengths = new Set(columns.filter(c => c.values).map(c => c.values.length));
    if (lengths.size > 1) throw new Error(`Columns of ${tableName} have different row counts; the file may be damaged.`);
    const rowCount = lengths.size ? [...lengths][0] : 0;
    for (const c of columns) if (!c.values) c.values = new Array(rowCount).fill(null);
    return { columns, rowCount };
  }

  close() { if (this.db) this.db.close(); }
}

const tick = () => new Promise(r => setTimeout(r, 0));

function readModel(db) {
  const typeCol = hasColumn(db, 'Column', 'Type') ? 'c.Type' : 'c.BindingType';
  const dataTypeCol = hasColumn(db, 'Column', 'InferredDataType')
    ? 'CASE WHEN c.ExplicitDataType = 1 THEN c.InferredDataType ELSE c.ExplicitDataType END'
    : 'c.ExplicitDataType';

  // Same storage query as pbixray: one row per (column, partition) in storage order.
  const storageRows = rows(db, `
    SELECT t.Name AS tableName,
           COALESCE(c.ExplicitName, c.InferredName) AS columnName,
           c.ID AS columnId,
           sfd.FileName AS dictionary,
           sfh.FileName AS hidx,
           sfi.FileName AS idf,
           cs.Statistics_DistinctStates AS cardinality,
           ${dataTypeCol} AS dataType,
           ds.BaseId AS baseId,
           ds.Magnitude AS magnitude
    FROM [Column] c
    JOIN [Table] t ON c.TableID = t.ID
    JOIN ColumnStorage cs ON c.ColumnStorageID = cs.ID
    JOIN AttributeHierarchy ah ON ah.ColumnID = c.ID
    JOIN AttributeHierarchyStorage ahs ON ah.AttributeHierarchyStorageID = ahs.ID
    LEFT JOIN StorageFile sfh ON sfh.ID = ahs.StorageFileID
    LEFT JOIN DictionaryStorage ds ON ds.ID = cs.DictionaryStorageID
    LEFT JOIN StorageFile sfd ON sfd.ID = ds.StorageFileID
    JOIN ColumnPartitionStorage cps ON cps.ColumnStorageID = cs.ID
    JOIN StorageFile sfi ON sfi.ID = cps.StorageFileID
    JOIN PartitionStorage ps ON ps.ID = cps.PartitionStorageID
    WHERE ${typeCol} IN (1,2,4)
    ORDER BY t.Name, cs.StoragePosition, ps.StoragePosition`);
  const storage = [];
  const byKey = new Map();
  for (const r of storageRows) {
    const key = r.tableName + '\u0000' + r.columnName;
    let s = byKey.get(key);
    if (!s) {
      s = { ...r, idfs: [] };
      delete s.idf;
      byKey.set(key, s);
      storage.push(s);
    }
    s.idfs.push(r.idf);
  }

  const tableRows = rows(db, `SELECT ID AS id, Name AS name, Description AS description, IsHidden AS isHidden,
      ${hasColumn(db, 'Table', 'SystemFlags') ? 'SystemFlags' : '0'} AS systemFlags,
      ${hasColumn(db, 'Table', 'IsPrivate') ? 'IsPrivate' : '0'} AS isPrivate
    FROM [Table] ORDER BY ID`);
  const hasPartType = hasColumn(db, 'Partition', 'Type');
  const partitions = rows(db, `SELECT TableID AS tableId, Name AS name, QueryDefinition AS query,
      ${hasPartType ? 'Type' : 'NULL'} AS type, ${hasColumn(db, 'Partition', 'Mode') ? 'Mode' : 'NULL'} AS mode
    FROM [Partition] ORDER BY TableID, ID`);
  const columnRows = rows(db, `SELECT c.ID AS id, c.TableID AS tableId,
      COALESCE(c.ExplicitName, c.InferredName) AS name,
      ${dataTypeCol} AS dataType, ${typeCol} AS kind, c.IsHidden AS isHidden,
      c.Expression AS expression, c.FormatString AS formatString, c.Description AS description,
      ${hasColumn(db, 'Column', 'DisplayFolder') ? 'c.DisplayFolder' : 'NULL'} AS displayFolder
    FROM [Column] c ORDER BY c.TableID, c.ID`);
  const measures = rows(db, `SELECT m.ID AS id, t.Name AS tableName, m.Name AS name, m.Expression AS expression,
      m.FormatString AS formatString, m.IsHidden AS isHidden, m.Description AS description,
      ${hasColumn(db, 'Measure', 'DisplayFolder') ? 'm.DisplayFolder' : 'NULL'} AS displayFolder
    FROM Measure m JOIN [Table] t ON m.TableID = t.ID ORDER BY t.Name, m.Name`);

  const modern = hasColumn(db, 'Relationship', 'FromColumnID');
  const rc = n => (modern ? n : n.replace(/^(From|To)/, '$1End'));
  const relationships = rows(db, `SELECT ft.Name AS fromTable, fc.ExplicitName AS fromColumn,
      tt.Name AS toTable, tc.ExplicitName AS toColumn, rel.IsActive AS isActive,
      rel.${rc('FromCardinality')} AS fromCardinality, rel.${rc('ToCardinality')} AS toCardinality,
      rel.CrossFilteringBehavior AS crossFilter
    FROM Relationship rel
    JOIN [Table] ft ON ft.ID = rel.${rc('FromTableID')}
    JOIN [Column] fc ON fc.ID = rel.${rc('FromColumnID')}
    JOIN [Table] tt ON tt.ID = rel.${rc('ToTableID')}
    JOIN [Column] tc ON tc.ID = rel.${rc('ToColumnID')}`);
  const expressions = rows(db, `SELECT Name AS name, Expression AS expression, Description AS description FROM Expression`);
  const model = rows(db, `SELECT Culture AS culture FROM Model`)[0] || {};

  const storedTables = new Set(storage.map(s => s.tableName));
  const tables = tableRows
    .filter(t => !/^(H|R|U)\$/.test(t.name) && (storedTables.has(t.name) || measures.some(m => m.tableName === t.name) || !t.systemFlags))
    .map(t => {
      const parts = partitions.filter(p => p.tableId === t.id);
      const cols = columnRows.filter(c => c.tableId === t.id && c.kind !== 3);
      return {
        id: t.id,
        name: t.name,
        description: t.description,
        isHidden: !!t.isHidden,
        isAutoDate: /^(LocalDateTable|DateTableTemplate)_/.test(t.name),
        hasData: storedTables.has(t.name),
        partitions: parts,
        source: parts.some(p => p.type === 2) ? 'Calculated table (DAX)' : parts.some(p => p.type === 4) ? 'Power Query' : parts.length ? 'Other' : 'No partition',
        columns: cols.map(c => ({ ...c, typeName: typeName[c.dataType] || 'Other', isCalculated: c.kind === 2 })),
      };
    });

  return { tables, storage, measures, relationships, expressions, culture: model.culture };
}

// ---- report --------------------------------------------------------------

function parseJson(bytes, wide) {
  if (!bytes) return null;
  try { return JSON.parse(wide ? utf16(bytes) : utf8(bytes)); } catch (e) { return null; }
}

function fieldName(f) {
  if (!f || typeof f !== 'object') return null;
  const inner = f.Column || f.Measure || f.Aggregation?.Expression?.Column || f.HierarchyLevel?.Expression?.Hierarchy;
  if (f.Aggregation) {
    const col = f.Aggregation.Expression?.Column;
    if (col) return `${aggName(f.Aggregation.Function)}(${col.Expression?.SourceRef?.Entity ?? '?'}[${col.Property}])`;
  }
  if (f.HierarchyLevel) {
    const h = f.HierarchyLevel.Expression?.Hierarchy;
    return `${h?.Expression?.SourceRef?.Entity ?? '?'}[${h?.Hierarchy ?? '?'}].${f.HierarchyLevel.Level}`;
  }
  if (inner) return `${inner.Expression?.SourceRef?.Entity ?? '?'}[${inner.Property}]`;
  return null;
}

function aggName(n) {
  return ['Sum', 'Average', 'Count', 'Min', 'Max', 'CountNonNull', 'Median', 'StandardDeviation', 'Variance'][n] || 'Agg';
}

// Power BI writes the aggregation into the queryRef ("Sum(Table.col)"), including for
// plain Column fields that a visual summarizes by default. The name there is
// authoritative; the numeric Function code is only a fallback.
const QUERYREF_AGGS = { Sum: 'Sum', Avg: 'Average', Average: 'Average', Min: 'Min', Max: 'Max', Count: 'Count', CountNonNull: 'CountNonNull', DistinctCount: 'Count', Median: 'Median', StandardDeviation: 'StandardDeviation', Variance: 'Variance' };
const DATE_LEVELS = ['Year', 'Quarter', 'Month', 'Day'];

// Turns a semantic-query field into { kind: 'column' | 'measure' | 'hierarchy', table,
// column | name | hierarchy, agg?, level? }. `aliases` maps filter source names to tables.
export function parseFieldRef(f, queryRef = '', aliases = null) {
  if (!f || typeof f !== 'object') return null;
  const ent = e => {
    const s = e?.SourceRef;
    if (!s) return null;
    return s.Entity ?? (aliases && aliases.get(s.Source)) ?? s.Source ?? null;
  };
  const m = /^([A-Za-z]+)\((.*)\)$/.exec(queryRef);
  const qrAgg = m ? QUERYREF_AGGS[m[1]] || null : null;
  if (f.Measure) return { kind: 'measure', table: ent(f.Measure.Expression), name: f.Measure.Property };
  if (f.Aggregation) {
    const inner = parseFieldRef(f.Aggregation.Expression, '', aliases);
    if (!inner || inner.kind !== 'column') return null;
    return { ...inner, agg: qrAgg || aggName(f.Aggregation.Function) };
  }
  if (f.Column) {
    const pvs = f.Column.Expression?.PropertyVariationSource;
    const out = { kind: 'column', table: pvs ? ent(pvs.Expression) : ent(f.Column.Expression), column: pvs ? pvs.Property : f.Column.Property };
    if (qrAgg) out.agg = qrAgg;
    const lv = /\.Variation\.[^.]+\.(Year|Quarter|Month|Day)$/.exec(queryRef);
    if (lv) out.level = lv[1];
    return out;
  }
  if (f.HierarchyLevel) {
    const h = f.HierarchyLevel.Expression?.Hierarchy;
    const pvs = h?.Expression?.PropertyVariationSource;
    const level = f.HierarchyLevel.Level;
    if (pvs && DATE_LEVELS.includes(level)) return { kind: 'column', table: ent(pvs.Expression), column: pvs.Property, level };
    return { kind: 'hierarchy', table: ent(h?.Expression), hierarchy: h?.Hierarchy, level };
  }
  return null;
}

export function fieldLabel(r) {
  if (!r) return '?';
  if (r.kind === 'measure') return `${r.table}[${r.name}]`;
  if (r.kind === 'hierarchy') return `${r.table}[${r.hierarchy}] ${r.level}`;
  const base = `${r.table}[${r.column}]`;
  return (r.agg ? `${r.agg}(${base})` : base) + (r.level ? ` (${r.level})` : '');
}

function literalTitle(objects) {
  const t = objects?.title?.[0]?.properties?.text?.expr?.Literal?.Value;
  return typeof t === 'string' ? t.replace(/^'|'$/g, '').replace(/''/g, "'") : null;
}

// Power BI adds an empty filter card for every field on a visual; only the
// ones carrying a condition actually filter anything. Each applied filter is
// described in words, e.g. "PO Transactions[status] is not Closed, Billed".
function appliedFilters(filterConfig) {
  return describeFilters(filterConfig?.filters || []);
}

export function describeFilters(list) {
  return (list || [])
    .filter(fl => fl && fl.filter && (fl.filter.Where || []).length)
    .map(fl => describeFilter(fl))
    .filter(Boolean);
}

function literal(l) {
  const v = l?.Value;
  if (v == null) return '?';
  if (v === 'null') return '(blank)';
  let m;
  if ((m = v.match(/^'(.*)'$/s))) return m[1].replace(/''/g, "'");
  if ((m = v.match(/^datetime'(.*)'$/))) return m[1].replace(/T00:00:00(\.0+)?$/, '').replace('T', ' ');
  if ((m = v.match(/^(-?[\d.]+)[LDM]?$/))) return m[1];
  return v;
}

function describeFilter(fl) {
  const aliases = new Map((fl.filter.From || []).map(f => [f.Name, f.Entity]));
  const ref = e => {
    if (!e) return '?';
    if (e.Literal) return literal(e.Literal);
    const target = e.Column || e.Measure;
    if (target) return `${aliases.get(target.Expression?.SourceRef?.Source) ?? target.Expression?.SourceRef?.Entity ?? '?'}[${target.Property}]`;
    if (e.Aggregation) return `${aggName(e.Aggregation.Function)}(${ref(e.Aggregation.Expression)})`;
    return fieldName(e) || '?';
  };
  const ops = ['=', '>', '>=', '<', '<='];
  const cond = c => {
    if (!c) return '?';
    if (c.And) return `${cond(c.And.Left)} and ${cond(c.And.Right)}`;
    if (c.Or) return `(${cond(c.Or.Left)} or ${cond(c.Or.Right)})`;
    if (c.Not) {
      const inner = c.Not.Expression;
      if (inner?.In) return `${inner.In.Expressions.map(ref).join(', ')} is not ${inner.In.Values.map(row => row.map(x => literal(x.Literal)).join(' & ')).join(', ')}`;
      return `not (${cond(inner)})`;
    }
    if (c.In) return `${c.In.Expressions.map(ref).join(', ')} is ${c.In.Values.map(row => row.map(x => literal(x.Literal)).join(' & ')).join(', ')}`;
    if (c.Comparison) return `${ref(c.Comparison.Left)} ${ops[c.Comparison.ComparisonKind] ?? '?'} ${ref(c.Comparison.Right)}`;
    if (c.Contains) return `${ref(c.Contains.Left)} contains ${ref(c.Contains.Right)}`;
    if (c.StartsWith) return `${ref(c.StartsWith.Left)} starts with ${ref(c.StartsWith.Right)}`;
    if (c.EndsWith) return `${ref(c.EndsWith.Left)} ends with ${ref(c.EndsWith.Right)}`;
    return null;
  };
  const parts = fl.filter.Where.map(w => cond(w.Condition));
  if (parts.some(p => !p)) return `${fieldName(fl.field) || 'a field'} has a ${String(fl.type || 'custom').toLowerCase()} filter`;
  return parts.join(' and ');
}

function readReport(zip) {
  // Enhanced report format (PBIR): Report/definition/pages/<id>/page.json + visuals/<id>/visual.json
  const pagesJson = parseJson(zip['Report/definition/pages/pages.json']);
  const pageIds = new Set();
  for (const name of Object.keys(zip)) {
    const m = name.match(/^Report\/definition\/pages\/([^/]+)\/page\.json$/);
    if (m) pageIds.add(m[1]);
  }
  if (!pageIds.size && !zip['Report/Layout']) return { format: 'none', pages: [], filters: [], rawFilters: [] };
  if (pageIds.size) {
    const order = pagesJson?.pageOrder || [...pageIds];
    const pages = order.filter(id => pageIds.has(id)).map(id => {
      const page = parseJson(zip[`Report/definition/pages/${id}/page.json`]) || {};
      const visuals = Object.keys(zip)
        .filter(n => n.startsWith(`Report/definition/pages/${id}/visuals/`) && n.endsWith('/visual.json'))
        .map(n => {
          const v = parseJson(zip[n]) || {};
          const q = v.visual?.query?.queryState || {};
          const fields = [];
          for (const [role, proj] of Object.entries(q)) {
            for (const p of proj?.projections || []) {
              const ref = parseFieldRef(p.field, p.queryRef || '');
              fields.push({
                role,
                ref,
                field: ref ? fieldLabel(ref) : p.queryRef || '?',
                label: p.displayName || null,
                header: p.displayName || p.nativeQueryRef || (ref ? fieldLabel(ref) : p.queryRef) || '?',
                active: p.active,
              });
            }
          }
          const filters = appliedFilters(v.filterConfig);
          const slicerFilter = v.visual?.objects?.general?.[0]?.properties?.filter?.filter;
          return {
            id: v.name || n.split('/').slice(-2, -1)[0],
            type: v.visual?.visualType || (v.visualGroup ? 'group' : 'unknown'),
            title: literalTitle(v.visual?.visualContainerObjects) || null,
            fields, filters,
            rawFilters: (v.filterConfig?.filters || []).filter(fl => fl.filter && (fl.filter.Where || []).length),
            slicerSelection: slicerFilter && (slicerFilter.Where || []).length ? slicerFilter : null,
            sort: (v.visual?.query?.sortDefinition?.sort || []).map(s => ({ ref: parseFieldRef(s.field), dir: s.direction === 'Descending' ? -1 : 1 })).filter(s => s.ref),
            position: v.position || null,
            hidden: !!v.isHidden,
          };
        })
        .sort((a, b) => (a.position?.y ?? 0) - (b.position?.y ?? 0) || (a.position?.x ?? 0) - (b.position?.x ?? 0));
      const filters = appliedFilters(page.filterConfig);
      return {
        id,
        name: page.displayName || id,
        visuals, filters,
        rawFilters: (page.filterConfig?.filters || []).filter(fl => fl.filter && (fl.filter.Where || []).length),
        interactions: page.visualInteractions || [],
        hidden: page.visibility === 'HiddenInViewMode',
      };
    });
    const report = parseJson(zip['Report/definition/report.json']) || {};
    return {
      format: 'PBIR', pages,
      filters: appliedFilters(report.filterConfig),
      rawFilters: (report.filterConfig?.filters || []).filter(fl => fl.filter && (fl.filter.Where || []).length),
    };
  }

  // Legacy format: Report/Layout is one UTF-16 JSON document
  const layout = parseJson(zip['Report/Layout'], true);
  if (!layout) return { format: 'none', pages: [], filters: [], rawFilters: [] };
  const list = s => {
    if (Array.isArray(s)) return s;
    try { return typeof s === 'string' ? JSON.parse(s) : []; } catch (e) { return []; }
  };
  const pages = (layout.sections || []).map(s => {
    const visuals = (s.visualContainers || []).map(vc => {
      let cfg = {};
      try { cfg = JSON.parse(vc.config || '{}'); } catch (e) { /* ignore */ }
      const sv = cfg.singleVisual || {};
      const fields = [];
      for (const [role, list] of Object.entries(sv.projections || {})) {
        // ref stays null: the visual check reads the PBIR format only for now
        for (const p of list || []) fields.push({ role, ref: null, field: p.queryRef || '?', label: null, header: p.queryRef || '?' });
      }
      return {
        id: cfg.name || null,
        type: sv.visualType || (cfg.singleVisualGroup ? 'group' : 'unknown'),
        title: literalTitle(sv.vcObjects),
        fields, filters: describeFilters(list(vc.filters)),
        rawFilters: [], slicerSelection: null, sort: [],
        position: { x: vc.x, y: vc.y },
        hidden: false,
      };
    }).sort((a, b) => (a.position.y ?? 0) - (b.position.y ?? 0) || (a.position.x ?? 0) - (b.position.x ?? 0));
    return { id: s.name, name: s.displayName || s.name, visuals, filters: describeFilters(list(s.filters)), rawFilters: [], interactions: [], hidden: false };
  });
  return { format: 'Layout', pages, filters: describeFilters(list(layout.filters)), rawFilters: [] };
}

// Power Query M from the DataMashup part (older files keep queries only here).
function readMashup(zip, unzipSync) {
  const dm = zip.DataMashup;
  if (!dm || dm.length < 8) return null;
  try {
    const dv = new DataView(dm.buffer, dm.byteOffset, dm.byteLength);
    const size = dv.getUint32(4, true);
    const inner = unzipSync(dm.subarray(8, 8 + size));
    const m = inner['Formulas/Section1.m'];
    return m ? utf8(m) : null;
  } catch (e) {
    return null;
  }
}
