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
const page=await browser.newPage({viewport:{width:1440,height:1080},acceptDownloads:true});
const errs=[];page.on('pageerror',e=>errs.push(e.message));page.on('console',m=>{if(m.type()==='error')errs.push('console: '+m.text());});
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForFunction(()=>document.querySelector('#metaW').textContent==='16',null,{timeout:10000});
const read=sel=>page.textContent(sel);

// 载入满规模
const chooser=page.waitForEvent('filechooser');
await page.click('#btnLoad');
const ch=await chooser; await ch.setFiles('.qa/big.json');
const t0=Date.now();
await page.waitForFunction(()=>document.querySelector('#metaW').textContent==='256',null,{timeout:60000});
await page.waitForFunction(()=>document.querySelector('#statusText').textContent==='第 0 轮',null,{timeout:60000});
console.log('big loaded in',Date.now()-t0,'ms, loss',await read('#lossVal'));
const total=Date.now();
await page.click('#btnRun');
await page.waitForFunction(()=>document.querySelector('#statusText').textContent==='已完成',null,{timeout:60000});
console.log('12 rounds in',Date.now()-total,'ms, final loss',await read('#lossVal'),'round',await read('#roundVal'));
await page.screenshot({path:'.qa/shot-big-done.png',fullPage:true});
console.log('errors',errs);
await browser.close();await new Promise(r=>server.close(r));
