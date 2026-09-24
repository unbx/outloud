import { timingSafeEqual } from 'node:crypto';
// Private usage report, behind the Pro password. Reads the Supabase `events` log (one row per
// caption, dub, script or ANALYZE run) and the free plan's daily counters in storage, and
// returns totals by day, feature, plan, language and country. Runs server-side because the
// Supabase key only exists here.
const BUCKET = 'outloud-free-trials';

function authorized(req) {
  const expected = Buffer.from(String(process.env.TESTER_PASSWORD || '').trim());
  const given = Buffer.from(String(req.headers['x-tester-pass'] || '').trim());
  return expected.length > 0 && given.length === expected.length && timingSafeEqual(given, expected);
}

async function supabase(path, options = {}) {
  const url = String(process.env.SUPABASE_URL || '').replace(/\/+$/, ''), key = process.env.SUPABASE_SERVICE_KEY;
  const r = await fetch(url + path, { ...options, headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', ...options.headers }, signal: AbortSignal.timeout(15000) });
  const body = await r.json().catch(() => null);
  return { ok: r.ok, status: r.status, body, headers: r.headers };
}

// Every events row, a thousand at a time.
async function allEvents() {
  const rows = [];
  for (let from = 0; from < 50000; from += 1000) {
    const r = await supabase('/rest/v1/events?select=*', { headers: { Range: `${from}-${from + 999}`, 'Range-Unit': 'items' } });
    if (!r.ok) return { error: `events table: ${r.status} ${r.body?.message || ''}`.trim(), rows };
    rows.push(...r.body);
    if (r.body.length < 1000) break;
  }
  return { rows };
}

const bump = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };

function summarizeEvents(rows) {
  const time = rows.length ? Object.keys(rows[0]).find(k => /^(created_at|inserted_at|at|ts|time|timestamp)$/.test(k)) : null;
  const out = { total: rows.length, columns: rows.length ? Object.keys(rows[0]) : [], first: null, last: null,
    byDay: {}, byFeature: {}, byPlan: {}, dubLanguages: {}, countries: {}, failures: {}, secondsByFeature: {} };
  for (const r of rows) {
    const day = time && r[time] ? String(r[time]).slice(0, 10) : 'unknown';
    if (time && r[time]) { if (!out.first || r[time] < out.first) out.first = r[time]; if (!out.last || r[time] > out.last) out.last = r[time]; }
    const f = r.feature || 'unknown';
    out.byDay[day] ||= {}; bump(out.byDay[day], f);
    bump(out.byFeature, f);
    bump(out.byPlan, r.plan || (f === 'free-caption' ? 'free' : 'pro'));
    if (f === 'dub' && r.target_lang) bump(out.dubLanguages, r.target_lang);
    if (r.country) bump(out.countries, r.country);
    if (r.ok === false) bump(out.failures, f);
    if (Number.isFinite(r.seconds)) bump(out.secondsByFeature, f, r.seconds);
  }
  out.byDay = Object.fromEntries(Object.entries(out.byDay).sort((a, b) => b[0].localeCompare(a[0])));
  return out;
}

// The free plan's markers, per day folder (kept about three days before cleanup).
async function freeCounters() {
  const top = await supabase(`/storage/v1/object/list/${BUCKET}`, { method: 'POST', body: JSON.stringify({ prefix: '', limit: 1000 }) });
  if (!top.ok) return { error: `storage: ${top.status}` };
  const days = (top.body || []).map(f => f.name).filter(n => /^\d{4}-\d{2}-\d{2}$/.test(n)).sort().reverse();
  const out = {};
  for (const day of days) {
    const names = [];
    for (let offset = 0; offset < 10000; offset += 1000) {
      const r = await supabase(`/storage/v1/object/list/${BUCKET}`, { method: 'POST', body: JSON.stringify({ prefix: day + '/', limit: 1000, offset }) });
      if (!r.ok) break;
      names.push(...(r.body || []).map(f => f.name));
      if ((r.body || []).length < 1000) break;
    }
    const visitors = new Set(), networks = new Set();
    let clips = 0, sessions = 0, budget = 0, oldCaptions = 0, oldAnalyses = 0;
    for (const n of names) {
      let m;
      if ((m = /^clip-([a-f0-9]+)-\d+\.json$/.exec(n))) { clips++; visitors.add(m[1]); }
      else if ((m = /^net-([a-f0-9]+)-\d+\.json$/.exec(n))) networks.add(m[1]);
      else if (/-session\.json$/.test(n)) sessions++;
      else if (/^quota-clips-/.test(n)) budget++;
      else if (/^quota-captions-/.test(n)) oldCaptions++;
      else if (/^quota-analysis-/.test(n)) oldAnalyses++;
    }
    out[day] = { freeClips: clips, visitorsWhoClipped: visitors.size, networks: networks.size, sessions, dailyBudgetUsedOf33: budget, oldFreeCaptions: oldCaptions, oldFreeAnalyses: oldAnalyses };
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only.' });
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized.' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) return res.status(503).json({ error: 'Supabase is not configured.' });
  try {
    const [events, free] = await Promise.all([allEvents(), freeCounters()]);
    return res.status(200).json({ generatedAt: new Date().toISOString(), events: { ...summarizeEvents(events.rows), error: events.error || null }, freePlan: free });
  } catch (e) {
    return res.status(503).json({ error: 'Report failed: ' + String(e?.message || e).slice(0, 120) });
  }
}
