// optical-core.mjs — ESM 入口，转发 UMD/CJS 核心。
// 用法：import { renderStrips, gapsToCsv } from './optical-core.mjs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const core = require('./optical-core.js');

export const {
  SAMPLE_RATE, TICKS_PER_FRAME, MAX_SECONDS, MAX_FRAMES, MAX_STRIPS, MAX_ROWS,
  MAX_PIXELS, INT16_MIN, INT16_MAX,
  roundHalfEven, divRoundHalfEven, floorDivInt, clampInt16,
  extractChannel, analyzeChannel, decodeChannel,
  parseDataset, renderStrips, inspectFrame, getGaps, lowerBound, upperBound,
  pcmToFloatChannels, encodeWavPcm, gapsToCsv, gapsToJson,
} = core;

export default core;
