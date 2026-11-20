/* 构建：把 index.html + css/js 内联为自包含单文件 dist/lightmap-mask-packer.html */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
let html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const css = fs.readFileSync(path.join(root, 'css', 'styles.css'), 'utf8');
html = html.replace('<link rel="stylesheet" href="css/styles.css">',
  '<style>\n' + css + '\n</style>');

['js/packer.js', 'js/sample-data.js', 'js/app.js'].forEach(rel => {
  const js = fs.readFileSync(path.join(root, rel), 'utf8');
  const tag = '<script src="' + rel + '"></script>';
  if (!html.includes(tag)) throw new Error('未找到引用 ' + rel);
  html = html.replace(tag, '<script>\n' + js + '\n</script>');
});

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const out = path.join(root, 'dist', 'lightmap-mask-packer.html');
fs.writeFileSync(out, html);
console.log('已生成', out, (fs.statSync(out).size / 1024).toFixed(1) + 'KB');
