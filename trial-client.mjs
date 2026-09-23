export const FREE_CLIP_LIMITS = Object.freeze({bytes:300_000_000, seconds:60});
export const FREE_CLIP_HINT = "Free session: one recording, up to 60 seconds and 300 MB. Analyze, caption, design and share. Original audio only.";
export function createTrialClient(wav) {
  const state = {active:false, complete:false};
  let source=null, pending=null;
  const prepared = new WeakMap();
  async function request(op, options={}) {
    const response=await fetch('/api/trial?op='+op,{credentials:'same-origin',...options});
    const data=await response.json().catch(()=>({error:'Free sessions are temporarily unavailable.'}));
    if(!response.ok)throw new Error(data.error||'Please try again.');
    return data;
  }
  async function refresh(){Object.assign(state,await request('status'));return state;}
  async function start(){Object.assign(state,await request('start',{method:'POST'}));return state;}
  async function prepare(file){
    if(!file || !file.size)throw new Error('This file is empty. Choose an audio or video recording.');
    if(file.size>FREE_CLIP_LIMITS.bytes)throw new Error('Free sessions accept files up to 300 MB and 60 seconds. Choose a smaller file or export a shorter passage, then try again.');
    if(prepared.has(file))return prepared.get(file);
    const task=(async()=>{
      const ctx=new (window.AudioContext||window.webkitAudioContext)();let buffer;
      try{buffer=await ctx.decodeAudioData(await file.arrayBuffer());}
      catch{throw new Error('We could not read the audio in this file. Try an MP3, WAV or M4A version. Your free clip has not been used.');}
      finally{await ctx.close();}
      if(!Number.isFinite(buffer.duration)||buffer.duration<.1)throw new Error('Choose a recording with at least a moment of audio.');
      if(buffer.duration>FREE_CLIP_LIMITS.seconds)throw new Error('This recording is longer than 60 seconds. Export a passage up to 60 seconds, then upload it. Your free clip has not been used.');
      const offline=new OfflineAudioContext(1,Math.ceil(buffer.duration*16000),16000);
      const node=offline.createBufferSource();node.buffer=buffer;node.connect(offline.destination);node.start();
      return {duration:buffer.duration,audio:wav(await offline.startRendering())};
    })();
    prepared.set(file,task);
    try{return await task;}catch(error){prepared.delete(file);throw error;}
  }
  async function transcribe(file){
    if(source===file&&pending)return pending;
    source=file;
    pending=(async()=>{
      const ready=await prepare(file);
      return request('transcribe',{method:'POST',headers:{'Content-Type':'audio/wav'},body:ready.audio});
    })();
    try{return await pending;}catch(e){pending=null;throw e;}
  }
  async function finish(){Object.assign(state,await request('finish',{method:'POST'}));return state;}
  return {state,refresh,start,prepare,transcribe,finish};
}
