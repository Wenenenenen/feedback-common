// 分量分类色（取自 dataviz 验证过的色盲友好分类色板，固定顺序、不循环生成）
export const COMP_COLORS = [
  '#257de0', // blue
  '#f47230', // orange
  '#00a888', // aqua/green
  '#d28e05', // yellow-ochre
  '#e24d8b', // magenta
  '#0a8a17', // green
  '#6a4ce2', // violet
  '#c2410c', // burnt orange
  '#0e7490', // cyan-800
  '#b45309', // amber-700
];
export function compColor(index) {
  return COMP_COLORS[index % COMP_COLORS.length];
}
export const COLORS = {
  ink: '#1b2430',
  inkSoft: '#46536a',
  edgeOk: '#9aa7bd',
  bad: '#d43d3a',
  badStrong: '#b3261e',
  primary: '#2563c9',
  spaceFill: '#eef1f6',
  spaceLine: '#c7d0df',
  anchor: '#2563c9',
  root: '#7a869c',
};
