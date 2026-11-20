import sys
sys.path.insert(0,'/home/wendy/jianzhi/feedback-tasks/donor-patch-inpainter/tools')
from inspect_samples import read_png
import os
base='/home/wendy/jianzhi/feedback-tasks/donor-patch-inpainter/_samples_extracted/'
w,h,bd,ct,ch,truth=read_png(base+'small-hole-truth.png')
w2,h2,_,_,_,img=read_png(base+'small-hole.png')
w3,h3,_,_,mch,mask=read_png(base+'small-hole-mask.png')
def px(buf,x,y,ch=3): return tuple(buf[(y*w+x)*ch+i] for i in range(ch))
# diff region truth vs image
diff=[(x,y) for y in range(h) for x in range(w) if px(img,x,y)!=px(truth,x,y)]
print('diff pixels truth vs hole image:', len(diff), 'bbox:', (min(x for x,_ in diff), min(y for _,y in diff), max(x for x,_ in diff), max(y for _,y in diff)))
# mask region equal diff region?
mholes=set((x,y) for y in range(h) for x in range(w) if mask[y*w+x]==255)
print('mask==diff set:', mholes==set(diff), 'mask count', len(mholes))
# period detection: autocorrelation on truth row 0 and col 0
def best_period(vals):
    n=len(vals)
    for p in range(1,n//2):
        if all(vals[i]==vals[i+p] for i in range(n-p)):
            return p
    return None
row0=[px(truth,x,0) for x in range(w)]
col0=[px(truth,0,y) for y in range(h)]
print('horizontal period:', best_period(row0), 'vertical period:', best_period(col0))
# check full 2D tile repeat
ph=best_period(row0); pv=best_period(col0)
ok=all(px(truth,x,y)==px(truth,x%ph,y%pv) for y in range(h) for x in range(w))
print('truth is pure', ph,'x',pv,'periodic tile:', ok)
# tile content
for y in range(pv):
    print(' '.join(str(px(truth,x,y)) for x in range(ph)))
