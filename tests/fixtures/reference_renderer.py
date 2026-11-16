# Independent reference implementation of the spec (numpy-free), used to
# validate the JS renderer's left/right eye outputs on the occlusion sample.
import struct, zlib, sys, json, math

D='/tmp/sdf-cases-1'
meta=json.load(open(D+'/occlusion.json'))
w,h=meta['width'],meta['height']
fw,fh,fx,fy,cx,cy=meta['width'],meta['height'],meta['fx'],meta['fy'],meta['cx'],meta['cy']
b=meta['eye_distance']; Z0=meta['zero_plane']; jump=meta['jump']
depth=struct.unpack('<%df'%(w*h), open(D+'/occlusion.f32','rb').read())

# decode color.png
raw_png=open(D+'/color.png','rb').read()
i=8; idat=b''
while i<len(raw_png):
    n=struct.unpack('>I',raw_png[i:i+4])[0]; t=raw_png[i+4:i+8]; d=raw_png[i+8:i+8+n]; i+=12+n
    if t==b'IHDR': ww,hh,bd,ct=struct.unpack('>IIBB',d[:10])
    if t==b'IDAT': idat+=d
raw=zlib.decompress(idat); stride=ww*3; rows=[]; prev=bytearray(stride); pos=0
for y in range(hh):
    f=raw[pos]; pos+=1; line=bytearray(raw[pos:pos+stride]); pos+=stride
    if f==1:
        for x in range(3,stride): line[x]=(line[x]+line[x-3])&255
    elif f==2:
        for x in range(stride): line[x]=(line[x]+prev[x])&255
    elif f==3:
        for x in range(stride):
            a=line[x-3] if x>=3 else 0
            line[x]=(line[x]+((a+prev[x])>>1))&255
    elif f==4:
        for x in range(stride):
            a=line[x-3] if x>=3 else 0
            c=prev[x-3] if x>=3 else 0
            p=a+prev[x]-c; pa=abs(p-a); pb=abs(p-prev[x]); pc=abs(p-c)
            pr=a if (pa<=pb and pa<=pc) else (prev[x] if pb<=pc else c)
            line[x]=(line[x]+pr)&255
    rows.append(bytes(line)); prev=line

def valid(z): return z==z and abs(z)!=float('inf') and z>0
def tri_ok(a,b_,c):
    if not(valid(a) and valid(b_) and valid(c)): return False
    t=[a,b_,c]; return max(t)-min(t)<=jump

def sample(tx,ty):
    x0=int(tx//1); y0=int(ty//1); fxr=tx-x0; fyr=ty-y0
    if x0<0: fxr=0; x0=0
    if y0<0: fyr=0; y0=0
    if x0>ww-1: fxr=0; x0=ww-1
    if y0>hh-1: fyr=0; y0=hh-1
    x1=min(x0+1,ww-1); y1=min(y0+1,hh-1)
    out=[]
    for ch in range(3):
        v=(rows[y0][x0*3+ch]*(1-fxr)*(1-fyr) + rows[y0][x1*3+ch]*fxr*(1-fyr)
          + rows[y1][x0*3+ch]*(1-fxr)*fyr + rows[y1][x1*3+ch]*fxr*fyr)
        out.append(int(round(v)))
    return out

def render(eye):
    eyeX=-b/2 if eye=='left' else b/2
    rgba=bytearray(w*h*4); mask=bytearray([255])*(w*h)
    zb=[float('inf')]*(w*h); tb=[1<<30]*(w*h)
    # triangle list in row-major order
    tris=[]
    for r in range(h-1):
        for c in range(w-1):
            i00=r*w+c; i10=i00+1; i11=i10+w; i01=i00+w
            if tri_ok(depth[i00],depth[i10],depth[i11]): tris.append((i00,i10,i11))
            if tri_ok(depth[i00],depth[i11],depth[i01]): tris.append((i00,i11,i01))
    for t,(i0,i1,i2) in enumerate(tris):
        iz=[1/depth[i0],1/depth[i1],1/depth[i2]]
        pts=[]
        for i,z in zip((i0,i1,i2),iz):
            c=i%w; r=i//w
            X=(c+.5-cx)*depth[i]/fx; Y=(r+.5-cy)*depth[i]/fy
            u=fx*(X-eyeX)/depth[i]+cx+fx*eyeX/Z0
            v=fy*Y/depth[i]+cy
            pts.append((u,v,c+.5,r+.5,iz[len(pts)]))
        (ax,ay,sax,say,za),(bx,by,sbx,sby,zb_),(cx_,cy_,scx,scy,zc)=pts
        area=(cx_-ax)*(by-ay)-(cy_-ay)*(bx-ax)
        if area==0: continue
        if area<0:
            bx,by,sbx,sby,zb_,cx_,cy_,scx,scy,zc = cx_,cy_,scx,scy,zc,bx,by,sbx,sby,zb_
            area=-area
        px0=max(0,math.ceil(min(ax,bx,cx_)-0.5)); px1=min(w-1,math.floor(max(ax,bx,cx_)-0.5))
        py0=max(0,math.ceil(min(ay,by,cy_)-0.5)); py1=min(h-1,math.floor(max(ay,by,cy_)-0.5))
        for py in range(py0,py1+1):
            for px in range(px0,px1+1):
                X=px+.5; Y=py+.5
                e0=(X-bx)*(cy_-by)-(Y-by)*(cx_-bx)
                e1=(X-cx_)*(ay-cy_)-(Y-cy_)*(ax-cx_)
                e2=(X-ax)*(by-ay)-(Y-ay)*(bx-ax)
                if e0<-1e-7 or e1<-1e-7 or e2<-1e-7: continue
                l0=e0/area; l1=e1/area; l2=e2/area
                iw=l0*za+l1*zb_+l2*zc
                if not iw>0: continue
                z=1/iw
                p=py*w+px
                tol=zb[p]*1e-6
                if z>zb[p]+tol: continue
                if z>=zb[p]-tol and t>=tb[p]: continue
                sx=(l0*sax*za+l1*sbx*zb_+l2*scx*zc)/iw
                sy=(l0*say*za+l1*sby*zb_+l2*scy*zc)/iw
                rgb=sample(sx-.5, sy-.5)
                rgba[p*4:p*4+3]=bytes(rgb); rgba[p*4+3]=255
                mask[p]=0; zb[p]=z; tb[p]=t
    return rgba, mask

import os
os.makedirs('/tmp/sdf-work/ref', exist_ok=True)
for eye in ('left','right'):
    rgba,mask=render(eye)
    open(f'/tmp/sdf-work/ref/{eye}.rgba','wb').write(rgba)
    open(f'/tmp/sdf-work/ref/{eye}.mask','wb').write(mask)
    print(eye,'holes',sum(1 for v in mask if v))
