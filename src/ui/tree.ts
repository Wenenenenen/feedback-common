import type { AppSnapshot } from '../app/controller';
import type { SceneState } from '../core/types';
import { linearInfo } from '../core/matrix';
import { ancestorsOf } from '../core/scene';
import { el } from './dom';

export interface TreeCallbacks {
  onSelect(id: string, mode: 'replace' | 'toggle' | 'range'): void;
  onReparent(ids: string[], targetId: string | null): void;
  onDragStateChange?(dragging: boolean): void;
  onFocus(id: string): void;
  onContextMenu?(id: string, x: number, y: number): void;
}

interface FlatRow {
  id: string;
  depth: number;
  hasChildren: boolean;
}

export class TreeView {
  readonly root: HTMLElement;
  private callbacks: TreeCallbacks;
  private collapsed = new Set<string>();
  private snapshot: AppSnapshot | null = null;
  private lastSignature = '';
  private rowElements = new Map<string, { li: HTMLElement; badges: HTMLElement }>();
  private rows = new Map<string, HTMLElement>();
  private search = '';
  private dragIds: string[] = [];
  private dropTargetId: string | null | undefined = undefined;

  constructor(root: HTMLElement, callbacks: TreeCallbacks) {
    this.root = root;
    this.callbacks = callbacks;
    this.root.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (this.dropTargetId === undefined) this.setDropTarget(null);
    });
    this.root.addEventListener('dragleave', (e) => {
      if ((e.target as Node) === this.root) this.setDropTarget(undefined);
    });
    this.root.addEventListener('drop', (e) => {
      e.preventDefault();
      const ids = this.dragIds;
      const target = this.dropTargetId ?? null;
      this.setDropTarget(undefined);
      this.dragIds = [];
      if (ids.length > 0) this.callbacks.onReparent(ids, target);
    });
    this.root.addEventListener('dragend', () => {
      this.setDropTarget(undefined);
      this.dragIds = [];
      this.callbacks.onDragStateChange?.(false);
    });
  }

  setSearch(value: string): void {
    this.search = value.trim().toLowerCase();
    this.render();
  }

  focusRow(id: string): void {
    this.rows.get(id)?.scrollIntoView({ block: 'nearest' });
  }

  render(snapshot: AppSnapshot | null = this.snapshot): void {
    if (snapshot) this.snapshot = snapshot;
    const state = this.snapshot?.state;

    if (!state || state.order.length === 0) {
      this.root.replaceChildren(el('div', { class: 'tree-empty', text: '尚无节点。载入场景以开始。' }));
      this.rows.clear();
      this.rowElements.clear();
      this.lastSignature = '';
      return;
    }

    const signature = this.signatureOf(snapshot ?? this.snapshot!);
    if (signature === this.lastSignature) {
      this.updateSelectionClasses(state);
      return;
    }
    this.lastSignature = signature;
    this.dropTargetId = undefined;
    this.root.replaceChildren();
    this.rows.clear();
    this.rowElements.clear();

    const flat = this.flatten(state);
    const visible = this.search === ''
      ? flat
      : flat.filter((row) => {
          if (row.id.toLowerCase().includes(this.search)) return true;
          // Keep ancestors of matching nodes visible.
          return ancestorsOf(state, row.id).some((a) => a.toLowerCase().includes(this.search));
        });

    if (this.search !== '') {
      this.root.append(
        el('div', { class: 'tree-hint', text: `筛选 “${this.search}” · ${visible.length} 项` }),
      );
    }

    for (const row of visible) {
      this.root.append(this.renderRow(state, row));
    }

    const dropRoot = el('div', { class: 'tree-root-drop', 'data-drop': 'root', text: '拖到此处 → 移到根层级' });
    dropRoot.addEventListener('dragover', (e) => {
      e.preventDefault();
      this.setDropTarget(null);
    });
    dropRoot.addEventListener('click', () => {
      if (this.snapshot && this.snapshot.state.selection.length > 0) {
        this.callbacks.onReparent(this.snapshot.state.selection, null);
      }
    });
    this.root.append(dropRoot);
  }

  /** Structure + badge signature; selection is applied separately for cheap updates. */
  private signatureOf(snapshot: AppSnapshot): string {
    const parts: string[] = [this.search, [...this.collapsed].join(',')];
    const state = snapshot.state;
    for (const id of state.order) {
      const node = state.nodes.get(id)!;
      if (!state.nodes.has(node.parent ?? '')) parts.push(`${id}|null`);
      else parts.push(`${id}|${node.parent}`);
      const info = linearInfo(snapshot.worlds.get(id) ?? node.matrix);
      parts.push(`${info.singular ? 's' : ''}${info.mirrored ? 'm' : ''}${info.sheared ? 'h' : ''}`);
    }
    return parts.join(';');
  }

  private updateSelectionClasses(state: SceneState): void {
    for (const [id, rowEl] of this.rows) {
      const selected = state.selection.includes(id);
      const active = state.active === id;
      rowEl.classList.toggle('selected', selected);
      rowEl.classList.toggle('active', active);
      rowEl.setAttribute('aria-selected', selected ? 'true' : 'false');
      if (active) rowEl.setAttribute('tabindex', '0');
      else rowEl.removeAttribute('tabindex');
    }
  }

  private flatten(state: SceneState): FlatRow[] {
    const children = new Map<string | null, string[]>();
    for (const id of state.order) {
      const parent = state.nodes.get(id)!.parent;
      const list = children.get(parent) ?? [];
      list.push(id);
      children.set(parent, list);
    }
    const out: FlatRow[] = [];
    const seen = new Set<string>();
    const walk = (parent: string | null, depth: number): void => {
      const list = children.get(parent) ?? [];
      for (const id of list) {
        if (seen.has(id)) continue;
        seen.add(id);
        const childList = children.get(id) ?? [];
        out.push({ id, depth, hasChildren: childList.length > 0 });
        if (!this.collapsed.has(id)) walk(id, depth + 1);
      }
    };
    walk(null, 0);
    // Safety net: never hide a node because of a malformed hierarchy.
    for (const id of state.order) {
      if (!seen.has(id)) out.push({ id, depth: 0, hasChildren: false });
    }
    return out;
  }

  private renderRow(state: SceneState, row: FlatRow): HTMLElement {
    const node = state.nodes.get(row.id)!;
    const info = this.snapshot!.state.order.includes(row.id)
      ? linearInfo(this.snapshot!.state.nodes.get(row.id)!.matrix)
      : null;
    const selected = state.selection.includes(row.id);
    const active = state.active === row.id;

    const li = el('div', {
      class: `tree-row${selected ? ' selected' : ''}${active ? ' active' : ''}`,
      role: 'treeitem',
      'aria-selected': selected ? 'true' : 'false',
      'data-node-id': row.id,
      'data-depth': row.depth,
      draggable: 'true',
      tabindex: active ? 0 : -1,
      title: row.id,
    });
    li.style.paddingLeft = `${8 + row.depth * 14}px`;

    const twisty = el('button', {
      class: `twisty${row.hasChildren ? '' : ' placeholder'}${this.collapsed.has(row.id) ? ' collapsed' : ''}`,
      type: 'button',
      'aria-label': this.collapsed.has(row.id) ? '展开' : '折叠',
      tabindex: -1,
    });
    twisty.textContent = row.hasChildren ? (this.collapsed.has(row.id) ? '▸' : '▾') : '·';
    twisty.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!row.hasChildren) return;
      if (this.collapsed.has(row.id)) this.collapsed.delete(row.id);
      else this.collapsed.add(row.id);
      this.render();
    });
    li.append(twisty);

    li.append(el('span', { class: 'tree-name', text: row.id }));
    const badges = el('span', { class: 'tree-badges' });
    if (info) {
      if (info.singular) badges.append(el('span', { class: 'chip chip-danger', text: '奇异', title: '世界矩阵奇异，不能作为保留世界变换的父节点' }));
      if (info.mirrored) badges.append(el('span', { class: 'chip chip-warn', text: '镜像', title: '行列式为负（镜像）' }));
      if (info.sheared) badges.append(el('span', { class: 'chip chip-info', text: '剪切', title: '线性部分含剪切' }));
    }
    if (node.parent === null) badges.append(el('span', { class: 'chip chip-muted', text: '根' }));
    li.append(badges);

    li.addEventListener('click', (event) => {
      const mode = event.shiftKey ? 'range' : event.ctrlKey || event.metaKey ? 'toggle' : 'replace';
      this.callbacks.onSelect(row.id, mode);
    });
    li.addEventListener('dblclick', () => this.callbacks.onFocus(row.id));
    li.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      this.callbacks.onContextMenu?.(row.id, event.clientX, event.clientY);
    });

    li.addEventListener('dragstart', (event) => {
      // Do not re-render the tree here: replacing the source node cancels the drag.
      // The dragged set is the current selection when this row belongs to it.
      const current = this.snapshot?.state.selection ?? [];
      this.dragIds = current.includes(row.id) ? [...current] : [row.id];
      event.dataTransfer?.setData('text/plain', row.id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      li.classList.add('dragging');
      this.callbacks.onDragStateChange?.(true);
    });
    li.addEventListener('dragend', () => {
      li.classList.remove('dragging');
      this.setDropTarget(undefined);
      this.callbacks.onDragStateChange?.(false);
    });

    li.addEventListener('dragover', (event) => {
      if (this.dragIds.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      this.setDropTarget(row.id);
    });
    li.addEventListener('drop', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const ids = this.dragIds;
      this.setDropTarget(undefined);
      this.dragIds = [];
      if (ids.length > 0) this.callbacks.onReparent(ids, row.id);
    });

    this.rows.set(row.id, li);
    return li;
  }

  private setDropTarget(id: string | null | undefined): void {
    if (id === this.dropTargetId) return;
    if (this.dropTargetId !== undefined && this.dropTargetId !== null) {
      this.rows.get(this.dropTargetId)?.classList.remove('drop-target', 'drop-invalid');
    }
    if (id === undefined) {
      this.root.querySelector('.tree-root-drop')?.classList.remove('drop-target');
      this.dropTargetId = undefined;
      return;
    }
    this.dropTargetId = id;
    if (id === null) {
      this.root.querySelector('.tree-root-drop')?.classList.add('drop-target');
      return;
    }
    const rowEl = this.rows.get(id);
    if (!rowEl) return;
    const state = this.snapshot?.state;
    const invalid = state ? this.dragIds.some((dragId) => dragId === id || ancestorsOf(state, id).includes(dragId)) : false;
    rowEl.classList.add(invalid ? 'drop-invalid' : 'drop-target');
  }
}
