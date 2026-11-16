import type { AppSnapshot } from '../app/controller';
import { formatNumber } from '../app/controller';
import type { Vec3 } from '../core/types';
import { el } from './dom';

export interface TransformCallbacks {
  onTranslate(space: 'world' | 'local', axis: 'x' | 'y' | 'z', distance: number): void;
  onRotate(space: 'world' | 'local', axis: 'x' | 'y' | 'z', degrees: number): void;
  onGizmoModeChange(mode: 'translate' | 'rotate'): void;
  onSpaceChange(space: 'world' | 'local'): void;
  onReparent(preserveWorld: boolean): void;
  onDropTo(targetId: string | null, preserveWorld: boolean): void;
  onFrameAll(): void;
}

const AXES: Array<'x' | 'y' | 'z'> = ['x', 'y', 'z'];

export class TransformPanel {
  readonly root: HTMLElement;
  private callbacks: TransformCallbacks;
  private distanceInput: HTMLInputElement;
  private angleInput: HTMLInputElement;
  private targetInput: HTMLInputElement;
  private targetList: HTMLDataListElement;
  private selectionSummary: HTMLElement;
  private pivotInfo: HTMLElement;
  private axisInfo: HTMLElement;
  private preserveWorld: HTMLInputElement;
  private space: 'world' | 'local' = 'world';
  private gizmoMode: 'translate' | 'rotate' = 'translate';
  private snapshot: AppSnapshot | null = null;
  private spaceButtons = new Map<string, HTMLButtonElement>();
  private targetWarning: HTMLElement;

  constructor(root: HTMLElement, callbacks: TransformCallbacks) {
    this.root = root;
    this.callbacks = callbacks;
    this.root.classList.add('transform-panel');

    this.root.append(el('div', { class: 'section-head' }, [el('h2', { text: '变换与层级' })]));

    this.selectionSummary = el('div', { class: 'selection-summary' });
    this.root.append(this.selectionSummary);

    // ---- Space / mode toggles
    const modeRow = el('div', { class: 'seg-row' });
    const spaceGroup = el('div', { class: 'segmented', role: 'group', 'aria-label': '轴空间' });
    for (const space of ['world', 'local'] as const) {
      const b = el('button', {
        class: 'seg-btn',
        type: 'button',
        text: space === 'world' ? '世界轴' : '本地轴',
        title: space === 'world' ? '标准世界 XYZ' : '活动选中根的世界矩阵列向量（可非正交）',
      }) as HTMLButtonElement;
      b.dataset.space = space;
      b.addEventListener('click', () => {
        this.space = space;
        this.syncSpace();
        this.callbacks.onSpaceChange(space);
      });
      this.spaceButtons.set(space, b);
      spaceGroup.append(b);
    }
    const modeGroup = el('div', { class: 'segmented', role: 'group', 'aria-label': 'Gizmo 模式' });
    for (const mode of ['translate', 'rotate'] as const) {
      const b = el('button', {
        class: 'seg-btn',
        type: 'button',
        text: mode === 'translate' ? '平移' : '旋转',
      }) as HTMLButtonElement;
      b.dataset.mode = mode;
      b.addEventListener('click', () => {
        this.gizmoMode = mode;
        this.syncSpace();
        this.callbacks.onGizmoModeChange(mode);
      });
      this.spaceButtons.set(mode, b);
      modeGroup.append(b);
    }
    modeRow.append(spaceGroup, modeGroup);
    this.root.append(modeRow);

    this.axisInfo = el('div', { class: 'axis-info' });
    this.root.append(this.axisInfo);

    // ---- Translate
    const translate = el('div', { class: 'transform-block' });
    translate.append(el('div', { class: 'block-title', text: '平移（沿轴 · 米制距离）' }));
    const tRow = el('div', { class: 'transform-controls' });
    this.distanceInput = el('input', {
      class: 'num-input',
      type: 'number',
      step: '0.05',
      value: '0.5',
      'aria-label': '平移距离',
    }) as HTMLInputElement;
    tRow.append(el('label', { class: 'field-label', text: '距离' }), this.distanceInput);
    for (const axis of AXES) {
      const b = el('button', {
        class: `axis-btn axis-${axis}`,
        type: 'button',
        text: `+${axis.toUpperCase()}`,
        title: `沿 ${axis.toUpperCase()} 平移`,
        'data-testid': `translate-${axis}`,
      }) as HTMLButtonElement;
      b.addEventListener('click', () => {
        const distance = Number(this.distanceInput.value);
        this.callbacks.onTranslate(this.space, axis, distance);
      });
      tRow.append(b);
    }
    const negRow = el('div', { class: 'transform-controls secondary' });
    for (const axis of AXES) {
      const b = el('button', {
        class: `axis-btn axis-${axis} ghost`,
        type: 'button',
        text: `−${axis.toUpperCase()}`,
        'data-testid': `translate-negative-${axis}`,
      }) as HTMLButtonElement;
      b.addEventListener('click', () => {
        const distance = Number(this.distanceInput.value);
        this.callbacks.onTranslate(this.space, axis, -distance);
      });
      negRow.append(b);
    }
    translate.append(tRow, negRow);
    this.root.append(translate);

    // ---- Rotate
    const rotate = el('div', { class: 'transform-block' });
    rotate.append(el('div', { class: 'block-title', text: '旋转（右手定则 · 绕公共枢轴）' }));
    const rRow = el('div', { class: 'transform-controls' });
    this.angleInput = el('input', {
      class: 'num-input',
      type: 'number',
      step: '15',
      value: '90',
      'aria-label': '旋转角度',
    }) as HTMLInputElement;
    rRow.append(el('label', { class: 'field-label', text: '角度°' }), this.angleInput);
    for (const axis of AXES) {
      const b = el('button', {
        class: `axis-btn axis-${axis}`,
        type: 'button',
        text: `+${axis.toUpperCase()}`,
        title: `绕 ${axis.toUpperCase()} 轴旋转`,
        'data-testid': `rotate-${axis}`,
      }) as HTMLButtonElement;
      b.addEventListener('click', () => {
        const degrees = Number(this.angleInput.value);
        this.callbacks.onRotate(this.space, axis, degrees);
      });
      rRow.append(b);
    }
    const rNegRow = el('div', { class: 'transform-controls secondary' });
    for (const axis of AXES) {
      const b = el('button', {
        class: `axis-btn axis-${axis} ghost`,
        type: 'button',
        text: `−${axis.toUpperCase()}`,
        'data-testid': `rotate-negative-${axis}`,
      }) as HTMLButtonElement;
      b.addEventListener('click', () => {
        const degrees = Number(this.angleInput.value);
        this.callbacks.onRotate(this.space, axis, -degrees);
      });
      rNegRow.append(b);
    }
    rotate.append(rRow, rNegRow);
    this.root.append(rotate);

    this.pivotInfo = el('div', { class: 'pivot-info' });
    this.root.append(this.pivotInfo);

    // ---- Reparent
    const reparent = el('div', { class: 'transform-block reparent-block' });
    reparent.append(el('div', { class: 'block-title', text: '换父节点' }));
    const preserveWrap = el('label', { class: 'checkbox-row' });
    this.preserveWorld = el('input', { type: 'checkbox', checked: true }) as HTMLInputElement;
    preserveWrap.append(this.preserveWorld, document.createTextNode('保留世界变换（推荐）'));
    reparent.append(preserveWrap);

    const targetRow = el('div', { class: 'target-row' });
    this.targetInput = el('input', {
      class: 'text-input',
      type: 'text',
      placeholder: '目标父节点 id 或留空=根层级',
      list: 'node-id-list',
      'aria-label': '目标父节点',
    }) as HTMLInputElement;
    this.targetList = el('datalist', { id: 'node-id-list' }) as HTMLDataListElement;
    targetRow.append(this.targetInput, this.targetList);
    const apply = el('button', {
      class: 'btn primary',
      type: 'button',
      text: '应用换父',
      'data-testid': 'apply-reparent',
    }) as HTMLButtonElement;
    apply.addEventListener('click', () => {
      this.callbacks.onReparent(this.preserveWorld.checked);
    });
    targetRow.append(apply);
    reparent.append(targetRow);
    this.targetWarning = el('div', { class: 'target-warning' });
    reparent.append(this.targetWarning);
    reparent.append(
      el('p', {
        class: 'hint',
        text: '也可在层级树中把选中节点拖到目标节点上（默认保留世界变换）。父节点世界矩阵奇异时会拒绝整批操作。',
      }),
    );
    this.root.append(reparent);

    this.root.append(
      el('div', { class: 'transform-foot' }, [
        (() => {
          const b = el('button', { class: 'btn', type: 'button', text: '全览视图' }) as HTMLButtonElement;
          b.addEventListener('click', () => this.callbacks.onFrameAll());
          return b;
        })(),
      ]),
    );
    this.syncSpace();
  }

  get targetValue(): string {
    return this.targetInput.value.trim();
  }

  /** Keeps the panel in sync when the gizmo state is changed elsewhere (keyboard). */
  setSpace(space: 'world' | 'local'): void {
    if (this.space === space) return;
    this.space = space;
    this.syncSpace();
  }

  setMode(mode: 'translate' | 'rotate'): void {
    if (this.gizmoMode === mode) return;
    this.gizmoMode = mode;
    this.syncSpace();
  }

  setTarget(value: string): void {
    this.targetInput.value = value;
    this.updateTargetWarning();
  }

  preserveEnabled(): boolean {
    return this.preserveWorld.checked;
  }

  private syncSpace(): void {
    for (const space of ['world', 'local'] as const) {
      this.spaceButtons.get(space)?.classList.toggle('on', this.space === space);
      this.spaceButtons.get(space)?.setAttribute('aria-pressed', this.space === space ? 'true' : 'false');
    }
    for (const mode of ['translate', 'rotate'] as const) {
      this.spaceButtons.get(mode)?.classList.toggle('on', this.gizmoMode === mode);
      this.spaceButtons.get(mode)?.setAttribute('aria-pressed', this.gizmoMode === mode ? 'true' : 'false');
    }
  }

  setSnapshot(snapshot: AppSnapshot): void {
    this.snapshot = snapshot;
    const state = snapshot.state;
    const selectedCount = state.selection.length;
    const roots = snapshot.selectionRoots;

    this.selectionSummary.replaceChildren();
    if (selectedCount === 0) {
      this.selectionSummary.append(el('span', { class: 'muted', text: '未选择节点' }));
    } else {
      const activeLabel = state.active ?? '—';
      this.selectionSummary.append(
        el('span', { class: 'summary-count', text: `已选 ${selectedCount}` }),
        el('span', { class: 'summary-dot', text: '·' }),
        el('span', { class: 'summary-roots', text: `移动顶层 ${roots.length}` }),
        el('span', { class: 'summary-dot', text: '·' }),
        el('span', { class: 'summary-active' }, ['活动 ', el('b', { text: activeLabel })]),
      );
      if (roots.length < selectedCount) {
        this.selectionSummary.append(
          el('div', {
            class: 'summary-note',
            text: `子节点不重复移动：批量操作仅作用于 ${roots.join('、')}`,
          }),
        );
      }
    }

    const pivot = snapshot.pivot;
    this.pivotInfo.replaceChildren();
    if (pivot) {
      this.pivotInfo.append(
        el('span', { class: 'muted', text: '公共枢轴' }),
        el('code', { text: formatVec(pivot) }),
      );
      if (snapshot.activeRoot) {
        this.pivotInfo.append(el('span', { class: 'muted', text: ' · 本地轴来源' }), el('code', { text: snapshot.activeRoot }));
      }
    } else {
      this.pivotInfo.append(el('span', { class: 'muted', text: '选择节点后显示公共枢轴与轴方向' }));
    }

    this.axisInfo.replaceChildren();
    const axes = snapshot.localAxes;
    if (axes) {
      for (const axis of AXES) {
        this.axisInfo.append(
          el('div', { class: `axis-chip axis-${axis}` }, [
            el('span', { class: 'axis-chip-name', text: axis.toUpperCase() }),
            el('span', { class: 'axis-chip-vec', text: formatVec(axes[axis], 3) }),
          ]),
        );
      }
      const orthogonal = isOrthogonal(axes.x, axes.y, axes.z);
      if (!orthogonal) {
        this.axisInfo.append(el('span', { class: 'chip chip-info', text: '本地轴非正交（剪切）' }));
      }
    }

    const applyBtn = this.root.querySelector('[data-testid="apply-reparent"]') as HTMLButtonElement | null;
    if (applyBtn) applyBtn.disabled = selectedCount === 0;
    for (const b of this.root.querySelectorAll<HTMLButtonElement>('.axis-btn')) b.disabled = selectedCount === 0;

    const options = this.targetList;
    options.replaceChildren();
    for (const id of state.order) {
      const opt = el('option', { value: id }) as HTMLOptionElement;
      options.append(opt);
    }
    this.updateTargetWarning();
  }

  private updateTargetWarning(): void {
    const snapshot = this.snapshot;
    if (!snapshot) return;
    const raw = this.targetInput.value.trim();
    this.targetWarning.textContent = '';
    this.targetWarning.className = 'target-warning';
    if (raw === '') return;
    const state = snapshot.state;
    if (!state.nodes.has(raw)) {
      this.targetWarning.textContent = '目标节点不存在';
      this.targetWarning.classList.add('warn');
      return;
    }
    const target = state.nodes.get(raw)!;
    const chain = [raw, ...ancestorsOfLocal(state, raw)];
    if (snapshot.selectionRoots.some((root) => chain.includes(root))) {
      this.targetWarning.textContent = '目标位于选中子树内，会产生循环引用';
      this.targetWarning.classList.add('danger');
      return;
    }
    const worldInfo = snapshot.worlds.get(raw);
    if (worldInfo) {
      const det = worldInfo[0] * (worldInfo[5] * worldInfo[10] - worldInfo[6] * worldInfo[9])
        - worldInfo[1] * (worldInfo[4] * worldInfo[10] - worldInfo[6] * worldInfo[8])
        + worldInfo[2] * (worldInfo[4] * worldInfo[9] - worldInfo[5] * worldInfo[8]);
      if (Math.abs(det) <= 1e-12) {
        this.targetWarning.textContent = '目标父节点世界矩阵奇异：保留世界变换将被拒绝';
        this.targetWarning.classList.add('warn');
      }
    }
    void target;
  }
}

function ancestorsOfLocal(state: AppSnapshot['state'], id: string): string[] {
  const out: string[] = [];
  let current = state.nodes.get(id)?.parent ?? null;
  const seen = new Set<string>();
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    out.push(current);
    current = state.nodes.get(current)?.parent ?? null;
  }
  return out;
}

function formatVec(v: Vec3, digits = 4): string {
  return `(${v.map((x) => formatNumber(x, digits)).join(', ')})`;
}

function isOrthogonal(x: Vec3, y: Vec3, z: Vec3): boolean {
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return Math.abs(dot(x, y)) < 1e-6 && Math.abs(dot(x, z)) < 1e-6 && Math.abs(dot(y, z)) < 1e-6;
}
