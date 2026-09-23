import {signSession,dayNow} from '../lib/trial-store.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeX} from '../beta-access.mjs';
import handler from '../api/feedback.js';
test('X handles and profile links normalize; other hosts and invalid handles are rejected',()=>{
 for (const value of ['someone','@someone','https://x.com/someone','https://twitter.com/someone/']) assert.equal(normalizeX(value),'@someone');
 for (const value of ['','@bad handle','https://evil.example/someone','https://x.com/user/status/123','abcdefghijklmnop']) assert.equal(normalizeX(value),null);
});
test('beta requests validate fields, route a replyable email, and report delivery failure',async()=>{
 const oldURL=process.env.SUPABASE_URL, oldService=process.env.SUPABASE_SERVICE_KEY; process.env.SUPABASE_URL='https://storage.test';process.env.SUPABASE_SERVICE_KEY='test';
 const cookie='ol_trial='+signSession(dayNow(),'b'.repeat(32));
 const originalFetch=globalThis.fetch, key=process.env.RESEND_API_KEY; process.env.RESEND_API_KEY='test-key';
 const call=async(body,id)=>{let code,payload;await handler({method:'POST',headers:{cookie,'x-forwarded-for':id},body},{status(n){code=n;return this;},json(v){payload=v;}});return {code,payload};};
 try{
 let deliveries=[];globalThis.fetch=async(url,opts)=>{if(url.startsWith('https://storage.test'))return new Response(JSON.stringify({created:Date.now()}),{status:200});deliveries.push(JSON.parse(opts.body));return {ok:true};};
 const invalid=await call({topic:'Beta access',from:'bad',xAccount:'@user'},'invalid'); assert.equal(invalid.code,400);assert.equal(deliveries.length,0);
 const bot=await call({topic:'Beta access',from:'test@example.com',xAccount:'@user',website:'spam'},'bot');assert.equal(bot.code,400);
 const valid=await call({topic:'Beta access',from:'test@example.com',xAccount:'https://x.com/user'},'valid');assert.equal(valid.code,200);assert.equal(deliveries[0].reply_to,'test@example.com');assert.match(deliveries[0].text,/X: @user/);assert.equal(deliveries[0].subject,'OutLoud beta access');
 globalThis.fetch=async(url)=>url.startsWith('https://storage.test')?new Response(JSON.stringify({created:Date.now()}),{status:200}):({ok:false});assert.equal((await call({topic:'Beta access',from:'test@example.com',xAccount:'@user'},'failed')).code,502);
 }finally{if(oldURL===undefined)delete process.env.SUPABASE_URL;else process.env.SUPABASE_URL=oldURL;if(oldService===undefined)delete process.env.SUPABASE_SERVICE_KEY;else process.env.SUPABASE_SERVICE_KEY=oldService;globalThis.fetch=originalFetch;if(key===undefined)delete process.env.RESEND_API_KEY;else process.env.RESEND_API_KEY=key;}
});
