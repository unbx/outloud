import {test,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {createTrialClient,checkFreeClip,FREE_CLIP_LIMITS,FREE_CAPTION_SECONDS,FREE_CLIPS_PER_DAY} from '../trial-client.mjs';
let requests;
beforeEach(()=>{requests=[];global.fetch=async(url,options={})=>{requests.push({url,options});return new Response(JSON.stringify({words:[],clipsLeft:2}));};});
const file=size=>({size});
test('uploads run to 2 hours and 300 MB; captions cover 2 minutes, 3 clips a day',()=>{assert.equal(FREE_CLIP_LIMITS.seconds,7200);assert.equal(FREE_CLIP_LIMITS.bytes,300_000_000);assert.equal(FREE_CAPTION_SECONDS,120);assert.equal(FREE_CLIPS_PER_DAY,3);});
test('rejects empty and over-300 MB files before anything is read or sent',()=>{assert.throws(()=>checkFreeClip(file(0)),/empty/);assert.throws(()=>checkFreeClip(file(FREE_CLIP_LIMITS.bytes+1)),/300 MB/);assert.equal(requests.length,0);});
test('a long recording is accepted for trimming, up to 2 hours',()=>{assert.throws(()=>checkFreeClip(file(100),7200.01),/longer than 2 hours/);checkFreeClip(file(FREE_CLIP_LIMITS.bytes),7200);checkFreeClip(file(100),3600);});
test('a caption sends the clip, a language only when chosen, and keeps the clips-left count',async()=>{
 const c=createTrialClient();const blob=new Blob(['x'],{type:'audio/ogg'});
 await c.caption(blob,'');await c.caption(blob,'es');
 const [a,b]=requests.map(r=>new URL(r.url,'https://outloud.test'));
 assert.equal(a.pathname,'/api/trial');assert.deepEqual(Object.fromEntries(a.searchParams),{op:'caption'});
 assert.equal(b.searchParams.get('lang'),'es');
 assert.equal(requests[0].options.method,'POST');assert.equal(requests[0].options.headers['Content-Type'],'audio/ogg');assert.equal(requests[0].options.body,blob);
 assert.equal(c.state.clipsLeft,2);
});
test('server errors surface as readable messages',async()=>{global.fetch=async()=>new Response(JSON.stringify({error:"You've made your 3 free clips for today."}),{status:429});await assert.rejects(createTrialClient().caption(new Blob(['x'])),/3 free clips/);});
