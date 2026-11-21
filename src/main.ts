/** 应用入口：搭建顶栏、三栏工作区与状态栏，并把界面事件接到 Controller。 */

import { Controller, type AppSnapshot } from './app/controller';
import { StemPlayer, type Stem } from './app/player';
import { WaveformView } from './ui/waveform';
import { computeBlockEnergy } from './ui/energy';
import {
  button,
  downloadBytes,
  downloadText,
  el,
  fmt,
  fmtDb,
  fmtFrames,
  fmtPower,
  fmtSigned,
  parseNumberInput,
} from './ui/dom';
import { NLMS_CONSTANTS } from './core/types';

interface Toast {
  id: number;
}

export function createApp(root: HTMLElement): void {
  const controller = new Controller();
  const player = new StemPlayer();
  const waveform = new WaveformView();

  let currentSnapshot: AppSnapshot = controller.snapshot();
  let playTimer: number | null = null;
  let pendingEnergyTimer: number | null = null;
  let selectedRange: { start: number; end: number } | null = null;

  // ---------------------------------------------------------------- 布局
  const toastStack = el('div', { class: 'toast-stack' });
  const topbar = el('header', { class: 'topbar' });
  const workspace = el('div', { class: 'workspace' });
  const leftPanel = el('aside', { class: 'panel left-panel' });
  const stage = el('section', { class: 'stage' });
  const rightPanel = el('aside', { class: 'panel right-panel' });
  const statusbar = el('footer', { class: 'statusbar' });
  workspace.append(leftPanel, stage, rightPanel);
  root.replaceChildren(topbar, workspace, statusbar);
  root.append(toastStack);
  toastStack.classList.add('toast-stack');

  // ---------------------------------------------------------------- 顶栏
  const fileInputRef = el('input', { class: 'hidden-file', attrs: { type: 'file', accept: '.wav,audio/wav', 'data-testid': 'ref-input' } }) as HTMLInputElement;
  const micInputRef = el('input', { class: 'hidden-file', attrs: { type: 'file', accept: '.wav,audio/wav', 'data-testid': 'mic-input' } }) as HTMLInputElement;
  const sampleZipRef = el('input', { class: 'hidden-file', attrs: { type: 'file', accept: '.zip,application/zip', 'data-testid': 'zip-input' } }) as HTMLInputElement;

  fileInputRef.addEventListener('change', () => {
    const file = fileInputRef.files?.[0];
    fileInputRef.value = '';
    if (file) void controller.loadReferenceOnly(file);
  });
  micInputRef.addEventListener('change', () => {
    const file = micInputRef.files?.[0];
    micInputRef.value = '';
    if (file) void controller.loadMicrophoneOnly(file);
  });
  sampleZipRef.addEventListener('change', () => {
    const file = sampleZipRef.files?.[0];
    sampleZipRef.value = '';
    if (file) void controller.openSampleBundle(file).then(() => refresh(true));
  });

  const importRefBtn = button('选择远端参考 WAV', 'btn', () => fileInputRef.click());
  importRefBtn.dataset.testid = 'pick-ref';
  const importMicBtn = button('选择麦克风 WAV', 'btn', () => micInputRef.click());
  importMicBtn.dataset.testid = 'pick-mic';
  const sampleBtn = button('打开样例包', 'btn ghost', () => sampleZipRef.click());
  sampleBtn.dataset.testid = 'pick-zip';

  const checkpointInput = el('input', { class: 'hidden-file', attrs: { type: 'file', accept: '.json,application/json', 'data-testid': 'ckpt-input' } }) as HTMLInputElement;
  checkpointInput.addEventListener('change', async () => {
    const file = checkpointInput.files?.[0];
    checkpointInput.value = '';
    if (!file) return;
    const text = await file.text();
    await controller.resumeFromCheckpointText(text);
    refresh(true);
  });

  const saveCheckpointBtn = button('保存检查点', 'btn', async () => {
    const text = await controller.exportCheckpointText();
    if (!text) return;
    downloadText(text, checkpointName(currentSnapshot, 'checkpoint'));
    controller.notify('good', '检查点已保存', `第 ${controller.engine?.frame ?? 0} 帧 · 含抽头与前缀输出摘要`);
    refresh();
  });
  saveCheckpointBtn.dataset.testid = 'save-checkpoint';
  const resumeBtn = button('导入检查点续算', 'btn ghost', () => checkpointInput.click());
  resumeBtn.dataset.testid = 'resume-checkpoint';

  const exportWavBtn = button('导出 24 位残差 WAV', 'btn', () => {
    const result = controller.exportResidualWav();
    if (!result) return;
    downloadBytes(result.bytes, result.filename, 'audio/wav');
    if (result.stats.clipped > 0) controller.notify('warn', `已导出（${result.stats.clipped} 帧削波）`, '削波是指限幅前 |e| 越界的帧数，WAV 内已限幅到 [-1, 1-2^-23]。');
    refresh();
  });
  exportWavBtn.dataset.testid = 'export-wav';

  const exportF64Btn = button('导出浮点残差', 'btn ghost', () => {
    const result = controller.exportResidualFloat64();
    if (!result) return;
    downloadBytes(result.bytes, result.filename, 'application/octet-stream');
    controller.notify('good', '浮点残差已导出', '小端 float64 原始字节，未做任何限幅。');
  });
  exportF64Btn.dataset.testid = 'export-f64';

  const exportJsonBtn = button('导出滤波器 JSON', 'btn ghost', () => {
    const report = controller.buildFilterReport();
    if (!report) {
      controller.notify('warn', '没有可导出的滤波器', '请先导入音频。');
      return;
    }
    downloadText(`${JSON.stringify(report, null, 2)}\n`, checkpointName(currentSnapshot, 'filter'));
    controller.notify('good', '滤波器 JSON 已导出', `${controller.engine?.config.taps ?? 0} 个抽头与各区间能量`);
  });
  exportJsonBtn.dataset.testid = 'export-json';

  const title = el('div', { class: 'brand' }, [
    el('div', { class: 'brand-mark', text: '⌁' }),
    el('div', { class: 'brand-text' }, [
      el('h1', { text: '自适应回声消除校验台' }),
      el('p', { text: '逐样本 NLMS · 冻结学习区间 · 检查点续算 · 分块不变' }),
    ]),
  ]);
  const actions = el('div', { class: 'top-actions' }, [
    importRefBtn,
    importMicBtn,
    sampleBtn,
    el('div', { class: 'divider' }),
    saveCheckpointBtn,
    resumeBtn,
    el('div', { class: 'divider' }),
    exportWavBtn,
    exportF64Btn,
    exportJsonBtn,
    fileInputRef,
    micInputRef,
    sampleZipRef,
    checkpointInput,
  ]);
  topbar.append(title, actions);

  // ---------------------------------------------------------------- 左栏：参数
  const leftBody = el('div', { class: 'panel-body' });
  leftPanel.append(el('div', { class: 'panel-head' }, [el('h2', { text: '滤波器参数' })]), leftBody);

  const delayInput = numberInput('delay', '延迟帧', 0, NLMS_CONSTANTS.maxDelay, 1);
  const tapsInput = numberInput('taps', '抽头数', NLMS_CONSTANTS.minTaps, NLMS_CONSTANTS.maxTaps, 1);
  const muSlider = sliderInput('mu', '步长 μ', 0, 1, 0.001);
  const leakSlider = sliderInput('leak', '泄漏', 0, NLMS_CONSTANTS.maxLeak, 0.00001);
  const tinyToggle = toggleInput('tiny', 'tiny 核对模式（允许 2 抽头）');

  const paramError = el('p', { class: 'error-text', text: '' });

  delayInput.input.addEventListener('change', applyParams);
  tapsInput.input.addEventListener('change', applyParams);
  muSlider.input.addEventListener('change', applyParams);
  leakSlider.input.addEventListener('change', applyParams);
  tinyToggle.input.addEventListener('change', applyParams);

  function applyParams(): void {
    stopRunLoop();
    const ok = controller.setParams({
      delay: parseNumberInput(delayInput.input),
      taps: parseNumberInput(tapsInput.input),
      mu: parseNumberInput(muSlider.input),
      leak: parseNumberInput(leakSlider.input),
      tiny: tinyToggle.input.checked,
    });
    refresh(true);
    if (!ok) paramError.textContent = '参数未写入：请查看右下角提示';
    else paramError.textContent = '';
  }

  const freezeStart = el('input', { class: 'input', attrs: { type: 'number', min: 0, step: 1, 'data-testid': 'freeze-start' } }) as HTMLInputElement;
  const freezeEnd = el('input', { class: 'input', attrs: { type: 'number', min: 0, step: 1, 'data-testid': 'freeze-end' } }) as HTMLInputElement;
  const freezeAdd = button('加入冻结区间', 'btn', () => {
    const start = parseNumberInput(freezeStart);
    const end = parseNumberInput(freezeEnd);
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      controller.notify('error', '冻结区间端点必须是整数帧', '起点/终点都按帧计，终点不含。');
      return;
    }
    stopRunLoop();
    const ok = controller.addFreezeRange({ start, end });
    if (ok) refresh(true);
  });
  freezeAdd.dataset.testid = 'freeze-add';

  const loadSampleJson = button('从样例 JSON 填参', 'btn ghost', () => {
    const caseId = currentSnapshot.sampleCaseId;
    if (!caseId) {
      controller.notify('warn', '没有载入样例参数', '先打开样例包并载入 tiny 或 main 案例。');
      return;
    }
    // 只填参数，不重新载入音频（避免丢掉已经跑出的结果）。
    controller.applySampleConfig(caseId);
    refresh(true);
  });
  loadSampleJson.dataset.testid = 'load-sample-json';

  const formatBtn = button('格式样例全部自检', 'btn ghost', () => {
    if (!controller.sampleBundle) {
      controller.notify('warn', '尚未打开样例包', '先用“打开样例包”载入 zip。');
      return;
    }
    void controller.runAllFormatChecks().then(() => refresh(true));
  });
  formatBtn.dataset.testid = 'format-check';

  const chunkBtn = button('分块不变性自检', 'btn ghost', () => {
    if (!controller.engine) {
      controller.notify('warn', '没有可自检的输入', '先导入两份 WAV。');
      return;
    }
    controller.runChunkCheck([1, 17, 512, 0]);
    refresh(true);
  });
  chunkBtn.dataset.testid = 'chunk-check';

  const tinyCheckBtn = button('tiny 逐位核对', 'btn ghost', () => {
    if (!controller.tinyExpected) {
      controller.notify('warn', '当前没有 tiny 期望值', '请载入 tiny 案例（样例 JSON 含 tiny-expected）。');
      return;
    }
    controller.runTinyCheck();
    refresh(true);
  });
  tinyCheckBtn.dataset.testid = 'tiny-check';

  const resetBtn = button('清零重算', 'btn danger', () => {
    stopRunLoop();
    controller.reset();
    player.stop();
    waveform.setPlayhead(0);
    refresh(true);
  });
  resetBtn.dataset.testid = 'reset';

  const sampleSelect = el('select', { class: 'input', attrs: { 'data-testid': 'sample-select' } }) as HTMLSelectElement;
  const sampleLoad = button('载入所选案例', 'btn', () => {
    const caseId = sampleSelect.value;
    if (!caseId) {
      controller.notify('warn', '请先选择案例', undefined);
      return;
    }
    if (caseId.startsWith('format-')) {
      void controller.loadFormatSample(caseId).then(() => refresh(true));
    } else {
      void controller.loadSampleCase(caseId).then(() => refresh(true));
    }
  });
  sampleLoad.dataset.testid = 'sample-load';

  leftBody.append(
    el('div', { class: 'section' }, [
      el('div', { class: 'section-title' }, ['滤波器']),
      delayInput.row,
      tapsInput.row,
      muSlider.row,
      leakSlider.row,
      tinyToggle.row,
      paramError,
      el('p', { class: 'hint', text: `epsilon = ${NLMS_CONSTANTS.epsilon}，gate = ${NLMS_CONSTANTS.gate} 固定按包内约定；修改参数会清零重算。` }),
    ]),
    el('div', { class: 'section' }, [
      el('div', { class: 'section-title' }, ['冻结学习区间']),
      el('div', { class: 'field' }, [el('label', { text: '帧区间' }), el('div', { class: 'slider-row' }, [freezeStart, freezeEnd])]),
      freezeAdd,
      el('p', { class: 'hint', text: '起点包含、终点不含；在波形上拖拽可直接生成区间，双击区间切换冻结/解冻。' }),
    ]),
    el('div', { class: 'section' }, [
      el('div', { class: 'section-title' }, ['样例与自检']),
      el('div', { class: 'field' }, [el('label', { text: '案例' }), sampleSelect]),
      sampleLoad,
      el('div', { class: 'chip-row', attrs: { style: 'margin-top:8px' } }, [loadSampleJson]),
      el('div', { class: 'chip-row', attrs: { style: 'margin-top:6px' } }, [tinyCheckBtn, chunkBtn]),
      el('div', { class: 'chip-row', attrs: { style: 'margin-top:6px' } }, [formatBtn]),
    ]),
    el('div', { class: 'section' }, [
      el('div', { class: 'section-title' }, ['运行']),
      el('div', { class: 'run-row' }, [resetBtn]),
    ]),
  );

  // ---------------------------------------------------------------- 中央：波形 + 播放
  const waveCard = el('div', { class: 'viewport-card', attrs: { style: 'flex:0 0 auto' } });
  const waveScroll = el('div', { class: 'wave-scroll' });
  waveScroll.append(waveform.canvas);
  waveform.observeContainer(waveScroll);
  const playBtn = el('button', { class: 'play-btn', text: '▶', attrs: { type: 'button', 'data-testid': 'play', title: '播放 / 暂停' }, on: { click: () => togglePlay() } });
  const stopBtn = el('button', { class: 'play-btn', text: '■', attrs: { type: 'button', 'data-testid': 'stop', title: '停止并回到起点' }, on: { click: () => { player.stop(); waveform.setPlayhead(0); updateTransport(); } } });
  const stemButtons: Record<Stem, HTMLButtonElement> = {
    microphone: el('button', { class: 'active', text: '原音 d', attrs: { type: 'button', 'data-testid': 'stem-mic' }, on: { click: () => selectStem('microphone') } }),
    echo: el('button', { text: '估计回声 y', attrs: { type: 'button', 'data-testid': 'stem-echo' }, on: { click: () => selectStem('echo') } }),
    residual: el('button', { text: '残差 e', attrs: { type: 'button', 'data-testid': 'stem-residual' }, on: { click: () => selectStem('residual') } }),
  };
  const stemSelect = el('div', { class: 'stem-select' }, [stemButtons.microphone, stemButtons.echo, stemButtons.residual]);
  const timeReadout = el('span', { class: 'time-readout', text: '0:00 / 0:00', attrs: { 'data-testid': 'time-readout' } });
  const progressBar = el('div', { class: 'progress-bar', attrs: { 'data-testid': 'progress' } });
  const progressWrap = el('div', { class: 'progress-wrap' }, [progressBar]);

  const playRate = el('select', { class: 'input', attrs: { style: 'width:96px;font-family:var(--sans)', 'data-testid': 'chunk-size' } }) as HTMLSelectElement;
  for (const value of ['单帧', '64 帧', '512 帧', '4096 帧', '整段']) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    playRate.append(option);
  }
  playRate.value = '4096 帧';
  const stepBtn = button('分块处理一步', 'btn ghost', () => {
    const size = parseChunkSize(playRate.value);
    const progressed = controller.advance(size);
    if (progressed === 0) controller.notify('info', '已经处理到末尾', undefined);
    refresh();
    scheduleEnergy();
    syncPlayerData();
    // 单步结束后把已处理位置播一下，直接听这一步的残差。
    if (progressed > 0 && player.hasAudio) waveform.setPlayhead(controller.engine?.frame ?? 0);
  });
  stepBtn.dataset.testid = 'step-chunk';
  let runHandle: number | null = null;
  function stopRunLoop(): void {
    if (runHandle !== null) {
      window.clearTimeout(runHandle);
      runHandle = null;
    }
  }
  function pump(): void {
    if (!controller.engine) {
      stopRunLoop();
      return;
    }
    // 每片 4096 帧（约 60–200 ms 的音频），保持界面可响应。
    const progressed = controller.advance(4096);
    refresh();
    if (progressed === 0 || controller.engine.frame >= controller.engine.totalFrames) {
      stopRunLoop();
      controller.endRun();
      refresh();
      scheduleEnergy(true);
      syncPlayerData();
      return;
    }
    if (progressed > 0) syncPlayerData();
    runHandle = window.setTimeout(pump, 0);
  }
  const runBtn = button('运行到结尾', 'btn primary', () => {
    if (!controller.engine) {
      controller.notify('warn', '尚未导入音频', '先选择远端参考与麦克风 WAV。');
      return;
    }
    if (controller.engine.frame >= controller.engine.totalFrames) {
      controller.notify('info', '已经处理到末尾', '如需重算请点“清零重算”。');
      return;
    }
    stopRunLoop();
    controller.beginRun();
    refresh();
    pump();
  });
  runBtn.dataset.testid = 'run';
  const pauseBtn = button('暂停', 'btn', () => {
    stopRunLoop();
    controller.pause();
    scheduleEnergy();
    syncPlayerData();
    refresh();
  });
  pauseBtn.dataset.testid = 'pause';

  const transport = el('div', { class: 'transport' }, [
    el('div', { class: 'transport-left' }, [playBtn, stopBtn, stemSelect]),
    progressWrap,
    timeReadout,
    el('div', { class: 'run-row' }, [playRate, stepBtn, runBtn, pauseBtn]),
  ]);
  const stemHint = el('p', { class: 'transport-hint', text: '试听共用同一播放位置：原音 d / 估计回声 y / 残差 e；拖拽波形选区，单击定位。' });
  waveCard.append(waveScroll, transport, stemHint);
  stage.append(waveCard);

  // ---------------------------------------------------------------- 右栏：页签
  const tabs: Array<{ key: string; label: string }> = [
    { key: 'energy', label: '能量' },
    { key: 'taps', label: '抽头' },
    { key: 'checks', label: '核对' },
    { key: 'notes', label: '说明' },
  ];
  let activeTab = 'energy';
  const tabBar = el('div', { class: 'tabs' });
  const tabBodies = new Map<string, HTMLElement>();
  for (const tab of tabs) {
    const node = el('button', { class: 'tab', text: tab.label, attrs: { type: 'button', 'data-testid': `tab-${tab.key}` }, on: { click: () => { activeTab = tab.key; refreshTabs(); } } });
    node.dataset.tab = tab.key;
    tabBar.append(node);
    const body = el('div', { class: 'tab-body', attrs: { 'data-tab-body': tab.key } });
    tabBodies.set(tab.key, body);
  }
  rightPanel.append(tabBar, ...Array.from(tabBodies.values()));

  function refreshTabs(): void {
    for (const node of Array.from(tabBar.children)) {
      const key = (node as HTMLElement).dataset.tab ?? '';
      node.classList.toggle('active', key === activeTab);
    }
    for (const [key, body] of tabBodies) {
      body.hidden = key !== activeTab;
    }
  }

  // 能量面板
  const energyBody = tabBodies.get('energy')!;
  const energyMetrics = el('div', { class: 'metric-grid' });
  const intervalsList = el('div', { class: 'interval-list' });
  const intervalStartInput = el('input', { class: 'input', attrs: { type: 'number', min: 0, step: 1, 'data-testid': 'analysis-start' } }) as HTMLInputElement;
  const intervalEndInput = el('input', { class: 'input', attrs: { type: 'number', min: 0, step: 1, 'data-testid': 'analysis-end' } }) as HTMLInputElement;
  const intervalAdd = button('加入分析区间', 'btn ghost', () => {
    const start = parseNumberInput(intervalStartInput);
    const end = parseNumberInput(intervalEndInput);
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      controller.notify('error', '分析区间端点必须是整数帧', undefined);
      return;
    }
    const existing = currentSnapshot.intervals.filter((item) => !item.freeze).map((item) => ({ start: item.start, end: item.end }));
    controller.setAnalysisRanges([...existing, { start, end }]);
    refresh();
  });
  intervalAdd.dataset.testid = 'analysis-add';
  energyBody.append(
    el('div', { class: 'section' }, [
      el('div', { class: 'section-title' }, ['整体']),
      energyMetrics,
      el('div', { class: 'metric', attrs: { 'data-testid': 'clip-stat' } }, [
        el('span', { class: 'label', text: '24 位削波（限幅前越界帧）' }),
        el('span', { class: 'value', text: '0' }),
      ]),
    ]),
    el('div', { class: 'section' }, [
      el('div', { class: 'section-title' }, ['区间能量（均方）']),
      intervalsList,
    ]),
    el('div', { class: 'section' }, [
      el('div', { class: 'section-title' }, ['额外分析区间']),
      el('div', { class: 'field' }, [el('label', { text: '帧区间' }), el('div', { class: 'slider-row' }, [intervalStartInput, intervalEndInput])]),
      intervalAdd,
    ]),
  );

  // 抽头面板
  const tapsBody = tabBodies.get('taps')!;
  const tapsCanvas = el('canvas', { class: 'tap-chart', attrs: { width: 300, height: 120, 'data-testid': 'tap-chart' } }) as HTMLCanvasElement;
  const tapsTable = el('table', { class: 'tap-table', attrs: { 'data-testid': 'tap-table' } });
  const tapsNote = el('p', { class: 'hint', text: '' });
  tapsBody.append(el('div', { class: 'section' }, [el('div', { class: 'section-title' }, ['抽头幅度']), tapsCanvas, tapsNote]), tapsTable);

  // 核对面板
  const checksBody = tabBodies.get('checks')!;
  const checksList = el('div', { class: 'check-list', attrs: { 'data-testid': 'check-list' } });
  checksBody.append(
    el('div', { class: 'section' }, [el('div', { class: 'section-title' }, ['样例与自检结果']), checksList]),
  );

  // 说明面板
  const notesBody = tabBodies.get('notes')!;
  const notesText = el('div', { class: 'notes', attrs: { 'data-testid': 'notes' } });
  notesBody.append(notesText);

  // ---------------------------------------------------------------- 状态栏
  const statusItems = {
    input: el('span', { class: 'item', attrs: { 'data-testid': 'status-input' }, text: '未导入' }),
    params: el('span', { class: 'item', attrs: { 'data-testid': 'status-params' }, text: '' }),
    frames: el('span', { class: 'item', attrs: { 'data-testid': 'status-frames' }, text: '' }),
    elapsed: el('span', { class: 'item', attrs: { 'data-testid': 'status-elapsed' }, text: '' }),
  };
  statusbar.append(statusItems.input, el('div', { class: 'grow' }), statusItems.params, statusItems.frames, statusItems.elapsed);

  // ---------------------------------------------------------------- 交互接线
  waveform.onSeek = (frame) => {
    player.seek(frame);
    waveform.setPlayhead(frame);
    updateTransport();
  };
  waveform.onSelection = (selection) => {
    selectedRange = selection;
    freezeStart.value = String(selection.start);
    freezeEnd.value = String(selection.end);
    intervalStartInput.value = String(selection.start);
    intervalEndInput.value = String(selection.end);
    controller.notify('info', '已选中区间', `[${selection.start}, ${selection.end})，点“加入冻结区间”即可在波形上标记。`);
  };
  waveform.onFreezeToggle = (range) => {
    const index = controller.freezeInput.findIndex((item) => item.start === range.start && item.end === range.end);
    if (index >= 0) {
      controller.removeFreezeRange(index);
      controller.notify('info', '已解除冻结', `[${range.start}, ${range.end})`);
      refresh(true);
    } else {
      controller.addFreezeRange(range);
      controller.notify('info', '已设为冻结', `[${range.start}, ${range.end})`);
      refresh(true);
    }
  };

  player.setOnEnd(() => {
    stopPlayTick();
    waveform.setPlayhead(player.positionFrame());
    updateTransport();
  });

  function selectStem(stem: Stem): void {
    player.setStem(stem);
    for (const key of Object.keys(stemButtons) as Stem[]) {
      stemButtons[key].classList.toggle('active', key === stem);
    }
    updateTransport();
  }

  function togglePlay(): void {
    if (!player.hasAudio) {
      controller.notify('warn', '还没有音频', '先导入两份 WAV 并运行一次。');
      return;
    }
    if (player.isPlaying) {
      player.pause();
      stopPlayTick();
    } else {
      syncPlayerData();
      player.play();
      startPlayTick();
    }
    updateTransport();
  }

  function startPlayTick(): void {
    stopPlayTick();
    playTimer = window.setInterval(() => {
      const frame = player.positionFrame();
      waveform.setPlayhead(frame);
      updateTransport();
    }, 60);
    playBtn.textContent = '❚❚';
  }

  function stopPlayTick(): void {
    if (playTimer !== null) {
      window.clearInterval(playTimer);
      playTimer = null;
    }
    playBtn.textContent = '▶';
  }

  function updateTransport(): void {
    const sampleRate = player.sampleRate || currentSnapshot.sampleRate;
    const total = player.numFrames || currentSnapshot.totalFrames;
    const frame = player.positionFrame();
    const ratio = total > 0 ? frame / total : 0;
    progressBar.style.width = `${(ratio * 100).toFixed(2)}%`;
    timeReadout.textContent = `${formatClock(frame, sampleRate)} / ${formatClock(total, sampleRate)}`;
  }

  // ---------------------------------------------------------------- 刷新
  controller.onNotice((notice) => {
    const toast: Toast = { id: Date.now() + Math.random() };
    const node = el('div', { class: `toast ${notice.kind}` }, [
      el('strong', { text: notice.title }),
      notice.detail ? el('span', { text: notice.detail }) : null,
    ]);
    node.dataset.toast = String(toast.id);
    toastStack.append(node);
    window.setTimeout(() => node.remove(), notice.kind === 'error' ? 6500 : 3800);
    renderChecks();
  });

  function refresh(structural = false): void {
    currentSnapshot = controller.snapshot();
    const snap = currentSnapshot;

    // 顶栏按钮可用性
    saveCheckpointBtn.disabled = !snap.hasInput || !controller.engine;
    resumeBtn.disabled = !snap.hasInput;
    exportWavBtn.disabled = snap.processedFrames === 0;
    exportF64Btn.disabled = snap.processedFrames === 0;
    exportJsonBtn.disabled = !snap.hasInput;
    tinyCheckBtn.disabled = !controller.tinyExpected;
    chunkBtn.disabled = !snap.hasInput;
    formatBtn.disabled = !controller.sampleBundle;
    resetBtn.disabled = !snap.hasInput;
    stepBtn.disabled = !snap.hasInput || snap.processedFrames >= snap.totalFrames || controller.running;
    pauseBtn.disabled = !controller.running;

    // 参数回填（仅在结构变化时写回，避免打断输入）。
    if (structural) {
      delayInput.input.value = String(snap.params.delay);
      tapsInput.input.value = String(snap.params.taps);
      muSlider.input.value = String(snap.params.mu);
      leakSlider.input.value = String(snap.params.leak);
      tinyToggle.input.checked = snap.params.tiny;
      freezeStart.value = selectedRange ? String(selectedRange.start) : '';
      freezeEnd.value = selectedRange ? String(selectedRange.end) : '';
      syncSliderFills();
      refreshSampleOptions();
    }

    // 状态栏
    statusItems.input.textContent = snap.hasInput
      ? `${snap.referenceName} / ${snap.microphoneName} · ${snap.sampleRate}Hz · ${snap.bitDepth} 位 · ${fmtFrames(snap.totalFrames, snap.sampleRate)}`
      : '未导入';
    statusItems.params.textContent = `延迟 ${snap.params.delay} · ${snap.params.taps} 抽头 · μ ${snap.params.mu} · leak ${snap.params.leak}${snap.params.tiny ? ' · tiny' : ''}`;
    statusItems.frames.textContent = `进度 ${snap.processedFrames}/${snap.totalFrames}`;
    statusItems.elapsed.textContent = snap.elapsedMs !== null ? `耗时 ${snap.elapsedMs.toFixed(0)} ms` : '';

    // 波形
    const engine = controller.engine;
    if (engine && snap.hasInput) {
      waveform.setData({
        sampleRate: snap.sampleRate,
        totalFrames: snap.totalFrames,
        processedFrames: snap.processedFrames,
        reference: engine.reference,
        microphone: engine.microphone,
        echo: engine.echo,
        residual: engine.residual,
        freeze: snap.freeze,
        analysis: controller.analysisRanges,
      });
    } else {
      waveform.setData({
        sampleRate: snap.sampleRate || 16000,
        totalFrames: 0,
        processedFrames: 0,
        reference: new Float64Array(0),
        microphone: new Float64Array(0),
        echo: new Float64Array(0),
        residual: new Float64Array(0),
        freeze: [],
        analysis: [],
      });
    }
    updateTransport();

    // 能量面板
    renderEnergy();
    renderTaps();
    renderChecks();
    notesText.textContent = snap.sampleNotes || controller.sampleNotes || '尚未打开样例包。载入后这里会显示样例说明与数值约定。';

    if (structural) scheduleEnergy(true);
  }

  function renderEnergy(): void {
    const snap = currentSnapshot;
    const overall = snap.overall;
    energyMetrics.replaceChildren(
      metric('整体 d 均方', overall ? fmtPower(overall.microphoneMeanSquare) : '无数据'),
      metric('整体 e 均方', overall ? fmtPower(overall.residualMeanSquare) : '无数据'),
      metric('整体 ERLE', overall ? fmtDb(overall.erleDb) : '无数据'),
      metric('峰值 |e|', fmt(snap.clipping.peak, 4)),
      metric('耗时', snap.elapsedMs !== null ? `${snap.elapsedMs.toFixed(0)} ms` : '—'),
    );
    const clipValue = document.querySelector('[data-testid="clip-stat"] .value');
    if (clipValue) {
      clipValue.textContent = String(snap.clipping.clipped);
      clipValue.className = `value ${snap.clipping.clipped > 0 ? 'bad' : 'good'}`;
    }

    intervalsList.replaceChildren();
    for (const interval of snap.intervals) {
      const row = el('div', { class: `interval-row ${interval.freeze ? 'freeze' : 'analysis'}`, attrs: { 'data-testid': 'interval-row' } }, [
        el('div', {}, [
          el('div', { class: 'interval-range', text: `[${interval.start}, ${interval.end})` }),
          el('div', { class: 'interval-stats', text: interval.processedFrames === 0 ? '无数据（尚未处理）' : `${interval.processedFrames}/${interval.totalFrames} 帧已处理` }),
        ]),
        el('div', { class: 'interval-stats' }, [
          `y ${fmtPower(interval.echoMeanSquare)}`,
          el('br'),
          `d ${fmtPower(interval.microphoneMeanSquare)}`,
          el('br'),
          `e ${fmtPower(interval.residualMeanSquare)}`,
          el('br'),
          interval.erleDb === null ? 'ERLE 无数据' : `ERLE ${fmtDb(interval.erleDb)}`,
        ]),
        el('button', {
          class: 'interval-remove',
          text: '×',
          title: interval.freeze ? '移除此冻结区间' : '移除此分析区间',
          attrs: { type: 'button', 'data-testid': interval.freeze ? 'freeze-remove' : 'analysis-remove' },
          on: {
            click: () => {
              if (interval.freeze) {
                const index = controller.freezeInput.findIndex((item) => item.start === interval.start && item.end === interval.end);
                if (index >= 0) controller.removeFreezeRange(index);
                refresh(true);
              } else {
                const next = controller.analysisRanges.filter((item) => !(item.start === interval.start && item.end === interval.end));
                controller.setAnalysisRanges(next);
                refresh();
              }
            },
          },
        }),
      ]);
      intervalsList.append(row);
    }
    if (snap.intervals.length === 0) {
      intervalsList.append(el('p', { class: 'hint', text: '没有区间。拖拽波形后点“加入冻结区间”，或使用样例 JSON 的 freeze。' }));
    }
  }

  function renderTaps(): void {
    const snap = currentSnapshot;
    const taps = snap.taps;
    tapsNote.textContent = taps.length === 0 ? '尚未组建滤波器。' : `${taps.length} 个抽头，本页延迟 ${snap.params.delay} 帧。`;
    drawTapChart(tapsCanvas, taps);
    if (taps.length === 0) {
      tapsTable.replaceChildren(el('caption', { text: '' }));
      tapsTable.replaceChildren();
      return;
    }
    const max = Math.max(...taps.map((value) => Math.abs(value)), 1e-12);
    const rows: HTMLElement[] = [];
    const head = el('thead', {}, [
      el('tr', {}, [el('th', { text: 'j' }), el('th', { text: 'h[j]' }), el('th', { text: 'dB' }), el('th', { text: '幅度条' })]),
    ]);
    rows.push(head);
    const body = el('tbody', {});
    for (let j = 0; j < taps.length; j += 1) {
      const value = taps[j];
      const nonzero = Math.abs(value) > 1e-9;
      const barWidth = Math.max(0, Math.min(96, (Math.abs(value) / max) * 96));
      body.append(
        el('tr', {}, [
          el('td', { text: String(j) }),
          el('td', { class: nonzero ? 'nonzero' : '', text: fmtSigned(value) }),
          el('td', { text: absDb(value) }),
          el('td', {}, [el('div', { attrs: { style: `height:4px;width:${barWidth}px;background:${nonzero ? 'var(--accent)' : '#1d2835'};border-radius:2px` } })]),
        ]),
      );
    }
    rows.push(body);
    tapsTable.replaceChildren(...rows);
  }

  function renderChecks(): void {
    const snap = currentSnapshot;
    const rows: HTMLElement[] = [];
    if (snap.tinyExpected) {
      const check = snap.tinyCheck;
      rows.push(
        checkRow(
          check ? (check.passed ? 'good' : 'bad') : 'info',
          check ? (check.passed ? 'tiny 逐位核对通过' : 'tiny 逐位核对未通过') : 'tiny 核对待运行',
          check
            ? `逐位相等：${check.exact ? '是' : '否'} · 最大误差 echo ${check.maxEchoError} / residual ${check.maxResidualError} / h ${check.maxTapError}`
            : `期望值 ${snap.tinyExpected.echo.length || '—'} 帧、${snap.tinyExpected.h.length} 个抽头`,
        ),
      );
    }
    if (snap.chunkCheck) {
      rows.push(
        checkRow(
          snap.chunkCheck.passed ? 'good' : 'bad',
          snap.chunkCheck.passed ? '分块不变性通过' : '分块不变性失败',
          `尺寸 ${snap.chunkCheck.sizes.join(' / ')}（0 = 整段）· 最大差异 y ${snap.chunkCheck.maxEchoDifference} / e ${snap.chunkCheck.maxResidualDifference} / h ${snap.chunkCheck.maxTapDifference}`,
        ),
      );
    }
    for (const check of snap.formatChecks) {
      rows.push(
        checkRow(
          check.passed ? 'good' : 'bad',
          `${check.name} 格式自检${check.passed ? '通过' : '失败'}`,
          `${check.sampleRate}Hz · ${check.bitDepth} 位 · ${check.frames} 帧 · 24 位往返 ${check.roundTripLsb.toFixed(3)} LSB · 峰值 ${check.peak.toFixed(4)}${check.reasons.length ? `\n${check.reasons.join('\n')}` : ''}`,
        ),
      );
    }
    if (rows.length === 0) {
      rows.push(el('p', { class: 'hint', text: '载入样例包后可在这里查看 tiny 逐位核对、分块不变性与 6 个格式样例的自检结果。' }));
    }
    checksList.replaceChildren(...rows);
  }

  function checkRow(kind: string, title: string, detail: string): HTMLElement {
    const status = kind === 'good' ? '通过' : kind === 'bad' ? '失败' : '待运行';
    return el('div', { class: `check-row ${kind}` }, [
      el('div', { class: 'title' }, [el('span', { text: title }), el('span', { class: `chip ${kind}`, text: status })]),
      el('div', { class: 'detail', text: detail }),
    ]);
  }

  function refreshSampleOptions(): void {
    const cases = controller.sampleCases;
    const previous = sampleSelect.value;
    sampleSelect.replaceChildren();
    sampleSelect.append(el('option', { text: '— 选择样例 —', attrs: { value: '' } }));
    for (const item of cases) {
      sampleSelect.append(el('option', { text: item.label, attrs: { value: item.id } }));
    }
    if (previous && cases.some((item) => item.id === previous)) sampleSelect.value = previous;
    else if (currentSnapshot.sampleCaseId) sampleSelect.value = currentSnapshot.sampleCaseId;
    sampleLoad.disabled = cases.length === 0;
  }

  // ---------------------------------------------------------------- 能量带（节流）
  function scheduleEnergy(immediate = false): void {
    if (pendingEnergyTimer !== null) {
      window.clearTimeout(pendingEnergyTimer);
      pendingEnergyTimer = null;
    }
    const run = () => {
      pendingEnergyTimer = null;
      const engine = controller.engine;
      if (!engine) {
        waveform.setEnergy({ windowFrames: 1, blocks: 0, microphone: new Float64Array(0), residual: new Float64Array(0), echo: new Float64Array(0) });
        return;
      }
      waveform.setEnergy(
        computeBlockEnergy(engine.totalFrames, engine.frame, engine.microphone, engine.echo, engine.residual),
      );
    };
    if (immediate) run();
    else pendingEnergyTimer = window.setTimeout(run, 180);
  }

  // 以引擎对象身份判断是否需要整体重建缓冲：换输入、改参数、恢复检查点都会
  // 产生新引擎，此时 echo 与残差都可能整段不同，只换残差会留下过期的回声。
  let playerEngine: unknown = null;
  function syncPlayerData(): void {
    const buffers = controller.stemBuffers();
    const engine = controller.engine;
    if (!buffers || !engine) {
      playerEngine = null;
      player.load({
        sampleRate: 16000,
        numFrames: 0,
        microphone: new Float64Array(0),
        echo: new Float64Array(0),
        residual: new Float64Array(0),
      });
      return;
    }
    if (engine !== playerEngine) {
      playerEngine = engine;
      player.load(buffers);
    } else {
      player.refreshResidual(buffers);
    }
  }

  // 参数滑块数值联动显示
  function syncSliderFills(): void {
    for (const slider of [muSlider, leakSlider]) {
      const ratio = (Number(slider.input.value) - Number(slider.input.min)) / (Number(slider.input.max) - Number(slider.input.min) || 1);
      slider.input.style.setProperty('--fill', `${(ratio * 100).toFixed(1)}%`);
      slider.value.textContent = slider.input.value;
    }
  }
  muSlider.input.addEventListener('input', syncSliderFills);
  leakSlider.input.addEventListener('input', syncSliderFills);

  refreshTabs();
  refresh(true);
  waveform.setEnergy({ windowFrames: 1, blocks: 0, microphone: new Float64Array(0), residual: new Float64Array(0), echo: new Float64Array(0) });

  // 暴露核对接口（端到端测试与手动核对都走同一条路径）。
  Object.defineProperty(window, 'scenario', {
    value: {
      importFiles: async (ref: File, mic: File) => {
        stopRunLoop();
        await controller.loadFiles(ref, mic);
        refresh(true);
        syncPlayerData();
      },
      loadReferenceOnly: async (file: File) => {
        await controller.loadReferenceOnly(file);
        refresh(true);
      },
      loadMicrophoneOnly: async (file: File) => {
        await controller.loadMicrophoneOnly(file);
        refresh(true);
      },
      loadSampleCase: async (id: string) => {
        stopRunLoop();
        if (id.startsWith('format-')) await controller.loadFormatSample(id);
        else await controller.loadSampleCase(id);
        refresh(true);
        syncPlayerData();
      },
      openSampleZip: async (file: File) => {
        await controller.openSampleBundle(file);
        refresh(true);
      },
      setParams: (params: Partial<typeof controller.params>) => {
        const ok = controller.setParams(params);
        refresh(true);
        return ok;
      },
      setFreeze: (ranges: Array<{ start: number; end: number }>) => {
        const ok = controller.setFreeze(ranges);
        refresh(true);
        return ok;
      },
      applySampleConfig: (caseId: string) => {
        const ok = controller.applySampleConfig(caseId);
        refresh(true);
        return ok;
      },
      run: () => {
        controller.runToEnd();
        refresh();
        scheduleEnergy(true);
        syncPlayerData();
      },
      advance: (frames: number) => {
        const progressed = controller.advance(frames);
        refresh();
        scheduleEnergy();
        syncPlayerData();
        return progressed;
      },
      reset: () => {
        controller.reset();
        refresh(true);
      },
      checkpointText: () => controller.exportCheckpointText(),
      resumeCheckpoint: async (text: string) => {
        stopRunLoop();
        const ok = await controller.resumeFromCheckpointText(text);
        refresh(true);
        syncPlayerData();
        return ok;
      },
      runChunkCheck: (sizes: number[]) => {
        controller.runChunkCheck(sizes);
        refresh();
      },
      runTinyCheck: () => {
        controller.runTinyCheck();
        refresh();
      },
      runFormatChecks: async () => {
        await controller.runAllFormatChecks();
        refresh();
      },
      snapshot: () => controller.snapshot(),
      exportResidual: () => {
        const result = controller.exportResidualWav();
        return result ? { stats: result.stats, filename: result.filename } : null;
      },
      exportFloat64: () => {
        const result = controller.exportResidualFloat64();
        return result ? { filename: result.filename } : null;
      },
      reportResidualWavBytes: () => {
        const result = controller.exportResidualWav();
        if (!result) return null;
        return { bytes: Array.from(result.bytes), stats: result.stats };
      },
      report: () => controller.buildFilterReport(),
      clipStats: () => controller.clipStats(),
      waveformFrameAt: (ratio: number) => Math.round(ratio * (controller.engine?.totalFrames ?? 0)),
      setStem: (stem: Stem) => selectStem(stem),
      play: () => {
        if (player.hasAudio) {
          player.play();
          startPlayTick();
        }
        return player.isPlaying;
      },
      pause: () => {
        player.pause();
        stopPlayTick();
      },
      notices: () => controller.history(),
    },
    writable: false,
    enumerable: false,
    configurable: false,
  });
}

// ---------------------------------------------------------------------- 控件工厂

interface NumberField {
  row: HTMLElement;
  input: HTMLInputElement;
}

function numberInput(testid: string, label: string, min: number, max: number, step: number, value = 0): NumberField {
  const input = el('input', { class: 'input', attrs: { type: 'number', min, max, step, value, 'data-testid': testid } }) as HTMLInputElement;
  const suffix = el('span', { class: 'suffix', text: `0–${max}` });
  const row = el('div', { class: 'field' }, [el('label', { text: label }), el('div', { class: 'slider-row' }, [input, suffix])]);
  return { row, input };
}

interface SliderField {
  row: HTMLElement;
  input: HTMLInputElement;
  value: HTMLElement;
}

function sliderInput(testid: string, label: string, min: number, max: number, step: number, value = 0): SliderField {
  const input = el('input', {
    class: 'slider',
    attrs: { type: 'range', min, max, step, value, 'data-testid': testid },
  }) as HTMLInputElement;
  input.style.setProperty('--fill', '30%');
  const readout = el('span', { class: 'suffix', text: String(value) });
  const row = el('div', { class: 'field' }, [el('label', { text: label }), el('div', { class: 'slider-row' }, [input, readout])]);
  return { row, input, value: readout };
}

interface ToggleField {
  row: HTMLElement;
  input: HTMLInputElement;
}

function toggleInput(testid: string, label: string): ToggleField {
  const input = el('input', { attrs: { type: 'checkbox', 'data-testid': testid } }) as HTMLInputElement;
  const track = el('span', { class: 'track' });
  const thumb = el('span', { class: 'thumb' });
  const wrap = el('span', { class: 'switch' }, [input, track, thumb]);
  wrap.addEventListener('click', () => {
    input.checked = !input.checked;
    input.dispatchEvent(new Event('change'));
  });
  const row = el('div', { class: 'toggle-row' }, [el('span', { text: label }), wrap]);
  return { row, input };
}

function metric(label: string, value: string): HTMLElement {
  return el('div', { class: 'metric' }, [el('span', { class: 'label', text: label }), el('span', { class: 'value', text: value })]);
}

function absDb(value: number): string {
  const abs = Math.abs(value);
  if (abs < 1e-12) return '−∞';
  return `${(20 * Math.log10(abs)).toFixed(1)}`;
}

function formatClock(frame: number, sampleRate: number): string {
  if (!sampleRate) return '0:00';
  if (frame / sampleRate < 0.5) return `${frame}帧`;
  const seconds = frame / sampleRate;
  const whole = Math.floor(seconds);
  const tenths = Math.floor((seconds - whole) * 10);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}.${tenths}`;
}

function parseChunkSize(label: string): number {
  switch (label) {
    case '单帧':
      return 1;
    case '64 帧':
      return 64;
    case '512 帧':
      return 512;
    case '4096 帧':
      return 4096;
    case '整段':
      return 0;
    default:
      return 4096;
  }
}

function checkpointName(snapshot: AppSnapshot, suffix: string): string {
  const base = snapshot.microphoneName.replace(/\.wav$/i, '') || 'echo';
  return `${base}-${suffix}.json`;
}

function drawTapChart(canvas: HTMLCanvasElement, taps: number[]): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#0b111a';
  ctx.fillRect(0, 0, width, height);
  if (taps.length === 0) return;
  const maxAbs = Math.max(...taps.map((value) => Math.abs(value), 1e-12));
  ctx.strokeStyle = 'rgba(102,117,138,0.3)';
  ctx.beginPath();
  ctx.moveTo(0, height / 2 + 0.5);
  ctx.lineTo(width, height / 2 + 0.5);
  ctx.stroke();
  const step = width / Math.max(1, taps.length);
  for (let j = 0; j < taps.length; j += 1) {
    const value = taps[j];
    const bar = (Math.abs(value) / maxAbs) * (height / 2 - 4);
    const x = j * step + step * 0.2;
    const barWidth = Math.max(1, step * 0.6);
    ctx.fillStyle = value >= 0 ? '#f3b455' : '#5fd4d6';
    if (value >= 0) ctx.fillRect(x, height / 2 - bar, barWidth, bar);
    else ctx.fillRect(x, height / 2, barWidth, bar);
  }
}
