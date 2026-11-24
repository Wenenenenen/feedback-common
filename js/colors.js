// colors.js — 8 条源轨的固定身份色（dataviz 调色板，已通过 CVD/对比度校验）
// 颜色跟随实体：源轨 S_i 永远用第 i 槽，不随段数或排序重涂。
export const TRACK_COUNT = 8;

export const TRACK_COLORS_LIGHT = [
  '#2a78d6', '#eb6834', '#1baf7a', '#eda100',
  '#e87ba4', '#008300', '#6250d6', '#e34948',
];
export const TRACK_COLORS_DARK = [
  '#3987e5', '#d95926', '#199e70', '#c98500',
  '#d55181', '#0ca30c', '#9085e9', '#e66767',
];

// 运行时读 CSS 变量，自动跟随明暗主题
export function trackColor(index) {
  return `var(--track-${index})`;
}

export function trackHex(index, dark) {
  return (dark ? TRACK_COLORS_DARK : TRACK_COLORS_LIGHT)[index];
}

export function isDark() {
  return document.documentElement.dataset.theme === 'dark' ||
    (document.documentElement.dataset.theme !== 'light' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);
}
