import {test,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import handler,{FREE} from '../api/trial.js';
import {dayNow} from '../lib/trial-store.mjs';
import {wav,opus} from './audio-fixtures.mjs';
import {measureSection} from '../lib/trial-audio.mjs';
process.env.SUPABASE_URL='https://storage.test';process.env.SUPABASE_SERVICE_KEY='test-only';process.env.ELEVENLABS_API_KEY='test-only';
let objects,paid,billed,forms;
const reply=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
beforeEach(()=>{
 objects=new Map();paid=0;billed=[];forms=[];
 global.fetch=async(url,options={})=>{
  if(url.startsWith('https://api.elevenlabs.io')){
   paid++;forms.push(options.body);billed.push(measureSection(Buffer.from(await options.body.get('file').arrayBuffer())).seconds);
   return reply({language_code:'eng',words:[{type:'word',text:'Hello',start:0.2,end:0.6,speaker_id:'speaker_0'},{type:'spacing',text:' ',start:0.6,end:0.7},{type:'word',text:'world.',start:0.7,end:1.1,speaker_id:'speaker_0'}]});
  }
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
// A caption call; returns the result plus the cookie the server set (or the one passed in).
async function caption(audio,{cookie='',ip,query}={}){const r=await call('caption',{cookie,body:audio,ip,query});return {...r,cookie:r.headers['Set-Cookie']?.split(';')[0]||cookie};}
const markers=(part)=>[...objects.keys()].filter(k=>k.includes(part));

test('a first free caption starts the visitor session and returns words and clips left',async()=>{
 const r=await caption(wav(5));
 assert.equal(r.status,200);assert.match(r.cookie,/^ol_trial=/);
 assert.deepEqual(r.data.words.map(w=>w.text),['Hello','world.']);assert.equal(r.data.clipsLeft,FREE.perVisitor-1);
 assert.equal(paid,1);assert.equal(billed[0],5);
 assert.equal((await call('status',{cookie:r.cookie,method:'GET'})).data.clipsLeft,FREE.perVisitor-1);
 assert.equal((await call('status',{method:'GET'})).data.clipsLeft,FREE.perVisitor);
});
test('two minutes is the free limit, in both WAV and Opus, and longer clips cost nothing',async()=>{
 assert.equal((await caption(wav(120))).status,200);
 assert.equal((await caption(opus(119.9),{ip:'10.0.0.2'})).status,200);
 assert.equal((await caption(wav(125),{ip:'10.0.0.3'})).status,413);
 assert.equal((await caption(opus(180),{ip:'10.0.0.4'})).status,413);
 assert.equal((await caption(Buffer.alloc(4_400_001),{ip:'10.0.0.5'})).status,413);
 assert.equal((await caption(Buffer.from('not audio'),{ip:'10.0.0.6'})).status,400);
 assert.equal(paid,2);
});
test('three clips a visitor a day; the fourth is refused without cost',async()=>{
 let {cookie}=await caption(wav(3));
 for(let i=1;i<FREE.perVisitor;i++)assert.equal((await caption(wav(3),{cookie})).status,200);
 const over=await caption(wav(3),{cookie});assert.equal(over.status,429);assert.match(over.data.error,/free clips for today/);
 assert.equal(paid,FREE.perVisitor);
});
test('a network caps at six clips, so clearing cookies does not reset it, and a refusal hands the visitor slot back',async()=>{
 for(let i=0;i<FREE.perNetwork;i++)assert.equal((await caption(wav(3),{ip:'10.9.9.9'})).status,200);
 const over=await caption(wav(3),{ip:'10.9.9.9'});assert.equal(over.status,429);assert.match(over.data.error,/network/);
 assert.equal(paid,FREE.perNetwork);
 assert.equal(markers('/clip-').length,FREE.perNetwork); // only the six that captioned
});
test('the global daily budget is the hard cap, and fails closed without leaving slots behind',async()=>{
 for(let i=0;i<FREE.perDay;i++)objects.set(dayNow()+'/quota-clips-'+i+'.json',{});
 const r=await caption(wav(3));assert.equal(r.status,429);assert.match(r.data.error,/fully booked/);
 assert.equal(paid,0);assert.equal(markers('/clip-').length,0);assert.equal(markers('/net-').length,0);
});
test('a provider failure costs the visitor nothing and the retry succeeds',async()=>{
 const mock=global.fetch;
 global.fetch=async(url,opts)=>url.startsWith('https://api.elevenlabs.io')?reply({detail:'busy'},500):mock(url,opts);
 const failed=await caption(wav(3));assert.equal(failed.status,502);
 assert.equal(markers('/clip-').length,0);assert.equal(markers('/net-').length,0);assert.equal(markers('quota-clips').length,0);
 global.fetch=mock;
 const ok=await caption(wav(3),{cookie:failed.cookie});assert.equal(ok.status,200);assert.equal(ok.data.clipsLeft,FREE.perVisitor-1);
});
test('a spoken language is passed on only in a valid form',async()=>{
 await caption(wav(3),{query:{lang:'es'}});assert.equal(forms[0].get('language_code'),'es');
 await caption(wav(3),{ip:'10.0.0.8',query:{lang:'es;drop'}});assert.equal(forms[1].get('language_code'),null);
});
test('ANALYZE, whole-recording transcripts and dubbing are Pro, and cost nothing',async()=>{
 for(const op of ['transcribe','analyze','finish','dubbing','start'])assert.equal((await call(op,{body:wav(3)})).status,403,op);
 assert.equal(paid,0);
});
test('cross-origin requests are rejected',async()=>{assert.equal((await call('caption',{body:wav(3),origin:'https://evil.test'})).status,403);assert.equal(paid,0);});
test('missing durable storage fails closed',async()=>{const key=process.env.SUPABASE_SERVICE_KEY;delete process.env.SUPABASE_SERVICE_KEY;try{assert.equal((await caption(wav(3))).status,503);assert.equal(paid,0);}finally{process.env.SUPABASE_SERVICE_KEY=key;}});
