const fs=require('fs');
const P=require('../js/png.js');
const {TiffReader}=require('../js/tiff.js');
(async()=>{
const r=await TiffReader.fromBytes(new Uint8Array(fs.readFileSync('.untrusted-samples/rotated.tif')));
const d=r.layers[0];
const res=await r.readRoi(d,{x:0,y:0,width:5,height:7});
fs.writeFileSync('/tmp/roi.png',P.encodeRgb16(res.values,res.width,res.height,3));
fs.writeFileSync('/tmp/mask.png',P.encodeMask(res.mask,res.width,res.height));
console.log('ok');
})();
