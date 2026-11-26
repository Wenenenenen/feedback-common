// 最小手工例：3x3，全相同指纹，gapOpen=9, gapExtend=2, 阈值 4
// 全 m 路径费用 0，应为最优
import { parseFingerprints, align, hamming } from '../web/algo.js';

const z = '0000000000000000';
const A = parseFingerprints([z, z, z], 'A');
const B = parseFingerprints([z, z, z], 'B');
const r = align(A, B, { maxDistance: 4, gapOpen: 9, gapExtend: 2 }, []);
console.log(JSON.stringify(r, null, 1));

// 再试 3 主版 / 4 交付，B 多一个冻结帧 -> 一个 extra 段 9+2=11
const B2 = parseFingerprints([z, z, z, z], 'B2');
const r2 = align(A, B2, { maxDistance: 4, gapOpen: 9, gapExtend: 2 }, []);
console.log('3v4:', r2.steps.map((s) => s.t).join(''), 'fee', r2.totalFee, 'seg', r2.gapSegments);

// 4 主版 / 3 交付 -> missing
const A4 = parseFingerprints([z, z, z, z], 'A4');
const r3 = align(A4, B, { maxDistance: 4, gapOpen: 9, gapExtend: 2 }, []);
console.log('4v3:', r3.steps.map((s) => s.t).join(''), 'fee', r3.totalFee, 'seg', r3.gapSegments);
void hamming;
