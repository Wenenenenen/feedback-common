import sys, math, random
sys.path.insert(0, '/home/wendy/jianzhi/feedback-tasks/hiz-conservative-culler/tools')
import ref_impl as R

# 规格约定：近面 z=0、远面 z=w，即 D3D 风格 NDC z∈[0,1]，相机看 -z
def perspective(fov=1.2, near=0.1, far=10.0, reversed_=False):
    f = 1.0 / math.tan(fov / 2)
    if reversed_:  # near->1, far->0；w=-ze
        a = near / (far - near); b = near * far / (far - near)
    else:          # D3D 约定 near->0, far->1；w=-ze
        a = -far / (far - near); b = -near * far / (far - near)
    M = [f,0,0,0, 0,f,0,0, 0,0,a,b, 0,0,-1,0]
    zn = (a * (-near) + b) / near
    zf = (a * (-far) + b) / far
    want = (1.0, 0.0) if reversed_ else (0.0, 1.0)
    assert abs(zn - want[0]) < 1e-9 and abs(zf - want[1]) < 1e-9, (zn, zf)
    return M

def mk(W,H,mode,M,boxes,depth=None):
    if depth is None:
        depth = [1.0 if mode=='standard' else 0.0]*(W*H)
    return {'width':W,'height':H,'depth':depth,'mode':mode,'view_projection':M,'boxes':boxes}

fails=[]
def check(name, got, want):
    ok = got==want
    print(('PASS' if ok else 'FAIL'), name, '->', got, '(want', want, ')')
    if not ok: fails.append(name)

M, Mr = perspective(), perspective(reversed_=True)

# 1. 相机内部盒（含原点，w 有正有负）
d = mk(8,8,'standard',M,[{'id':'cam','min':[-1,-1,-1],'max':[1,1,1]}])
check('camera-interior -> visible', R.cull(d)[0][0]['status'], 'visible')

# 2. 完全在相机后方（w 全负）-> w 保护 -> visible
d = mk(8,8,'standard',M,[{'id':'behind','min':[1,1,2],'max':[2,2,3]}])
check('behind camera (w<=eps) -> visible', R.cull(d)[0][0]['status'], 'visible')

# 3. 完全在右侧 / 远面外（w 全正、角点同面）-> outside
d = mk(8,8,'standard',M,[{'id':'right','min':[5,-1,-5],'max':[6,1,-4]}])
check('outside right -> outside', R.cull(d)[0][0]['status'], 'outside')
d = mk(8,8,'standard',M,[{'id':'farout','min':[-1,-1,-12],'max':[1,1,-11]}])
check('beyond far -> outside', R.cull(d)[0][0]['status'], 'outside')

# 4. 跨近裁面：eye z 从 -2 到 +0.05（穿过相机近面，近面 eye z=-0.1）
cross = [{'id':'cross','min':[-0.5,-0.5,-2.0],'max':[0.5,0.5,0.05]}]
for tag,mm,mode in [('standard',M,'standard'),('reversed',Mr,'reversed')]:
    d = mk(8,8,mode,mm,cross)
    check(f'near crossing {tag} -> visible', R.cull(d)[0][0]['status'], 'visible')

# 5. 反向深度遮挡：近处表面 0.9，远处盒（保证在视锥内）
farbox = [{'id':'farbox','min':[-0.4,-0.4,-8],'max':[-0.2,-0.2,-7]}]
d = mk(8,8,'reversed',Mr,farbox,[0.9]*64)
r = R.cull(d)[0][0]
check('reversed far box -> occluded', r['status'], 'occluded')

# 6. 等深度（清屏值）：两种模式都必须 visible
d = mk(8,8,'reversed',Mr,farbox,[0.0]*64)
r = R.cull(d)[0][0]
print('   reversed equal: near=%.4f agg=%.4f -> %s' % (r['near_depth'], r['agg'], r['status']))
check('reversed equal depth -> visible', r['status'], 'visible')
d = mk(8,8,'standard',M,farbox,[1.0]*64)
r = R.cull(d)[0][0]
print('   standard equal: near=%.4f agg=%.4f -> %s' % (r['near_depth'], r['agg'], r['status']))
check('standard equal depth -> visible', r['status'], 'visible')

# 7. 随机奇数尺寸一致性（两种模式）
random.seed(42); W,H=13,9
boxes=[]
for i in range(60):
    cx,cy=random.uniform(-0.6,0.6),random.uniform(-0.6,0.6)
    z2,z1=sorted(random.sample([random.uniform(-9,-1) for _ in range(2)],2))
    s=random.uniform(0.05,0.25)
    boxes.append({'id':str(i),'min':[cx,cy,z2],'max':[cx+s,cy+s,z1]})
for mode,mm in [('standard',M),('reversed',Mr)]:
    dep=[round(random.random(),4) for _ in range(W*H)]
    d=mk(W,H,mode,mm,boxes,dep)
    res,levels,_,_=R.cull(d)
    mm_bad=[r['id'] for r in res if r.get('mismatch')]
    check(f'{mode} random odd pyramid==exhaustive', len(mm_bad), 0)
    if mode=='standard':
        print('   sizes:', [[w,h] for w,h,_ in levels],
              'verdicts:', {s:sum(1 for r in res if r['status']==s) for s in ('occluded','visible','outside')})

# 8. 校验：奇异矩阵 / min>max / 非有限 / 尺寸上限 / 数量上限
errs = R.validate(mk(4,4,'standard',[0]*16,[{'id':'b','min':[1,1,1],'max':[0,0,0]}]))
check('singular+inverted rejected', len(errs)>=2, True)
big = mk(514,385,'standard',M,[])
check('oversize rejected', bool(R.validate(big)), True)
many = mk(8,8,'standard',M,[{'id':str(i),'min':[0,0,-2],'max':[1,1,-1]} for i in range(2001)])
check('>2000 boxes rejected', bool(R.validate(many)), True)
badval = mk(4,4,'standard',M,[]); badval['depth']=[0.5,float('nan'),0,0]*4
check('non-finite depth rejected', bool(R.validate(badval)), True)

# 9. 部分出屏盒：矩形裁剪后仍正常判定
d = mk(8,8,'standard',M,[{'id':'edge','min':[0.8,-0.2,-5],'max':[1.5,0.2,-4]}],[0.1]*64)
r = R.cull(d)[0][0]
print('   clipped rect:', r.get('rect'), r['status'])
check('partially off-screen evaluated', r['status'] in ('occluded','visible'), True)

print(); print('FAILURES:', fails if fails else 'none')
sys.exit(1 if fails else 0)
