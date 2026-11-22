/* 用 samples/lantern-stack-duel.json 校验引擎：主线动作 + cancelCase 变体。 */
const fs = require('fs');
const path = require('path');
const E = require(path.join(__dirname, 'game.js'));

const sample = JSON.parse(fs.readFileSync(path.join(__dirname, 'samples', 'lantern-stack-duel.json'), 'utf8'));

function run(cfg, actions) {
  const st = E.newGame(cfg);
  for (const a of actions) {
    const err = E.applyAction(st, a);
    if (err) throw new Error(`动作 ${JSON.stringify(a)} 被拒绝：${err}`);
  }
  return st;
}

function report(name, rows) {
  let bad = 0;
  for (const r of rows) {
    if (!r.ok) bad++;
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.label}\t期望: ${r.want}\t实际: ${r.got}`);
  }
  console.log(`${name}: ${bad === 0 ? '全部通过' : bad + ' 项不符'}\n`);
  return bad === 0;
}

const cfg = { active: sample.active, lamps: sample.lamps, energy: sample.energy, hands: sample.hands };

let ok = true;

// 主线
const st1 = run(cfg, sample.actions);
console.log('主线结算序列:', st1.resolution.join(' → '));
ok &= report('主线', E.compareExpected(st1, sample.expected));

// cancelCase 变体
const cc = sample.cancelCase;
const actions2 = sample.actions.slice(0, cc.takeActions);
actions2[cc.replaceAction.index] = cc.replaceAction.action;
const st2 = run(cfg, actions2);
console.log('变体结算序列:', st2.resolution.join(' → '));
ok &= report('cancelCase 变体', E.compareExpected(st2, {
  resolution: cc.expectedResolution,
  score: cc.expectedScore,
}));

// 导出-重放一致性：导出的记录重放后应与原状态一致
const rec = E.exportRecord(st1);
const st3 = run(rec, rec.actions);
ok &= report('导出重放一致性', E.compareExpected(st3, rec.expected));

process.exit(ok ? 0 : 1);
