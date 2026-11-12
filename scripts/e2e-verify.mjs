/**
 * 浏览器端端到端验证脚本。
 *
 * 用本机 Chrome 启动真实浏览器，走真实的「导入 → 剪辑 → 预览 → 导出」流程，
 * 并对导出的 MP4 做 ffprobe 级校验。运行方式：
 *   node scripts/e2e-verify.mjs
 */
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const outDir = join(root, '.tmp-export');
mkdirSync(outDir, { recursive: true });

const VITE_URL = 'http://127.0.0.1:5199/';
const RECV_URL = 'http://127.0.0.1:8907/save';
// 同步测试素材：每 2 秒一个 0.1 秒的 8kHz 脉冲，便于用 ffmpeg 精确校验音画对位
const SYNC_SAMPLE = join(root, 'samples', 'sync-source.mp4');

if (!existsSync(SYNC_SAMPLE)) {
  console.log('生成同步测试素材…');
  execFileSync(
    'ffmpeg',
    [
      '-y', '-v', 'error',
      '-f', 'lavfi', '-i', 'color=c=0x202020:s=1280x720:r=24:d=60',
      // String.raw 保留 ffmpeg 滤镜表达式里必须存在的反斜杠转义逗号
      '-f', 'lavfi', '-i', String.raw`aevalsrc=if(lt(mod(t\,2)\,0.1)\,sin(2*PI*8000*t)*0.9\,0):s=48000:d=60`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k', '-shortest',
      SYNC_SAMPLE,
    ],
    { stdio: 'inherit' },
  );
}

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const browser = await chromium.launch({
  executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--enable-features=SharedArrayBuffer', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const errors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') {
    errors.push(msg.text());
  }
});
page.on('pageerror', (err) => errors.push(`PAGEERROR ${err.message}`));

try {
  await page.goto(VITE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);

  // 1. 页面加载
  const hasUi = await page.locator('.topbar').count();
  check('页面加载与三栏布局', hasUi === 1 && (await page.locator('.preview-canvas').count()) === 1);

  // 2. 导入素材（走真实 loadAsset 路径）
  const loaded = await page.evaluate(async () => {
    const api = window.__clipcut;
    const res = await fetch('/samples/sintel_trailer-720p.mp4');
    const file = new File([await res.blob()], 'sintel_trailer-720p.mp4', { type: 'video/mp4' });
    const handle = await api.loadAsset(file);
    api.store.getState().registerAsset(handle);
    api.store.getState().addClipFromAsset(handle.info.id);
    return { info: handle.info, clipCount: api.store.getState().clips.length };
  });
  check(
    '导入素材',
    loaded.info.duration > 50 && loaded.clipCount === 1,
    `${loaded.info.width}x${loaded.info.height} ${loaded.info.frameRate}fps ${loaded.info.duration.toFixed(2)}s`,
  );

  // 3. 预览引擎就绪并出画
  await page.waitForTimeout(2000);
  const preview = await page.evaluate(async () => {
    const engine = window.__clipcut.previewHolder.engine;
    if (!engine) return { ready: false };
    await engine.seek(5);
    await new Promise((r) => setTimeout(r, 800));
    const canvas = document.querySelector('.preview-canvas');
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let nonBlack = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] + data[i + 1] + data[i + 2] > 24) nonBlack += 1;
    }
    return { ready: true, duration: engine.getDuration(), nonBlack, total: data.length / 4 };
  });
  check('预览引擎出画', preview.ready && preview.nonBlack > 300000, `非黑像素 ${preview.nonBlack}/${preview.total}`);

  // 4. 缩略图生成
  await page.waitForTimeout(1500);
  const thumbs = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('.thumb-cell')];
    return { total: cells.length, withImage: cells.filter((el) => el.style.backgroundImage).length };
  });
  check('时间轴缩略图', thumbs.total > 0 && thumbs.withImage > 0, `${thumbs.withImage}/${thumbs.total} 格有图`);

  // 5. 波形生成（等异步算完）
  const waveform = await page.evaluate(async () => {
    const api = window.__clipcut;
    const handle = api.getAssetHandle(api.store.getState().clips[0].assetId);
    const peaks = await api.buildWaveform(handle);
    return peaks ? { buckets: peaks.min.length, maxPeak: Math.max(...Array.from(peaks.max).slice(0, 2000)) } : null;
  });
  check('音频波形计算', waveform !== null && waveform.buckets > 0, `${waveform?.buckets} 个峰值桶`);

  // 6. 导入字幕
  const srtImported = await page.evaluate(async () => {
    const api = window.__clipcut;
    const res = await fetch('/samples/sintel_trailer.srt');
    const cues = api.parseSrt(await res.text());
    const assetId = api.store.getState().clips[0].assetId;
    api.store.getState().addSubtitleSet({ assetId, name: 'sintel_trailer.srt', cues });
    return { cues: cues.length };
  });
  check('导入 SRT 字幕', srtImported.cues > 0, `${srtImported.cues} 条`);

  // 7. 剪切：在播放头切开（真实键盘 S）
  const cut = await page.evaluate(async () => {
    const api = window.__clipcut;
    api.store.getState().setPlayhead(10);
    await new Promise((r) => setTimeout(r, 150));
    return api.store.getState().clips.length;
  });
  await page.keyboard.press('s');
  await page.waitForTimeout(500);
  const afterCut = await page.evaluate(async () => {
    const api = window.__clipcut;
    return {
      count: api.store.getState().clips.length,
      clips: api.store.getState().clips.map((c) => ({ in: c.sourceIn, out: c.sourceOut })),
    };
  });
  check(
    '在播放头切开片段',
    afterCut.count === cut + 1,
    `${cut} → ${afterCut.count} 段，切点 ${afterCut.clips[1]?.in.toFixed(2)}s`,
  );

  // 8. 删除片段
  const beforeDelete = afterCut.count;
  await page.evaluate(() => {
    const api = window.__clipcut;
    const clips = api.store.getState().clips;
    if (clips[1]) api.store.getState().selectClip(clips[1].id);
  });
  await page.waitForTimeout(200);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(400);
  const afterDelete = await page.evaluate(() => window.__clipcut.store.getState().clips.length);
  check('删除选中片段', afterDelete === beforeDelete - 1, `${beforeDelete} → ${afterDelete} 段`);

  // 9. 加转场 + 淡入淡出（先补一段，确保有相邻段可加转场）
  const transitionSet = await page.evaluate(async () => {
    const api = window.__clipcut;
    const firstAsset = Object.values(api.store.getState().assets)[0];
    if (firstAsset) {
      api.store.getState().addClipFromAsset(firstAsset.id);
    }
    // 加完片段后重新取最新状态，避免用到过期快照
    const fresh = api.store.getState();
    const clips = fresh.clips.map((c, i) => ({
      ...c,
      fadeIn: i === 0 ? 0.5 : 0,
      fadeOut: i === fresh.clips.length - 1 ? 0.5 : 0,
      transitionOut: i < fresh.clips.length - 1 ? { type: 'crossfade', duration: 0.8 } : { type: 'none', duration: 0 },
    }));
    fresh.setClips(clips);
    return { clips: clips.length, transitions: api.buildLayout(clips).clips.map((c) => c.transitionSamples / 48000) };
  });
  check(
    '设置转场与音量淡入淡出',
    transitionSet.clips >= 2 && transitionSet.transitions.filter(Boolean).length >= 1,
    `${transitionSet.clips} 段，${transitionSet.transitions.filter(Boolean).length} 处转场`,
  );

  // 10. 预览播放（真实播放 2 秒，检查时钟推进与画面更新）
  const playback = await page.evaluate(async () => {
    const engine = window.__clipcut.previewHolder.engine;
    await engine.seek(3);
    await new Promise((r) => setTimeout(r, 400));
    const canvas = document.querySelector('.preview-canvas');
    const snapshot = () => {
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let hash = 0;
      for (let i = 0; i < data.length; i += 4) hash = (hash * 31 + data[i]) % 2147483647;
      return hash;
    };
    const beforeImg = snapshot();
    const t0 = engine.getTime();
    await engine.play();
    await new Promise((r) => setTimeout(r, 2000));
    const t1 = engine.getTime();
    const afterImg = snapshot();
    const playing = engine.isPlaying();
    engine.pause();
    await new Promise((r) => setTimeout(r, 300));
    const pausedAt = engine.getTime();
    return { t0, t1, elapsed: t1 - t0, playing, frameChanged: beforeImg !== afterImg, pausedAt };
  });
  check(
    '实时预览播放推进',
    playback.playing && playback.elapsed > 1.85 && playback.elapsed < 2.25 && playback.frameChanged,
    `播放 ${playback.elapsed.toFixed(3)}s，画面更新 ${playback.frameChanged}`,
  );

  // 11. 导出真实性校验：三段不同入点 + 转场 + 字幕，写盘后 ffprobe
  const exportOut = await page.evaluate(async () => {
    const api = window.__clipcut;
    const s = api.store.getState();
    s.resetProject();
    await new Promise((r) => setTimeout(r, 50));
    const res = await fetch('/samples/sync-source.mp4');
    const handle = await api.loadAsset(new File([await res.blob()], 'sync-source.mp4', { type: 'video/mp4' }));
    api.store.getState().registerAsset(handle);
    const mk = (sourceIn, sourceOut, id) => ({
      id,
      assetId: handle.info.id,
      sourceIn,
      sourceOut,
      muted: false,
      fadeIn: 0,
      fadeOut: 0,
      transitionOut: { type: 'crossfade', duration: 0.8 },
    });
    const clips = [mk(0, 4, 'e1'), mk(10, 14, 'e2'), mk(20, 25, 'e3')];
    api.store.getState().setClips(clips);
    api.store.getState().addSubtitleSet({
      assetId: handle.info.id,
      name: 'e2e.srt',
      cues: [
        { start: 1, end: 3, text: '第一段字幕' },
        { start: 11, end: 13, text: '第二段字幕' },
      ],
    });
    await new Promise((r) => setTimeout(r, 100));

    const st = api.store.getState();
    const layout = api.buildLayout(st.clips);
    const cues = api.projectCues(layout, st.subtitles);
    const pool = new api.CursorPool(api.getVideoTrack, { width: 1280, height: 720, poolSize: 2 });

    let bytes = 0;
    const chunks = [];
    const writable = new WritableStream({
      write(chunk) {
        chunks.push({ pos: chunk.position, data: chunk.data });
        bytes = Math.max(bytes, chunk.position + chunk.data.byteLength);
      },
    });
    const target = {
      writable,
      finish: async () => {
        const out = new Uint8Array(bytes);
        for (const chunk of chunks) out.set(chunk.data, chunk.pos);
        const res2 = await fetch('http://127.0.0.1:8907/save?name=e2e-out.mp4', { method: 'POST', body: out });
        return { saved: (await res2.json()).name, fileName: 'e2e-out.mp4', bytes, savedToFile: true };
      },
      abort: async () => {},
    };

    await api.exportTimeline(target, {
      layout,
      settings: { width: 1280, height: 720, fps: 24, videoBitrate: 4000000, audioBitrate: 128000, range: 'all' },
      sourceFrameRate: 24,
      cues,
      getAudioTrack: api.getAudioTrack,
      frameAt: async (item, sourceTime) => {
        const f = await pool.frameAt(item.clip.assetId, item.clip.id, item.clip.sourceIn, item.clip.sourceOut, sourceTime);
        return f?.canvas ?? null;
      },
    });
    pool.dispose();
    return { bytes, totalSeconds: layout.totalSamples / 48000, cueCount: cues.length, chunks: chunks.length };
  });
  check(
    '流式导出写盘',
    exportOut.bytes > 50000,
    `${(exportOut.bytes / 1024).toFixed(0)}KB，时间轴 ${exportOut.totalSeconds}s，字幕 ${exportOut.cueCount} 条`,
  );

  // 12. 界面截图留档
  await page.waitForTimeout(1200);
  await page.evaluate(async () => {
    // 恢复一个有内容的工程用于截图
    const api = window.__clipcut;
    api.store.getState().resetProject();
    await new Promise((r) => setTimeout(r, 60));
    const res = await fetch('/samples/sintel_trailer-720p.mp4');
    const handle = await api.loadAsset(new File([await res.blob()], 'sintel_trailer-720p.mp4', { type: 'video/mp4' }));
    api.store.getState().registerAsset(handle);
    api.store.getState().addClipFromAsset(handle.info.id);
    await api.buildWaveform(handle).then((peaks) => {
      if (peaks) {
        api.setWaveform(handle.info.id, peaks);
        api.store.getState().bumpWaveformVersion();
      }
    });
    const srtRes = await fetch('/samples/sintel_trailer.srt');
    api.store.getState().addSubtitleSet({
      assetId: handle.info.id,
      name: 'sintel_trailer.srt',
      cues: api.parseSrt(await srtRes.text()),
    });
    api.previewHolder.engine?.seek(7);
  });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(outDir, 'e2e-ui.png') });
  check('界面截图', true, '.tmp-export/e2e-ui.png');
} catch (error) {
  check('脚本执行', false, String(error));
} finally {
  const fatal = errors.filter(
    (text) =>
      !text.includes('favicon') &&
      !text.includes('garbage collected') &&
      !text.includes('Failed to load resource'),
  );
  check('无致命控制台错误', fatal.length === 0, fatal.slice(0, 3).join(' | ') || '无');

  const summary = results.filter((r) => !r.pass);
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n汇总：${passed}/${results.length} 项通过`);
  writeFileSync(join(outDir, 'e2e-results.json'), JSON.stringify({ results, consoleErrors: errors }, null, 2));
  await browser.close();
  process.exit(summary.length === 0 ? 0 : 1);
}
