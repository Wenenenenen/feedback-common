const { chromium } = require('playwright');
(async()=>{
  const b=await chromium.launch({headless:true});
  const p=await b.newPage();
  const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  await p.goto('file://'+process.cwd()+'/index.html');
  await p.click('#load-demo-btn');
  await p.waitForSelector('#workspace:not(.hidden)');
  await p.waitForSelector('.bit-chip');
  const ok=await p.evaluate(()=>({ch:PDMReel.getResult().channels, chips:document.querySelectorAll('.bit-chip').length}));
  console.log('file:// demo:',JSON.stringify(ok),'errors:',errs.length?errs:'none');
  await b.close();
})().catch(e=>{console.error(e);process.exit(1)});
