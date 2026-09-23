import {test,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {createTrialClient,checkFreeClip,FREE_CLIP_LIMITS} from '../trial-client.mjs';
let requests;
beforeEach(()=>{requests=[];global.fetch=async(url,options={})=>{requests.push({url,options});return new Response(JSON.stringify({words:[]}));};});
const file=size=>({size});
test('limits are one recording up to 2 hours and 300 MB',()=>{assert.equal(FREE_CLIP_LIMITS.seconds,7200);assert.equal(FREE_CLIP_LIMITS.bytes,300_000_000);});
test('rejects empty and over-300 MB files before anything is read or sent',()=>{assert.throws(()=>checkFreeClip(file(0)),/empty/);assert.throws(()=>checkFreeClip(file(FREE_CLIP_LIMITS.bytes+1)),/300 MB/);assert.equal(requests.length,0);});
test('rejects recordings over 2 hours, accepts exactly 2 hours',()=>{assert.throws(()=>checkFreeClip(file(100),7200.01),/longer than 2 hours/);checkFreeClip(file(FREE_CLIP_LIMITS.bytes),7200);checkFreeClip(file(100));});
test('each section is sent with its place in the recording, and a language only when chosen',async()=>{
 const c=createTrialClient();const blob=new Blob(['x'],{type:'audio/ogg'});
 await c.transcribeSection({section:2,count:12,total:7200,size:5000000,language:''},blob);
 await c.transcribeSection({section:0,count:1,total:10,size:100,language:'es'},blob);
 const [a,b]=requests.map(r=>new URL(r.url,'https://outloud.test'));
 assert.equal(a.pathname,'/api/trial');assert.deepEqual(Object.fromEntries(a.searchParams),{op:'transcribe',section:'2',count:'12',total:'7200',size:'5000000'});
 assert.equal(b.searchParams.get('lang'),'es');
 assert.equal(requests[0].options.method,'POST');assert.equal(requests[0].options.headers['Content-Type'],'audio/ogg');assert.equal(requests[0].options.body,blob);
});
test('server errors surface as readable messages',async()=>{global.fetch=async()=>new Response(JSON.stringify({error:'Your free session covers one recording.'}),{status:403});await assert.rejects(createTrialClient().transcribeSection({section:0,count:1,total:10,size:1},new Blob(['x'])),/one recording/);});
