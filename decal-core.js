/* 贴花体积裁剪核心管线（纯计算，无渲染依赖，可在 Node 中测试）
 * 手写实现：六面体(Sutherland–Hodgman)裁剪、世界法线角度筛选、
 * 交点重心坐标插值、来源三角形追踪、镜像实例绕序反转。 */

export const EPS = 1e-9;        // 计算容差
export const MIN_AREA = 1e-12;  // 偏移前面积下限（退化面丢弃）
export const MAX_TRIS = 10000;
export const MAX_PROJECTORS = 4;

/* ---------- 矩阵工具（行主序 4×4 / 3×3） ---------- */
export const m3det = m => m[0]*(m[4]*m[8]-m[5]*m[7]) - m[1]*(m[3]*m[8]-m[5]*m[6]) + m[2]*(m[3]*m[7]-m[4]*m[6]);
export function m3inv(m) {
  const a=m[0],b=m[1],c=m[2],d=m[3],e=m[4],f=m[5],g=m[6],h=m[7],i=m[8];
  const A=e*i-f*h, B=f*g-d*i, C=d*h-e*g, det=a*A+b*B+c*C, s=1/det;
  return [A*s,(c*h-b*i)*s,(b*f-c*e)*s, B*s,(a*i-c*g)*s,(c*d-a*f)*s, C*s,(b*g-a*h)*s,(a*e-b*d)*s];
}
export const m3t = m => [m[0],m[3],m[6], m[1],m[4],m[7], m[2],m[5],m[8]];
export const m3v = (m,v) => [m[0]*v[0]+m[1]*v[1]+m[2]*v[2], m[3]*v[0]+m[4]*v[1]+m[5]*v[2], m[6]*v[0]+m[7]*v[1]+m[8]*v[2]];
export const m4p = (m,p) => [m[0]*p[0]+m[1]*p[1]+m[2]*p[2]+m[3], m[4]*p[0]+m[5]*p[1]+m[6]*p[2]+m[7], m[8]*p[0]+m[9]*p[1]+m[10]*p[2]+m[11]];
export function m4invAffine(m) { // 仿射 [A t; 0 1] 求逆
  const A=[m[0],m[1],m[2],m[4],m[5],m[6],m[8],m[9],m[10]], Ai=m3inv(A), t=[m[3],m[7],m[11]], ti=m3v(Ai,t).map(x=>-x);
  return [Ai[0],Ai[1],Ai[2],ti[0], Ai[3],Ai[4],Ai[5],ti[1], Ai[6],Ai[7],Ai[8],ti[2], 0,0,0,1];
}
export const sub=(a,b)=>[a[0]-b[0],a[1]-b[1],a[2]-b[2]];
export const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
export const dot=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
export const norm=v=>{const l=Math.hypot(v[0],v[1],v[2]);return l>0?[v[0]/l,v[1]/l,v[2]/l]:[0,0,0];};

/* ---------- 核心管线 ----------
 * scene: {meshes:[{id,vertices,triangles}], instances:[{id,mesh,matrix}], projectors:[{id,worldToBox,texture,maxAngle,worldOffset}]}
 * projOverrides: 每投射盒可选 {worldToBox, maxAngle, worldOffset}
 * 返回 {records, stats}；records 每三角形：
 *   {projectorId, instanceId, meshId, sourceTriangle, positions(偏移后世界), positionsRaw(偏移前世界),
 *    uv(逐角, v向下), bary(逐角重心坐标), normal(世界外法线)} */
export function buildDecals(scene, projOverrides) {
  const triTotal = scene.meshes.reduce((s,m)=>s+m.triangles.length,0);
  if (triTotal > MAX_TRIS) throw new Error(`三角形总数 ${triTotal} 超过上限 ${MAX_TRIS}`);
  if (scene.projectors.length > MAX_PROJECTORS) throw new Error(`投射盒 ${scene.projectors.length} 个超过上限 ${MAX_PROJECTORS}`);

  const meshById = Object.fromEntries(scene.meshes.map(m=>[m.id,m]));
  const records = [];
  const stats = [];

  scene.projectors.forEach((proj, pi) => {
    const ov = projOverrides?.[pi] || {};
    const w2b = ov.worldToBox || proj.worldToBox;
    const maxAngle = ov.maxAngle ?? proj.maxAngle;
    const worldOffset = ov.worldOffset ?? proj.worldOffset;
    const b2w = m4invAffine(w2b);
    const b2wL = [b2w[0],b2w[1],b2w[2], b2w[4],b2w[5],b2w[6], b2w[8],b2w[9],b2w[10]];
    const projDir = norm(m3v(b2wL,[0,0,1]));          // 世界投射方向：盒到世界 +z 轴
    const negDir = [-projDir[0],-projDir[1],-projDir[2]];
    const cosT = Math.cos(maxAngle*Math.PI/180);
    const st = { id: proj.id, kept:0, angleCut:0, clipCut:0, degen:0, out:0 };

    for (const inst of scene.instances) {
      const mesh = meshById[inst.mesh];
      if (!mesh) continue;
      const M = inst.matrix;
      const A = [M[0],M[1],M[2], M[4],M[5],M[6], M[8],M[9],M[10]];
      const det = m3det(A);
      const N = m3t(m3inv(A));                        // 世界法线 = 线性部分逆转置
      const wv = mesh.vertices.map(v=>m4p(M,v));      // 世界顶点
      const bv = wv.map(v=>m4p(w2b,v));               // 盒局部顶点

      mesh.triangles.forEach((tri, ti) => {
        const [i0,i1,i2] = tri;
        const lv = mesh.vertices;
        const ln = norm(cross(sub(lv[i1],lv[i0]), sub(lv[i2],lv[i0]))); // 局部叉乘外法线
        const wn = norm(m3v(N, ln));                                     // 世界外法线
        if (dot(wn, negDir) < cosT - EPS) { st.angleCut++; return; }     // 世界法线角度筛选

        // —— Sutherland–Hodgman：盒局部对 x/y/z = ±1 共 6 平面裁剪，边界等于 ±1 算内部 ——
        let poly = [
          { p: bv[i0], b: [1,0,0] },
          { p: bv[i1], b: [0,1,0] },
          { p: bv[i2], b: [0,0,1] },
        ];
        for (let axis=0; axis<3 && poly.length; axis++) for (const sign of [1,-1]) {
          const inside = q => sign*q.p[axis] <= 1 + EPS;
          const out = [];
          for (let k=0; k<poly.length; k++) {
            const cur = poly[k], prv = poly[(k+poly.length-1)%poly.length];
            const ci = inside(cur), pj = inside(prv);
            if (ci) {
              if (!pj) out.push(lerpV(prv, cur, axis, sign));
              out.push(cur);
            } else if (pj) out.push(lerpV(prv, cur, axis, sign));
          }
          poly = out;
        }
        if (poly.length < 3) { st.clipCut++; return; }
        st.kept++;

        // —— 扇形三角化；交点同步插值来源三角形重心坐标 ——
        const src = [wv[i0], wv[i1], wv[i2]];
        for (let k=1; k+1<poly.length; k++) {
          const corners = [poly[0], poly[k], poly[k+1]];
          // 世界位置 = 重心坐标对源三角形世界顶点插值（仿射变换下与盒内插值等价）
          const rawPos = corners.map(c => [
            c.b[0]*src[0][0]+c.b[1]*src[1][0]+c.b[2]*src[2][0],
            c.b[0]*src[0][1]+c.b[1]*src[1][1]+c.b[2]*src[2][1],
            c.b[0]*src[0][2]+c.b[1]*src[1][2]+c.b[2]*src[2][2],
          ]);
          const area = 0.5*Math.hypot(...cross(sub(rawPos[1],rawPos[0]), sub(rawPos[2],rawPos[0])));
          if (area < MIN_AREA) { st.degen++; continue; }                 // 退化面丢弃（含贴边碎条）
          const uv = corners.map(c => [(c.p[0]+1)/2, (1-c.p[1])/2]);     // 交点UV：v 向下
          const pos = rawPos.map(p => [p[0]+wn[0]*worldOffset, p[1]+wn[1]*worldOffset, p[2]+wn[2]*worldOffset]); // 沿世界外法线偏移
          const rec = { projectorId: proj.id, instanceId: inst.id, meshId: mesh.id, sourceTriangle: ti,
                        positions: pos, positionsRaw: rawPos, uv,
                        bary: corners.map(c=>c.b.slice()), normal: wn.slice() };
          if (det < 0) { // 负行列式（镜像）实例：反转输出绕序以保持外表面朝向
            rec.positions.reverse(); rec.positionsRaw.reverse(); rec.uv.reverse(); rec.bary.reverse();
          }
          records.push(rec); st.out++;
        }
      });
    }
    stats.push(st);
  });
  return { records, stats };

  function lerpV(a, b, axis, sign) { // 边 a→b 与平面 sign*x=1 的交点，同步插值重心坐标
    const da = sign*a.p[axis]-1, db = sign*b.p[axis]-1;
    let t = da/(da-db); t = Math.min(1, Math.max(0, t));
    return {
      p: [0,1,2].map(i => a.p[i]+t*(b.p[i]-a.p[i])),
      b: [0,1,2].map(i => a.b[i]+t*(b.b[i]-a.b[i])),
    };
  }
}
