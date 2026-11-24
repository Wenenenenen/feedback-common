const { chromium } = require('playwright');
const fs = require('fs');
(async()=>{
 const browser=await chromium.launch({headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1100}});
 const errors=[]; page.on('pageerror',e=>errors.push(e.stack||e.message)); page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
 const baseUrl = process.env.BASE_URL || 'http://127.0.0.1:8321';
 await page.goto(`${baseUrl}/index.html`,{waitUntil:'networkidle'});
 await page.waitForSelector('#statusPill:has-text("最优计划")',{timeout:10000});
 const summary=await page.locator('#summaryBody').innerText();
 if(!summary.includes('最早全完工')||!summary.includes('4')) throw new Error('sample summary missing makespan 4: '+summary);
 const bars=page.locator('.gantt-interval'); if(await bars.count()!==2) throw new Error('expected 2 gantt bars');
 const rows=page.locator('#ledgerContainer tbody tr'); console.log('ledger rows',await rows.count());
 // Change station 1 outage from [4,5) to [1,2), forcing job 1 to start at 2.
 const a=page.locator('[data-closed-a]').first(), b=page.locator('[data-closed-b]').first();
 await a.fill('1'); await b.fill('2'); await b.blur();
 await page.waitForTimeout(500);
 await page.waitForFunction(()=>document.querySelector('#summaryBody')?.textContent.includes('6'),null,{timeout:8000});
 console.log('after closure summary', (await page.locator('#summaryBody').innerText()).replace(/\n/g,' | '));
 // Lock job 1 at tick 2.
 await page.locator('[data-lock-check]').first().check();
 await page.waitForTimeout(400);
 await page.waitForSelector('#statusPill:has-text("最优计划")');
 const lockVal=await page.locator('[data-lock-start]').first().inputValue();
 if(lockVal!=='2') throw new Error('expected lock input 2 after edit, got '+lockVal);
 // Export and reimport.
 const downloadPromise=page.waitForEvent('download');
 await page.click('#exportBtn');
 const download=await downloadPromise;
 const path='/tmp/cookfest-export.json'; await download.saveAs(path);
 const json=JSON.parse(fs.readFileSync(path,'utf8'));
 if(!json.plan?.assignments?.length) throw new Error('export missing assignments');
 await page.setInputFiles('#fileInput',path);
 await page.waitForSelector('#verificationContainer :text("已核验导入文件")',{timeout:5000});
 await page.waitForSelector('#verificationContainer .pill.good:has-text("核验通过")',{timeout:5000});
 const checks=page.locator('.start-check'); console.log('start checks',await checks.count());
 if(await checks.count()!==2) throw new Error('expected two start checks');
 await page.screenshot({path:'/tmp/cookfest-page.png',fullPage:true});
 // Import deliberately invalid simultaneous double-spend plan.
 const bad={deadline:3,stations:[{id:1,closed:[]},{id:2,closed:[]}],stock:{grain:1},tools:{},jobs:[
  {id:1,modes:[{id:1,station:1,ticks:1,use:{grain:1}}]},
  {id:2,modes:[{id:1,station:2,ticks:1,use:{grain:1}}]}
 ],plan:{assignments:[{jobId:1,modeId:1,start:0,end:1},{jobId:2,modeId:1,start:0,end:1}]}};
 fs.writeFileSync('/tmp/cookfest-bad.json',JSON.stringify(bad));
 await page.setInputFiles('#fileInput','/tmp/cookfest-bad.json');
 await page.waitForSelector('#verificationContainer .pill.bad:has-text("核验失败")',{timeout:5000});
 const badText=await page.locator('#verificationContainer').innerText();
 if(!badText.includes('汇总扣料')) throw new Error('bad import did not show aggregate material failure');
 console.log('page errors',errors);
 if(errors.length) throw new Error('Browser errors: '+errors.join('\n'));
 await browser.close();
 console.log('E2E OK');
})().catch(e=>{console.error(e);process.exit(1)});
