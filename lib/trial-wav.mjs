export function validateTrialWav(b){
 if(b.length<44||b.toString('ascii',0,4)!=='RIFF'||b.toString('ascii',8,12)!=='WAVE'||b.toString('ascii',12,16)!=='fmt '||b.readUInt32LE(16)!==16||b.readUInt16LE(20)!==1||b.readUInt16LE(22)!==1||b.readUInt32LE(24)!==16000||b.readUInt32LE(28)!==32000||b.readUInt16LE(32)!==2||b.readUInt16LE(34)!==16||b.toString('ascii',36,40)!=='data')throw new Error('Use a supported clip. Free sessions accept up to 60 seconds of audio.');
 const size=b.readUInt32LE(40);if(size!==b.length-44||b.readUInt32LE(4)!==b.length-8||size%2||size<3200||size>1920000)throw new Error('Your free clip must be between 0.1 and 60 seconds.');return size/32000;
}
