// 坐标、镜像与参考中心布局（严格按样例说明实现）。
//
// - 图块中心为整数像素，偏移 -p/2 .. p/2-1（p 为偶数 4/8）。
// - 越界镜像采用“不重复端点”的对称反射（reflect-101）：...3,2,1,0,1,2,3...
//   周期 2(L-1)，端点不重复。
// - 轴长 1 时任何坐标恒取 0。
// - 参考中心：0, s, 2s, ...（严格小于边长）并补最后一像素 L-1，去重后升序。

export function mirrorIndex(raw, length) {
  if (length <= 1) return 0;
  const period = 2 * (length - 1);
  let t = ((raw % period) + period) % period;
  // 归一化 -0，避免显示与比较时的符号噪声
  if (t === 0) return 0;
  return t < length ? t : period - t;
}

export function patchOffsets(p) {
  const out = new Int32Array(p);
  const start = -Math.floor(p / 2);
  for (let i = 0; i < p; i++) out[i] = start + i;
  return out;
}

export function referenceCenters(length, stride) {
  if (!Number.isInteger(length) || length < 1) throw new Error('轴长必须为正整数');
  if (!Number.isInteger(stride) || stride < 1) throw new Error('步长必须为正整数');
  const set = new Set();
  for (let v = 0; v < length; v += stride) set.add(v);
  set.add(length - 1);
  return [...set].sort((a, b) => a - b);
}

// 为每个可能的中心预计算 p 个采样坐标，避免匹配内层循环反复做镜像运算。
export function buildPatchIndexMap(length, offsets) {
  const p = offsets.length;
  const map = new Array(length);
  for (let c = 0; c < length; c++) {
    const row = new Int32Array(p);
    for (let i = 0; i < p; i++) row[i] = mirrorIndex(c + offsets[i], length);
    map[c] = row;
  }
  return map;
}

export function patchStart(center, p) {
  return center - Math.floor(p / 2);
}

// 一个图块在图像内的覆盖范围（可能越界，仅用于显示）。
export function patchRect(centerY, centerX, p) {
  const y0 = patchStart(centerY, p);
  const x0 = patchStart(centerX, p);
  return { x0, y0, x1: x0 + p - 1, y1: y0 + p - 1 };
}
