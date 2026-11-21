import array, json, sys, statistics

img_path, json_path = sys.argv[1], sys.argv[2]
a = array.array('H'); a.frombytes(open(img_path,'rb').read())
meta = json.load(open(json_path))
w, h = meta['w'], meta['h']

def px(x, y): return a[y*w+x]

for idx,(rx,ry,rw,rh) in enumerate(meta['rois']):
    vals=[px(x,y) for y in range(ry,ry+rh) for x in range(rx,rx+rw)]
    gx=0.0; gy=0.0; n=0
    for y in range(ry+1,ry+rh-1):
        for x in range(rx+1,rx+rw-1):
            gx+=abs(px(x+1,y)-px(x-1,y)); gy+=abs(px(x,y+1)-px(x,y-1)); n+=1
    print(f'ROI{idx} pos=({rx},{ry}) size={rw}x{rh} min={min(vals)} max={max(vals)} mean|gx|={gx/n:.1f} mean|gy|={gy/n:.1f}')
    # ascii rendering, downsample 4x: classify D/B/?
    chars={7864:'#',55049:'.',32768:'~'}
    for yy in range(ry, ry+rh, 4):
        line=''
        for xx in range(rx, rx+rw, 2):
            v=px(xx,yy)
            if v<15000: c='#'
            elif v>45000: c='.'
            else: c='+'
            line+=c
        print('   ',line)
    print()
