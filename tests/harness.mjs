// 零依赖测试框架
let passed = 0;
let failed = 0;
const failures = [];
let currentGroup = '';

export function group(name, fn) {
  currentGroup = name;
  fn();
}

export function ok(cond, msg) {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(`[${currentGroup}] ${msg}`);
    console.error(`  ✗ ${msg}`);
  }
}

export function eq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(a === e, `${msg}（期望 ${e}，实际 ${a}）`);
}

export function throws(fn, fragment, msg) {
  let threw = null;
  try {
    fn();
  } catch (e) {
    threw = e;
  }
  ok(threw !== null, `${msg}：应抛错`);
  if (threw) {
    ok(
      String(threw.message).includes(fragment) || String(threw.toString?.() ?? threw).includes(fragment),
      `${msg}：错误信息应包含 ${JSON.stringify(fragment)}，实际「${threw.message}」`,
    );
  }
}

export function noThrow(fn, msg) {
  try {
    fn();
    ok(true, msg);
  } catch (e) {
    ok(false, `${msg}：意外抛错 ${e.message}`);
  }
}

export function summary() {
  console.log(`\n${failed === 0 ? '✅' : '❌'} 通过 ${passed} 项，失败 ${failed} 项`);
  if (failed > 0) {
    process.exitCode = 1;
  }
  return failed === 0;
}
