'use strict';
// 独立进程：仅驱动写入页
const fs = require('fs'), path = require('path');
require(path.join(__dirname, '..', 'js', 'wav-codec.js'));
require(path.join(__dirname, '..', 'js', 'watermark.js'));
function El(tag){this.tagName=tag;this.children=[];this.attrs={};this.style={};this._listeners={};this.className='';this._text='';this.innerHTML='';
const self=this;this.classList={add(c){const s=new Set(self.className.split(/\s+/).filter(Boolean));s.add(c);self.className=[...s].join(' ');},remove(c){const s=new Set(self.className.split(/\s+/).filter(Boolean));s.delete(c);self.className=[...s].join(' ');},contains(c){return self.className.split(/\s+/).indexOf(c)>=0;}};}
El.prototype.appendChild=function(c){this.children.push(c);return c;};
El.prototype.addEventListener=function(ev,fn){(this._listeners[ev]=this._listeners[ev]||[]).push(fn);};
El.prototype.dispatch=function(ev,d){if(d&&d.target&&d.target.files)this.files=d.target.files;(this._listeners[ev]||[]).forEach(f=>f(Object.assign({preventDefault(){},stopPropagation(){},dataTransfer:null,target:this},d||{})));};
El.prototype.setAttribute=function(k,v){this.attrs[k]=v;if(k==='class')this.className=v;};
El.prototype.querySelector=function(){return this._q||(this._q=new El('audio'));};
El.prototype.querySelectorAll=function(){return[];};
Object.defineProperty(El.prototype,'textContent',{get(){return this._text;},set(v){this._text=String(v);}});
Object.defineProperty(El.prototype,'value',{get(){return this._value!=null?this._value:(this.attrs.value||'');},set(v){this._value=v;}});
const elements={};const ensure=id=>elements[id]||(elements[id]=new El('div'));
global.document={querySelector:s=>ensure(s.replace('#','')),createElement:t=>new El(t),createTextNode:t=>({text:t})};
global.window=global;global.URL={createObjectURL:()=>'blob:mock',revokeObjectURL(){}};
global.Blob=class{constructor(p,o){this.parts=p;this.type=o&&o.type;}};
global.FileReader=class{readAsArrayBuffer(file){const self=this;setTimeout(()=>{self.result=file._buffer;self.onload({target:self});},0);}};
const tick=ms=>new Promise(r=>setTimeout(r,ms));
require(path.join(__dirname,'..','js','app-common.js'));
require(path.join(__dirname,'..','js','embed.js'));
let pass=0,fail=0;const check=(n,c,x)=>{if(c){pass++;console.log('  PASS',n);}else{fail++;console.log('  FAIL',n,x||'');}};
(async()=>{
  const src=fs.readFileSync(path.join(__dirname,'..','samples','watermark-bed.wav'));
  const srcBuf=src.buffer.slice(src.byteOffset,src.byteOffset+src.byteLength);
  ensure('fileInput').dispatch('change',{target:{files:[{name:'watermark-bed.wav',_buffer:srcBuf}]}});
  ensure('assetId')._value='1A2B3C4D';ensure('passphrase')._value='browser-pw';
  ensure('alpha')._value='0.01';ensure('alphaVal');ensure('idHint');ensure('passHint');
  ensure('players');ensure('downloadWrap');ensure('toast');
  await tick(20);
  check('文件载入 drop 进入 has 态',ensure('drop').classList.contains('has'));
  ensure('runBtn').dispatch('click');await tick(50);
  check('生成下载区',ensure('downloadWrap').children.length>0);
  check('三路试听',ensure('players').children.length===3);
  console.log(`embed page: ${pass} passed, ${fail} failed`);process.exit(fail?1:0);
})();
