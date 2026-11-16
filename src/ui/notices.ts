import { el } from './dom';

export type NoticeKind = 'success' | 'error' | 'warn' | 'info';

interface Notice {
  id: number;
  kind: NoticeKind;
  title: string;
  detail?: string;
  timer: number;
}

export class NoticeCenter {
  readonly toastRoot: HTMLElement;
  readonly logEl: HTMLElement;
  private list = new Map<number, Notice>();
  private nextId = 1;
  private entries: Array<{ kind: NoticeKind; title: string; detail?: string; time: string }> = [];

  constructor(toastRoot: HTMLElement, logRoot: HTMLElement) {
    this.toastRoot = toastRoot;
    this.logEl = logRoot;
    this.renderLog();
  }

  show(kind: NoticeKind, title: string, detail?: string): void {
    const id = this.nextId++;
    const node = el('div', { class: `toast toast-${kind}`, role: kind === 'error' ? 'alert' : 'status' });
    node.dataset.noticeId = String(id);
    node.append(el('div', { class: 'toast-title', text: title }));
    if (detail) node.append(el('div', { class: 'toast-detail', text: detail }));
    const close = el('button', { class: 'toast-close', type: 'button', 'aria-label': '关闭', text: '×' });
    close.addEventListener('click', () => this.dismiss(id));
    node.append(close);
    node.addEventListener('mouseenter', () => {
      const notice = this.list.get(id);
      if (notice) {
        window.clearTimeout(notice.timer);
        notice.timer = 0;
      }
    });
    node.addEventListener('mouseleave', () => {
      const notice = this.list.get(id);
      if (notice && notice.timer === 0) notice.timer = window.setTimeout(() => this.dismiss(id), kind === 'error' ? 8000 : 3200);
    });
    const timer = window.setTimeout(() => this.dismiss(id), kind === 'error' ? 8000 : 3200);
    this.toastRoot.append(node);
    this.list.set(id, { id, kind, title, detail, timer });
    this.entries.unshift({ kind, title, detail, time: new Date().toLocaleTimeString('zh-CN', { hour12: false }) });
    if (this.entries.length > 80) this.entries.pop();
    this.renderLog();
  }

  dismiss(id: number): void {
    const notice = this.list.get(id);
    if (!notice) return;
    window.clearTimeout(notice.timer);
    this.list.delete(id);
    const node = this.toastRoot.querySelector(`[data-notice-id="${id}"]`);
    if (node instanceof HTMLElement) {
      node.classList.add('leaving');
      window.setTimeout(() => node.remove(), 180);
    }
  }

  private renderLog(): void {
    this.logEl.replaceChildren();
    if (this.entries.length === 0) {
      this.logEl.append(el('div', { class: 'log-empty', text: '尚无操作记录' }));
      return;
    }
    for (const entry of this.entries.slice(0, 30)) {
      this.logEl.append(
        el('div', { class: `log-row log-${entry.kind}` }, [
          el('span', { class: 'log-time', text: entry.time }),
          el('span', { class: 'log-title', text: entry.title }),
          entry.detail ? el('span', { class: 'log-detail', text: entry.detail }) : null,
        ]),
      );
    }
  }
}
