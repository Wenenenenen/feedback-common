// Bundles app/index.html + local scripts into a single self-contained dist/index.html.
// External CDN scripts (three.js) stay external; everything local is inlined.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'app', 'index.html'), 'utf8');

const bundled = html.replace(/<script src="(app\/[^"]+)"><\/script>/g, (m, rel) => {
  const code = fs.readFileSync(path.join(root, rel), 'utf8');
  return '<script>\n' + code + '\n</script>';
});

const outDir = path.join(root, 'dist');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'index.html');
fs.writeFileSync(out, bundled);
console.log('wrote', out, (bundled.length / 1024).toFixed(1) + ' KiB');
if (bundled.length > 16 * 1024 * 1024) {
  console.error('exceeds 16MB artifact limit');
  process.exit(1);
}
