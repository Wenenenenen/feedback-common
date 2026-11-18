import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, createReadStream, existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
const ROOT = process.cwd();
const SAMPLES = join(ROOT, '.work/samples-extract');
const MIME = { '.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json' };
const server = createServer((req,res)=>{
  let path=decodeURIComponent(req.url.split('?')[0]);
  let file = path.startsWith('/samples/')?join(SAMPLES,path.slice(9)):join(ROOT,'src',normalize(path).replace(/^(\.\.[/\\])+/,''));
  if(existsSync(file)){res.setHeader('Content-Type',MIME[extname(file)]||'application/octet-stream');createReadStream(file).pipe(res);}else{res.statusCode=404;res.end();}
});
await new Promise(r=>server.listen(0,r));
const browser=await chromium.launch();
const page=await browser.newPage({viewport:{width:1400,height:900}});
await page.goto(`http://localhost:${server.address().port}/index.html`,{waitUntil:'networkidle'});
await page.setInputFiles('#fileInput',{name:'flat.json',mimeType:'application/json',buffer:readFileSync(join(SAMPLES,'flat.json'))});
await page.waitForFunction(()=>document.querySelector('#diagBox').textContent.includes('求解耗时'));
console.log('after load:', (await page.textContent('#diagBox')).match(/缓存：.*$/m)?.[0] || await page.textContent('#diagBox'));
await page.check('#multiMode');
const box=await page.locator('#gl').boundingBox();
// 试几个点击位置，看 sourceList 是否变化
for (const [fx,fy] of [[0.5,0.45],[0.4,0.5],[0.6,0.55],[0.5,0.6],[0.3,0.4]]) {
  await page.mouse.click(box.x+box.width*fx, box.y+box.height*fy);
  await page.waitForTimeout(150);
  console.log(`click(${fx},${fy}):`, await page.textContent('#sourceList'), '|', (await page.textContent('#diagBox')).match(/缓存：[^\n]*/)?.[0]);
}
await browser.close(); server.close();
