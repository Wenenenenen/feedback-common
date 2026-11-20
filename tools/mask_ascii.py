import sys
sys.path.insert(0,'/home/wendy/jianzhi/feedback-tasks/donor-patch-inpainter/tools')
from inspect_samples import read_png
for path in sys.argv[1:]:
    w,h,bd,ct,ch,px=read_png(path)
    print('==',path.split('/')[-1],w,h)
    if ch==1:
        for y in range(h):
            print(''.join('#' if px[y*w+x]==255 else '.' for x in range(w)))
