#!/usr/bin/env python3
"""Print forced-layout reads, attributed DOM toggles, and stack samples: qa-forced.py <name-prefix>"""
import glob
import json
import os
import sys

prefix = sys.argv[1] if len(sys.argv) > 1 else 'g4h-forced'
here = os.path.dirname(os.path.abspath(__file__))
files = sorted(glob.glob(os.path.join(here, 'results', prefix + '*.json')), key=os.path.getmtime)

for f in files:
    d = json.load(open(f))
    name = os.path.basename(f).rsplit('-', 1)[0]
    drag = d.get('drag') or {}
    print(f"=== {name}  drag avg {drag.get('avgMs')} ms/frame  ({'; '.join(d.get('notes') or [])[:160]})")
    writes = d.get('dragWrites') or {}
    forced = {k: v for k, v in writes.items() if k.startswith('forced.')}
    toggles = {k: v for k, v in writes.items() if '@' in k}
    muts = {k: v for k, v in writes.items() if k.startswith('mut.')}
    print("  forced reads/frame:", ', '.join(f"{k[7:]}={v}" for k, v in sorted(forced.items(), key=lambda kv: -kv[1])) or 'none')
    print("  attributed toggles/frame:", ', '.join(f"{k}={v}" for k, v in sorted(toggles.items(), key=lambda kv: -kv[1])[:12]) or 'none')
    print("  mutations/frame:", ', '.join(f"{k[4:]}={v}" for k, v in sorted(muts.items(), key=lambda kv: -kv[1])[:8]) or 'none')
    for api, stacks in (d.get('forcedStacks') or {}).items():
        print(f"  --- first forced {api} stacks ({len(stacks)}):")
        for s in stacks:
            print("     ", s[:600])
    print()
