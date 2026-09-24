import {createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
const BUCKET='outloud-free-trials';
export const dayNow=()=>new Date().toISOString().slice(0,10);
export function fail(message,status=400){return Object.assign(new Error(message),{status});}
function secret(){const key=process.env.SUPABASE_SERVICE_KEY;if(!key)throw fail('Free captions are temporarily unavailable. Please try again later, or use your Pro password.',503);return key;}
function mac(value){return createHmac('sha256',secret()).update('outloud-trial:'+value).digest('hex');}
function equal(a,b){const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);}
export function signSession(day,id){return `${day}.${id}.${mac(day+'.'+id)}`;}
export function readSession(req){
 const token=String(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith('ol_trial='))?.slice(9)||'';
 const match=/^(\d{4}-\d{2}-\d{2})\.([a-f0-9]{32})\.([a-f0-9]{64})$/.exec(token);
 if(!match||!equal(match[3],mac(match[1]+'.'+match[2])))return null;
 const age=Date.now()-Date.parse(match[1]+'T00:00:00Z');if(age<0||age>48*3600000)return null;
 return {day:match[1],id:match[2],prefix:match[1]+'/'+match[2]};
}
export function ipKey(req){return mac(String(req.headers['x-forwarded-for']||req.socket?.remoteAddress||'unknown').split(',')[0].trim());}
async function storage(path,options={}){
 const base=process.env.SUPABASE_URL;if(!base||!/^https:\/\/[^/]+/.test(base))throw fail('Free captions are temporarily unavailable. Please try again later.',503);
 const key=secret();const r=await fetch(base.replace(/\/$/,'')+'/storage/v1/'+path,{...options,headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json',...options.headers},signal:AbortSignal.timeout(12000)});
 const data=await r.json().catch(()=>({}));return {r,data};
}
export async function ensureBucket(){
 let {r}=await storage('bucket/'+BUCKET);if(r.ok)return;
 const created=await storage('bucket',{method:'POST',body:JSON.stringify({id:BUCKET,name:BUCKET,public:false,file_size_limit:1000000,allowed_mime_types:['application/json']})});
 if(!created.r.ok){const check=await storage('bucket/'+BUCKET);if(!check.r.ok)throw Object.assign(fail('Free-session storage is unavailable. Please try later.',503),{storageStatus:check.r.status,storageCode:String(check.data.error||check.data.code||'').replace(/[^A-Za-z0-9_]/g,'').slice(0,60)});}
}
export async function get(key){const {r,data}=await storage('object/'+BUCKET+'/'+key);if(r.ok)return data;if(r.status===404||String(data.statusCode)==='404'||data.error==='not_found'||/object not found/i.test(data.message||''))return null;throw fail('Free-session storage is unavailable.',503);}
export async function put(key,value,upsert=false){const {r,data}=await storage('object/'+BUCKET+'/'+key,{method:'POST',headers:{'x-upsert':String(upsert)},body:JSON.stringify(value)});if(r.ok)return true;if(!upsert&&(r.status===409||/already exists|duplicate/i.test(JSON.stringify(data))))return false;throw fail('Free captions are temporarily unavailable. Please try again later.',503);}
export async function del(keys){const {r}=await storage('object/'+BUCKET,{method:'DELETE',body:JSON.stringify({prefixes:keys})});if(!r.ok)throw fail('Could not release the session. Please retry later.',503);}
// Takes one of today's `limit` slots for `kind` and returns its key, so a caller can hand it back.
export async function reserve(kind,limit=25){
 const day=dayNow();for(let i=0;i<limit;i++){const key=`${day}/quota-${kind}-${i}.json`;if(await put(key,{at:Date.now()}))return key;}
 throw fail('Free captions are fully booked for today. Try again tomorrow, or go Pro for more.',429);
}
// A visitor's session: a signed cookie that names them for the daily clip count. Starting one
// costs nothing; the per-visitor, per-network and global clip limits are what guard spend.
export async function begin(req,res){
 await ensureBucket();let session=readSession(req);
 if(session){const record=await get(session.prefix+'-session.json');if(record&&Date.now()-record.created<86400000)return session;}
 const day=dayNow(),id=randomBytes(16).toString('hex');
 session={day,id,prefix:day+'/'+id};await put(session.prefix+'-session.json',{created:Date.now()});
 res.setHeader('Set-Cookie',`ol_trial=${signSession(day,id)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400${process.env.VERCEL?' ; Secure':''}`);
 await cleanup().catch(()=>{});return session;
}
async function cleanup(){
 const day=dayNow();if(!await put(day+'/cleanup.json',{at:Date.now()}))return;
 const folders=await storage('object/list/'+BUCKET,{method:'POST',body:JSON.stringify({prefix:'',limit:1000})});if(!folders.r.ok)return;
 for(const folder of folders.data){if(!/^\d{4}-\d{2}-\d{2}$/.test(folder.name)||Date.now()-Date.parse(folder.name)<3*86400000)continue;
  const files=await storage('object/list/'+BUCKET,{method:'POST',body:JSON.stringify({prefix:folder.name,limit:1000})});if(files.r.ok&&files.data.length)await del(files.data.map(f=>folder.name+'/'+f.name));
 }
}
