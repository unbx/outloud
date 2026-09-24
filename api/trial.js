import {timingSafeEqual} from 'node:crypto';
import {begin,readSession,get,put,del,reserve,fail,ensureBucket,dayNow,ipKey} from '../lib/trial-store.mjs';
import {SECTION,measureSection} from '../lib/trial-audio.mjs';
import {logEvent,countryOf} from '../lib/usage-log.mjs';
export const config={maxDuration:120,api:{bodyParser:false}};
// Free plan: captions for one selected clip at a time, up to two minutes, measured here from the
// audio itself. Three clips a visitor a day, six a network (so clearing cookies can't reset it,
// but two people on one wifi both get theirs), and a global daily budget that is the hard cap
// on spend. ANALYZE, whole-recording transcripts and dubbing are Pro.
export const FREE={clipSeconds:120,perVisitor:3,perNetwork:6,perDay:33};
const PRO_ONLY='This is a Pro feature. Enter your Pro password, or request Pro access.';
async function body(req,max){const parts=[];let length=0;for await(const chunk of req){const b=Buffer.from(chunk);length+=b.length;if(length>max)throw fail('This clip is too large. Trim it to two minutes or less and try again.',413);parts.push(b);}return Buffer.concat(parts);}
// Takes the first free slot of `limit` numbered markers, or returns null when all are taken.
async function slot(prefix,limit){for(let i=0;i<limit;i++){const key=`${prefix}-${i}.json`;if(await put(key,{at:Date.now()}))return key;}return null;}
async function clipsLeft(s){
 if(!s)return FREE.perVisitor;
 const day=dayNow();let used=0;
 for(let i=0;i<FREE.perVisitor;i++)if(await get(`${day}/clip-${s.id}-${i}.json`))used++;
 return FREE.perVisitor-used;
}
export default async function handler(req,res){
 res.setHeader('Cache-Control','no-store');
 try{
  const op=req.query?.op||'status';
  if(op==='health'&&req.method==='GET'){
   const expected=Buffer.from(process.env.TESTER_PASSWORD||''), actual=Buffer.from(String(req.headers['x-tester-pass']||''));
   if(!expected.length||actual.length!==expected.length||!timingSafeEqual(actual,expected))throw fail('Unauthorized.',401);
   try{await ensureBucket();}catch(e){const code=String(e.cause?.code||e.code||e.name||'unavailable').replace(/[^A-Za-z0-9_]/g,'').slice(0,40);return res.status(503).json({storage:false,code,status:e.storageStatus,reason:e.storageCode});}return res.status(200).json({storage:true,captions:!!process.env.ELEVENLABS_API_KEY});
  }
  if(!['GET','POST'].includes(req.method))throw fail('Method not allowed.',405);
  if(req.method==='POST'&&req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)throw fail('Invalid origin.',403);
  if(op==='status'&&req.method==='GET'){
   let s=readSession(req);if(s&&!await get(s.prefix+'-session.json'))s=null;
   return res.status(200).json({clipsLeft:await clipsLeft(s),clipSeconds:FREE.clipSeconds});
  }
  if(op==='caption'&&req.method==='POST'){
   const audio=await body(req,SECTION.maxBytes);
   let measured;try{measured=measureSection(audio);}catch{throw fail('This clip could not be read. Refresh and try again.');}
   if(measured.seconds>FREE.clipSeconds+0.5)throw fail('Free captions cover up to two minutes. Trim your selection and try again.',413);
   if(!process.env.ELEVENLABS_API_KEY)throw fail('Captions are temporarily unavailable.',503);
   const lang=typeof req.query?.lang==='string'&&/^[a-z]{2,3}$/.test(req.query.lang)?req.query.lang:'';
   const s=await begin(req,res),day=dayNow(),started=Date.now();
   const usage=(ok,status)=>logEvent({feature:'free-caption',plan:'free',target_lang:lang||null,ok,status,country:countryOf(req),ms:Date.now()-started,bytes:audio.length,seconds:Math.round(measured.seconds*10)/10});
   // Visitor, then network, then the global budget. Anything taken is handed back if a later
   // limit or the provider fails, so a refused or failed clip never counts against anyone.
   const taken=[];
   try{
    const mine=await slot(`${day}/clip-${s.id}`,FREE.perVisitor);
    if(!mine)throw fail(`You've made your ${FREE.perVisitor} free clips for today. Come back tomorrow, or go Pro for more.`,429);
    taken.push(mine);
    const network=await slot(`${day}/net-${ipKey(req)}`,FREE.perNetwork);
    if(!network)throw fail('This network has used today’s free clips. Come back tomorrow, or go Pro for more.',429);
    taken.push(network);
    taken.push(await reserve('clips',FREE.perDay));
    const form=new FormData();form.append('file',new Blob([audio],{type:measured.kind==='opus'?'audio/ogg':'audio/wav'}),measured.kind==='opus'?'clip.ogg':'clip.wav');
    form.append('model_id','scribe_v2');form.append('tag_audio_events','false');if(lang)form.append('language_code',lang);
    const upstream=await fetch('https://api.elevenlabs.io/v1/speech-to-text',{method:'POST',headers:{'xi-api-key':process.env.ELEVENLABS_API_KEY},body:form,signal:AbortSignal.timeout(100000)});
    if(!upstream.ok){await usage(false,upstream.status);throw fail('Captioning paused. Your free clip was not used; please try again.',502);}
    const result=await upstream.json();
    const words=(Array.isArray(result.words)?result.words:[]).filter(w=>w&&w.type==='word'&&typeof w.text==='string'&&Number.isFinite(w.start)&&Number.isFinite(w.end))
     .map(w=>({type:'word',text:w.text,start:w.start,end:w.end}));
    await usage(true,200);
    return res.status(200).json({words,language_code:typeof result.language_code==='string'?result.language_code:null,clipsLeft:await clipsLeft(s)});
   }catch(e){if(taken.length)await del(taken).catch(()=>{});throw e;}
  }
  throw fail(PRO_ONLY,403);
 }catch(e){return res.status(e.status||503).json({error:e.status?e.message:'Processing is temporarily unavailable. Please retry shortly.'});}
}
