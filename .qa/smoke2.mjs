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
await page.waitForTimeout(300);
// 点查
const box=await page.locator('#view').boundingBox();
await page.locator('#view').click({position:{x:box.width*0.5,y:box.height*0.3}});
await page.waitForTimeout(200);
console.log('probe', await page.textContent('#probeHint'));
console.log('probeRows', await page.locator('#probeRows').evaluate(e=>[...e.children].map(n=>n.textContent).join(' | ')));
// 单步
await page.click('#btnStep');
await page.waitForFunction(()=>document.querySelector('#roundVal').textContent==='1',null,{timeout:15000});
await page.waitForTimeout(300);
console.log('round1 loss',await page.textContent('#lossVal'),'step',await page.textContent('#stepVal'));
await page.screenshot({path:'.qa/shot-step1.png',fullPage:true});
// 切强度视图
await page.click('#viewTabs button[data-view=intensity]');
await page.waitForTimeout(200);
await page.screenshot({path:'.qa/shot-intensity.png',fullPage:true});
// 梯度视图
await page.click('#viewTabs button[data-view=grad]');
await page.waitForTimeout(200);
await page.screenshot({path:'.qa/shot-grad.png',fullPage:true});
console.log('errors',errs);
await browser.close();await new Promise(r=>server.close(r));
