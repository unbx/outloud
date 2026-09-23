import {test,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {createTrialClient,FREE_CLIP_LIMITS} from '../trial-client.mjs';
let duration,decodes,requests,broken;
beforeEach(()=>{
 duration=60;decodes=0;requests=0;broken=false;
 global.window={AudioContext:class{async decodeAudioData(){decodes++;if(broken)throw Error();return {duration};}async close(){}}};
 global.OfflineAudioContext=class{constructor(_,length,rate){this.length=length;this.rate=rate;}createBufferSource(){return {connect(){},start(){}};}async startRendering(){return {length:this.length};}};
 global.fetch=async()=>{requests++;return new Response(JSON.stringify({words:[]}));};
});
const file=size=>({size,arrayBuffer:async()=>new ArrayBuffer(1)});
test('rejects over 300 MB before decoding or spending a transcription',async()=>{const c=createTrialClient(x=>x);await assert.rejects(c.prepare(file(FREE_CLIP_LIMITS.bytes+1)),/300 MB/);assert.equal(decodes,0);assert.equal(requests,0);});
test('rejects over 60 seconds before transcription',async()=>{duration=60.01;const c=createTrialClient(x=>x);await assert.rejects(c.prepare(file(100)),/longer than 60/);assert.equal(requests,0);});
test('accepts exact limits; analysis reuses preflight audio and request',async()=>{const c=createTrialClient(x=>new Blob(['wav']));const f=file(FREE_CLIP_LIMITS.bytes);await c.prepare(f);assert.equal(requests,0);await c.transcribe(f);await c.transcribe(f);assert.equal(decodes,1);assert.equal(requests,1);});
test('unreadable audio is rejected with recovery guidance and can retry',async()=>{const c=createTrialClient(x=>x),f=file(100);broken=true;await assert.rejects(c.prepare(f),/MP3, WAV or M4A/);broken=false;await c.prepare(f);assert.equal(decodes,2);assert.equal(requests,0);});
