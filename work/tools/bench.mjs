// 性能与容量验证：node work/tools/bench.mjs [packets]
// 先用 genbig.py 生成大文件，再用页面导入并测量“到页/包索引可查”的耗时。
import { chromium } from "/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright/index.mjs";
import { existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
const ROOT="/home/wendy/jianzhi/feedback-tasks/opus-chain-cutroom";
const big=ROOT+"/work/big.opus";
if(!existsSync(big)){
  // 101 包/轮 × 2971 ≈ 30 万包
  execFileSync("python3",["-I",ROOT+"/work/tools/genbig.py",ROOT+"/test/fixtures/mono20.opus",big,"2971"],{stdio:"inherit"});
}
console.log("big file:", (statSync(big).size/1048576).toFixed(1), "MiB");
const b=await chromium.launch(); const p=await b.newPage({viewport:{width:1440,height:950}});
const errs=[]; p.on("pageerror",e=>errs.push(e.message));
await p.goto("file://"+ROOT+"/index.html"); await p.waitForSelector("#file");
const t0=Date.now();
await p.setInputFiles("#file", big);
await p.waitForSelector("#cards:not([hidden])",{timeout:120000});
const wall=Date.now()-t0;
const pk=await p.textContent("#cPackets"), uiMs=await p.textContent("#cMs");
const ip=await p.evaluate(()=>{const buf=window.__cut.state.buf;const t=performance.now();const idx=window.OpusCut.parse(buf);const t2=performance.now();window.OpusCut.tabulate(idx);return {parse:t2-t,tab:performance.now()-t2,pages:idx.pageCount,packets:idx.packetCount};});
console.log(`导入到可查 wall=${wall}ms  UI解析=${uiMs}  包=${pk}  页=${ip.pages}`);
console.log(`页内：parse=${ip.parse.toFixed(0)}ms tabulate=${ip.tab.toFixed(0)}ms`);
// 查询一个样本
await p.locator('.tab[data-pane="locate"]').click();
await p.fill("#locSample", String(Math.floor(ip.packets*480))); await p.click("#locGo");
console.log("查询结果含音频包:", (await p.textContent("#locOut")).includes("音频包"));
console.log("errors:", errs.length?errs:"none");
console.log(wall < 20000 ? "PASS: 20 秒内可查" : "FAIL: 超过 20 秒");
await b.close();
