import { chromium } from "/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright/index.mjs";
import { readFileSync, statSync } from "node:fs";
const ROOT="/home/wendy/jianzhi/feedback-tasks/opus-chain-cutroom";
const b=await chromium.launch(); const p=await b.newPage({viewport:{width:1440,height:950},acceptDownloads:true});
const errs=[]; p.on("pageerror",e=>errs.push("PAGEERROR "+e.message)); p.on("console",m=>{if(m.type()==="error")errs.push(m.text());});
let pass=0,fail=0; const ok=(c,m)=>{if(c)pass++;else{fail++;console.log("  FAIL:",m);}};

await p.goto("file://"+ROOT+"/index.html"); await p.waitForSelector("#file");

// 1. not-ogg file
await p.setInputFiles("#file","/tmp/opus-tools/notogg.bin"); await p.waitForTimeout(400);
ok((await p.textContent("#statusText")).includes("失败")||(await p.locator("#diagList .diagitem.bad").count())>0,"非 Ogg 文件报错");
console.log("notogg status:", await p.textContent("#statusText"));

// 2. tone sample + full select + download
await p.goto("file://"+ROOT+"/index.html"); await p.waitForSelector("#demoBtn");
await p.click("#demoBtn"); await p.waitForSelector("#cards:not([hidden])");
await p.locator('.tab[data-pane="cut"]').click();
await p.click("#cutAll"); await p.waitForTimeout(50);
const S=await p.inputValue("#cutS"), T=await p.inputValue("#cutT");
ok(S==="0" && Number(T)===198576,"全选设置 [0,198576)");
await p.click("#cutGo"); await p.waitForTimeout(150);
ok(await p.isEnabled("#cutDl"),"全选后可下载");
const [dl]=await Promise.all([p.waitForEvent("download"),p.click("#cutDl")]);
await dl.saveAs("/tmp/opus-tools/final_full.opus");
ok(statSync("/tmp/opus-tools/final_full.opus").size>0,"下载非空");

// 3. tiny range at 1 sample
await p.fill("#cutS","100"); await p.fill("#cutT","101"); await p.click("#cutGo"); await p.waitForTimeout(100);
ok(await p.isEnabled("#cutDl"),"1 样本区间可导出");

// 4. locate highlight
await p.locator('.tab[data-pane="locate"]').click();
await p.fill("#locSample","100000"); await p.click("#locGo");
ok((await p.textContent("#locOut")).includes("音频包"),"定位显示音频包");

// 5. diagnose clean sample
await p.locator('.tab[data-pane="diag"]').click();
ok((await p.locator("#diagList .diagitem.ok").count())===1,"干净样例诊断通过");

// 6. out-of-range locate
await p.locator('.tab[data-pane="locate"]').click();
await p.fill("#locSample","999999999"); await p.click("#locGo");
ok((await p.textContent("#locOut")).includes("超出"),"越界定位报错");

console.log("errors:", errs.length?errs:"none");
console.log(`PASS ${pass} FAIL ${fail}`);
await b.close(); process.exit(fail?1:0);
