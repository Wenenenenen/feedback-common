/*
 * 系数 JSON 的导出与导入。
 *
 * 导出同时服务两种 kind：
 *   - radiance  ：环境辐亮度系数 C_i，单位 W/(m²·sr)
 *   - irradiance：经余弦卷积的辐照度系数 E_i，单位 W/m²
 * 两种文件名与 kind/units 字段都不同，数值也不相同（E_i = C_i·A_l）。
 *
 * 导入是严格校验的：
 *   - 必须给出可识别的基标识（basis.id 或 basisId），且必须与本页一致；
 *   - 必须给出 kind（radiance / irradiance），units 若存在必须匹配；
 *   - 必须给出 9 组 RGB，共 27 个有限数；
 *   - rotation 记录的是「已经烘焙进系数」的角度；导入时不再隐式应用，
 *     界面上从 0° 起，文件中的角度只作为出处的只读信息。
 */

import {
  BASIS_ID,
  BASIS_ALIASES,
  BASIS_FUNCTIONS,
  BASIS_AXES_NOTE,
  BASIS_NORMALIZATION,
  CHANNEL_NAMES,
  COEFFICIENT_COUNT,
  CONVOLUTION_FACTORS,
  KIND_UNITS,
  KIND_LABELS,
  SCHEMA_ID,
  SCHEMA_VERSION,
} from './constants.js';
import { convolve, deconvolve } from './sh.js';

export class CoefficientJsonError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CoefficientJsonError';
    this.code = code;
    this.details = details;
  }
}

/** Float64Array(27) → 9 组 [R,G,B]。 */
export function toNested(coefficients) {
  const out = [];
  for (let i = 0; i < COEFFICIENT_COUNT; i++) {
    out.push([
      coefficients[i * 3],
      coefficients[i * 3 + 1],
      coefficients[i * 3 + 2],
    ]);
  }
  return out;
}

/** 9 组 [R,G,B] → Float64Array(27)。 */
export function fromNested(nested) {
  const out = new Float64Array(COEFFICIENT_COUNT * 3);
  for (let i = 0; i < COEFFICIENT_COUNT; i++) {
    for (let k = 0; k < 3; k++) out[i * 3 + k] = nested[i][k];
  }
  return out;
}

const KNOWN_BASIS_IDS = new Set([BASIS_ID, ...BASIS_ALIASES]);

const UNIT_NORMALIZERS = {
  radiance: [
    'W/(m^2 sr)', 'W/(m^2·sr)', 'W/(m2 sr)', 'W/(m2*sr)', 'W/(m² sr)', 'W/(m²·sr)',
    'W/m^2/sr', 'W/m2/sr', 'W/m²/sr', 'w/(m^2 sr)', 'w/(m2 sr)',
  ],
  irradiance: [
    'W/m^2', 'W/m2', 'W/m²', 'W / m^2', 'W·m^-2', 'W m^-2', 'w/m2',
  ],
};

function normalizeUnit(raw) {
  return String(raw)
    .replace(/²/g, '2')
    .replace(/³/g, '3')
    .replace(/·/g, '*')
    .replace(/\s+/g, '')
    .replace(/²/g, '2');
}

function unitMatches(kind, raw) {
  if (raw === undefined || raw === null) return { ok: true, given: false };
  const norm = normalizeUnit(raw);
  const list = UNIT_NORMALIZERS[kind].map(normalizeUnit);
  return { ok: list.includes(norm), given: true, norm };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * @param {{kind:'radiance'|'irradiance', coefficients:Float64Array, rotationDeg:number,
 *          provenance?:object, extraNotes?:string[]}} params
 * @returns {object} 可直接 JSON.stringify 的对象
 */
export function buildCoefficientJson(params) {
  const {
    kind, coefficients, rotationDeg = 0, provenance = null, extraNotes = [],
  } = params;
  if (kind !== 'radiance' && kind !== 'irradiance') {
    throw new TypeError(`未知 kind：${kind}`);
  }
  if (coefficients.length !== COEFFICIENT_COUNT * 3) {
    throw new TypeError(`系数长度应为 ${COEFFICIENT_COUNT * 3}。`);
  }
  for (let i = 0; i < coefficients.length; i++) {
    if (!Number.isFinite(coefficients[i])) {
      throw new TypeError('系数含非有限值，拒绝导出。');
    }
  }
  const deg = Number(rotationDeg) || 0;

  const notes = [
    kind === 'radiance'
      ? `环境辐亮度系数 C_i = ∫ L(ω)·Y_i(ω) dω；单位 ${KIND_UNITS.radiance}。`
      : `辐照度系数 E_i = C_i·A_l（A_0=π，A_1=2π/3，A_2=π/4）；单位 ${KIND_UNITS.irradiance}。`,
    '系数为 9 组 RGB，基顺序见 basis.functions；用 E(n)=Σ E_i·Y_i(n) 重建。',
    `rotation.degrees = ${deg}° 已烘焙进本文件系数，导入端不得再次隐式旋转。`,
    ...extraNotes,
  ];

  return {
    schema: SCHEMA_ID,
    version: SCHEMA_VERSION,
    generator: 'irradiance-sh-baker 1.0',
    basis: {
      id: BASIS_ID,
      order: 3,
      bands: COEFFICIENT_COUNT,
      channelOrder: CHANNEL_NAMES.join(''),
      normalization: BASIS_NORMALIZATION,
      axes: BASIS_AXES_NOTE,
      functions: BASIS_FUNCTIONS.slice(),
    },
    kind,
    units: KIND_UNITS[kind],
    definition: kind === 'radiance'
      ? 'C_i = ∫ L(ω)·Y_i(ω) dω'
      : 'E_i = ∫ L(ω)·Y_i(ω) dω · A_l',
    convolutionFactors: CONVOLUTION_FACTORS.slice(),
    rotation: {
      axis: 'y',
      degrees: deg,
      bakedIntoCoefficients: true,
      convention: '绕 +y 右手系正旋转；+90° 时 +x → −z；Lr(n) = L(R⁻¹n)。',
    },
    coefficients: toNested(coefficients),
    ...(provenance ? { provenance } : {}),
    notes,
  };
}

function parseCoefficientsField(raw) {
  let nested = null;
  if (Array.isArray(raw)) {
    if (raw.length === COEFFICIENT_COUNT) {
      nested = raw;
    } else if (raw.length === COEFFICIENT_COUNT * 3 && raw.every((v) => typeof v === 'number')) {
      nested = [];
      for (let i = 0; i < COEFFICIENT_COUNT; i++) nested.push(raw.slice(i * 3, i * 3 + 3));
    } else {
      throw new CoefficientJsonError(
        'COEF_SHAPE',
        `coefficients 应为 9 组 [R,G,B]（或 27 个数的平铺数组），实际长度 ${raw.length}。`,
        { length: raw.length },
      );
    }
  } else {
    throw new CoefficientJsonError('COEF_SHAPE', 'coefficients 缺失或不是数组。');
  }

  const flat = new Float64Array(COEFFICIENT_COUNT * 3);
  for (let i = 0; i < COEFFICIENT_COUNT; i++) {
    const band = nested[i];
    if (!Array.isArray(band) || band.length !== 3) {
      throw new CoefficientJsonError(
        'COEF_SHAPE',
        `第 ${i} 组系数应为 3 个数（RGB），实际为 ${Array.isArray(band) ? `${band.length} 个数` : typeof band}。`,
        { band: i },
      );
    }
    for (let k = 0; k < 3; k++) {
      const v = band[k];
      if (typeof v !== 'number') {
        throw new CoefficientJsonError(
          'COEF_SHAPE',
          `第 ${i} 组 ${CHANNEL_NAMES[k]} 通道不是数字（${typeof v}）。`,
          { band: i, channel: CHANNEL_NAMES[k] },
        );
      }
      if (!Number.isFinite(v)) {
        throw new CoefficientJsonError(
          'COEF_NONFINITE',
          `第 ${i} 组 ${CHANNEL_NAMES[k]} 通道为非有限值（${String(v)}）。`,
          { band: i, channel: CHANNEL_NAMES[k], value: String(v) },
        );
      }
      flat[i * 3 + k] = v;
    }
  }
  return flat;
}

/**
 * 解析导入的系数 JSON。
 * @param {string} text
 * @returns {{
 *   kind:'radiance'|'irradiance',
 *   coefficients:Float64Array, // 原样（kind 对应的单位），未旋转
 *   radiance:Float64Array,     // 内部表示：辐亮度系数（irradiance 输入会反卷积）
 *   irradiance:Float64Array,   // 内部表示：辐照度系数
 *   rotationDeg:number,        // 文件记录的已烘焙角度
 *   units:string, warnings:string[],
 *   provenance:object|null, notes:string[]
 * }}
 */
export function parseCoefficientJson(text) {
  if (typeof text !== 'string') {
    throw new CoefficientJsonError('COEF_JSON_PARSE', '导入内容不是文本。');
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new CoefficientJsonError(
      'COEF_JSON_PARSE',
      `JSON 语法错误：${err.message}`,
      { raw: text.slice(0, 120) },
    );
  }
  if (!isPlainObject(data)) {
    throw new CoefficientJsonError('COEF_JSON_PARSE', 'JSON 顶层应为对象。');
  }

  // 1) 基标识
  let basisId = null;
  if (isPlainObject(data.basis)) basisId = data.basis.id;
  else if (typeof data.basis === 'string') basisId = data.basis;
  if (basisId === undefined || basisId === null) basisId = data.basisId;
  if (typeof basisId !== 'string' || basisId.trim() === '') {
    throw new CoefficientJsonError(
      'COEF_BASIS_MISSING',
      '缺少基标识：需要 basis.id（或 basisId），值应为 "irradiance-sh-baker.real-sh-acn-l2-yup"。',
    );
  }
  if (!KNOWN_BASIS_IDS.has(basisId.trim())) {
    throw new CoefficientJsonError(
      'COEF_BASIS_MISMATCH',
      `基标识不匹配：文件为 “${basisId}”，本页只接受 “${BASIS_ID}”。`,
      { got: basisId, want: BASIS_ID },
    );
  }
  if (isPlainObject(data.basis)) {
    if (data.basis.bands !== undefined && Number(data.basis.bands) !== COEFFICIENT_COUNT) {
      throw new CoefficientJsonError(
        'COEF_BASIS_MISMATCH',
        `basis.bands 应为 ${COEFFICIENT_COUNT}，实际 ${data.basis.bands}。`,
      );
    }
    if (data.basis.order !== undefined && Number(data.basis.order) !== 3) {
      throw new CoefficientJsonError('COEF_BASIS_MISMATCH', `basis.order 应为 3，实际 ${data.basis.order}。`);
    }
    if (data.basis.channelOrder !== undefined
      && String(data.basis.channelOrder).toUpperCase() !== CHANNEL_NAMES.join('')) {
      throw new CoefficientJsonError(
        'COEF_BASIS_MISMATCH',
        `basis.channelOrder 应为 RGB，实际 ${data.basis.channelOrder}。`,
      );
    }
    if (Array.isArray(data.basis.functions)) {
      const same = data.basis.functions.length === BASIS_FUNCTIONS.length
        && data.basis.functions.every((f, i) => String(f).replace(/\s+/g, '') === BASIS_FUNCTIONS[i]);
      if (!same) {
        throw new CoefficientJsonError(
          'COEF_BASIS_MISMATCH',
          'basis.functions 与包内约定不一致；拒绝按未知基积分。',
          { got: data.basis.functions, want: BASIS_FUNCTIONS },
        );
      }
    }
  }

  // 2) kind
  const kind = data.kind;
  if (kind !== 'radiance' && kind !== 'irradiance') {
    throw new CoefficientJsonError(
      'COEF_KIND',
      `kind 缺失或无法识别：需要 "radiance"（辐亮度）或 "irradiance"（辐照度），实际 ${
        kind === undefined ? '缺失' : JSON.stringify(kind)
      }。`,
      { kind },
    );
  }

  // 3) 单位
  const units = unitMatches(kind, data.units);
  if (!units.ok) {
    throw new CoefficientJsonError(
      'COEF_UNITS',
      `units 与 kind 不符：${KIND_LABELS[kind]} 应为 ${KIND_UNITS[kind]}，文件写的是 “${data.units}”。`,
      { got: String(data.units), want: KIND_UNITS[kind] },
    );
  }

  // 4) 系数
  const raw = data.coefficients ?? data.C ?? data.E;
  if (raw === undefined) {
    throw new CoefficientJsonError('COEF_SHAPE', '缺少 coefficients（9 组 RGB）。');
  }
  const values = parseCoefficientsField(raw);

  // 5) 旋转：只读记录，不再应用
  const warnings = [];
  let rotationDeg = 0;
  const rot = data.rotation;
  const rotRaw = isPlainObject(rot) ? rot.degrees : (rot ?? data.rotationDeg);
  if (rotRaw !== undefined && rotRaw !== null) {
    const deg = Number(rotRaw);
    if (!Number.isFinite(deg)) {
      throw new CoefficientJsonError(
        'COEF_ROTATION',
        `rotation 角度无效：${JSON.stringify(rotRaw)}，应为有限数。`,
      );
    }
    rotationDeg = deg;
    if (isPlainObject(rot) && rot.axis !== undefined && String(rot.axis).toLowerCase() !== 'y') {
      throw new CoefficientJsonError(
        'COEF_ROTATION',
        `rotation.axis 应为 y，实际 ${JSON.stringify(rot.axis)}；本页只支持绕 y 轴。`,
      );
    }
    if (isPlainObject(rot) && rot.bakedIntoCoefficients === false) {
      throw new CoefficientJsonError(
        'COEF_ROTATION',
        '文件声明 rotation.bakedIntoCoefficients=false：本页只接受已烘焙角度的系数，不做隐式旋转。',
      );
    }
  } else {
    warnings.push('文件未记录旋转角，按 0°（未旋转）当作已烘焙角度。');
  }
  if (units.given === false) {
    warnings.push(`文件未写 units，已按 kind=${kind} 采用 ${KIND_UNITS[kind]}。`);
  }

  let radianceCoefficients;
  let irradianceCoefficients;
  if (kind === 'radiance') {
    radianceCoefficients = Float64Array.from(values);
    irradianceCoefficients = convolve(values);
  } else {
    irradianceCoefficients = Float64Array.from(values);
    radianceCoefficients = deconvolve(values);
    for (let i = 0; i < radianceCoefficients.length; i++) {
      if (!Number.isFinite(radianceCoefficients[i])) {
        throw new CoefficientJsonError('COEF_NONFINITE', '辐照度系数反卷积后出现非有限值。');
      }
    }
  }

  const notes = Array.isArray(data.notes) ? data.notes.map(String) : [];

  return {
    kind,
    coefficients: values,
    radiance: radianceCoefficients,
    irradiance: irradianceCoefficients,
    rotationDeg,
    units: KIND_UNITS[kind],
    warnings,
    provenance: isPlainObject(data.provenance) ? data.provenance : null,
    notes,
  };
}

/** 导出文件名：把 kind 与旋转角写进名字，避免两种系数混淆。 */
export function coefficientFileName(kind, rotationDeg, extension = 'json') {
  const kindName = kind === 'radiance' ? 'radiance-C' : 'irradiance-E';
  const deg = Number.isFinite(rotationDeg) ? rotationDeg : 0;
  const rounded = Math.round(deg * 1000) / 1000;
  const sign = rounded < 0 ? 'm' : '';
  const angle = `rotY_${sign}${String(Math.abs(rounded)).replace('.', 'p')}deg`;
  return `${kindName}_${angle}.${extension}`;
}
