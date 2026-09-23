import {createHash,timingSafeEqual} from 'node:crypto';
import {begin,readSession,requireSession,get,put,del,reserve,fail,ensureBucket} from '../lib/trial-store.mjs';
import {validateTrialWav} from '../lib/trial-wav.mjs';
import {normalizeWords,segmentsFromWords} from '../moments-core.mjs';
import moments from './moments.js';
export const config={maxDuration:180,api:{bodyParser:false}};
async function body(req,max){const parts=[];let length=0;for await(const chunk of req){const b=Buffer.from(chunk);length+=b.length;if(length>max)throw fail('Clip is too large. Use up to 60 seconds.',413);parts.push(b);}return Buffer.concat(parts);}
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
  if(op==='finish'&&req.method==='POST'){if(!await get(s.prefix+'-transcript.json'))throw fail('Make your free clip before requesting beta access.',403);await put(s.prefix+'-complete.json',{at:Date.now()});return res.status(200).json({active:true,complete:true});}
  if(op==='transcribe'&&req.method==='POST'){
   const wav=await body(req,1920044);let duration;try{duration=validateTrialWav(wav);}catch(e){throw fail(e.message);}
   const hash=createHash('sha256').update(wav).digest('hex');const cached=await get(s.prefix+'-transcript.json');
   if(cached){if(cached.hash!==hash)throw fail('Your free session covers one recording. Finish this clip, then request beta access.',403);return res.status(200).json(cached.result);}
   if(!await put(s.prefix+'-stt-lock.json',{hash,at:Date.now()}))throw fail('Your clip is already processing. Please wait and retry.',409);
   
   try{
    if(!process.env.ELEVENLABS_API_KEY)throw fail('Caption service is temporarily unavailable.',503);
    await reserve('captions');
    const form=new FormData();form.append('file',new Blob([wav],{type:'audio/wav'}),'trial.wav');form.append('model_id','scribe_v2');form.append('diarize','true');form.append('tag_audio_events','false');
    const upstream=await fetch('https://api.elevenlabs.io/v1/speech-to-text',{method:'POST',headers:{'xi-api-key':process.env.ELEVENLABS_API_KEY},body:form,signal:AbortSignal.timeout(150000)});
    if(!upstream.ok)throw fail('Captioning could not finish. Your free pass is still available; please retry.',502);
    const result=await upstream.json();if(!Array.isArray(result.words)||!result.words.some(w=>w.type==='word'))throw fail('No speech was found. Try a clearer recording; your pass is still available.');
    await put(s.prefix+'-transcript.json',{hash,duration,result});await del([s.prefix+'-stt-lock.json']);return res.status(200).json(result);
   }catch(e){await del([s.prefix+'-stt-lock.json']).catch(()=>{});throw e;}
  }
  if(op==='analyze'){
   if(req.method==='GET')return res.status(200).json({ready:!!process.env.OPENAI_API_KEY});
   const transcript=await get(s.prefix+'-transcript.json');if(!transcript)throw fail('Caption your free recording first.');
   const cached=await get(s.prefix+'-analysis.json');if(cached)return res.status(200).json(cached);
   const input=JSON.parse((await body(req,4096)).toString()||'{}');
   if(!await put(s.prefix+'-analysis-lock.json',{at:Date.now()}))throw fail('Analysis is already running. Please wait and retry.',409);
   try{
    await reserve('analysis');
    const words=normalizeWords(transcript.result.words,0,0,0,transcript.duration);const segments=segmentsFromWords(words);
    const result=await new Promise((resolve,reject)=>{let code=200;Promise.resolve(moments({method:'POST',headers:{'x-moments-key':process.env.OPENAI_API_KEY||'', 'x-forwarded-for':s.id},body:{segments,min:15,max:90,brief:String(input.brief||'').slice(0,600),speaker:''}},{setHeader(){},status(n){code=n;return this;},json(data){resolve({code,data});}})).catch(reject);});
    if(result.code!==200)throw fail(result.data.error||'Analysis failed. You can retry.',result.code);
    await put(s.prefix+'-analysis.json',result.data);await del([s.prefix+'-analysis-lock.json']);return res.status(200).json(result.data);
   }catch(e){await del([s.prefix+'-analysis-lock.json']).catch(()=>{});throw e;}
  }
  throw fail('This action is not included in a free session.',403);
 }catch(e){return res.status(e.status||503).json({error:e.status?e.message:'Processing is temporarily unavailable. Please retry shortly.'});}
}
