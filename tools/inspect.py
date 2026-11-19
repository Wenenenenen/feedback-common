import sys, struct, os, math

def read_wav(path):
    with open(path, 'rb') as f:
        buf = f.read()
    if buf[:4] != b'RIFF' or buf[8:12] != b'WAVE':
        return None, 'not riff/wave'
    pos = 12
    fmt = None
    data = None
    while pos + 8 <= len(buf):
        cid = buf[pos:pos+4]
        sz = struct.unpack('<I', buf[pos+4:pos+8])[0]
        body = buf[pos+8:pos+8+sz]
        if cid == b'fmt ':
            fmt = struct.unpack('<HHIIHH', body[:16])
        elif cid == b'data':
            data = body
        pos += 8 + sz + (sz & 1)
        if cid == b'data' and data is not None and pos > len(buf):
            break
    return (fmt, data, len(buf)), None

for path in sys.argv[1:]:
    print('='*80)
    print(os.path.basename(path), os.path.getsize(path), 'bytes')
    info, err = read_wav(path)
    if err:
        print('ERR', err); continue
    fmt, data, fsize = info
    tag, ch, rate, byterate, align, bits = fmt
    n = (len(data) // align) if data else 0
    print(f'formatTag={tag} ch={ch} rate={rate} bits={bits} align={align} dataBytes={len(data) if data else 0} frames={n} duration={n/rate:.3f}s fileEndsAt={12+0}')
    # check truncation: expected file size vs actual
    if data is not None and tag == 1 and bits in (16,24) and ch in (1,2):
        # decode first/last samples and look at peaks
        if bits == 16:
            vals = struct.unpack('<%dh' % (len(data)//2), data[:len(data)//2*2])
        else:
            b = data
            vals = []
            for i in range(0, len(b)//3*3, 3):
                v = b[i] | (b[i+1]<<8) | (b[i+2]<<16)
                if v & 0x800000: v -= 1<<24
                vals.append(v)
        peak = max(abs(v) for v in vals)
        print('peak abs:', peak, '(% .3f FS)' % (peak/(2**(bits-1))))
        # per-channel peak locations (first few big peaks) for first channel
        ch0 = vals[0::ch]
        thr = peak*0.5
        idxs = [i for i,v in enumerate(ch0) if abs(v) >= thr][:15]
        print('first ch0 >50%peak idx:', idxs)
