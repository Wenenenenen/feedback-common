import { chromium } from '/home/wendy/.nvm/versions/node/v22.23.2/lib/node_modules/playwright/index.mjs';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json'};
const srv=createServer((q,r)=>{let p=decodeURIComponent(q.url.split('?')[0]);if(p==='/')p='/index.html';try{r.writeHead(200,{'content-type':mime[extname(p)]||'text/plain'});r.end(readFileSync(join(root,p)));}catch{r.writeHead(404);r.end();}});
await new Promise(r=>srv.listen(8799,'127.0.0.1',r));
const b=await chromium.launch(); const pg=await b.newPage({viewport:{width:1500,height:1000}});
const errs=[]; pg.on('pageerror',e=>errs.push(e.message));
await pg.goto('http://127.0.0.1:8799/index.html',{waitUntil:'networkidle'});
await pg.waitForSelector('.cp-handle[data-i="1"]');
const before=await pg.evaluate(()=>window.RKS.studio.curve.points[1].X.toString());
const box=await pg.locator('.cp-handle[data-i="1"] rect').first().boundingBox();
const cx=box.x+box.width/2, cy=box.y+box.height/2;
await pg.mouse.move(cx,cy); await pg.mouse.down();
for(let i=1;i<=10;i++){ await pg.mouse.move(cx+12*i, cy-8*i); }
await pg.mouse.up();
await pg.waitForTimeout(100);
const after=await pg.evaluate(()=>({x:window.RKS.studio.curve.points[1].X.toString(), undo:window.RKS.studio.undoStack.length}));
console.log('before X',before,'after',after);
// undo via button
await pg.click('#btn-undo');
const restored=await pg.evaluate(()=>window.RKS.studio.curve.points[1].X.toString());
console.log('restored',restored);
console.log('errors',errs);
const shot='/tmp/drag.png'; await pg.screenshot({path:shot});
await b.close(); srv.close();
if(after.x===before||after.undo!==1||restored!==before||errs.length) {console.error('DRAG FAIL');process.exit(1);}
console.log('DRAG OK');
