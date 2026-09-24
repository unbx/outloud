// Free plan. Anyone can upload a recording up to 2 hours and 300 MB, trim it in the Clip editor,
// and caption one selection of up to two minutes at a time, three clips a day. Only the selection
// is uploaded; the server measures it again and holds the key.
export const FREE_CLIP_LIMITS = Object.freeze({bytes:300_000_000, seconds:7200});
export const FREE_CAPTION_SECONDS = 120;
export const FREE_CLIPS_PER_DAY = 3;
export const FREE_CLIP_HINT = "Free: captions for clips up to 2 minutes, 3 clips a day. Upload up to 2 hours, then trim in the Clip editor. ANALYZE and dubbing are Pro.";
// Cheap intake checks, before anything is decoded or sent. The length is metadata from the media
// element; a long recording is fine, since only the trimmed selection is ever captioned.
export function checkFreeClip(file, seconds = 0) {
  if (!file || !file.size) throw new Error('This file is empty. Choose an audio or video recording.');
  if (file.size > FREE_CLIP_LIMITS.bytes) throw new Error('Uploads can be up to 2 hours and 300 MB. Choose a smaller file or an audio-only export, then try again.');
  if (seconds > FREE_CLIP_LIMITS.seconds) throw new Error('This recording is longer than 2 hours. Export a section up to 2 hours, then upload it.');
}
export function createTrialClient() {
  const state = {clipsLeft: FREE_CLIPS_PER_DAY};
  async function request(op, options={}, params={}) {
    const response=await fetch('/api/trial?'+new URLSearchParams({op, ...params}),{credentials:'same-origin',...options});
    const data=await response.json().catch(()=>({error:'Free captions are temporarily unavailable.'}));
    if(!response.ok)throw new Error(data.error||'Please try again.');
    return data;
  }
  async function refresh(){const data=await request('status');if(Number.isFinite(data.clipsLeft))state.clipsLeft=data.clipsLeft;return state;}
  // Captions for one selected clip. The server starts the visitor's session on first use.
  async function caption(blob, language, signal) {
    const params = language ? {lang: language} : {};
    const data = await request('caption',{method:'POST',headers:{'Content-Type':blob.type||'application/octet-stream'},body:blob,signal},params);
    if (Number.isFinite(data.clipsLeft)) state.clipsLeft = data.clipsLeft;
    return data;
  }
  return {state,refresh,caption};
}
