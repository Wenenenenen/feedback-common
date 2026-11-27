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
const page=await browser.newPage({viewport:{width:1440,height:1080}});
page.on('pageerror',e=>console.log('PAGEERR',e.message));
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(()=>document.querySelector('#metaW').textContent==='16',null,{timeout:10000});
const ch=page.waitForEvent('filechooser'); await page.click('#btnLoad'); (await ch).setFiles('.qa/big.json');
await page.waitForFunction(()=>document.querySelector('#metaW').textContent==='256',null,{timeout:60000});
await page.waitForTimeout(300);
await page.click('#btnRun');
for(let i=0;i<15;i++){
  await page.waitForTimeout(700);
  const st=await page.evaluate(()=>{const A=globalThis.__PM_APP__;return {round:A.S.round,status:A.S.state,playing:A.S.playing,done:A.S.done,busy:A.S.busy,steps:A.S.targetSteps,loss:A.S.loss};});
  console.log(i,JSON.stringify(st));
  if(st.round>=12) break;
}
await browser.close();await new Promise(r=>server.close(r));
