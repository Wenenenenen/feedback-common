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
const st=()=>page.evaluate(()=>{const A=__PM_APP__.S;return{round:A.round,status:document.querySelector('#statusText').textContent,
  loss:A.loss,stepSize:A.stepSize,metaW:A.engineMeta&&A.engineMeta.W,busy:A.busy,playing:A.playing,done:A.done};});
const waitFor=async(pred,ms=60000)=>{const t0=Date.now();while(Date.now()-t0<ms){const v=await st();if(pred(v))return v;await page.waitForTimeout(300);}throw new Error('timeout');};

// 满规模计时（从运行操作起算）
const ch=page.waitForEvent('filechooser'); await page.click('#btnLoad'); (await ch).setFiles('.qa/big.json');
await waitFor(v=>v.metaW===256&&v.status==='第 0 轮');
let t0=Date.now();
await page.click('#btnRun');
let v=await waitFor(v=>v.done&&v.status==='已完成');
console.log('PERF 12 rounds (click 续跑 -> 末轮可查):',Date.now()-t0,'ms; final',v.round,v.loss.toFixed(6));
await page.screenshot({path:'.qa/shot-big-done.png',fullPage:true});

// 暂停续跑：与不间断运行比较同轮损失与导出字节
await page.locator('#zRows input').nth(0).fill('8');
await page.locator('#zRows input').nth(0).press('Enter');
await waitFor(v=>v.status==='第 0 轮'&&!v.busy);
await page.click('#btnRun');
await waitFor(v=>v.round>=3);
await page.click('#btnPause');
v=await waitFor(v=>!v.playing&&!v.busy);
const paused={round:v.round,loss:v.loss,stepSize:v.stepSize};
const q1=await page.evaluate(()=>Array.from(__PM_APP__.S.p||[]).length);
let d1=page.waitForEvent('download'); await page.click('#btnExportDrive'); const dl1=await d1; await dl1.saveAs('.qa/paused-drive.bin');
await page.click('#btnRun');
await waitFor(v=>v.round>=6);
await page.click('#btnPause'); await waitFor(v=>!v.playing&&!v.busy);
console.log('after pause at',(await st()).round);
let d2=page.waitForEvent('download'); await page.click('#btnExportDrive'); const dl2=await d2; await dl2.saveAs('.qa/paused6-drive.bin');
const fileEqual = fs.readFileSync('.qa/paused6-drive.bin').equals(fs.readFileSync('.qa/paused6-drive.bin'));
console.log('PAUSE resumed to 6, export bytes len',fs.statSync('.qa/paused6-drive.bin').size);

// 独立同设置不间断跑到 6 轮，比较导出字节
await page.locator('#zRows input').nth(0).fill('8');
await page.locator('#zRows input').nth(0).press('Enter');
await waitFor(v=>v.status==='第 0 轮'&&!v.busy);
await page.click('#btnRun');
v=await waitFor(v=>v.round===6);
await page.evaluate(()=>__PM_APP__.pause()); await waitFor(v=>!v.playing&&!v.busy);
let d3=page.waitForEvent('download'); await page.click('#btnExportDrive'); const dl3=await d3; await dl3.saveAs('.qa/straight6-drive.bin');
const eq=fs.readFileSync('.qa/paused6-drive.bin').equals(fs.readFileSync('.qa/straight6-drive.bin'));
console.log('PAUSE equivalence same-round loss/bytes:',v.loss.toFixed(10),'bytesEqual',eq);

// 旧任务不得覆盖新设置：运行中改 z 再改 eta，等旧任务结束，结果应与新设置第0轮一致
await page.click('#btnRun');
await page.waitForTimeout(700);
await page.locator('#zRows input').nth(1).fill('9');
await page.locator('#zRows input').nth(1).press('Enter');
await page.waitForTimeout(400);
await page.locator('#etaInput').fill('0.5');
await page.locator('#etaInput').press('Enter');
v=await waitFor(v=>v.status==='第 0 轮'&&!v.busy,90000);
await page.waitForTimeout(3000); // 给旧任务充分时间“归来”
v=await st();
console.log('STALE final after old task finishes:',JSON.stringify({round:v.round,status:v.status,loss:v.loss,eta:await page.inputValue('#etaInput')}));
const expectLoss=await page.evaluate(()=>{const A=__PM_APP__.S;return null;});
await page.screenshot({path:'.qa/shot-stale.png',fullPage:true});
console.log('errors',errs);
await browser.close();await new Promise(r=>server.close(r));
