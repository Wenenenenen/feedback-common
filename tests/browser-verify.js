'use strict';
// 独立进程：仅驱动验证页，输入为预先嵌入的 WAV
const fs = require('fs'), path = require('path');
require(path.join(__dirname, '..', 'js', 'wav-codec.js'));
require(path.join(__dirname, '..', 'js', 'watermark.js'));
function El(tag){this.tagName=tag;this.children=[];this.attrs={};this.style={};this._listeners={};this.className='';this._text='';this.innerHTML='';
const self=this;this.classList={add(c){const s=new Set(self.className.split(/\s+/).filter(Boolean));s.add(c);self.className=[...s].join(' ');},remove(c){const s=new Set(self.className.split(/\s+/).filter(Boolean));s.delete(c);self.className=[...s].join(' ');},contains(c){return self.className.split(/\s+/).indexOf(c)>=0;}};}
El.prototype.appendChild=function(c){this.children.push(c);this._rebuildHtml();return c;};
El.prototype._rebuildHtml=function(){this.innerHTML=this.children.map(function(c){return c._text||'';}).join('');};
El.prototype.addEventListener=function(ev,fn){(this._listeners[ev]=this._listeners[ev]||[]).push(fn);};
El.prototype.dispatch=function(ev,d){if(d&&d.target&&d.target.files)this.files=d.target.files;(this._listeners[ev]||[]).forEach(f=>f(Object.assign({preventDefault(){},stopPropagation(){},dataTransfer:null,target:this},d||{})));};
El.prototype.setAttribute=function(){};
El.prototype.querySelector=function(){return this._q||(this._q=new El('audio'));};
El.prototype.querySelectorAll=function(){return[];};
Object.defineProperty(El.prototype,'textContent',{get(){return this._text;},set(v){this._text=String(v);}});
Object.defineProperty(El.prototype,'value',{get(){return this._value!=null?this._value:(this.attrs.value||'');},set(v){this._value=v;}});
const elements={};const ensure=id=>elements[id]||(elements[id]=new El('div'));
global.document={querySelector:s=>ensure(s.replace('#','')),createElement:t=>new El(t),createTextNode:t=>({text:t})};
global.window=global;global.URL={createObjectURL:()=>'blob:mock',revokeObjectURL(){}};
global.Blob=class{constructor(p,o){this.parts=p;}};
global.FileReader=class{readAsArrayBuffer(file){const self=this;setTimeout(()=>{self.result=file._buffer;self.onload({target:self});},0);}};
const tick=ms=>new Promise(r=>setTimeout(r,ms));
function allText(el){return el.children.map(c=>(c._text||'')+' '+allText(c)).join(' ');}
const WM=globalThis.WM;
require(path.join(__dirname,'..','js','app-common.js'));
require(path.join(__dirname,'..','js','verify.js'));
let pass=0,fail=0;const check=(n,c,x)=>{if(c){pass++;console.log('  PASS',n);}else{fail++;console.log('  FAIL',n,x||'');}};
(async()=>{
  const src=fs.readFileSync(path.join(__dirname,'..','samples','watermark-bed.wav'));
  const wav=WM.decodeWav(src.buffer.slice(src.byteOffset,src.byteOffset+src.byteLength));
  const marked=WM.embed(wav,'1A2B3C4D','browser-pw',{alpha:0.01});
  const outBuf=WM.encodeWav(marked.samples,wav.sampleRate);
  ensure('fileInput').dispatch('change',{target:{files:[{name:'clip.wav',_buffer:outBuf}]}});
  ensure('resultBox');ensure('toast');ensure('passHint');ensure('metaBox');
  await tick(20);
  check('文件载入',ensure('drop').classList.contains('has'));
  ensure('passphrase')._value='browser-pw';
  ensure('runBtn').dispatch('click');await tick(80);
  const html=allText(ensure('resultBox'));
  check('读出正确编号',html.indexOf('1A2B3C4D')>=0);
  check('显示校验通过',html.indexOf('校验通过')>=0);
  check('显示信号位置',html.indexOf('信号首次同步位置')>=0);
  ensure('passphrase')._value='wrong';
  ensure('runBtn').dispatch('click');await tick(80);
  const html2=allText(ensure('resultBox'));
  check('错口令报未检出',html2.indexOf('未检出')>=0);
  check('错口令不显示编号大字',html2.indexOf('id-big')<0);
  console.log(`verify page: ${pass} passed, ${fail} failed`);process.exit(fail?1:0);
})();
