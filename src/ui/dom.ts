/** 极小的 DOM 构造辅助，避免模板字符串拼接带来的转义问题。 */

type Child = Node | string | number | null | undefined | false;

export interface ElOptions {
  class?: string;
  text?: string;
  title?: string;
  dataset?: Record<string, string>;
  attrs?: Record<string, string | number | boolean | null>;
  on?: Partial<Record<keyof HTMLElementEventMap, (event: never) => void>>;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, options: ElOptions = {}, children: Child[] = []): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.class) node.className = options.class;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.title) node.title = options.title;
  if (options.dataset) {
    for (const [key, value] of Object.entries(options.dataset)) node.dataset[key] = value;
  }
  if (options.attrs) {
    for (const [key, value] of Object.entries(options.attrs)) {
      if (value === null || value === false) continue;
      if (value === true) node.setAttribute(key, '');
      else node.setAttribute(key, String(value));
    }
  }
  if (options.on) {
    for (const [event, handler] of Object.entries(options.on)) {
      node.addEventListener(event, handler as EventListener);
    }
  }
  append(node, children);
  return node;
}

export function append(parent: Element, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child instanceof Node ? child : String(child));
  }
}

export function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  return el('button', { class: className, text: label, attrs: { type: 'button' }, on: { click: onClick } });
}

export function iconButton(glyph: string, title: string, onClick: () => void): HTMLButtonElement {
  const node = el('button', { class: 'icon-btn', text: glyph, title, attrs: { type: 'button' }, on: { click: onClick } });
  node.setAttribute('aria-label', title);
  return node;
}

export function fmt(value: number | null | undefined, digits = 4): string {
  if (value === null || value === undefined) return '无数据';
  if (!Number.isFinite(value)) return '∞';
  if (value === 0) return '0';
  const abs = Math.abs(value);
  if (abs < 1e-4) return value.toExponential(2);
  return value.toFixed(digits);
}

export function fmtPower(value: number | null): string {
  if (value === null) return '无数据';
  if (value === 0) return '0';
  if (!Number.isFinite(value)) return '∞';
  return value < 1e-3 ? value.toExponential(2) : value.toFixed(6);
}

export function fmtDb(value: number | null): string {
  if (value === null) return '无数据';
  if (!Number.isFinite(value)) return '∞ dB';
  return `${value.toFixed(2)} dB`;
}

export function fmtFrames(value: number, sampleRate: number): string {
  const seconds = value / sampleRate;
  return `${value} 帧 · ${seconds.toFixed(3)} s`;
}

export function downloadBytes(bytes: Uint8Array | Blob, filename: string, mime = 'application/octet-stream'): void {
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes as unknown as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function downloadText(text: string, filename: string, mime = 'application/json'): void {
  downloadBytes(new Blob([text], { type: mime }), filename, mime);
}

export function parseNumberInput(input: HTMLInputElement): number {
  const value = input.value.trim();
  if (value === '') return Number.NaN;
  return Number(value);
}

/** 带正负号的数值文本（用于抽头表）。 */
export function fmtSigned(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (Object.is(value, -0)) return '0';
  return value.toFixed(6);
}
