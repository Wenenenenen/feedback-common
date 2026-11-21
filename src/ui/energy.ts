/** 逐块能量带的数据结构与计算。 */

import { blockMeanSquare } from '../core/nlms';

export interface BlockEnergy {
  /** 每块覆盖的帧数。 */
  windowFrames: number;
  blocks: number;
  microphone: Float64Array;
  residual: Float64Array;
  echo: Float64Array;
}

export function computeBlockEnergy(
  totalFrames: number,
  processedFrames: number,
  microphone: Float64Array,
  echo: Float64Array,
  residual: Float64Array,
  targetBlocks = 480,
): BlockEnergy {
  const windowFrames = Math.max(1, Math.ceil(totalFrames / targetBlocks));
  const blocks = Math.ceil(totalFrames / windowFrames);
  return {
    windowFrames,
    blocks,
    microphone: blockMeanSquare(microphone, processedFrames, windowFrames, blocks),
    residual: blockMeanSquare(residual, processedFrames, windowFrames, blocks),
    echo: blockMeanSquare(echo, processedFrames, windowFrames, blocks),
  };
}
