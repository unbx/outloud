import {test,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import handler from '../api/trial.js';
import feedback from '../api/feedback.js';
import {signSession,dayNow} from '../lib/trial-store.mjs';
import {wav,opus} from './audio-fixtures.mjs';
import {measureSection} from '../lib/trial-audio.mjs';
process.env.SUPABASE_URL='https://storage.test';process.env.SUPABASE_SERVICE_KEY='test-only';process.env.ELEVENLABS_API_KEY='test-only';process.env.OPENAI_API_KEY='test-only';process.env.RESEND_API_KEY='test-only';
let objects,paid,emails,analysis,billed,forms,sentToModel;
const reply=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
beforeEach(()=>{
 objects=new Map();paid=0;emails=0;analysis=0;billed=[];forms=[];sentToModel=null;
 global.fetch=async(url,options={})=>{
  if(url.startsWith('https://api.elevenlabs.io')){
   paid++;forms.push(options.body);billed.push(measureSection(Buffer.from(await options.body.get('file').arrayBuffer())).seconds);
   // Words sit at 0.5 s (inside the overlap a later section shares with the one before it) and
   // at 3-6 s (owned by this section), so assembly has something to deduplicate.
   return reply({language_code:'eng',words:[{type:'word',text:'overlap',start:0.5,end:1,speaker_id:'speaker_0'},{type:'spacing',text:' ',start:1,end:3},{type:'word',text:'Hello',start:3,end:4,speaker_id:'speaker_0'},{type:'word',text:'world.',start:5,end:6,speaker_id:'speaker_0'}]});
  }
  if(url.startsWith('https://api.openai.com')){analysis++;sentToModel=JSON.parse(JSON.parse(options.body).input);return reply({output:[{content:[{type:'output_text',text:'{"moments":[]}'}]}]});}
  if(url.startsWith('https://api.resend.com')){emails++;return reply({id:'mock'});}
  assert.ok(url.startsWith('https://storage.test/'));const p=new URL(url).pathname;
  if(p.includes('/bucket'))return reply({});
  if(p.includes('/object/list/'))return reply([]);
  const prefix='/storage/v1/object/outloud-free-trials';const key=p.slice(prefix.length+1);
  if(options.method==='DELETE'){JSON.parse(options.body).prefixes.forEach(k=>objects.delete(k));return reply({});}
  if(options.method==='POST'){
   if(objects.has(key)&&options.headers['x-upsert']==='false')return reply({message:'The resource already exists'},400);
   objects.set(key,JSON.parse(options.body));return reply({});
  }
  return objects.has(key)?reply(objects.get(key)):reply({message:'Object not found',statusCode:'404'},400);
 };
});
async function call(op,{cookie='',method='POST',body=Buffer.alloc(0),ip='127.0.0.1',origin,query={}}={}){const req=Readable.from([body]);Object.assign(req,{method,query:{op,...query},headers:{cookie,host:'outloud.test','x-forwarded-for':ip,...(origin?{origin}:{})}});const result={status:200,headers:{}};await handler(req,{setHeader(k,v){result.headers[k]=v;},status(s){result.status=s;return this;},json(data){result.data=data;}});return result;}
async function start(ip){const r=await call('start',{ip});assert.equal(r.status,200);return r.headers['Set-Cookie'].split(';')[0];}
// Sections laid out exactly as the browser lays them out: 10-minute Opus or 2-minute WAV, with two
// seconds of shared context on each side.
function layout(total,kind='opus'){const chunk=kind==='opus'?600:120,count=Math.ceil(total/chunk);return Array.from({length:count},(_,section)=>{const from=section*chunk,to=Math.min(total,from+chunk),start=Math.max(0,from-2),end=Math.min(total,to+2);return {section,count,audio:kind==='opus'?opus(end-start):wav(end-start)};});}
const send=(cookie,total,{section,count,audio},extra={})=>call('transcribe',{cookie,body:audio,query:{section:String(section),count:String(count),total:String(total),size:'5000000',...extra}});
async function transcribeAll(cookie,total,kind){for(const s of layout(total,kind))assert.equal((await send(cookie,total,s)).status,200);}

test('anonymous or forged session cannot invoke processing',async()=>{const [s]=layout(10,'wav');assert.equal((await send('',10,s)).status,401);assert.equal((await send('ol_trial='+signSession(dayNow(),'a'.repeat(32)),10,s)).status,401);assert.equal(paid,0);});
test('one network session per day, existing cookie resumes',async()=>{const cookie=await start();assert.equal((await call('start')).status,429);assert.equal((await call('start',{cookie})).status,200);});
test('cross-origin creation is rejected',async()=>{assert.equal((await call('start',{origin:'https://evil.test'})).status,403);});
test('a full two-hour recording transcribes once per section and bills no more than it lasts',async()=>{
 const cookie=await start();await transcribeAll(cookie,7200,'opus');
 assert.equal(paid,12);
 // Everything sent for transcription adds up to the recording plus the shared context at the
 // 11 section boundaries (2 s on each side), and not a second more.
 const seconds=billed.reduce((a,b)=>a+b,0);assert.ok(seconds>=7199&&seconds<=7200+11*4+0.5,String(seconds));
 const r=await call('analyze',{cookie,body:Buffer.from('{"brief":"test"}')});assert.equal(r.status,200);
 // Assembly keeps each section's own words and drops the overlap copies: 2 words x 12 sections,
 // plus the first section's early word, which no earlier section owns.
 const words=sentToModel.segments.flatMap(s=>s.text.split(' '));assert.equal(words.length,25);
 const starts=sentToModel.segments.map(s=>s.start);assert.deepEqual(starts,[...starts].sort((a,b)=>a-b));
});
test('WAV sections work too, for browsers without Opus encoding',async()=>{const cookie=await start();await transcribeAll(cookie,250,'wav');assert.equal(paid,3);assert.equal((await call('finish',{cookie})).status,200);});
test('parallel calls for one section spend once, a retry is free, and a second recording is refused',async()=>{
 const cookie=await start();const [s]=layout(10,'wav');
 const results=await Promise.all([send(cookie,10,s),send(cookie,10,s)]);assert.ok(results.some(r=>r.status===200));assert.equal(paid,1);
 assert.equal((await send(cookie,10,s)).status,200);assert.equal(paid,1);
 const [other]=layout(11,'wav');assert.equal((await send(cookie,11,other)).status,403);assert.equal(paid,1);
});
test('over-limit recordings, oversized sections and dubbing are rejected without cost',async()=>{
 const cookie=await start();
 const [s]=layout(7200.5,'opus');assert.equal((await send(cookie,7200.5,s)).status,413);                         // past 2 hours
 assert.equal((await send(cookie,10,{section:0,count:1,audio:wav(30)})).status,413);                             // audio longer than its slot
 assert.equal((await send(cookie,700,{section:1,count:2,audio:opus(1200)})).status,413);                          // a lie inside a valid layout
 assert.equal((await send(cookie,10,{section:0,count:1,audio:wav(10)},{size:'300000001'})).status,413);           // file over 300 MB
 assert.equal((await send(cookie,10,{section:0,count:1,audio:Buffer.alloc(4_400_001)})).status,413);            // body over the section cap
 assert.equal((await send(cookie,1300,{section:0,count:2,audio:opus(602)})).status,400);                         // wrong section count
 assert.equal((await call('dubbing',{cookie})).status,403);
 assert.equal(paid,0);
});
test('a spoken language is passed on only in a valid form',async()=>{const cookie=await start();const [s]=layout(10,'wav');await send(cookie,10,s,{lang:'es'});assert.equal(forms[0].get('language_code'),'es');const other=await start('10.0.0.2');await send(other,10,s,{lang:'es;drop'});assert.equal(forms[1].get('language_code'),null);});
test('beta request requires a completed recording, not just a cookie or part of one',async()=>{
 const cookie=await start();assert.equal((await call('finish',{cookie})).status,403);
 let status;await feedback({method:'POST',headers:{cookie,'x-forwarded-for':'beta-test'},body:{topic:'Beta access',from:'test@example.com',xAccount:'test'}},{status(n){status=n;return this;},json(){}});assert.equal(status,403);assert.equal(emails,0);
 const parts=layout(1300,'opus');await send(cookie,1300,parts[0]);assert.equal((await call('finish',{cookie})).status,403);
 for(const p of parts.slice(1))await send(cookie,1300,p);
 assert.equal((await call('status',{cookie,method:'GET'})).data.complete,false);await call('finish',{cookie});assert.equal((await call('status',{cookie,method:'GET'})).data.complete,true);
});
test('analysis uses the saved transcript, ignores client segments, and caches repeats',async()=>{const cookie=await start();await transcribeAll(cookie,10,'wav');const r=await call('analyze',{cookie,body:Buffer.from('{"brief":"test","segments":"untrusted"}')});assert.equal(r.status,200);await call('analyze',{cookie,body:Buffer.from('{}')});assert.equal(analysis,1);});
test('analysis before every section is saved is refused',async()=>{const cookie=await start();await send(cookie,1300,layout(1300,'opus')[0]);assert.equal((await call('analyze',{cookie,body:Buffer.from('{}')})).status,400);assert.equal(analysis,0);});
test('global caption budget fails closed, and frees the recording slot it did not use',async()=>{const cookie=await start();for(let i=0;i<25;i++)objects.set(dayNow()+'/quota-captions-'+i+'.json',{});const [s]=layout(10,'wav');assert.equal((await send(cookie,10,s)).status,429);assert.equal(paid,0);assert.ok(![...objects.keys()].some(k=>k.endsWith('-manifest.json')));});
test('expired sessions cannot process even with a retained signed cookie',async()=>{const cookie=await start();const key=[...objects.keys()].find(k=>k.endsWith('-session.json'));objects.set(key,{created:Date.now()-86400001});assert.equal((await send(cookie,10,layout(10,'wav')[0])).status,401);assert.equal(paid,0);});
test('provider failure releases the section lock and the retry succeeds',async()=>{const cookie=await start();const [s]=layout(10,'wav');const mock=global.fetch;global.fetch=async(url,opts)=>url.startsWith('https://api.elevenlabs.io')?Promise.reject(new Error('timeout')):mock(url,opts);assert.equal((await send(cookie,10,s)).status,503);global.fetch=mock;assert.equal((await send(cookie,10,s)).status,200);});
test('missing durable storage fails closed',async()=>{const key=process.env.SUPABASE_SERVICE_KEY;delete process.env.SUPABASE_SERVICE_KEY;try{assert.equal((await call('start')).status,503);assert.equal(paid,0);}finally{process.env.SUPABASE_SERVICE_KEY=key;}});
test('a page loaded before this release is told to refresh instead of spending',async()=>{const cookie=await start();assert.equal((await call('transcribe',{cookie,body:wav(5)})).status,409);assert.equal(paid,0);});
test('a session that finished under the old single-upload flow keeps working',async()=>{const cookie=await start();const prefix=[...objects.keys()].find(k=>k.endsWith('-session.json')).replace('-session.json','');objects.set(prefix+'-transcript.json',{hash:'x',duration:2,result:{words:[{type:'word',text:'Legacy',start:0,end:1,speaker_id:'speaker_0'}]}});assert.equal((await call('analyze',{cookie,body:Buffer.from('{}')})).status,200);assert.equal((await send(cookie,10,layout(10,'wav')[0])).status,403);assert.equal(paid,0);});
