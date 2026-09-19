#!/usr/bin/env python3
"""Tabulate harness results: qa-table.py <name-prefix> [--writes]"""
import glob
import json
import os
import sys

prefix = sys.argv[1] if len(sys.argv) > 1 else 'v1-'
show_writes = '--writes' in sys.argv
here = os.path.dirname(os.path.abspath(__file__))
files = sorted(glob.glob(os.path.join(here, 'results', prefix + '*.json')), key=os.path.getmtime)

hdr = (f"{'run':26} {'rows':>4} {'eds':>3} {'inv':>3} {'und':>3} {'treeH':>5} {'elems':>6} {'idle':>5} "
       f"{'drag avg':>8} {'p90':>5} {'resize avg':>10} {'p90':>5} {'scroll':>6}  notes")
print(hdr)
print('-' * len(hdr))


def fmt(d, key, width, prec=1):
    if d is None:
        return f"{'-':>{width}}"
    return f"{d.get(key, 0):{width}.{prec}f}"


for f in files:
    d = json.load(open(f))
    if 'error' in d:
        print(f"{os.path.basename(f).rsplit('-', 1)[0]:26} ERROR {d['error']}  {'; '.join(d.get('notes') or [])}")
        continue
    b = d.get('before', {})
    drag = d.get('drag') or None
    resize = d.get('resize') or None
    scroll = d.get('scroll') or None
    idle = d.get('idle') or {}
    name = os.path.basename(f).rsplit('-', 1)[0]
    notes = '; '.join(d.get('notes') or [])
    if d.get('css'):
        notes += '  css=' + d['css']
    print(f"{name:26} {b.get('treeRowsTotal', 0):4} {b.get('codeEditors', 0):3} {b.get('invisible', 0):3} {b.get('undisplayed', 0):3} "
          f"{b.get('treeRectHeight', -1):5} {b.get('elements', 0):6} {idle.get('avgMs', 0):5.1f} "
          f"{fmt(drag, 'avgMs', 8)} {fmt(drag, 'p90Ms', 5, 0)} {fmt(resize, 'avgMs', 10)} {fmt(resize, 'p90Ms', 5, 0)} "
          f"{fmt(scroll, 'avgMs', 6)}  {notes}")
    if show_writes and d.get('dragWrites'):
        items = [f"{k}={v}" for k, v in d['dragWrites'].items() if v >= 0.05]
        print(f"{'':26} writes/frame: " + ', '.join(items))
