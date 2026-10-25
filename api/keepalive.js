import { timingSafeEqual } from 'node:crypto';
// Daily keep-alive for the Supabase project. Supabase's free plan pauses a project it sees as idle,
// and a paused project takes the free plan and the usage log down with it (10/14 to 10/25/26). A
// Vercel cron calls this once a day: one tiny read from the events table and one from storage count
// as activity. Vercel sends `Authorization: Bearer $CRON_SECRET`; nobody else can trigger it.
const BUCKET = 'outloud-free-trials';

function authorized(req) {
  const secret = String(process.env.CRON_SECRET || '');
  const expected = Buffer.from('Bearer ' + secret), given = Buffer.from(String(req.headers.authorization || ''));
  return secret.length >= 16 && given.length === expected.length && timingSafeEqual(given, expected);
}

async function ping(path) {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/+$/, ''), key = process.env.SUPABASE_SERVICE_KEY;
  try {
    const r = await fetch(url + path, { headers: { apikey: key, Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(15000) });
    return r.status;
  } catch (e) {
    return String(e.cause?.code || e.code || e.name || 'unreachable').replace(/[^A-Za-z0-9_]/g, '').slice(0, 40);
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized.' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return res.status(503).json({ error: 'Supabase is not configured.' });
  const [db, storage] = await Promise.all([ping('/rest/v1/events?select=id&limit=1'), ping('/storage/v1/bucket/' + BUCKET)]);
  const ok = db === 200 && storage === 200;
  // a failure here is the early warning: it shows in Vercel's error list before users notice
  if (!ok) console.error('[keepalive] Supabase not healthy:', JSON.stringify({ db, storage }));
  return res.status(ok ? 200 : 503).json({ ok, db, storage });
}
