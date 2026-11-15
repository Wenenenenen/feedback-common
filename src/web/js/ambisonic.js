/*
 * 一阶 B-format 的格式定义与通道换算。
 *
 * 依据 samples 包内的 conventions.json：
 *   AmbiX (ACN / SN3D)：文件通道顺序 W Y Z X
 *   FuMa            ：文件通道顺序 W X Y Z，且 W 为 AmbiX 的 √2 倍
 * 因此统一先换到「规范序」[W, Y, Z, X]（即 AmbiX 的 ACN 顺序与 SN3D 缩放），
 * 旋转只在规范序的 X/Y/Z 上进行，再换回用户选择的输出格式。
 */

export const SQRT2 = Math.SQRT2;

export const FORMAT_SPECS = {
  ambix: {
    id: 'ambix',
    label: 'AmbiX · ACN / SN3D',
    order: ['W', 'Y', 'Z', 'X'],
    wGainToCanonical: 1,
    note: '通道序 W Y Z X，W 不缩放。',
  },
  fuma: {
    id: 'fuma',
    label: 'FuMa · W √2',
    order: ['W', 'X', 'Y', 'Z'],
    wGainToCanonical: SQRT2,
    note: '通道序 W X Y Z；转到 AmbiX 时 W 乘 √2，XYZ 仅重排。',
  },
};

export function formatSpec(id) {
  const spec = FORMAT_SPECS[id];
  if (!spec) throw new Error(`未知格式：${id}`);
  return spec;
}

/** 文件通道下标 → 规范序数组下标的映射（规范序 = W,Y,Z,X）。 */
export function canonicalIndexMap(formatId) {
  if (formatId === 'ambix') {
    return { W: 0, Y: 1, Z: 2, X: 3 };
  }
  if (formatId === 'fuma') {
    return { W: 0, X: 1, Y: 2, Z: 3 };
  }
  throw new Error(`未知格式：${formatId}`);
}

/** 规范序 [W,Y,Z,X] 中每个分量的下标。 */
const CANON_INDEX = { W: 0, Y: 1, Z: 2, X: 3 };
const KEYS = ['W', 'Y', 'Z', 'X'];

/**
 * 4×4 换算矩阵（作用在列向量），把输入格式的文件通道映射为输出格式的文件通道。
 * 这一部分只含格式换算（重排 + W 的 √2），不含旋转，用于界面展示。
 * 行 = 输出格式通道，列 = 输入格式通道。
 * @param {'ambix'|'fuma'} inputFormat
 * @param {'ambix'|'fuma'} outputFormat
 * @returns {number[]} 16 个数字，行主序
 */
export function conversionMatrix(inputFormat, outputFormat) {
  const inMap = canonicalIndexMap(inputFormat);
  const outMap = canonicalIndexMap(outputFormat);
  // D：输入文件通道 → 规范序
  const D = new Array(16).fill(0);
  for (const key of KEYS) {
    const gain = key === 'W' ? FORMAT_SPECS[inputFormat].wGainToCanonical : 1;
    D[CANON_INDEX[key] * 4 + inMap[key]] = gain;
  }
  // C：规范序 → 输出文件通道
  const C = new Array(16).fill(0);
  for (const key of KEYS) {
    const gain = key === 'W' && outputFormat === 'fuma' ? 1 / SQRT2 : 1;
    C[outMap[key] * 4 + CANON_INDEX[key]] = gain;
  }
  // M = C · D
  const M = new Array(16).fill(0);
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += C[r * 4 + k] * D[k * 4 + c];
      M[r * 4 + c] = sum;
    }
  }
  return M;
}
