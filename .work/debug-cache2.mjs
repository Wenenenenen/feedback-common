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
await page.check('#multiMode');
const box=await page.locator('#gl').boundingBox();
await page.mouse.click(box.x+box.width*0.5, box.y+box.height*0.45);
await page.waitForTimeout(200);
const d3 = await page.textContent('#diagBox');
const line = d3.split('\n').find(l=>l.includes('缓存'));
console.log('line=', JSON.stringify(line));
console.log('regex1=', /热分解 命中 [1-9]\d*\/未命中 1/.test(line));
console.log('regex2=', /Poisson 命中 0\/未命中 2/.test(line));
await browser.close(); server.close();
