import { Controller, formatNumber, type AppSnapshot } from './app/controller';
import { SceneStore } from './core/history';
import { activeSelectionRoot, applyTransform, parseSceneDocument, selectionRoots, worldMatrices } from './core/scene';
import { averageOrigin, columnVector, normalize3 } from './core/matrix';
import type { Mat4, SceneState } from './core/types';
import { Viewport, type ViewSnapshot } from './render/viewport';
import { TreeView } from './ui/tree';
import { MatrixPanel } from './ui/matrixPanel';
import { TransformPanel } from './ui/transformPanel';
import { NoticeCenter } from './ui/notices';
import { button, el, iconButton } from './ui/dom';
import { parseCellsStrict } from './ui/matrixPanel';
import { loadSampleScene } from './ui/sampleScene';

export function createApp(root: HTMLElement) {
  const controller = new Controller(200);
  const toastStack = el('div', { class: 'toast-stack' });
  const logList = el('div', { class: 'log-list' });
  const notices = new NoticeCenter(toastStack, logList);
  controller.onNotice((kind, title, detail) => notices.show(kind, title, detail));

  // ---- Layout skeleton
  const topbar = el('header', { class: 'topbar' });
  const workspace = el('div', { class: 'workspace' });
  const leftPanel = el('aside', { class: 'panel left-panel' });
  const viewportWrap = el('main', { class: 'viewport-wrap' });
  const rightPanel = el('aside', { class: 'panel right-panel' });
  workspace.append(leftPanel, viewportWrap, rightPanel);
  const statusbar = el('footer', { class: 'statusbar' });
  root.replaceChildren(topbar, workspace, statusbar);
  root.append(toastStack);

  // ---- Top bar
  const title = el('div', { class: 'brand' }, [
    el('div', { class: 'brand-mark', text: '⬡' }),
    el('div', { class: 'brand-text' }, [
      el('h1', { text: '仿射层级场景编辑器' }),
      el('p', { text: '完整 4×4 仿射局部矩阵 · 保留世界变换换父 · 事务化撤销' }),
    ]),
  ]);
  const fileInput = el('input', { type: 'file', accept: '.json,application/json', class: 'hidden-file' }) as HTMLInputElement;
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    await importFile(file);
  });
  const importBtn = button('导入 JSON', 'btn', () => fileInput.click());
  importBtn.dataset.testid = 'import';
  const sampleBtn = button('载入样例场景', 'btn ghost', () => {
    controller.loadDocument(loadSampleScene(), '样例场景');
    notices.show('info', '已载入样例场景', 'payload 位于 parent 下，含剪切与奇异节点');
    refresh(true);
  });
  const exportBtn = button('导出 JSON', 'btn', () => exportScene());
  exportBtn.dataset.testid = 'export';
  const verifyBtn = button('导出并校验', 'btn ghost', () => verifyRoundTrip());
  verifyBtn.dataset.testid = 'verify';
  const undoBtn = iconButton('↶', '撤销 (Ctrl+Z)', () => {
    controller.undo();
    refresh();
  });
  undoBtn.dataset.testid = 'undo';
  const redoBtn = iconButton('↷', '重做 (Ctrl+Shift+Z)', () => {
    controller.redo();
    refresh();
  });
  redoBtn.dataset.testid = 'redo';
  const historyCount = el('span', { class: 'history-count', text: '0 / 0' });

  const actions = el('div', { class: 'top-actions' }, [
    importBtn,
    sampleBtn,
    exportBtn,
    verifyBtn,
    el('div', { class: 'divider' }),
    el('div', { class: 'history-group' }, [undoBtn, redoBtn, historyCount]),
    fileInput,
  ]);
  topbar.append(title, actions);

  // ---- Left: tree
  const treeSearch = el('input', {
    class: 'text-input search-input',
    type: 'search',
    placeholder: '筛选节点…',
    'aria-label': '筛选节点',
  }) as HTMLInputElement;
  treeSearch.addEventListener('input', () => tree.setSearch(treeSearch.value));
  const treeRoot = el('div', { class: 'tree', role: 'tree', 'aria-label': '场景层级' });
  const treeHeader = el('div', { class: 'panel-head' }, [
    el('h2', { text: '层级树' }),
    el('span', { class: 'panel-count', text: '0' }),
  ]);
  const treeHints = el('div', { class: 'tree-hints' }, [
    el('span', { text: '单击选择 · Shift 多选 · Ctrl 切换 · 拖动换父 · 双击聚焦' }),
  ]);
  const selectionActions = el('div', { class: 'selection-actions' }, [
    button('全选', 'btn small ghost', () => {
      controller.selectAll();
      refresh();
    }),
    button('清空', 'btn small ghost', () => {
      controller.clearSelection();
      refresh();
    }),
    button('移到根层级', 'btn small ghost', () => {
      controller.reparentSelection(null, true);
      refresh();
    }),
  ]);
  leftPanel.append(treeHeader, treeSearch, treeHints, treeRoot, selectionActions);

  // ---- Right: transform + matrix
  const transformPanel = new TransformPanel(el('section', { class: 'stack' }), {
    onTranslate: (space, axis, distance) => {
      controller.translate(space, axis, distance);
      refresh();
    },
    onRotate: (space, axis, degrees) => {
      controller.rotate(space, axis, degrees);
      refresh();
    },
    onGizmoModeChange: (mode) => {
      gizmoModeValue = mode;
      refresh();
    },
    onSpaceChange: (space) => {
      gizmoSpace = space;
      refresh();
    },
    onReparent: (preserveWorld) => {
      const value = transformPanel.targetValue;
      const target = value === '' ? null : value;
      controller.reparentSelection(target, preserveWorld);
      refresh();
    },
    onDropTo: (target, preserve) => {
      controller.reparentSelection(target, preserve);
      refresh();
    },
    onFrameAll: () => viewport.frameAll(currentViewSnapshot()),
  });

  const matrixPanel = new MatrixPanel(el('section', { class: 'stack' }), {
    onApply: (matrix) => {
      const state = controller.store.getState();
      const id = state.active;
      if (!id) return;
      controller.setLocalMatrixDirect(id, matrix);
      refresh();
    },
    onReset: () => refresh(),
    onCopyWorld: () => {
      const state = controller.store.getState();
      const id = state.active;
      if (!id) return;
      const world = controller.worlds().get(id);
      if (!world) return;
      void navigator.clipboard
        ?.writeText(world.map((v) => formatNumber(v, 9)).join(', '))
        .then(() => notices.show('success', '已复制世界矩阵', id))
        .catch(() => notices.show('warn', '无法访问剪贴板'));
    },
    onShowWorld: () => refresh(),
  });

  const helpSection = el('section', { class: 'stack help-block' }, [
    el('div', { class: 'section-head' }, [el('h2', { text: '矩阵格式' })]),
    el('p', {
      class: 'hint',
      text: '行主序 4×4，作用于列向量；世界矩阵 = 父世界 × 局部。末行必须为 [0, 0, 0, 1]。矩阵按完整仿射保存，镜像与剪切不会丢失。',
    }),
  ]);

  const logSection = el('section', { class: 'stack log-block' }, [
    el('div', { class: 'section-head' }, [el('h2', { text: '操作记录' })]),
    logList,
  ]);

  // Two tabs keep both core panels fully visible on shorter screens.
  const tabBar = el('div', { class: 'tab-bar', role: 'tablist' });
  const transformTab = el('button', { class: 'tab-btn on', type: 'button', role: 'tab', 'data-testid': 'tab-transform' });
  transformTab.textContent = '变换';
  const matrixTab = el('button', { class: 'tab-btn', type: 'button', role: 'tab', 'data-testid': 'tab-matrix' });
  matrixTab.textContent = '矩阵与记录';
  tabBar.append(transformTab, matrixTab);
  const transformPane = el('div', { class: 'right-pane' }, [transformPanel.root, helpSection]);
  const matrixPane = el('div', { class: 'right-pane', hidden: true }, [matrixPanel.root, logSection]);
  const setTab = (which: 'transform' | 'matrix'): void => {
    transformTab.classList.toggle('on', which === 'transform');
    matrixTab.classList.toggle('on', which === 'matrix');
    transformTab.setAttribute('aria-selected', which === 'transform' ? 'true' : 'false');
    matrixTab.setAttribute('aria-selected', which === 'matrix' ? 'true' : 'false');
    transformPane.hidden = which !== 'transform';
    matrixPane.hidden = which !== 'matrix';
  };
  transformTab.addEventListener('click', () => setTab('transform'));
  matrixTab.addEventListener('click', () => setTab('matrix'));
  rightPanel.append(tabBar, el('div', { class: 'right-scroll' }, [transformPane, matrixPane]));

  // ---- Status bar
  const statusSource = el('span', { class: 'status-item', text: '未载入' });
  const statusCounts = el('span', { class: 'status-item' });
  const statusRoots = el('span', { class: 'status-item' });
  const statusDirty = el('span', { class: 'status-item' });
  const labelToggle = el('input', { type: 'checkbox', checked: true, 'aria-label': '显示节点标签' }) as HTMLInputElement;
  labelToggle.addEventListener('change', () => {
    showLabels = labelToggle.checked;
    viewport.setShowLabels(showLabels);
    if (previewState) renderViewport(previewState);
  });
  const labelWrap = el('label', { class: 'status-toggle' }, [labelToggle, document.createTextNode('节点标签')]);
  const statusHint = el('span', { class: 'status-hint', text: '拖动 gizmo 轴操作 · Shift 吸附 · Esc 取消' });
  statusbar.append(statusSource, statusCounts, statusRoots, statusDirty, labelWrap, statusHint);

  // ---- Tree wiring
  let anchorSelection: string | null = null;
  let treeDragging = false;
  const tree = new TreeView(treeRoot, {
    onSelect: (id, mode) => {
      if (mode === 'toggle') {
        anchorSelection = id;
        controller.toggleSelection(id, true);
      } else if (mode === 'range') {
        const state = controller.store.getState();
        const order = flatOrder(state);
        const anchor = anchorSelection ?? id;
        const a = order.indexOf(anchor);
        const b = order.indexOf(id);
        if (a >= 0 && b >= 0) {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          controller.updateSelection(order.slice(lo, hi + 1), id);
        } else {
          controller.updateSelection([id], id);
        }
      } else {
        anchorSelection = id;
        controller.setActive(id, false);
      }
      refresh();
      // Pan only on single click; double-click zooms (handled in onFocus).
      viewport.focusNode(id, false);
    },
    onReparent: (ids, target) => {
      const preserve = transformPanel.preserveEnabled();
      const ok = controller.reparentNodes(ids, target, preserve);
      if (ok) anchorSelection = ids[0];
      refresh();
    },
    onDragStateChange: (dragging) => {
      treeDragging = dragging;
      if (!dragging && pendingTreeRender) {
        pendingTreeRender = false;
        tree.render(controller.snapshot());
      }
    },
    onFocus: (id) => {
      controller.setActive(id, false);
      refresh();
      viewport.focusNode(id, true);
    },
    onContextMenu: (id) => {
      if (!controller.store.getState().selection.includes(id)) {
        controller.setActive(id, false);
        refresh();
      }
      transformPanel.setTarget(id);
    },
  });

  // ---- Viewport
  const viewport = new Viewport(viewportWrap, {
    onPick: (id, additive) => {
      if (id === null) {
        if (!additive) {
          controller.clearSelection();
          refresh();
        }
        return;
      }
      if (additive) controller.toggleSelection(id, true);
      else controller.setActive(id, false);
      refresh();
    },
    onGizmoPreview: (mode, axis, value) => {
      // Preview must never throw out of a pointer event: an invalid batch simply
      // shows no preview, and the commit path reports the error and rolls back.
      try {
        const state = controller.store.getState();
        const preview = applyTransform(state, requestFor(mode, axis, value, gizmoSpace));
        previewState = preview.state;
        renderViewport(preview.state);
        statusHint.textContent = `${mode === 'translate' ? '平移' : '旋转'} ${axis.toUpperCase()} ${formatNumber(value, 3)}${mode === 'rotate' ? '°' : ' m'}（预览，松开提交）`;
      } catch {
        previewState = null;
        renderViewport(controller.store.getState());
        statusHint.textContent = '当前操作不可用（父矩阵奇异或轴长为 0），松开将回滚';
      }
    },
    onGizmoCommit: (mode, axis, value) => {
      previewState = null;
      const space = gizmoSpace;
      if (mode === 'translate') controller.translate(space, axis, value);
      else controller.rotate(space, axis, value);
      refresh();
    },
    onGizmoCancel: () => {
      previewState = null;
      renderViewport(controller.store.getState());
      statusHint.textContent = '拖动 gizmo 轴操作 · Shift 吸附 · Esc 取消';
    },
  });
  viewport.ensureHandles();

  let previewState: SceneState | null = null;
  let gizmoSpace: 'world' | 'local' = 'world';
  let gizmoModeValue: 'translate' | 'rotate' = 'translate';
  let showLabels = true;
  let didFrameAll = false;

  function currentViewSnapshot(): ViewSnapshot {
    const snapshot = controller.snapshot();
    const state = previewState ?? snapshot.state;
    const worlds = previewState ? worldMatricesOf(previewState) : snapshot.worlds;
    // During a gizmo drag the preview state is authoritative, so the gizmo follows
    // the moving selection instead of staying at the drag's starting point.
    let pivot = snapshot.pivot;
    let localAxes = snapshot.localAxes;
    if (previewState) {
      const roots = selectionRoots(previewState);
      pivot = roots.length > 0 ? averageOrigin(roots.map((id) => worlds.get(id)!)) : null;
      const activeRoot = activeSelectionRoot(previewState, roots);
      localAxes = activeRoot ? axesOf(worlds.get(activeRoot) ?? null) : null;
    }
    return {
      state,
      worlds,
      selection: new Set(state.selection),
      active: state.active,
      gizmo: { space: gizmoSpace, mode: gizmoModeValue, pivot, localAxes },
      showLabels,
    };
  }

  function axesOf(world: Mat4 | null) {
    if (!world) return null;
    const columns = [columnVector(world, 0), columnVector(world, 1), columnVector(world, 2)];
    for (const column of columns) {
      if (!Number.isFinite(Math.hypot(...column)) || Math.hypot(...column) === 0) return null;
    }
    return {
      x: normalize3(columns[0]),
      y: normalize3(columns[1]),
      z: normalize3(columns[2]),
    };
  }

  function renderViewport(state: SceneState): void {
    const snapshot = controller.snapshot();
    viewport.setSnapshot({
      ...currentViewSnapshot(),
      state,
      worlds: state === snapshot.state ? snapshot.worlds : worldMatricesOf(state),
      selection: new Set(state.selection),
      active: state.active,
    });
  }

  // ---- Refresh
  let pendingTreeRender = false;

  function refresh(frameAll = false): void {
    const snapshot = controller.snapshot();
    // Replacing the tree during an HTML5 drag cancels it; defer until dragend.
    if (treeDragging) pendingTreeRender = true;
    else {
      tree.render(snapshot);
      pendingTreeRender = false;
    }
    transformPanel.setSnapshot(snapshot);
    matrixPanel.setSnapshot(snapshot);
    if (previewState === null || !viewport.isDragging()) {
      // Ensure a stale preview can never leak into the committed view.
      if (previewState && !viewport.isDragging()) previewState = null;
      renderViewport(controller.store.getState());
    }
    const info = snapshot.history;
    undoBtn.disabled = !info.canUndo;
    redoBtn.disabled = !info.canRedo;
    historyCount.textContent = `${info.undoCount} / ${info.undoCount + info.redoCount}`;
    undoBtn.title = info.canUndo ? `撤销：${info.undoLabels[info.undoLabels.length - 1]}` : '没有可撤销的操作';
    redoBtn.title = info.canRedo ? `重做：${info.redoLabels[info.redoLabels.length - 1]}` : '没有可重做的操作';

    const counts = controller.layoutInfo();
    const countEl = treeHeader.querySelector('.panel-count');
    if (countEl) countEl.textContent = `${counts.nodes} 节点`;
    statusSource.textContent = controller.source;
    statusCounts.textContent = `节点 ${counts.nodes}/${counts.maxNodes} · 奇异 ${counts.singular} · 镜像 ${counts.mirrored} · 剪切 ${counts.sheared}`;
    statusRoots.textContent =
      snapshot.selectionRoots.length > 0
        ? `已选 ${snapshot.state.selection.length} · 顶层 ${snapshot.selectionRoots.length}`
        : '未选择';
    statusDirty.textContent = controller.isDirty ? '已修改' : '未修改';
    statusDirty.className = `status-item${controller.isDirty ? ' dirty' : ''}`;
    if (frameAll) {
      viewport.frameAll(currentViewSnapshot());
      didFrameAll = true;
    } else if (!didFrameAll && controller.store.getState().order.length > 0) {
      viewport.frameAll(currentViewSnapshot());
      didFrameAll = true;
    }
    if (snapshot.state.active) tree.focusRow(snapshot.state.active);
  }

  controller.subscribe(() => refresh());

  // ---- File operations
  async function importFile(file: File): Promise<void> {
    try {
      const text = await file.text();
      const parsed: unknown = JSON.parse(text);
      const result = controller.loadDocument(parsed, file.name);
      if (!result.ok) {
        notices.show('error', '导入失败，场景未改变', result.error);
        return;
      }
      notices.show('success', `已导入 ${file.name}`, result.warnings.join('；') || '未发现异常');
      didFrameAll = false;
      refresh(true);
    } catch (error) {
      notices.show('error', '导入失败，场景未改变', error instanceof Error ? error.message : String(error));
    }
  }

  function exportScene(): void {
    const json = controller.exportDocument();
    const name = controller.source.endsWith('.json') ? controller.source : `${controller.source || 'scene'}.json`;
    triggerDownload(name, json);
    const check = controller.verifyRoundTrip();
    notices.show(
      check.ok ? 'success' : 'warn',
      `已导出 ${name}`,
      check.ok
        ? `${check.nodes} 个节点 · 往返最大世界误差 ${check.maxWorldDelta.toExponential(2)} m`
        : `往返校验未通过：世界误差 ${check.maxWorldDelta}`,
    );
  }

  function verifyRoundTrip(): void {
    const result = controller.verifyRoundTrip();
    if (result.ok) {
      notices.show(
        'success',
        '导出并校验通过',
        `${result.nodes} 个节点 · 世界位置与剪切还原 · 最大误差 ${result.maxWorldDelta.toExponential(2)} m`,
      );
    } else {
      notices.show('error', '往返校验失败', result.error ?? `最大世界误差 ${result.maxWorldDelta}`);
    }
  }

  // ---- Keyboard
  window.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement | null;
    const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
    if (event.key === 'Escape') {
      if (viewport.isDragging()) {
        viewport.cancelDrag();
        notices.show('info', '已取消拖动，矩阵未改变');
      } else if (typing) {
        (target as HTMLElement).blur();
      }
      return;
    }
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) controller.redo();
      else controller.undo();
      refresh();
      return;
    }
    if (mod && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      controller.redo();
      refresh();
      return;
    }
    if (typing) return;
    if (mod && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      controller.selectAll();
      refresh();
      return;
    }
    if (event.key.toLowerCase() === 'w' && !mod) {
      gizmoSpace = 'world';
      transformPanel.setSpace('world');
      refresh();
    } else if (event.key.toLowerCase() === 'e' && !mod) {
      gizmoSpace = 'local';
      transformPanel.setSpace('local');
      refresh();
    } else if (event.key.toLowerCase() === 'g' && !mod) {
      gizmoModeValue = 'translate';
      transformPanel.setMode('translate');
      refresh();
    } else if (event.key.toLowerCase() === 'r' && !mod) {
      gizmoModeValue = 'rotate';
      transformPanel.setMode('rotate');
      refresh();
    } else if (event.key.toLowerCase() === 'f' && !mod) {
      viewport.frameAll(currentViewSnapshot());
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const state = controller.store.getState();
      const order = flatOrder(state);
      if (order.length === 0) return;
      event.preventDefault();
      const current = state.active ?? order[0];
      const index = Math.max(0, order.indexOf(current));
      const next = order[Math.min(order.length - 1, Math.max(0, index + (event.key === 'ArrowUp' ? -1 : 1)))];
      if (event.shiftKey) controller.updateSelection([...state.selection, next], next);
      else controller.setActive(next, false);
      refresh();
      tree.focusRow(next);
      viewport.focusNode(next);
    } else if (event.key === '[' || event.key === ']') {
      gizmoSpace = event.key === '[' ? 'world' : 'local';
      transformPanel.setSpace(gizmoSpace);
      refresh();
    }
  });

  window.addEventListener('beforeunload', (event) => {
    if (controller.isDirty) {
      event.preventDefault();
      event.returnValue = '';
    }
  });

  // Expose a small, documented automation surface for tests.
  const api = {
    importFile,
    exportScene,
    verifyRoundTrip: () => controller.verifyRoundTrip(),
    loadSample: () => {
      controller.loadDocument(loadSampleScene(), '样例场景');
      didFrameAll = false;
      refresh(true);
    },
    getScene: () => JSON.parse(controller.exportDocument()) as unknown,
    getSnapshot: () => serializableSnapshot(),
    setSelection: (ids: string[], active: string | null) => {
      controller.updateSelection(ids, active);
      refresh();
    },
    reparent: (target: string | null, preserve = true) => {
      const ok = controller.reparentSelection(target, preserve);
      refresh();
      return ok;
    },
    translate: (space: 'world' | 'local', axis: 'x' | 'y' | 'z', distance: number) => {
      const ok = controller.translate(space, axis, distance);
      refresh();
      return ok;
    },
    rotate: (space: 'world' | 'local', axis: 'x' | 'y' | 'z', degrees: number) => {
      const ok = controller.rotate(space, axis, degrees);
      refresh();
      return ok;
    },
    setGizmo: (space: 'world' | 'local', mode: 'translate' | 'rotate') => {
      gizmoSpace = space;
      gizmoModeValue = mode;
      transformPanel.setSpace(space);
      transformPanel.setMode(mode);
      refresh();
    },
    applyMatrix: (id: string, matrix: number[]) => {
      const ok = controller.setLocalMatrixDirect(id, matrix as Mat4);
      refresh();
      return ok;
    },
    undo: () => {
      const ok = controller.undo();
      refresh();
      return ok;
    },
    redo: () => {
      const ok = controller.redo();
      refresh();
      return ok;
    },
    history: () => controller.store.historyInfo(),
    worldOf: (id: string) => controller.worlds().get(id) ?? null,
    project: (point: [number, number, number]) => viewport.projectPoint(point),
    gizmoAxis: (axis: 'x' | 'y' | 'z') => viewport.gizmoAxisWorld(axis),
    gizmoRadiusPx: () => viewport.gizmoRadiusPx(),
    pivot: () => controller.snapshot().pivot,
    setTab: (which: 'transform' | 'matrix') => setTab(which),
  };
  (window as unknown as { scenario: typeof api }).scenario = api;

  function serializableSnapshot() {
    const snapshot = controller.snapshot();
    const state = snapshot.state;
    return {
      selection: [...state.selection],
      active: state.active,
      roots: [...snapshot.selectionRoots],
      activeRoot: snapshot.activeRoot,
      pivot: snapshot.pivot,
      localAxes: snapshot.localAxes,
      history: snapshot.history,
      nodes: state.order.map((id) => ({
        id,
        parent: state.nodes.get(id)!.parent,
        matrix: [...state.nodes.get(id)!.matrix],
        world: [...(snapshot.worlds.get(id) ?? [])],
      })),
    };
  }

  // Boot with the sample scene so the editor is immediately explorable.
  controller.loadDocument(loadSampleScene(), '样例场景');
  refresh(true);
  notices.show('info', '已载入样例场景', '拖拽层级树换父，或在右侧使用世界/本地轴操作');

  return { controller, viewport, refresh, api };
}

function requestFor(
  mode: 'translate' | 'rotate',
  axis: 'x' | 'y' | 'z',
  value: number,
  space: 'world' | 'local',
) {
  return mode === 'translate'
    ? ({ mode: 'translate', space, axis, distance: value } as const)
    : ({ mode: 'rotate', space, axis, degrees: value } as const);
}

function worldMatricesOf(state: SceneState): Map<string, Mat4> {
  return worldMatrices(state);
}

function triggerDownload(filename: string, contents: string): void {
  const blob = new Blob([contents], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function flatOrder(state: SceneState): string[] {
  const children = new Map<string | null, string[]>();
  for (const id of state.order) {
    const parent = state.nodes.get(id)!.parent;
    const list = children.get(parent) ?? [];
    list.push(id);
    children.set(parent, list);
  }
  const out: string[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null) => {
    for (const id of children.get(parent) ?? []) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      walk(id);
    }
  };
  walk(null);
  for (const id of state.order) if (!seen.has(id)) out.push(id);
  return out;
}

export { SceneStore, parseSceneDocument, parseCellsStrict, button };
