// rks.mjs — 供 Node / 验证脚本使用的 ESM 命名导出入口。
// 浏览器直接打开 index.html 走经典脚本（file:// 也可用），不依赖本文件。
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const fracNS = require('./js/frac.js');
const engineNS = require('./js/engine.js');
const tessNS = require('./js/tessellate.js');
const studioNS = require('./js/studio.js');

export const { Frac, gcd } = fracNS;
export const {
  INT_MAX_CP,
  parseCurveObject,
  curveToObject,
  cloneCurve,
  domain,
  findSpan,
  basisValue,
  evalHomogeneousSide,
  evalHomogeneousDerivativeSide,
  projectedPointExact,
  queryAt,
  insertKnot,
  removeKnotAt,
  interiorOccurrenceRange,
  knotMultiplicity,
  moveProjectedPoint,
  setWeight,
  setHomogeneousPoint,
  homogeneousPointsEqual,
  evalPointFloat,
} = engineNS;
export const { tessellate, buildExportSVG, measureSegments, distinctKnots } = tessNS;
export const { Studio } = studioNS;

export default {
  ...fracNS,
  ...engineNS,
  ...tessNS,
  ...studioNS,
};
