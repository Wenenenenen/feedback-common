import sys, struct, wave, statistics, json

def read_wav(path):
    with wave.open(path, 'rb') as w:
        nch, sw, sr, n, ctyp, _ = w.getparams()
        raw = w.readframes(n)
    assert ctyp == 'NONE' and sw == 2
    import array
    a = array.array('h'); a.frombytes(raw)
    chans = [a[i::nch] for i in range(nch)]
    return sr, n, nch, chans

for path in sys.argv[1:]:
    sr, n, nch, chans = read_wav(path)
    x = chans[0]
    print(f"== {path}: sr={sr} frames={n} dur={n/sr:.3f}s ch={nch}")
    print(f"   min={min(x)} max={max(x)} mean={sum(x)/len(x):.1f} median~{statistics.median(x)}")
    # zero crossings around mean
    mean = sum(x)/len(x)
    edges = []
    prev = x[0] - mean
    for i in range(1, len(x)):
        v = x[i] - mean
        if (prev <= 0 < v) or (prev >= 0 > v):
            edges.append(i)
        prev = v
    print(f"   raw zero crossings: {len(edges)}")
    gaps = [edges[i+1]-edges[i] for i in range(len(edges)-1)]
    print(f"   gap min/med/max: {min(gaps)} / {statistics.median(gaps)} / {max(gaps)}")
    # distribution of gap sizes
    from collections import Counter
    c = Counter(gaps)
    print(f"   gap hist (top): {c.most_common(12)}")
    # find big gaps (silence/noise regions)
    big = [(edges[i], edges[i+1], g) for i,g in enumerate(gaps) if g > 60]
    print(f"   gaps >60 samples: {big[:20]}")
    # noise estimate: std of first 500 samples
    seg = list(x[:500])
    m = sum(seg)/len(seg)
    sd = (sum((v-m)**2 for v in seg)/len(seg))**0.5
    print(f"   head 500 mean={m:.1f} sd={sd:.1f}; head values sample: {list(x[:16])}")
