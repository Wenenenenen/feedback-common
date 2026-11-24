import { chromium } from "/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright/index.mjs";
const ROOT="/home/wendy/jianzhi/feedback-tasks/opus-chain-cutroom";
const b=await chromium.launch();
for(const vp of [{width:390,height:844,name:"mobile"},{width:820,height:900,name:"tablet"}]){
  const p=await b.newPage({viewport:{width:vp.width,height:vp.height}});
  const errs=[]; p.on("pageerror",e=>errs.push(e.message));
  await p.goto("file://"+ROOT+"/index.html"); await p.waitForSelector("#demoMultiBtn");
  await p.click("#demoMultiBtn"); await p.waitForSelector("#cards:not([hidden])");
  await p.waitForTimeout(200);
  const hs = await p.evaluate(()=>({docW:document.documentElement.scrollWidth, winW:window.innerWidth}));
  console.log(vp.name, 'scrollWidth', hs.docW, 'win', hs.winW, hs.docW<=hs.winW+1?'no-hscroll':'H-SCROLL', 'errors', errs.length?errs:'none');
  await p.screenshot({path:`/tmp/opus-tools/resp_${vp.name}.png`, fullPage:false});
  await p.click('.tab[data-pane="cut"]');
  await p.fill("#cutS","1000");await p.fill("#cutT","100000");await p.click("#cutGo");
  await p.waitForTimeout(150);
  await p.screenshot({path:`/tmp/opus-tools/resp_${vp.name}_cut.png`});
  await p.close();
}
await b.close();
