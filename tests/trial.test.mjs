import {test,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import handler from '../api/trial.js';
import feedback from '../api/feedback.js';
import {signSession,dayNow} from '../lib/trial-store.mjs';
import {validateTrialWav} from '../lib/trial-wav.mjs';
process.env.SUPABASE_URL='https://storage.test';process.env.SUPABASE_SERVICE_KEY='test-only';process.env.ELEVENLABS_API_KEY='test-only';process.env.OPENAI_API_KEY='test-only';process.env.RESEND_API_KEY='test-only';
let objects,paid,emails,analysis;
const reply=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
beforeEach(()=>{
 objects=new Map();paid=0;emails=0;analysis=0;
 global.fetch=async(url,options={})=>{
  if(url.startsWith('https://api.elevenlabs.io')){paid++;return reply({language_code:'eng',words:[{type:'word',text:'Hello',start:0,end:1,speaker_id:'speaker_0'},{type:'word',text:'world.',start:1,end:2,speaker_id:'speaker_0'}]});}
  if(url.startsWith('https://api.openai.com')){analysis++;return reply({output:[{content:[{type:'output_text',text:'{"moments":[]}'}]}]});}
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
function wav(seconds=2){const b=Buffer.alloc(44+seconds*32000);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(b.length-44,40);return b;}
async function call(op,{cookie='',method='POST',body=Buffer.alloc(0),ip='127.0.0.1',origin}={}){const req=Readable.from([body]);Object.assign(req,{method,query:{op},headers:{cookie,host:'outloud.test','x-forwarded-for':ip,...(origin?{origin}:{})}});const result={status:200,headers:{}};await handler(req,{setHeader(k,v){result.headers[k]=v;},status(s){result.status=s;return this;},json(data){result.data=data;}});return result;}
async function start(){const r=await call('start');assert.equal(r.status,200);return r.headers['Set-Cookie'].split(';')[0];}
test('duration comes from validated PCM bytes, not client metadata',()=>{assert.equal(validateTrialWav(wav(60)),60);assert.throws(()=>validateTrialWav(wav(61)));const b=wav();b.writeUInt32LE(1,40);assert.throws(()=>validateTrialWav(b));});
test('anonymous or forged session cannot invoke processing',async()=>{assert.equal((await call('transcribe',{body:wav()})).status,401);assert.equal((await call('transcribe',{cookie:'ol_trial='+signSession(dayNow(),'a'.repeat(32)),body:wav()})).status,401);assert.equal(paid,0);});
test('one network session per day, existing cookie resumes',async()=>{const cookie=await start();assert.equal((await call('start')).status,429);assert.equal((await call('start',{cookie})).status,200);});
test('cross-origin creation is rejected',async()=>{assert.equal((await call('start',{origin:'https://evil.test'})).status,403);});
test('parallel transcription calls spend once, cached retry is free',async()=>{const cookie=await start();const results=await Promise.all([call('transcribe',{cookie,body:wav()}),call('transcribe',{cookie,body:wav()})]);assert.ok(results.some(r=>r.status===200));assert.equal(paid,1);assert.equal((await call('transcribe',{cookie,body:wav()})).status,200);assert.equal(paid,1);assert.equal((await call('transcribe',{cookie,body:wav(3)})).status,403);});
test('oversized audio and dubbing rejected without cost',async()=>{const cookie=await start();assert.equal((await call('transcribe',{cookie,body:wav(61)})).status,413);assert.equal((await call('dubbing',{cookie})).status,403);assert.equal(paid,0);});
test('beta request requires a completed clip, not just a cookie',async()=>{const cookie=await start();assert.equal((await call('finish',{cookie})).status,403);let status;await feedback({method:'POST',headers:{cookie,'x-forwarded-for':'beta-test'},body:{topic:'Beta access',from:'test@example.com',xAccount:'test'}},{status(n){status=n;return this;},json(){}});assert.equal(status,403);assert.equal(emails,0);await call('transcribe',{cookie,body:wav()});assert.equal((await call('status',{cookie,method:'GET'})).data.complete,false);await call('finish',{cookie});assert.equal((await call('status',{cookie,method:'GET'})).data.complete,true);});
test('analysis uses saved transcript and returns cache for repeats',async()=>{const cookie=await start();await call('transcribe',{cookie,body:wav()});const r=await call('analyze',{cookie,body:Buffer.from('{"brief":"test","segments":"untrusted"}')});assert.equal(r.status,200);await call('analyze',{cookie,body:Buffer.from('{}')});assert.equal(analysis,1);});
test('global caption budget fails closed',async()=>{const cookie=await start();for(let i=0;i<25;i++)objects.set(dayNow()+'/quota-captions-'+i+'.json',{});assert.equal((await call('transcribe',{cookie,body:wav()})).status,429);assert.equal(paid,0);});

test('expired sessions cannot process even with a retained signed cookie',async()=>{const cookie=await start();const key=[...objects.keys()].find(k=>k.endsWith('-session.json'));objects.set(key,{created:Date.now()-86400001});assert.equal((await call('transcribe',{cookie,body:wav()})).status,401);assert.equal(paid,0);});
test('provider failure releases the lock and a retry remains bounded by the daily budget',async()=>{const cookie=await start();const mock=global.fetch;global.fetch=async(url,opts)=>url.startsWith('https://api.elevenlabs.io')?Promise.reject(new Error('timeout')):mock(url,opts);assert.equal((await call('transcribe',{cookie,body:wav()})).status,503);global.fetch=mock;assert.equal((await call('transcribe',{cookie,body:wav()})).status,200);});
test('missing durable storage fails closed',async()=>{const key=process.env.SUPABASE_SERVICE_KEY;delete process.env.SUPABASE_SERVICE_KEY;try{assert.equal((await call('start')).status,503);assert.equal(paid,0);}finally{process.env.SUPABASE_SERVICE_KEY=key;}});
