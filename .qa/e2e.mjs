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
function assert(c,m){if(!c)throw new Error('ASSERT '+m);}

// 1. 导出驱动 + 误差 JSON
await page.click('#btnStep');
await page.waitForFunction(()=>document.querySelector('#roundVal').textContent==='1',null,{timeout:15000});
await page.waitForTimeout(300);
const [dlDrive]=await Promise.all([page.waitForEvent('download'),page.click('#btnExportDrive')]);
await dlDrive.saveAs('.qa/out-drive.bin');
const [dlErr]=await Promise.all([page.waitForEvent('download'),page.click('#btnExportError')]);
await dlErr.saveAs('.qa/out-error.json');
const b=fs.readFileSync('.qa/out-drive.bin');
console.log('drive bytes',b.length,'sample256', [...b.subarray(0,8).map(v=>v>=128?v-256:v)]);
const ej=JSON.parse(fs.readFileSync('.qa/out-error.json','utf8'));
console.log('error json',JSON.stringify(ej));

// 2. 坏输入：保留上一份有效项目
const bad=JSON.parse(fs.readFileSync('samples/phase-mask.json','utf8'));
bad.planes[0].weight[3]='oops';
fs.writeFileSync('.qa/bad.json',JSON.stringify(bad));
const chooser=page.waitForEvent('filechooser');
await page.click('#btnLoad');
const ch=await chooser; await ch.setFiles('.qa/bad.json');
await page.waitForTimeout(600);
console.log('after bad status:',await read('#loadStatus'));
console.log('meta still:',await read('#metaW'),await read('#metaH'),'round',await read('#roundVal'));
assert(await read('#metaW')==='16','project preserved after bad input');

// 3. 改 z -> 回第 0 轮
const zInput = page.locator('#zRows input').nth(1);
await zInput.fill('11');
await zInput.press('Enter');
await page.waitForTimeout(700);
console.log('after z change round',await read('#roundVal'),'loss',await read('#lossVal'),'msg',await read('#paramMsg'));
assert(await read('#roundVal')==='0','z change resets to round 0');

// 4. 续跑 + 暂停
await page.click('#btnRun');
await page.waitForTimeout(1200);
const midRound=await read('#roundVal');
await page.click('#btnPause');
await page.waitForFunction(()=>document.querySelector('#statusText').textContent!=='续跑中',null,{timeout:15000});
await page.waitForTimeout(400);
const pausedRound=await read('#roundVal');
console.log('running mid',midRound,'paused at',pausedRound,'status',await read('#statusText'));
await page.screenshot({path:'.qa/shot-paused.png',fullPage:true});

// 5. 续跑到底
await page.click('#btnRun');
await page.waitForFunction(()=>document.querySelector('#statusText').textContent==='已完成',null,{timeout:30000});
await page.waitForTimeout(500);
console.log('final round',await read('#roundVal'),'loss',await read('#lossVal'));
await page.screenshot({path:'.qa/shot-done.png',fullPage:true});
console.log('errors',errs);
await browser.close();await new Promise(r=>server.close(r));
