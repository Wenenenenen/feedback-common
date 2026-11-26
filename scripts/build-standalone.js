const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });

const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const index = read('index.html');
const styles = read('styles.css');
const core = read('agreement-core.js');
const sample = read('sample-data.js');
const app = read('app.js');

function inlineAssets(html) {
  let out = html.replace(
    /<link rel="stylesheet" href="styles\.css" \/>/,
    () => `<style>\n${styles}\n</style>`,
  );
  out = out.replace(
    /  <script src="agreement-core\.js"><\/script>\n  <script src="sample-data\.js"><\/script>\n  <script src="app\.js"><\/script>/,
    () => `  <script>\n${core}\n  </script>\n  <script>\n${sample}\n  </script>\n  <script>\n${app}\n  </script>`,
  );
  return out;
}

const standalone = inlineAssets(index);
fs.writeFileSync(path.join(dist, 'instance-agreement.html'), standalone);

const bodyMatch = index.match(/<body>([\s\S]*?)<\/body>/);
if (!bodyMatch) throw new Error('Could not locate body in index.html');
let body = bodyMatch[1]
  .replace(/\s*<script src="agreement-core\.js"><\/script>\s*/, () => `\n<script>\n${core}\n</script>\n`)
  .replace(/\s*<script src="sample-data\.js"><\/script>\s*/, () => `\n<script>\n${sample}\n</script>\n`)
  .replace(/\s*<script src="app\.js"><\/script>\s*/, () => `\n<script>\n${app}\n</script>\n`);

const artifactFragment = `
<title>实例匹配对照台</title>
<meta name="claude:viewport-fit-sides" content="cover" />
<style>
${styles}
</style>
${body.trim()}
`;
fs.writeFileSync(path.join(dist, 'artifact.html'), artifactFragment);

console.log(`Wrote ${path.relative(root, path.join(dist, 'instance-agreement.html'))}`);
console.log(`Wrote ${path.relative(root, path.join(dist, 'artifact.html'))}`);
