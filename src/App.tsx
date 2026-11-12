import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useEditorStore, getWaveform, isSubtitleEnabled, subtitleDisplayName } from './store';
import { previewHolder, thumbnails, subscribeThumbnails, getThumbVersion } from './runtime';
import { SAMPLE_RATE, buildLayout, type ClipLayout, type TimelineLayout } from './lib/timeline';
import { projectCues } from './lib/subtitles';
import { moveClip, splitClip, trimIn, trimOut } from './lib/edits';
import { WAVEFORM_BUCKETS_PER_SECOND } from './lib/thumbnails';
import { loadAsset } from './lib/media';
import { buildWaveform, setWaveform } from './lib/waveformLoader';
import { parseSrt } from './lib/srt';
import { PreviewEngine } from './lib/previewEngine';
import { TimelineAudioMixer } from './lib/audio';
import { CursorPool } from './lib/frameCursor';
import { getAudioTrack, getVideoTrack } from './runtime';
import type { AssetInfo, Clip, SubtitleSet } from './types';
import { formatDuration, formatTimecode } from './lib/format';

export default function App() {
  // 订阅缩略图版本：生成新缩略图时让时间轴重绘
  useSyncExternalStore(subscribeThumbnails, getThumbVersion, getThumbVersion);
  useGlobalShortcuts();
  const { dragging, handlers } = useFileDrop();

  return (
    <div className={`app${dragging ? ' dropping' : ''}`} {...handlers}>
      <TopBar />
      <div className="workspace">
        <LeftPanel />
        <main className="center">
          <PreviewPanel />
          <TimelinePanel />
        </main>
      </div>
      {dragging ? (
        <div className="drop-overlay">
          <div className="drop-hint">松手导入 mp4 / mov，srt 字幕会自动绑定到素材</div>
        </div>
      ) : null}
      <Toast />
    </div>
  );
}

/** 把文件导入工程（视频与字幕共用一条入口） */
async function importFiles(files: File[]): Promise<void> {
  const store = useEditorStore.getState();
  const videos = files.filter((file) => file.type.startsWith('video') || /\.(mp4|mov|m4v)$/i.test(file.name));
  const srtFiles = files.filter((file) => /\.srt$/i.test(file.name) || file.type === 'text/plain');
  const skipped = files.length - videos.length - srtFiles.length;
  if (skipped > 0) {
    store.showToast(`忽略了 ${skipped} 个不支持的文件`);
  }

  if (videos.length > 0) {
    store.setLoading(videos.length);
  }

  for (const file of videos) {
    try {
      const handle = await loadAsset(file);
      store.registerAsset(handle);
      store.addClipFromAsset(handle.info.id);
      store.showToast(`已导入 ${file.name}`);
      // 波形在后台算，不阻塞后续导入
      void buildWaveform(handle).then((peaks) => {
        if (!peaks) {
          return;
        }
        setWaveform(handle.info.id, peaks);
        useEditorStore.getState().bumpWaveformVersion();
      });
    } catch (error) {
      store.showToast(`导入失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      useEditorStore.getState().setLoading((current) => Math.max(0, current - 1));
    }
  }

  // 字幕绑定到刚导入的视频，或当前选中片段所属素材
  if (srtFiles.length > 0) {
    // 复用顶部静态导入的解析器
    const current = useEditorStore.getState();
    const assetId =
      videos.length > 0
        ? [...current.clips].reverse().find((clip) => clip.assetId)?.assetId
        : current.clips.find((clip) => clip.id === current.selectedClipId)?.assetId ??
          current.clips[current.clips.length - 1]?.assetId ??
          null;
    if (!assetId) {
      store.showToast('请先导入视频，再导入 srt 字幕');
      return;
    }
    for (const file of srtFiles) {
      try {
        const cues = parseSrt(await file.text());
        if (cues.length === 0) {
          store.showToast(`${file.name} 里没有解析到有效字幕`);
          continue;
        }
        const existing = current.subtitles.find((subtitle) => subtitle.assetId === assetId);
        useEditorStore.getState().addSubtitleSet({
          assetId,
          name: existing && !isSubtitleEnabled(existing) ? `[off] ${file.name}` : file.name,
          cues,
        });
        store.showToast(`已导入 ${cues.length} 条字幕`);
      } catch (error) {
        store.showToast(`字幕导入失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

/** 窗口级文件拖放 */
function useFileDrop() {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  useEffect(() => {
    const onDragEnter = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) {
        return;
      }
      event.preventDefault();
      depth.current += 1;
      setDragging(true);
    };
    const onDragOver = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes('Files')) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    };
    const onDragLeave = (event: DragEvent) => {
      event.preventDefault();
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) {
        setDragging(false);
      }
    };
    const onDrop = (event: DragEvent) => {
      event.preventDefault();
      depth.current = 0;
      setDragging(false);
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length > 0) {
        void importFiles(files);
      }
    };

    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  return { dragging, handlers: {} };
}

/** 全局快捷键 */
function useGlobalShortcuts() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) {
        return;
      }
      const engine = previewHolder.engine;

      if (event.code === 'Space') {
        event.preventDefault();
        engine?.toggle();
        return;
      }

      if (event.key === 's' || event.key === 'S') {
        event.preventDefault();
        splitAtPlayhead();
        return;
      }

      if (event.key === 'Delete' || event.key === 'Backspace') {
        const state = useEditorStore.getState();
        if (state.selectedClipId) {
          event.preventDefault();
          state.setClips(state.clips.filter((clip) => clip.id !== state.selectedClipId));
          state.selectClip(null);
        }
        return;
      }

      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault();
        if (!engine) {
          return;
        }
        const step = 1 / 24;
        const next = Math.max(0, Math.min(engine.getDuration(), engine.getTime() + (event.key === 'ArrowLeft' ? -step : step)));
        void engine.seek(next);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}

/** 在播放头处切开当前所在片段 */
function splitAtPlayhead(): void {
  const state = useEditorStore.getState();
  const layout = buildLayout(state.clips);
  const sample = Math.round(state.playhead * SAMPLE_RATE);
  const item = layout.clips.find(
    (entry) => sample > entry.startSample && sample < entry.startSample + entry.durSamples,
  );
  if (!item) {
    state.showToast('把播放头放到某个片段内部再切');
    return;
  }
  const sourceTime = item.clip.sourceIn + (sample - item.startSample) / SAMPLE_RATE;
  const pieces = splitClip(item.clip, sourceTime);
  if (pieces.length === 1) {
    state.showToast('切点太靠近边缘，换一处再试');
    return;
  }
  const next = [...state.clips];
  next.splice(item.index, 1, ...pieces);
  state.setClips(next);
  state.selectClip(pieces[1].id);
}

/* ------------------------------------------------------------------ 顶栏 */

function TopBar() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const srtInputRef = useRef<HTMLInputElement>(null);
  const assets = useEditorStore((state) => state.assets);
  const loadingCount = useEditorStore((state) => state.loadingCount);
  const [exportOpen, setExportOpen] = useState(false);

  const targetAssetId =
    useEditorStore((state) => state.clips.find((clip) => clip.id === state.selectedClipId)?.assetId) ??
    Object.values(assets)[0]?.id ??
    null;

  const handleSrt = async (files: FileList | null) => {
    if (!files || files.length === 0) {
      return;
    }
    const store = useEditorStore.getState();
    if (!targetAssetId) {
      store.showToast('请先导入一个视频素材，再导入字幕');
      return;
    }
    const file = files[0];
    try {

      const cues = parseSrt(await file.text());
      if (cues.length === 0) {
        store.showToast('字幕里没有解析到有效条目');
        return;
      }
      // 已有字幕时保留其开启/关闭状态
      const existing = store.subtitles.find((subtitle) => subtitle.assetId === targetAssetId);
      const set: SubtitleSet = {
        assetId: targetAssetId,
        name: existing && !isSubtitleEnabled(existing) ? `[off] ${file.name}` : file.name,
        cues,
      };
      store.addSubtitleSet(set);
      store.showToast(`已导入 ${cues.length} 条字幕，绑定到 ${store.assets[targetAssetId]?.name ?? '素材'}`);
    } catch (error) {
      store.showToast(`字幕导入失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">✂</span>
        <span className="brand-name">ClipCut</span>
        <span className="brand-sub">浏览器本地剪辑</span>
      </div>

      <div className="topbar-actions">
        <button type="button" className="btn primary" onClick={() => fileInputRef.current?.click()}>
          导入视频
        </button>
        <button type="button" className="btn" onClick={() => srtInputRef.current?.click()}>
          导入字幕
        </button>
        <button type="button" className="btn accent" onClick={() => setExportOpen(true)}>
          导出 MP4
        </button>
      </div>

      <div className="topbar-meta">
        {loadingCount > 0 ? <span className="pill">正在解析 {loadingCount} 个文件…</span> : null}
        <span className="pill">{Object.keys(assets).length} 个素材</span>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="video/mp4,video/quicktime,.mp4,.mov,.m4v"
        multiple
        hidden
        onChange={(event) => {
          void importFiles(Array.from(event.target.files ?? []));
          event.target.value = '';
        }}
      />
      <input
        ref={srtInputRef}
        type="file"
        accept=".srt,text/plain"
        hidden
        onChange={(event) => {
          void handleSrt(event.target.files);
          event.target.value = '';
        }}
      />

      {exportOpen ? <ExportDialog onClose={() => setExportOpen(false)} /> : null}
    </header>
  );
}

/* ---------------------------------------------------------------- 左侧面板 */

function LeftPanel() {
  const assets = useEditorStore((state) => state.assets);
  const clips = useEditorStore((state) => state.clips);
  const subtitles = useEditorStore((state) => state.subtitles);
  const removeAsset = useEditorStore((state) => state.removeAsset);
  const addClipFromAsset = useEditorStore((state) => state.addClipFromAsset);
  const toggleSubtitleSet = useEditorStore((state) => state.toggleSubtitleSet);
  const removeSubtitleSet = useEditorStore((state) => state.removeSubtitleSet);
  const assetList = Object.values(assets);
  const usedIds = new Set(clips.map((clip) => clip.assetId));

  return (
    <aside className="left-panel">
      <section>
        <h2>素材</h2>
        {assetList.length === 0 ? (
          <p className="hint">把 mp4 拖进窗口，或用上方「导入视频」。</p>
        ) : (
          <ul className="asset-list">
            {assetList.map((asset) => (
              <li key={asset.id} className={usedIds.has(asset.id) ? 'asset used' : 'asset'}>
                <div className="asset-title" title={asset.name}>
                  {asset.name}
                </div>
                <div className="asset-meta">
                  {asset.hasVideo ? `${asset.width}×${asset.height} · ${asset.frameRate.toFixed(2)}fps` : '无视频轨'}
                  <br />
                  {asset.hasAudio ? `${asset.sampleRate}Hz / ${asset.channels}ch` : '无音频轨'} · {formatDuration(asset.duration)}
                </div>
                <div className="asset-actions">
                  <button type="button" className="mini" onClick={() => addClipFromAsset(asset.id)}>
                    再加一段
                  </button>
                  <button type="button" className="mini danger" onClick={() => removeAsset(asset.id)}>
                    移除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>字幕</h2>
        {subtitles.length === 0 ? (
          <p className="hint">导入 srt 后，字幕会跟着素材一起被剪切、搬移。</p>
        ) : (
          <ul className="asset-list">
            {subtitles.map((subtitle) => (
              <li key={subtitle.assetId} className="asset">
                <div className="asset-title">{subtitleDisplayName(subtitle)}</div>
                <div className="asset-meta">
                  {subtitle.cues.length} 条 · 绑定「{assets[subtitle.assetId]?.name ?? subtitle.assetId}」
                </div>
                <div className="asset-actions">
                  <button type="button" className="mini" onClick={() => toggleSubtitleSet(subtitle.assetId)}>
                    {isSubtitleEnabled(subtitle) ? '关闭显示' : '开启显示'}
                  </button>
                  <button type="button" className="mini danger" onClick={() => removeSubtitleSet(subtitle.assetId)}>
                    删除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="shortcut-hint">
        <h2>快捷键</h2>
        <ul>
          <li><kbd>空格</kbd> 播放 / 暂停</li>
          <li><kbd>S</kbd> 在播放头处切开</li>
          <li><kbd>Delete</kbd> 删除选中片段</li>
          <li><kbd>←</kbd> / <kbd>→</kbd> 逐帧移动</li>
        </ul>
      </section>
    </aside>
  );
}

/* ------------------------------------------------------------------ 预览区 */

function PreviewPanel() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const clips = useEditorStore((state) => state.clips);
  const playhead = useEditorStore((state) => state.playhead);
  const setPlayhead = useEditorStore((state) => state.setPlayhead);
  const subtitles = useEditorStore((state) => state.subtitles);
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false);

  const layout = useMemo(() => buildLayout(clips), [clips]);
  const cues = useMemo(
    () => projectCues(layout, subtitles.filter(isSubtitleEnabled)),
    [layout, subtitles],
  );

  // 让引擎回调总能读到最新的排版与字幕
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const cuesRef = useRef(cues);
  cuesRef.current = cues;
  const playingRef = useRef(false);
  playingRef.current = playing;
  const playheadRef = useRef(playhead);
  playheadRef.current = playhead;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    let canceled = false;
    let engine: PreviewEngine | null = null;
    let audioContext: AudioContext | null = null;
    let pool: CursorPool | null = null;

    const setup = () => {
      if (canceled) {
        return;
      }

      audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
      canvas.width = 1280;
      canvas.height = 720;

      const mixer = new TimelineAudioMixer({ getTrack: getAudioTrack, layout: layoutRef.current });
      pool = new CursorPool(getVideoTrack, { width: 1280, height: 720, poolSize: 3 });

      engine = new PreviewEngine({
        canvas,
        audioContext,
        mixer,
        layout: layoutRef.current,
        getCues: () => cuesRef.current,
        frameAt: async (clipId, assetId, sourceIn, sourceOut, sourceTime) => {
          if (!pool) {
            return null;
          }
          const frame = await pool.frameAt(assetId, clipId, sourceIn, sourceOut, sourceTime);
          return frame?.canvas ?? null;
        },
      });
      engine.setPlayStateListener(setPlaying);
      engine.setTimeListener(setPlayhead);
      previewHolder.engine = engine;
      setReady(true);
      void engine.drawAt(0);
    };

    setup();

    return () => {
      canceled = true;
      engine?.dispose();
      pool?.dispose();
      void audioContext?.close();
      previewHolder.engine = null;
      setReady(false);
    };
  }, [setPlayhead]);

  // 剪辑变化：更新排版并按需重绘
  useEffect(() => {
    const engine = previewHolder.engine;
    if (!engine) {
      return;
    }
    engine.setLayout(layout);
    if (!playingRef.current) {
      void engine.seek(Math.min(playheadRef.current, engine.getDuration()));
    }
  }, [layout]);

  // 时间轴点击定位：同步画面
  useEffect(() => {
    const engine = previewHolder.engine;
    if (!engine || playing) {
      return;
    }
    if (Math.abs(engine.getTime() - playhead) > 0.02) {
      void engine.seek(playhead);
    }
  }, [playhead, playing]);

  const disabled = clips.length === 0;

  return (
    <section className="preview">
      <div className="preview-stage">
        <canvas ref={canvasRef} className="preview-canvas" />
        {!ready || disabled ? (
          <div className="preview-empty">
            {disabled ? '导入素材后，这里会实时预览剪辑结果' : '正在准备预览…'}
          </div>
        ) : null}
      </div>
      <div className="transport">
        <button type="button" className="btn ghost" onClick={() => void previewHolder.engine?.seek(0)} title="回到开头">
          ⏮
        </button>
        <button
          type="button"
          className="btn play"
          disabled={disabled}
          onClick={() => previewHolder.engine?.toggle()}
        >
          {playing ? '⏸ 暂停' : '▶ 播放'}
        </button>
        <span className="timecode">
          {formatTimecode(playhead)} / {formatTimecode(layout.totalSamples / SAMPLE_RATE)}
        </span>
        <span className="spacer" />
        <span className="hint">实时合成，剪辑后不需等渲染</span>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ 时间轴 */

function TimelinePanel() {
  const clips = useEditorStore((state) => state.clips);
  const assets = useEditorStore((state) => state.assets);
  const zoom = useEditorStore((state) => state.zoom);
  const setZoom = useEditorStore((state) => state.setZoom);
  const selectedClipId = useEditorStore((state) => state.selectedClipId);
  const selectClip = useEditorStore((state) => state.selectClip);
  const setClips = useEditorStore((state) => state.setClips);
  const updateClip = useEditorStore((state) => state.updateClip);

  const layout = useMemo(() => buildLayout(clips), [clips]);
  const selected = clips.find((clip) => clip.id === selectedClipId) ?? null;

  return (
    <section className="timeline-panel">
      <div className="timeline-toolbar">
        <ClipToolbar
          selected={selected}
          clips={clips}
          onSelect={selectClip}
          onClipsChange={setClips}
          onUpdateClip={updateClip}
        />
        <div className="zoom-control">
          <span className="hint">缩放</span>
          <input
            type="range"
            min={8}
            max={400}
            step={1}
            value={zoom}
            onChange={(event) => setZoom(Number(event.target.value))}
          />
        </div>
      </div>

      <TimelineTracks layout={layout} assets={assets} zoom={zoom} selectedClipId={selectedClipId} />
    </section>
  );
}

/** 工具条 */
function ClipToolbar({
  selected,
  clips,
  onSelect,
  onClipsChange,
  onUpdateClip,
}: {
  selected: Clip | null;
  clips: Clip[];
  onSelect: (id: string | null) => void;
  onClipsChange: (clips: Clip[]) => void;
  onUpdateClip: (clipId: string, patch: Partial<Clip>) => void;
}) {
  const showToast = useEditorStore((state) => state.showToast);

  const setTransitionType = (type: Clip['transitionOut']['type']) => {
    if (!selected) {
      return;
    }
    const duration = type === 'none' ? 0 : Math.max(selected.transitionOut.duration, 0.5);
    onUpdateClip(selected.id, { transitionOut: { type, duration } });
  };

  return (
    <div className="clip-toolbar">
      <button type="button" className="btn small" onClick={() => splitAtPlayhead()}>
        ✂ 在播放头切开 <kbd>S</kbd>
      </button>
      <button
        type="button"
        className="btn small"
        disabled={!selected}
        onClick={() => {
          if (!selected) return;
          onClipsChange(clips.filter((clip) => clip.id !== selected.id));
          onSelect(null);
          showToast('已删除片段');
        }}
      >
        删除片段 <kbd>Del</kbd>
      </button>

      <span className="divider" />

      <label className="field">
        <span>到下一段</span>
        <select
          value={selected?.transitionOut.type ?? 'none'}
          disabled={!selected}
          onChange={(event) => setTransitionType(event.target.value as Clip['transitionOut']['type'])}
        >
          <option value="none">硬切</option>
          <option value="crossfade">叠化</option>
          <option value="dipToBlack">淡入淡出</option>
        </select>
      </label>

      {selected && selected.transitionOut.type !== 'none' ? (
        <label className="field">
          <span>时长</span>
          <input
            type="number"
            min={0.1}
            max={3}
            step={0.1}
            value={selected.transitionOut.duration}
            onChange={(event) =>
              onUpdateClip(selected.id, {
                transitionOut: { ...selected.transitionOut, duration: Math.max(0, Number(event.target.value)) },
              })
            }
          />
          <span className="unit">秒</span>
        </label>
      ) : null}

      <span className="divider" />

      <label className="field">
        <span>音量淡入</span>
        <input
          type="number"
          min={0}
          max={3}
          step={0.1}
          disabled={!selected}
          value={selected?.fadeIn ?? 0}
          onChange={(event) => selected && onUpdateClip(selected.id, { fadeIn: Math.max(0, Number(event.target.value)) })}
        />
      </label>

      <label className="field">
        <span>音量淡出</span>
        <input
          type="number"
          min={0}
          max={3}
          step={0.1}
          disabled={!selected}
          value={selected?.fadeOut ?? 0}
          onChange={(event) => selected && onUpdateClip(selected.id, { fadeOut: Math.max(0, Number(event.target.value)) })}
        />
      </label>

      <label className="field checkbox">
        <input
          type="checkbox"
          disabled={!selected}
          checked={selected?.muted ?? false}
          onChange={(event) => selected && onUpdateClip(selected.id, { muted: event.target.checked })}
        />
        <span>静音本段</span>
      </label>
    </div>
  );
}

/** 轨道区 */
function TimelineTracks({
  layout,
  assets,
  zoom,
  selectedClipId,
}: {
  layout: TimelineLayout;
  assets: Record<string, AssetInfo>;
  zoom: number;
  selectedClipId: string | null;
}) {
  const playhead = useEditorStore((state) => state.playhead);
  const setPlayhead = useEditorStore((state) => state.setPlayhead);
  const selectClip = useEditorStore((state) => state.selectClip);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const totalSeconds = layout.totalSamples / SAMPLE_RATE;
  const width = Math.max(320, totalSeconds * zoom);

  /** 由鼠标横坐标算时间轴秒数 */
  const timeFromClientX = (clientX: number): number => {
    const content = contentRef.current;
    if (!content) {
      return 0;
    }
    const rect = content.getBoundingClientRect();
    return Math.max(0, Math.min(totalSeconds, (clientX - rect.left) / zoom));
  };

  const scrub = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    setPlayhead(timeFromClientX(event.clientX));
    const move = (moveEvent: PointerEvent) => setPlayhead(timeFromClientX(moveEvent.clientX));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div className="timeline-scroll" ref={scrollRef}>
      <div className="timeline-content" style={{ width }} ref={contentRef}>
        <Ruler totalSeconds={totalSeconds} zoom={zoom} onScrub={scrub} />
        <div className="track video-track" onPointerDown={() => selectClip(null)}>
          {layout.clips.map((item) => (
            <ClipBlock
              key={item.clip.id}
              item={item}
              asset={assets[item.clip.assetId]}
              zoom={zoom}
              totalSeconds={totalSeconds}
              selected={selectedClipId === item.clip.id}
            />
          ))}
        </div>
        <div className="track audio-track" onPointerDown={() => selectClip(null)}>
          {layout.clips.map((item) => (
            <WaveformBlock
              key={item.clip.id}
              item={item}
              zoom={zoom}
              selected={selectedClipId === item.clip.id}
            />
          ))}
        </div>
        <div className="playhead" style={{ left: playhead * zoom }} onPointerDown={scrub} title="拖动定位" />
      </div>
    </div>
  );
}

/** 时标尺 */
function Ruler({
  totalSeconds,
  zoom,
  onScrub,
}: {
  totalSeconds: number;
  zoom: number;
  onScrub: (event: React.PointerEvent<HTMLDivElement>) => void;
}) {
  // 自适应刻度：保证标签间距不小于目标像素
  const targetPx = 80;
  const candidates = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  const step = candidates.find((value) => value * zoom >= targetPx) ?? 600;
  const ticks: number[] = [];
  for (let time = 0; time <= totalSeconds + 1e-6; time += step) {
    ticks.push(time);
  }

  return (
    <div className="ruler" onPointerDown={onScrub} style={{ width: totalSeconds * zoom }}>
      {ticks.map((time) => (
        <span key={time} className="tick" style={{ left: time * zoom }}>
          {formatDuration(time)}
        </span>
      ))}
    </div>
  );
}

/** 视频片段块：缩略图条 + 左右裁剪手柄 + 拖拽调序 */
function ClipBlock({
  item,
  asset,
  zoom,
  totalSeconds,
  selected,
}: {
  item: ClipLayout;
  asset: AssetInfo | undefined;
  zoom: number;
  totalSeconds: number;
  selected: boolean;
}) {
  const thumbVersion = useSyncExternalStore(subscribeThumbnails, getThumbVersion, getThumbVersion);
  const selectClip = useEditorStore((state) => state.selectClip);
  const [dragging, setDragging] = useState(false);
  const left = (item.startSample / SAMPLE_RATE) * zoom;
  const width = (item.durSamples / SAMPLE_RATE) * zoom;

  // 每约 96px 放一格缩略图，取该格中点时刻的源内画面
  const cells = useMemo(() => {
    const cellWidthPx = 96;
    const count = Math.max(1, Math.ceil(width / cellWidthPx));
    const list: (string | null)[] = [];
    const span = item.clip.sourceOut - item.clip.sourceIn;
    for (let i = 0; i < count; i++) {
      const sourceTime = item.clip.sourceIn + span * ((i + 0.5) / count);
      list.push(thumbnails.get(item.clip.assetId, sourceTime));
    }
    return list;
    // thumbVersion 参与依赖，缩略图就绪后重新取
  }, [item.clip.assetId, item.clip.sourceIn, item.clip.sourceOut, width, thumbVersion]);

  /** 左边缘拖动 = 调整入点 */
  const startTrimIn = (event: React.PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    selectClip(item.clip.id);
    const duration = asset?.duration ?? item.clip.sourceOut;
    const startX = event.clientX;
    const originIn = item.clip.sourceIn;
    const move = (moveEvent: PointerEvent) => {
      const deltaSeconds = (moveEvent.clientX - startX) / zoom;
      const state = useEditorStore.getState();
      const clip = state.clips.find((entry) => entry.id === item.clip.id);
      if (!clip) return;
      state.updateClip(item.clip.id, trimIn(clip, originIn + deltaSeconds, duration));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /** 右边缘拖动 = 调整出点 */
  const startTrimOut = (event: React.PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    selectClip(item.clip.id);
    const duration = asset?.duration ?? item.clip.sourceOut;
    const startX = event.clientX;
    const originOut = item.clip.sourceOut;
    const move = (moveEvent: PointerEvent) => {
      const deltaSeconds = (moveEvent.clientX - startX) / zoom;
      const state = useEditorStore.getState();
      const clip = state.clips.find((entry) => entry.id === item.clip.id);
      if (!clip) return;
      state.updateClip(item.clip.id, trimOut(clip, originOut + deltaSeconds, duration));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  /** 主体拖动 = 调整顺序（按插入位置算，而不是按悬停片段交换） */
  const startReorder = (event: React.PointerEvent) => {
    event.preventDefault();
    const state0 = useEditorStore.getState();
    const fromIndex = item.index;
    setDragging(true);

    const move = (moveEvent: PointerEvent) => {
      const content = (event.currentTarget as HTMLElement).closest('.timeline-content');
      if (!content) {
        return;
      }
      const rect = content.getBoundingClientRect();
      const timeAtCursor = (moveEvent.clientX - rect.left) / zoom;
      // 计算光标落在哪个片段的“槽位”
      const currentLayout = buildLayout(useEditorStore.getState().clips);
      let targetIndex = currentLayout.clips.length - 1;
      for (const entry of currentLayout.clips) {
        const midpoint = (entry.startSample + entry.durSamples / 2) / SAMPLE_RATE;
        if (timeAtCursor < midpoint) {
          targetIndex = entry.index;
          break;
        }
      }
      const state = useEditorStore.getState();
      const next = moveClip(state.clips, fromIndex, targetIndex);
      if (next !== state.clips) {
        state.setClips(next);
      }
    };
    const up = () => {
      setDragging(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    void state0;
    void totalSeconds;
  };

  return (
    <div
      className={`clip-block${selected ? ' selected' : ''}${dragging ? ' dragging' : ''}`}
      style={{ left, width }}
      data-clip-index={item.index}
      onPointerDown={(event) => {
        event.stopPropagation();
        selectClip(item.clip.id);
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        void previewHolder.engine?.seek(item.startSample / SAMPLE_RATE);
      }}
    >
      <div className="thumb-strip">
        {cells.map((url, index) => (
          <div
            key={index}
            className="thumb-cell"
            style={{
              backgroundImage: url ? `url(${url})` : undefined,
              width: `${100 / cells.length}%`,
            }}
          />
        ))}
      </div>

      <div className="clip-label">
        <span className="clip-name">{asset?.name ?? '未知素材'}</span>
      </div>

      {item.transitionSamples > 0 ? (
        <span
          className="transition-badge"
          style={{ width: (item.transitionSamples / SAMPLE_RATE) * zoom }}
          title={`转场 ${(item.transitionSamples / SAMPLE_RATE).toFixed(2)} 秒`}
        />
      ) : null}

      <span className="trim-handle left" onPointerDown={startTrimIn} title="拖动调整入点" />
      <span className="trim-handle right" onPointerDown={startTrimOut} title="拖动调整出点" />
      <span className="drag-handle" onPointerDown={startReorder} title="拖动调整顺序" />
    </div>
  );
}

/** 波形块 */
function WaveformBlock({ item, zoom, selected }: { item: ClipLayout; zoom: number; selected: boolean }) {
  const width = (item.durSamples / SAMPLE_RATE) * zoom;
  const left = (item.startSample / SAMPLE_RATE) * zoom;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // 波形是异步算好的，靠 waveformVersion 触发重绘
  const waveformVersion = useEditorStore((state) => state.waveformVersion);
  const waveform = useMemo(
    () => getWaveform(item.clip.assetId) ?? null,
    [item.clip.assetId, item.clip.sourceIn, item.clip.sourceOut, item.clip.id, waveformVersion],
  );
  const selectClip = useEditorStore((state) => state.selectClip);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    const cssHeight = 52;
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.floor(cssHeight * dpr);
    const context = canvas.getContext('2d');
    if (!context) {
      return;
    }
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, cssHeight);

    context.fillStyle = selected ? 'rgba(125, 211, 252, 0.16)' : 'rgba(255, 255, 255, 0.06)';
    context.fillRect(0, 0, width, cssHeight);

    if (!waveform || width <= 0) {
      return;
    }

    const startBucket = Math.floor(item.clip.sourceIn * WAVEFORM_BUCKETS_PER_SECOND);
    const totalBuckets = Math.max(
      1,
      Math.ceil((item.clip.sourceOut - item.clip.sourceIn) * WAVEFORM_BUCKETS_PER_SECOND),
    );

    context.fillStyle = selected ? '#7dd3fc' : 'rgba(148, 197, 255, 0.78)';
    const mid = cssHeight / 2;
    const amplitude = mid - 3;
    for (let x = 0; x < Math.ceil(width); x++) {
      const bucket = startBucket + Math.floor((x / width) * totalBuckets);
      const minValue = waveform.min[bucket] ?? 0;
      const maxValue = waveform.max[bucket] ?? 0;
      let top = mid - maxValue * amplitude;
      let bottom = mid - minValue * amplitude;
      if (top > bottom) {
        [top, bottom] = [bottom, top];
      }
      context.fillRect(x, top, 1, Math.max(1, bottom - top));
    }
  }, [width, item.clip.sourceIn, item.clip.sourceOut, selected, waveform]);

  return (
    <div
      className={`wave-block${selected ? ' selected' : ''}`}
      style={{ left, width }}
      onPointerDown={(event) => {
        event.stopPropagation();
        selectClip(item.clip.id);
      }}
    >
      <canvas ref={canvasRef} style={{ width: '100%', height: `52px` }} />
    </div>
  );
}

/* ------------------------------------------------------------------- 提示 */

function Toast() {
  const toast = useEditorStore((state) => state.toast);
  const showToast = useEditorStore((state) => state.showToast);

  useEffect(() => {
    if (!toast) {
      return;
    }
    const timer = window.setTimeout(() => showToast(null), 2800);
    return () => window.clearTimeout(timer);
  }, [toast, showToast]);

  if (!toast) {
    return null;
  }
  return <div className="toast">{toast}</div>;
}

/* --------------------------------------------------------------- 导出对话框 */

function ExportDialog({ onClose }: { onClose: () => void }) {
  const settings = useEditorStore((state) => state.exportSettings);
  const setExportSettings = useEditorStore((state) => state.setExportSettings);
  const clips = useEditorStore((state) => state.clips);
  const assets = useEditorStore((state) => state.assets);
  const subtitles = useEditorStore((state) => state.subtitles);
  const showToast = useEditorStore((state) => state.showToast);
  const [progress, setProgress] = useState<{ ratio: number; phase: string; frames: number; total: number } | null>(null);
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const layout = useMemo(() => buildLayout(clips), [clips]);
  const cues = useMemo(() => projectCues(layout, subtitles.filter(isSubtitleEnabled)), [layout, subtitles]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const cuesRef = useRef(cues);
  cuesRef.current = cues;

  const sourceFrameRate = clips.length > 0 ? assets[clips[0].assetId]?.frameRate ?? 24 : 24;
  // 预估体积，让用户对导出结果有预期
  const estimatedBytes = useMemo(() => {
    const seconds = layout.totalSamples / SAMPLE_RATE;
    return ((settings.videoBitrate + settings.audioBitrate) / 8) * seconds;
  }, [layout.totalSamples, settings.videoBitrate, settings.audioBitrate]);

  const startExport = async () => {
    if (running) {
      return;
    }
    if (clips.length === 0) {
      showToast('时间轴是空的，先导入素材');
      return;
    }
    setRunning(true);
    setProgress({ ratio: 0, phase: '准备中', frames: 0, total: 0 });
    const controller = new AbortController();
    abortRef.current = controller;

    const { createOutputTarget, exportTimeline, defaultExportName } = await import('./lib/exporter');
    const pool = new CursorPool(getVideoTrack, {
      width: settings.width,
      height: settings.height,
      poolSize: 2,
    });

    try {
      const target = await createOutputTarget(defaultExportName());
      await exportTimeline(target, {
        layout: layoutRef.current,
        settings,
        sourceFrameRate,
        cues: cuesRef.current,
        getAudioTrack,
        signal: controller.signal,
        frameAt: async (item, sourceTime) => {
          const frame = await pool.frameAt(
            item.clip.assetId,
            item.clip.id,
            item.clip.sourceIn,
            item.clip.sourceOut,
            sourceTime,
          );
          return frame?.canvas ?? null;
        },
        onProgress: (next) => {
          const phaseText =
            next.phase === 'preparing'
              ? '准备中'
              : next.phase === 'encoding'
                ? '编码中'
                : next.phase === 'finalizing'
                  ? '写入收尾'
                  : next.phase === 'done'
                    ? '完成'
                    : next.phase === 'canceled'
                      ? '已取消'
                      : '出错';
          setProgress({ ratio: next.ratio, phase: phaseText, frames: next.framesDone, total: next.totalFrames });
        },
      });
      showToast('导出完成');
      onClose();
    } catch (error) {
      if (error instanceof Error && error.message === 'EXPORT_CANCELED') {
        showToast('导出已取消');
      } else {
        showToast(`导出失败：${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      pool.dispose();
      setRunning(false);
      abortRef.current = null;
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <h2>导出 MP4</h2>
        <p className="hint">
          H.264 + AAC，字幕直接烧进画面。导出全程流式写盘，不会把整段视频留在内存里。
        </p>

        <div className="export-fields">
          <label className="field">
            <span>分辨率</span>
            <select
              value={`${settings.width}x${settings.height}`}
              onChange={(event) => {
                const [width, height] = event.target.value.split('x').map(Number);
                setExportSettings({ width, height });
              }}
            >
              <option value="1920x1080">1920×1080</option>
              <option value="1280x720">1280×720</option>
              <option value="3840x2160">3840×2160</option>
            </select>
          </label>

          <label className="field">
            <span>帧率</span>
            <select
              value={settings.fps === 'source' ? 'source' : String(settings.fps)}
              onChange={(event) =>
                setExportSettings({ fps: event.target.value === 'source' ? 'source' : Number(event.target.value) })
              }
            >
              <option value="source">跟随素材 {sourceFrameRate.toFixed(2)}</option>
              <option value="24">24</option>
              <option value="30">30</option>
              <option value="60">60</option>
            </select>
          </label>

          <label className="field">
            <span>视频码率</span>
            <select
              value={String(settings.videoBitrate)}
              onChange={(event) => setExportSettings({ videoBitrate: Number(event.target.value) })}
            >
              <option value="4000000">4 Mbps（体积优先）</option>
              <option value="8000000">8 Mbps（推荐）</option>
              <option value="16000000">16 Mbps（画质优先）</option>
            </select>
          </label>

          <label className="field">
            <span>音频码率</span>
            <select
              value={String(settings.audioBitrate)}
              onChange={(event) => setExportSettings({ audioBitrate: Number(event.target.value) })}
            >
              <option value="96000">96 kbps</option>
              <option value="160000">160 kbps</option>
              <option value="192000">192 kbps</option>
            </select>
          </label>
        </div>

        <p className="hint">
          时长 {formatDuration(layout.totalSamples / SAMPLE_RATE)}，预计体积约 {(estimatedBytes / 1024 / 1024).toFixed(0)} MB
        </p>

        {progress ? (
          <div className="progress-area">
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: `${Math.round(progress.ratio * 100)}%` }} />
            </div>
            <div className="progress-meta">
              <span>{progress.phase}</span>
              <span>
                {progress.frames} / {progress.total} 帧 · {Math.round(progress.ratio * 100)}%
              </span>
            </div>
          </div>
        ) : null}

        <div className="modal-actions">
          {running ? (
            <button type="button" className="btn danger" onClick={() => abortRef.current?.abort()}>
              取消导出
            </button>
          ) : (
            <>
              <button type="button" className="btn" onClick={onClose}>
                关闭
              </button>
              <button type="button" className="btn primary" onClick={() => void startExport()}>
                开始导出
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
