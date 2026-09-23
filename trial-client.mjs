export const FREE_CLIP_LIMITS = Object.freeze({bytes:300_000_000, seconds:7200});
export const FREE_CLIP_HINT = "Free session: one recording, up to 2 hours and 300 MB. Analyze, caption, design and share. Original audio only.";
// Cheap intake checks, before anything is decoded or sent. The length is metadata from the media
// element; the server measures every section again, so this only spares the visitor a wait.
export function checkFreeClip(file, seconds = 0) {
  if (!file || !file.size) throw new Error('This file is empty. Choose an audio or video recording.');
  if (file.size > FREE_CLIP_LIMITS.bytes) throw new Error('Free sessions accept one recording up to 2 hours and 300 MB. Choose a smaller file or an audio-only export, then try again.');
  if (seconds > FREE_CLIP_LIMITS.seconds) throw new Error('This recording is longer than 2 hours. Export a section up to 2 hours, then upload it. Your free session has not been used.');
}
export function createTrialClient() {
  const state = {active:false, complete:false};
  async function request(op, options={}, params={}) {
    const response=await fetch('/api/trial?'+new URLSearchParams({op, ...params}),{credentials:'same-origin',...options});
    const data=await response.json().catch(()=>({error:'Free sessions are temporarily unavailable.'}));
    if(!response.ok)throw new Error(data.error||'Please try again.');
    return data;
  }
  async function refresh(){Object.assign(state,await request('status'));return state;}
  async function start(){Object.assign(state,await request('start',{method:'POST'}));return state;}
  // One section of the recording, laid out exactly as Find moments lays out tester sections.
  // Finished sections are saved server-side, so a retry of one returns its transcript for free.
  function transcribeSection({section, count, total, size, language}, blob, signal) {
    const params={section:String(section), count:String(count), total:String(total), size:String(size)};
    if (language) params.lang = language;
    return request('transcribe',{method:'POST',headers:{'Content-Type':blob.type||'application/octet-stream'},body:blob,signal},params);
  }
  async function finish(){Object.assign(state,await request('finish',{method:'POST'}));return state;}
  return {state,refresh,start,transcribeSection,finish};
}
