import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/**
 * 端到端验收：界面与数值都走与用户相同的路径。
 * 样例直接从 samples/ 压缩包读取（不依赖预先解包）。
 */

const ARCHIVE = path.resolve('samples/echo-path-nlms-desk-cases.zip');

function readZipEntries(archivePath: string): Map<string, Buffer> {
  const buffer = readFileSync(archivePath);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 0xffff - 22); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('缺少中央目录');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const files = new Map<string, Buffer>();
  for (let i = 0; i < count; i += 1) {
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? zlib.inflateRawSync(raw) : null;
    if (!data) throw new Error(`不支持的压缩方法 ${method}`);
    if (!name.endsWith('/')) files.set(name, data);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

const files = readZipEntries(ARCHIVE);
const bytesOf = (name: string): number[] => Array.from(files.get(name) ?? []);

// 页面暴露在 window.scenario 上的核对入口。
interface Scenario {
  importFiles(ref: File, mic: File): Promise<void>;
  loadSampleCase(id: string): Promise<void>;
  openSampleZip(file: File): Promise<void>;
  setParams(params: Record<string, unknown>): boolean;
  setFreeze(ranges: Array<{ start: number; end: number }>): boolean;
  applySampleConfig(caseId: string): boolean;
  run(): void;
  advance(frames: number): number;
  reset(): void;
  checkpointText(): Promise<string | null>;
  resumeCheckpoint(text: string): Promise<boolean>;
  runChunkCheck(sizes: number[]): void;
  runTinyCheck(): void;
  runFormatChecks(): Promise<void>;
  reportResidualWavBytes(): { bytes: number[]; stats: { clipped: number; belowMin: number; aboveMax: number; peak: number } } | null;
  report(): Record<string, unknown> | null;
  snapshot(): Snapshot;
  notices(): Array<{ kind: string; title: string; detail?: string }>;
  setStem(stem: string): void;
  play(): boolean;
  pause(): void;
}

interface IntervalView {
  start: number;
  end: number;
  freeze: boolean;
  processedFrames: number;
  totalFrames: number;
  complete: boolean;
  echoMeanSquare: number | null;
  microphoneMeanSquare: number | null;
  residualMeanSquare: number | null;
  erleDb: number | null;
}

interface Snapshot {
  hasInput: boolean;
  referenceName: string;
  microphoneName: string;
  sampleRate: number;
  bitDepth: number;
  totalFrames: number;
  processedFrames: number;
  params: { delay: number; taps: number; mu: number; leak: number; tiny: boolean };
  freeze: Array<{ start: number; end: number }>;
  taps: number[];
  intervals: IntervalView[];
  overall: IntervalView | null;
  clipping: { belowMin: number; aboveMax: number; clipped: number; peak: number };
  tinyCheck: { passed: boolean; exact: boolean; maxEchoError: number; maxResidualError: number; maxTapError: number; frames: number; taps: number } | null;
  formatChecks: Array<{ name: string; passed: boolean; sampleRate: number; bitDepth: number; roundTripLsb: number; reasons: string[] }>;
  chunkCheck: { passed: boolean; maxEchoDifference: number; maxResidualDifference: number; maxTapDifference: number } | null;
  sampleCaseId: string | null;
  sampleNotes: string;
  running: boolean;
  elapsedMs: number | null;
}

declare global {
  interface Window {
    scenario: Scenario;
  }
}

async function boot(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.scenario));
  return errors;
}

const snap = (page: Page): Promise<Snapshot> => page.evaluate(() => window.scenario.snapshot());

async function openZip(page: Page): Promise<void> {
  const zipBytes = Array.from(readFileSync(ARCHIVE));
  await page.evaluate(async (bytes) => {
    const file = new File([Uint8Array.from(bytes)], 'cases.zip', { type: 'application/zip' });
    await window.scenario.openSampleZip(file);
  }, zipBytes);
}

test.describe('回声消除校验台', () => {
  test('打开样例包后识别 8 个案例，并显示包内说明', async ({ page }) => {
    const errors = await boot(page);
    await openZip(page);
    const snapshot = await snap(page);
    expect(snapshot.sampleNotes).toContain('epsilon=1e-8');
    const options = await page.locator('[data-testid="sample-select"] option').count();
    expect(options).toBe(9); // 1 个占位 + 8 个案例
    expect(errors).toEqual([]);
  });

  test('tiny 案例逐位复现包内期望值（界面显示“通过”）', async ({ page }) => {
    const errors = await boot(page);
    await openZip(page);
    await page.evaluate(() => window.scenario.loadSampleCase('tiny'));
    let snapshot = await snap(page);
    expect(snapshot.totalFrames).toBe(8);
    expect(snapshot.params.taps).toBe(2);
    expect(snapshot.params.tiny).toBe(true);
    expect(snapshot.params.mu).toBe(0.25);
    expect(snapshot.params.leak).toBe(0.001);
    expect(snapshot.freeze).toEqual([{ start: 3, end: 5 }]);

    await page.evaluate(() => window.scenario.runTinyCheck());
    snapshot = await snap(page);
    expect(snapshot.tinyCheck?.passed).toBe(true);
    expect(snapshot.tinyCheck?.exact).toBe(true);
    expect(snapshot.tinyCheck?.maxEchoError).toBe(0);
    expect(snapshot.tinyCheck?.maxResidualError).toBe(0);
    expect(snapshot.tinyCheck?.maxTapError).toBe(0);

    await page.locator('[data-testid="tab-checks"]').click();
    await expect(page.locator('[data-testid="check-list"]')).toContainText('tiny 逐位核对通过');
    expect(errors).toEqual([]);
  });

  test('main 案例：冻结讲话区间后抽头收敛到两阶段真回声路径', async ({ page }) => {
    const errors = await boot(page);
    await openZip(page);
    await page.evaluate(() => window.scenario.loadSampleCase('main'));
    let snapshot = await snap(page);
    expect(snapshot.params.taps).toBe(64);
    expect(snapshot.params.tiny).toBe(false);
    expect(snapshot.freeze).toEqual([{ start: 12000, end: 19000 }]);

    await page.evaluate(() => window.scenario.run());
    snapshot = await snap(page);
    expect(snapshot.processedFrames).toBe(48000);
    // 第二阶段真路径 12→0.35、40→0.30，27 已归零。
    expect(Math.abs(snapshot.taps[12] - 0.35)).toBeLessThan(1e-3);
    expect(Math.abs(snapshot.taps[40] - 0.3)).toBeLessThan(1e-3);
    expect(Math.abs(snapshot.taps[27])).toBeLessThan(1e-2);

    // 冻结区间的能量：e 明显高于非冻结段（近端讲话被保留）。
    const frozen = snapshot.intervals.find((item) => item.freeze && item.start === 12000)!;
    expect(frozen.complete).toBe(true);
    expect(frozen.processedFrames).toBe(7000);
    expect(frozen.erleDb).not.toBeNull();
    expect(frozen.erleDb! < 10).toBe(true);

    await page.locator('[data-testid="tab-taps"]').click();
    await expect(page.locator('[data-testid="tap-table"]')).toContainText('0.35000');
    expect(errors).toEqual([]);
  });

  test('分块大小不改变结果：界面自检显示全部差异为 0', async ({ page }) => {
    await boot(page);
    await openZip(page);
    await page.evaluate(() => window.scenario.loadSampleCase('main'));
    await page.evaluate(() => window.scenario.runChunkCheck([1, 17, 512, 0]));
    const snapshot = await snap(page);
    expect(snapshot.chunkCheck?.passed).toBe(true);
    expect(snapshot.chunkCheck?.maxEchoDifference).toBe(0);
    expect(snapshot.chunkCheck?.maxResidualDifference).toBe(0);
    expect(snapshot.chunkCheck?.maxTapDifference).toBe(0);
    await page.locator('[data-testid="tab-checks"]').click();
    await expect(page.locator('[data-testid="check-list"]')).toContainText('分块不变性通过');
  });

  test('暂停并保存检查点，重新导入原文件后续算，与一次到底完全一致', async ({ page }) => {
    await boot(page);
    await openZip(page);
    await page.evaluate(() => window.scenario.loadSampleCase('main'));
    await page.evaluate(() => window.scenario.advance(9000));
    let snapshot = await snap(page);
    expect(snapshot.processedFrames).toBe(9000);

    const checkpoint = await page.evaluate(() => window.scenario.checkpointText());
    expect(checkpoint).toBeTruthy();
    expect(checkpoint!.length).toBeGreaterThan(100000);
    const parsed = JSON.parse(checkpoint!) as { frame: number; inputs: { reference: { digest: string }; microphone: { digest: string } }; params: { mu: number } };
    expect(parsed.frame).toBe(9000);
    expect(parsed.params.mu).toBe(0.3);
    expect(parsed.inputs.reference.digest.length).toBeGreaterThan(16);

    // 模拟“重新导入原文件”再续算。
    await page.evaluate(
      async ({ x, d }) => {
        await window.scenario.importFiles(new File([Uint8Array.from(x)], 'main-x.wav'), new File([Uint8Array.from(d)], 'main-d.wav'));
        await window.scenario.setParams({ delay: 0, taps: 64, mu: 0.3, leak: 0, tiny: false });
        await window.scenario.setFreeze([{ start: 12000, end: 19000 }]);
      },
      { x: bytesOf('main-x.wav'), d: bytesOf('main-d.wav') },
    );
    const resumed = await page.evaluate(async (text) => window.scenario.resumeCheckpoint(text), checkpoint!);
    expect(resumed).toBe(true);
    snapshot = await snap(page);
    expect(snapshot.processedFrames).toBe(9000);
    await page.evaluate(() => window.scenario.run());
    snapshot = await snap(page);
    // 与前面“一次到底”的运行比较：抽头必须逐位一致。
    const full = await page.evaluate(async ({ x, d }) => {
      await window.scenario.importFiles(new File([Uint8Array.from(x)], 'main-x.wav'), new File([Uint8Array.from(d)], 'main-d.wav'));
      await window.scenario.setParams({ delay: 0, taps: 64, mu: 0.3, leak: 0, tiny: false });
      await window.scenario.setFreeze([{ start: 12000, end: 19000 }]);
      window.scenario.run();
      return window.scenario.snapshot();
    }, { x: bytesOf('main-x.wav'), d: bytesOf('main-d.wav') });
    expect(snapshot.taps).toEqual(full.taps);
  });

  test('拒绝用不同文件或不同参数续算，并说明原因', async ({ page }) => {
    await boot(page);
    await openZip(page);
    await page.evaluate(() => window.scenario.loadSampleCase('main'));
    await page.evaluate(() => window.scenario.advance(500));
    const checkpoint = await page.evaluate(() => window.scenario.checkpointText());

    // 换成 tiny 的文件（摘要不符）
    await page.evaluate(
      async ({ x, d }) => {
        await window.scenario.importFiles(new File([Uint8Array.from(x)], 'tiny-x.wav'), new File([Uint8Array.from(d)], 'tiny-d.wav'));
      },
      { x: bytesOf('tiny-x.wav'), d: bytesOf('tiny-d.wav') },
    );
    expect(await page.evaluate(async (text) => window.scenario.resumeCheckpoint(text), checkpoint!)).toBe(false);
    const notice = (await page.evaluate(() => window.scenario.notices())).slice(-1)[0];
    expect(notice.kind).toBe('error');
    expect(notice.detail).toContain('内容摘要不符');

    // 换回原文件但改参数
    await page.evaluate(
      async ({ x, d }) => {
        await window.scenario.importFiles(new File([Uint8Array.from(x)], 'main-x.wav'), new File([Uint8Array.from(d)], 'main-d.wav'));
        await window.scenario.setFreeze([{ start: 12000, end: 19000 }]);
        await window.scenario.setParams({ mu: 0.5 });
      },
      { x: bytesOf('main-x.wav'), d: bytesOf('main-d.wav') },
    );
    expect(await page.evaluate(async (text) => window.scenario.resumeCheckpoint(text), checkpoint!)).toBe(false);
    const paramNotice = (await page.evaluate(() => window.scenario.notices())).slice(-1)[0];
    expect(paramNotice.detail).toContain('步长 μ');
  });

  test('导出 24 位 WAV 与浮点残差：格式正确，削波按限幅前越界帧计数', async ({ page }) => {
    await boot(page);
    await openZip(page);
    await page.evaluate(() => window.scenario.loadSampleCase('main'));
    await page.evaluate(() => window.scenario.run());
    const result = await page.evaluate(() => window.scenario.reportResidualWavBytes());
    expect(result).not.toBeNull();
    const bytes = new Uint8Array(result!.bytes);
    // RIFF 头：48kHz、单声道、24 位、帧数 = 48000。
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint16(34, true)).toBe(24);
    const dataSize = view.getUint32(40, true);
    expect(dataSize).toBe(48000 * 3);
    expect(result!.stats.clipped).toBe(0);

    await page.locator('[data-testid="tab-energy"]').click();
    await expect(page.locator('[data-testid="clip-stat"] .value')).toHaveText('0');
  });

  test('6 个格式样例全部可导入并通过 24 位往返自检（8/16/48kHz × 16/24 位）', async ({ page }) => {
    await boot(page);
    await openZip(page);
    await page.evaluate(() => window.scenario.runFormatChecks());
    const snapshot = await snap(page);
    expect(snapshot.formatChecks).toHaveLength(6);
    const expected: Array<[string, number, number]> = [
      ['formats/8000-16.wav', 8000, 16],
      ['formats/8000-24.wav', 8000, 24],
      ['formats/16000-16.wav', 16000, 16],
      ['formats/16000-24.wav', 16000, 24],
      ['formats/48000-16.wav', 48000, 16],
      ['formats/48000-24.wav', 48000, 24],
    ];
    for (const [name, rate, bits] of expected) {
      const check = snapshot.formatChecks.find((item) => item.name === name);
      expect(check, `缺少 ${name}`).toBeDefined();
      expect(check!.passed).toBe(true);
      expect(check!.sampleRate).toBe(rate);
      expect(check!.bitDepth).toBe(bits);
      expect(check!.roundTripLsb).toBeLessThan(0.5 + 1e-9);
    }
    await page.locator('[data-testid="tab-checks"]').click();
    await expect(page.locator('[data-testid="check-list"]')).toContainText('formats/48000-24.wav 格式自检通过');
  });

  test('在波形上拖拽生成冻结区间，双击解除，能量统计随区间更新', async ({ page }) => {
    await boot(page);
    await openZip(page);
    await page.evaluate(() => window.scenario.loadSampleCase('main'));
    await page.evaluate(() => window.scenario.setFreeze([]));
    await page.evaluate(() => window.scenario.run());

    const box = await page.locator('canvas.wave-canvas').first().boundingBox();
    if (!box) throw new Error('缺少波形画布');
    // 拖拽约 25%–40% 的横向范围（画布左侧有 74px 标签栏，右侧留 8px）。
    const plotLeft = box.x + 74;
    const plotWidth = box.width - 74 - 8;
    await page.mouse.move(plotLeft + plotWidth * 0.25, box.y + 40);
    await page.mouse.down();
    await page.mouse.move(plotLeft + plotWidth * 0.4, box.y + 40, { steps: 8 });
    await page.mouse.up();
    await page.locator('[data-testid="freeze-start"]').waitFor();
    const start = await page.locator('[data-testid="freeze-start"]').inputValue();
    expect(Number(start)).toBeGreaterThan(8000);
    await page.locator('[data-testid="freeze-add"]').click();

    const snapshot = await snap(page);
    expect(snapshot.freeze.length).toBe(1);
    expect(snapshot.freeze[0].start).toBeGreaterThan(8000);
    expect(snapshot.freeze[0].end).toBeGreaterThan(snapshot.freeze[0].start);
    // 改冻结区间会清零重算；先跑完再看能量。
    await page.evaluate(() => window.scenario.run());
    const after = await snap(page);
    const interval = after.intervals.find((item) => item.freeze)!;
    expect(interval.complete).toBe(true);
    expect(interval.microphoneMeanSquare).not.toBeNull();
    expect(interval.residualMeanSquare).not.toBeNull();

    // 双击冻结区间 → 解除冻结。
    const midX = plotLeft + plotWidth * ((interval.start + interval.end) / 2 / after.totalFrames);
    await page.mouse.dblclick(midX, box.y + 40);
    const cleared = await snap(page);
    expect(cleared.freeze).toEqual([]);
  });

  test('界面参数校验：短滤波器需 tiny 模式、延迟上限、冻结区间不得越界', async ({ page }) => {
    await boot(page);
    await page.evaluate(
      async ({ x, d }) => {
        await window.scenario.importFiles(new File([Uint8Array.from(x)], 'main-x.wav'), new File([Uint8Array.from(d)], 'main-d.wav'));
      },
      { x: bytesOf('main-x.wav'), d: bytesOf('main-d.wav') },
    );
    expect(await page.evaluate(() => window.scenario.setParams({ taps: 2 }))).toBe(false);
    expect((await page.evaluate(() => window.scenario.notices())).slice(-1)[0].detail).toContain('tiny 核对模式');
    expect(await page.evaluate(() => window.scenario.setParams({ delay: 3000 }))).toBe(false);
    expect((await page.evaluate(() => window.scenario.notices())).slice(-1)[0].detail).toContain('延迟');
    expect(await page.evaluate(() => window.scenario.setParams({ mu: 2 }))).toBe(false);
    expect(await page.evaluate(() => window.scenario.setFreeze([{ start: 0, end: 48001 }]))).toBe(false);
    expect((await page.evaluate(() => window.scenario.notices())).slice(-1)[0].detail).toContain('超出文件长度');
    // 合法参数仍然生效。
    expect(await page.evaluate(() => window.scenario.setParams({ taps: 32, delay: 0, mu: 0.5, leak: 0 }))).toBe(true);
  });

  test('试听可切换原音 / 估计回声 / 残差，播放位置共用', async ({ page }) => {
    await boot(page);
    await openZip(page);
    await page.evaluate(() => window.scenario.loadSampleCase('main'));
    await page.evaluate(() => window.scenario.run());
    await page.evaluate(() => window.scenario.setStem('echo'));
    await expect(page.locator('[data-testid="stem-echo"]')).toHaveClass(/active/);
    await page.evaluate(() => window.scenario.setStem('residual'));
    await expect(page.locator('[data-testid="stem-residual"]')).toHaveClass(/active/);
  });

  test('「从样例 JSON 填参」只改参数、不重新载入音频', async ({ page }) => {
    await boot(page);
    await page.evaluate(
      async ({ x, d }) => {
        await window.scenario.importFiles(new File([Uint8Array.from(x)], 'main-x.wav'), new File([Uint8Array.from(d)], 'main-d.wav'));
      },
      { x: bytesOf('main-x.wav'), d: bytesOf('main-d.wav') },
    );
    await expect(page.locator('[data-testid="load-sample-json"]')).toBeVisible();
    // 没有样例参数时的提示
    expect(await page.evaluate(() => window.scenario.applySampleConfig('main'))).toBe(false);
    await openZip(page);
    expect(await page.evaluate(() => window.scenario.applySampleConfig('main'))).toBe(true);
    const snapshot = await snap(page);
    expect(snapshot.params.taps).toBe(64);
    expect(snapshot.params.mu).toBe(0.3);
    expect(snapshot.freeze).toEqual([{ start: 12000, end: 19000 }]);
    expect(snapshot.processedFrames).toBe(0);
    expect(snapshot.referenceName).toBe('main-x.wav');
  });

  test('参数改动会使旧结果失效（清零重算），不会冒充旧数据', async ({ page }) => {
    await boot(page);
    await openZip(page);
    await page.evaluate(() => window.scenario.loadSampleCase('main'));
    await page.evaluate(() => window.scenario.run());
    expect((await snap(page)).processedFrames).toBe(48000);
    expect(await page.evaluate(() => window.scenario.setParams({ mu: 0.4 }))).toBe(true);
    expect((await snap(page)).processedFrames).toBe(0);
    expect((await snap(page)).taps.every((value) => value === 0)).toBe(true);
  });
});
