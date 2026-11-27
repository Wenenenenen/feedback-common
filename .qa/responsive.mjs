import pkg from '/tmp/sf-domtest/node_modules/playwright-core/index.js';
const { chromium } = pkg;
import http from 'node:http';import fs from 'node:fs';import path from 'node:path';
const ROOT=process.cwd();
const EXE='/home/wendy/.cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell';
const MIME={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8'};
const server=http.createServer((req,res)=>{const u=decodeURIComponent(req.url.split('?')[0]);const t=path.join(ROOT,u==='/'?'index.html':u);
  if(!t.startsWith(ROOT)||!fs.existsSync(t)){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'content-type':MIME[path.extname(t)]||'application/octet-stream'});fs.createReadStream(t).pipe(res);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
const browser=await chromium.launch({headless:true,executablePath:EXE,args:['--no-sandbox']});
for(const [name,vp,dark] of [['desktop',{width:1440,height:1000},false],['mobile',{width:390,height:844},false],['dark',{width:1440,height:1000},true]]){
  const page=await browser.newPage({viewport:vp,colorScheme:dark?'dark':'light'});
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForFunction(()=>document.querySelector('#metaW').textContent==='16',null,{timeout:10000});
  await page.click('#btnStep');
  await page.waitForFunction(()=>document.querySelector('#roundVal').textContent==='1',null,{timeout:15000});
  await page.waitForTimeout(400);
  const metric=await page.evaluate(()=>({sw:document.documentElement.scrollWidth,w:document.documentElement.clientWidth}));
  await page.screenshot({path:`.qa/shot-${name}.png`,fullPage:true});
  console.log(name,'scrollWidth',metric.sw,'clientW',metric.w,'hscroll',metric.sw>metric.w);
  await page.close();
}
await browser.close();await new Promise(r=>server.close(r));
