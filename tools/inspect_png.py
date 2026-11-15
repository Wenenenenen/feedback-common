import struct, zlib, sys, collections

def read_png(path):
    b = open(path,'rb').read()
    pos = 8
    width=height=bitd=ctype=None
    idat=b''
    while pos < len(b):
        ln = struct.unpack('>I', b[pos:pos+4])[0]
        typ = b[pos+4:pos+8]
        data = b[pos+8:pos+8+ln]
        if typ==b'IHDR':
            width,height,bitd,ctype = struct.unpack('>IIBB', data[:10])
        elif typ==b'IDAT':
            idat += data
        elif typ==b'IEND':
            break
        pos += 12+ln
    raw = zlib.decompress(idat)
    ch = {0:1,2:3,3:1,4:2,6:4}[ctype]
    stride = width*ch
    out=bytearray()
    prev=bytearray(stride)
    p=0
    for y in range(height):
        f=raw[p]; p+=1
        line=bytearray(raw[p:p+stride]); p+=stride
        for i in range(stride):
            a=line[i-ch] if i>=ch else 0
            up=prev[i]
            ul=prev[i-ch] if i>=ch else 0
            if f==1: line[i]=(line[i]+a)&255
            elif f==2: line[i]=(line[i]+up)&255
            elif f==3: line[i]=(line[i]+((a+up)>>1))&255
            elif f==4:
                pa=abs(up-ul); pb=abs(a-ul); pc=abs(a+up-2*ul)
                pr=a if pa<=pb and pa<=pc else (up if pb<=pc else ul)
                line[i]=(line[i]+pr)&255
        out+=line; prev=line
    return width,height,ch,bytes(out)

for path in sys.argv[1:]:
    w,h,ch,px = read_png(path)
    cnt=collections.Counter()
    for i in range(0,len(px),ch):
        cnt[px[i:i+ch]]+=1
    print(path, w,h,'channels',ch,'distinct colors',len(cnt))
    for c,n in cnt.most_common(6): print('  ',tuple(c),n)
