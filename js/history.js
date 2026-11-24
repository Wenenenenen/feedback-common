// history.js — 撤销/重做
// 快照只复制段数组与段对象（源轨不可变，不进快照）。
// 约定：任何编辑后 push()；push 会截断旧重做栈，保证“撤销后再编辑清掉旧重做”。

const MAX_HISTORY = 100;

export class History {
  constructor() {
    this.undoStack = [];
    this.redoStack = [];
  }

  static snapshot(segments) {
    return segments.map((s) => ({ ...s }));
  }

  push(segments) {
    this.undoStack.push(History.snapshot(segments));
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
  }

  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }

  /** 返回恢复用的段数组（深拷贝），空栈返回 null */
  undo(currentSegments) {
    const prev = this.undoStack.pop();
    if (prev === undefined) return null;
    this.redoStack.push(History.snapshot(currentSegments));
    return prev;
  }

  redo(currentSegments) {
    const next = this.redoStack.pop();
    if (next === undefined) return null;
    this.undoStack.push(History.snapshot(currentSegments));
    return next;
  }
}
