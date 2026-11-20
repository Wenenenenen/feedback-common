// 导出：保持原拓扑的 OBJ 与含逐点旋转/约束/迭代记录的诊断 JSON。

// OBJ：保持原顶点顺序与三角形索引（OBJ 索引从 1 开始），仅替换位置。
export function buildOBJ(rest, triangles, vertices) {
  const lines = ['# ARAP handle deformation export'];
  for (let i = 0; i < rest.length; i++) {
    const v = vertices[i];
    lines.push(`v ${fmt(v[0])} ${fmt(v[1])} ${fmt(v[2])}`);
  }
  for (const [a, b, c] of triangles) {
    lines.push(`f ${a + 1} ${b + 1} ${c + 1}`);
  }
  return lines.join('\n') + '\n';
}

function fmt(x) {
  // 足够精度且去掉无意义尾零
  if (!Number.isFinite(x)) return '0';
  return String(Number(x.toPrecision(10)));
}

// 诊断 JSON：rest、vertices、triangles、constraints、rotations、energies、iterations、stop_reason
export function buildDiagnostic(solver) {
  return {
    rest: solver.data.rest.map((p) => p.slice()),
    vertices: solver.x.map((p) => p.slice()),
    triangles: solver.data.triangles.map((t) => t.slice()),
    constraints: solver.constraints.map((c) => ({
      vertex: c.vertex,
      target: c.target.slice(),
    })),
    // 逐点行主序 3x3 旋转
    rotations: solver.rotations.map((R) => R.slice()),
    energies: solver.energies.slice(),
    iterations: solver.iterations,
    stop_reason: solver.stopReason,
  };
}

// 浏览器端触发下载（在用户点击事件中调用，避免被拦截）
export function downloadText(filename, text, mime = 'text/plain') {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
