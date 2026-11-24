#!/usr/bin/env python3
"""用一条真实链的音频包平铺出大文件（默认 30 万包），用于性能与容量验证。
用法: python3 -I genbig.py in.opus out.opus [repeats]
"""
import sys, struct, importlib.util, os
here=os.path.dirname(os.path.abspath(__file__))
spec=importlib.util.spec_from_file_location('rp', os.path.join(here,'repage.py'))
# repage.py runs main() on import, so re-implement minimal bits here instead.
def crc_table():
    t=[]
    for i in range(256):
        r=i<<24
        for _ in range(8):
            r=((r<<1)^0x04c11db7)&0xffffffff if (r&0x80000000) else (r<<1)&0xffffffff
        t.append(r)
    return t
T=crc_table()
def ogg_crc(b):
    c=0
    for x in b: c=((c<<8)&0xffffffff)^T[((c>>24)&0xff)^x]
    return c
def read_pages(data):
    off=0; r=[]
    while off+27<=len(data):
        if data[off:off+4]!=b'OggS': break
        nseg=data[off+26]; hdr=27+nseg; seg=list(data[off+27:off+27+nseg])
        body=data[off+hdr:off+hdr+sum(seg)]
        r.append(dict(ht=data[off+5],gran=struct.unpack_from('<q',data,off+6)[0],
                      serial=struct.unpack_from('<I',data,off+14)[0],seg=seg,body=body))
        off+=hdr+sum(seg)
    return r
def packets_of(pages):
    out=[]; cur=bytearray()
    for p in pages:
        pos=0
        for s in p['seg']:
            cur+=p['body'][pos:pos+s]; pos+=s
            if s<255: out.append(bytes(cur)); cur=bytearray()
    return out
def make_page(serial,seq,gran,flags,segs,body):
    hdr=bytearray(27+len(segs)); hdr[0:4]=b'OggS'; hdr[5]=flags
    struct.pack_into('<q',hdr,6,gran); struct.pack_into('<I',hdr,14,serial)
    struct.pack_into('<I',hdr,18,seq); struct.pack_into('<I',hdr,22,0); hdr[26]=len(segs)
    for i,s in enumerate(segs): hdr[27+i]=s
    page=bytearray(hdr+body); struct.pack_into('<I',page,22,ogg_crc(bytes(page)))
    return bytes(page)
def frame_samples(toc):
    cfg=toc>>3
    if cfg<12: return [480,960,1920,2880][cfg&3]
    if cfg<16: return [480,960][cfg&1]
    return [120,240,480,960][cfg&3]
def dur(p):
    toc=p[0]; code=toc&3; f=frame_samples(toc)
    return f if code==0 else (2*f if code in (1,2) else (p[1]&0x3f)*f)
def main():
    inp,outp=sys.argv[1],sys.argv[2]
    reps=int(sys.argv[3]) if len(sys.argv)>3 else 2971
    data=open(inp,'rb').read(); pages=read_pages(data); pkts=packets_of(pages)
    head,tags=pkts[0],pkts[1]; base=pkts[2:]
    serial=0x1234abcd
    chunk_samp=sum(dur(p) for p in base)
    out=[make_page(serial,0,0,0x02,[len(head)],head),
         make_page(serial,1,0,0,[len(tags)],tags)]
    seq=2; cum=0; PER=50
    total=int(len(base))*reps
    n=0
    flat=[]
    for _ in range(reps): flat.extend(base)
    # 逐段装页：每包拆 lacing，按段数 PER 换页；跨页时续传位正确
    seg_items=[]  # (pid, slice, is_last, end_sample_if_last)
    cum=0
    for pid,p in enumerate(flat):
        cum+=dur(p); k=len(p)//255; laces=[255]*k+[len(p)-k*255]; off=0
        for j,l in enumerate(laces):
            seg_items.append((p[off:off+l], j==len(laces)-1, cum if j==len(laces)-1 else None)); off+=l
    i=0; prev_cont=False
    while i<len(seg_items):
        chunk=seg_items[i:i+PER]; segs=[len(it[0]) for it in chunk]; body=b''.join(it[0] for it in chunk)
        last_end=None
        for it in chunk:
            if it[1]: last_end=it[2]
        ends_mid = not chunk[-1][1]
        is_last = (i+len(chunk)>=len(seg_items))
        gran = (last_end if last_end is not None else -1)
        flags = 0x01 if prev_cont else 0
        if is_last: gran=cum-648; flags|=0x04
        out.append(make_page(serial,seq,gran,flags,segs,body)); seq+=1
        prev_cont=ends_mid; i+=len(chunk)
    open(outp,'wb').write(b''.join(out))
    print(f"wrote {n} audio packets, {len(out)} pages, {sum(len(x) for x in out)} bytes, samples={cum}")
main()
