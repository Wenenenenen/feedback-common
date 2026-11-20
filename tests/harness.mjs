import fs from 'node:fs';
import vm from 'node:vm';
import zlib from 'node:zlib';

const html = fs.readFileSync(new URL('../web/index.html', import.meta.url),'utf8');
const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
console.log('inline script blocks:', scripts.length);

function ctxStub(){
  return {
    createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4),width:w,height:h}),
    putImageData(){}, save(){}, restore(){}, strokeRect(){},
    set fillStyle(v){}, set strokeStyle(v){}, set lineWidth(v){}, set lineDash(v){},
    setLineDash(){},
  };
}
function stubEl(id){
  const store={};
  const fn=function(){};
  return new Proxy(fn,{
    get(t,p){
      if(p==='value'){ if(store.value===undefined){ store.value = id==='inTol'?'1e-8':id==='inMaxit'?'2000':'0'; } return store.value; }
      if(p==='style') return store.style ??= {};
      if(p==='dataset') return store.dataset ??= {};
      if(p==='classList') return {add(){},remove(){},toggle(){},contains:()=>false};
      if(p==='hidden') return store.hidden ?? false;
      if(p==='getContext') return ()=>ctxStub();
      if(p==='querySelectorAll') return ()=>[];
      if(p==='querySelector') return ()=>stubEl(id+'-q');
      if(p==='closest') return ()=>null;
      if(p==='scrollIntoView') return ()=>{};
      if(p==='width'||p==='height') return store[p] ?? 8;
      if(p in store) return store[p];
      return (store[p] ??= function(){});
    },
    set(t,p,v){ store[p]=v; return true; }
  });
}
const elMap=new Map();
const documentStub={
  getElementById:id=>{ if(!elMap.has(id))elMap.set(id,stubEl(id)); return elMap.get(id); },
  createElement:()=>stubEl('created'),
  body:{appendChild(){},removeChild(){}},
  documentElement:{dataset:{}},
};
class BlobStub{ constructor(parts,opts){this.parts=parts;this.opts=opts;} }
const sandbox={
  process, console, TextEncoder, TextDecoder, Uint8Array, Uint8ClampedArray, Int8Array, Int32Array,
  Float32Array, Float64Array, DataView, ArrayBuffer, Math, JSON, Date, Object, Array, Number,
  isNaN, isFinite, parseInt, parseFloat, setTimeout, clearTimeout, performance, atob, btoa,
  document:documentStub,
  matchMedia:()=>({matches:false}),
  window:{}, Blob:BlobStub, URL:{createObjectURL:()=>'blob:x',revokeObjectURL(){}},
  // Node 侧能力，仅供驱动测试使用
  nodeFs:fs, nodeZlib:zlib,
};
sandbox.window.DEMO_ZIP_B64='';
sandbox.globalThis=sandbox;
vm.createContext(sandbox);
const driver = fs.readFileSync(new URL('./driver.js', import.meta.url),'utf8');
vm.runInContext(scripts.join('\n')+'\n;'+driver, sandbox, {filename:'page-bundle.js'});
