export type Attrs = Record<string, string | number | boolean | null | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: Array<Node | string | null | undefined> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'html') node.innerHTML = String(value);
    else if (key.startsWith('data-') || key === 'role' || key === 'title' || key === 'aria-label') node.setAttribute(key, String(value));
    else if (key === 'checked' || key === 'disabled' || key === 'selected') (node as HTMLInputElement)[key as 'checked'] = Boolean(value);
    else if (key === 'value') (node as HTMLInputElement).value = String(value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function button(label: string, className = 'btn', onClick?: () => void): HTMLButtonElement {
  const b = el('button', { class: className, type: 'button' });
  b.textContent = label;
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

export function iconButton(label: string, title: string, onClick?: () => void): HTMLButtonElement {
  const b = el('button', { class: 'icon-btn', type: 'button', title, 'aria-label': title });
  b.textContent = label;
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

export function section(title: string, ...children: Array<Node | string | null>): HTMLElement {
  const wrap = el('section', { class: 'stack' }, [
    el('div', { class: 'section-head' }, [el('h2', { text: title })]),
    ...children,
  ]);
  return wrap;
}

export function badge(text: string, kind: 'ok' | 'warn' | 'danger' | 'info' | 'muted' = 'muted'): HTMLElement {
  return el('span', { class: `badge badge-${kind}`, text });
}

export function download(filename: string, contents: string, type = 'application/json'): void {
  const blob = new Blob([contents], { type });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
