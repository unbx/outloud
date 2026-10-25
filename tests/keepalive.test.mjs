import {test,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import keepalive from '../api/keepalive.js';
process.env.SUPABASE_URL='https://db.test';process.env.SUPABASE_SERVICE_KEY='test-only';process.env.CRON_SECRET='cron-secret-for-tests';
let hits;
beforeEach(()=>{hits=[];global.fetch=async(url)=>{hits.push(new URL(url).pathname);return new Response('[]',{status:200});};});
async function call(headers={}){let code,body;await keepalive({headers},{setHeader(){},status(n){code=n;return this;},json(v){body=v;}});return {code,body};}
test('only the cron secret can trigger it',async()=>{
 assert.equal((await call()).code,401);assert.equal((await call({authorization:'Bearer wrong'})).code,401);assert.equal(hits.length,0);
});
test('it touches the events table and the free-plan bucket',async()=>{
 const r=await call({authorization:'Bearer cron-secret-for-tests'});
 assert.equal(r.code,200);assert.deepEqual(r.body,{ok:true,db:200,storage:200});
 assert.deepEqual(hits.sort(),['/rest/v1/events','/storage/v1/bucket/outloud-free-trials']);
});
test('a paused project answers 503 with the cause',async()=>{
 global.fetch=async()=>{throw Object.assign(new TypeError('fetch failed'),{cause:{code:'ENOTFOUND'}});};
 const r=await call({authorization:'Bearer cron-secret-for-tests'});
 assert.equal(r.code,503);assert.deepEqual(r.body,{ok:false,db:'ENOTFOUND',storage:'ENOTFOUND'});
});
