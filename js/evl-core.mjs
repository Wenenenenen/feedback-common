// Node ESM 便利入口：`import { parseEVL, computeAll } from './js/evl-core.mjs'`
// 浏览器页面不引用本文件（页面使用经典脚本 evl-core.js + window.EVLCore）。
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const C = require('./evl-core.js');

export const {
  LIMITS,
  EVLFormatError,
  parseEVL,
  clampedIntegral,
  expLinIntegral,
  buildPixelRuns,
  integralRange,
  computeAll,
  computeAllAsync,
  computePixelInto,
  encodeLUM1,
  encodeLUM1Planar,
  zipStore,
  crc32,
  validateWindows,
} = C;
export default C;
