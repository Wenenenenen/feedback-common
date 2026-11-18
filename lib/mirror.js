// 镜像取样工具：按样例约定，下标 -1 取 1，下标 w 取 w-2（行列相同），
// 即关于边界像素中心对称反射，反射后落在同色位置，CFA 排列保持不变。
// 对深度 1、2 的邻域（本项目所有插值最多用到 ±2）直接给出闭式映射，
// 避免依赖运行时是否提供反射式 pad。

export function mirrorIndex(i, n) {
  if (i < 0) {
    // -1 -> 1, -2 -> 2, -3 -> 3 ...（-n 时为 n，会越界，实际不会出现）
    return -i;
  }
  if (i >= n) {
    // n -> n-2, n+1 -> n-3 ...
    return 2 * n - i - 2;
  }
  return i;
}

export function mirrorGetter(arr, width, height) {
  return (x, y) => arr[mirrorIndex(y, height) * width + mirrorIndex(x, width)];
}
