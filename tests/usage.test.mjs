import {test,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {logEvent,dropped} from '../lib/usage-log.mjs';
import report from '../api/usage.js';
process.env.SUPABASE_URL='https://db.test';process.env.SUPABASE_SERVICE_KEY='test-only';process.env.TESTER_PASSWORD='pro-pass';
const reply=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json'}});
let inserts,tableColumns,rows,storage;
beforeEach(()=>{
 inserts=[];tableColumns=['id','created_at','feature','target_lang','ok','status','country','ms','bytes'];rows=[];storage={};
 global.fetch=async(url,options={})=>{
  const u=new URL(url);
  if(u.pathname==='/rest/v1/events'&&options.method==='POST'){
   const row=JSON.parse(options.body);const unknown=Object.keys(row).find(k=>!tableColumns.includes(k));
   if(unknown)return reply({code:'PGRST204',message:`Could not find the '${unknown}' column of 'events' in the schema cache`},400);
   inserts.push(row);return reply({},201);
  }
  if(u.pathname==='/rest/v1/events'){const [a,b]=options.headers.Range.split('-').map(Number);return reply(rows.slice(a,b+1));}
  if(u.pathname.startsWith('/storage/v1/object/list/')){const {prefix}=JSON.parse(options.body);
   if(!prefix)return reply(Object.keys(storage).map(name=>({name,id:null})));
   return reply((storage[prefix.slice(0,-1)]||[]).map(name=>({name})));}
  throw new Error('unexpected '+url);
 };
});
async function get(headers={}){let code,body;await report({method:'GET',headers},{setHeader(){},status(n){code=n;return this;},json(v){body=v;}});return {code,body};}

test('a row with columns the table lacks is still logged, without them',async()=>{
 await logEvent({feature:'free-caption',plan:'free',seconds:12.3,ok:true,status:200});
 assert.equal(inserts.length,1);assert.deepEqual(inserts[0],{feature:'free-caption',ok:true,status:200});
 assert.ok(dropped().includes('plan')&&dropped().includes('seconds'));
 // the warm instance remembers, so the next row goes through first time
 await logEvent({feature:'dub',plan:'pro',ok:true});assert.equal(inserts.length,2);
});
test('logging never throws when Supabase is down',async()=>{global.fetch=async()=>{throw new Error('down');};await logEvent({feature:'dub'});});
test('the report needs the Pro password',async()=>{assert.equal((await get()).code,401);assert.equal((await get({'x-tester-pass':'wrong-pass'})).code,401);});
test('the report totals the events log and the free plan counters',async()=>{
 rows=[
  {id:1,created_at:'2026-09-23T10:00:00Z',feature:'dub',target_lang:'ko',ok:true,country:'US'},
  {id:2,created_at:'2026-09-24T09:00:00Z',feature:'caption',ok:true,country:'US'},
  {id:3,created_at:'2026-09-24T10:00:00Z',feature:'free-caption',plan:'free',ok:true,seconds:95,country:'PH'},
  {id:4,created_at:'2026-09-24T11:00:00Z',feature:'dub',target_lang:'de',ok:false,country:'US'},
 ];
 storage={'2026-09-24':['clip-aa-0.json','clip-aa-1.json','clip-bb-0.json','net-c1-0.json','net-c1-1.json','net-c1-2.json','aa-session.json','bb-session.json','quota-clips-0.json','quota-clips-1.json','quota-clips-2.json']};
 const {code,body}=await get({'x-tester-pass':'pro-pass'});
 assert.equal(code,200);
 assert.equal(body.events.total,4);assert.equal(body.events.first,'2026-09-23T10:00:00Z');
 assert.deepEqual(body.events.byFeature,{dub:2,caption:1,'free-caption':1});
 assert.deepEqual(body.events.byPlan,{pro:3,free:1});
 assert.deepEqual(body.events.dubLanguages,{ko:1,de:1});
 assert.deepEqual(body.events.failures,{dub:1});
 assert.deepEqual(Object.keys(body.events.byDay),['2026-09-24','2026-09-23']);
 assert.deepEqual(body.freePlan['2026-09-24'],{freeClips:3,visitorsWhoClipped:2,networks:1,sessions:2,dailyBudgetUsedOf33:3,oldFreeCaptions:0,oldFreeAnalyses:0});
});
