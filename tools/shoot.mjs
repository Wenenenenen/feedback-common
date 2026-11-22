import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const TYPES = {".html":"text/html;charset=utf-8",".js":"text/javascript;charset=utf-8",".ts":"video/mp2t"};
const server = createServer(async (req,res)=>{
  let p = decodeURIComponent(new URL(req.url,"http://x").pathname);
  if(p==="/")p="/index.html";
  try{const d=await readFile(normalize(join(root,p)));res.writeHead(200,{"Content-Type":TYPES[extname(p)]||"application/octet-stream"}).end(d);}catch{res.writeHead(404).end();}
});
await new Promise(r=>server.listen(8138,r));
await mkdir(join(root,"tools/shots"),{recursive:true});
const browser = await chromium.launch();
const shots = [
  {name:"desktop-light", w:1280,h:1400,theme:null},
  {name:"desktop-dark", w:1280,h:1400,theme:"dark"},
  {name:"phone-light", w:390,h:1500,theme:null},
];
for (const s of shots) {
  const ctx = await browser.newContext({viewport:{width:s.w,height:s.h}, colorScheme: s.theme==="dark"?"dark":"light"});
  const page = await ctx.newPage();
  await page.goto("http://localhost:8138/");
  if (s.theme) await page.evaluate(t=>document.documentElement.setAttribute("data-theme",t), s.theme);
  const fb = await readFile(join(root,"samples/switch.ts"));
  await page.setInputFiles("#file-input",{name:"switch.ts",mimeType:"video/mp2t",buffer:fb});
  await page.waitForSelector("#work-grid:not([hidden])");
  await page.waitForTimeout(300);
  await page.screenshot({path:join(root,`tools/shots/${s.name}.png`), fullPage:true});
  await ctx.close();
}
await browser.close(); server.close();
console.log("shots done");
