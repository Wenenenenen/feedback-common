#!/usr/bin/env python3
"""Cross-check JS engine against the independent Python reference.

Runs both implementations on the sample room and hand-built edge cases
(edge/corner discard, grazing box touch, multi-box tie, zero-tap wall) and
compares path sets, vertices (exact rationals), blockage reports and response
samples. Run: python3 -I tools/crosscheck.py
"""
import json
import subprocess
import sys
from fractions import Fraction
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from reference import solve as py_solve  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
NODE_DUMP = ROOT / 'tools' / 'dump.js'


def node_solve(room):
    p = subprocess.run(
        ['node', str(NODE_DUMP)],
        input=json.dumps(room), capture_output=True, text=True, check=True,
    )
    return json.loads(p.stdout)


def verts_key(rows):
    out = {}
    for r in rows:
        key = tuple(r['walls'])
        out[key] = (
            tuple(tuple(Fraction(s) for s in v) for v in r['verts']),
            round(r['length'], 9),
            r['blocked'],
        )
    return out


def compare(name, room):
    py = py_solve(room)
    js = node_solve(room)
    assert set(map(tuple, js['pairs'])) == set(py.keys()), 'pair set mismatch'
    for pair, py_rows in py.items():
        js_rows = next(r for k, r in zip(map(tuple, js['pairs']), js['results']) if tuple(k) == pair)
        a, b = verts_key(py_rows), verts_key(js_rows)
        assert set(a) == set(b), f'{name} {pair}: wall-order sets differ\n only py: {set(a)-set(b)}\n only js: {set(b)-set(a)}'
        for k in a:
            pv, pl, pb = a[k]
            jv, jl, jb = b[k]
            assert pv == jv, f'{name} {pair} {k}: vertex mismatch {pv} vs {jv}'
            assert abs(pl - jl) < 1e-9, f'{name} {pair} {k}: length mismatch'
            assert (pb is None and jb is None) or (pb and jb and tuple(pb) == tuple(jb)), \
                f'{name} {pair} {k}: blockage mismatch {pb} vs {jb}'
    print(f'PASS {name}: {sum(len(v) for v in py.values())} paths across {len(py)} pairs')
    return js


def main():
    sample = json.loads((ROOT / 'samples' / 'extracted' / 'room.json').read_text())
    compare('sample room', sample)

    # Exact corner hit: image segment crosses x=L and y=L at one parameter.
    # tx = (L-Sx)/(2L-Rx-Sx), ty likewise; numbers below make them identical,
    # so the x1->y1 candidate must be dropped by both engines as an edge hit.
    corner = {
        'size': [4000, 4000, 3000],
        'sources': [[1000, 2000, 1500]],
        'receivers': [[2500, 3000, 1500]],
        'boxes': [], 'order': 2, 'walls': sample['walls'],
    }
    c = compare('exact corner discard', corner)
    orders = {tuple(r['walls']) for r in c['results'][0]}
    assert ('x1', 'y1') not in orders, 'corner path must be discarded'
    assert ('x1',) in orders and ('y1',) in orders, 'single-wall paths survive'

    # Grazing touch: box face contains the whole direct segment on one axis plane,
    # closed box => block, even though the ray only slides along the surface.
    graze = {
        'size': [4000, 4000, 3000],
        'sources': [[500, 1000, 1500]],
        'receivers': [[3500, 1000, 1500]],
        'boxes': [{'min': [1500, 1000, 1000], 'max': [2500, 2000, 2000]}],
        'order': 1, 'walls': sample['walls'],
    }
    g = compare('grazing box', graze)
    direct = next(r for r in g['results'][0] if not r['walls'])
    assert direct['blocked'] == [0, 0], 'grazing direct path must be blocked at segment 0'

    # Multi-box tie: two boxes sharing an entry plane, both met by the ray at
    # the same point -> smallest index wins. Boxes stay strictly inside the room.
    tie = {
        'size': [6000, 4000, 3000],
        'sources': [[500, 2000, 1500]],
        'receivers': [[5500, 2000, 1500]],
        'boxes': [
            {'min': [2700, 1900, 1400], 'max': [3200, 2100, 1600]},
            {'min': [2700, 2000, 1500], 'max': [3200, 2200, 1700]},
        ],
        'order': 0, 'walls': sample['walls'],
    }
    t = compare('multi-box tie', tie)
    assert t['results'][0][0]['blocked'] == [0, 0], 'smallest box index must win ties'

    # Zero taps still produce geometric paths; response contribution is zero.
    zero = json.loads(json.dumps(sample))
    zero['walls'] = [[0, 0, 0]] * 6
    z = compare('zero-tap walls', zero)
    assert all(abs(x) == 0.0 for x in z['response']), 'zero taps => silent response'
    assert z['results'][0], 'geometry must still exist with zero wall taps'

    print('\nALL CROSS-CHECKS PASSED')


if __name__ == '__main__':
    main()
