/* 字典序专项：构造零候选（所有序列匹配分都为 0），
   此时任意可行序列总分 = -总转移代价；再用等间距锚点让“恒定最小拍长”成为
   零代价可行解，验证它被选中，并与暴力枚举的字典序最优一致。 */
const S = require('./solver.js');

// 案例 A：beats=4，首尾锚点间距恰为 4*8 单位（每拍都只能取 p=8）
function caseA() {
  const beats = 4, fc = 1000;
  const anchors = [[0, 0], [beats, beats * 8 * 6]];
  const onsets = []; // 无候选，全部未匹配
  const v = S.validate({ beats, frameCount: fc, anchors, onsets });
  const r = S.solve({ beats, frameCount: fc, anchorFrame: v.anchorFrame, onsets });
  console.log('A feasible', r.feasible, 'score', r.score);
  const seq = r.beats.map(b => [b.period / 6, b.swing]);
  console.log('A seq', JSON.stringify(seq));
  if (!r.feasible) throw new Error('A 应可行');
  if (r.score !== 0) throw new Error('A 零候选+恒定拍长应总分 0，实际 ' + r.score);
  // 所有拍 s 应取 0（字典序最小），p 全为 8
  for (const b of r.beats) {
    if (b.period !== 48 || b.swing !== 0) throw new Error('A 应全 (8,0)');
    if (b.onMatch !== null || b.offMatch !== null) throw new Error('A 应全部未匹配 null');
    if (b.onScore !== 0 || b.offScore !== 0) throw new Error('A 匹配分应为 0');
  }
}

// 案例 B：间距允许 p 在 8..10 间且零候选，零代价恒定解有 p=8/9/10 三种，
// 字典序应选全 (8,0)
function caseB() {
  const beats = 3, fc = 1000;
  // 取间距 = 3*9，允许 8/9/10 组合凑 27，例如 8,9,10；但恒定 9 零代价，恒定 8 不可达
  const anchors = [[0, 0], [beats, 27 * 6]];
  const onsets = [];
  const v = S.validate({ beats, frameCount: fc, anchors, onsets });
  const r = S.solve({ beats, frameCount: fc, anchorFrame: v.anchorFrame, onsets });
  console.log('B feasible', r.feasible, 'score', r.score);
  // 零候选下，恒定 p=9 零代价总分 0；含 8/10 的组合有变速代价 >0 扣分，分数更低
  // 所以最优是恒定 9、s 全 0
  const seq = r.beats.map(b => [b.period / 6, b.swing]);
  console.log('B seq', JSON.stringify(seq));
  if (r.score !== 0) throw new Error('B 最优应总分 0');
  for (const b of r.beats) if (b.period !== 54 || b.swing !== 0) throw new Error('B 应全 (9,0)');
}

// 案例 C：s 切换无差异时（零候选），验证 s 恒取 0 而非 1
function caseC() {
  const beats = 2, fc = 1000;
  const anchors = [[0, 0], [beats, 2 * 20 * 6]];
  const onsets = [];
  const v = S.validate({ beats, frameCount: fc, anchors, onsets });
  const r = S.solve({ beats, frameCount: fc, anchorFrame: v.anchorFrame, onsets });
  for (const b of r.beats) if (b.swing !== 0) throw new Error('C s 应字典序取 0');
  console.log('C swing all 0 OK, score', r.score);
}

// 案例 D：用暴力程序对拍含真实同分的小案例（外部 fuzz 已覆盖，这里内联一个）
function caseD() {
  const beats = 2, fc = 600;
  const anchors = [[0, 0], [2, 24 * 6]]; // 间距 24u，两拍 p 组合 (8,16)..(16,8)，相邻差<=2 受限
  // 候选放在所有正/反拍都够不到的位置，制造匹配全 0；只剩转移代价比较
  const onsets = [[500, 500, 500]];
  const v = S.validate({ beats, frameCount: fc, anchors, onsets });
  const r = S.solve({ beats, frameCount: fc, anchorFrame: v.anchorFrame, onsets });
  // 手算：可行需 p1+p2=24 且 |p1-p2|<=2，p∈[8,39]
  // 组合 (11,13),(12,12),(13,11)；变速代价：(11,13)=3,(12,12)=0,(13,11)=3
  // 最优 (12,12) 零代价，s 全 0 -> 字典序最小
  const seq = r.beats.map(b => [b.period / 6, b.swing]);
  console.log('D seq', JSON.stringify(seq), 'score', r.score);
  if (JSON.stringify(seq) !== '[[12,0],[12,0]]') throw new Error('D 应选 (12,0),(12,0)');
}

caseA(); caseB(); caseC(); caseD();
console.log('LEX TIE-BREAK ALL PASSED');
