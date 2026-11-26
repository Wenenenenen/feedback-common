// 撤销/重做：场景快照栈，所有提交的编辑都经过这里
export class History {
  constructor(initialScene, limit = 100) {
    this.limit = limit;
    this.stack = [JSON.parse(JSON.stringify(initialScene))];
    this.pointer = 0;
  }

  get current() {
    return this.stack[this.pointer];
  }

  get canUndo() { return this.pointer > 0; }
  get canRedo() { return this.pointer < this.stack.length - 1; }

  push(scene) {
    // 丢弃 redo 分支
    this.stack = this.stack.slice(0, this.pointer + 1);
    this.stack.push(JSON.parse(JSON.stringify(scene)));
    if (this.stack.length > this.limit) this.stack.shift();
    this.pointer = this.stack.length - 1;
    return this.current;
  }

  undo() {
    if (!this.canUndo) return null;
    this.pointer--;
    return this.current;
  }

  redo() {
    if (!this.canRedo) return null;
    this.pointer++;
    return this.current;
  }
}
