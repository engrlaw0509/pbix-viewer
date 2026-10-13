"""Dump every table PBIXray decodes from a .pbix into a canonical JSON file.

Used as the reference the browser decoder is checked against cell by cell.
Usage: python -I pbixray_dump.py <file.pbix> <out.json>
"""
import sys, json, math
import pandas as pd
from pbixray import PBIXRay


def cell(v):
    if v is None or v is pd.NA or v is pd.NaT:
        return None
    if isinstance(v, float) and math.isnan(v):
        return None
    if isinstance(v, pd.Timestamp):
        s = v.strftime('%Y-%m-%d %H:%M:%S')
        return s[:10] if s.endswith(' 00:00:00') else s
    if hasattr(v, 'item'):
        v = v.item()
    if isinstance(v, float):
        return v
    if isinstance(v, (bool, int, str)):
        return v
    return str(v)


m = PBIXRay(sys.argv[1])
out = {'tables': {}, 'measures': [], 'relationships': []}
for t in m.tables:
    df = m.get_table(t)
    out['tables'][t] = {c: [cell(v) for v in df[c].tolist()] for c in df.columns}
for _, r in m.dax_measures.iterrows():
    out['measures'].append({'table': r['TableName'], 'name': r['Name'], 'expression': r['Expression']})
for _, r in m.relationships.iterrows():
    out['relationships'].append({k: cell(v) for k, v in r.items()})
with open(sys.argv[2], 'w', encoding='utf-8') as f:
    json.dump(out, f, ensure_ascii=False)
print('tables', {t: len(next(iter(c.values()), [])) for t, c in out['tables'].items()})
