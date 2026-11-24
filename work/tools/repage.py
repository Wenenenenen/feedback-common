#!/usr/bin/env python3
"""把一条合法 Ogg Opus 流按段数重新分页，使部分包跨页，用于验证跨页拼包。

用法: python3 -I repage.py in.opus out.opus [segs_per_page]
做法:
  1. 局部流重组出全部包，保持字节不变；
  2. 把每个包拆成 lacing 段（255 的倍数 + 末段），按 segs_per_page 连续装页；
  3. 页首若接续上一页未完包则置 continued 位；
  4. 页粒度 = 本页最后"结束包"的累计样本；无包结束记 -1；
     末页沿用原流 EOS 粒度（保留原有尾部裁量）。
"""
import sys, struct

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
        nseg=data[off+26]; hdr=27+nseg
        seg=list(data[off+27:off+27+nseg])
        body=data[off+hdr:off+hdr+sum(seg)]
        r.append(dict(ht=data[off+5], gran=struct.unpack_from('<q',data,off+6)[0],
                      serial=struct.unpack_from('<I',data,off+14)[0],
                      seg=seg, body=body))
        off+=hdr+sum(seg)
    return r

def packets_of(pages):
    pkts=[]; cur=bytearray()
    for p in pages:
        pos=0
        for s in p['seg']:
            cur+=p['body'][pos:pos+s]; pos+=s
            if s<255:
                pkts.append(bytes(cur)); cur=bytearray()
    return pkts

def frame_samples(toc):
    cfg=toc>>3
    if cfg<12: return [480,960,1920,2880][cfg&3]
    if cfg<16: return [480,960][cfg&1]
    return [120,240,480,960][cfg&3]
def packet_dur(p):
    toc=p[0]; code=toc&3; f=frame_samples(toc)
    if code in (0,1,2): return f*(1 if code==0 else 2)
    return (p[1]&0x3f)*f

def make_page(serial,seq,gran,flags,segs,body):
    hdr=bytearray(27+len(segs))
    hdr[0:4]=b'OggS'; hdr[5]=flags
    struct.pack_into('<q',hdr,6,gran)
    struct.pack_into('<I',hdr,14,serial)
    struct.pack_into('<I',hdr,18,seq)
    struct.pack_into('<I',hdr,22,0)
    hdr[26]=len(segs)
    for i,s in enumerate(segs): hdr[27+i]=s
    page=bytearray(hdr+body)
    struct.pack_into('<I',page,22,ogg_crc(bytes(page)))
    return bytes(page)

def main():
    inp,outp=sys.argv[1],sys.argv[2]
    per=int(sys.argv[3]) if len(sys.argv)>3 else 16
    data=open(inp,'rb').read()
    pages=read_pages(data)
    pkts=packets_of(pages)
    serial=pages[0]['serial']
    eos_gran=pages[-1]['gran']

    # 头部包：OpusHead 单独一页（BOS，粒度 0）；OpusTags 单独成页（粒度 0）
    n_head=pkts[0]; n_tags=pkts[1]
    out=[make_page(serial,0,0,0x02,[len(n_head)],n_head),
         make_page(serial,1,0,0,[len(n_tags)],n_tags)]

    # 音频：每个段带 (packet_id, packet_end?, 累计样本)
    audio=pkts[2:]
    seg_items=[]  # (pid, bytes_slice, is_last_seg_of_packet, end_sample_if_last)
    cum=0
    for pid,p in enumerate(audio):
        dur=packet_dur(p); cum+=dur
        k=len(p)//255
        laces=[255]*k+[len(p)-k*255]
        off=0
        for j,l in enumerate(laces):
            seg_items.append((pid, p[off:off+l], j==len(laces)-1, cum if j==len(laces)-1 else None))
            off+=l
    # 按段连续装页
    seq=2; i=0; prev_cont=False
    while i < len(seg_items):
        chunk=seg_items[i:i+per]
        segs=[len(it[1]) for it in chunk]
        body=b''.join(it[1] for it in chunk)
        # 本页是否结束包：最后一个 is_last 的样本
        last_end=None
        for it in chunk:
            if it[2]: last_end=it[3]
        # 本页是否以未完包结尾
        ends_mid = not chunk[-1][2]
        # 下一段是否续传（同一包）
        cont_flag = prev_cont
        # 粒度
        if last_end is None:
            gran=-1
        else:
            gran=last_end
        # 若本页是最后一批，用原 EOS 粒度
        is_last_chunk = (i+len(chunk) >= len(seg_items))
        flags=(0x01 if cont_flag else 0)
        if is_last_chunk:
            gran=eos_gran; flags|=0x04
        out.append(make_page(serial,seq,gran,flags,segs,body))
        seq+=1
        prev_cont=ends_mid
        i+=len(chunk)
    open(outp,'wb').write(b''.join(out))
    print(f"repaged {len(pkts)} packets into {len(out)} pages (per={per}, eos_g={eos_gran})")

main()
