import {timingSafeEqual} from 'node:crypto';
import {begin,requireSession,get,put,del,reserve,fail,ensureBucket} from '../lib/trial-store.mjs';
import {SECTION,measureSection} from '../lib/trial-audio.mjs';
import {normalizeWords,segmentsFromWords} from '../moments-core.mjs';
import moments from './moments.js';
export const config={maxDuration:180,api:{bodyParser:false}};
// A free session covers one recording up to 2 hours and 300 MB. The browser sends it in the same
// sections Find moments uses for testers, and each section is measured here before any spend.
export const FREE={seconds:7200,bytes:300_000_000};
const ONE_RECORDING='Your free session covers one recording. Finish this clip, then request beta access.';
async function body(req,max){const parts=[];let length=0;for await(const chunk of req){const b=Buffer.from(chunk);length+=b.length;if(length>max)throw fail('This audio section is too large. Refresh and try again.',413);parts.push(b);}return Buffer.concat(parts);}
// The whole transcript, assembled from saved sections exactly as the browser assembles it:
// each word belongs to the section that owns its midpoint, so overlaps never double up.
// Sessions started before sections existed saved one transcript; they still resolve here.
async function transcriptOf(s){
 const legacy=await get(s.prefix+'-transcript.json');
 if(legacy)return {words:normalizeWords(legacy.result.words,0,0,0,legacy.duration)};
 const m=await get(s.prefix+'-manifest.json');if(!m)return null;
 const parts=await Promise.all(Array.from({length:m.count},(_,i)=>get(s.prefix+'-section-'+i+'.json')));
 if(parts.some(p=>!p))return null;
 return {words:parts.flatMap((p,i)=>normalizeWords(p.words,p.start,i,p.from,p.to)).sort((a,b)=>a.start-b.start)};
}
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');
 try{
  const op=req.query?.op||'status';
  if(op==='health'&&req.method==='GET'){
   const expected=Buffer.from(process.env.TESTER_PASSWORD||''), actual=Buffer.from(String(req.headers['x-tester-pass']||''));
   if(!expected.length||actual.length!==expected.length||!timingSafeEqual(actual,expected))throw fail('Unauthorized.',401);
   try{await ensureBucket();}catch(e){const code=String(e.cause?.code||e.code||e.name||'unavailable').replace(/[^A-Za-z0-9_]/g,'').slice(0,40);return res.status(503).json({storage:false,code,status:e.storageStatus,reason:e.storageCode});}return res.status(200).json({storage:true,captions:!!process.env.ELEVENLABS_API_KEY,analysis:!!process.env.OPENAI_API_KEY});
  }
  if(!['GET','POST'].includes(req.method))throw fail('Method not allowed.',405);
  if(req.method==='POST'&&req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)throw fail('Invalid origin.',403);
  if(op==='start'&&req.method==='POST'){const s=await begin(req,res);return res.status(200).json({active:true,complete:!!await get(s.prefix+'-complete.json')});}
  if(op==='status'&&req.method==='GET'){let s=null;try{s=await requireSession(req);}catch(e){if(e.status!==401)throw e;}return res.status(200).json({active:!!s,complete:s?!!await get(s.prefix+'-complete.json'):false});}
  const s=await requireSession(req);
  if(op==='finish'&&req.method==='POST'){if(!await transcriptOf(s))throw fail('Make your free clip before requesting beta access.',403);await put(s.prefix+'-complete.json',{at:Date.now()});return res.status(200).json({active:true,complete:true});}
  if(op==='transcribe'&&req.method==='POST'){
   const q=req.query||{};
   if(q.section===undefined)throw fail('OutLoud was updated. Refresh the page, then continue your free clip.',409);
   const section=Number(q.section),count=Number(q.count),total=Number(q.total),size=Number(q.size);
   const audio=await body(req,SECTION.maxBytes);
   let measured;try{measured=measureSection(audio);}catch{throw fail('This audio section could not be read. Refresh and try again.');}
   const chunk=SECTION[measured.kind];
   if(!Number.isFinite(total)||total<0.1||total>FREE.seconds||!Number.isSafeInteger(size)||size<1||size>FREE.bytes)throw fail('Free sessions accept one recording up to 2 hours and 300 MB.',413);
   if(!Number.isInteger(count)||count!==Math.ceil(total/chunk)||!Number.isInteger(section)||section<0||section>=count)throw fail('This audio section does not fit the recording. Refresh and try again.');
   // Section bounds are recomputed here, never read from the request. The measured audio must fit
   // them (plus one Opus frame), so the whole session can never bill more than its recording.
   const from=section*chunk,to=Math.min(total,(section+1)*chunk),start=Math.max(0,from-SECTION.overlap),end=Math.min(total,to+SECTION.overlap);
   if(measured.seconds>end-start+0.25)throw fail('This audio section is longer than expected. Refresh and try again.',413);
   const lang=typeof q.lang==='string'&&/^[a-z]{2,3}$/.test(q.lang)?q.lang:'';
   if(!process.env.ELEVENLABS_API_KEY)throw fail('Caption service is temporarily unavailable.',503);
   // The first section fixes which recording this session covers and takes one slot of the
   // daily caption budget. Later sections must describe the same recording.
   let manifest=await get(s.prefix+'-manifest.json');
   if(!manifest){
    if(await get(s.prefix+'-transcript.json'))throw fail(ONE_RECORDING,403);
    const fresh={total:String(q.total),size,chunk,count};
    if(await put(s.prefix+'-manifest.json',fresh)){try{await reserve('captions');}catch(e){await del([s.prefix+'-manifest.json']).catch(()=>{});throw e;}manifest=fresh;}
    else manifest=await get(s.prefix+'-manifest.json');
    if(!manifest)throw fail('Your clip is already starting. Please wait and retry.',409);
   }
   if(manifest.total!==String(q.total)||manifest.size!==size||manifest.chunk!==chunk)throw fail(ONE_RECORDING,403);
   const key=s.prefix+'-section-'+section+'.json',lock=s.prefix+'-stt-lock-'+section+'.json';
   const saved=await get(key);if(saved)return res.status(200).json({words:saved.words,language_code:saved.language_code});
   if(!await put(lock,{at:Date.now()}))throw fail('This section is already processing. Please wait and retry.',409);
   try{
    const form=new FormData();form.append('file',new Blob([audio],{type:measured.kind==='opus'?'audio/ogg':'audio/wav'}),measured.kind==='opus'?'section.ogg':'section.wav');
    form.append('model_id','scribe_v2');form.append('diarize','true');form.append('tag_audio_events','false');if(lang)form.append('language_code',lang);
    const upstream=await fetch('https://api.elevenlabs.io/v1/speech-to-text',{method:'POST',headers:{'xi-api-key':process.env.ELEVENLABS_API_KEY},body:form,signal:AbortSignal.timeout(150000)});
    if(!upstream.ok)throw fail('Captioning paused on this section. Finished sections are saved; please retry.',502);
    const result=await upstream.json();
    // Keep only what assembly needs, so a long section stays well inside the storage object limit.
    const words=(Array.isArray(result.words)?result.words:[]).filter(w=>w&&w.type==='word'&&typeof w.text==='string'&&Number.isFinite(w.start)&&Number.isFinite(w.end))
     .map(w=>({type:'word',text:w.text,start:w.start,end:w.end,speaker_id:w.speaker_id??null}));
    const record={words,language_code:typeof result.language_code==='string'?result.language_code:null,start,from,to};
    await put(key,record);await del([lock]);return res.status(200).json({words:record.words,language_code:record.language_code});
   }catch(e){await del([lock]).catch(()=>{});throw e;}
  }
  if(op==='analyze'){
   if(req.method==='GET')return res.status(200).json({ready:!!process.env.OPENAI_API_KEY});
   const transcript=await transcriptOf(s);if(!transcript)throw fail('Caption your free recording first.');
   if(!transcript.words.length)throw fail('No speech was found in this recording. Try a recording with clearer speech.');
   const cached=await get(s.prefix+'-analysis.json');if(cached)return res.status(200).json(cached);
   const input=JSON.parse((await body(req,4096)).toString()||'{}');
   if(!await put(s.prefix+'-analysis-lock.json',{at:Date.now()}))throw fail('Analysis is already running. Please wait and retry.',409);
   try{
    await reserve('analysis');
    const segments=segmentsFromWords(transcript.words);
    const result=await new Promise((resolve,reject)=>{let code=200;Promise.resolve(moments({method:'POST',headers:{'x-moments-key':process.env.OPENAI_API_KEY||'', 'x-forwarded-for':s.id},body:{segments,min:15,max:90,brief:String(input.brief||'').slice(0,600),speaker:''}},{setHeader(){},status(n){code=n;return this;},json(data){resolve({code,data});}})).catch(reject);});
    if(result.code!==200)throw fail(result.data.error||'Analysis failed. You can retry.',result.code);
    await put(s.prefix+'-analysis.json',result.data);await del([s.prefix+'-analysis-lock.json']);return res.status(200).json(result.data);
   }catch(e){await del([s.prefix+'-analysis-lock.json']).catch(()=>{});throw e;}
  }
  throw fail('This action is not included in a free session.',403);
 }catch(e){return res.status(e.status||503).json({error:e.status?e.message:'Processing is temporarily unavailable. Please retry shortly.'});}
}
