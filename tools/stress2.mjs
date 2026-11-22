// Stress with realistic clock increments and forced wraps/discontinuities.
import { analyze } from "../src/analyzer.js";
import { PTS_MOD, PCR_MOD } from "../src/clock.js";

const packets = 100_000;
const buf = new Uint8Array(packets * 188);
function wp(i, pid, cc, { pusi=false, afc=1, pts=null, pcr=null, disc=false } = {}) {
  const off = i * 188;
  buf.fill(0xff, off, off + 188);
  buf[off] = 0x47;
  buf[off+1] = ((pusi?1:0)<<6) | ((pid>>8)&0x1f);
  buf[off+2] = pid & 0xff;
  buf[off+3] = (afc<<4) | (cc&0xf);
  let pos = off+4;
  if (afc & 2) {
    const bodyLen = pcr !== null ? 6 : 0;
    buf[pos] = 1 + bodyLen;
    buf[pos+1] = (disc?0x80:0) | (pcr!==null?0x10:0);
    if (pcr !== null) {
      const base = pcr/300n, ext = pcr%300n;
      buf[pos+2]=Number((base>>25n)&0xffn); buf[pos+3]=Number((base>>17n)&0xffn);
      buf[pos+4]=Number((base>>9n)&0xffn);  buf[pos+5]=Number((base>>1n)&0xffn);
      buf[pos+6]=Number(((base&1n)<<7n)|((ext>>8n)&1n)); buf[pos+7]=Number(ext&0xffn);
    }
    pos = off + 5 + buf[off+4];
  }
  if ((afc&1) && pts !== null) {
    buf[pos]=0;buf[pos+1]=0;buf[pos+2]=1;buf[pos+3]=0xe0;
    buf[pos+4]=0;buf[pos+5]=14;buf[pos+6]=0x80;buf[pos+7]=0x80;buf[pos+8]=5;
    buf[pos+9]=0x21|Number(((pts>>30n)&7n)<<1n);
    buf[pos+10]=Number((pts>>22n)&0xffn);
    buf[pos+11]=0x01|Number(((pts>>15n)&0x7fn)<<1n);
    buf[pos+12]=Number((pts>>7n)&0xffn);
    buf[pos+13]=0x01|Number((pts&0x7fn)<<1n);
  }
}

let ptsAcc = BigInt(PTS_MOD) - 1000n;
let pcrAcc = BigInt(PCR_MOD) - 5000n;
// With 3000 ticks per PTS sample, the 33-bit counter crosses its modulus
// naturally every ~2.86M samples; force an early cross at packet 400 by
// resetting the accumulator to just below the boundary.
const wrapAtPts = new Set([390]);
const discAt = new Set([700, 60000]);
for (let i=0;i<packets;i++){
  let pts = null, pcr = null;
  if (i % 30 === 0) {
    ptsAcc = wrapAtPts.has(i) ? BigInt(PTS_MOD) - 500n : (ptsAcc + 3000n) % BigInt(PTS_MOD);
    pts = ptsAcc;
  }
  if (i % 10 === 0) {
    pcrAcc = (pcrAcc + 27000n) % BigInt(PCR_MOD);
    pcr = pcrAcc;
  }
  wp(i, 0x101, i%16, { pusi: pts!==null, afc: pcr!==null?3:1, pts, pcr, disc: discAt.has(i) });
}
const t0 = performance.now();
const r = analyze(buf.buffer);
const t1 = performance.now();
const types = {};
for (const a of r.anomalies) types[a.type] = (types[a.type]||0)+1;
console.log("analyze ms:", (t1-t0).toFixed(0));
console.log("anomaly types:", types);
console.log("pts wraps:", r.anomalies.filter(a=>a.type==="pts_wrap").map(a=>a.packetIndex));
console.log("pcr wraps:", r.anomalies.filter(a=>a.type==="pcr_wrap").length);
console.log("disc segments:", r.anomalies.filter(a=>a.type==="pcr_discontinuity_segment").map(a=>a.packetIndex));
// Unwrapped PTS must be monotonic non-decreasing within a segment
const ptsPts = r.clockPoints.filter(p=>p.kind==="PTS");
let bad = 0;
for (let i=1;i<ptsPts.length;i++){
  if (ptsPts[i].segmentId === ptsPts[i-1].segmentId && ptsPts[i].unwrapped < ptsPts[i-1].unwrapped) bad++;
}
console.log("non-monotonic PTS within segments:", bad);
