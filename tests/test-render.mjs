// 将渲染结果输出为 PPM(P6) 便于肉眼核对；另造大规模压测场景验证性能预算
import { writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { Engine } from '../src/engine.js';

function dumpPPM(engine, outPath) {
  const { width, height } = engine.model;
  const img = engine.result.image;
  const header = Buffer.from(`P6\n${width} ${height}\n255\n`);
  const body = Buffer.alloc(width * height * 3);
  for (let p = 0; p < width * height; p++) {
    body[p * 3] = img[p * 4]; body[p * 3 + 1] = img[p * 4 + 1]; body[p * 3 + 2] = img[p * 4 + 2];
  }
  writeFileSync(outPath, Buffer.concat([header, body]));
  console.log('wrote', outPath, `${width}x${height}`);
}

if (process.argv[2] === 'ppm') {
  for (const p of process.argv.slice(3)) {
    const scene = JSON.parse(readFileSync(p, 'utf8'));
    const engine = new Engine();
    const r = engine.load(scene);
    if (!r.ok) { console.log(r.errors); continue; }
    dumpPPM(engine, p.replace(/\.json$/, '') + '.ppm');
  }
}

// 压测：4000 三角形 + 16 镜面 + 4 层反射 + 320x240
function stressScene() {
  const mirrors = [];
  for (let i = 0; i < 16; i++) {
    const ang = (i / 16) * Math.PI * 2;
    const cx = Math.cos(ang) * 4, cz = Math.sin(ang) * 4 - 2;
    // 每面小镜子，朝向圆心
    const nx = -Math.cos(ang), nz = -Math.sin(ang);
    const tx = -Math.sin(ang), tz = Math.cos(ang);
    const s = 0.5;
    const base = [cx, 0.4, cz];
    const v = (du, dy) => [
      base[0] + tx * du * s + nx * 0,
      base[1] + dy,
      base[2] + tz * du * s,
    ];
    mirrors.push({
      id: 'M' + i, enabled: true,
      reflectance: [0.85 + 0.005 * i, 0.9, 0.92],
      vertices: [v(-1, 0), v(1, 0), v(1, 2.2), v(-1, 2.2)],
    });
  }
  const vertices = [];
  const triangles = [];
  let id = 0;
  const gridX = 50, gridY = 80; // 4000 个三角形
  for (let gx = 0; gx < gridX; gx++) {
    for (let gy = 0; gy < gridY; gy++) {
      const x = -6 + (gx / gridX) * 12;
      const y = (gy / gridY) * 3;
      const z = -8 - ((gx + gy) % 3);
      const s = 0.25;
      const o = vertices.length;
      vertices.push([x, y, z], [x + s, y, z], [x + s * 0.5, y + s, z]);
      triangles.push({ id: id++, indices: [o, o + 1, o + 2], color: [(gx % 13) / 13, 0.4, (gy % 11) / 11], singleSided: gx % 2 === 0 });
    }
  }
  return {
    sceneId: 'stress',
    camera: { eye: [0, 1.5, 6], target: [0, 1.5, -2], up: [0, 1, 0], fovYDeg: 90, near: 0.2, far: 80, width: 320, height: 240 },
    maxBounceDepth: 4, beamBudgetK: 32,
    mirrors, vertices, triangles,
  };
}

if (process.argv[2] === 'stress') {
  const scene = stressScene();
  console.log('triangles =', scene.triangles.length, 'mirrors =', scene.mirrors.length);
  const engine = new Engine();
  const t0 = Date.now();
  const r = engine.load(scene);
  const t1 = Date.now();
  if (!r.ok) { console.log(r.errors); process.exit(1); }
  console.log('总耗时 ms =', t1 - t0, engine.lastTiming);
  dumpPPM(engine, 'tests/out/stress.ppm');
  // 编辑单镜面后的重算耗时
  const edited = JSON.parse(JSON.stringify(scene));
  edited.mirrors[3].reflectance = [0.5, 0.5, 0.5];
  const t2 = Date.now();
  engine.applyEdit(edited, 'single-mirror');
  const t3 = Date.now();
  console.log('改单镜面重算 ms =', t3 - t2, engine.lastTiming);
}
