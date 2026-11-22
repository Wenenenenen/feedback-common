# LTC decoder prototype (final) — validated against all three probe ground truths.
# Run: python3 -I scratch/ltc_proto.py <wav> <probes.json> <df30|ndf25>
#
# Pipeline:
#   1. Schmitt-trigger edges (hysteresis): polarity-independent, DC-bias and
#      noise tolerant.
#   2. Find each frame from the sync word's 24 consecutive short gaps (the twelve
#      1-bits); an L,S,S tail marks forward frames, the mirrored L,S,S lead marks
#      reverse-time audio. This also decides the direction.
#   3. Decode biphase cells between consecutive boundaries:
#      bit 0 = one long gap (~T), bit 1 = two short gaps (~T/2 each).
#      Unclassifiable gaps make the frame fail -> it is dropped (a reported gap).
#   4. Parse BCD digits from 8-bit-stride slots; reverse frames are bit-flipped.
import sys, wave, array, json

def read_wav(path):
    with wave.open(path, "rb") as w:
        nch, sw, sr, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        raw = w.readframes(n)
    a = array.array("h"); a.frombytes(raw)
    return sr, n, [a[i::nch] for i in range(nch)]

def find_edges(x):
    s = sorted(x)
    p5, p95 = s[len(s)//20], s[len(s)*19//20]
    amp = (p95 - p5) / 2 or 1.0
    off = (p95 + p5) / 2
    hi, lo = off + 0.30*amp, off - 0.30*amp
    edges = []
    high = x[0] > off
    for i, v in enumerate(x):
        if high:
            if v < lo:
                high = False; edges.append(i)
        else:
            if v > hi:
                high = True; edges.append(i)
    return edges

def find_frame_boundaries(edges, T):
    """24-short-gap sync marker. Forward: L,S,S tail after the run leads to the
    boundary. Reverse: S,S after a boundary edge precedes the run (mirror).
    Returns (boundary edge indices sorted ascending, direction)."""
    short = lambda g: 0.25*T <= g < 0.75*T
    longg = lambda g: 0.75*T <= g <= 1.4*T
    m = len(edges)
    fwd_b, rev_b = [], []
    i = 1
    while i < m:
        if short(edges[i] - edges[i-1]):
            j = i
            while j < m and short(edges[j] - edges[j-1]):
                j += 1
            if j - i >= 20:
                run_lo, run_hi = i - 1, j - 1
                # forward: run then L,S,S; boundary is the edge after those 3 gaps
                if run_hi + 3 < m:
                    t = [edges[run_hi+1]-edges[run_hi],
                         edges[run_hi+2]-edges[run_hi+1],
                         edges[run_hi+3]-edges[run_hi+2]]
                    if longg(t[0]) and short(t[1]) and short(t[2]):
                        fwd_b.append(run_hi + 3)
                # reverse: boundary edge b, then S,S into the run
                if run_lo - 3 >= 1:
                    b = run_lo - 3
                    lead = [edges[b+1]-edges[b], edges[b+2]-edges[b+1]]
                    if short(lead[0]) and short(lead[1]):
                        rev_b.append(b)
            i = j
        else:
            i += 1
    if len(fwd_b) >= len(rev_b):
        return sorted(fwd_b), "fwd"
    return sorted(rev_b), "rev"

def decode_between(edges, e_lo, e_hi, T):
    bits = []
    ok = True
    i = e_lo
    while i < e_hi:
        if i + 1 > e_hi:
            ok = False; break
        g = edges[i+1] - edges[i]
        if 0.75*T <= g <= 1.4*T:
            bits.append(0); i += 1
        elif 0.25*T <= g < 0.75*T:
            if i + 2 <= e_hi and 0.25*T <= edges[i+2]-edges[i+1] < 0.75*T:
                bits.append(1); i += 2
            else:
                ok = False; break
        else:
            ok = False; break
    return bits, ok and len(bits) == 80

def parse_tc(bits):
    """Eight BCD digits in 8-bit-stride slots (verified against probe labels):
    frame units/tens, second units/tens, minute units/tens, hour units/tens."""
    def u(base, width):
        return sum(bits[base+j] << j for j in range(width))
    fr = u(0, 4) + 10 * u(8, 2)
    sc = u(16, 4) + 10 * u(24, 3)
    mn = u(32, 4) + 10 * u(40, 3)
    hr = u(48, 4) + 10 * u(56, 2)
    return hr, mn, sc, fr, bool(bits[6])

def valid_frame(bits):
    if len(bits) != 80:
        return False
    hr, mn, sc, fr, _ = parse_tc(bits)
    return hr <= 23 and mn <= 59 and sc <= 59 and fr <= 29

def fmt(hr, mn, sc, fr, df):
    return f"{hr:02d}:{mn:02d}:{sc:02d}{';' if df else ':'}{fr:02d}"

def run(path, mode, channel=0):
    sr, n, chans = read_wav(path)
    x = chans[channel]
    T = sr / (2400 if mode == "df30" else 2000)
    dff = mode == "df30"
    edges = find_edges(x)
    bounds, direction = find_frame_boundaries(edges, T)
    rows = []
    for a, b in zip(bounds, bounds[1:]):
        bits, ok = decode_between(edges, a, b, T)
        if not ok:
            continue
        if direction == "rev":
            bits = bits[::-1]
        if not valid_frame(bits):
            continue
        hr, mn, sc, fr, dffbit = parse_tc(bits)
        rows.append((fmt(hr, mn, sc, fr, dff), edges[a], edges[b], dffbit))
    rows.sort(key=lambda r: r[1])
    return rows, direction, T, edges, bounds

if __name__ == "__main__":
    wav, probes_path, mode = sys.argv[1], sys.argv[2], sys.argv[3]
    probes = json.load(open(probes_path))
    rows, direction, T, edges, bounds = run(wav, mode)
    print(f"direction={direction} frames={len(rows)} boundaries={len(bounds)}")
    for r in rows: print("  ", r)
    print("--- probes", len(probes))
    for p in probes: print("  ", p)
    match = (len(rows) == len(probes) and
             all(a[0] == b[0] and a[1] == b[1] and a[2] == b[2]
                 for a, b in zip(rows, probes)))
    print("MATCH:", match)
