// Synthetic audio sections for free-session tests. Not a test file itself.
export function wav(seconds=2){const b=Buffer.alloc(44+Math.round(seconds*16000)*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(b.length-44,40);return b;}
// A minimal Ogg Opus stream. Each packet is CELT 20 ms frames (TOC config 31) packed `frames` at a
// time with frame-count code 3, so 6 frames = 120 ms, the longest packet Opus allows.
function page(serial,seq,granule,packets){const segs=[];for(const p of packets){let n=p.length;while(n>=255){segs.push(255);n-=255;}segs.push(n);}const head=Buffer.alloc(27);head.write('OggS');head.writeBigUInt64LE(BigInt(granule),6);head.writeUInt32LE(serial,14);head.writeUInt32LE(seq,18);head[26]=segs.length;return Buffer.concat([head,Buffer.from(segs),...packets]);}
export function opus(seconds,{frames=6,serial=7,granule=0}={}){
 const opusHead=Buffer.alloc(19);opusHead.write('OpusHead');opusHead[8]=1;opusHead[9]=1;opusHead.writeUInt32LE(48000,12);
 const pages=[page(serial,0,0,[opusHead]),page(serial,1,0,[Buffer.from('OpusTags\x07\x00\x00\x00OutLoud\x00\x00\x00\x00','latin1')])];
 const count=Math.round(seconds*1000/(20*frames));let batch=[];
 for(let i=0;i<count;i++){batch.push(Buffer.from([(31<<3)|3,frames,0x55]));if(batch.length===200){pages.push(page(serial,pages.length,granule,batch));batch=[];}}
 if(batch.length)pages.push(page(serial,pages.length,granule,batch));
 return Buffer.concat(pages);
}
