import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, normalize, join } from 'node:path';
const HERE = '/home/wendy/jianzhi/feedback-tasks/temporal-history-reprojector/app';
const MIME = { '.html':'text/html','.mjs':'text/javascript','.json':'application/json','.gz':'application/gzip' };
const server = createServer(async (req,res)=>{
  let p = decodeURIComponent(req.url.split('?')[0]); if(p==='/') p='/index.html';
  try { const d = await readFile(normalize(join(HERE,p))); res.writeHead(200,{'content-type':MIME[extname(p)]||'application/octet-stream'}); res.end(d);}
  catch { res.writeHead(404); res.end(); }
});
await new Promise(r=>server.listen(0,r));
const b = await chromium.launch();
const shots = [
  { name:'desktop-light', w:1366,h:900, scheme:'light', seq:1 },
  { name:'desktop-dark', w:1366,h:900, scheme:'dark', seq:1 },
  { name:'phone-dark', w:390,h:844, scheme:'dark', seq:2 },
];
for (const s of shots) {
  const pg = await b.newPage({ viewport:{width:s.w,height:s.h}, colorScheme:s.scheme });
  await pg.goto(`http://127.0.0.1:${server.address().port}`,{waitUntil:'networkidle'});
  await pg.selectOption('#sequenceSelect',{index:s.seq});
  await pg.waitForFunction(()=>document.getElementById('status').textContent.includes('完成'),{timeout:30000});
  await pg.waitForTimeout(400);
  await pg.screenshot({ path: join(HERE,'test',s.name+'.png'), fullPage:true });
  await pg.close();
}
await b.close(); server.close();
console.log('shots done');
