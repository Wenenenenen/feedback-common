// 验收用的三面算例（与流水线日志中的难点用例同构）
export function acceptanceCase(over = {}) {
  const W = 8, H = 4;
  const amp = [], p0 = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    amp.push(((3 * x + y) % 9) / 8);
    p0.push(((5 * x + 3 * y + 1) % 19) / 19);
  }
  const planes = [];
  for (let j = 0; j < 3; j++) {
    const target = [], weight = [];
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      target.push(((x + 2 * y + j) % 7) / 7);
      weight.push((x + y + j) % 3 === 0 ? 0 : 1);
    }
    planes.push({
      wave: j === 0 ? 0 : 1,
      z: [0.13, 0.0, 0.7][j],
      target, weight,
    });
  }
  return {
    W, H, dx: 0.23, dy: 0.41,
    waves: [{ lambda: 0.64, cycles: 1.15 }, { lambda: 0.55, cycles: 0.7 }],
    amp, p0, locks: [[7, 1, 201]], planes,
    eta: 1.0, steps: 2,
    ...over,
  };
}

// 满规模：256×256、2 波长、6 面
export function fullCase(steps = 12) {
  const W = 256, H = 256;
  const n = W * H;
  let s = 7;
  const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const amp = new Array(n), p0 = new Array(n);
  for (let i = 0; i < n; i++) { amp[i] = Math.round(rnd() * 1000) / 1000; p0[i] = Math.round(rnd() * 1000) / 1000; }
  const planes = [];
  for (let j = 0; j < 6; j++) {
    const target = new Array(n), weight = new Array(n);
    for (let i = 0; i < n; i++) { target[i] = 0.5; weight[i] = 1; }
    planes.push({ wave: j % 2, z: (j + 1) * 3, target, weight });
  }
  return {
    W, H, dx: 0.5, dy: 0.5,
    waves: [{ lambda: 0.5, cycles: 1.0 }, { lambda: 0.6, cycles: 1.2 }],
    amp, p0, locks: [[2, 2, 128]], planes, eta: 0.1, steps,
  };
}
