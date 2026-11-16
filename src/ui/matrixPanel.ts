import type { AppSnapshot } from '../app/controller';
import { formatNumber } from '../app/controller';
import type { Mat4 } from '../core/types';
import { AFFINE_ROW_EPS } from '../core/matrix';
import { el } from './dom';

export interface MatrixPanelCallbacks {
  onApply(matrix: Mat4): void;
  onReset(): void;
  onCopyWorld(): void;
  onShowWorld(show: boolean): void;
}

const ROW_LABELS = ['m00', 'm01', 'm02', 'm03', 'm10', 'm11', 'm12', 'm13', 'm20', 'm21', 'm22', 'm23', 'm30', 'm31', 'm32', 'm33'];
const CELL_HINTS: Array<[string, string]> = [
  ['X 轴 →', ''],
  ['Y 轴 →', ''],
  ['Z 轴 →', ''],
  ['平移 →', ''],
];

export class MatrixPanel {
  readonly root: HTMLElement;
  private callbacks: MatrixPanelCallbacks;
  private inputs: HTMLInputElement[] = [];
  private gridWrap: HTMLElement;
  private errorEl: HTMLElement;
  private infoEl: HTMLElement;
  private targetEl: HTMLElement;
  private toggle: HTMLInputElement;
  private lastStateKey = '';
  private showWorld = false;
  private snapshot: AppSnapshot | null = null;
  private applyBtn: HTMLButtonElement;
  private revertBtn: HTMLButtonElement;

  constructor(root: HTMLElement, callbacks: MatrixPanelCallbacks) {
    this.root = root;
    this.callbacks = callbacks;
    this.root.classList.add('matrix-panel');

    const header = el('div', { class: 'matrix-head' });
    header.append(el('h2', { text: '矩阵数值编辑' }));
    this.targetEl = el('span', { class: 'matrix-target', text: '未选择节点' });
    header.append(this.targetEl);

    const modeWrap = el('label', { class: 'world-toggle' });
    this.toggle = el('input', { type: 'checkbox' }) as HTMLInputElement;
    this.toggle.addEventListener('change', () => {
      this.showWorld = this.toggle.checked;
      this.lastStateKey = '';
      this.callbacks.onShowWorld(this.showWorld);
      this.lastStateKey = '';
      if (this.snapshot) this.setSnapshot(this.snapshot);
    });
    modeWrap.append(this.toggle, document.createTextNode('查看世界矩阵（只读）'));
    header.append(modeWrap);
    this.root.append(header);

    this.infoEl = el('div', { class: 'matrix-info' });
    this.root.append(this.infoEl);

    this.gridWrap = el('div', { class: 'matrix-grid-wrap' });
    this.root.append(this.gridWrap);

    this.errorEl = el('div', { class: 'matrix-error', role: 'alert' });
    this.root.append(this.errorEl);

    const actions = el('div', { class: 'matrix-actions' });
    this.applyBtn = el('button', { class: 'btn primary', type: 'button', text: '应用矩阵' }) as HTMLButtonElement;
    this.applyBtn.addEventListener('click', () => this.apply());
    this.revertBtn = el('button', { class: 'btn', type: 'button', text: '还原' }) as HTMLButtonElement;
    this.revertBtn.addEventListener('click', () => this.revert());
    const copyWorld = el('button', { class: 'btn ghost', type: 'button', text: '复制世界矩阵' }) as HTMLButtonElement;
    copyWorld.addEventListener('click', () => this.callbacks.onCopyWorld());
    actions.append(this.applyBtn, this.revertBtn, copyWorld);
    this.root.append(actions);

    this.root.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.target as HTMLElement)?.tagName === 'INPUT') {
        e.preventDefault();
        this.apply();
      } else if (e.key === 'Escape' && (e.target as HTMLElement)?.tagName === 'INPUT') {
        e.preventDefault();
        this.revert();
        (e.target as HTMLElement).blur();
      }
    });
  }

  setSnapshot(snapshot: AppSnapshot): void {
    this.snapshot = snapshot;
    const state = snapshot.state;
    const id = state.active;
    const node = id !== null ? state.nodes.get(id) : null;
    const worldMatrix = id !== null ? snapshot.worlds.get(id) ?? null : null;
    const matrix = node ? (this.showWorld ? worldMatrix ?? node.matrix : node.matrix) : null;
    const world = id !== null ? snapshot.worlds.get(id) ?? null : null;
    const key = `${id}|${node ? node.matrix.join(',') : ''}|${this.showWorld ? (world?.join(',') ?? '') : ''}|${snapshot.activeRoot ?? ''}`;
    if (key === this.lastStateKey) return;
    this.lastStateKey = key;
    this.targetEl.textContent = id === null ? '未选择节点' : `${id} · ${this.showWorld ? '世界（只读）' : '局部'}`;
    this.toggle.checked = this.showWorld;
    this.inputs.forEach((input) => {
      input.disabled = id === null;
      input.readOnly = this.showWorld;
    });
    this.applyBtn.disabled = id === null || this.showWorld;
    this.revertBtn.disabled = id === null || this.showWorld;
    const copyWorld = this.root.querySelector('.matrix-actions .btn.ghost') as HTMLButtonElement | null;
    if (copyWorld) copyWorld.disabled = id === null;
    this.buildGrid(matrix ?? null);
    this.infoEl.replaceChildren();
    if (node && world) {
      this.infoEl.append(...describeMatrix(node.matrix, world));
    } else {
      this.infoEl.append(el('span', { class: 'muted', text: '在层级树或视口中选择一个节点以编辑其局部 4×4 仿射矩阵。' }));
    }
    this.errorEl.textContent = '';
  }

  private buildGrid(matrix: Mat4 | null): void {
    this.gridWrap.replaceChildren();
    this.inputs = [];
    if (!matrix) {
      this.gridWrap.append(el('div', { class: 'matrix-placeholder', text: '无矩阵' }));
      return;
    }
    const grid = el('div', { class: 'matrix-grid' });
    const corner = el('div', { class: 'matrix-corner', text: '行 \\ 列' });
    grid.append(corner);
    for (let c = 0; c < 4; c += 1) {
      const label = c < 3 ? ['X', 'Y', 'Z'][c] : '平移';
      grid.append(el('div', { class: 'matrix-col-label', text: label, title: `第 ${c} 列` }));
    }
    for (let r = 0; r < 4; r += 1) {
      const rowLabel = el('div', {
        class: `matrix-row-label${r === 3 ? ' affine-row' : ''}`,
        title: CELL_HINTS[r]?.[0] ?? '',
      });
      rowLabel.textContent = r === 3 ? '末行' : ['X 行', 'Y 行', 'Z 行'][r];
      grid.append(rowLabel);
      for (let c = 0; c < 4; c += 1) {
        const index = r * 4 + c;
        const input = el('input', {
          class: `matrix-input${r === 3 ? ' affine-row' : ''}${c === 3 && r < 3 ? ' translation-cell' : ''}`,
          type: 'text',
          inputmode: 'decimal',
          spellcheck: 'false',
          'aria-label': ROW_LABELS[index],
          value: formatCellExact(matrix[index]),
        }) as HTMLInputElement;
        input.dataset.index = String(index);
        this.inputs.push(input);
        grid.append(input);
      }
    }
    this.gridWrap.append(grid);
    for (const input of this.inputs) {
      input.addEventListener('keydown', (e) => {
        const idx = Number(input.dataset.index);
        const delta = e.key === 'ArrowUp' ? 1 : e.key === 'ArrowDown' ? -1 : 0;
        if (delta !== 0 && !e.altKey) {
          e.preventDefault();
          const value = Number(input.value);
          if (Number.isFinite(value)) {
            const step = e.shiftKey ? delta * 10 : delta;
            input.value = formatNumber(value + step, 6);
          }
        } else if (e.key === 'ArrowRight' && input.selectionStart === input.value.length) {
          const next = this.inputs[idx + 1];
          if (next) {
            e.preventDefault();
            next.focus();
            next.select();
          }
        } else if (e.key === 'ArrowLeft' && input.selectionStart === 0) {
          const prev = this.inputs[idx - 1];
          if (prev) {
            e.preventDefault();
            prev.focus();
            prev.select();
          }
        }
      });
    }
  }

  private apply(): void {
    if (this.showWorld) return;
    const cells = this.inputs.map((input) => input.value);
    try {
      const matrix = parseCellsStrict(cells);
      this.callbacks.onApply(matrix);
      this.errorEl.textContent = '';
    } catch (error) {
      this.errorEl.textContent = error instanceof Error ? error.message : String(error);
      this.errorEl.classList.add('visible');
      // Invalid input is not written: the document matrix is untouched.
      const active = this.inputs.find((input) => input.dataset.index === '0');
      active?.focus();
    }
  }

  private revert(): void {
    this.lastStateKey = '';
    if (this.snapshot) this.setSnapshot(this.snapshot);
    this.errorEl.textContent = '';
  }
}

/**
 * Lossless, compact text for a matrix cell: JS prints the shortest string that
 * round-trips to the identical double, so pressing "应用矩阵" without editing any
 * cell can never silently requantize the matrix.
 */
export function formatCellExact(value: number): string {
  if (Object.is(value, -0)) return '0';
  return String(value);
}

export function parseCellsStrict(cells: readonly string[]): Mat4 {
  if (cells.length !== 16) throw new Error('矩阵需要 16 个数值');
  const values = cells.map((cell, index) => {
    const trimmed = cell.trim();
    if (trimmed === '') throw new Error(`第 ${index + 1} 格为空`);
    if (!/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(trimmed)) {
      throw new Error(`第 ${index + 1} 格不是合法数字：“${cell}”`);
    }
    const value = Number(trimmed);
    if (!Number.isFinite(value)) throw new Error(`第 ${index + 1} 格不是有限数值`);
    return value;
  });
  for (let c = 0; c < 3; c += 1) {
    if (Math.abs(values[12 + c]) > AFFINE_ROW_EPS) throw new Error('末行前三列必须为 0（仿射矩阵）');
  }
  if (Math.abs(values[15] - 1) > AFFINE_ROW_EPS) throw new Error('末行最后一列必须为 1（仿射矩阵）');
  return values;
}

function describeMatrix(local: Mat4, world: Mat4): HTMLElement[] {
  const out: HTMLElement[] = [];
  out.push(el('div', { class: 'matrix-info-row' }, [
    el('span', { class: 'muted', text: '世界平移' }),
    el('code', { text: `(${[world[3], world[7], world[11]].map((v) => formatNumber(v, 5)).join(', ')})` }),
  ]));
  const detWorld = det3(world);
  const detLocal = det3(local);
  out.push(el('div', { class: 'matrix-info-row' }, [
    el('span', { class: 'muted', text: 'det(3×3)' }),
    el('code', { text: `局部 ${formatNumber(detLocal, 6)} · 世界 ${formatNumber(detWorld, 6)}` }),
  ]));
  const flags: string[] = [];
  if (Math.abs(detLocal) <= 1e-12) flags.push('局部奇异');
  if (Math.abs(detWorld) <= 1e-12) flags.push('世界奇异');
  if (detLocal < 0) flags.push('局部镜像');
  if (detWorld < 0) flags.push('世界镜像');
  const shear = shearMeasure(world);
  if (shear > 1e-6) flags.push(`世界剪切 ${formatNumber(shear, 4)}`);
  out.push(el('div', { class: 'matrix-info-row' }, [
    el('span', { class: 'muted', text: '属性' }),
    el('span', { class: 'matrix-flags', text: flags.length > 0 ? flags.join(' · ') : '刚正（无剪切/镜像）' }),
  ]));
  return out;
}

function det3(m: readonly number[]): number {
  return (
    m[0] * (m[5] * m[10] - m[6] * m[9]) -
    m[1] * (m[4] * m[10] - m[6] * m[8]) +
    m[2] * (m[4] * m[9] - m[5] * m[8])
  );
}

function shearMeasure(m: readonly number[]): number {
  const cols = [
    [m[0], m[4], m[8]],
    [m[1], m[5], m[9]],
    [m[2], m[6], m[10]],
  ];
  const lens = cols.map((c) => Math.hypot(c[0], c[1], c[2]));
  let max = 0;
  for (let i = 0; i < 3; i += 1) {
    for (let j = i + 1; j < 3; j += 1) {
      if (lens[i] === 0 || lens[j] === 0) return Infinity;
      const dot = Math.abs(cols[i][0] * cols[j][0] + cols[i][1] * cols[j][1] + cols[i][2] * cols[j][2]) / (lens[i] * lens[j]);
      max = Math.max(max, dot);
    }
  }
  return max;
}
