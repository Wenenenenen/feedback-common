import sys, struct, zlib, os
# minimal PNG reader, no third-party deps
def read_png(path):
    with open(path,'rb') as f:
        data=f.read()
    assert data[:8]==b'\x89PNG\r\n\x1a\n'
    pos=8; width=height=bd=ct=None; idat=b''
    while pos < len(data):
        ln=struct.unpack('>I',data[pos:pos+4])[0]; typ=data[pos+4:pos+8]; chunk=data[pos+8:pos+8+ln]
        if typ==b'IHDR':
            width,height,bd,ct,comp,filt,inter=struct.unpack('>IIBBBBB',chunk)
        elif typ==b'IDAT': idat+=chunk
        elif typ==b'IEND': break
        pos += 12+ln
    raw=zlib.decompress(idat)
    ch={0:1,2:3,3:1,4:2,6:4}[ct]
    bpp=ch*(bd//8)
    stride=width*bpp
    out=bytearray(stride*height)
    prev=bytearray(stride)
    p=0
    for y in range(height):
        ft=raw[p]; p+=1
        line=bytearray(raw[p:p+stride]); p+=stride
        for x in range(stride):
            a=line[x-bpp] if x>=bpp else 0
            b=prev[x]
            c=prev[x-bpp] if x>=bpp else 0
            if ft==1: line[x]=(line[x]+a)&255
            elif ft==2: line[x]=(line[x]+b)&255
            elif ft==3: line[x]=(line[x]+((a+b)>>1))&255
            elif ft==4:
                pp=a+b-c; pa=abs(pp-a); pb=abs(pp-b); pc=abs(pp-c)
                pr=a if (pa<=pb and pa<=pc) else (b if pb<=pc else c)
                line[x]=(line[x]+pr)&255
        out[y*stride:(y+1)*stride]=line
        prev=line
    return width,height,bd,ct,ch,bytes(out)

for path in sys.argv[1:]:
    w,h,bd,ct,ch,px=read_png(path)
    print(os.path.basename(path), 'size',w,'x',h,'bitdepth',bd,'colortype',ct,'channels',ch)
    if ch==1:
        vals=sorted(set(px))
        print('  unique values:', vals[:10], '...' if len(vals)>10 else '', 'count=',len(vals))
        n255=px.count(255); print('  n255=',n255,'(',100*n255/len(px),'% )')
    else:
        # sample some pixels
        def pix(x,y): return tuple(px[(y*w+x)*ch+i] for i in range(3))
        print('  corners:', pix(0,0), pix(w-1,0), pix(0,h-1), pix(w-1,h-1))
        print('  center:', pix(w//2,h//2))
