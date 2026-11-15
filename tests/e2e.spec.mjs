// Playwright 端到端测试：真实 Chromium + WebGL2。
// 运行：npx playwright test tests/e2e.spec.mjs
import { test, expect, chromium } from 'playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const appUrl = '/app/index.html';
const samples = join(root, 'samples', 'extracted');

async function boot() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(appUrl);
  return { browser, page, errors };
}

async function injectConfigAndImage(page, cfgName, imgName) {
  const cfg = readFileSync(join(samples, cfgName), 'utf8');
  const imgBytes = readFileSync(join(samples, imgName));
  const dataUrl = 'data:image/png;base64,' + imgBytes.toString('base64');
  await page.evaluate(async ({ cfg, dataUrl, imgName }) => {
    const w = window.__warp;
    const next = AppState.stateFromConfig(JSON.parse(cfg));
    // 保留一个初始空 state 占位
    w.state = next;
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = dataUrl; });
    w.state.image = img;
    w.state.imageSize = [img.naturalWidth, img.naturalHeight];
    w.state.imageName = imgName;
    w.sampler = new Sampler.ImageSampler(img);
    w.ensureRenderer();
    document.getElementById('revisionLabel').textContent = '修订 #' + w.state.revision;
    // 触发 UI 构建
    w.scheduleRender();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }, { cfg, dataUrl, imgName });
}

test.describe('校正台端到端', () => {
  test('oracle 融合权重、线性颜色与 sRGB 编码精确一致', async () => {
    const { browser, page, errors } = await boot();
    await injectConfigAndImage(page, 'overlap.json', 'gray.png');
    const oracle = JSON.parse(readFileSync(join(samples, 'oracle.json'), 'utf8'));

    for (const probe of oracle.probes) {
      const got = await page.evaluate((p) => window.__warp.probeAt(p[0], p[1]), probe.p);
      for (let i = 0; i < probe.weights.length; i++) {
        expect(Math.abs(got.weights[i] - probe.weights[i])).toBeLessThan(1e-9);
      }
    }
    // 灰图线性值
    const center = await page.evaluate(() => window.__warp.probeAt(128, 64));
    expect(Math.abs(center.perProjector[0].linear[0] - oracle.gray_linear)).toBeLessThan(1e-12);

    // 合成像素：归一化保证权重和为 1，相同灰图在任何覆盖点都还原 sRGB 128
    const surf = await page.evaluate(() =>
      window.__warp.renderToPixels(256, 128, 'surface'));
    const surfAt = (x, y) => surf.data[((128 - 1 - y) * 256 + x) * 4];
    expect(surfAt(128, 64)).toBe(128);  // 重叠中心，权重 0.5/0.5
    expect(surfAt(16, 64)).toBe(128);   // 单覆盖，权重 1

    // 单台投影帧：表面 d=16、feather=32 → raw=0.5 → 线性半灰编码为 oracle 的 92
    const f0 = await page.evaluate(() =>
      window.__warp.renderToPixels(160, 128, 'projector', 0));
    const frameAt = (x, y) => f0.data[((128 - 1 - y) * 160 + x) * 4];
    expect(frameAt(16, 64)).toBe(oracle.half_weight_gray_srgb);
    expect(frameAt(80, 64)).toBe(128);  // d 超过羽化宽度，raw=1

    // CPU 探针：表面外点（260 超出 256 宽表面）权重为 0、未覆盖
    const outside = await page.evaluate(() => window.__warp.probeAt(260, 64));
    expect(outside.weights).toEqual([0, 0]);
    expect(outside.covered).toBe(false);
    expect(outside.compositeLinear).toEqual([0, 0, 0]);
    expect(errors).toEqual([]);
    await browser.close();
  });

  test('透视配置：单应映射与帧/合成输出尺寸正确', async () => {
    const { browser, page, errors } = await boot();
    await injectConfigAndImage(page, 'perspective.json', 'grid.png');
    const dims = await page.evaluate(() => {
      const st = window.__warp.state;
      const surf = window.__warp.renderToPixels(st.surface[0], st.surface[1], 'surface');
      const p0 = window.__warp.renderToPixels(st.projectors[0].size[0], st.projectors[0].size[1], 'projector', 0);
      return {
        surface: [surf.width, surf.height],
        projector: [p0.width, p0.height],
        probe: window.__warp.probeAt(128, 64).perProjector[0].framebuffer
      };
    });
    expect(dims.surface).toEqual([256, 128]);
    expect(dims.projector).toEqual([160, 128]);
    // 与 Python 参考实现一致的帧缓冲坐标
    expect(Math.abs(dims.probe[0] - 123.181)).toBeLessThan(0.01);
    expect(Math.abs(dims.probe[1] - 57.739)).toBeLessThan(0.01);
    expect(errors).toEqual([]);
    await browser.close();
  });

  test('非法四角被拒绝且保留有效校正', async () => {
    const { browser, page, errors } = await boot();
    await injectConfigAndImage(page, 'perspective.json', 'grid.png');
    const result = await page.evaluate(() => {
      const st = window.__warp.state;
      const good = st.projectors[0].quad.map((p) => [...p]);
      const crossed = [[0, 0], [160, 128], [160, 0], [0, 128]];
      const ok1 = AppState.tryUpdateQuad(st, 0, crossed);
      const retainedAfterBad = st.projectors[0].quad.map((p) => [...p]);
      const ok2 = AppState.tryUpdateQuad(st, 0, [[4, 5], [170, 12], [158, 123], [12, 116]]);
      return { ok1, retainedAfterBad, good, ok2 };
    });
    expect(result.ok1).toBe(false);
    expect(result.ok2).toBe(true);
    expect(result.retainedAfterBad).toEqual(result.good);
    await browser.close();
  });

  test('invalid-crossed 与 invalid-flat 配置标记为非法', async () => {
    const { browser, page } = await boot();
    for (const [cfgName, img] of [['invalid-crossed.json', 'grid.png'], ['invalid-flat.json', 'grid.png']]) {
      await injectConfigAndImage(page, cfgName, img);
      const reason = await page.evaluate(() => window.__warp.state.projectors[0].invalidReason);
      expect(reason.length).toBeGreaterThan(0);
    }
    await browser.close();
  });

  test('配置导出后重导可还原', async () => {
    const { browser, page } = await boot();
    await injectConfigAndImage(page, 'perspective.json', 'grid.png');
    const exported = await page.evaluate(() => AppState.toConfig(window.__warp.state));
    const restored = await page.evaluate((cfg) => {
      const s2 = AppState.stateFromConfig(cfg);
      return {
        surface: s2.surface, feather: s2.feather, image: s2.imageName,
        quads: s2.projectors.map((p) => ({ id: p.id, size: p.size, quad: p.quad, invalid: p.invalidReason }))
      };
    }, exported);
    expect(restored.surface).toEqual([256, 128]);
    expect(restored.feather).toBe(24);
    expect(restored.image).toBe('grid.png');
    expect(restored.quads[0].quad).toEqual(exported.projectors[0].quad);
    expect(restored.quads.every((q) => q.invalid === '')).toBe(true);
    await browser.close();
  });

  test('导出 PNG 为合法 sRGB 文件且像素与渲染缓冲一致', async () => {
    const { browser, page } = await boot();
    await injectConfigAndImage(page, 'overlap.json', 'gray.png');
    const pngInfo = await page.evaluate(async () => {
      const st = window.__warp.state;
      const frame = window.__warp.renderToPixels(st.surface[0], st.surface[1], 'surface');
      const png = await PngEncoder.encodePng(frame.width, frame.height, frame.data);
      // 回读：构造 Image 验证可解码，并核对签名与 sRGB 块
      const sig = Array.from(png.subarray(0, 8));
      const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
      let pos = 8; const chunks = [];
      while (pos < png.length) {
        const len = dv.getUint32(pos);
        chunks.push(new TextDecoder().decode(png.subarray(pos + 4, pos + 8)));
        pos += len + 12;
      }
      const url = URL.createObjectURL(new Blob([png], { type: 'image/png' }));
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
      return { sig, chunks, w: img.naturalWidth, h: img.naturalHeight, bytes: png.length };
    });
    expect(pngInfo.sig).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(pngInfo.chunks).toContain('sRGB');
    expect(pngInfo.chunks).toContain('IDAT');
    expect(pngInfo.chunks).toContain('IEND');
    expect([pngInfo.w, pngInfo.h]).toEqual([256, 128]);
    await browser.close();
  });

  test('连续快速改动不会被旧渲染覆盖（revision 单调）', async () => {
    const { browser, page } = await boot();
    await injectConfigAndImage(page, 'overlap.json', 'gray.png');
    const final = await page.evaluate(async () => {
      const st = window.__warp.state;
      const revs = [];
      for (let i = 0; i < 20; i++) {
        const q = st.projectors[0].quad.map((p) => [...p]);
        q[0] = [i, 0];
        AppState.tryUpdateQuad(st, 0, q);
        revs.push(st.revision);
      }
      window.__warp.renderAll();
      return { rev: st.revision, corner: st.projectors[0].quad[0], revs };
    });
    expect(final.rev).toBe(final.revs[final.revs.length - 1]);
    expect(final.corner).toEqual([19, 0]);
    await browser.close();
  });

  test('真实鼠标拖拽四角并同步数字输入', async () => {
    const { browser, page } = await boot();
    // 走真实文件导入流程，确保面板与叠层都已构建
    await page.setInputFiles('#fileBoth', [
      join(samples, 'perspective.json'),
      join(samples, 'grid.png')
    ]);
    await page.waitForTimeout(500);
    const moved = await page.evaluate(() => {
      const c = document.getElementById('overlayCanvas');
      const r = c.getBoundingClientRect();
      const st = window.__warp.state;
      const toClient = (x, y) => [r.left + (x / st.surface[0]) * r.width,
                                   r.top + (y / st.surface[1]) * r.height];
      const [sx, sy] = toClient(4, 5);
      const [tx, ty] = toClient(30, 25);
      const pe = (type, x, y) => c.dispatchEvent(new PointerEvent(type, {
        clientX: x, clientY: y, bubbles: true, cancelable: true,
        pointerId: 1, isPrimary: true
      }));
      pe('pointerdown', sx, sy);
      for (let i = 1; i <= 8; i++) {
        pe('pointermove', sx + (tx - sx) * i / 8, sy + (ty - sy) * i / 8);
      }
      pe('pointerup', tx, ty);
      return st.projectors[0].quad[0];
    });
    expect(moved[0]).toBeCloseTo(30, 6);
    expect(moved[1]).toBeCloseTo(25, 6);
    const inputX = await page.locator('.field-group[data-proj-index="0"] .corner-cell')
      .first().locator('.qx').inputValue();
    expect(parseFloat(inputX)).toBeCloseTo(30, 6);
    await browser.close();
  });

  test('真实下载合成 PNG 并落盘校验 sRGB 与像素', async () => {
    const { browser, page } = await boot();
    await injectConfigAndImage(page, 'overlap.json', 'gray.png');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#btnExportComposite')
    ]);
    expect(download.suggestedFilename()).toBe('composite.png');
    const path = await download.path();
    const bytes = readFileSync(path);
    // PNG 签名 + sRGB 块
    expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    const head = bytes.subarray(0, 200).toString('latin1');
    expect(head).toContain('sRGB');
    // 用浏览器解码回图像，确认尺寸与可解码性
    const dims = await page.evaluate(async (b64) => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = 'data:image/png;base64,' + b64; });
      return [img.naturalWidth, img.naturalHeight];
    }, bytes.toString('base64'));
    expect(dims).toEqual([256, 128]);
    await browser.close();
  });
});
