/**
 * 应用状态与动作编排：导入、参数、运行、暂停、检查点、导出、样例核对。
 *
 * 所有数值都通过 NlmsEngine，界面只读引擎状态；任何参数变化都会重建引擎
 * （参数变化使旧结果失效，不允许“悄悄”混合两套参数）。
 */

import { NlmsEngine, intervalEnergy, type IntervalEnergyResult } from '../core/nlms';
import { importWav, decodeWavPcm, WavError } from '../core/wav';
import { validateConfig, normalizeFreeze } from '../core/params';
import { buildCheckpoint, finalizeCheckpoint, parseCheckpoint, serializeCheckpoint, compareCheckpointConfig } from '../core/checkpoint';
import { buildFilterReport, buildResidualFloat64, buildResidualWav, clipStatsOf, type ClipStats } from '../core/export';
import { tinyCheck, formatSelfCheck, chunkInvariance, type FormatCheck, type ChunkInvarianceResult } from '../core/verify';
import { readSampleBundle, loadSampleCase, type SampleBundle, type SampleCase } from '../core/zip';
import { parseSampleConfig, parseTinyExpected } from '../core/samples';
import { clipMeta, NLMS_CONSTANTS, type AudioClip, type NlmsConfig, type NlmsParams, type TinyCheck, type TinyExpected } from '../core/types';
import type { StemBuffers } from './player';

export type NoticeKind = 'info' | 'warn' | 'error' | 'good';

export interface Notice {
  kind: NoticeKind;
  title: string;
  detail?: string;
  at: number;
}

export interface IntervalView extends IntervalEnergyResult {
  freeze: boolean;
  label: string;
}

export interface AppSnapshot {
  hasInput: boolean;
  referenceName: string;
  microphoneName: string;
  sampleRate: number;
  bitDepth: number;
  totalFrames: number;
  durationSeconds: number;
  processedFrames: number;
  params: NlmsParams & { tiny: boolean };
  freeze: Array<{ start: number; end: number }>;
  taps: number[];
  intervals: IntervalView[];
  overall: IntervalView | null;
  clipping: ClipStats;
  tinyCheck: TinyCheck | null;
  tinyExpected: TinyExpected | null;
  formatChecks: FormatCheck[];
  chunkCheck: ChunkInvarianceResult | null;
  sampleNotes: string;
  sampleCaseId: string | null;
  running: boolean;
  elapsedMs: number | null;
}



const MAX_TAP_TEXT = 256;

export class Controller {
  reference: AudioClip | null = null;
  microphone: AudioClip | null = null;
  engine: NlmsEngine | null = null;
  params: NlmsParams & { tiny: boolean } = { delay: 0, taps: 64, mu: 0.3, leak: 0, tiny: false };
  freezeInput: Array<{ start: number; end: number }> = [];
  /** 与冻结无关、只用于分析的区间（额外区间）。 */
  analysisRanges: Array<{ start: number; end: number }> = [];

  tinyExpected: TinyExpected | null = null;
  tinyCheckResult: TinyCheck | null = null;
  formatChecks: FormatCheck[] = [];
  chunkCheck: ChunkInvarianceResult | null = null;
  sampleBundle: SampleBundle | null = null;
  sampleCaseId: string | null = null;
  sampleNotes = '';

  running = false;
  elapsedMs: number | null = null;
  private runStartedAt = 0;
  /** 每次重建引擎递增，用于界面判断是否需要重建音频缓冲。 */
  engineVersion = 0;
  playerVersion = '';

  private listeners = new Set<() => void>();
  private noticeListeners = new Set<(notice: Notice) => void>();
  private notices: Notice[] = [];

  on(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onNotice(listener: (notice: Notice) => void): () => void {
    this.noticeListeners.add(listener);
    return () => this.noticeListeners.delete(listener);
  }

  notify(kind: NoticeKind, title: string, detail?: string): void {
    const notice: Notice = { kind, title, detail, at: Date.now() };
    this.notices.push(notice);
    for (const listener of this.noticeListeners) listener(notice);
  }

  history(): Notice[] {
    return this.notices.slice(-12);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  // ------------------------------------------------------------------ 导入

  /** 只替换远端参考；麦克风沿用已载入的（用于两文件分别选择）。 */
  async loadReferenceOnly(file: File): Promise<void> {
    try {
      const reference = await importWav(file.name, new Uint8Array(await file.arrayBuffer()));
      if (this.microphone) this.applyInputs(reference, this.microphone, '远端参考');
      else {
        this.reference = reference;
        this.notify('info', '远端参考已载入', `${reference.numFrames} 帧 · ${reference.sampleRate}Hz；请再选择麦克风 WAV。`);
        this.emit();
      }
    } catch (error) {
      this.reportError(error, '远端参考导入失败');
    }
  }

  /** 只替换麦克风。 */
  async loadMicrophoneOnly(file: File): Promise<void> {
    try {
      const microphone = await importWav(file.name, new Uint8Array(await file.arrayBuffer()));
      if (this.reference) this.applyInputs(this.reference, microphone, '麦克风');
      else {
        this.microphone = microphone;
        this.notify('info', '麦克风已载入', `${microphone.numFrames} 帧 · ${microphone.sampleRate}Hz；请再选择远端参考 WAV。`);
        this.emit();
      }
    } catch (error) {
      this.reportError(error, '麦克风导入失败');
    }
  }

  async loadFiles(referenceFile: File, microphoneFile: File): Promise<void> {
    try {
      const reference = await importWav(referenceFile.name, new Uint8Array(await referenceFile.arrayBuffer()));
      const microphone = await importWav(microphoneFile.name, new Uint8Array(await microphoneFile.arrayBuffer()));
      this.applyInputs(reference, microphone, '手动导入');
    } catch (error) {
      this.reportError(error, '导入失败');
    }
  }

  async loadFromClip(clip: AudioClip): Promise<void> {
    this.applyInputs(clip, clip, '同文件往返');
  }

  /** 两端都已就绪时才真正组建引擎。 */
  private applyInputs(reference: AudioClip, microphone: AudioClip, source: string, keepChecks = false): void {
    if (reference.sampleRate !== microphone.sampleRate) {
      this.notify(
        'error',
        '采样率不一致',
        `参考 ${reference.sampleRate}Hz 与麦克风 ${microphone.sampleRate}Hz 不同，无法逐样本相减。`,
      );
      return;
    }
    if (reference.numFrames !== microphone.numFrames) {
      this.notify(
        'error',
        '长度不一致',
        `参考 ${reference.numFrames} 帧与麦克风 ${microphone.numFrames} 帧不等（必须等长同采样率）。`,
      );
      return;
    }
    this.reference = reference;
    this.microphone = microphone;
    this.tinyExpected = null;
    this.tinyCheckResult = null;
    if (!keepChecks) this.formatChecks = [];
    this.chunkCheck = null;
    this.sampleCaseId = null;
    // 换输入后旧的分析区间可能越界：全部按新长度重新校验，越界则整组清空并提示。
    if (this.analysisRanges.length > 0) {
      const check = normalizeFreeze(this.analysisRanges, reference.numFrames, '分析区间');
      if (check.errors.length > 0) {
        this.analysisRanges = [];
        this.notify('warn', '旧的分析区间已清空', check.errors.join('\n'));
      } else {
        this.analysisRanges = check.ranges;
      }
    }
    if (this.freezeInput.length > 0) {
      const normalized = normalizeFreeze(this.freezeInput, reference.numFrames);
      this.freezeInput = normalized.errors.length === 0 ? normalized.ranges : [];
    }
    this.rebuildEngine();
    this.notify('good', `${source}：已载入`, `${reference.numFrames} 帧 · ${reference.sampleRate}Hz · ${reference.bitDepth} 位`);
  }

  // ------------------------------------------------------------------ 参数

  setParams(params: Partial<NlmsParams & { tiny: boolean }>): boolean {
    if (!this.reference) {
      this.params = { ...this.params, ...params };
      this.emit();
      return true;
    }
    const candidate = { ...this.params, ...params };
    const validation = validateConfig({ ...candidate, freeze: this.freezeInput }, this.reference.numFrames);
    if (!validation.ok) {
      this.notify('error', '参数不合法', validation.errors.join('\n'));
      this.emit();
      return false;
    }
    const next = { delay: candidate.delay, taps: candidate.taps, mu: candidate.mu, leak: candidate.leak, tiny: candidate.tiny };
    const same = (['delay', 'taps', 'mu', 'leak', 'tiny'] as const).every((key) => this.params[key] === next[key]);
    this.params = next;
    if (same) this.emit();
    else this.rebuildEngine();
    return true;
  }

  /** 冻结区间来自命令行/样例 JSON：替换整组。 */
  setFreeze(ranges: Array<{ start: number; end: number }>): boolean {
    if (!this.reference) {
      this.freezeInput = ranges;
      this.emit();
      return true;
    }
    const normalized = normalizeFreeze(ranges, this.reference.numFrames);
    if (normalized.errors.length > 0) {
      this.notify('error', '冻结区间不合法', normalized.errors.join('\n'));
      return false;
    }
    const same =
      this.freezeInput.length === normalized.ranges.length &&
      this.freezeInput.every((range, index) => range.start === normalized.ranges[index].start && range.end === normalized.ranges[index].end);
    this.freezeInput = normalized.ranges;
    if (same) this.emit();
    else this.rebuildEngine();
    return true;
  }

  addFreezeRange(range: { start: number; end: number }): boolean {
    return this.setFreeze([...this.freezeInput, range]);
  }

  removeFreezeRange(index: number): void {
    const next = this.freezeInput.filter((_, i) => i !== index);
    this.freezeInput = next;
    this.rebuildEngine();
  }

  setAnalysisRanges(ranges: Array<{ start: number; end: number }>): boolean {
    if (!this.reference) {
      this.analysisRanges = ranges;
      this.emit();
      return true;
    }
    const normalized = normalizeFreeze(ranges, this.reference.numFrames, '分析区间');
    if (normalized.errors.length > 0) {
      this.notify('error', '分析区间不合法', normalized.errors.join('\n'));
      return false;
    }
    this.analysisRanges = normalized.ranges;
    this.emit();
    return true;
  }

  private rebuildEngine(): void {
    if (!this.reference || !this.microphone) {
      this.engine = null;
      this.emit();
      return;
    }
    const validation = validateConfig({ ...this.params, freeze: this.freezeInput }, this.reference.numFrames);
    if (!validation.ok || !validation.config) {
      this.engine = null;
      this.notify('error', '无法组建滤波器', validation.errors.join('\n'));
      this.emit();
      return;
    }
    this.params = {
      delay: validation.config.delay,
      taps: validation.config.taps,
      mu: validation.config.mu,
      leak: validation.config.leak,
      tiny: validation.config.tiny,
    };
    this.engineVersion += 1;
    this.engine = new NlmsEngine({
      reference: this.reference.samples,
      microphone: this.microphone.samples,
      sampleRate: this.reference.sampleRate,
      config: validation.config,
    });
    this.running = false;
    this.elapsedMs = null;
    this.chunkCheck = null;
    this.playerVersion = `engine-${this.engineVersion}`;
    this.emit();
  }

  // ------------------------------------------------------------------ 运行

  runToEnd(): void {
    if (!this.engine) return;
    const started = performance.now();
    this.running = true;
    this.runStartedAt = started;
    this.engine.runToEnd();
    this.running = false;
    this.elapsedMs = performance.now() - started;
    this.emit();
  }

  /** 标记为“正在运行”（供分块循环使用），耗时按首次开跑起算。 */
  beginRun(): void {
    if (this.running) return;
    this.running = true;
    this.runStartedAt = performance.now();
  }

  /** 结束运行状态并记录本次耗时。 */
  endRun(): void {
    if (!this.running) return;
    this.running = false;
    if (this.runStartedAt > 0) this.elapsedMs = performance.now() - this.runStartedAt;
    this.emit();
  }

  /** 逐块推进（用于“分块运行”与来自界面的循环调用）。 */
  advance(frames: number): number {
    if (!this.engine) return 0;
    const progressed = this.engine.advance(frames);
    if (this.engine.frame >= this.engine.totalFrames) this.running = false;
    this.emit();
    return progressed;
  }

  pause(): void {
    if (this.running && this.runStartedAt > 0) this.elapsedMs = performance.now() - this.runStartedAt;
    this.running = false;
    this.emit();
  }

  reset(): void {
    if (this.reference && this.microphone) this.rebuildEngine();
    else {
      this.engine = null;
      this.emit();
    }
  }

  // ------------------------------------------------------------------ 检查点

  async exportCheckpointText(): Promise<string | null> {
    if (!this.engine || !this.reference || !this.microphone) {
      this.notify('warn', '没有可保存的状态', '请先导入两份 WAV 并至少处理 0 帧以上。');
      return null;
    }
    const partial = buildCheckpoint({
      engine: this.engine,
      referenceMeta: clipMeta(this.reference),
      microphoneMeta: clipMeta(this.microphone),
    });
    const checkpoint = await finalizeCheckpoint(this.engine, partial);
    return serializeCheckpoint(checkpoint);
  }

  async resumeFromCheckpointText(text: string): Promise<boolean> {
    if (!this.reference || !this.microphone) {
      this.notify('error', '需要先重新导入原文件', '检查点只记录数值状态；请先导入保存检查点时的两份 WAV。');
      return false;
    }
    const result = await parseCheckpoint(text, {
      referenceDigest: this.reference.digest,
      microphoneDigest: this.microphone.digest,
      totalFrames: this.reference.numFrames,
    });
    if (!result.ok) {
      this.notify('error', '检查点拒绝续算', result.reasons.join('\n'));
      return false;
    }
    const current: NlmsConfig = {
      delay: this.params.delay,
      taps: this.params.taps,
      mu: this.params.mu,
      leak: this.params.leak,
      tiny: this.params.tiny,
      freeze: this.freezeInput,
    };
    const diffs = compareCheckpointConfig(result.config, current);
    if (diffs.length > 0) {
      this.notify('error', '参数与检查点不一致，拒绝续算', `${diffs.join('\n')}\n请先把参数改回检查点中的值。`);
      return false;
    }
    this.engine = new NlmsEngine({
      reference: this.reference.samples,
      microphone: this.microphone.samples,
      sampleRate: this.reference.sampleRate,
      config: result.config,
    });
    try {
      this.engine.restore({
        frame: result.frame,
        taps: result.taps,
        echoPrefix: result.echoPrefix,
        residualPrefix: result.residualPrefix,
        tapHistory: result.tapHistory,
      });
    } catch (error) {
      this.engine = null;
      this.notify('error', '检查点状态无法落位', (error as Error).message);
      return false;
    }
    this.params = { delay: result.config.delay, taps: result.config.taps, mu: result.config.mu, leak: result.config.leak, tiny: result.config.tiny };
    this.freezeInput = result.config.freeze;
    this.notify('good', '已从检查点续算', `从第 ${result.frame} 帧继续（共 ${result.totalFrames} 帧）`);
    this.emit();
    return true;
  }

  /** 分块不变性自检：用给定尺寸在当前输入上重跑。 */
  runChunkCheck(sizes: number[]): void {
    if (!this.reference || !this.microphone || !this.engine) return;
    const config = this.engine.config;
    const result = chunkInvariance(this.reference.samples, this.microphone.samples, this.reference.sampleRate, config, sizes);
    this.chunkCheck = result;
    this.notify(
      result.passed ? 'good' : 'error',
      result.passed ? '分块不变性通过' : '分块不变性失败',
      `比较了 ${sizes.length} 种分块尺寸（0 = 整段），最大差异 y ${result.maxEchoDifference} / e ${result.maxResidualDifference} / h ${result.maxTapDifference}`,
    );
    this.emit();
  }

  // ------------------------------------------------------------------ 导出

  exportResidualWav(): { bytes: Uint8Array; stats: ClipStats; filename: string } | null {
    if (!this.engine) {
      this.notify('warn', '没有可导出的残差', '请先导入并处理音频。');
      return null;
    }
    if (this.engine.frame === 0) {
      this.notify('warn', '尚未处理任何帧', '先运行或分块推进，再导出残差。');
      return null;
    }
    const { bytes, stats } = buildResidualWav(this.engine);
    this.reportClip(stats);
    return { bytes, stats, filename: `${baseName(this.microphone?.name ?? 'residual')}-residual-24bit.wav` };
  }

  exportResidualFloat64(): { bytes: Uint8Array; filename: string } | null {
    if (!this.engine || this.engine.frame === 0) {
      this.notify('warn', '尚未处理任何帧', '先运行或分块推进，再导出浮点残差。');
      return null;
    }
    return { bytes: buildResidualFloat64(this.engine), filename: `${baseName(this.microphone?.name ?? 'residual')}-residual-f64.raw` };
  }

  reportClip(stats: ClipStats): void {
    if (stats.clipped > 0) {
      this.notify('warn', `24 位残差有 ${stats.clipped} 帧削波`, `低于 -1：${stats.belowMin} 帧；高于 1-2^-23：${stats.aboveMax} 帧；峰值 ${stats.peak.toFixed(4)}`);
    } else {
      this.notify('good', '24 位残差无削波', `峰值 ${stats.peak.toFixed(4)}，未触及 ±1 边界。`);
    }
  }

  buildFilterReport(): Record<string, unknown> | null {
    if (!this.engine || !this.reference || !this.microphone) return null;
    return buildFilterReport({
      engine: this.engine,
      sampleRate: this.reference.sampleRate,
      config: this.engine.config,
      referenceName: this.reference.name,
      microphoneName: this.microphone.name,
      referenceDigest: this.reference.digest,
      microphoneDigest: this.microphone.digest,
      intervals: this.intervals().map((interval) => ({
        start: interval.start,
        end: interval.end,
        freeze: interval.freeze,
        processedFrames: interval.processedFrames,
        echoMeanSquare: interval.echoMeanSquare,
        microphoneMeanSquare: interval.microphoneMeanSquare,
        residualMeanSquare: interval.residualMeanSquare,
        erleDb: interval.erleDb,
      })),
    });
  }

  // ------------------------------------------------------------------ 样例

  async openSampleBundle(file: File): Promise<void> {
    try {
      const bundle = await readSampleBundle(new Uint8Array(await file.arrayBuffer()));
      this.sampleBundle = bundle;
      this.sampleNotes = bundle.notes;
      this.notify('good', '样例包已打开', `识别到 ${bundle.cases.length} 个案例`);
      this.emit();
    } catch (error) {
      this.reportError(error, '样例包无法打开');
    }
  }

  get sampleCases(): SampleCase[] {
    return this.sampleBundle?.cases ?? [];
  }

  /** 把样例 JSON 的参数（delay/taps/μ/leak/freeze）填入，且不重载音频。 */
  applySampleConfig(caseId: string): boolean {
    const target = this.sampleCases.find((item) => item.id === caseId);
    if (!target?.meta) {
      this.notify('warn', '该案例没有参数 JSON', '只有 tiny 与 main 案例带 tiny.json / main.json。');
      return false;
    }
    if (!this.reference) {
      this.notify('warn', '尚未导入音频', '先载入该案例的 WAV，再填参数。');
      return false;
    }
    const cfg = parseSampleConfig(target.meta);
    const validation = validateConfig({ delay: cfg.delay, taps: cfg.taps, mu: cfg.mu, leak: cfg.leak, tiny: cfg.tiny, freeze: cfg.freeze }, this.reference.numFrames);
    if (!validation.ok) {
      this.notify('error', '样例参数不合法', validation.errors.join('\n'));
      return false;
    }
    this.params = { delay: cfg.delay, taps: cfg.taps, mu: cfg.mu, leak: cfg.leak, tiny: cfg.tiny };
    this.freezeInput = cfg.freeze;
    this.rebuildEngine();
    this.notify('info', '已按样例 JSON 填入参数', `${target.label}：${cfg.taps} 抽头，μ=${cfg.mu}，leak=${cfg.leak}`);
    return true;
  }

  async loadSampleCase(caseId: string): Promise<boolean> {
    const target = this.sampleCases.find((item) => item.id === caseId);
    if (!target) {
      this.notify('error', '找不到案例', `样例包中没有 ${caseId}`);
      return false;
    }
    try {
      const { reference, microphone } = await loadSampleCase(target);
      this.sampleCaseId = caseId;
      this.sampleNotes = this.sampleBundle?.notes ?? '';
      this.applyInputs(reference, microphone, `样例 ${target.label}`);
      if (target.meta) {
        const cfg = parseSampleConfig(target.meta);
        this.params = { delay: cfg.delay, taps: cfg.taps, mu: cfg.mu, leak: cfg.leak, tiny: cfg.tiny };
        this.freezeInput = cfg.freeze;
        this.rebuildEngine();
      }
      // 只有 tiny 案例带期望值；其他案例必须清掉，避免用错的期望值核对。
      this.tinyExpected = caseId === 'tiny' && target.expected ? parseTinyExpected(target.expected) : null;
      this.tinyCheckResult = null;
      if (this.tinyExpected) this.runTinyCheck();
      this.notify('info', '参数已按样例 JSON 填入', `${target.label}`);
      return true;
    } catch (error) {
      this.reportError(error, '样例无法载入');
      return false;
    }
  }

  async loadFormatSample(caseId: string): Promise<void> {
    // 格式样例用同一文件作参考与麦克风，验证解码与“e 恒为 0”。
    try {
      const target = this.sampleCases.find((item) => item.id === caseId);
      if (!target?.reference) throw new Error('格式样例缺少 WAV');
      const decoded = decodeWavPcm(target.reference.bytes);
      const check = formatSelfCheck(target.reference.name, decoded);
      const clip = await importWav(target.reference.name, target.reference.bytes);
      // applyInputs 会清空旧自检记录（换输入即失效），因此先载入再登记本次结果。
      this.applyInputs(clip, clip, `格式样例 ${check.name}`, true);
      this.formatChecks = [...this.formatChecks.filter((item) => item.name !== check.name), check];
      this.params = { delay: 0, taps: NLMS_CONSTANTS.minTaps, mu: 0.3, leak: 0, tiny: false };
      this.freezeInput = [];
      this.rebuildEngine();
      this.engine?.runToEnd();
      let maxResidual = 0;
      if (this.engine) {
        for (let n = 0; n < this.engine.totalFrames; n += 1) maxResidual = Math.max(maxResidual, Math.abs(this.engine.residual[n]));
      }
      this.notify(check.passed ? 'good' : 'error', `${check.name} 格式自检${check.passed ? '通过' : '失败'}`, `24 位往返误差 ${check.roundTripLsb.toFixed(3)} LSB，残差最大 ${maxResidual.toExponential(2)}${check.reasons.length ? `；${check.reasons.join('；')}` : ''}`);
      this.emit();
    } catch (error) {
      this.reportError(error, '格式样例无法载入');
    }
  }

  runTinyCheck(): void {
    if (!this.engine || !this.tinyExpected) {
      this.notify('warn', '当前没有 tiny 期望值', '请先载入 tiny 案例（含 tiny-expected.json）。');
      return;
    }
    this.engine.runToEnd();
    const check = tinyCheck(this.engine, this.tinyExpected);
    this.tinyCheckResult = check;
    this.notify(
      check.passed ? 'good' : 'error',
      check.passed ? 'tiny 逐位核对通过' : 'tiny 逐位核对未通过',
      check.exact
        ? `${check.frames} 帧的 echo / residual 与 ${check.taps} 个抽头全部逐位相等`
        : `最大误差 echo ${check.maxEchoError}，residual ${check.maxResidualError}，h ${check.maxTapError}`,
    );
    this.emit();
  }

  /** 把样例包中的格式样例逐个跑一遍，生成 6 条自检记录。 */
  async runAllFormatChecks(): Promise<void> {
    for (const item of this.sampleCases.filter((c) => c.id.startsWith('format-'))) {
      await this.loadFormatSample(item.id);
    }
  }

  // ------------------------------------------------------------------ 查询

  /** 全段（已处理前缀）的整体能量。 */
  overall(): IntervalView | null {
    if (!this.engine) return null;
    const view = intervalEnergy(this.engine, { start: 0, end: this.engine.totalFrames });
    return { ...view, freeze: false, label: '整体' };
  }

  intervals(): IntervalView[] {
    if (!this.engine) return [];
    const views: IntervalView[] = [];
    for (const range of this.engine.config.freeze) {
      views.push({ ...intervalEnergy(this.engine, range), freeze: true, label: '冻结' });
    }
    for (const range of this.analysisRanges) {
      views.push({ ...intervalEnergy(this.engine, range), freeze: false, label: '分析' });
    }
    return views;
  }

  clipStats(): ClipStats {
    if (!this.engine) return { belowMin: 0, aboveMax: 0, clipped: 0, peak: 0 };
    return clipStatsOf(this.engine.residual, this.engine.frame);
  }

  stemBuffers(): StemBuffers | null {
    if (!this.engine || !this.reference) return null;
    // 残差未处理部分为 0，播放时听不到；原音与估计回声全长参与。
    return {
      sampleRate: this.reference.sampleRate,
      numFrames: this.engine.totalFrames,
      microphone: this.microphone!.samples,
      echo: this.engine.echo,
      residual: this.engine.residual,
    };
  }

  snapshot(): AppSnapshot {
    const engine = this.engine;
    const tinyExpected = this.tinyExpected;
    return {
      hasInput: Boolean(this.reference && this.microphone),
      referenceName: this.reference?.name ?? '',
      microphoneName: this.microphone?.name ?? '',
      sampleRate: this.reference?.sampleRate ?? 0,
      bitDepth: this.reference?.bitDepth ?? 0,
      totalFrames: this.reference?.numFrames ?? 0,
      durationSeconds: this.reference ? this.reference.numFrames / this.reference.sampleRate : 0,
      processedFrames: engine?.frame ?? 0,
      params: { ...this.params },
      freeze: this.freezeInput.slice(),
      taps: engine ? Array.from(engine.taps) : [],
      intervals: this.intervals(),
      overall: this.overall(),
      clipping: this.clipStats(),
      tinyCheck: this.tinyCheckResult,
      tinyExpected: tinyExpected ? { echo: [], residual: [], h: tinyExpected.h } : null,
      formatChecks: this.formatChecks.slice(),
      chunkCheck: this.chunkCheck,
      sampleNotes: this.sampleNotes,
      sampleCaseId: this.sampleCaseId,
      running: this.running,
      elapsedMs: this.elapsedMs,
    };
  }

  /** 供核对工具读取的概览。 */
  summary(): string {
    if (!this.engine) return '未载入';
    const { frame, totalFrames } = this.engine.progress();
    return `${frame}/${totalFrames} 帧 · ${this.engine.config.taps} 抽头 · μ=${this.engine.config.mu} · leak=${this.engine.config.leak}`;
  }

  private reportError(error: unknown, title: string): void {
    const message = error instanceof WavError ? error.message : (error as Error)?.message ?? String(error);
    this.notify('error', title, message);
  }


}

function baseName(name: string): string {
  return name.replace(/\.wav$/i, '');
}

/** 只保留前 MAX_TAP_TEXT 个抽头用于文本展示（避免一次插入数千行）。 */
export function visibleTaps(taps: number[], limit = MAX_TAP_TEXT): number[] {
  return taps.slice(0, limit);
}
