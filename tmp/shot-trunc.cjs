const { chromium } = require('playwright');
(async()=>{
  const b=await chromium.launch({headless:true});
  const p=await b.newPage({viewport:{width:1500,height:900}});
  const errs=[];p.on('pageerror',e=>errs.push(e.message));
  await p.goto('http://127.0.0.1:8137/index.html');
  await p.setInputFiles('#file-input', process.cwd()+'/test/fixtures/trunc-midbody.pdq');
  await p.waitForSelector('#trunc-banner');
  await p.waitForTimeout(200);
  await p.screenshot({path:'tmp/shot-trunc.png'});
  // bad-crc provider badges
  await p.setInputFiles('#file-input', process.cwd()+'/test/fixtures/bad-crc-overwrite.pdq');
  await p.waitForSelector('#workspace:not(.hidden)');
  await p.evaluate(()=>{ PDMReel.inspectFrame(0,0); });
  // select tick 15 chip
  await p.evaluate(()=>{ const st=PDMReel.getResult(); });
  await p.click('.bit-chip[data-tick="15"]');
  await p.locator('#tick-detail').scrollIntoViewIfNeeded();
  await p.waitForTimeout(150);
  await p.screenshot({path:'tmp/shot-providers.png'});
  console.log('errors',errs.length?errs:'none');
  await b.close();
})().catch(e=>{console.error(e);process.exit(1)});
